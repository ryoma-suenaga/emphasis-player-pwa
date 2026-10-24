// tags.js - minimal metadata reader: ID3v2 (MP3), MP4/M4A atoms, FLAC Vorbis comments.
// Returns { title, artist, album, albumArtist, track, disc, picture: {mime, data} }.

const be32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const le32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const syncsafe = (b, p) => (b[p] << 21) | (b[p + 1] << 14) | (b[p + 2] << 7) | b[p + 3];
const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));
const bytes = async (file, s, e) => new Uint8Array(await file.slice(s, e).arrayBuffer());
const utf8 = d => new TextDecoder('utf-8').decode(d);

export async function readTags(file) {
  const h = await bytes(file, 0, 12);
  try {
    if (ascii(h, 0, 3) === 'ID3') return norm(await id3(file));
    if (ascii(h, 0, 4) === 'fLaC') return norm(await flac(file));
    if (ascii(h, 4, 4) === 'ftyp') return norm(await mp4(file));
  } catch (e) {
    console.warn('tag read failed', file.name, e);
  }
  return {};
}

function norm(t) {
  for (const k of ['track', 'disc']) {
    if (t[k] != null) t[k] = parseInt(String(t[k]).split('/')[0], 10) || 0;
  }
  for (const k of ['title', 'artist', 'album', 'albumArtist']) {
    if (typeof t[k] === 'string') t[k] = t[k].replace(/\0/g, '').trim() || undefined;
  }
  return t;
}

// ---------------------------------------------------------------- ID3v2
// Latin-1 frames in Japanese files are often really Shift_JIS.
function decodeLatin1OrSjis(d) {
  if (d.some(x => x > 0x7f)) {
    try { return new TextDecoder('shift_jis', { fatal: true }).decode(d); } catch (_) { /* fall through */ }
  }
  return new TextDecoder('latin1').decode(d);
}

function decodeStr(d, enc) {
  if (enc === 0) return decodeLatin1OrSjis(d);
  if (enc === 3) return utf8(d);
  if (enc === 2) return new TextDecoder('utf-16be').decode(d);
  if (d[0] === 0xfe && d[1] === 0xff) return new TextDecoder('utf-16be').decode(d.subarray(2));
  if (d[0] === 0xff && d[1] === 0xfe) return new TextDecoder('utf-16le').decode(d.subarray(2));
  return new TextDecoder('utf-16le').decode(d);
}

function skipStr(d, p, enc) {
  if (enc === 1 || enc === 2) {
    while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2;
    return p + 2;
  }
  while (p < d.length && d[p] !== 0) p++;
  return p + 1;
}

const ID3_MAP = {
  TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album',
  TPE2: 'albumArtist', TP2: 'albumArtist', TRCK: 'track', TRK: 'track', TPOS: 'disc', TPA: 'disc',
};

async function id3(file) {
  const h = await bytes(file, 0, 10);
  const ver = h[3], flags = h[5], size = syncsafe(h, 6);
  const b = await bytes(file, 10, 10 + size);
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  let p = 0;
  if (ver >= 3 && flags & 0x40) p = ver === 4 ? syncsafe(b, 0) : be32(b, 0) + 4;
  const out = {};
  while (p + hdr <= b.length) {
    const id = ascii(b, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const sz = ver === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5]
      : ver === 4 ? syncsafe(b, p + 4) : be32(b, p + 4);
    const d = b.subarray(p + hdr, p + hdr + sz);
    p += hdr + sz;
    if (ID3_MAP[id] && out[ID3_MAP[id]] == null) {
      out[ID3_MAP[id]] = decodeStr(d.subarray(1), d[0]).split('\0')[0];
    } else if ((id === 'APIC' || id === 'PIC') && !out.picture) {
      const enc = d[0];
      let q, mime;
      if (id === 'PIC') { mime = ascii(d, 1, 3).toUpperCase() === 'PNG' ? 'image/png' : 'image/jpeg'; q = 4; }
      else { const e = skipStr(d, 1, 0); mime = ascii(d, 1, e - 2) || 'image/jpeg'; q = e; }
      q = skipStr(d, q + 1, enc);               // picture type byte, then description
      if (!mime.includes('/')) mime = 'image/' + mime.toLowerCase().replace('jpg', 'jpeg');
      out.picture = { mime, data: d.slice(q) };
    }
  }
  return out;
}

// ---------------------------------------------------------------- FLAC
async function flac(file) {
  const out = {};
  let pos = 4;
  for (let i = 0; i < 128 && pos + 4 <= file.size; i++) {
    const h = await bytes(file, pos, pos + 4);
    const last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4 || (type === 6 && !out.picture)) {
      const d = await bytes(file, pos + 4, pos + 4 + len);
      if (type === 4) vorbis(d, out);
      else {
        let p = 4;
        const ml = be32(d, p); const mime = ascii(d, p + 4, ml); p += 4 + ml;
        const dl = be32(d, p); p += 4 + dl + 16;
        const n = be32(d, p);
        out.picture = { mime, data: d.slice(p + 4, p + 4 + n) };
      }
    }
    pos += 4 + len;
    if (last) break;
  }
  return out;
}

const VORBIS_MAP = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist',
  'ALBUM ARTIST': 'albumArtist', TRACKNUMBER: 'track', DISCNUMBER: 'disc',
};
function vorbis(d, out) {
  let p = 4 + le32(d, 0);
  const n = le32(d, p); p += 4;
  for (let i = 0; i < n && p + 4 <= d.length; i++) {
    const l = le32(d, p);
    const s = utf8(d.subarray(p + 4, p + 4 + l)); p += 4 + l;
    const eq = s.indexOf('=');
    const key = VORBIS_MAP[s.slice(0, eq).toUpperCase()];
    if (key && out[key] == null) out[key] = s.slice(eq + 1);
  }
}

// ---------------------------------------------------------------- MP4 / M4A
function* atoms(b, s, e) {
  let p = s;
  while (p + 8 <= e) {
    let len = be32(b, p), hdr = 8;
    if (len === 1) { len = be32(b, p + 12); hdr = 16; } else if (len === 0) len = e - p;
    if (len < 8) return;
    yield { t: ascii(b, p + 4, 4), s: p + hdr, e: Math.min(p + len, e) };
    p += len;
  }
}
const child = (b, a, t) => { for (const c of atoms(b, a.s, a.e)) if (c.t === t) return c; return null; };

const MP4_MAP = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', aART: 'albumArtist' };

async function mp4(file) {
  let pos = 0, moov = null;
  while (pos + 8 <= file.size) {
    const h = await bytes(file, pos, pos + 16);
    let len = be32(h, 0), hdr = 8;
    if (len === 1) { len = be32(h, 8) * 2 ** 32 + be32(h, 12); hdr = 16; } else if (len === 0) len = file.size - pos;
    if (ascii(h, 4, 4) === 'moov') { moov = await bytes(file, pos + hdr, pos + len); break; }
    if (len < 8) break;
    pos += len;
  }
  const out = {};
  if (!moov) return out;
  const root = { s: 0, e: moov.length };
  const udta = child(moov, root, 'udta'); if (!udta) return out;
  const meta = child(moov, udta, 'meta'); if (!meta) return out;
  const ilst = child(moov, { s: meta.s + 4, e: meta.e }, 'ilst'); if (!ilst) return out;
  for (const it of atoms(moov, ilst.s, ilst.e)) {
    const d = child(moov, it, 'data'); if (!d) continue;
    const type = be32(moov, d.s) & 0xffffff;
    const v = moov.subarray(d.s + 8, d.e);
    if (MP4_MAP[it.t]) out[MP4_MAP[it.t]] = utf8(v);
    else if (it.t === 'trkn' && v.length >= 4) out.track = (v[2] << 8) | v[3];
    else if (it.t === 'disk' && v.length >= 4) out.disc = (v[2] << 8) | v[3];
    else if (it.t === 'covr' && !out.picture) out.picture = { mime: type === 14 ? 'image/png' : 'image/jpeg', data: v.slice() };
  }
  return out;
}

// app.js - Emphasis Player (PWA): local library, album playback, patent-core emphasis EQ,
// loudness-linked (ISO 226) preset, and blind A/B / ABX listening tests.
import { makeCurve, designFIR, FIR_LEN, powerSpectrum, spectrumLoudness, kWeighting, abxP, prefP } from './dsp.js';
import { readTags } from './tags.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => (!isFinite(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const dbToLin = db => Math.pow(10, db / 20);
const sgn = v => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`;
const UNKNOWN_ALBUM = '不明なアルバム', UNKNOWN_ARTIST = '不明なアーティスト';

// ------------------------------------------------------------------ storage (IndexedDB)
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('emphasis-player', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('tracks', { keyPath: 'id' });
      d.createObjectStore('files');
      d.createObjectStore('covers');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
const put = (name, value, key) => req(key === undefined ? store(name, 'readwrite').put(value) : store(name, 'readwrite').put(value, key));
const get = (name, key) => req(store(name).get(key));
const getAll = name => req(store(name).getAll());
const getAllKeys = name => req(store(name).getAllKeys());
const del = (name, key) => req(store(name, 'readwrite').delete(key));

// ------------------------------------------------------------------ settings
// vol: in-app volume [dB]; calVol: volume that corresponds to calPhon (loudness preset reference)
const EQ_DEFAULT = { enabled: true, preset: 'strong', B: 8, C: 5, fLo: 50, fHi: 5000, mode: 'fir', autoPre: true, pre: -6,
  vol: 0, calVol: 0, calPhon: 60 };
const PRESETS = { std: { B: 3, C: 3 }, strong: { B: 8, C: 5 }, loud: { C: 5 } };
const REF_PHON = 83;   // assumed mixing / mastering level
function load(key, def) { try { return { ...def, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch (_) { return { ...def }; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* storage unavailable */ } }
const eq = load('eq', EQ_DEFAULT);
const prefs = load('prefs', { shuffle: false, repeat: 'all', cacheGB: 2 });

// ------------------------------------------------------------------ state
const state = { tracks: [], view: 'albums', album: null, query: '', queue: [], qi: -1 };
const covers = new Map();   // coverKey -> object URL
const cur = () => state.queue[state.qi];

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(msg, ms = 2500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ library
const albumKey = t => `${t.albumArtist}\u0000${t.album}`;
function matches(t, q) {
  if (!q) return true;
  return [t.title, t.artist, t.album, t.albumArtist].some(v => String(v).toLowerCase().includes(q));
}
const byTrack = (a, b) => (a.disc - b.disc) || (a.track - b.track) || a.title.localeCompare(b.title, 'ja');
function albums() {
  const q = state.query.toLowerCase(), m = new Map();
  for (const t of state.tracks) {
    if (!matches(t, q)) continue;
    const k = albumKey(t);
    if (!m.has(k)) m.set(k, { key: k, album: t.album, artist: t.albumArtist, tracks: [], coverKey: null });
    const a = m.get(k); a.tracks.push(t);
    if (!a.coverKey && t.coverKey) a.coverKey = t.coverKey;
  }
  const list = [...m.values()];
  list.forEach(a => a.tracks.sort(byTrack));
  return list.sort((a, b) => a.album.localeCompare(b.album, 'ja'));
}
function songs() {
  const q = state.query.toLowerCase();
  return state.tracks.filter(t => matches(t, q))
    .sort((a, b) => a.artist.localeCompare(b.artist, 'ja') || a.album.localeCompare(b.album, 'ja') || byTrack(a, b));
}

// A track is identified by file name + size, so the same file matches again in later sessions.
const mkOf = f => `${f.name}|${f.size}`;
const AUDIO_RE = /\.(mp3|m4a|aac|mp4|flac|wav|ogg|oga|opus|webm)$/i;

// Files picked this session (not persisted): matchKey -> File. Browsers forget them on restart.
const session = new Map();
const playable = t => session.has(t.mk) || t.cachedBytes > 0;

async function scanFiles(fileList) {
  const files = [...fileList].filter(f => AUDIO_RE.test(f.name) || f.type.startsWith('audio/'));
  if (!files.length) { toast('音楽ファイルが見つかりませんでした'); return; }
  navigator.storage?.persist?.()?.catch(() => {});
  const byMk = new Map(state.tracks.map(t => [t.mk, t]));
  let added = 0, matched = 0;
  for (const [i, f] of files.entries()) {
    const mk = mkOf(f);
    session.set(mk, f);
    if (byMk.has(mk)) { matched++; continue; }
    toast(`新しい曲の情報を読み込み中 ${i + 1} / ${files.length}`, 0);
    let tags = {};
    try { tags = await readTags(f); } catch (_) { /* untagged file */ }
    const artist = tags.artist || UNKNOWN_ARTIST;
    const t = {
      id: mk, mk, name: f.name, size: f.size, added: Date.now(), lastPlayed: 0, cachedBytes: 0,
      title: tags.title || f.name.replace(/\.[^.]+$/, ''),
      artist, album: tags.album || UNKNOWN_ALBUM, albumArtist: tags.albumArtist || artist,
      track: tags.track || 0, disc: tags.disc || 1, coverKey: null,
    };
    if (tags.picture) {
      t.coverKey = albumKey(t);
      if (!covers.has(t.coverKey)) {
        const blob = new Blob([tags.picture.data], { type: tags.picture.mime });
        try { await put('covers', blob, t.coverKey); } catch (_) { /* cover is optional */ }
        covers.set(t.coverKey, URL.createObjectURL(blob));
      }
    }
    try { await put('tracks', t); } catch (_) { toast('曲情報を保存できませんでした', 4000); break; }
    state.tracks.push(t); byMk.set(mk, t); added++;
  }
  toast(`${files.length} 曲を選択しました（新規 ${added}・登録済み ${matched}）`, 3500);
  hideNeed(); render(); updateUsage();
}

// ---- recently-played cache (LRU, size-capped). Copies only tracks that were actually played.
const cacheLimit = () => Math.max(0, prefs.cacheGB) * 1e9;
const cacheUsed = () => state.tracks.reduce((s, t) => s + (t.cachedBytes || 0), 0);

async function cacheTrack(t, blob) {
  if (!cacheLimit() || blob.size > cacheLimit() || t.cachedBytes) return;
  try { await put('files', blob, t.id); } catch (_) { return; }   // quota errors: just skip caching
  t.cachedBytes = blob.size;
  await put('tracks', t);
  await enforceCache(t.id);
  updateUsage();
}

async function enforceCache(keepId) {
  let total = cacheUsed();
  const lru = state.tracks.filter(t => t.cachedBytes > 0).sort((a, b) => a.lastPlayed - b.lastPlayed);
  for (const t of lru) {
    if (total <= cacheLimit()) break;
    if (t.id === keepId || t === cur()) continue;
    await del('files', t.id);
    total -= t.cachedBytes; t.cachedBytes = 0;
    await put('tracks', t);
  }
}

async function clearCache() {
  for (const t of state.tracks) if (t.cachedBytes) { await del('files', t.id); t.cachedBytes = 0; await put('tracks', t); }
  render(); updateUsage();
}

async function sourceFor(t) {
  const f = session.get(t.mk);
  if (f) return { blob: f, fromSession: true };
  if (t.cachedBytes) {
    const b = await get('files', t.id);
    if (b) return { blob: b, fromSession: false };
    t.cachedBytes = 0; await put('tracks', t);
  }
  return null;
}

async function deleteTracks(list) {
  for (const t of list) { await del('tracks', t.id); await del('files', t.id); session.delete(t.mk); }
  const ids = new Set(list.map(t => t.id));
  state.tracks = state.tracks.filter(t => !ids.has(t.id));
  const used = new Set(state.tracks.map(t => t.coverKey));
  for (const k of [...covers.keys()]) if (!used.has(k)) { await del('covers', k); URL.revokeObjectURL(covers.get(k)); covers.delete(k); }
  render(); updateUsage();
}

async function updateUsage() {
  const gb = b => (b / 1e9).toFixed(2);
  const n = state.tracks.filter(t => t.cachedBytes > 0).length;
  $('#cacheInfo').textContent = `保存済み ${n} 曲・${gb(cacheUsed())} GB ／ 上限 ${prefs.cacheGB ? prefs.cacheGB + ' GB' : 'オフ'}`;
  $('#vCache').textContent = prefs.cacheGB ? `${prefs.cacheGB} GB` : 'オフ';
  $('#sCache').value = prefs.cacheGB;
  let line = `ライブラリ ${state.tracks.length} 曲（今回選択済み ${session.size} 曲）`;
  if (navigator.storage?.estimate) {
    const { usage = 0 } = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    line += `\nアプリの使用容量 ${gb(usage)} GB`;
    if (!persisted) line += '\n※ホーム画面に追加すると、保存データがブラウザに削除されにくくなります。';
  }
  $('#usage').textContent = line;
}

// "please pick files" banner, shown above the mini player
function needFiles(msg) { $('#needMsg').textContent = msg; $('#need').classList.add('show'); }
function hideNeed() { $('#need').classList.remove('show'); }

// ------------------------------------------------------------------ rendering
const coverStyle = key => (key && covers.has(key) ? `style="background-image:url('${covers.get(key)}')"` : '');
const noteIcon = '<svg class="icon"><use href="#i-note"/></svg>';

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === state.view));
  const main = $('#main');
  if (!state.tracks.length) {
    main.innerHTML = `<div class="empty"><p>まだ曲がありません。<br>端末の音楽ファイルを選択してください。<br>
      <small>曲名・アルバム・ジャケットの情報だけを記憶し、ファイルのコピーは作りません。</small></p>
      <button class="btn primary" data-act="pick">音楽ファイルを選択</button></div>`;
    return;
  }
  const notice = session.size ? '' : `<div class="notice"><span>今回はまだファイルを選択していません。保存済みの ${state.tracks.filter(t => t.cachedBytes > 0).length} 曲は再生できます。</span>
    <button class="btn primary" data-act="pick">選択</button></div>`;
  if (state.view === 'albums' && state.album) return renderAlbum(main);
  if (state.view === 'albums') {
    const list = albums();
    main.innerHTML = notice + (list.length ? `<div class="grid">${list.map((a, i) => `
      <button class="album" data-album="${i}">
        <div class="cover" ${coverStyle(a.coverKey)}>${a.coverKey ? '' : noteIcon}</div>
        <div class="t">${esc(a.album)}</div><div class="a">${esc(a.artist)}・${a.tracks.length}曲</div>
      </button>`).join('')}</div>` : '<div class="empty">見つかりませんでした</div>');
    main._albums = list;
    return;
  }
  const list = songs();
  main._songs = list;
  main.innerHTML = notice + (list.length ? `<div class="list">${list.map((t, i) => songRow(t, i, true)).join('')}</div>`
    : '<div class="empty">見つかりませんでした</div>');
}

function songRow(t, i, withThumb) {
  const cls = (cur() && cur().id === t.id ? ' playing' : '') + (playable(t) ? '' : ' na');
  return `<button class="row${cls}" data-song="${i}">
    ${withThumb ? `<div class="thumb cover" ${coverStyle(t.coverKey)}></div>` : `<span class="n">${t.track || ''}</span>`}
    <div class="meta"><div class="t">${esc(t.title)}</div><div class="a">${esc(withThumb ? `${t.artist}・${t.album}` : t.artist)}</div></div>
    ${t.cachedBytes > 0 ? '<span class="saved" title="端末に保存済み">保存済</span>' : ''}
  </button>`;
}

function renderAlbum(main) {
  const a = albums().find(x => x.key === state.album);
  if (!a) { state.album = null; return render(); }
  main._songs = a.tracks;
  main.innerHTML = `
    <button class="back" data-act="back"><svg class="icon"><use href="#i-back"/></svg>アルバム</button>
    <div class="detail-head">
      <div class="cover" ${coverStyle(a.coverKey)}>${a.coverKey ? '' : noteIcon}</div>
      <div><h2>${esc(a.album)}</h2><div class="a" style="color:var(--muted)">${esc(a.artist)}・${a.tracks.length}曲</div></div>
    </div>
    <div class="btns">
      <button class="btn primary" data-act="playAll">再生</button>
      <button class="btn" data-act="shuffleAll">シャッフル再生</button>
      <button class="btn danger" data-act="delAlbum">削除</button>
    </div>
    <div class="list">${a.tracks.map((t, i) => songRow(t, i, false)).join('')}</div>`;
}

$('#main').addEventListener('click', async e => {
  const main = $('#main');
  const el = e.target.closest('[data-album],[data-song],[data-act]');
  if (!el) return;
  if (el.dataset.album != null) { state.album = main._albums[+el.dataset.album].key; render(); window.scrollTo(0, 0); return; }
  if (el.dataset.song != null) { startQueue(main._songs, +el.dataset.song); return; }
  const act = el.dataset.act;
  if (act === 'add') openSettings();
  if (act === 'pick') $('#file').click();
  if (act === 'back') { state.album = null; render(); }
  if (act === 'playAll') startQueue(main._songs, 0, false);
  if (act === 'shuffleAll') startQueue(main._songs, 0, true);
  if (act === 'delAlbum' && confirm('このアルバムをアプリから削除しますか？（端末の元ファイルは消えません）')) {
    await deleteTracks(main._songs); state.album = null; render();
  }
});

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  state.view = b.dataset.view; state.album = null; render();
}));
$('#q').addEventListener('input', e => { state.query = e.target.value.trim(); state.album = null; render(); });

// ------------------------------------------------------------------ filter curves
// Listening level of the loudness preset follows the in-app volume (1 dB steps).
const listenPhon = () => Math.round(Math.min(REF_PHON, Math.max(40, eq.calPhon + (eq.vol - eq.calVol))));

// spec for a curve: preset 'loud' -> ISO 226 + patent HF, otherwise the patent emphasis
function specFor(o = eq) {
  return o.preset === 'loud'
    ? { kind: 'loud', phon: o.phon ?? listenPhon(), refPhon: REF_PHON, cap: 12, C: o.C, fHi: o.fHi }
    : { kind: 'emph', B: o.B, C: o.C, fLo: o.fLo, fHi: o.fHi };
}
const effMode = (o = eq) => (o.preset === 'loud' ? 'fir' : o.mode);   // loudness curve exists only as FIR
const autoPreDb = curve => -0.45 * curve.maxBoostDb;

let curveCache = { key: '', curve: null };
function currentCurve(fs) {
  const spec = specFor(), key = `${fs}|${JSON.stringify(spec)}`;
  if (curveCache.key !== key) curveCache = { key, curve: makeCurve(fs, spec) };
  return curveCache.curve;
}
function preampDb(curve) { return eq.autoPre ? autoPreDb(curve) : eq.pre; }

// Build processing for one condition between `input` and `out`.
// align: delay dry / IIR paths by the FIR latency (N/2) so every condition is sample-aligned.
// Returns the created nodes (to disconnect later).
function buildChain(c, input, out, curve, mode, align = true) {
  const fs = c.sampleRate, nodes = [];
  const delay = () => { const d = c.createDelay(1); d.delayTime.value = align ? (FIR_LEN / 2) / fs : 0; nodes.push(d); return d; };
  if (!curve) { input.connect(delay()).connect(out); return nodes; }               // dry
  if (mode === 'fir') {
    const conv = c.createConvolver();
    conv.normalize = false;
    const buf = c.createBuffer(1, FIR_LEN, fs);
    buf.copyToChannel(designFIR(curve, FIR_LEN), 0);
    conv.buffer = buf;
    input.connect(conv).connect(out); nodes.push(conv);
    return nodes;
  }
  const flt = curve.flt, iir = co => c.createIIRFilter(co.b, co.a), d = delay();
  const direct = c.createGain(), lp = iir(flt.lp), glo = iir(flt.glo), gl = c.createGain(), hp = iir(flt.hp), gh = c.createGain();
  gl.gain.value = -flt.B; gh.gain.value = -flt.C;
  input.connect(d);
  d.connect(direct).connect(out);
  d.connect(lp).connect(glo).connect(gl).connect(out);
  d.connect(hp).connect(gh).connect(out);
  nodes.push(direct, lp, glo, gl, hp, gh);
  return nodes;
}

// ------------------------------------------------------------------ audio engine
//  <audio> ─ src ─┬─ Delay(N/2 for FIR, 0 for IIR) ─ dryGain ─┐
//                 └─ wetIn ─ wet chain ─ wetGain(preamp) ──────┴─ limiter ─ master(vol) ─ out
const audio = new Audio();
audio.preload = 'auto';
let ctx, srcNode, dryDelay, dryGain, wetIn, wetGain, limiter, master, wetChain = null, curUrl = null;

function makeLimiter(c) {
  const l = c.createDynamicsCompressor();
  l.threshold.value = -1; l.knee.value = 0; l.ratio.value = 20;
  l.attack.value = 0.002; l.release.value = 0.15;
  return l;
}

function ensureEngine() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  srcNode = ctx.createMediaElementSource(audio);
  dryDelay = ctx.createDelay(1); dryDelay.delayTime.value = (FIR_LEN / 2) / ctx.sampleRate;
  dryGain = ctx.createGain(); wetIn = ctx.createGain(); wetGain = ctx.createGain();
  limiter = makeLimiter(ctx);
  master = ctx.createGain(); master.gain.value = dbToLin(eq.vol);
  srcNode.connect(dryDelay).connect(dryGain).connect(limiter);
  srcNode.connect(wetIn);
  wetGain.connect(limiter);
  limiter.connect(master).connect(ctx.destination);
  rebuildWet(true);
}

// Build a new wet chain and crossfade to it (avoids clicks while dragging sliders / changing volume).
let builtKey = '';
function rebuildWet(immediate = false) {
  if (!ctx) return;
  const curve = currentCurve(ctx.sampleRate), mode = effMode();
  const key = `${curveCache.key}|${mode}`;
  if (key === builtKey && wetChain) { applyMix(immediate); return; }
  builtKey = key;
  const out = ctx.createGain();
  // player: IIR keeps its zero latency (dry path follows), FIR delays the dry path to stay aligned
  const nodes = buildChain(ctx, wetIn, out, curve, mode, false);
  dryDelay.delayTime.value = mode === 'fir' ? (FIR_LEN / 2) / ctx.sampleRate : 0;
  out.connect(wetGain);
  const t = ctx.currentTime, fade = immediate ? 0.001 : 0.06;
  out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(1, t + fade);
  const old = wetChain;
  if (old) {
    old.out.gain.setValueAtTime(old.out.gain.value, t); old.out.gain.linearRampToValueAtTime(0, t + fade);
    setTimeout(() => { old.nodes.forEach(n => n.disconnect()); old.out.disconnect(); }, fade * 1000 + 100);
  }
  wetChain = { out, nodes };
  applyMix(immediate);
}

function applyMix(immediate = false) {
  if (!ctx) return;
  const curve = currentCurve(ctx.sampleRate);
  const wet = eq.enabled ? dbToLin(preampDb(curve)) : 0, dry = eq.enabled ? 0 : 1;
  const t = ctx.currentTime, tc = immediate ? 0.001 : 0.03;
  wetGain.gain.setTargetAtTime(wet, t, tc);
  dryGain.gain.setTargetAtTime(dry, t, tc);
  master.gain.setTargetAtTime(dbToLin(eq.vol), t, tc);
}

// ------------------------------------------------------------------ playback
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startQueue(list, index, forceShuffle) {
  ensureEngine();   // create AudioContext synchronously inside the tap handler (autoplay policy)
  stopTest();
  let q = list.slice(), i = index;
  const sh = forceShuffle ?? prefs.shuffle;
  if (forceShuffle != null) { prefs.shuffle = forceShuffle; save('prefs', prefs); syncToggles(); }
  if (sh) { const first = q.splice(index, 1)[0]; q = [first, ...shuffleArr(q)]; i = 0; }
  state.queue = q;
  playIndex(i);
}

// Play queue[i]. When `auto`, skip tracks whose file is not available this session.
async function playIndex(i, auto = false) {
  const n = state.queue.length;
  for (let k = 0; k < n; k++, i++) {
    if (i >= n) { if (!auto || prefs.repeat === 'all') i = 0; else break; }
    const t = state.queue[i];
    const src = await sourceFor(t);
    if (!src) {
      if (auto) continue;
      needFiles(`「${t.title}」のファイルが選択されていません`);
      return;
    }
    state.qi = i;
    if (curUrl) URL.revokeObjectURL(curUrl);
    curUrl = URL.createObjectURL(src.blob);
    ensureEngine();
    audio.src = curUrl;
    try { await ctx.resume(); await audio.play(); } catch (e) { toast('再生できませんでした：' + (e.message || e)); }
    t.lastPlayed = Date.now();
    put('tracks', t).catch(() => {});
    if (src.fromSession) cacheTrack(t, src.blob);   // background copy for next time (LRU)
    updateNowPlaying();
    render();
    return;
  }
  audio.pause();
  needFiles('続きの曲のファイルが選択されていません');
}

function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && prefs.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  let i = state.qi + 1;
  if (i >= state.queue.length) { if (prefs.repeat === 'all' || !auto) i = 0; else return; }
  playIndex(i, true);
}
function prev() {
  if (audio.currentTime > 3 || state.qi <= 0) { audio.currentTime = 0; return; }
  playIndex(state.qi - 1);
}
function togglePlay() {
  if (!cur()) { const list = $('#main')._songs || songs(); if (list?.length) startQueue(list, 0); return; }
  if (audio.paused) { stopTest(); ctx?.resume(); audio.play(); } else audio.pause();
}

audio.addEventListener('ended', () => next(true));
audio.addEventListener('play', () => { ctx?.resume(); syncPlayIcons(); });
audio.addEventListener('pause', syncPlayIcons);
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0, c = audio.currentTime || 0;
  $('#miniBar').style.width = d ? `${(c / d) * 100}%` : '0';
  if (!seeking) $('#seek').value = d ? Math.round((c / d) * 1000) : 0;
  $('#tCur').textContent = fmt(c); $('#tDur').textContent = fmt(d);
  if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: 1 }); } catch (_) { /* ignore */ }
  }
});

let seeking = false;
$('#seek').addEventListener('input', () => { seeking = true; $('#tCur').textContent = fmt((audio.duration || 0) * $('#seek').value / 1000); });
$('#seek').addEventListener('change', () => { if (audio.duration) audio.currentTime = audio.duration * $('#seek').value / 1000; seeking = false; });

function syncPlayIcons() {
  const icon = audio.paused ? '#i-play' : '#i-pause';
  document.querySelectorAll('#play use, #miniPlay use').forEach(u => u.setAttribute('href', icon));
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

function updateNowPlaying() {
  const t = cur(); if (!t) return;
  $('#mini').classList.add('show');
  $('#miniTitle').textContent = $('#npTitle').textContent = t.title;
  $('#miniArtist').textContent = $('#npArtist').textContent = `${t.artist}・${t.album}`;
  const bg = t.coverKey && covers.has(t.coverKey) ? `url('${covers.get(t.coverKey)}')` : '';
  $('#miniCover').style.backgroundImage = bg; $('#npCover').style.backgroundImage = bg;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: t.coverKey && covers.has(t.coverKey) ? [{ src: covers.get(t.coverKey), sizes: '512x512' }] : [],
    });
  }
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => { stopTest(); ctx?.resume(); audio.play(); });
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', prev);
  ms.setActionHandler('nexttrack', () => next());
  try { ms.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; }); } catch (_) { /* unsupported */ }
}

// ------------------------------------------------------------------ transport UI
$('#play').onclick = $('#miniPlay').onclick = togglePlay;
$('#next').onclick = $('#miniNext').onclick = () => next();
$('#prev').onclick = prev;
$('#miniOpen').onclick = () => { $('#np').classList.add('open'); drawGraph(); };
$('#npClose').onclick = () => $('#np').classList.remove('open');
function syncToggles() {
  $('#shuf').classList.toggle('on', prefs.shuffle);
  $('#rep').classList.toggle('on', prefs.repeat !== 'off');
  $('#rep').style.opacity = prefs.repeat === 'one' ? '1' : '';
  $('#rep').title = { all: 'すべてリピート', one: '1曲リピート', off: 'リピートなし' }[prefs.repeat];
}
$('#shuf').onclick = () => {
  prefs.shuffle = !prefs.shuffle; save('prefs', prefs); syncToggles();
  if (cur()) { const now = cur(); const rest = state.queue.filter(t => t !== now); state.queue = [now, ...(prefs.shuffle ? shuffleArr(rest) : rest.sort(byTrack))]; state.qi = 0; }
};
$('#rep').onclick = () => {
  prefs.repeat = { all: 'one', one: 'off', off: 'all' }[prefs.repeat]; save('prefs', prefs); syncToggles();
  toast($('#rep').title, 1200);
};

// ------------------------------------------------------------------ settings sheet
function openSettings() { $('#settings').classList.add('open'); updateUsage(); }
$('#addBtn').onclick = () => $('#file').click();
$('#needPick').onclick = () => $('#file').click();
$('#needClose').onclick = hideNeed;
$('#setBtn').onclick = openSettings;
$('#setClose').onclick = () => $('#settings').classList.remove('open');
$('#pickFiles').onclick = () => $('#file').click();
$('#pickDir').onclick = () => $('#dir').click();
$('#file').onchange = e => { scanFiles(e.target.files); e.target.value = ''; $('#settings').classList.remove('open'); };
$('#dir').onchange = e => { scanFiles(e.target.files); e.target.value = ''; $('#settings').classList.remove('open'); };
$('#sCache').addEventListener('input', e => { prefs.cacheGB = +e.target.value; save('prefs', prefs); updateUsage(); });
$('#sCache').addEventListener('change', async () => { await enforceCache(); render(); updateUsage(); });
$('#clearCache').onclick = async () => { if (confirm('保存済みの曲データを消去しますか？（曲情報と元ファイルは残ります）')) await clearCache(); };
$('#wipe').onclick = async () => {
  if (!confirm('曲情報と保存済みデータをすべて削除しますか？（端末の元ファイルは消えません）')) return;
  audio.pause(); state.queue = []; state.qi = -1; $('#mini').classList.remove('show');
  await deleteTracks(state.tracks.slice());
};

// ------------------------------------------------------------------ volume + EQ UI
let rebuildTimer;
function eqChanged(structural) {
  save('eq', eq); syncEqUI(); drawGraph();
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => (structural ? rebuildWet() : applyMix()), 120);
}
function syncEqUI() {
  const loud = eq.preset === 'loud';
  $('#eqOn').classList.toggle('on', eq.enabled);
  $('#miniEq').classList.toggle('off', !eq.enabled);
  $('#miniEq').textContent = eq.enabled ? (loud ? 'LD' : 'EQ') : 'OFF';
  document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', b.dataset.p === eq.preset));
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === effMode()));
  $('#modeSeg').style.opacity = loud ? '0.5' : '';
  $('#loudModeNote').hidden = !loud;
  $('#rowB').hidden = loud;
  $('#loudBox').hidden = !loud;
  $('#sB').value = eq.B; $('#vB').textContent = eq.B.toFixed(1);
  $('#sC').value = eq.C; $('#vC').textContent = eq.C.toFixed(1);
  $('#sLo').value = eq.fLo; $('#vLo').textContent = `${eq.fLo} Hz`;
  $('#sHi').value = eq.fHi; $('#vHi').textContent = `${(eq.fHi / 1000).toFixed(2)} kHz`;
  $('#cWarn').hidden = !(eq.C > 0 && eq.C < 2);
  $('#autoPre').checked = eq.autoPre;
  $('#preBox').style.display = eq.autoPre ? 'none' : '';
  $('#sPre').value = eq.pre; $('#vPre').textContent = `${eq.pre.toFixed(1)} dB`;
  $('#eqCard').style.opacity = eq.enabled ? '1' : '0.6';
  $('#sVol').value = eq.vol;
  $('#vVol').textContent = `${sgn(eq.vol)} dB`;
  $('#volPhon').textContent = loud ? `聴感 約 ${listenPhon()} phon` : '';
  $('#sCalPhon').value = eq.calPhon; $('#vCalPhon').textContent = `${eq.calPhon} phon`;
  $('#calInfo').textContent = `基準：アプリ音量 ${sgn(eq.calVol)} dB ＝ ${eq.calPhon} phon。いまは ${listenPhon()} phon として補正中。`;
}
$('#eqOn').onclick = () => { eq.enabled = !eq.enabled; eqChanged(false); toast(eq.enabled ? 'エンファシス ON' : 'エンファシス OFF（原音）', 1000); };
$('#miniEq').onclick = $('#eqOn').onclick;
document.querySelectorAll('#presets button').forEach(b => b.onclick = () => {
  eq.preset = b.dataset.p;
  if (PRESETS[eq.preset]) Object.assign(eq, PRESETS[eq.preset]);
  eq.enabled = true; eqChanged(true);
});
document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => {
  if (eq.preset === 'loud') { toast('ラウドネス連動は直線位相 (FIR) のみです', 2000); return; }
  eq.mode = b.dataset.m; eqChanged(true);
});
const slide = (id, key, structural = true) => $(id).addEventListener('input', e => {
  eq[key] = +e.target.value;
  if (key === 'B' || (key === 'C' && eq.preset !== 'loud')) eq.preset = 'custom';
  eqChanged(structural);
});
slide('#sB', 'B'); slide('#sC', 'C'); slide('#sLo', 'fLo'); slide('#sHi', 'fHi'); slide('#sPre', 'pre', false);
slide('#sCalPhon', 'calPhon', true);
$('#autoPre').onchange = e => { eq.autoPre = e.target.checked; eqChanged(false); };

// Volume: changes master gain at once; in the loudness preset the curve follows (rebuild only when phon changes).
$('#sVol').addEventListener('input', e => {
  eq.vol = +e.target.value;
  if (ctx) master.gain.setTargetAtTime(dbToLin(eq.vol), ctx.currentTime, 0.03);
  eqChanged(eq.preset === 'loud');
});
$('#calBtn').onclick = () => {
  eq.calVol = eq.vol; eqChanged(true);
  toast(`いまの音量を ${eq.calPhon} phon の基準にしました`, 2000);
};

function drawGraph() {
  const cv = $('#graph'), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300, h = cv.clientHeight || 150;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const fs = ctx?.sampleRate || 48000, curve = currentCurve(fs);
  const lo = -3, hi = Math.max(15, Math.ceil(curve.maxBoostDb / 3) * 3 + 3);
  const fx = f => (Math.log10(f / 20) / 3) * w, dy = d => h - ((d - lo) / (hi - lo)) * h;
  const css = getComputedStyle(document.documentElement);
  g.strokeStyle = css.getPropertyValue('--line'); g.fillStyle = css.getPropertyValue('--muted');
  g.lineWidth = 1; g.font = '10px system-ui';
  for (const f of [50, 100, 500, 1000, 5000, 10000]) {
    g.beginPath(); g.moveTo(fx(f), 0); g.lineTo(fx(f), h); g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), fx(f) + 3, h - 4);
  }
  for (let d = 0; d <= hi; d += 6) {
    g.beginPath(); g.moveTo(0, dy(d)); g.lineTo(w, dy(d)); g.stroke();
    g.fillText(`${d > 0 ? '+' : ''}${d} dB`, 4, dy(d) - 3);
  }
  const plot = (c, color, width, dash = []) => {
    g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.beginPath();
    for (let i = 0; i <= 240; i++) {
      const f = 20 * Math.pow(1000, i / 240), y = dy(c ? c.magDb(f) : 0);
      i ? g.lineTo(fx(f), y) : g.moveTo(fx(f), y);
    }
    g.stroke(); g.setLineDash([]);
  };
  if (eq.preset === 'loud' && eq.enabled) {   // reference: the B8C5 curve the user liked
    plot(makeCurve(fs, { kind: 'emph', B: 8, C: eq.C, fLo: eq.fLo, fHi: eq.fHi }), css.getPropertyValue('--muted'), 1.5, [4, 4]);
  }
  plot(eq.enabled ? curve : null, eq.enabled ? css.getPropertyValue('--accent') : css.getPropertyValue('--muted'), 2.5);
  $('#stMax').textContent = `最大 +${curve.maxBoostDb.toFixed(1)} dB` + (eq.preset === 'loud' ? `・${listenPhon()} phon（点線は強 B8C5）` : '');
  $('#stPre').textContent = `プリアンプ ${preampDb(curve).toFixed(1)} dB・${effMode() === 'fir' ? '直線位相' : 'アナログ型'}`;
}
window.addEventListener('resize', () => { if ($('#np').classList.contains('open')) drawGraph(); });

// ------------------------------------------------------------------ listening test (blind A/B, ABX)
// Both conditions run in parallel from ONE looping buffer source, so they are sample-aligned;
// switching only crossfades two gains (20 ms). Levels are matched by K-weighted loudness of the segment.
const CONDS = {
  dry: { label: '原音（エンファシスなし）' },
  std: { label: '標準 B3C3（直線位相）', o: { preset: 'std', B: 3, C: 3, mode: 'fir' } },
  strong: { label: '強 B8C5（直線位相）', o: { preset: 'strong', B: 8, C: 5, mode: 'fir' } },
  strongIIR: { label: '強 B8C5（アナログ型 IIR）', o: { preset: 'strong', B: 8, C: 5, mode: 'iir' } },
  loud: { label: 'ラウドネス連動（いまの音量）', o: { preset: 'loud', C: 5 } },
  current: { label: 'いまの設定', o: null },
};
const condObj = id => (id === 'current' ? { ...eq } : { ...eq, ...CONDS[id].o, phon: undefined });
const condCurve = (id, fs) => (id === 'dry' ? null : makeCurve(fs, specFor(condObj(id))));
const condMode = id => (id === 'dry' ? 'fir' : effMode(condObj(id)));
const condLabel = id => (id === 'current' ? `いまの設定（${eq.enabled ? presetName() : '原音'}）` : CONDS[id].label);
function presetName() {
  return { std: '標準', strong: '強', loud: 'ラウドネス連動', custom: `カスタム B${eq.B}C${eq.C}` }[eq.preset] + (effMode() === 'iir' ? '・IIR' : '');
}

const testCfg = load('abxCfg', { mode: 'pref', a: 'strong', b: 'loud', n: 10, len: 15, match: true });
let T = null;   // running test

function openTest() {
  if (!cur()) { toast('先に曲を再生してください'); return; }
  $('#cmp').classList.add('open');
  if (!T) renderSetup();
}
function closeTest() { stopTest(); $('#cmp').classList.remove('open'); }
$('#cmpBtn').onclick = openTest;
$('#cmpClose').onclick = closeTest;

function renderSetup() {
  const opts = sel => Object.keys(CONDS).map(k => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(condLabel(k))}</option>`).join('');
  const start = Math.max(0, Math.floor(audio.currentTime || 0));
  $('#cmpBody').innerHTML = `
    <div class="card">
      <h3>比べる設定</h3>
      <div class="field"><span>A</span><select id="tA">${opts(testCfg.a)}</select></div>
      <div class="field"><span>B</span><select id="tB">${opts(testCfg.b)}</select></div>
      <div class="seg" id="tMode" style="margin-top:12px">
        <button data-m="pref" class="${testCfg.mode === 'pref' ? 'on' : ''}">どちらが好み（ブラインドAB）</button>
        <button data-m="abx" class="${testCfg.mode === 'abx' ? 'on' : ''}">違いが分かるか（ABX）</button>
      </div>
      <p class="hint" id="tModeHint"></p>
      <div class="slider"><label>試行回数 <b id="vN"></b></label><input type="range" id="tN" min="6" max="24" step="2" value="${testCfg.n}"></div>
      <div class="slider"><label>区間の長さ <b id="vLen"></b></label><input type="range" id="tLen" min="5" max="30" step="1" value="${testCfg.len}"></div>
      <div class="slider"><label>区間の開始位置 <b id="vSt"></b></label><input type="range" id="tSt" min="0" max="${Math.max(0, Math.floor((audio.duration || 0) - 5))}" step="1" value="${start}"></div>
      <label class="check"><input type="checkbox" id="tMatch" ${testCfg.match ? 'checked' : ''}> 音量を自動で揃える（推奨）</label>
      <p class="hint">曲：${esc(cur().title)}。テスト中は通常の再生を止めます。</p>
      <div class="btns"><button class="btn primary" id="tGo">開始</button></div>
    </div>
    ${historyHtml()}`;
  const sync = () => {
    $('#vN').textContent = `${$('#tN').value} 回`;
    $('#vLen').textContent = `${$('#tLen').value} 秒`;
    $('#vSt').textContent = fmt(+$('#tSt').value);
    $('#tModeHint').textContent = testCfg.mode === 'abx'
      ? 'X が A と B のどちらかを当てます。16 回中 12 回以上正解なら「聞き分けられている」と言えます（p < 0.05）。'
      : 'ラベルを伏せた 1・2 を聴き比べ、好きな方を選びます。終わったら A・B のどちらを選んでいたかを表示します。';
  };
  sync();
  ['#tN', '#tLen', '#tSt'].forEach(id => $(id).addEventListener('input', sync));
  document.querySelectorAll('#tMode button').forEach(b => b.onclick = () => {
    testCfg.mode = b.dataset.m;
    if (testCfg.mode === 'abx' && +$('#tN').value < 16) $('#tN').value = 16;
    document.querySelectorAll('#tMode button').forEach(x => x.classList.toggle('on', x === b)); sync();
  });
  $('#tGo').onclick = startTest;
  bindHistory();
}

async function startTest() {
  Object.assign(testCfg, { a: $('#tA').value, b: $('#tB').value, n: +$('#tN').value, len: +$('#tLen').value, match: $('#tMatch').checked });
  save('abxCfg', testCfg);
  if (testCfg.a === testCfg.b) { toast('A と B に違う設定を選んでください'); return; }
  const track = cur(), start = +$('#tSt').value;
  ensureEngine(); await ctx.resume();
  audio.pause();
  $('#cmpBody').innerHTML = '<div class="card"><p class="hint">曲を読み込み、音量を測っています…</p></div>';
  try {
    const src = await sourceFor(track);
    if (!src) throw new Error('ファイルが選択されていません');
    const full = await ctx.decodeAudioData(await src.blob.arrayBuffer());
    const fs = ctx.sampleRate, s0 = Math.min(Math.floor(start * fs), Math.max(0, full.length - fs));
    const n = Math.min(Math.floor(testCfg.len * fs), full.length - s0);
    const buf = ctx.createBuffer(full.numberOfChannels, n, fs), fade = Math.floor(0.02 * fs);
    for (let ch = 0; ch < full.numberOfChannels; ch++) {
      const x = full.getChannelData(ch).slice(s0, s0 + n);
      for (let i = 0; i < fade; i++) { const g = i / fade; x[i] *= g; x[n - 1 - i] *= g; }
      buf.copyToChannel(x, ch);
    }
    // level matching on the segment (K-weighted, ungated)
    const spec = powerSpectrum([...Array(buf.numberOfChannels).keys()].map(c => buf.getChannelData(c)), fs);
    const kw = kWeighting(fs);
    const ids = [testCfg.a, testCfg.b], curves = ids.map(id => condCurve(id, fs));
    const loud = curves.map(c => spectrumLoudness(spec, c ? c.magLin : undefined, kw));
    const headroom = -0.45 * Math.max(0, ...curves.map(c => (c ? c.maxBoostDb : 0)));
    const gains = testCfg.match
      ? loud.map(L => headroom + Math.min(...loud) - L)
      : curves.map(c => (c ? autoPreDb(c) : 0));
    buildTestGraph(buf, ids, curves, gains);
    T.meta = { title: track.title, start, len: n / fs, gains, loudDiff: loud[1] - loud[0] };
    T.trials = makeTrials(testCfg.mode, testCfg.n);
    T.i = 0; T.answers = [];
    playTarget(T.trials[0].first);
    renderTrial();
  } catch (e) {
    stopTest();
    $('#cmpBody').innerHTML = `<div class="card"><p class="hint warn">開始できませんでした：${esc(e.message || e)}</p>
      <div class="btns"><button class="btn" id="tBack">戻る</button></div></div>`;
    $('#tBack').onclick = renderSetup;
  }
}

function buildTestGraph(buf, ids, curves, gains) {
  stopTest();
  const lim = makeLimiter(ctx), input = ctx.createGain(), sel = [], nodes = [lim, input];
  lim.connect(master);
  ids.forEach((id, k) => {
    const out = ctx.createGain(), g = ctx.createGain();
    g.gain.value = 0;
    nodes.push(...buildChain(ctx, input, out, curves[k], condMode(id)), out, g);
    out.gain.value = dbToLin(gains[k]);
    out.connect(g).connect(lim);
    sel.push(g);
  });
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true; src.connect(input); src.start(ctx.currentTime + 0.05);
  T = { ids, sel, nodes, src, buf, playing: -1 };
}

function stopTest() {
  if (!T) return;
  try { T.src.stop(); } catch (_) { /* already stopped */ }
  T.src.disconnect(); T.nodes.forEach(n => n.disconnect()); T.sel.forEach(n => n.disconnect());
  T = null;
}

// which: 0 = A, 1 = B
function playTarget(which) {
  if (!T) return;
  const t = ctx.currentTime;
  T.sel.forEach((g, k) => {
    g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(k === which ? 1 : 0, t + 0.02);
  });
  T.playing = which;
}
function restartSegment() {
  if (!T) return;
  const src = ctx.createBufferSource();
  src.buffer = T.buf; src.loop = true; src.connect(T.nodes[1]);
  const t = ctx.currentTime;
  T.sel.forEach(g => { g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + 0.02); });
  try { T.src.stop(t + 0.03); } catch (_) { /* ignore */ }
  src.start(t + 0.04);
  T.src = src;
  const w = T.playing; T.playing = -1;
  setTimeout(() => playTarget(w < 0 ? 0 : w), 50);
}

const coin = () => (crypto.getRandomValues(new Uint8Array(1))[0] & 1);
function makeTrials(mode, n) {
  // pref: slot 1 maps to A or B at random. abx: X is A or B, balanced (n/2 each) in random order.
  if (mode === 'pref') return Array.from({ length: n }, () => { const one = coin(); return { one, first: one }; });
  const xs = Array.from({ length: n }, (_, i) => i % 2);
  for (let i = n - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [xs[i], xs[j]] = [xs[j], xs[i]]; }
  return xs.map(x => ({ x, first: 0, heardX: false }));
}

function renderTrial() {
  const tr = T.trials[T.i], n = T.trials.length, abx = testCfg.mode === 'abx';
  const btn = (label, key, on) => `<button class="pick${on ? ' on' : ''}" data-k="${key}">${label}</button>`;
  const playing = T.playing;
  let listen, answer;
  if (abx) {
    const isX = T.listenX;
    listen = btn('A', 'a', !isX && playing === 0) + btn('B', 'b', !isX && playing === 1) + btn('X', 'x', isX);
    answer = `<button class="btn" data-ans="0" ${tr.heardX ? '' : 'disabled'}>X は A</button>
              <button class="btn" data-ans="1" ${tr.heardX ? '' : 'disabled'}>X は B</button>`;
  } else {
    const slot = playing < 0 ? -1 : (playing === tr.one ? 1 : 2);
    listen = btn('1', 's1', slot === 1) + btn('2', 's2', slot === 2);
    answer = '<button class="btn" data-ans="1">1 が好み</button><button class="btn" data-ans="2">2 が好み</button>';
  }
  $('#cmpBody').innerHTML = `
    <div class="card">
      <h3>${abx ? 'ABX' : 'ブラインド AB'}<span class="hint" style="margin:0">試行 ${T.i + 1} / ${n}</span></h3>
      <div class="progress"><i style="width:${(T.i / n) * 100}%"></i></div>
      <div class="picks">${listen}</div>
      <p class="hint" style="text-align:center">${abx ? 'A・B・X を何度でも切り替えて聴けます。X を聴いてから答えてください。' : '1・2 を何度でも切り替えて聴けます。'}</p>
      <div class="btns answer">${answer}</div>
      <div class="btns"><button class="btn" id="tRestart">区間の頭から</button><button class="btn danger" id="tStop">中止</button></div>
    </div>`;
  $('#cmpBody').querySelectorAll('.pick').forEach(b => b.onclick = () => {
    const k = b.dataset.k;
    if (k === 'a') { T.listenX = false; playTarget(0); }
    if (k === 'b') { T.listenX = false; playTarget(1); }
    if (k === 'x') { T.listenX = true; tr.heardX = true; playTarget(tr.x); }
    if (k === 's1') playTarget(tr.one);
    if (k === 's2') playTarget(1 - tr.one);
    renderTrial();
  });
  $('#cmpBody').querySelectorAll('[data-ans]').forEach(b => b.onclick = () => answerTrial(+b.dataset.ans));
  $('#tRestart').onclick = restartSegment;
  $('#tStop').onclick = () => { stopTest(); renderSetup(); };
}

function answerTrial(ans) {
  const tr = T.trials[T.i];
  // abx: ans 0/1 = guessed A/B; pref: ans 1/2 = slot -> chosen condition index
  T.answers.push(testCfg.mode === 'abx' ? { ok: ans === tr.x } : { pick: ans === 1 ? tr.one : 1 - tr.one });
  T.i++; T.listenX = false;
  if (T.i < T.trials.length) {
    const nx = T.trials[T.i];
    playTarget(testCfg.mode === 'abx' ? 0 : nx.one);
    renderTrial();
  } else finishTest();
}

function finishTest() {
  const n = T.answers.length, abx = testCfg.mode === 'abx';
  const k = abx ? T.answers.filter(a => a.ok).length : T.answers.filter(a => a.pick === 0).length;
  const p = abx ? abxP(n, k) : prefP(n, k);
  const [A, B] = T.ids.map(condLabel), m = T.meta;
  const rec = { date: new Date().toISOString(), mode: testCfg.mode, a: A, b: B, track: m.title, start: m.start, len: +m.len.toFixed(1),
    matched: testCfg.match, gainA: +m.gains[0].toFixed(2), gainB: +m.gains[1].toFixed(2), n, k, p: +p.toFixed(4) };
  const hist = loadHistory(); hist.unshift(rec); saveHistory(hist.slice(0, 200));
  let verdict;
  if (abx) {
    verdict = p < 0.05 ? `違いを聞き分けられています（p = ${p.toFixed(3)}）。` : `偶然の範囲です（p = ${p.toFixed(3)}）。この区間では違いが分からないと言えます。`;
  } else {
    const fav = k > n - k ? A : k < n - k ? B : null;
    verdict = !fav ? `好みは半々でした（p = ${p.toFixed(2)}）。`
      : p < 0.05 ? `「${fav}」がはっきり好まれています（p = ${p.toFixed(3)}）。`
      : `「${fav}」の方が多く選ばれましたが、偶然の可能性もあります（p = ${p.toFixed(2)}）。回数を増やすか、別の区間で確かめてください。`;
  }
  // keep looping so the user can listen to the revealed A/B
  $('#cmpBody').innerHTML = `
    <div class="card">
      <h3>結果</h3>
      <div class="result">${abx ? `正解 <b>${k}</b> / ${n}` : `A を選んだ回数 <b>${k}</b> / ${n}`}</div>
      <p>${esc(verdict)}</p>
      <p class="hint">A：${esc(A)}<br>B：${esc(B)}<br>
        音量補正：A ${sgn(m.gains[0])} dB／B ${sgn(m.gains[1])} dB${testCfg.match ? `（揃える前の差 B−A ${sgn(m.loudDiff)} dB）` : '（自動合わせなし）'}</p>
      <div class="picks"><button class="pick wide" data-k="0">A を聴く</button><button class="pick wide" data-k="1">B を聴く</button></div>
      <div class="btns"><button class="btn primary" id="tAgain">もう一度</button><button class="btn" id="tDone">終了</button></div>
    </div>
    ${historyHtml()}`;
  $('#cmpBody').querySelectorAll('.pick').forEach(b => b.onclick = () => {
    playTarget(+b.dataset.k);
    $('#cmpBody').querySelectorAll('.pick').forEach(x => x.classList.toggle('on', x === b));
  });
  $('#tAgain').onclick = () => { stopTest(); renderSetup(); };
  $('#tDone').onclick = closeTest;
  bindHistory();
}

// ---- history (localStorage) + CSV export
const loadHistory = () => { try { return JSON.parse(localStorage.getItem('abxHistory') || '[]'); } catch (_) { return []; } };
const saveHistory = h => save('abxHistory', h);
function historyHtml() {
  const h = loadHistory();
  if (!h.length) return '';
  const rows = h.slice(0, 20).map(r => {
    const d = new Date(r.date), when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const what = r.mode === 'abx' ? `ABX 正解 ${r.k}/${r.n}` : `好み A ${r.k}/${r.n}`;
    return `<div class="hrow"><div><b>${what}</b>・p=${r.p}<br><small>A ${esc(r.a)} ／ B ${esc(r.b)}<br>${esc(r.track)}・${when}</small></div></div>`;
  }).join('');
  return `<div class="card"><h3>これまでの結果 <span class="hint" style="margin:0">${h.length} 件</span></h3>${rows}
    <div class="btns"><button class="btn" id="hCsv">CSV で書き出す</button><button class="btn danger" id="hClear">履歴を消去</button></div></div>`;
}
function bindHistory() {
  const csv = $('#hCsv'), clr = $('#hClear');
  if (csv) csv.onclick = () => {
    const h = loadHistory(), cols = ['date', 'mode', 'a', 'b', 'track', 'start', 'len', 'matched', 'gainA', 'gainB', 'n', 'k', 'p'];
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const text = '﻿' + [cols.join(','), ...h.map(r => cols.map(c => q(r[c])).join(','))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `listening-tests-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  if (clr) clr.onclick = () => { if (confirm('聴き比べの履歴をすべて消去しますか？')) { saveHistory([]); renderSetup(); } };
}

// ------------------------------------------------------------------ boot
(async function boot() {
  syncEqUI(); syncToggles();
  try {
    db = await openDB();
    state.tracks = await getAll('tracks');
    const fileKeys = new Set(await getAllKeys('files'));
    for (const t of state.tracks) {          // migrate v1 records (id = name|size|mtime, every file copied)
      if (t.mk && t.cachedBytes != null) continue;
      const parts = t.id.split('|');
      t.mk = t.mk || parts.slice(0, 2).join('|');
      t.size = t.size || +parts[1] || 0;
      t.lastPlayed = t.lastPlayed || 0;
      t.cachedBytes = fileKeys.has(t.id) ? ((await get('files', t.id))?.size || 0) : 0;
      await put('tracks', t);
    }
    await enforceCache();
    const keys = await getAllKeys('covers');
    for (const k of keys) {
      const b = await get('covers', k);
      if (b) covers.set(k, URL.createObjectURL(b));
    }
  } catch (e) {
    toast('ライブラリを開けませんでした：' + (e.message || e), 6000);
  }
  render(); updateUsage();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

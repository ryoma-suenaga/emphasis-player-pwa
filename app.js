// app.js - Emphasis Player (PWA): local library, album playback, patent-core emphasis EQ.
import { makeFilter, magDb, maxBoostDb, designFIR, FIR_LEN } from './dsp.js';
import { readTags } from './tags.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => (!isFinite(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const dbToLin = db => Math.pow(10, db / 20);
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
const EQ_DEFAULT = { enabled: true, preset: 'strong', B: 8, C: 5, fLo: 50, fHi: 5000, mode: 'fir', autoPre: true, pre: -6 };
const PRESETS = { std: { B: 3, C: 3 }, strong: { B: 8, C: 5 } };
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

// ------------------------------------------------------------------ audio engine
const audio = new Audio();
audio.preload = 'auto';
let ctx, srcNode, dryDelay, dryGain, wetIn, wetGain, limiter, wetChain = null, curUrl = null;

function ensureEngine() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
  srcNode = ctx.createMediaElementSource(audio);
  dryDelay = ctx.createDelay(1); dryGain = ctx.createGain();
  wetIn = ctx.createGain(); wetGain = ctx.createGain();
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.002; limiter.release.value = 0.15;
  srcNode.connect(dryDelay).connect(dryGain).connect(limiter);
  srcNode.connect(wetIn);
  wetGain.connect(limiter);
  limiter.connect(ctx.destination);
  rebuildWet(true);
}

function preampDb(flt) { return eq.autoPre ? -0.45 * maxBoostDb(flt) : eq.pre; }
function currentFilter(fs) { return makeFilter(fs, { B: eq.B, C: eq.C, fLo: eq.fLo, fHi: eq.fHi }); }

// Build a new wet chain and crossfade to it (avoids clicks while dragging sliders).
function rebuildWet(immediate = false) {
  if (!ctx) return;
  const fs = ctx.sampleRate, flt = currentFilter(fs), out = ctx.createGain(), nodes = [];
  if (eq.mode === 'fir') {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    const buf = ctx.createBuffer(1, FIR_LEN, fs);
    buf.copyToChannel(designFIR(flt, FIR_LEN), 0);
    conv.buffer = buf;
    wetIn.connect(conv).connect(out); nodes.push(conv);
    dryDelay.delayTime.value = (FIR_LEN / 2) / fs;   // keep A/B time-aligned
  } else {
    const iir = c => ctx.createIIRFilter(c.b, c.a);
    const direct = ctx.createGain();
    const lp = iir(flt.lp), glo = iir(flt.glo), gl = ctx.createGain();
    const hp = iir(flt.hp), gh = ctx.createGain();
    gl.gain.value = -flt.B; gh.gain.value = -flt.C;
    wetIn.connect(direct).connect(out);
    wetIn.connect(lp).connect(glo).connect(gl).connect(out);
    wetIn.connect(hp).connect(gh).connect(out);
    nodes.push(direct, lp, glo, gl, hp, gh);
    dryDelay.delayTime.value = 0;
  }
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
  const flt = currentFilter(ctx.sampleRate);
  const wet = eq.enabled ? dbToLin(preampDb(flt)) : 0, dry = eq.enabled ? 0 : 1;
  const t = ctx.currentTime, tc = immediate ? 0.001 : 0.03;
  wetGain.gain.setTargetAtTime(wet, t, tc);
  dryGain.gain.setTargetAtTime(dry, t, tc);
}

// ------------------------------------------------------------------ playback
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startQueue(list, index, forceShuffle) {
  ensureEngine();   // create AudioContext synchronously inside the tap handler (autoplay policy)
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
  if (audio.paused) { ctx?.resume(); audio.play(); } else audio.pause();
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
  ms.setActionHandler('play', () => { ctx?.resume(); audio.play(); });
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

// ------------------------------------------------------------------ EQ UI
let rebuildTimer;
function eqChanged(structural) {
  save('eq', eq); syncEqUI(); drawGraph();
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => (structural ? rebuildWet() : applyMix()), 120);
}
function syncEqUI() {
  $('#eqOn').classList.toggle('on', eq.enabled);
  $('#miniEq').classList.toggle('off', !eq.enabled);
  $('#miniEq').textContent = eq.enabled ? 'EQ' : 'OFF';
  document.querySelectorAll('#presets button').forEach(b => b.classList.toggle('on', b.dataset.p === eq.preset));
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === eq.mode));
  $('#sB').value = eq.B; $('#vB').textContent = eq.B.toFixed(1);
  $('#sC').value = eq.C; $('#vC').textContent = eq.C.toFixed(1);
  $('#sLo').value = eq.fLo; $('#vLo').textContent = `${eq.fLo} Hz`;
  $('#sHi').value = eq.fHi; $('#vHi').textContent = `${(eq.fHi / 1000).toFixed(2)} kHz`;
  $('#cWarn').hidden = !(eq.C > 0 && eq.C < 2);
  $('#autoPre').checked = eq.autoPre;
  $('#preBox').style.display = eq.autoPre ? 'none' : '';
  $('#sPre').value = eq.pre; $('#vPre').textContent = `${eq.pre.toFixed(1)} dB`;
  $('#eqCard').style.opacity = eq.enabled ? '1' : '0.6';
}
$('#eqOn').onclick = () => { eq.enabled = !eq.enabled; eqChanged(false); toast(eq.enabled ? 'エンファシス ON' : 'エンファシス OFF（原音）', 1000); };
$('#miniEq').onclick = $('#eqOn').onclick;
document.querySelectorAll('#presets button').forEach(b => b.onclick = () => {
  eq.preset = b.dataset.p;
  if (PRESETS[eq.preset]) Object.assign(eq, PRESETS[eq.preset]);
  eq.enabled = true; eqChanged(true);
});
document.querySelectorAll('#modeSeg button').forEach(b => b.onclick = () => { eq.mode = b.dataset.m; eqChanged(true); });
const slide = (id, key, structural = true) => $(id).addEventListener('input', e => {
  eq[key] = +e.target.value;
  if (key === 'B' || key === 'C') eq.preset = 'custom';
  eqChanged(structural);
});
slide('#sB', 'B'); slide('#sC', 'C'); slide('#sLo', 'fLo'); slide('#sHi', 'fHi'); slide('#sPre', 'pre', false);
$('#autoPre').onchange = e => { eq.autoPre = e.target.checked; eqChanged(false); };

function drawGraph() {
  const cv = $('#graph'), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300, h = cv.clientHeight || 150;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const fs = ctx?.sampleRate || 48000, flt = currentFilter(fs);
  const lo = -3, hi = Math.max(15, Math.ceil(maxBoostDb(flt) / 3) * 3 + 3);
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
  g.strokeStyle = eq.enabled ? css.getPropertyValue('--accent') : css.getPropertyValue('--muted');
  g.lineWidth = 2.5; g.beginPath();
  for (let i = 0; i <= 240; i++) {
    const f = 20 * Math.pow(1000, i / 240), y = dy(eq.enabled ? magDb(flt, f) : 0);
    i ? g.lineTo(fx(f), y) : g.moveTo(fx(f), y);
  }
  g.stroke();
  const mb = maxBoostDb(flt);
  $('#stMax').textContent = `最大 +${mb.toFixed(1)} dB`;
  $('#stPre').textContent = `プリアンプ ${preampDb(flt).toFixed(1)} dB・${eq.mode === 'fir' ? '直線位相' : 'アナログ型'}`;
}
window.addEventListener('resize', () => { if ($('#np').classList.contains('open')) drawGraph(); });

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

/* Liseuse vocale — application. Aucun jeton n'est écrit dans ce code :
   il est saisi dans les réglages et gardé seulement dans le navigateur de l'appareil. */
'use strict';

const $ = id => document.getElementById(id);
const DEFAULTS = { owner: 'finalcosmic-jma', repo: 'final-cosmic-lore', branch: 'main' };
const BOOKS = { 1: 'La Chute d’Harvard Boy', 4: 'Épisode 1' };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const synth = window.speechSynthesis;

/* ---------- Réglages (localStorage) ---------- */
const S = {
  get(k, d) { try { const v = localStorage.getItem('lv:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('lv:' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('lv:' + k); } catch (e) {} }
};
const cfg = () => ({
  owner: S.get('owner', DEFAULTS.owner), repo: S.get('repo', DEFAULTS.repo),
  branch: S.get('branch', DEFAULTS.branch), token: S.get('token', '')
});

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('liseuse', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('chapters', { keyPath: 'path' });
      d.createObjectStore('files', { keyPath: 'id' });
      d.createObjectStore('progress', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
  });
}
const idb = {
  all: s => tx(s, 'readonly', st => st.getAll()),
  get: (s, k) => tx(s, 'readonly', st => st.get(k)),
  put: (s, v) => tx(s, 'readwrite', st => st.put(v)),
  del: (s, k) => tx(s, 'readwrite', st => st.delete(k)),
  clear: s => tx(s, 'readwrite', st => st.clear())
};

/* ---------- Petits utilitaires ---------- */
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }
function status(msg, err) { const s = $('status'); s.textContent = msg || ''; s.classList.toggle('err', !!err); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function bookName(n) { return 'Livre ' + (ROMAN[n] || n); }
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'à l’instant'; if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60); if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24); return d === 1 ? 'hier' : `il y a ${d} jours`;
}

/* ---------- GitHub ---------- */
class GhError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
async function gh(path) {
  const c = cfg();
  if (!c.token) throw new GhError('notoken', 'Aucun jeton enregistré.');
  let r;
  try {
    r = await fetch('https://api.github.com' + path, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + c.token, 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store'
    });
  } catch (e) { throw new GhError('network', 'Pas de connexion à GitHub. Les chapitres déjà téléchargés restent lisibles.'); }
  if (r.status === 401) throw new GhError('auth', 'GitHub refuse le jeton. Vérifie qu’il est bien copié et qu’il n’a pas expiré.');
  if (r.status === 404) throw new GhError('notfound', 'Dépôt ou branche introuvable, ou le jeton n’a pas accès à ce dépôt.');
  if (r.status === 403 || r.status === 429) throw new GhError('limit', 'GitHub limite les requêtes pour le moment. Réessaie dans quelques minutes.');
  if (!r.ok) throw new GhError('http', 'GitHub a répondu avec une erreur (' + r.status + ').');
  return r.json();
}
function b64utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

let syncing = false;
async function sync(force) {
  if (syncing) return; const c = cfg();
  if (!c.token) { renderLibrary(); return; }
  syncing = true; $('syncBtn').disabled = true; status('Recherche de nouveaux chapitres…');
  try {
    const tree = await gh(`/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/git/trees/${encodeURIComponent(c.branch)}?recursive=1`);
    const remote = (tree.tree || []).filter(f => f.type === 'blob')
      .map(f => ({ f, m: f.path.match(/^livre(\d+)\/ch(\d+)\.md$/i) })).filter(x => x.m)
      .map(x => ({ path: x.f.path, sha: x.f.sha, book: +x.m[1], num: +x.m[2] }));
    const local = new Map((await idb.all('chapters')).map(c => [c.path, c]));
    const firstSync = local.size === 0;
    const todo = remote.filter(r => force || !local.has(r.path) || local.get(r.path).sha !== r.sha);
    let done = 0, added = 0;
    const work = async r => {
      const blob = await gh(`/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/git/blobs/${r.sha}`);
      const text = blob.encoding === 'base64' ? b64utf8(blob.content) : blob.content;
      const old = local.get(r.path);
      const isNew = !old && !firstSync;
      if (isNew) added++;
      await idb.put('chapters', { ...r, text, title: Parse.chapterTitle(text) || ('Chapitre ' + r.num), isNew: isNew || (old && old.isNew) || false, fetched: Date.now() });
      done++; status(`Téléchargement des chapitres… ${done} / ${todo.length}`);
    };
    const queue = todo.slice();
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => { while (queue.length) await work(queue.shift()); }));
    const keep = new Set(remote.map(r => r.path));
    for (const p of local.keys()) if (!keep.has(p)) await idb.del('chapters', p);
    S.set('lastSync', Date.now());
    status(added ? `${added} nouveau${added > 1 ? 'x' : ''} chapitre${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''}.` : (todo.length && !firstSync ? `${todo.length} chapitre${todo.length > 1 ? 's' : ''} mis à jour.` : `À jour · ${remote.length} chapitres.`));
  } catch (e) {
    status(e.message || 'La synchronisation a échoué.', true);
  } finally {
    syncing = false; $('syncBtn').disabled = false; renderLibrary();
  }
}

/* ---------- Bibliothèque ---------- */
let tab = S.get('tab', 'books');
function setTab(t) {
  tab = t; S.set('tab', t);
  for (const [k, id] of [['books', 'Books'], ['history', 'History'], ['files', 'Files']]) {
    $('tab' + id).setAttribute('aria-selected', String(k === t)); $('pane' + id).hidden = k !== t;
  }
}
$('tabBooks').onclick = () => setTab('books');
$('tabHistory').onclick = () => setTab('history');
$('tabFiles').onclick = () => setTab('files');

function progEl(p) {
  if (!p) return el('span', 'prog');
  if (p.pct >= 0.98) return el('span', 'done', 'Lu');
  const w = el('span', 'prog'); const i = el('i'); i.style.width = Math.round(p.pct * 100) + '%'; w.appendChild(i); return w;
}

async function renderLibrary() {
  const [chs, files, progs] = await Promise.all([idb.all('chapters'), idb.all('files'), idb.all('progress')]);
  const P = new Map(progs.map(p => [p.id, p]));
  $('connectCard').hidden = !!cfg().token || chs.length > 0;

  // Reprendre
  const last = progs.filter(p => p.pct < 0.98).sort((a, b) => b.updated - a.updated)[0];
  if (last) {
    $('resume').hidden = false; $('resumeName').textContent = last.title;
    $('resumeSub').textContent = `${last.sub} · ${Math.round(last.pct * 100)} % · ${ago(last.updated)}`;
    $('resume').onclick = () => openItem(last.id);
  } else $('resume').hidden = true;

  // Livres
  const pane = $('paneBooks'); pane.textContent = '';
  const byBook = new Map();
  chs.sort((a, b) => a.book - b.book || a.num - b.num).forEach(c => { if (!byBook.has(c.book)) byBook.set(c.book, []); byBook.get(c.book).push(c); });
  if (!byBook.size) pane.appendChild(el('p', 'empty', cfg().token ? 'Aucun chapitre pour l’instant. Touche le bouton d’actualisation en haut.' : 'Les chapitres de ton dépôt apparaîtront ici.'));
  const openBooks = S.get('openBooks', null);
  const lastBook = last && last.id.startsWith('gh:') ? +(last.id.match(/livre(\d+)/i) || [])[1] : Math.max(...byBook.keys());
  for (const [b, list] of byBook) {
    const d = el('details', 'book');
    d.open = openBooks ? openBooks.includes(b) : b === lastBook;
    d.ontoggle = () => { const o = new Set(S.get('openBooks', [lastBook])); d.open ? o.add(b) : o.delete(b); S.set('openBooks', [...o]); };
    const sm = el('summary'); sm.appendChild(el('h3', null, bookName(b)));
    sm.appendChild(el('span', 'bs', BOOKS[b] || ''));
    const read = list.filter(c => (P.get('gh:' + c.path) || {}).pct >= 0.98).length;
    sm.appendChild(el('span', 'cnt', `${read}/${list.length}`));
    d.appendChild(sm);
    const ol = el('ol', 'list');
    for (const c of list) {
      const li = el('li'); const r = el('button', 'row'); r.type = 'button';
      r.appendChild(el('span', 'num', String(c.num)));
      const tt = el('span', 'tt'); tt.appendChild(el('b', null, c.title)); r.appendChild(tt);
      if (c.isNew) r.appendChild(el('span', 'chip', 'Nouveau'));
      r.appendChild(progEl(P.get('gh:' + c.path)));
      r.onclick = () => openItem('gh:' + c.path);
      li.appendChild(r); ol.appendChild(li);
    }
    d.appendChild(ol); pane.appendChild(d);
  }

  // Historique
  const hp = $('paneHistory'); hp.textContent = '';
  const hist = progs.slice().sort((a, b) => b.updated - a.updated);
  if (!hist.length) hp.appendChild(el('p', 'empty', 'Les chapitres et fichiers que tu écoutes apparaîtront ici.'));
  const hl = el('ol', 'list');
  for (const p of hist) {
    const li = el('li'); const r = el('button', 'row'); r.type = 'button';
    const tt = el('span', 'tt'); tt.appendChild(el('b', null, p.title)); tt.appendChild(el('small', null, `${p.sub} · ${ago(p.updated)}`));
    r.appendChild(tt); r.appendChild(progEl(p)); r.onclick = () => openItem(p.id);
    li.appendChild(r); hl.appendChild(li);
  }
  hp.appendChild(hl);

  // Mes fichiers
  const fl = $('filesList'); fl.textContent = '';
  if (!files.length) fl.appendChild(el('li', 'empty', 'Ajoute un fichier .txt ou .md, ou colle un texte. Il sera gardé ici.'));
  for (const f of files.sort((a, b) => b.added - a.added)) {
    const li = el('li'); li.style.display = 'flex'; li.style.alignItems = 'center';
    const r = el('button', 'row'); r.type = 'button';
    const tt = el('span', 'tt'); tt.appendChild(el('b', null, f.name)); tt.appendChild(el('small', null, 'Ajouté ' + ago(f.added)));
    r.appendChild(tt); r.appendChild(progEl(P.get('file:' + f.id))); r.onclick = () => openItem('file:' + f.id);
    const x = el('button', 'icon ghost del'); x.type = 'button'; x.setAttribute('aria-label', 'Supprimer ' + f.name);
    x.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    x.onclick = async () => {
      if (x.dataset.armed) { await idb.del('files', f.id); await idb.del('progress', 'file:' + f.id); renderLibrary(); toast('Fichier supprimé'); }
      else { x.dataset.armed = '1'; x.style.color = 'var(--warn)'; x.title = 'Touche encore pour supprimer'; toast('Touche encore pour supprimer'); setTimeout(() => { delete x.dataset.armed; x.style.color = ''; }, 3000); }
    };
    li.appendChild(r); li.appendChild(x); fl.appendChild(li);
  }
}

/* Fichiers locaux */
async function addFile(name, text) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await idb.put('files', { id, name, text, added: Date.now() }); return id;
}
$('fileInput').onchange = async e => {
  const list = [...e.target.files]; e.target.value = ''; let lastId;
  for (const f of list) {
    try { lastId = await addFile(f.name.replace(/\.(txt|md|markdown)$/i, ''), await f.text()); }
    catch (err) { toast('Impossible de lire « ' + f.name + ' »'); }
  }
  await renderLibrary(); if (list.length === 1 && lastId) openItem('file:' + lastId);
};
$('pasteBtn').onclick = () => { $('pasteBox').hidden = !$('pasteBox').hidden; if (!$('pasteBox').hidden) $('pasteArea').focus(); };
$('pasteCancel').onclick = () => { $('pasteBox').hidden = true; };
$('pasteSave').onclick = async () => {
  const t = $('pasteArea').value; if (!t.trim()) { $('pasteArea').focus(); return; }
  const name = $('pasteName').value.trim() || (Parse.chapterTitle(t) || t.trim().split('\n')[0]).slice(0, 60);
  const id = await addFile(name, t); $('pasteArea').value = ''; $('pasteName').value = ''; $('pasteBox').hidden = true;
  await renderLibrary(); openItem('file:' + id);
};

/* ---------- Navigation ---------- */
function show(v) {
  for (const id of ['library', 'reader', 'settings']) $(id).hidden = id !== v;
  $('player').hidden = v !== 'reader';
  scrollTo(0, 0);
}
$('settingsBtn').onclick = () => { fillSettings(); show('settings'); };
$('connectGo').onclick = () => { fillSettings(); show('settings'); };
$('setBack').onclick = () => { show('library'); renderLibrary(); };
$('backBtn').onclick = () => { pause(); saveProgress(true); show('library'); renderLibrary(); };
$('syncBtn').onclick = () => sync(false);

/* ---------- Lecteur ---------- */
let item = null;        // { id, title, sub, text, next }
let words = [], sents = [], wordEls = [], sentEls = [];
let cur = 0, playing = false, token = 0, voices = [], wakeLock = null, atEnd = false;

async function openItem(id) {
  let text, title, sub, next = null;
  if (id.startsWith('gh:')) {
    const path = id.slice(3), c = await idb.get('chapters', path);
    if (!c) { toast('Ce chapitre n’est plus dans le dépôt.'); return; }
    text = c.text; title = c.title; sub = `${bookName(c.book)} · Chapitre ${c.num}`;
    if (c.isNew) { c.isNew = false; await idb.put('chapters', c); }
    const all = (await idb.all('chapters')).sort((a, b) => a.book - b.book || a.num - b.num);
    const k = all.findIndex(x => x.path === path); if (k >= 0 && all[k + 1]) next = 'gh:' + all[k + 1].path;
  } else {
    const f = await idb.get('files', id.slice(5));
    if (!f) { toast('Ce fichier a été supprimé.'); return; }
    text = f.text; title = f.name; sub = 'Mes fichiers';
  }
  pause();
  item = { id, title, sub, text, next };
  const p = await idb.get('progress', id);
  build(text);
  $('rBook').textContent = sub; $('rTitle').textContent = title;
  $('nextChBtn').hidden = !next;
  cur = p && p.word < words.length ? p.word : 0;
  atEnd = false; show('reader'); mark(cur, true, true);
  S.set('lastOpen', id);
  return true;
}

function build(md) {
  const { blocks } = Parse.parse(md, { readEpigraph: S.get('readEpi', true) });
  words = []; sents = []; wordEls = []; sentEls = [];
  const root = $('text'); root.textContent = '';
  const reS = /[^.!?…]+(?:[.!?…]+["»”’)\]]*)?\s*|[.!?…]+\s*/g;
  let pauseNext = 0;
  for (const b of blocks) {
    if (b.type === 'sep') { root.appendChild(el('hr', 'sep')); pauseNext = 700; continue; }
    if (b.type === 'table') {
      const w = el('div', 'tbl'), t = el('table');
      for (const row of b.rows) { const tr = el('tr'); row.forEach(c => tr.appendChild(el('td', null, c))); t.appendChild(tr); }
      w.appendChild(t); root.appendChild(w); continue;
    }
    const tag = b.type === 'title' ? 'h2' : b.type === 'heading' ? 'h3' : 'p';
    const cls = { title: 'title', part: 'part', epi: 'epi', 'epi-attr': 'epi-attr', section: 'section', end: 'end', colophon: 'colophon' }[b.type] || '';
    const be = el(tag, cls);
    if (!b.speak) {
      if (b.type === 'epi' || b.type === 'epi-attr') be.classList.add('off');
      if (b.type === 'section') pauseNext = 700;
      appendStyled(be, b.text, b.flags, 0, b.text.length);
      root.appendChild(be); continue;
    }
    for (const m of b.text.matchAll(reS)) {
      const st = m[0]; if (!st.trim()) continue;
      const si = sents.length, se = el('span', 's');
      const sent = { text: st, first: words.length, last: words.length - 1, suffix: '', pause: pauseNext };
      pauseNext = 0; let last = 0;
      for (const w of st.matchAll(/\S+/g)) {
        if (w.index > last) appendStyled(se, st, b.flags, last, w.index, m.index);
        const we = el('span', 'w'); we.dataset.i = words.length;
        appendStyled(we, st, b.flags, w.index, w.index + w[0].length, m.index);
        words.push({ s: si, off: w.index }); wordEls.push(we); se.appendChild(we);
        last = w.index + w[0].length;
      }
      if (last < st.length) se.appendChild(document.createTextNode(st.slice(last)));
      sent.last = words.length - 1;
      if (sent.last >= sent.first) { sents.push(sent); sentEls.push(se); }
      be.appendChild(se);
    }
    if (sents.length && b.suffix) sents[sents.length - 1].suffix = b.suffix;
    if (b.type === 'title' || b.type === 'part' || b.type === 'heading') pauseNext = Math.max(pauseNext, 500);
    root.appendChild(be);
  }
}
/* Ajoute du texte en respectant l'italique / le gras d'origine. base = position de la phrase dans le bloc. */
function appendStyled(parent, str, flags, a, z, base) {
  base = base || 0; let i = a;
  while (i < z) {
    const f = flags[base + i] || 0; let j = i + 1;
    while (j < z && (flags[base + j] || 0) === f) j++;
    const t = str.slice(i, j);
    if (f) { const s = el('span', (f & 1 ? 'it ' : '') + (f & 2 ? 'bd' : ''), t); parent.appendChild(s); }
    else parent.appendChild(document.createTextNode(t));
    i = j;
  }
}

let onWord = null, onSent = null;
function mark(i, scroll, instant) {
  if (!words.length) { $('pos').textContent = 'Rien à lire dans ce texte'; $('pct').textContent = ''; return; }
  i = Math.max(0, Math.min(i, words.length - 1));
  if (onWord) onWord.classList.remove('on');
  onWord = wordEls[i]; onWord.classList.add('on');
  const se = sentEls[words[i].s];
  if (onSent !== se) { if (onSent) onSent.classList.remove('cur'); onSent = se; se.classList.add('cur'); }
  cur = i;
  const pct = words.length > 1 ? i / (words.length - 1) : 0;
  $('pos').textContent = `Phrase ${words[i].s + 1} / ${sents.length}`;
  $('pct').textContent = Math.round(pct * 100) + ' %';
  $('barFill').style.width = pct * 100 + '%';
  if (scroll) {
    const r = onWord.getBoundingClientRect();
    if (r.top < 70 || r.bottom > innerHeight - 180)
      onWord.scrollIntoView({ block: 'center', behavior: instant || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  saveProgress(false);
}
let saveT;
function saveProgress(now) {
  if (!item || !words.length) return;
  clearTimeout(saveT);
  const go = () => idb.put('progress', {
    id: item.id, word: cur, pct: atEnd ? 1 : (words.length > 1 ? cur / (words.length - 1) : 1),
    title: item.title, sub: item.sub, updated: Date.now()
  }).catch(() => {});
  now ? go() : (saveT = setTimeout(go, 1200));
}

/* Voix */
function loadVoices() {
  if (!synth) return; voices = synth.getVoices(); if (!voices.length) return;
  const sel = $('voice'); sel.textContent = '';
  const fr = voices.filter(v => /^fr/i.test(v.lang)), other = voices.filter(v => !/^fr/i.test(v.lang));
  const add = (label, list) => {
    if (!list.length) return; const g = el('optgroup'); g.label = label;
    list.sort((a, b) => a.name.localeCompare(b.name)).forEach(v => { const o = el('option', null, `${v.name} (${v.lang})`); o.value = v.voiceURI; g.appendChild(o); });
    sel.appendChild(g);
  };
  add('Français', fr); add('Autres langues', other);
  const pick = voices.find(v => v.voiceURI === S.get('voice')) || fr.find(v => /premium|amélioré|enhanced/i.test(v.name)) || fr.find(v => v.default) || fr[0] || voices[0];
  if (pick) sel.value = pick.voiceURI;
}
const currentVoice = () => voices.find(v => v.voiceURI === ($('voice').value || S.get('voice')));
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; setTimeout(loadVoices, 600); }

/* Lecture */
const RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const rate = () => S.get('rate', 1);
function showRate() { const r = rate(); $('rateBtn').textContent = String(Math.round(r * 100) / 100).replace('.', ',') + '×'; $('rate').value = r; $('rateVal').textContent = r.toFixed(2).replace('.', ',') + '×'; }
showRate();
$('rateBtn').onclick = () => {
  const r = rate(); const i = RATES.findIndex(x => x > r + 0.001);
  S.set('rate', RATES[i < 0 ? 0 : i]); showRate(); if (playing) speakFrom(cur);
};

function setIcon() {
  $('playIcon').innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
}
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
function speakFrom(i) {
  if (!synth) { toast('La synthèse vocale n’est pas disponible sur cet appareil.'); return; }
  if (!words.length) return;
  const t = ++token; playing = true; atEnd = false; setIcon(); keepAwake(true);
  synth.cancel(); mark(i, true);
  setTimeout(() => { if (t === token) speakSentence(words[cur].s, words[cur].off, t); }, 60);
}
function speakSentence(si, start, t) {
  if (t !== token || !playing) return;
  if (si >= sents.length) { finished(); return; }
  const s = sents[si], text = s.text.slice(start) + s.suffix;
  if (!text.trim()) { speakSentence(si + 1, 0, t); return; }
  const u = new SpeechSynthesisUtterance(text);
  const v = currentVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'fr-FR';
  u.rate = rate();
  let first = s.first; while (first < s.last && words[first].off < start) first++;
  mark(first, true);
  u.onboundary = e => {
    if (t !== token || (e.name && e.name !== 'word')) return;
    const abs = start + e.charIndex; let k = first;
    for (let j = first; j <= s.last; j++) { if (words[j].off <= abs) k = j; else break; }
    if (k !== cur) mark(k, true);
  };
  u.onend = () => {
    if (t !== token || !playing) return;
    const nx = sents[si + 1], gap = nx ? nx.pause : 0;
    gap ? setTimeout(() => speakSentence(si + 1, 0, t), gap) : speakSentence(si + 1, 0, t);
  };
  u.onerror = e => {
    if (t !== token || e.error === 'interrupted' || e.error === 'canceled') return;
    pause(); toast('La voix s’est interrompue. Appuie sur lecture pour reprendre.');
  };
  synth.speak(u);
}
function pause() { token++; playing = false; if (synth) synth.cancel(); setIcon(); keepAwake(false); saveProgress(true); }
async function finished() {
  playing = false; atEnd = true; setIcon(); saveProgress(true);
  if (item && item.next && S.get('autoNext', true)) {
    toast('Chapitre suivant'); const ok = await openItem(item.next);
    if (ok) setTimeout(() => speakFrom(0), 900); return;
  }
  keepAwake(false); toast('Fin du chapitre');
}
function jumpSentence(d) {
  if (!words.length) return;
  let s = words[cur].s;
  if (d < 0 && words[cur].off > 0 && playing) d = 0; // revient d'abord au début de la phrase
  s = Math.min(Math.max(0, s + d), sents.length - 1);
  const i = sents[s].first; atEnd = false;
  playing ? speakFrom(i) : mark(i, true);
}
$('play').onclick = () => { if (playing) pause(); else speakFrom(atEnd ? 0 : cur); };
$('prev').onclick = () => jumpSentence(-1);
$('next').onclick = () => jumpSentence(1);
$('nextChBtn').onclick = async () => { if (!item || !item.next) return; const was = playing; await openItem(item.next); if (was) speakFrom(0); };
$('text').addEventListener('click', e => {
  const w = e.target.closest('.w'); if (!w) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && String(sel).length > 1) return; // texte sélectionné : on laisse le menu d'iOS s'afficher
  speakFrom(+w.dataset.i);
});
$('bar').addEventListener('click', e => {
  if (!words.length) return;
  const r = e.currentTarget.getBoundingClientRect();
  let i = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (words.length - 1));
  i = sents[words[i].s].first; atEnd = false;
  playing ? speakFrom(i) : mark(i, true);
});
document.addEventListener('keydown', e => {
  if ($('reader').hidden || e.target.closest('textarea,input,select')) return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  else if (e.key === 'ArrowLeft') jumpSentence(-1);
  else if (e.key === 'ArrowRight') jumpSentence(1);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveProgress(true); else if (playing) keepAwake(true);
});

/* Tout sélectionner : sélectionne le chapitre pour pouvoir utiliser « Énoncer » d'iOS */
$('selectBtn').onclick = () => {
  if (playing) pause();
  const sel = window.getSelection(), r = document.createRange();
  r.selectNodeContents($('text'));
  sel.removeAllRanges(); sel.addRange(r);
  toast('Texte sélectionné · touche-le pour afficher « Énoncer »');
};

/* Taille du texte */
const SIZES = [1, 1.15, 1.3, 1.5];
function applySize() { document.documentElement.style.setProperty('--fs', S.get('fs', 1.15) + 'rem'); }
applySize();
$('sizeBtn').onclick = () => { const f = S.get('fs', 1.15); const i = SIZES.indexOf(f); S.set('fs', SIZES[(i + 1) % SIZES.length]); applySize(); };

/* ---------- Réglages ---------- */
function fillSettings() {
  const c = cfg();
  $('owner').value = c.owner; $('repo').value = c.repo; $('branch').value = c.branch;
  $('token').value = ''; $('token').placeholder = c.token ? 'Jeton enregistré (laisse vide pour le garder)' : 'github_pat_…';
  $('repoStatus').textContent = ''; $('readEpi').checked = S.get('readEpi', true); $('autoNext').checked = S.get('autoNext', true);
  showRate(); loadVoices();
}
$('saveRepo').onclick = async () => {
  const prev = cfg();
  const owner = $('owner').value.trim(), repo = $('repo').value.trim(), branch = $('branch').value.trim() || 'main';
  const tok = $('token').value.trim() || prev.token;
  const st = $('repoStatus'); st.classList.remove('err');
  if (!owner || !repo) { st.textContent = 'Indique le propriétaire et le nom du dépôt.'; st.classList.add('err'); return; }
  if (!tok) { st.textContent = 'Colle ton jeton d’accès GitHub.'; st.classList.add('err'); return; }
  S.set('owner', owner); S.set('repo', repo); S.set('branch', branch); S.set('token', tok);
  st.textContent = 'Test de la connexion…';
  try {
    await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`);
    st.textContent = 'Connexion réussie. Téléchargement des chapitres…'; $('token').value = '';
    $('token').placeholder = 'Jeton enregistré (laisse vide pour le garder)';
    if (prev.owner !== owner || prev.repo !== repo || prev.branch !== branch) await idb.clear('chapters');
    show('library'); sync(false);
  } catch (e) {
    if (prev.token) S.set('token', prev.token); else S.del('token');
    S.set('owner', prev.owner); S.set('repo', prev.repo); S.set('branch', prev.branch);
    st.textContent = e.message; st.classList.add('err');
  }
};
$('forgetToken').onclick = () => { S.del('token'); fillSettings(); $('repoStatus').textContent = 'Jeton supprimé de cet appareil.'; };
$('voice').onchange = e => { S.set('voice', e.target.value); };
$('rate').oninput = e => { S.set('rate', +e.target.value); showRate(); };
$('readEpi').onchange = e => { S.set('readEpi', e.target.checked); };
$('autoNext').onchange = e => { S.set('autoNext', e.target.checked); };
$('testVoice').onclick = () => {
  if (!synth) return; synth.cancel();
  const u = new SpeechSynthesisUtterance('Bonjour. Voici la voix qui lira tes chapitres.');
  const v = currentVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'fr-FR'; u.rate = rate(); synth.speak(u);
};
$('redownload').onclick = () => { show('library'); sync(true); };
$('clearHistory').onclick = () => { $('confirmClear').hidden = false; };
$('clearNo').onclick = () => { $('confirmClear').hidden = true; };
$('clearYes').onclick = async () => { await idb.clear('progress'); $('confirmClear').hidden = true; toast('Historique effacé'); };

/* ---------- Démarrage ---------- */
if (!synth) status('Ce navigateur ne propose pas la synthèse vocale. Ouvre l’appli dans Safari.', true);
setTab(tab);
renderLibrary().then(() => { if (cfg().token) sync(false); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

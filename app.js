// libraries are served from vendor/ (same origin) so the service worker can cache them and the app opens offline
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const $ = s => document.querySelector(s);

// ---------- storage (IndexedDB) ----------
const db = new Promise((res, rej) => {
  const r = indexedDB.open('books', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('books', { keyPath: 'id' });
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => { const d = await db; return new Promise((res, rej) => {
  const t = d.transaction('books', mode); const out = fn(t.objectStore('books'));
  t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); }); };
const allBooks = () => tx('readonly', s => s.getAll());
const putBook = b => tx('readwrite', s => s.put(b));
const getBook = id => tx('readonly', s => s.get(id));
const delBook = id => tx('readwrite', s => s.delete(id));

// reading position lives in localStorage so a page turn never rewrites the whole book file in IndexedDB
const getProg = b => { const p = parseFloat(localStorage['prog:' + b.id]); return isNaN(p) ? (b.progress || 0) : p; };
const setProg = (b, p) => { localStorage['prog:' + b.id] = p; };
// EPUB page numbers change with font size, font and screen size, so EPUB places (reading position, bookmarks)
// are also saved as a chapter plus how far through it, and turned back into a page number after each layout
const getPos = b => { try { const l = JSON.parse(localStorage['pos:' + b.id] || 'null'); return l && l.ch != null ? l : null; } catch (e) { return null; } };
const setPos = (b, l) => { if (l) localStorage['pos:' + b.id] = JSON.stringify(l); else localStorage.removeItem('pos:' + b.id); };

// ---------- EPUB sanitizing ----------
// EPUB chapters are untrusted HTML that ends up in the app's own page, so anything that can run code is removed
const BAD_TAGS = 'script,style,link,meta,base,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,template,noscript,portal,foreignObject,animate,set,animateMotion,animateTransform,handler,listener';
const URL_ATTRS = ['href', 'xlink:href', 'src', 'action', 'formaction', 'poster', 'background', 'data', 'srcdoc'];
function cleanBody(html) {
  const d = new DOMParser().parseFromString('<!DOCTYPE html><html><body>' + html, 'text/html');
  d.body.querySelectorAll(BAD_TAGS).forEach(n => n.remove());
  const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_COMMENT); const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode); comments.forEach(c => c.remove());
  d.body.querySelectorAll('*').forEach(el => { for (const a of [...el.attributes]) {
    const name = a.name.toLowerCase(), val = a.value.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase();
    if (name.startsWith('on') || name === 'srcset' || name === 'srcdoc' || name === 'formaction' ||
        (URL_ATTRS.includes(name) && /^(javascript|vbscript|data:(?!image\/(png|jpe?g|gif|webp|svg\+xml)))/.test(val)) ||
        (name === 'style' && /expression\(|javascript:|-moz-binding/.test(val))) el.removeAttribute(a.name);
  } });
  return d.body;
}
// cleaning twice catches markup that only turns dangerous after being re-parsed
const sanitizeHTML = html => cleanBody(cleanBody(html).innerHTML).innerHTML;

// iOS kills the tab once canvas memory passes its budget, so always zero a canvas before dropping it
const freeCanvas = c => { c.width = c.height = 0; c.remove(); };
const PDF_OPTS = { isOffscreenCanvasSupported: false, isEvalSupported: false };

// ---------- covers ----------
const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
async function shrink(blob, w = 420) {
  const bmp = await createImageBitmap(blob); const s = Math.min(1, w / bmp.width);
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
  const url = c.toDataURL('image/jpeg', 0.82); freeCanvas(c); return url;
}
async function epubOpf(zip) {
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const container = xml(await zip.file('META-INF/container.xml').async('string'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  return { opf: xml(await zip.file(opfPath).async('string')), opfPath };
}
async function epubCover(zip) {
  const { opf, opfPath } = await epubOpf(zip);
  const items = [...opf.querySelectorAll('manifest > item')];
  let item = items.find(i => (i.getAttribute('properties') || '').split(/\s+/).includes('cover-image'));
  if (!item) { const mt = opf.querySelector('meta[name="cover"]'); if (mt) item = items.find(i => i.getAttribute('id') === mt.getAttribute('content')); }
  if (!item) item = items.find(i => /cover/i.test(i.getAttribute('id') || '') && /image/.test(i.getAttribute('media-type') || ''));
  if (!item) return null;
  const f = zip.file(resolve(opfPath, item.getAttribute('href'))); if (!f) return null;
  const b = await f.async('blob'); return new Blob([b], { type: item.getAttribute('media-type') || 'image/jpeg' });
}
async function makeCover(b) {
  try {
    const buf = await b.blob.arrayBuffer();
    if (b.type === 'pdf') {
      const pdf = await pdfjsLib.getDocument({ data: buf, ...PDF_OPTS }).promise;
      try {
        const pg = await pdf.getPage(1);
        const v0 = pg.getViewport({ scale: 1 }); const v = pg.getViewport({ scale: 420 / v0.width });
        const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
        await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
        const url = c.toDataURL('image/jpeg', 0.82); freeCanvas(c); return url;
      } finally { pdf.destroy(); }
    }
    const cb = await epubCover(await JSZip.loadAsync(buf)); return cb ? await shrink(cb) : null;
  } catch (e) { return null; }
}

// ---------- library ----------
let tab = 'all', openColl = null;
const getColls = () => { try { return JSON.parse(localStorage.collections || '[]'); } catch (e) { return []; } };
const setColls = c => localStorage.collections = JSON.stringify(c);
// covers are made one at a time: opening several PDFs at once is enough to crash Safari on a phone
let coverQ = Promise.resolve(); const coverJobs = new Set();
function paintCover(el, b) {
  const paint = c => { if (c) { el.classList.add('hascover'); el.style.backgroundImage = `url(${c})`; } };
  paint(b.cover);
  if (b.cover !== undefined || coverJobs.has(b.id)) return;
  coverJobs.add(b.id);
  coverQ = coverQ.then(() => makeCover(b)).then(async c => { const fresh = await getBook(b.id); if (fresh) { fresh.cover = c; await putBook(fresh); paint(c); } })
    .catch(() => {}).finally(() => coverJobs.delete(b.id));
}
function bookCard(b) {
  const el = document.createElement('div'); el.className = 'cover';
  el.innerHTML = `<span></span><small>${b.type.toUpperCase()}</small><button class="more" aria-label="Options">⋯</button><div class="prog"><i style="width:${getProg(b) * 100}%"></i></div>`;
  el.querySelector('span').textContent = b.title;
  paintCover(el, b);
  el.onclick = () => openBook(b.id);
  el.querySelector('.more').onclick = e => { e.stopPropagation(); showMenu(b.id); };
  return el;
}
function showMenu(id) {
  getBook(id).then(b => {
    const sheet = document.createElement('div'); sheet.id = 'sheet';
    const draw = () => {
      const colls = getColls(); const mine = b.collections || [];
      sheet.innerHTML = `<div class="panel"><h3></h3><div class="list"></div><button class="new">+ New collection</button><button class="danger">Delete book</button><button class="close">Done</button></div>`;
      sheet.querySelector('h3').textContent = b.title;
      const list = sheet.querySelector('.list');
      if (!colls.length) list.innerHTML = '<p class="hint">No collections yet</p>';
      colls.forEach(name => { const row = document.createElement('label'); row.className = 'row';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = mine.includes(name);
        cb.onchange = async () => { b.collections = cb.checked ? [...new Set([...(b.collections || []), name])] : (b.collections || []).filter(n => n !== name); await putBook(b); };
        row.append(cb, document.createTextNode(' ' + name)); list.append(row); });
      sheet.querySelector('.new').onclick = async () => { const n = (prompt('Collection name') || '').trim(); if (!n) return;
        const c = getColls(); if (!c.includes(n)) { c.push(n); setColls(c); } b.collections = [...new Set([...(b.collections || []), n])]; await putBook(b); draw(); };
      sheet.querySelector('.danger').onclick = async () => { if (confirm('Delete "' + b.title + '"?')) { await delBook(b.id); localStorage.removeItem('prog:' + b.id); localStorage.removeItem('pos:' + b.id); localStorage.removeItem('bm:' + b.id); sheet.remove(); renderLibrary(); } };
      sheet.querySelector('.close').onclick = () => { sheet.remove(); renderLibrary(); };
    };
    sheet.onclick = e => { if (e.target === sheet) { sheet.remove(); renderLibrary(); } };
    draw(); document.body.append(sheet);
  });
}
async function renderLibrary() {
  const books = (await allBooks()).sort((a, b) => b.added - a.added);
  const colls = getColls();
  document.querySelectorAll('#tabs button').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  const shelf = $('#shelf'), bar = $('#collbar'); shelf.innerHTML = ''; bar.innerHTML = ''; bar.hidden = tab !== 'collections';
  const empty = $('#empty'); empty.hidden = true;
  if (tab === 'all') { empty.textContent = 'Add a PDF or EPUB to start reading. Books are stored privately in this browser.'; empty.hidden = books.length > 0; books.forEach(b => shelf.append(bookCard(b))); return; }
  if (!openColl) {
    const add = document.createElement('button'); add.textContent = '+ New collection';
    add.onclick = () => { const n = (prompt('Collection name') || '').trim(); if (!n) return; const c = getColls(); if (!c.includes(n)) { c.push(n); setColls(c); } renderLibrary(); };
    bar.append(add);
    empty.textContent = 'No collections yet. Create one, then add books from the ⋯ menu on any book.'; empty.hidden = colls.length > 0;
    colls.forEach(name => { const inC = books.filter(b => (b.collections || []).includes(name));
      const el = document.createElement('div'); el.className = 'collcard';
      const stack = document.createElement('div'); stack.className = 'stack';
      inC.slice(0, 3).reverse().forEach((b, i, arr) => { const t = document.createElement('div'); t.className = 'thumb'; if (b.cover) t.style.backgroundImage = `url(${b.cover})`; t.style.transform = `translateX(${(i - (arr.length - 1) / 2) * 26}px) rotate(${(i - (arr.length - 1) / 2) * 6}deg)`; stack.append(t); });
      const label = document.createElement('div'); label.className = 'label'; label.textContent = name;
      const n = document.createElement('small'); n.textContent = inC.length + (inC.length === 1 ? ' book' : ' books');
      el.append(stack, label, n); el.onclick = () => { openColl = name; renderLibrary(); }; shelf.append(el); });
    return;
  }
  const back = document.createElement('button'); back.textContent = '← Collections'; back.onclick = () => { openColl = null; renderLibrary(); };
  const title = document.createElement('strong'); title.textContent = openColl;
  const del = document.createElement('button'); del.className = 'danger'; del.textContent = 'Delete collection';
  del.onclick = async () => { if (!confirm('Delete collection "' + openColl + '"? Books stay in your library.')) return;
    setColls(getColls().filter(n => n !== openColl));
    for (const b of books) if ((b.collections || []).includes(openColl)) { b.collections = b.collections.filter(n => n !== openColl); await putBook(b); }
    openColl = null; renderLibrary(); };
  bar.append(back, title, del);
  const inC = books.filter(b => (b.collections || []).includes(openColl));
  empty.textContent = 'This collection is empty. Use the ⋯ menu on a book to add it.'; empty.hidden = inC.length > 0;
  inC.forEach(b => shelf.append(bookCard(b)));
}
document.querySelectorAll('#tabs button').forEach(t => t.onclick = () => { tab = t.dataset.tab; openColl = null; renderLibrary(); });
$('#file').onchange = async e => {
  for (const f of e.target.files) {
    const type = f.name.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf';
    await putBook({ id: crypto.randomUUID(), title: f.name.replace(/\.(pdf|epub)$/i, ''), type, blob: f, added: Date.now(), progress: 0 });
  }
  e.target.value = ''; renderLibrary();
};

// ---------- themes & reader comfort ----------
const THEMES = ['light', 'sepia', 'dark', 'oled'];
const THEME_COLORS = {
  light: '#faf5e8',
  sepia: '#f4ecd8',
  dark: '#1d1b19',
  oled: '#000000'
};

function getSavedTheme() {
  const t = localStorage.reader_theme;
  if (THEMES.includes(t)) return t;
  if (localStorage.dark === '1') return 'dark';
  return 'light';
}

function applyTheme(t) {
  if (!THEMES.includes(t)) t = 'light';
  THEMES.forEach(name => document.body.classList.remove('theme-' + name));
  document.body.classList.add('theme-' + t);
  localStorage.reader_theme = t;
  localStorage.dark = (t === 'dark' || t === 'oled') ? '1' : '';
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === t);
  });
  updateTheme();
}

function updateTheme() {
  const isReading = $('#reader') && !$('#reader').hidden;
  const meta = $('meta[name="theme-color"]');
  if (meta) {
    if (isReading) {
      const cur = getSavedTheme();
      meta.content = THEME_COLORS[cur] || '#faf5e8';
    } else {
      meta.content = '#1e1a17';
    }
  }
}

// ---------- Screen Wake Lock ----------
let wakeLock = null;
async function requestWakeLock() {
  if ('wakeLock' in navigator && document.visibilityState === 'visible') {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      wakeLock = null;
    }
  }
}
function releaseWakeLock() {
  if (wakeLock) {
    try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && current && $('#reader') && !$('#reader').hidden) {
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
});

// ---------- typography (EPUB) ----------
const FONT_SIZES = [14, 16, 18, 19, 21, 24, 28, 32];
let rebuildT = null;

function getFontSize() {
  const s = parseInt(localStorage.reader_font_size || '19', 10);
  return isNaN(s) ? 19 : s;
}
function updateFontSizeUI(s) {
  const val = $('#font-size-val');
  if (val) val.textContent = s + 'px';
  const dec = $('#font-dec'), inc = $('#font-inc');
  if (dec) dec.disabled = s <= FONT_SIZES[0];
  if (inc) inc.disabled = s >= FONT_SIZES[FONT_SIZES.length - 1];
}
function setFontSize(newSize) {
  localStorage.reader_font_size = newSize;
  document.documentElement.style.setProperty('--reader-font-size', newSize + 'px');
  updateFontSizeUI(newSize);
  if (current && current.type === 'epub') {
    clearTimeout(rebuildT);
    rebuildT = setTimeout(buildBook, 350);
  }
}
function stepFontSize(dir) {
  const cur = getFontSize();
  let idx = FONT_SIZES.indexOf(cur);
  if (idx === -1) {
    idx = FONT_SIZES.reduce((prev, c, i) => Math.abs(c - cur) < Math.abs(FONT_SIZES[prev] - cur) ? i : prev, 3);
  }
  const nextIdx = Math.max(0, Math.min(FONT_SIZES.length - 1, idx + dir));
  setFontSize(FONT_SIZES[nextIdx]);
}
function getFontFamily() {
  return localStorage.reader_font_family || 'Georgia, serif';
}
function setFontFamily(font) {
  localStorage.reader_font_family = font;
  document.documentElement.style.setProperty('--reader-font-family', font);
  updateFontFamilyUI(font);
  if (current && current.type === 'epub') {
    clearTimeout(rebuildT);
    rebuildT = setTimeout(buildBook, 350);
  }
}
function updateFontFamilyUI(font) {
  document.querySelectorAll('.font-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.font === font);
  });
}

// ---------- bookmarks ----------
function getBookmarks(id) {
  if (!id) return [];
  try {
    const list = JSON.parse(localStorage['bm:' + id] || '[]');
    return Array.isArray(list) ? list.sort((a, b) => a.page - b.page) : [];
  } catch (e) {
    return [];
  }
}
function setBookmarks(id, list) {
  if (!id) return;
  localStorage['bm:' + id] = JSON.stringify(list);
}
function isPageBookmarked(id, pageIdx) {
  return getBookmarks(id).some(b => b.page === pageIdx);
}
function getSnippetForPage(pageIdx) {
  const p = pages[pageIdx];
  if (!p) return `Page ${pageIdx}`;
  const c = p.querySelector('.content');
  if (c && c.innerText) {
    const txt = c.innerText.replace(/\s+/g, ' ').trim();
    if (txt) return txt.slice(0, 75) + (txt.length > 75 ? '…' : '');
  }
  const match = toc.slice().reverse().find(t => t.page <= pageIdx);
  if (match && match.title) return `${match.title} · p. ${pageIdx}`;
  return `Page ${pageIdx}`;
}
function pageLoc(idx) {
  const p = pages[idx]; if (!p || p._ch == null) return null;
  return { ch: p._ch, off: p._col / p._n };
}
function locPage(loc) {
  if (!loc || loc.ch == null) return null;
  let first = -1, n = 0;
  pages.forEach((p, k) => { if (p._ch === loc.ch) { if (first < 0) first = k; n++; } });
  if (first < 0) return null;
  return first + Math.max(0, Math.min(n - 1, Math.round(loc.off * n)));
}
// after an EPUB is laid out, move each bookmark to the page its chapter position now falls on.
// bookmarks saved before chapter positions existed are upgraded using the current layout.
function relinkBookmarks() {
  if (!current || current.type !== 'epub') return;
  const bms = getBookmarks(current.id); let changed = false;
  bms.forEach(b => {
    if (b.ch == null) { const l = pageLoc(b.page); if (l) { Object.assign(b, l); changed = true; } }
    else { const p = locPage(b); if (p != null && p !== b.page) { b.page = p; changed = true; } }
  });
  if (changed) setBookmarks(current.id, bms);
}
function toggleBookmark() {
  if (!current || !pf) return;
  const pageIdx = pf.getCurrentPageIndex();
  let bms = getBookmarks(current.id);
  const exists = bms.some(b => b.page === pageIdx);
  if (exists) {
    bms = bms.filter(b => b.page !== pageIdx);
  } else {
    bms.push({
      ...(pageLoc(pageIdx) || {}),
      page: pageIdx,
      text: getSnippetForPage(pageIdx),
      time: Date.now()
    });
  }
  setBookmarks(current.id, bms);
  updateBookmarkRibbons();
  updateBookmarkUI(pageIdx);
}
function updateBookmarkRibbons() {
  if (!current) return;
  const bms = new Set(getBookmarks(current.id).map(b => b.page));
  pages.forEach((p, idx) => {
    let ribbon = p.querySelector('.ribbon');
    if (bms.has(idx)) {
      if (!ribbon) {
        ribbon = document.createElement('div');
        ribbon.className = 'ribbon';
        ribbon.setAttribute('aria-hidden', 'true');
        p.append(ribbon);
      }
    } else if (ribbon) {
      ribbon.remove();
    }
  });
}
function updateBookmarkUI(pageIdx) {
  const isBm = current ? isPageBookmarked(current.id, pageIdx) : false;
  const bmBtn = $('#bookmark');
  if (bmBtn) {
    bmBtn.classList.toggle('on', isBm);
    bmBtn.title = isBm ? 'Remove bookmark' : 'Bookmark page';
  }
}

// ---------- reader ----------
let pf = null, current = null, pages = [], toc = [], doc = null, urls = [], build = 0, resizeT, lastW = 0, lastH = 0, ui = false, uiT;

// ---------- safe area insets ----------
function getInsets() {
  const el = $('#insets');
  if (!el) return { top: 0, bottom: 0, left: 0, right: 0 };
  const cs = getComputedStyle(el);
  return {
    top: parseFloat(cs.top) || 0,
    bottom: parseFloat(cs.bottom) || 0,
    left: parseFloat(cs.left) || 0,
    right: parseFloat(cs.right) || 0
  };
}

function bookSize(aspect) {
  const r = $('#reader');
  const availW = (r && r.clientWidth) || innerWidth;
  const availH = Math.max(window.innerHeight, document.documentElement.clientHeight, (r && r.clientHeight) || 0);
  const portrait = availW < 760;
  if (portrait) return { w: Math.floor(availW), h: Math.floor(availH), portrait };
  const cs = getComputedStyle($('#stage'));
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const hAvail = availH - padY - 4, maxW = availW / 2;
  let h = hAvail, w = aspect ? h * aspect : Math.min(maxW, h * 0.75);
  if (w > maxW) { w = maxW; h = w / aspect; }
  return { w: Math.floor(w), h: Math.floor(h), portrait };
}
const hardPage = (title, sub = '') => { const d = document.createElement('div'); d.className = 'page hard'; d.dataset.density = 'hard'; d.innerHTML = `<div></div><small style="font:13px sans-serif;opacity:.6;margin-top:14px">${sub}</small>`; d.firstChild.textContent = title; return d; };
const blankPage = () => { const d = document.createElement('div'); d.className = 'page'; return d; };

async function openBook(id) {
  current = await getBook(id);
  if (!current) return;
  requestWakeLock();
  const isPdf = current.type === 'pdf';
  document.querySelectorAll('#type-panel .epub-only').forEach(el => el.hidden = isPdf);
  const hint = $('#type-panel .pdf-hint'); if (hint) hint.hidden = !isPdf;
  $('#type-panel').hidden = true;
  document.body.classList.add('reading');
  updateTheme();
  $('#library').hidden = true; $('#reader').hidden = false; $('#title').textContent = current.title;
  await buildBook();
}
function ensureBook() {
  let b = $('#book');
  if (!b) {
    b = document.createElement('div');
    b.id = 'book';
    const s = $('#stage');
    if (s) s.prepend(b);
  }
  return b;
}
function releaseBook() {
  if (pf) { try { pf.destroy(); } catch (e) {} pf = null; }
  pages.forEach(p => { p._on = false; try { p._clear && p._clear(p); } catch (e) {} }); pages = []; toc = [];
  if (doc) {
    try { if (doc.cleanup) doc.cleanup(); } catch (e) {}
    try { if (doc.destroy) { const p = doc.destroy(); if (p && p.catch) p.catch(() => {}); } } catch (e) {}
    doc = null;
  }
  urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
  ensureBook().innerHTML = '';
}
async function buildBook() {
  const my = ++build;
  releaseBook(); $('#loading').hidden = false;
  const bookEl = ensureBook();
  const buf = await current.blob.arrayBuffer();
  const frac = getProg(current);
  const r = current.type === 'pdf' ? await preparePDF(buf) : await prepareEPUB(buf);
  if (my !== build) { if (r.doc) { try { const p = r.doc.destroy(); if (p && p.catch) p.catch(() => {}); } catch (e) {} } (r.urls || []).forEach(u => URL.revokeObjectURL(u)); return; }
  const { content, size, cover } = r; doc = r.doc || null; urls = r.urls || []; toc = r.toc || [];
  lastW = innerWidth; lastH = innerHeight;
  pages = [cover || hardPage(current.title, current.type.toUpperCase()), ...content];
  if ((pages.length + 1) % 2) pages.push(blankPage());
  pages.push(hardPage(''));
  pages.forEach((p, i) => { p.classList.add(i % 2 ? 'left' : 'right'); });
  pages.forEach((p, i) => { if (!p.classList.contains('hard') && !p.querySelector('.num')) { const n = document.createElement('div'); n.className = 'num'; n.textContent = i; p.append(n); } });
  $('#loading').hidden = true;
  pf = new St.PageFlip(bookEl, { width: size.w, height: size.h, size: 'fixed', showCover: true, usePortrait: true,
    maxShadowOpacity: 0.6, flippingTime: 600, mobileScrollSupport: false, drawShadow: true, useMouseEvents: false });
  pf.loadFromHTML(pages);
  pf.on('flip', sync);
  const loc = current.type === 'epub' ? locPage(getPos(current)) : null;
  const start = loc != null ? loc : Math.min(pages.length - 1, Math.max(0, Math.round(frac * (pages.length - 1))));
  if (start > 0) {
    try { pf.turnToPage(start); } catch (e) {}
  }
  $('#slider').max = pages.length - 1;
  relinkBookmarks();
  updateBookmarkRibbons();
  sync();
}
function sync() {
  if (!pf || !current || !pages.length) return; const i = pf.getCurrentPageIndex(); $('#slider').value = i; $('#label').textContent = `${i} / ${pages.length - 1}`;
  updateLazy(i); updateBookmarkUI(i); setProg(current, i / Math.max(1, pages.length - 1));
  if (current.type === 'epub') setPos(current, pageLoc(i));
}
function updateLazy(i) {
  if (!current) return;
  const R = current.type === 'pdf' ? 3 : 4;
  pages.forEach((p, k) => { const f = p._fill; if (!f) return; const near = Math.abs(k - i) <= R;
    if (near && !p._on) { p._on = true; f(p); } else if (!near && p._on) { p._on = false; try { p._clear && p._clear(p); } catch (e) {} } });
}

// ---------- table of contents & bookmarks sheet ----------
function showToc(initialTab = 'toc') {
  const sheet = document.createElement('div'); sheet.id = 'sheet';
  const hasToc = toc && toc.length > 0;
  const activeTab = (!hasToc && initialTab === 'toc') ? 'bms' : initialTab;

  sheet.innerHTML = `
    <div class="panel">
      <div class="sheet-tabs">
        <button class="tab-btn ${activeTab === 'toc' ? 'on' : ''}" data-sheet-tab="toc" ${hasToc ? '' : 'disabled'}>Contents</button>
        <button class="tab-btn ${activeTab === 'bms' ? 'on' : ''}" data-sheet-tab="bms">Bookmarks</button>
      </div>
      <div class="list toc" id="sheet-toc" ${activeTab !== 'toc' ? 'hidden' : ''}></div>
      <div class="list bms" id="sheet-bms" ${activeTab !== 'bms' ? 'hidden' : ''}></div>
      <button class="close">Done</button>
    </div>
  `;

  const tocList = sheet.querySelector('#sheet-toc');
  const bmsList = sheet.querySelector('#sheet-bms');
  const here = pf ? pf.getCurrentPageIndex() : 0;
  let mark = null;

  if (hasToc) {
    toc.forEach(t => {
      const b = document.createElement('button'); b.className = 'row'; b.style.paddingLeft = (8 + Math.max(0, t.depth) * 16) + 'px';
      const name = document.createElement('span'); name.textContent = t.title || 'Untitled';
      const n = document.createElement('small'); n.textContent = t.page; b.append(name, n);
      if (t.page <= here) mark = b;
      b.onclick = () => { sheet.remove(); if (pf) { pf.turnToPage(t.page); sync(); } };
      tocList.append(b);
    });
    if (mark) mark.classList.add('here');
  } else {
    tocList.innerHTML = '<p class="hint">No table of contents in this document.</p>';
  }

  function renderSheetBookmarks() {
    bmsList.innerHTML = '';
    const bms = getBookmarks(current.id);
    if (!bms.length) {
      bmsList.innerHTML = '<p class="hint">No bookmarks yet. Tap the bookmark icon in the top bar to save pages.</p>';
      return;
    }
    bms.forEach(bm => {
      const row = document.createElement('div'); row.className = 'bm-row';
      const link = document.createElement('button'); link.className = 'bm-link';
      link.innerHTML = `<strong class="bm-page">Page ${bm.page}</strong><span class="bm-text"></span>`;
      link.querySelector('.bm-text').textContent = bm.text;
      link.onclick = () => {
        sheet.remove();
        if (pf) { pf.turnToPage(bm.page); sync(); }
      };
      const del = document.createElement('button'); del.className = 'bm-del'; del.title = 'Remove bookmark'; del.setAttribute('aria-label', 'Remove bookmark'); del.textContent = '✕';
      del.onclick = e => {
        e.stopPropagation();
        let list = getBookmarks(current.id).filter(b => b.page !== bm.page);
        setBookmarks(current.id, list);
        updateBookmarkRibbons();
        if (pf) updateBookmarkUI(pf.getCurrentPageIndex());
        renderSheetBookmarks();
      };
      row.append(link, del);
      bmsList.append(row);
    });
  }
  renderSheetBookmarks();

  sheet.querySelectorAll('.sheet-tabs .tab-btn').forEach(btn => {
    btn.onclick = () => {
      if (btn.disabled) return;
      sheet.querySelectorAll('.sheet-tabs .tab-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      const target = btn.dataset.sheetTab;
      tocList.hidden = target !== 'toc';
      bmsList.hidden = target !== 'bms';
    };
  });

  sheet.querySelector('.close').onclick = () => sheet.remove();
  sheet.onclick = e => { if (e.target === sheet) sheet.remove(); };
  document.body.append(sheet);
  if (activeTab === 'toc' && mark) mark.scrollIntoView({ block: 'center' });
}

// ---------- PDF ----------
async function preparePDF(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf, ...PDF_OPTS }).promise;
  const first = await pdf.getPage(1); const vp = first.getViewport({ scale: 1 });
  const size = bookSize(vp.width / vp.height); const content = []; let cover = null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const insets = getInsets();
  for (let n = 1; n <= pdf.numPages; n++) {
    const d = document.createElement('div'); d.className = n === 1 ? 'page hard pdfcover' : 'page'; if (n === 1) d.dataset.density = 'hard';
    d._fill = async el => { const gen = el._gen = (el._gen || 0) + 1;
      let pg; try { pg = await pdf.getPage(n); } catch (e) { return; }
      if (!el._on || gen !== el._gen) { try { pg.cleanup(); } catch (e) {} return; }
      const v0 = pg.getViewport({ scale: 1 });
      const maxW = size.portrait ? size.w - (insets.left + insets.right) : size.w;
      const maxH = size.portrait ? size.h - (insets.top + insets.bottom + 24) : size.h;
      const s = Math.min(maxW / v0.width, maxH / v0.height) * dpr; const v = pg.getViewport({ scale: s });
      const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
      try { await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; } catch (e) { freeCanvas(c); return; }
      try { pg.cleanup(); } catch (e) {}
      if (el._on && gen === el._gen) { c.style.objectFit = 'contain'; el.prepend(c); } else freeCanvas(c); };
    d._clear = el => { el._gen = (el._gen || 0) + 1; el.querySelectorAll('canvas').forEach(freeCanvas); };
    if (n === 1) cover = d; else content.push(d);
  }
  const toc = [];
  const walk = async (items, depth) => { for (const it of items || []) {
    try { let dest = it.dest; if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (Array.isArray(dest) && dest[0] != null) toc.push({ title: it.title, depth, page: typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0] });
    } catch (e) {}
    await walk(it.items, depth + 1); } };
  try { await walk(await pdf.getOutline(), 0); } catch (e) {}
  return { content, size, cover, toc, doc: pdf };
}

// ---------- EPUB ----------
const resolve = (base, rel) => decodeURIComponent(new URL(rel, 'http://x/' + base).pathname.slice(1));
async function epubToc(zip, opf, opfPath) {
  const items = [...opf.querySelectorAll('manifest > item')];
  const read = async href => { const p = resolve(opfPath, href); const f = zip.file(p); return f ? { p, s: await f.async('string') } : null; };
  const entry = (base, href, title, depth) => { const [file, frag] = (href || '').split('#');
    return { title: (title || '').trim().replace(/\s+/g, ' '), depth, path: file ? resolve(base, file) : base, frag: frag ? decodeURIComponent(frag) : '' }; };
  const out = [];
  const nav = items.find(i => (i.getAttribute('properties') || '').split(/\s+/).includes('nav'));
  const r = nav && await read(nav.getAttribute('href'));
  if (r) { const d = new DOMParser().parseFromString(r.s, 'text/html');
    const el = [...d.querySelectorAll('nav')].find(n => /toc/.test(n.getAttribute('epub:type') || '')) || d.querySelector('nav');
    if (el) el.querySelectorAll('a[href]').forEach(a => { let depth = -1; for (let e = a.parentElement; e && e !== el; e = e.parentElement) if (e.tagName === 'OL' || e.tagName === 'UL') depth++;
      out.push(entry(r.p, a.getAttribute('href'), a.textContent, depth)); }); }
  if (out.length) return out;
  const spine = opf.querySelector('spine'), ncxId = spine && spine.getAttribute('toc');
  const ncx = items.find(i => i.getAttribute('id') === ncxId) || items.find(i => /ncx/.test(i.getAttribute('media-type') || ''));
  const n = ncx && await read(ncx.getAttribute('href'));
  if (n) { const d = new DOMParser().parseFromString(n.s, 'application/xml');
    const kids = (e, name) => [...e.children].filter(c => c.localName === name);
    const walk = (parent, depth) => kids(parent, 'navPoint').forEach(np => {
      const label = kids(np, 'navLabel')[0], src = kids(np, 'content')[0];
      if (src) out.push(entry(n.p, src.getAttribute('src'), label ? label.textContent : '', depth)); walk(np, depth + 1); });
    const map = kids(d.documentElement, 'navMap')[0]; if (map) walk(map, 0); }
  return out;
}
async function prepareEPUB(buf) {
  const zip = await JSZip.loadAsync(buf);
  const text = p => zip.file(p).async('string');
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const container = xml(await text('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const opf = xml(await text(opfPath));
  const manifest = {}; opf.querySelectorAll('manifest > item').forEach(i => manifest[i.getAttribute('id')] = i.getAttribute('href'));
  const spine = [...opf.querySelectorAll('spine > itemref')].map(r => manifest[r.getAttribute('idref')]).filter(Boolean);
  const size = bookSize(); const W = size.w, H = size.h;
  const blobCache = {}, urls = [];
  const blobURL = async path => { if (blobCache[path]) return blobCache[path]; const f = zip.file(path); if (!f) return null;
    const b = await f.async('blob'); const u = URL.createObjectURL(b.type ? b : new Blob([b], { type: /\.png$/i.test(path) ? 'image/png' : /\.gif$/i.test(path) ? 'image/gif' : /\.svg$/i.test(path) ? 'image/svg+xml' : 'image/jpeg' }));
    urls.push(u); return blobCache[path] = u; };
  const chapters = [];
  for (const href of spine) {
    const path = resolve(opfPath, href); if (!zip.file(path)) continue;
    const raw = await text(path);
    let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(raw, 'text/html');
    const srcBody = doc.body || doc.querySelector('body'); if (!srcBody) continue;
    const body = cleanBody(srcBody.innerHTML);
    for (const img of body.querySelectorAll('img')) { const u = await blobURL(resolve(path, img.getAttribute('src') || '')); if (u) img.setAttribute('src', u); else img.removeAttribute('src'); }
    for (const im of body.querySelectorAll('image')) { const a = im.getAttribute('xlink:href') || im.getAttribute('href'); const u = a && await blobURL(resolve(path, a)); if (u) { im.setAttribute('href', u); im.setAttribute('xlink:href', u); } }
    chapters.push({ path, html: sanitizeHTML(body.innerHTML) });
  }
  let toc = []; try { toc = await epubToc(zip, opf, opfPath); } catch (e) {}
  const insets = getInsets();
  const pad = size.portrait ? Math.max(16, insets.left + 16) : 30;
  const vpadTop = size.portrait ? Math.max(22, insets.top + 8) : 36;
  const vpadBottom = size.portrait ? Math.max(26, insets.bottom + 22) : 36;
  const innerW = W - 2 * pad, innerH = H - vpadTop - vpadBottom;
  const styleContent = el => { el.className = 'content';
    el.style.cssText = `width:${innerW}px;height:${innerH}px;padding:0 ${pad}px;box-sizing:content-box;column-width:${innerW}px;column-gap:${2 * pad}px;--ih:${innerH}px;`; };
  const meas = document.createElement('div'); meas.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden'; document.body.append(meas);
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const content = [];
  for (const [ci, ch] of chapters.entries()) {
    const m = document.createElement('div'); m.className = 'page'; m.style.cssText = `width:${W}px;height:${H}px`; const c = document.createElement('div'); styleContent(c); c.innerHTML = ch.html;
    meas.innerHTML = ''; m.append(c); meas.append(m);
    await Promise.all([...c.querySelectorAll('img')].map(i => i.decode ? i.decode().catch(() => {}) : 0));
    const first = content.length, x0 = c.getBoundingClientRect().left;
    const n = Math.max(1, Math.ceil((c.scrollWidth - pad) / W));
    for (const t of toc) if (t.path === ch.path && t.page == null) {
      const el = t.frag && (c.querySelector('#' + CSS.escape(t.frag)) || c.querySelector(`[name="${CSS.escape(t.frag)}"]`));
      const col = el ? Math.floor((el.getBoundingClientRect().left - x0) / W) : 0;
      t.page = 1 + first + Math.max(0, Math.min(n - 1, col));
    }
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div'); d.className = 'page'; d._ch = ci; d._col = i; d._n = n;
      d._fill = el => { const clip = document.createElement('div'); clip.className = 'clip'; clip.style.cssText = `top:${vpadTop}px;height:${innerH}px`;
        const cc = document.createElement('div'); styleContent(cc); cc.style.transform = `translateX(${-i * W}px)`; cc.innerHTML = ch.html; clip.append(cc); el.prepend(clip); };
      d._clear = el => el.querySelectorAll('.clip').forEach(c => c.remove());
      content.push(d);
    }
  }
  meas.remove();
  let cover = null;
  try { const cb = await epubCover(zip); if (cb) { cover = document.createElement('div'); cover.className = 'page hard pdfcover'; cover.dataset.density = 'hard';
    const im = document.createElement('img'); const u = URL.createObjectURL(cb); urls.push(u); im.src = u; im.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'; cover.append(im); } } catch (e) {}
  return { content, size, cover, urls, toc: toc.filter(t => t.page != null) };
}

// ---------- controls & event listeners ----------
$('#back').onclick = e => {
  if (e) e.stopPropagation();
  setUI(false);
  $('#type-panel').hidden = true;
  releaseWakeLock();
  build++;
  document.body.classList.remove('reading');
  $('#reader').hidden = true;
  $('#library').hidden = false;
  updateTheme();
  renderLibrary();
  try { releaseBook(); } catch (err) { console.error(err); }
  current = null;
};
// always-visible back pill shares the same handler
$('#back-pill').onclick = e => $('#back').onclick(e);
$('#next').onclick = () => pf && pf.flipNext();
$('#prev').onclick = () => pf && pf.flipPrev();
$('#slider').onchange = e => { if (pf) { pf.turnToPage(+e.target.value); sync(); } };
$('#slider').oninput = () => setUI(true);
$('#controls').onclick = $('#bar').onclick = () => setUI(true);
$('#toc').onclick = e => { e.stopPropagation(); $('#type-panel').hidden = true; showToc(); };
$('#bookmark').onclick = e => { e.stopPropagation(); toggleBookmark(); setUI(true); };

// typography panel toggle & interactions
$('#type-btn').onclick = e => {
  e.stopPropagation();
  const p = $('#type-panel');
  p.hidden = !p.hidden;
  if (!p.hidden) {
    setUI(true);
    clearTimeout(uiT);
  }
};
$('#type-panel').onclick = e => {
  e.stopPropagation();
  clearTimeout(uiT);
};
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.onclick = () => applyTheme(btn.dataset.theme);
});
$('#font-dec').onclick = () => stepFontSize(-1);
$('#font-inc').onclick = () => stepFontSize(1);
document.querySelectorAll('.font-btn').forEach(btn => {
  btn.onclick = () => setFontFamily(btn.dataset.font);
});

document.addEventListener('keydown', e => { if (!pf) return; if (e.key === 'ArrowRight') pf.flipNext(); if (e.key === 'ArrowLeft') pf.flipPrev(); });
addEventListener('resize', () => { if (!current || $('#reader').hidden) return;
  if (Math.abs(innerWidth - lastW) < 60 && Math.abs(innerHeight - lastH) < 150) return; clearTimeout(resizeT); resizeT = setTimeout(buildBook, 400); });

function setUI(v) {
  ui = v;
  $('#bar').classList.toggle('show', v);
  $('#controls').classList.toggle('show', v);
  clearTimeout(uiT);
  if (v) {
    uiT = setTimeout(() => {
      setUI(false);
      $('#type-panel').hidden = true;
    }, 5000);
  } else {
    $('#type-panel').hidden = true;
  }
}

const stageEl = $('#stage'); let g = null;
// links inside book text point at files in the EPUB zip, so following one would leave the app
stageEl.addEventListener('click', e => { if (e.target.closest && e.target.closest('a')) e.preventDefault(); });
stageEl.addEventListener('pointerdown', e => {
  if (!$('#type-panel').hidden) $('#type-panel').hidden = true;
  g = { x: e.clientX, y: e.clientY };
});
stageEl.addEventListener('pointercancel', () => g = null);
stageEl.addEventListener('pointerup', e => {
  if (!g || !pf) return; const dx = e.clientX - g.x, dy = e.clientY - g.y; g = null;
  if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy) * 1.2) { dx < 0 ? pf.flipNext() : pf.flipPrev(); return; }
  if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
    const r = stageEl.getBoundingClientRect(), f = (e.clientX - r.left) / r.width;
    if (f < 0.25) pf.flipPrev(); else if (f > 0.75) pf.flipNext(); else setUI(!ui);
  }
});

// initialize settings on boot
applyTheme(getSavedTheme());
setFontSize(getFontSize());
setFontFamily(getFontFamily());

renderLibrary();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
// service worker keeps the app and its libraries cached so it opens without a connection
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
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

// iOS kills the tab once canvas memory passes its budget, so always zero a canvas before dropping it
const freeCanvas = c => { c.width = c.height = 0; c.remove(); };
const PDF_OPTS = { isOffscreenCanvasSupported: false };

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
      sheet.querySelector('.danger').onclick = async () => { if (confirm('Delete "' + b.title + '"?')) { await delBook(b.id); localStorage.removeItem('prog:' + b.id); sheet.remove(); renderLibrary(); } };
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

// ---------- reader ----------
// build: bumped on every (re)build so a slow, stale build can't create a second flipbook on top of the current one
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

// measured from the window, not the stage: iOS home-screen apps can report a short 100dvh, which left a dead band at the bottom
// phones: stage and pages bleed edge-to-edge; text & PDFs fit safely inside insets. Wider screens: two pages side by side.
function bookSize(aspect) {
  const r = $('#reader');
  const availW = (r && r.clientWidth) || innerWidth;
  const availH = (r && r.clientHeight) || innerHeight;
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
  document.body.classList.add('reading');
  $('#library').hidden = true; $('#reader').hidden = false; $('#title').textContent = current.title;
  await buildBook();
}
function releaseBook() {
  if (pf) { try { pf.destroy(); } catch (e) {} pf = null; }
  pages.forEach(p => { p._on = false; p._clear && p._clear(p); }); pages = []; toc = [];
  if (doc) { doc.destroy(); doc = null; }
  urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
  $('#book').innerHTML = '';
}
async function buildBook() {
  const my = ++build;
  releaseBook(); $('#loading').hidden = false;
  const buf = await current.blob.arrayBuffer();
  const frac = getProg(current);
  const r = current.type === 'pdf' ? await preparePDF(buf) : await prepareEPUB(buf);
  if (my !== build) { if (r.doc) r.doc.destroy(); (r.urls || []).forEach(u => URL.revokeObjectURL(u)); return; }
  const { content, size, cover } = r; doc = r.doc || null; urls = r.urls || []; toc = r.toc || [];
  lastW = innerWidth; lastH = innerHeight;
  // cover + content (+ filler) + back cover => even total so last page sits alone
  pages = [cover || hardPage(current.title, current.type.toUpperCase()), ...content];
  if ((pages.length + 1) % 2) pages.push(blankPage());
  pages.push(hardPage(''));
  pages.forEach((p, i) => { p.classList.add(i % 2 ? 'left' : 'right'); });
  pages.forEach((p, i) => { if (!p.classList.contains('hard') && !p.querySelector('.num')) { const n = document.createElement('div'); n.className = 'num'; n.textContent = i; p.append(n); } });
  $('#loading').hidden = true;
  pf = new St.PageFlip($('#book'), { width: size.w, height: size.h, size: 'fixed', showCover: true, usePortrait: true,
    maxShadowOpacity: 0.6, flippingTime: 600, mobileScrollSupport: false, drawShadow: true, useMouseEvents: false });
  pf.loadFromHTML(pages);
  const start = Math.round(frac * (pages.length - 1));
  if (start > 0) pf.turnToPage(start);
  $('#slider').max = pages.length - 1;
  $('#toc').hidden = !toc.length;
  pf.on('flip', sync); sync();
}
function sync() {
  if (!pf) return; const i = pf.getCurrentPageIndex(); $('#slider').value = i; $('#label').textContent = `${i} / ${pages.length - 1}`;
  updateLazy(i); setProg(current, i / (pages.length - 1));
}
function updateLazy(i) {
  // PDF pages are canvases (several MB each), so keep fewer of them alive than EPUB pages
  const R = current.type === 'pdf' ? 3 : 4;
  pages.forEach((p, k) => { const f = p._fill; if (!f) return; const near = Math.abs(k - i) <= R;
    if (near && !p._on) { p._on = true; f(p); } else if (!near && p._on) { p._on = false; p._clear(p); } });
}

// ---------- table of contents ----------
function showToc() {
  const sheet = document.createElement('div'); sheet.id = 'sheet';
  sheet.innerHTML = '<div class="panel"><h3>Contents</h3><div class="list toc"></div><button class="close">Done</button></div>';
  const list = sheet.querySelector('.list'), here = pf ? pf.getCurrentPageIndex() : 0;
  let mark = null;
  toc.forEach(t => { const b = document.createElement('button'); b.className = 'row'; b.style.paddingLeft = 8 + Math.max(0, t.depth) * 16 + 'px';
    const name = document.createElement('span'); name.textContent = t.title || 'Untitled';
    const n = document.createElement('small'); n.textContent = t.page; b.append(name, n);
    if (t.page <= here) mark = b;
    b.onclick = () => { sheet.remove(); if (pf) { pf.turnToPage(t.page); sync(); } };
    list.append(b); });
  if (mark) mark.classList.add('here');
  sheet.querySelector('.close').onclick = () => sheet.remove();
  sheet.onclick = e => { if (e.target === sheet) sheet.remove(); };
  document.body.append(sheet);
  if (mark) mark.scrollIntoView({ block: 'center' });
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
    // _gen guards against a slow render landing after the page was cleared (or re-filled), which stacked canvases
    d._fill = async el => { const gen = el._gen = (el._gen || 0) + 1;
      const pg = await pdf.getPage(n); if (!el._on || gen !== el._gen) return;
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
  // outline -> [{ title, depth, page }]; PDF page n sits at book index n - 1 (page 1 is the cover)
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
// nav document (EPUB 3) or NCX (EPUB 2) -> [{ title, depth, path, frag }]
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
    const body = doc.body || doc.querySelector('body'); if (!body) continue;
    body.querySelectorAll('script,style,link').forEach(n => n.remove());
    for (const img of body.querySelectorAll('img')) { const u = await blobURL(resolve(path, img.getAttribute('src') || '')); if (u) img.setAttribute('src', u); }
    for (const im of body.querySelectorAll('image')) { const a = im.getAttribute('xlink:href') || im.getAttribute('href'); const u = a && await blobURL(resolve(path, a)); if (u) { im.setAttribute('href', u); im.setAttribute('xlink:href', u); } }
    chapters.push({ path, html: body.innerHTML });
  }
  let toc = []; try { toc = await epubToc(zip, opf, opfPath); } catch (e) {}
  // tighter margins on a phone so the text uses the screen and stays clear of notch/home bar
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
  for (const ch of chapters) {
    const m = document.createElement('div'); m.className = 'page'; m.style.cssText = `width:${W}px;height:${H}px`; const c = document.createElement('div'); styleContent(c); c.innerHTML = ch.html;
    meas.innerHTML = ''; m.append(c); meas.append(m);
    await Promise.all([...c.querySelectorAll('img')].map(i => i.decode ? i.decode().catch(() => {}) : 0));
    const first = content.length, x0 = c.getBoundingClientRect().left;
    const n = Math.max(1, Math.ceil((c.scrollWidth - pad) / W));
    // which column each contents entry in this chapter lands in
    for (const t of toc) if (t.path === ch.path && t.page == null) {
      const el = t.frag && (c.querySelector('#' + CSS.escape(t.frag)) || c.querySelector(`[name="${CSS.escape(t.frag)}"]`));
      const col = el ? Math.floor((el.getBoundingClientRect().left - x0) / W) : 0;
      t.page = 1 + first + Math.max(0, Math.min(n - 1, col));
    }
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div'); d.className = 'page';
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

// ---------- controls ----------
$('#back').onclick = () => { setUI(false); build++; releaseBook(); current = null; document.body.classList.remove('reading'); $('#reader').hidden = true; $('#library').hidden = false; renderLibrary(); };
$('#next').onclick = () => pf && pf.flipNext();
$('#prev').onclick = () => pf && pf.flipPrev();
$('#slider').onchange = e => { if (pf) { pf.turnToPage(+e.target.value); sync(); } };
$('#slider').oninput = () => setUI(true);
$('#controls').onclick = $('#bar').onclick = () => setUI(true);
$('#toc').onclick = e => { e.stopPropagation(); showToc(); };
$('#theme').onclick = () => { document.body.classList.toggle('dark'); localStorage.dark = document.body.classList.contains('dark') ? 1 : ''; };
if (localStorage.dark) document.body.classList.add('dark');
document.addEventListener('keydown', e => { if (!pf) return; if (e.key === 'ArrowRight') pf.flipNext(); if (e.key === 'ArrowLeft') pf.flipPrev(); });
addEventListener('resize', () => { if (!current || $('#reader').hidden) return;
  if (Math.abs(innerWidth - lastW) < 60 && Math.abs(innerHeight - lastH) < 150) return; clearTimeout(resizeT); resizeT = setTimeout(buildBook, 400); });

// immersive: controls only after a tap in the middle; swipe or tap an edge to turn the page
function setUI(v) { ui = v; $('#bar').classList.toggle('show', v); $('#controls').classList.toggle('show', v); clearTimeout(uiT); if (v) uiT = setTimeout(() => setUI(false), 5000); }
const stageEl = $('#stage'); let g = null;
stageEl.addEventListener('pointerdown', e => { g = { x: e.clientX, y: e.clientY }; });
stageEl.addEventListener('pointercancel', () => g = null);
stageEl.addEventListener('pointerup', e => {
  if (!g || !pf) return; const dx = e.clientX - g.x, dy = e.clientY - g.y; g = null;
  if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy) * 1.2) { dx < 0 ? pf.flipNext() : pf.flipPrev(); return; }
  if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
    const r = stageEl.getBoundingClientRect(), f = (e.clientX - r.left) / r.width;
    if (f < 0.25) pf.flipPrev(); else if (f > 0.75) pf.flipNext(); else setUI(!ui);
  }
});

renderLibrary();
// ask the browser to keep our storage (books) from being auto-evicted
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

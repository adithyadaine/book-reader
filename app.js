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

// ---------- covers ----------
const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
async function shrink(blob, w = 420) {
  const bmp = await createImageBitmap(blob); const s = Math.min(1, w / bmp.width);
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.82);
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
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise; const pg = await pdf.getPage(1);
      const v0 = pg.getViewport({ scale: 1 }); const v = pg.getViewport({ scale: 420 / v0.width });
      const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; return c.toDataURL('image/jpeg', 0.82);
    }
    const cb = await epubCover(await JSZip.loadAsync(buf)); return cb ? await shrink(cb) : null;
  } catch (e) { return null; }
}

// ---------- library ----------
async function renderLibrary() {
  const books = (await allBooks()).sort((a, b) => b.added - a.added);
  $('#shelf').innerHTML = ''; $('#empty').hidden = books.length > 0;
  for (const b of books) {
    const el = document.createElement('div'); el.className = 'cover';
    el.innerHTML = `<span></span><small>${b.type.toUpperCase()}</small><button class="del">✕</button><div class="prog"><i style="width:${(b.progress || 0) * 100}%"></i></div>`;
    el.querySelector('span').textContent = b.title;
    const paint = c => { if (c) { el.classList.add('hascover'); el.style.backgroundImage = `url(${c})`; } };
    paint(b.cover);
    if (b.cover === undefined) makeCover(b).then(async c => { const fresh = await getBook(b.id); if (!fresh) return; fresh.cover = c; await putBook(fresh); paint(c); });
    el.onclick = () => openBook(b.id);
    el.querySelector('.del').onclick = async e => { e.stopPropagation(); if (confirm('Delete "' + b.title + '"?')) { await delBook(b.id); renderLibrary(); } };
    $('#shelf').append(el);
  }
}
$('#file').onchange = async e => {
  for (const f of e.target.files) {
    const type = f.name.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf';
    await putBook({ id: crypto.randomUUID(), title: f.name.replace(/\.(pdf|epub)$/i, ''), type, blob: f, added: Date.now(), progress: 0 });
  }
  e.target.value = ''; renderLibrary();
};

// ---------- reader ----------
let pf = null, current = null, pages = [], fills = [], resizeT, lastW = 0, lastH = 0, ui = false, uiT;
const PAD = 30;

function bookSize(aspect = 0.68) {
  const stage = $('#stage'); const cs = getComputedStyle(stage);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 4, availW = stage.clientWidth - 4;
  const portrait = availW < 760;
  let h = availH, w = h * aspect;
  const maxW = portrait ? availW : availW / 2;
  if (w > maxW) { w = maxW; h = w / aspect; }
  return { w: Math.floor(w), h: Math.floor(h), portrait };
}
const hardPage = (title, sub = '') => { const d = document.createElement('div'); d.className = 'page hard'; d.dataset.density = 'hard'; d.innerHTML = `<div></div><small style="font:13px sans-serif;opacity:.6;margin-top:14px">${sub}</small>`; d.firstChild.textContent = title; return d; };
const blankPage = () => { const d = document.createElement('div'); d.className = 'page'; return d; };

async function openBook(id) {
  current = await getBook(id);
  $('#library').hidden = true; $('#reader').hidden = false; $('#title').textContent = current.title;
  await buildBook();
}
async function buildBook() {
  if (pf) { try { pf.destroy(); } catch (e) {} pf = null; }
  $('#book').innerHTML = ''; $('#loading').hidden = false;
  const buf = await current.blob.arrayBuffer();
  const frac = current.progress || 0;
  let content, size, cover;
  if (current.type === 'pdf') ({ content, size, cover } = await preparePDF(buf));
  else ({ content, size, cover } = await prepareEPUB(buf));
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
  const sync = () => { const i = pf.getCurrentPageIndex(); $('#slider').value = i; $('#label').textContent = `${i} / ${pages.length - 1}`;
    updateLazy(i); current.progress = i / (pages.length - 1); putBook(current); };
  pf.on('flip', sync); sync();
}
function updateLazy(i) {
  pages.forEach((p, k) => { const f = p._fill; if (!f) return; const near = Math.abs(k - i) <= 5;
    if (near && !p._on) { p._on = true; f(p); } else if (!near && p._on) { p._on = false; p._clear(p); } });
}

// ---------- PDF ----------
async function preparePDF(buf) {
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const first = await pdf.getPage(1); const vp = first.getViewport({ scale: 1 });
  const size = bookSize(vp.width / vp.height); const content = []; let cover = null;
  for (let n = 1; n <= pdf.numPages; n++) {
    const d = document.createElement('div'); d.className = n === 1 ? 'page hard pdfcover' : 'page'; if (n === 1) d.dataset.density = 'hard';
    d._fill = async el => { const pg = await pdf.getPage(n); if (!el._on) return;
      const v0 = pg.getViewport({ scale: 1 }); const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const s = Math.min(size.w / v0.width, size.h / v0.height) * dpr; const v = pg.getViewport({ scale: s });
      const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
      await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
      if (el._on) { c.style.objectFit = 'contain'; el.prepend(c); } };
    d._clear = el => el.querySelectorAll('canvas').forEach(c => c.remove());
    if (n === 1) cover = d; else content.push(d);
  }
  return { content, size, cover };
}

// ---------- EPUB ----------
const resolve = (base, rel) => decodeURIComponent(new URL(rel, 'http://x/' + base).pathname.slice(1));
async function prepareEPUB(buf) {
  const zip = await JSZip.loadAsync(buf);
  const text = p => zip.file(p).async('string');
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const container = xml(await text('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const opf = xml(await text(opfPath));
  const manifest = {}; opf.querySelectorAll('manifest > item').forEach(i => manifest[i.getAttribute('id')] = i.getAttribute('href'));
  const spine = [...opf.querySelectorAll('spine > itemref')].map(r => manifest[r.getAttribute('idref')]).filter(Boolean);
  const size = bookSize(0.68); const W = size.w, H = size.h;
  const blobCache = {};
  const blobURL = async path => { if (blobCache[path]) return blobCache[path]; const f = zip.file(path); if (!f) return null;
    const b = await f.async('blob'); return blobCache[path] = URL.createObjectURL(b.type ? b : new Blob([b], { type: /\.png$/i.test(path) ? 'image/png' : /\.gif$/i.test(path) ? 'image/gif' : /\.svg$/i.test(path) ? 'image/svg+xml' : 'image/jpeg' })); };

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
    chapters.push(body.innerHTML);
  }

  const vpad = 36, innerW = W - 2 * PAD, innerH = H - 2 * vpad;
  const styleContent = el => { el.className = 'content';
    el.style.cssText = `width:${innerW}px;height:${innerH}px;padding:0 ${PAD}px;box-sizing:content-box;column-width:${innerW}px;column-gap:${2 * PAD}px;`; };
  const meas = document.createElement('div'); meas.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden'; document.body.append(meas);
  const content = [];
  for (const html of chapters) {
    const m = document.createElement('div'); m.className = 'page'; m.style.cssText = `width:${W}px;height:${H}px`; const c = document.createElement('div'); styleContent(c); c.innerHTML = html;
    meas.innerHTML = ''; m.append(c); meas.append(m);
    await Promise.all([...c.querySelectorAll('img')].map(i => i.decode ? i.decode().catch(() => {}) : 0));
    const n = Math.max(1, Math.round(c.scrollWidth / W));
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div'); d.className = 'page';
      d._fill = el => { const clip = document.createElement('div'); clip.className = 'clip'; clip.style.cssText = `top:${vpad}px;height:${innerH}px`;
        const cc = document.createElement('div'); styleContent(cc); cc.style.transform = `translateX(${-i * W}px)`; cc.innerHTML = html; clip.append(cc); el.prepend(clip); };
      d._clear = el => el.querySelectorAll('.clip').forEach(c => c.remove());
      content.push(d);
    }
  }
  meas.remove();
  let cover = null;
  try { const cb = await epubCover(zip); if (cb) { cover = document.createElement('div'); cover.className = 'page hard pdfcover'; cover.dataset.density = 'hard';
    const im = document.createElement('img'); im.src = URL.createObjectURL(cb); im.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'; cover.append(im); } } catch (e) {}
  return { content, size, cover };
}

// ---------- controls ----------
$('#back').onclick = () => { setUI(false); if (pf) { try { pf.destroy(); } catch (e) {} pf = null; } $('#reader').hidden = true; $('#library').hidden = false; renderLibrary(); };
$('#next').onclick = () => pf && pf.flipNext();
$('#prev').onclick = () => pf && pf.flipPrev();
$('#slider').onchange = e => pf && pf.turnToPage(+e.target.value);
$('#slider').oninput = () => setUI(true);
$('#controls').onclick = $('#bar').onclick = () => setUI(true);
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

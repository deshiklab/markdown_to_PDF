/* Shared helpers for every Folio tool: DOM, files, formatting, and lazy
   loading of the heavier PDF libraries. Works both as an ES module (Vite) and
   as a classic script (open index.html straight from disk). */

/* -------------------------------------------------- tiny DOM helpers ---- */
export function q(selector, root = document) {
  return root.querySelector(selector);
}

export function qa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined || value === '') continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------- notifications ---- */
let toastTimer;
export function toast(message, isError = false) {
  const node = q('#toast');
  if (!node) {
    console[isError ? 'error' : 'log'](`[folio] ${message}`);
    return;
  }
  window.clearTimeout(toastTimer);
  node.textContent = message;
  node.classList.toggle('is-error', Boolean(isError));
  node.classList.add('is-visible');
  toastTimer = window.setTimeout(() => node.classList.remove('is-visible'), 3400);
}
window.folioToast = toast;

/* ------------------------------------------------------------ files ---- */
export function bytes(size) {
  if (!Number.isFinite(size)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(size, 1)) / Math.log(1024)));
  const value = size / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** Trigger a browser download for a Blob without touching the network. */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeFileName(name, extension) {
  const base = String(name || 'document').replace(/\.[a-z0-9]+$/i, '').trim() || 'document';
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${cleaned || 'document'}.${extension}`;
}

/** Opens the native picker without a visible trigger button. */
export function pickFiles({ accept = '', multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple, hidden: true });
    input.addEventListener('change', () => {
      resolve(Array.from(input.files || []));
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/* Keep drop zones honest: only react when real files are dragged. */
export function hasFiles(event) {
  return Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes('Files');
}

/* ---------------------------------------------------------- numbers ---- */
/** "1-3,7,10-" style page lists -> [{start, end}] with 1-based, inclusive ends. */
export function parsePageRanges(input, pageCount) {
  const text = String(input || '').trim();
  if (!text || /^(all|every|full|\*)$/i.test(text)) {
    return { ranges: pageCount ? [{ start: 1, end: pageCount }] : [], ok: true };
  }
  const ranges = [];
  const errors = [];
  for (const part of text.split(/[,;]/)) {
    const piece = part.trim();
    if (!piece) continue;
    const match = /^(\d+)?\s*(?:-|–|to)\s*(\d+)?$|^\s*(\d+)\s*$/i.exec(piece);
    if (!match) {
      errors.push(piece);
      continue;
    }
    const isRange = piece.includes('-') || piece.includes('–') || /to/i.test(piece);
    let start;
    let end;
    if (isRange) {
      start = match[1] ? Number(match[1]) : 1;
      end = match[2] ? Number(match[2]) : pageCount;
    } else {
      start = end = Number(match[3]);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end > pageCount || start > end) {
      errors.push(piece);
      continue;
    }
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  return { ranges: mergeRanges(ranges), ok: errors.length === 0, errors };
}

function mergeRanges(list) {
  const out = [];
  for (const range of list) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

export function rangeLabel(ranges, pageCount) {
  if (!ranges.length) return 'no pages';
  const total = ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
  const text = ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}${r.end === pageCount ? '' : ''}`)).join(', ');
  return `${text} · ${total} ${total === 1 ? 'page' : 'pages'}`;
}

/* -------------------------------------------------------------- misc ---- */
export function debounce(fn, wait = 200) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

export function progress({ bar, label }) {
  return (value, text) => {
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, value * 100))}%`;
    if (label && text) label.textContent = text;
  };
}


export const isFileProtocol = window.location.protocol === 'file:';

/* Anything the bundler can resolve for us is pushed in here by src/main.js;
   when index.html is opened straight from disk, the inline script hands over
   the UMD globals on window instead. */
export const injected = {
  marked: null,
  DOMPurify: null,
  PDFLib: null,
  pdfjs: null,
  zip: null,
  pdfjsAssets: null,
  loadPdfLib: null,
  loadPdfJs: null,
  loadZip: null,
  loadHtml2Pdf: null,
};

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const script = el('script', { src });
    script.onload = () => resolve(true);
    script.onerror = () => {
      script.remove();
      reject(new Error(`Could not load ${src}`));
    };
    document.head.append(script);
  });
}

let pdfLibPromise;
export function loadPdfLib() {
  if (injected.PDFLib) return Promise.resolve(injected.PDFLib);
  if (isFileProtocol) {
    pdfLibPromise ??= loadClassicScript('./node_modules/pdf-lib/dist/pdf-lib.min.js').then(() => {
      if (!window.PDFLib) throw new Error('pdf-lib did not load.');
      return window.PDFLib;
    });
    return pdfLibPromise;
  }
  pdfLibPromise ??= injected.loadPdfLib ? injected.loadPdfLib() : import('pdf-lib');
  return pdfLibPromise;
}

let pdfJsPromise;
export function loadPdfJs() {
  if (injected.pdfjs) return Promise.resolve(injected.pdfjs);
  if (isFileProtocol) {
    return Promise.reject(new Error('Reading a PDF from disk needs the dev server — run `npm run dev` and open http://localhost:5173/.'));
  }
  pdfJsPromise ??= injected.loadPdfJs();
  return pdfJsPromise;
}

/** Extra getDocument() options (character maps, standard fonts) for odd PDFs. */
export function pdfjsAssetOptions() {
  return injected.pdfjsAssets ?? {};
}

/** Open a PDF for reading, with the shared asset hints applied. */
export async function openPdfDocument(buffer) {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument({ data: buffer, isEvalSupported: false, ...pdfjsAssetOptions() }).promise;
}

let zipPromise;
export async function loadZip() {
  if (injected.zip) return injected.zip;
  const fflate = injected.loadZip ? await injected.loadZip() : await import('fflate');
  return { zip: fflate.zip, zipSync: fflate.zipSync };
}

let html2pdfPromise;
export function loadHtml2PdfBridge() {
  if (isFileProtocol && window.html2pdf) return Promise.resolve(window.html2pdf);
  if (!injected.loadHtml2Pdf) {
    return Promise.reject(new Error('The PDF writer is not available in this mode.'));
  }
  html2pdfPromise ??= injected.loadHtml2Pdf();
  return html2pdfPromise;
}


export async function makeZip(entries) {
  const { zip } = await loadZip();
  return new Promise((resolve, reject) => {
    zip(entries, { level: 0 }, (error, data) => (error ? reject(error) : resolve(new Blob([data], { type: 'application/zip' }))));
  });
}

/** Decode an image file once: a blob URL plus its natural size. */
export function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
        name: file.name,
        size: file.size,
        type: file.type || 'image/*',
        image,
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name || 'That image'} could not be decoded.`));
    };
    image.src = url;
  });
}

/** Re-encode an image to JPEG/PNG data URL at a bounded size — used for previews and PDF payloads. */
export function rasterize(source, { maxSize = 2200, quality = 0.9, type = 'image/jpeg', background = '#ffffff' } = {}) {
  const { image, width, height } = source;
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (type === 'image/jpeg') {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL(type, quality);
  return { dataUrl, width: canvas.width, height: canvas.height };
}

/* ------------------------------------------------------------ state ---- */
export function store(key, fallback) {
  const storageKey = `folio:${key}`;
  return {
    read() {
      try {
        const raw = window.localStorage.getItem(storageKey);
        return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
      } catch (error) {
        console.warn(`Folio could not read "${key}" from local storage:`, error);
        return { ...fallback };
      }
    },
    write(value) {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(value));
        return true;
      } catch (error) {
        console.warn(`Folio could not save "${key}" locally:`, error);
        return false;
      }
    },
  };
}

/** Shared placeholder block used by every tool's empty state. */
export function emptyState({ title, note, action } = {}) {
  return el('div', { class: 'empty-preview' }, [
    el('div', {
      class: 'empty-icon',
      'aria-hidden': 'true',
      html: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 7.5h16l8 8V40H12V7.5Z"/><path d="M28 8v8h8M18 23h12M18 28h12M18 33h7" stroke-linecap="round"/></svg>',
    }),
    el('strong', { text: title }),
    el('span', { text: note }),
    action || null,
  ]);
}

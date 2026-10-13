// Shared utilities for the Folio studio. Anything that more than one tool
// (Markdown → PDF, PDF Lab, Translate, Converter, Portfolio, Sign, Finish)
// might reach for lives here. The goal is a thin, dependency-free module
// that tools can pull in without pulling in a whole tab's worth of code.
//
// Conventions:
//   * Functions are pure where possible.
//   * Anything that touches the DOM goes through the small helpers below
//     so the rest of the code reads like markup, not querySelector chains.
//   * Toasts, file pickers, lazy loaders, and localStorage prefs all live
//     in one place so a future refactor (e.g. swapping localStorage for
//     IndexedDB) only changes this file.

const NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'text', 'defs', 'use', 'symbol', 'tspan', 'title', 'desc']);

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

/**
 * Create an element with attributes and children.
 *
 *   h('button', { class: 'btn', onClick }, 'Save')
 *   h('div', { class: 'row' }, [h('span', null, 'hi'), h('span', null, 'there')])
 *
 * Children can be strings, numbers, nodes, or arrays of any of those.
 * `null` / `undefined` / `false` are skipped. Event handlers are wired up
 * if the key starts with `on` (e.g. `onClick`, `onInput`).
 */
export function h(tag, attrs = null, children = null) {
  const el = SVG_TAGS.has(tag.toLowerCase())
    ? document.createElementNS(NS, tag)
    : document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class' || key === 'className') {
        el.setAttribute('class', value);
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key === 'dataset' && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (v != null) el.dataset[k] = v;
        }
      } else if (key === 'html') {
        el.innerHTML = value;
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden' || key === 'open') {
        if (value) el.setAttribute(key, '');
      } else if (key === 'value' && el.tagName === 'TEXTAREA') {
        el.value = value;
      } else if (key === 'value' && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) {
        el.value = value;
      } else {
        el.setAttribute(key, value);
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(parent, children) {
  if (children == null || children === false) return;
  if (Array.isArray(children)) {
    for (const c of children) appendChildren(parent, c);
    return;
  }
  if (children instanceof Node) {
    parent.append(children);
    return;
  }
  parent.append(document.createTextNode(String(children)));
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function on(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

// ---------------------------------------------------------------------------
// File pickers
// ---------------------------------------------------------------------------

/**
 * Open the native file picker with a given accept list and resolve with the
 * chosen file (or null on cancel). Re-uses a single hidden `<input>` per
 * call site to keep the call shape predictable.
 */
export function pickFile({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.multiple = multiple;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    let resolved = false;
    const cleanup = () => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    input.addEventListener('change', () => {
      resolved = true;
      cleanup();
      if (multiple) resolve(Array.from(input.files || []));
      else resolve(input.files && input.files[0] ? input.files[0] : null);
    });
    // The cancel event isn't reliable across browsers; fall back to focus.
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(multiple ? [] : null);
        }
      }, 400);
    }, { once: true });
    document.body.append(input);
    input.click();
  });
}

/**
 * Read a File as ArrayBuffer. Used by every PDF tool before handing bytes
 * to pdf-lib / pdf.js.
 */
export function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Read a File as text (UTF-8 by default).
 */
export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsText(file, 'utf-8');
  });
}

/**
 * Read a File as a data URL (for image previews).
 */
export function readFileDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Trigger a browser download of a Blob. `filename` is sanitised lightly
 * (no path separators, no control chars).
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFilename(filename);
  document.body.append(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

export function sanitizeFilename(name) {
  if (!name) return 'document';
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'document';
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastEl = null;
let toastTimer = null;

/**
 * Show a short message in the bottom-right. Errors get a red style.
 * Re-calling replaces the previous toast before its timer expires.
 */
export function showToast(message, { error = false, duration = 3200 } = {}) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.toggle('is-error', !!error);
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.classList.remove('is-visible');
  }, duration);
}

// ---------------------------------------------------------------------------
// Lazy loaders
// ---------------------------------------------------------------------------

const loaderCache = new Map();

/**
 * Memoised async module loader. Use for any heavy dependency that should
 * only be pulled in when the relevant tab is opened.
 *
 *   const loadPdfLib = lazy(() => import('pdf-lib'));
 *   const { PDFDocument } = await loadPdfLib();
 */
export function lazy(loader) {
  return () => {
    if (loaderCache.has(loader)) return loaderCache.get(loader);
    const promise = loader().then((mod) => {
      loaderCache.set(loader, mod);
      return mod;
    });
    loaderCache.set(loader, promise);
    return promise;
  };
}

// ---------------------------------------------------------------------------
// localStorage preferences
// ---------------------------------------------------------------------------

/**
 * Tiny localStorage wrapper with JSON encoding. Falls back to an
 * in-memory map when storage is unavailable (private mode, quota).
 */
const memoryStore = new Map();

function storageAvailable() {
  try {
    const k = '__folio_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return true;
  } catch (error) {
    return false;
  }
}

const hasStorage = typeof window !== 'undefined' && storageAvailable();

export function readPref(key, fallback = null) {
  try {
    const raw = hasStorage
      ? window.localStorage.getItem(`folio:${key}`)
      : memoryStore.get(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.warn('readPref failed:', key, error);
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    const raw = JSON.stringify(value);
    if (hasStorage) window.localStorage.setItem(`folio:${key}`, raw);
    else memoryStore.set(key, raw);
    return true;
  } catch (error) {
    console.warn('writePref failed:', key, error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Misc small utilities
// ---------------------------------------------------------------------------

export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function debounce(fn, delay = 200) {
  let timeout;
  const debounced = (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => clearTimeout(timeout);
  return debounced;
}

export function uniqueId(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
}

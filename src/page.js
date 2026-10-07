/* Folio's page setup — one sheet of paper, shared by every tab.

   The studio, Translate, Portfolio, Convert, PDF Lab, Finish and Sign all put
   their work on the same page, so the numbers live in one store (`page:v1`) and
   in one strip under the tab bar. Change the margins in Translate and the studio
   preview moves with it; `@page`, the on-screen sheet and every PDF export read
   the same millimetres, so what is printed is what was previewed. */
import { q, qa, store, toast } from './lib.js';

const MM_TO_PX = 96 / 25.4;

export const SHEETS = {
  a4: { label: 'A4', width: 210, height: 297 },
  letter: { label: 'US Letter', width: 215.9, height: 279.4 },
  legal: { label: 'US Legal', width: 215.9, height: 355.6 },
  a5: { label: 'A5', width: 148, height: 210 },
  a3: { label: 'A3', width: 297, height: 420 },
  postcard: { label: 'Postcard 6×4in', width: 152.4, height: 101.6 },
  square: { label: 'Square 1:1', width: 210, height: 210 },
};

/* The named settings. "Book" is the one with a binding gutter. */
export const PRESETS = {
  comfortable: { label: 'Comfortable', top: 16, right: 14, bottom: 16, left: 14, gutter: 0 },
  compact: { label: 'Compact', top: 12, right: 11, bottom: 12, left: 11, gutter: 0 },
  wide: { label: 'Wide', top: 22, right: 19, bottom: 22, left: 19, gutter: 0 },
  book: { label: 'Book / bound', top: 18, right: 13, bottom: 16, left: 13, gutter: 9 },
  none: { label: 'Near bleed', top: 4, right: 4, bottom: 4, left: 4, gutter: 0 },
};

export const UNITS = {
  mm: { label: 'mm', factor: 1, step: 0.5, digits: 1 },
  in: { label: 'in', factor: 1 / 25.4, step: 0.0625, digits: 4 },
  pt: { label: 'pt', factor: 72 / 25.4, step: 1, digits: 0 },
};

const SIDES = ['top', 'right', 'bottom', 'left'];

const fallback = {
  sheet: 'a4',
  orientation: 'portrait',
  preset: 'comfortable',
  unit: 'mm',
  top: 16,
  right: 14,
  bottom: 16,
  left: 14,
  gutter: 0,
  mirror: false,
  backgrounds: true,
  scale: 100,
};

const prefs = store('page:v1', fallback);
const listeners = new Set();

const clamp = (value, min = 0, max = 120) => Math.min(max, Math.max(min, Number(value) || 0));

function normalise(value = {}) {
  const next = { ...fallback, ...value };
  if (!SHEETS[next.sheet]) next.sheet = 'a4';
  if (!UNITS[next.unit]) next.unit = 'mm';
  next.orientation = next.orientation === 'landscape' ? 'landscape' : 'portrait';
  for (const side of SIDES) next[side] = clamp(next[side], 0, 80);
  next.gutter = clamp(next.gutter, 0, 40);
  next.scale = Math.min(200, Math.max(40, Math.round(Number(next.scale) || 100)));
  next.mirror = Boolean(next.mirror);
  next.backgrounds = next.backgrounds !== false;
  if (next.preset !== 'custom' && !PRESETS[next.preset]) next.preset = 'comfortable';
  if (PRESETS[next.preset]) {
    const preset = PRESETS[next.preset];
    // a preset owns its numbers, so switching to one is never a half-applied edit
    for (const side of SIDES) next[side] = preset[side];
    next.gutter = preset.gutter;
  }
  return next;
}

let settings = normalise(prefs.read());

/** The current page setup, in millimetres, as a copy. */
export function page() {
  return { ...settings, margins: marginsMm(settings) };
}

export function setPage(patch, { notify = true } = {}) {
  settings = normalise({ ...settings, ...patch });
  prefs.write(settings);
  if (notify) for (const listener of [...listeners]) listener(page());
  return page();
}

export function onPage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ------------------------------------------------------------- geometry ---- */
export function sheetMm(next = settings) {
  const sheet = SHEETS[next.sheet] ?? SHEETS.a4;
  const landscape = next.orientation === 'landscape';
  return {
    label: sheet.label,
    landscape,
    width: landscape ? sheet.height : sheet.width,
    height: landscape ? sheet.width : sheet.height,
  };
}

/** Margins for one sheet. `pageIndex` only matters when the gutter is mirrored. */
export function marginsMm(next = settings, pageIndex = 0) {
  const gutter = clamp(next.gutter, 0, 40);
  let left = clamp(next.left);
  let right = clamp(next.right);
  if (gutter) {
    if (next.mirror && pageIndex % 2 === 1) right += gutter;
    else left += gutter;
  }
  return { top: clamp(next.top), right, bottom: clamp(next.bottom), left };
}

export function marginsPx(next = settings, pageIndex = 0) {
  const mm = marginsMm(next, pageIndex);
  const out = {};
  for (const side of SIDES) out[side] = Math.round(mm[side] * MM_TO_PX);
  return out;
}

/** `16mm 14mm 16mm 14mm` — what CSS wants. */
export function marginCss(next = settings, pageIndex = 0, unit = 'mm') {
  const mm = marginsMm(next, pageIndex);
  const factor = unit === 'px' ? MM_TO_PX : 1;
  const digits = unit === 'px' ? 0 : 2;
  return SIDES.map((side) => `${+(mm[side] * factor).toFixed(digits)}${unit}`).join(' ');
}

export function sheetPx(next = settings) {
  return Math.round(sheetMm(next).width * MM_TO_PX);
}

export function toUnit(mm, unit = settings.unit) {
  const u = UNITS[unit] ?? UNITS.mm;
  const stepped = Math.round((mm * u.factor) / u.step) * u.step;
  return +stepped.toFixed(u.digits);
}

export function fromUnit(value, unit = settings.unit) {
  const u = UNITS[unit] ?? UNITS.mm;
  return clamp((Number(value) || 0) / u.factor);
}

/* --------------------------------------------------------------- style ---- */
/**
 * Margins for the *printer*. Padding on a sheet is applied once, at the top of
 * the box, so a document that runs to page two would have no top margin there —
 * `@page` margins repeat on every sheet, so the printed page uses those. A
 * scale below 100 shrinks the content by growing the margins around it.
 */
export function printMargins(next = settings) {
  const m = marginsMm(next);
  const scale = (next.scale ?? 100) / 100;
  if (scale >= 1) return m;
  const sheet = sheetMm(next);
  const extraX = ((sheet.width - m.left - m.right) * (1 - scale)) / 2;
  const extraY = ((sheet.height - m.top - m.bottom) * (1 - scale)) / 2;
  return { top: m.top + extraY, right: m.right + extraX, bottom: m.bottom + extraY, left: m.left + extraX };
}

/* One <style> element carries the printed page: physical sheet size, margins
   that repeat on every sheet, colour handling and scale. */
export function installPageStyle() {
  const sheet = sheetMm();
  const pad = marginCss(settings, 0, 'mm');
  const print = printMargins(settings);
  const rules = `@media print {
  @page { size: ${+sheet.width.toFixed(2)}mm ${+sheet.height.toFixed(2)}mm; margin: ${+print.top.toFixed(2)}mm ${+print.right.toFixed(2)}mm ${+print.bottom.toFixed(2)}mm ${+print.left.toFixed(2)}mm; }
}
`;
  const root = document.documentElement;
  root.style.setProperty('--pg-pad', pad);
  root.style.setProperty('--pg-sheet', `${+sheet.width.toFixed(2)}mm`);
  root.style.setProperty('--pg-scale', String(settings.scale / 100));
  root.style.setProperty('--pg-color', settings.backgrounds ? 'exact' : 'economy');
  let node = q('#folioPageStyle');
  if (!node) {
    node = document.createElement('style');
    node.id = 'folioPageStyle';
    document.head.append(node);
  }
  if (node.textContent !== rules) node.textContent = rules;
  return rules;
}

/* ------------------------------------------------------------- printing ---- */
/** Print whatever the active tab is showing, with the shared page setup. */
export function printSheet(scope) {
  const panel = scope ?? q('.tool-panel:not([hidden])');
  const roots = [...(panel?.querySelectorAll('[data-print-root]') ?? [])];
  const root = roots.find((node) => node.offsetParent !== null) ?? roots[0]
    ?? (panel?.id === 'panel-markdown' ? q('#paper') : null);
  if (!root) {
    toast('Nothing to print in this tab yet — the page fills in once there is something on it.', true);
    return false;
  }
  installPageStyle();
  const previous = document.body.dataset.printTool;
  document.body.dataset.printTool = (panel?.id ?? 'sheet').replace('panel-', '');
  const done = () => {
    if (previous === undefined) delete document.body.dataset.printTool;
    else document.body.dataset.printTool = previous;
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.setTimeout(() => {
    try {
      window.print();
    } catch (error) {
      console.error(error);
      toast('Your browser blocked the print dialog — try Cmd/Ctrl-P.', true);
      done();
    }
  }, 60);
  window.setTimeout(done, 4000);
  return true;
}

/* -------------------------------------------------------------- the UI ---- */
const printerIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 7.5V4h7v3.5M6.5 14.5H5a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 5 7.5h10a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-1.5"/><path d="M6.5 12h7v4h-7z"/></svg>';

const caret = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.25 3.5 3.5 3.5-3.5"/></svg>';

function uiPrefs() {
  return store('page:ui:v1', { collapsed: null });
}
const ui = uiPrefs();

/** A Print button that any tool can drop into its own header. */
export function printButton(label = 'Print') {
  return `<button class="button button-light" type="button" data-print-go title="Print — or save as PDF — using the page setup above" aria-label="Print this document">${printerIcon}<span>${label}</span></button>`;
}

export function controlsMarkup() {
  const state = page();
  const sheets = Object.entries(SHEETS)
    .map(([value, sheet]) => `<option value="${value}"${value === state.sheet ? ' selected' : ''}>${sheet.label}</option>`)
    .join('');
  const presets = [...Object.entries(PRESETS).map(([value, preset]) => [value, preset.label]), ['custom', 'Custom…']]
    .map(([value, label]) => `<option value="${value}"${value === state.preset ? ' selected' : ''}>${label}</option>`)
    .join('');
  const fields = [...SIDES.map((side) => ({ side, label: side })), { side: 'gutter', label: 'gutter' }]
    .map(({ side, label }) => `<label class="pg-num"><span>${label}</span><input type="number" min="0" max="80" step="any" data-side="${side}" aria-label="Page ${label} margin" /></label>`)
    .join('');
  const units = Object.entries(UNITS)
    .map(([value, unit]) => `<button type="button" class="pg-seg${value === state.unit ? ' is-on' : ''}" data-unit="${value}" aria-pressed="${value === state.unit}">${unit.label}</button>`)
    .join('');
  return `<div class="pg-inner">
    <button class="pg-toggle" type="button" id="pgToggle" aria-expanded="true" aria-controls="pgFields">${printerIcon}<strong>Page &amp; print</strong><small id="pgToggleNote">one sheet, every tab</small></button>
    <div class="pg-fields" id="pgFields">
      <label class="field pg-cell"><span class="field-label">Paper</span><select class="text-input" id="pgSheet" aria-label="Paper size">${sheets}</select></label>
      <span class="field pg-cell"><span class="field-label">Orientation</span>
        <span class="pg-seg-row">
          <button type="button" class="pg-seg${state.orientation === 'portrait' ? ' is-on' : ''}" data-orientation="portrait" aria-pressed="${state.orientation === 'portrait'}">Portrait</button>
          <button type="button" class="pg-seg${state.orientation === 'landscape' ? ' is-on' : ''}" data-orientation="landscape" aria-pressed="${state.orientation === 'landscape'}">Landscape</button>
        </span>
      </span>
      <label class="field pg-cell"><span class="field-label">Margins</span><select class="text-input" id="pgPreset" aria-label="Margin preset">${presets}</select></label>
      <span class="field pg-cell pg-cell-nums"><span class="field-label">Per side (${UNITS[state.unit]?.label ?? 'mm'})</span><span class="pg-nums" role="group" aria-label="Page margins">${fields}</span></span>
      <span class="field pg-cell"><span class="field-label">Units</span><span class="pg-seg-row">${units}</span></span>
      <label class="field field-switch pg-switch"><input type="checkbox" class="switch-input" id="pgMirror" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Mirror the gutter</span></label>
      <label class="field field-switch pg-switch"><input type="checkbox" class="switch-input" id="pgColour" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Print backgrounds</span></label>
      <label class="field pg-scale"><span class="field-label-row"><span class="field-label">Print scale</span><output class="range-readout" id="pgScaleOut">100%</output></span><input class="range-input" id="pgScale" type="range" min="60" max="160" step="5" /></label>
      <button class="button button-light pg-print" type="button" id="pgPrint">${printerIcon}<span>Print</span></button>
    </div>
    <span class="pg-readout" id="pgReadout"></span>
  </div>`;
}

export function readoutText(next = page()) {
  const sheet = sheetMm(next);
  const unit = UNITS[next.unit] ?? UNITS.mm;
  const same = next.top === next.bottom && next.right === next.left;
  const numbers = same
    ? `${toUnit(next.top, next.unit)}${next.top === next.right ? '' : ` / ${toUnit(next.right, next.unit)}`}`
    : `${toUnit(next.top, next.unit)} · ${toUnit(next.right, next.unit)} · ${toUnit(next.bottom, next.unit)} · ${toUnit(next.left, next.unit)}`;
  const gutter = next.gutter ? ` + ${toUnit(next.gutter, next.unit)}${next.mirror ? ' mirrored' : ''} gutter` : '';
  return `${sheet.label} · ${sheet.landscape ? 'landscape' : 'portrait'} · ${numbers} ${unit.label}${gutter}${next.scale !== 100 ? ` · printed at ${next.scale}%` : ''}`;
}

function paintInputs(host, next = page()) {
  for (const node of qa('[data-side]', host)) {
    if (node.value !== undefined && document.activeElement !== node) node.value = String(toUnit(next[node.dataset.side], next.unit));
  }
  const sheet = q('#pgSheet', host);
  if (sheet) sheet.value = next.sheet;
  const preset = q('#pgPreset', host);
  if (preset) preset.value = next.preset;
  const mirror = q('#pgMirror', host);
  if (mirror) mirror.checked = next.mirror;
  const colour = q('#pgColour', host);
  if (colour) colour.checked = next.backgrounds;
  const scale = q('#pgScale', host);
  if (scale) scale.value = String(next.scale);
  const scaleOut = q('#pgScaleOut', host);
  if (scaleOut) scaleOut.textContent = `${next.scale}%`;
  for (const node of qa('[data-unit]', host)) node.classList.toggle('is-on', node.dataset.unit === next.unit), (node.ariaPressed = String(node.dataset.unit === next.unit));
  for (const node of qa('[data-orientation]', host)) node.classList.toggle('is-on', node.dataset.orientation === next.orientation), (node.ariaPressed = String(node.dataset.orientation === next.orientation));
  const readout = q('#pgReadout', host);
  if (readout) readout.textContent = readoutText(next);
  const summary = q('#pgToggleNote', host);
  if (summary) summary.textContent = `${sheetMm(next).label} · ${marginsMm(next).top}mm margin · ${next.scale === 100 ? 'actual size' : `${next.scale}%`}`;
  const nums = q('.pg-nums', host);
  if (nums) nums.dataset.step = String((UNITS[next.unit] ?? UNITS.mm).step);
}

/**
 * Mount the strip in `host` (or replace its contents) and keep it in step with
 * the store — including changes made from another tab.
 */
export function mountControls(host, { onPreview } = {}) {
  if (!host) return null;
  host.innerHTML = controlsMarkup();
  document.body.classList.add('has-page-strip');
  installPageStyle();
  paintInputs(host);

  const toggle = q('#pgToggle', host);
  const narrow = window.matchMedia('(max-width: 820px)');
  /* Until the reader picks a side, the panel decides: open where there is room,
     folded to one line on a phone. After that their choice is kept. */
  const apply = (value) => {
    host.classList.toggle('is-collapsed', value);
    toggle?.setAttribute('aria-expanded', String(!value));
  };
  const chosen = ui.read().collapsed;
  apply(chosen ?? narrow.matches);
  toggle?.addEventListener('click', () => {
    const next = !host.classList.contains('is-collapsed');
    apply(next);
    ui.write({ collapsed: next });
  });
  narrow.addEventListener?.('change', (event) => {
    if (ui.read().collapsed === null || ui.read().collapsed === undefined) apply(event.matches);
  });

  const refresh = (next = page()) => {
    installPageStyle();
    paintInputs(host, next);
    onPreview?.(next);
  };
  const stop = onPage(refresh);

  host.addEventListener('change', (event) => {
    const node = event.target;
    if (node.id === 'pgSheet') return void setPage({ sheet: node.value });
    if (node.id === 'pgPreset') {
      if (node.value === 'custom') return void setPage({ preset: 'custom' }, { notify: false }) || refresh();
      return void setPage({ preset: node.value });
    }
    if (node.id === 'pgMirror') return void setPage({ mirror: node.checked });
    if (node.id === 'pgColour') return void setPage({ backgrounds: node.checked });
    if (node.id === 'pgScale') return void setPage({ scale: Number(node.value) });
    const side = node.dataset?.side;
    if (side) return void setPage({ preset: 'custom', [side]: fromUnit(node.value, page().unit) });
  });
  host.addEventListener('click', (event) => {
    const unit = event.target.closest?.('[data-unit]');
    if (unit) return void setPage({ unit: unit.dataset.unit });
    const orientation = event.target.closest?.('[data-orientation]');
    if (orientation) return void setPage({ orientation: orientation.dataset.orientation });
    if (event.target.closest?.('#pgPrint')) return void printSheet();
  });
  // typing a margin should read as live, not wait for blur
  host.addEventListener('input', (event) => {
    if (event.target.id === 'pgScale') return void setPage({ scale: Number(event.target.value) });
    const side = event.target.dataset?.side;
    if (!side) return;
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    setPage({ preset: 'custom', [side]: fromUnit(value, page().unit) });
  });

  return { refresh, unmount: () => { stop(); host.innerHTML = ''; document.body.classList.remove('has-page-strip'); } };
}

/* ------------------------------------------------------- legacy bridge ---- */
/* The Markdown studio starts as a classic script so that opening index.html
   straight from disk still works; it reads the page setup through this. */
const api = {
  SHEETS,
  printButton,
  PRESETS,
  UNITS,
  page,
  setPage,
  onPage,
  sheetMm,
  sheetPx,
  marginsMm,
  marginsPx,
  marginCss,
  installPageStyle,
  mountControls,
  printSheet,
  printMargins,
  readoutText,
  toUnit,
  fromUnit,
};

if (typeof window !== 'undefined') window.folioPage = api;
export default api;

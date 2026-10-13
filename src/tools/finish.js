// Finish tab. Four sub-panels, all running locally:
//
//   1. Metadata — read and rewrite the document fields (title, author,
//      subject, keywords, creator, producer, dates).
//   2. Footers — stamp `{page}` / `{total}` footers with placement,
//      size, margin, and range.
//   3. Redact — black out terms, optionally flatten the page to an
//      image so the text really is gone.
//   4. Checksum — SHA-2 / SHA-3 digest with a sidecar `.sum` file.
//
// Same shell as Converter: sub-tab strip inside the panel, settings
// card on the left, file area on the right, busy action button at the
// bottom. Every sub-panel is independent — pick a file in one, switch
// to another, come back, the state is still there.

import {
  h, clear, showToast, readFileBytes, downloadBlob, sanitizeFilename,
  formatBytes, lazy,
} from '../lib.js';

const loadPdfLib = lazy(() => import('pdf-lib'));
const loadPdfJs = lazy(() => import('pdfjs-dist/build/pdf.mjs'));

const SUBTABS = [
  { id: 'metadata', title: 'Metadata', sub: 'Read and rewrite the document fields.' },
  { id: 'footers', title: 'Page numbers & footers', sub: 'Stamp `{page}` / `{total}` at any edge.' },
  { id: 'redact', title: 'Redact', sub: 'Black out terms, optionally flatten the page.' },
  { id: 'checksum', title: 'Checksum', sub: 'SHA-2 / SHA-3 digest with a sidecar .sum file.' },
];

export function start(root) {
  const panel = h('div', { class: 'tool-finish' }, [
    buildSubTabBar(),
    h('div', { class: 'finish-stage', id: 'finishStage' }),
  ]);

  root.append(panel);

  const subRoots = new Map();
  let active = SUBTABS[0].id;

  function renderActive() {
    const stage = panel.querySelector('#finishStage');
    clear(stage);
    if (subRoots.has(active)) {
      stage.append(subRoots.get(active));
    } else {
      const sub = buildSubTool(active);
      subRoots.set(active, sub);
      stage.append(sub);
    }
    panel.querySelectorAll('.finish-subtab').forEach((b) => {
      const on = b.dataset.subtab === active;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  panel.querySelectorAll('.finish-subtab').forEach((button) => {
    button.addEventListener('click', () => {
      active = button.dataset.subtab;
      renderActive();
    });
  });

  renderActive();

  return {
    unmount() { panel.remove(); },
  };
}

function buildSubTabBar() {
  return h('div', { class: 'finish-subtabs', role: 'tablist', 'aria-label': 'Finish sub-tools' },
    SUBTABS.map((s) => h('button', {
      type: 'button',
      class: 'finish-subtab',
      role: 'tab',
      'data-subtab': s.id,
      'aria-selected': 'false',
    }, [
      h('span', { class: 'finish-subtab-title' }, s.title),
      h('span', { class: 'finish-subtab-sub' }, s.sub),
    ]))
  );
}

function buildSubTool(id) {
  switch (id) {
    case 'metadata': return buildMetadataPanel();
    case 'footers': return buildFootersPanel();
    case 'redact': return buildRedactPanel();
    case 'checksum': return buildChecksumPanel();
    default: throw new Error(`Unknown Finish sub-tool: ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Common chrome for the four panels: a file picker + drop area, a
// status line, and a busy action button.
// ---------------------------------------------------------------------------

function buildFileArea({ statusText, multiple = false, accept = 'application/pdf,.pdf' }) {
  return h('section', { class: 'finish-files' }, [
    h('div', { class: 'finish-drop', 'data-drop': 'true' }, [
      dropIcon(),
      h('strong', null, 'Drop a PDF here'),
      h('span', null, 'or use the file picker below'),
      h('button', { class: 'button button-light', type: 'button', 'data-pick': 'true' }, 'Choose PDF'),
    ]),
    h('div', { class: 'finish-file-list', 'data-files': 'true' }),
    h('div', { class: 'finish-foot' }, [
      h('span', { class: 'finish-status', 'data-status': 'true' }, statusText),
      h('button', { class: 'button button-export', type: 'button', 'data-action': 'true' }, [
        actionIcon(),
        h('span', null, 'Run'),
      ]),
    ]),
  ]);
}

/**
 * Wire a panel's file area. The `state` object is updated in place
 * with `state.file` (single) or `state.files` (multiple). Returns a
 * refresh() function the panel can call to redraw the file list.
 */
function wireFileArea(panel, state, { accept, multiple, onChange }) {
  const drop = panel.querySelector('[data-drop]');
  const list = panel.querySelector('[data-files]');
  const pick = panel.querySelector('[data-pick]');
  const status = panel.querySelector('[data-status]');

  function render() {
    clear(list);
    const files = state.files || (state.file ? [state.file] : []);
    if (!files.length) return;
    files.forEach((file, index) => {
      const row = h('div', { class: 'finish-file-row' }, [
        h('span', { class: 'finish-file-name' }, file.name),
        h('span', { class: 'finish-file-size' }, formatBytes(file.size)),
        h('button', {
          type: 'button',
          class: 'finish-file-remove',
          'aria-label': `Remove ${file.name}`,
          title: 'Remove',
        }, '×'),
      ]);
      row.querySelector('button').addEventListener('click', () => {
        if (multiple) state.files.splice(index, 1);
        else state.file = null;
        render();
        if (onChange) onChange();
      });
      list.append(row);
    });
  }

  function addFiles(fileList) {
    const arr = Array.from(fileList || []);
    if (multiple) {
      state.files = (state.files || []).concat(arr);
    } else {
      state.file = arr[0] || null;
    }
    render();
    if (onChange) onChange();
  }

  pick.addEventListener('click', async () => {
    const { pickFile } = await import('../lib.js');
    const files = await pickFile({ accept, multiple });
    if (files && files.length) addFiles(files);
  });

  ['dragenter', 'dragover'].forEach((evt) => drop.addEventListener(evt, (e) => {
    e.preventDefault();
    drop.classList.add('is-drag');
  }));
  ['dragleave', 'drop'].forEach((evt) => drop.addEventListener(evt, (e) => {
    if (evt === 'dragleave' && e.target !== drop) return;
    drop.classList.remove('is-drag');
  }));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  return { render, setStatus: (text) => { status.textContent = text; }, status };
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = !!busy;
  if (busy) {
    button.innerHTML = '<span class="export-spinner" aria-hidden="true"></span><span>' + label + '</span>';
  } else {
    button.innerHTML = '';
    button.append(actionIcon());
    const span = document.createElement('span');
    span.textContent = label;
    button.append(span);
  }
}

function dropIcon() {
  return h('svg', { viewBox: '0 0 32 32', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M16 20.5V5.75m0 0-5.5 5.5M16 5.75l5.5 5.5 M7 19v5.25A2.75 2.75 0 0 0 9.75 27h12.5A2.75 2.75 0 0 0 25 24.25V19', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  );
}

function actionIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3' })
  );
}

// ---------------------------------------------------------------------------
// 1. Metadata
// ---------------------------------------------------------------------------

// PDF date format is `D:YYYYMMDDHHmmSSOHH'mm'` (a literal D:, then
// year, month, day, hour, minute, second, and an optional timezone).
// The output field of a `pdf-lib` PDFDocument is a JS Date if you
// pass one, so we round-trip Date ↔ PDF string here.
const PDF_DATE_FIELDS = ['CreationDate', 'ModDate'];

function pdfDateToDate(str) {
  if (!str || typeof str !== 'string' || !str.startsWith('D:')) return null;
  const body = str.slice(2);
  const y = parseInt(body.slice(0, 4), 10);
  const mo = parseInt(body.slice(4, 6), 10) - 1;
  const d = parseInt(body.slice(6, 8), 10);
  const h = parseInt(body.slice(8, 10), 10) || 0;
  const mi = parseInt(body.slice(10, 12), 10) || 0;
  const s = parseInt(body.slice(12, 14), 10) || 0;
  if (!Number.isFinite(y)) return null;
  return new Date(y, mo, d, h, mi, s);
}

function dateToPdfDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return undefined;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function buildMetadataPanel() {
  const root = h('div', { class: 'finish-sub' });

  const form = h('form', { class: 'finish-metadata', autocomplete: 'off' }, [
    metaRow('Title', 'title', 'Document title'),
    metaRow('Author', 'author', 'Who wrote it'),
    metaRow('Subject', 'subject', 'A short description'),
    metaRow('Keywords', 'keywords', 'comma, separated, tags'),
    metaRow('Creator', 'creator', 'Originating application'),
    metaRow('Producer', 'producer', 'PDF producer'),
    metaRow('Created', 'created', '', { type: 'datetime-local' }),
    metaRow('Modified', 'modified', '', { type: 'datetime-local' }),
  ]);

  const fileArea = buildFileArea({ statusText: 'No PDF yet.' });
  root.append(
    h('div', { class: 'finish-sub-head' }, [
      h('h3', null, 'Metadata'),
      h('p', null, 'Read the document fields from a PDF, edit them, and save the result. The text layer of the source pages is preserved.'),
    ]),
    h('div', { class: 'finish-sub-body finish-sub-body-wide' }, [
      h('aside', { class: 'finish-settings' }, [
        h('h4', { class: 'finish-settings-title' }, 'Document fields'),
        form,
      ]),
      fileArea,
    ]),
  );

  const state = { file: null, fields: defaults() };
  const wire = wireFileArea(root, state, { accept: 'application/pdf,.pdf', multiple: false, onChange: loadCurrent });

  async function loadCurrent() {
    if (!state.file) {
      Object.assign(state.fields, defaults());
      fillForm(form, state.fields);
      wire.setStatus('No PDF yet.');
      return;
    }
    wire.setStatus(`Reading ${state.file.name}…`);
    try {
      const { PDFDocument } = await loadPdfLib();
      const bytes = await readFileBytes(state.file);
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      Object.assign(state.fields, readFields(doc));
      fillForm(form, state.fields);
      wire.setStatus(`Loaded ${state.file.name}. Edit any field and click Save.`);
    } catch (error) {
      console.error('Metadata read failed:', error);
      wire.setStatus('Could not read this PDF.');
      showToast('Could not read the PDF metadata.', { error: true });
    }
  }

  // Live-sync form changes into state.
  form.addEventListener('input', () => {
    const fd = new FormData(form);
    state.fields.title = fd.get('title') || '';
    state.fields.author = fd.get('author') || '';
    state.fields.subject = fd.get('subject') || '';
    state.fields.keywords = fd.get('keywords') || '';
    state.fields.creator = fd.get('creator') || '';
    state.fields.producer = fd.get('producer') || '';
    state.fields.created = fd.get('created') || '';
    state.fields.modified = fd.get('modified') || '';
  });

  root.querySelector('[data-action]').addEventListener('click', () => metadataSave(root, state, wire));
  // Update the action button label to "Save" since this panel writes
  // the file out, unlike the others which print / stamp / hash.
  const actionBtn = root.querySelector('[data-action]');
  actionBtn.querySelector('span').textContent = 'Save PDF';
  return root;
}

function defaults() {
  return {
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: '',
    producer: '',
    created: '',
    modified: '',
  };
}

function readFields(doc) {
  const out = defaults();
  // pdf-lib exposes the Info dictionary via getInfoDict(); getTitle,
  // getAuthor, etc. are convenience wrappers around it.
  out.title = doc.getTitle() || '';
  out.author = doc.getAuthor() || '';
  out.subject = doc.getSubject() || '';
  out.keywords = (doc.getKeywords() || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean).join(', ');
  out.creator = doc.getCreator() || '';
  out.producer = doc.getProducer() || '';
  // Created / modified aren't direct getters on pdf-lib's high-level
  // API, so reach into the Info dict.
  const info = doc.getInfoDict ? doc.getInfoDict() : null;
  if (info) {
    const created = pdfDateToDate(info.get ? info.get('CreationDate') : null);
    const modified = pdfDateToDate(info.get ? info.get('ModDate') : null);
    if (created) out.created = toLocalInput(created);
    if (modified) out.modified = toLocalInput(modified);
  }
  return out;
}

function writeFields(doc, fields) {
  doc.setTitle(fields.title || undefined);
  doc.setAuthor(fields.author || undefined);
  doc.setSubject(fields.subject || undefined);
  if (fields.keywords && fields.keywords.trim()) {
    doc.setKeywords(fields.keywords.split(/[;,]/).map((s) => s.trim()).filter(Boolean));
  } else {
    doc.setKeywords([]);
  }
  doc.setCreator(fields.creator || undefined);
  doc.setProducer(fields.producer || undefined);
  const info = doc.getInfoDict ? doc.getInfoDict() : null;
  if (info && info.set) {
    if (fields.created) {
      const d = new Date(fields.created);
      if (!Number.isNaN(d.getTime())) info.set('CreationDate', dateToPdfDate(d));
    }
    if (fields.modified) {
      const d = new Date(fields.modified);
      if (!Number.isNaN(d.getTime())) info.set('ModDate', dateToPdfDate(d));
    }
  }
  // pdf-lib updates ModDate automatically on save(), but we want the
  // user's value if they set one explicitly, so override after the
  // helper runs. (The set above runs first; save() runs in the caller.)
}

function fillForm(form, fields) {
  for (const [key, value] of Object.entries(fields)) {
    const input = form.querySelector(`[name="${key}"]`);
    if (input) input.value = value || '';
  }
}

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function metaRow(label, name, placeholder, { type = 'text' } = {}) {
  return h('label', { class: 'finish-row' }, [
    h('span', { class: 'finish-row-label' }, label),
    h('input', { class: 'finish-row-input', type, name, placeholder, autocomplete: 'off', spellcheck: type === 'text' ? 'false' : 'false' }),
  ]);
}

async function metadataSave(root, state, wire) {
  if (!state.file) {
    showToast('Choose a PDF first.', { error: true });
    return;
  }
  const button = root.querySelector('[data-action]');
  setBusy(button, true, 'Saving…');
  wire.setStatus('Rewriting metadata…');
  try {
    const { PDFDocument } = await loadPdfLib();
    const bytes = await readFileBytes(state.file);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    writeFields(doc, state.fields);
    const out = await doc.save();
    const baseName = state.file.name.replace(/\.pdf$/i, '') || 'document';
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${baseName}-metadata.pdf`);
    wire.setStatus(`Saved ${baseName}-metadata.pdf (${formatBytes(out.length)}).`);
    showToast(`Saved ${baseName}-metadata.pdf`);
  } catch (error) {
    console.error('Metadata save failed:', error);
    wire.setStatus(error && error.message ? error.message : 'Could not save the PDF.');
    showToast('Could not save the PDF.', { error: true });
  } finally {
    setBusy(button, false, 'Save PDF');
  }
}

// ---------------------------------------------------------------------------
// 2. Page numbers / footers
// ---------------------------------------------------------------------------

function buildFootersPanel() {
  const root = h('div', { class: 'finish-sub' });
  const fileArea = buildFileArea({ statusText: 'No PDF yet.' });

  const settings = [
    selectRow('Placement', 'placement', [
      ['bottom-center', 'Bottom · center'],
      ['bottom-right', 'Bottom · right'],
      ['bottom-left', 'Bottom · left'],
      ['top-center', 'Top · center'],
      ['top-right', 'Top · right'],
      ['top-left', 'Top · left'],
    ]),
    textRow('Text template', 'template', 'Page {page} of {total}', 'Use {page} and {total}'),
    rangeRow('Font size', 'fontSize', 7, 18, 9, 'pt'),
    colorRow('Colour', 'color', '#444444'),
    rangeRow('Margin', 'margin', 8, 60, 22, 'mm'),
    selectRow('Pages', 'pages', [['all', 'All pages'], ['range', 'A range…'], ['first', 'Skip first (cover)'], ['except-last', 'Skip last']]),
    textRow('Range', 'range', '1', 'e.g. 2-9'),
    h('label', { class: 'finish-row finish-row-check' }, [
      h('input', { type: 'checkbox', 'data-setting': 'excludeFirst', checked: true }),
      h('span', null, 'Skip page 1 (typical for cover pages)'),
    ]),
  ];

  root.append(
    h('div', { class: 'finish-sub-head' }, [
      h('h3', null, 'Page numbers & footers'),
      h('p', null, 'Stamp a `{page}` / `{total}` footer at any edge of every page. The text layer of the source pages is preserved; the stamp is drawn into the page content stream.'),
    ]),
    h('div', { class: 'finish-sub-body' }, [
      h('aside', { class: 'finish-settings' }, [
        h('h4', { class: 'finish-settings-title' }, 'Footer'),
        ...settings,
      ]),
      fileArea,
    ]),
  );

  const state = {
    file: null,
    placement: 'bottom-center',
    template: 'Page {page} of {total}',
    fontSize: 9,
    color: '#444444',
    margin: 22,
    pages: 'all',
    range: '',
    excludeFirst: true,
  };
  const wire = wireFileArea(root, state, { accept: 'application/pdf,.pdf', multiple: false });
  wireSettings(root, state, {
    placement: 'placement',
    template: 'template',
    fontSize: 'fontSize',
    color: 'color',
    margin: 'margin',
    pages: 'pages',
    range: 'range',
    excludeFirst: 'excludeFirst',
  });

  // Hide the range input unless the user picked "A range…".
  const rangeRowEl = root.querySelector('[data-setting="range"]')?.closest('label');
  const syncRange = () => {
    if (!rangeRowEl) return;
    const off = state.pages !== 'range';
    rangeRowEl.style.opacity = off ? '0.45' : '1';
    rangeRowEl.style.pointerEvents = off ? 'none' : 'auto';
  };
  syncRange();
  root.querySelector('[data-setting="pages"]').addEventListener('change', syncRange);

  const actionBtn = root.querySelector('[data-action]');
  actionBtn.querySelector('span').textContent = 'Stamp footer';
  actionBtn.addEventListener('click', () => footersStamp(root, state, wire));
  return root;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 0.27, g: 0.27, b: 0.27 };
  return {
    r: parseInt(m[1], 16) / 255,
    g: parseInt(m[2], 16) / 255,
    b: parseInt(m[3], 16) / 255,
  };
}

async function footersStamp(root, state, wire) {
  if (!state.file) {
    showToast('Choose a PDF first.', { error: true });
    return;
  }
  const button = root.querySelector('[data-action]');
  setBusy(button, true, 'Stamping…');
  wire.setStatus('Reading PDF…');
  try {
    const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
    const bytes = await readFileBytes(state.file);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const total = doc.getPageCount();

    // Resolve the target page set.
    let pages;
    if (state.pages === 'range') {
      pages = parseRange(state.range, total);
      if (!pages.length) throw new Error('The page range did not match any page.');
    } else if (state.pages === 'first') {
      pages = [1];
    } else if (state.pages === 'except-last') {
      pages = Array.from({ length: total - 1 }, (_, i) => i + 1);
    } else {
      pages = Array.from({ length: total }, (_, i) => i + 1);
    }
    if (state.excludeFirst) {
      pages = pages.filter((n) => n !== 1);
    }

    const colour = hexToRgb(state.color);
    const marginPt = Number(state.margin) * 2.835; // mm → pt (1mm = 2.835pt)
    const fontSize = Number(state.fontSize);

    for (const pageNum of pages) {
      const page = doc.getPage(pageNum - 1);
      const { width: pw, height: ph } = page.getSize();
      const text = state.template.replace(/\{page\}/g, String(pageNum)).replace(/\{total\}/g, String(total));
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      const placement = positionFor(state.placement, pw, ph, textWidth, fontSize, marginPt);

      page.drawText(text, {
        x: placement.x,
        y: placement.y,
        size: fontSize,
        font,
        color: rgb(colour.r, colour.g, colour.b),
      });
    }

    const out = await doc.save();
    const baseName = state.file.name.replace(/\.pdf$/i, '') || 'document';
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${baseName}-stamped.pdf`);
    wire.setStatus(`Stamped ${pages.length} page${pages.length === 1 ? '' : 's'} into ${baseName}-stamped.pdf (${formatBytes(out.length)}).`);
    showToast(`Saved ${baseName}-stamped.pdf`);
  } catch (error) {
    console.error('Footer stamp failed:', error);
    wire.setStatus(error && error.message ? error.message : 'Could not stamp the PDF.');
    showToast('Could not stamp the PDF.', { error: true });
  } finally {
    setBusy(button, false, 'Stamp footer');
  }
}

function positionFor(placement, pageW, pageH, textW, fontSize, margin) {
  // PDF origin is bottom-left.
  let x;
  if (placement.endsWith('center')) x = (pageW - textW) / 2;
  else if (placement.endsWith('right')) x = pageW - textW - margin;
  else x = margin;
  let y;
  if (placement.startsWith('top')) y = pageH - margin - fontSize;
  else y = margin;
  return { x, y };
}

function parseRange(text, total) {
  if (!text) return [];
  const out = new Set();
  for (const chunk of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = chunk.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    const [from, to] = a <= b ? [a, b] : [b, a];
    for (let i = from; i <= to; i += 1) {
      if (i >= 1 && i <= total) out.add(i);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 3. Redact
// ---------------------------------------------------------------------------

function buildRedactPanel() {
  const root = h('div', { class: 'finish-sub' });
  const fileArea = buildFileArea({ statusText: 'No PDF yet.' });

  const settings = [
    textAreaRow('Terms (one per line)', 'terms', '', 'A line per phrase. Matching is case-insensitive.'),
    colorRow('Box colour', 'color', '#000000'),
    rangeRow('Padding', 'padding', 0, 12, 2, 'pt'),
    h('label', { class: 'finish-row finish-row-check' }, [
      h('input', { type: 'checkbox', 'data-setting': 'flatten', checked: false }),
      h('span', null, 'Flatten page to image so the text really is gone (slower, larger file)'),
    ]),
    rangeRow('Flatten DPI', 'dpi', 96, 300, 150, 'dpi'),
    selectRow('Pages', 'pages', [['all', 'All pages'], ['range', 'A range…']]),
    textRow('Range', 'range', '1', 'e.g. 2-9'),
  ];

  root.append(
    h('div', { class: 'finish-sub-head' }, [
      h('h3', null, 'Redact'),
      h('p', null, 'Paint an opaque box over every occurrence of a term, optionally flatten the page to an image so the text really is gone. The PDF text layer under the box survives unless you tick the flatten switch.'),
    ]),
    h('div', { class: 'finish-sub-body' }, [
      h('aside', { class: 'finish-settings' }, [
        h('h4', { class: 'finish-settings-title' }, 'Redaction'),
        ...settings,
      ]),
      fileArea,
    ]),
  );

  const state = {
    file: null,
    terms: '',
    color: '#000000',
    padding: 2,
    flatten: false,
    dpi: 150,
    pages: 'all',
    range: '',
  };
  const wire = wireFileArea(root, state, { accept: 'application/pdf,.pdf', multiple: false });
  wireSettings(root, state, {
    terms: 'terms',
    color: 'color',
    padding: 'padding',
    flatten: 'flatten',
    dpi: 'dpi',
    pages: 'pages',
    range: 'range',
  });

  // Disable / dim the DPI row unless flatten is on.
  const dpiRowEl = root.querySelector('[data-setting="dpi"]')?.closest('label');
  const syncDpi = () => {
    if (!dpiRowEl) return;
    const off = !state.flatten;
    dpiRowEl.style.opacity = off ? '0.45' : '1';
    dpiRowEl.style.pointerEvents = off ? 'none' : 'auto';
  };
  syncDpi();
  root.querySelector('[data-setting="flatten"]').addEventListener('change', syncDpi);

  // Range row visibility.
  const rangeRowEl = root.querySelector('[data-setting="range"]')?.closest('label');
  const syncRange = () => {
    if (!rangeRowEl) return;
    const off = state.pages !== 'range';
    rangeRowEl.style.opacity = off ? '0.45' : '1';
    rangeRowEl.style.pointerEvents = off ? 'none' : 'auto';
  };
  syncRange();
  root.querySelector('[data-setting="pages"]').addEventListener('change', syncRange);

  const actionBtn = root.querySelector('[data-action]');
  actionBtn.querySelector('span').textContent = 'Redact & save';
  actionBtn.addEventListener('click', () => redactRun(root, state, wire));
  return root;
}

async function redactRun(root, state, wire) {
  if (!state.file) {
    showToast('Choose a PDF first.', { error: true });
    return;
  }
  const terms = (state.terms || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!terms.length) {
    showToast('Add at least one term to redact.', { error: true });
    return;
  }
  const button = root.querySelector('[data-action]');
  setBusy(button, true, 'Redacting…');
  wire.setStatus(`Searching for ${terms.length} term${terms.length === 1 ? '' : 's'}…`);
  try {
    if (state.flatten) {
      await redactWithFlatten(state, terms, wire);
    } else {
      await redactWithBoxes(state, terms, wire);
    }
  } catch (error) {
    console.error('Redact failed:', error);
    wire.setStatus(error && error.message ? error.message : 'Could not redact the PDF.');
    showToast('Could not redact the PDF.', { error: true });
  } finally {
    setBusy(button, false, 'Redact & save');
  }
}

/**
 * Cheap path: draw an opaque black rectangle over every match's
 * bounding box. The text layer underneath is *not* removed — a copy
 * paste of the original text would still reveal it. The README
 * explicitly warns about this: "Finish paints an opaque layer over
 * redacted words, which hides them but does not remove them — tick
 * 'Flatten page to image' when the text itself has to go."
 */
async function redactWithBoxes(state, terms, wire) {
  const { PDFDocument, rgb } = await loadPdfLib();
  const pdfjs = await loadPdfJs();
  const bytes = await readFileBytes(state.file);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const total = doc.getPageCount();
  const targets = resolvePageSet(state, total);
  const paddingPt = Number(state.padding);
  const colour = hexToRgb(state.color);

  // We need the original PDF so pdf.js can read it without disturbing
  // the pdf-lib document we're writing to.
  const sourceDoc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const lowerTerms = terms.map((t) => t.toLowerCase());

  let matches = 0;
  for (const pageNum of targets) {
    wire.setStatus(`Redacting page ${pageNum}/${total}…`);
    const page = await sourceDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const text = await page.getTextContent();
    const pageObj = doc.getPage(pageNum - 1);
    const { width: pw, height: ph } = pageObj.getSize();

    // pdf.js returns items in PDF user space (origin bottom-left). We
    // collect the runs of consecutive items whose joined text contains
    // a term, then take the union of their boxes.
    for (let i = 0; i < text.items.length; i += 1) {
      // Try every term against the joined text starting at item i.
      const joined = joinRun(text.items, i, 6);
      const lower = joined.text.toLowerCase();
      const hitIdx = lowerTerms.findIndex((t) => lower.includes(t));
      if (hitIdx === -1) continue;
      // We found a hit. Compute the box covering items i .. i+joined.count-1.
      const items = text.items.slice(i, i + joined.count);
      const box = unionBox(items, viewport, pageObj);
      pageObj.drawRectangle({
        x: box.x - paddingPt,
        y: box.y - paddingPt,
        width: box.width + paddingPt * 2,
        height: box.height + paddingPt * 2,
        color: rgb(colour.r, colour.g, colour.b),
        opacity: 1,
      });
      matches += 1;
      // Skip past this match so we don't redraw the same box per-item.
      i += joined.count - 1;
    }
  }

  const out = await doc.save();
  const baseName = state.file.name.replace(/\.pdf$/i, '') || 'document';
  downloadBlob(new Blob([out], { type: 'application/pdf' }), `${baseName}-redacted.pdf`);
  wire.setStatus(`Painted ${matches} box${matches === 1 ? '' : 'es'} over ${targets.length} page${targets.length === 1 ? '' : 's'} into ${baseName}-redacted.pdf.`);
  showToast(`Saved ${baseName}-redacted.pdf`);
}

/**
 * Strong path: rasterise every targeted page to an image, draw the
 * black redaction boxes on the bitmap, and re-embed the image in a
 * new PDF. The text layer is destroyed; the file is a flat picture.
 */
async function redactWithFlatten(state, terms, wire) {
  const { PDFDocument, rgb } = await loadPdfLib();
  const pdfjs = await loadPdfJs();
  const bytes = await readFileBytes(state.file);
  const sourceDoc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const total = sourceDoc.numPages;
  const targets = resolvePageSet(state, total);
  const out = await PDFDocument.create();
  const dpi = Number(state.dpi);
  const scale = dpi / 72;
  const lowerTerms = terms.map((t) => t.toLowerCase());
  const paddingPx = Number(state.padding) * scale;
  const colour = hexToRgb(state.color);

  for (const pageNum of targets) {
    wire.setStatus(`Flattening page ${pageNum}/${total}…`);
    const page = await sourceDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;

    // Paint boxes on the bitmap (canvas coordinates = viewport
    // coordinates; PDF and canvas share the same origin if the page
    // is not rotated).
    const text = await page.getTextContent();
    for (let i = 0; i < text.items.length; i += 1) {
      const joined = joinRun(text.items, i, 6);
      const hitIdx = lowerTerms.findIndex((t) => joined.text.toLowerCase().includes(t));
      if (hitIdx === -1) continue;
      const items = text.items.slice(i, i + joined.count);
      const box = unionBox(items, viewport, { getSize: () => ({ width: viewport.width, height: viewport.height }) });
      ctx.fillStyle = state.color || '#000000';
      ctx.fillRect(box.x - paddingPx, box.y - paddingPx, box.width + paddingPx * 2, box.height + paddingPx * 2);
      i += joined.count - 1;
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const image = await out.embedJpg(jpeg);
    const newPage = out.addPage([viewport.width, viewport.height]);
    newPage.drawImage(image, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  }

  const saved = await out.save();
  const baseName = state.file.name.replace(/\.pdf$/i, '') || 'document';
  downloadBlob(new Blob([saved], { type: 'application/pdf' }), `${baseName}-redacted-flat.pdf`);
  wire.setStatus(`Flattened ${targets.length} page${targets.length === 1 ? '' : 's'} into ${baseName}-redacted-flat.pdf (${formatBytes(saved.length)}).`);
  showToast(`Saved ${baseName}-redacted-flat.pdf`);
}

function joinRun(items, start, maxCount) {
  let text = '';
  for (let i = start; i < Math.min(items.length, start + maxCount); i += 1) {
    text += items[i].str;
  }
  return { text, count: Math.min(maxCount, items.length - start) };
}

function unionBox(items, viewport, pageObj) {
  // Compute the union of item.transform-driven boxes in viewport
  // (top-left origin) coordinates.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    const tx = item.transform;
    if (!tx) continue;
    const x = tx[4];
    const y = tx[5];
    const w = item.width || 0;
    const h = item.height || Math.abs(tx[3]) || 0;
    // PDF y origin is bottom-left; viewport origin is top-left.
    // transform[5] is the baseline; subtract height to get the top.
    const top = (viewport.height - (y + h));
    const left = x;
    const right = x + w;
    const bottom = top + h;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function resolvePageSet(state, total) {
  if (state.pages === 'range') {
    return parseRange(state.range, total);
  }
  return Array.from({ length: total }, (_, i) => i + 1);
}

// ---------------------------------------------------------------------------
// 4. Checksum
// ---------------------------------------------------------------------------

function buildChecksumPanel() {
  const root = h('div', { class: 'finish-sub' });
  const fileArea = buildFileArea({ statusText: 'No PDF yet.' });

  const settings = [
    selectRow('Algorithm', 'algorithm', [
      ['SHA-256', 'SHA-256 (recommended)'],
      ['SHA-384', 'SHA-384'],
      ['SHA-512', 'SHA-512'],
      ['SHA-1', 'SHA-1 (legacy)'],
    ]),
    selectRow('Encoding', 'encoding', [
      ['hex', 'Hex (lowercase)'],
      ['hex-upper', 'Hex (uppercase)'],
      ['base64', 'Base64'],
    ]),
    h('label', { class: 'finish-row finish-row-check' }, [
      h('input', { type: 'checkbox', 'data-setting': 'sidecar', checked: true }),
      h('span', null, 'Also write a sidecar `.sum` file with the digest and metadata'),
    ]),
  ];

  root.append(
    h('div', { class: 'finish-sub-head' }, [
      h('h3', null, 'Checksum'),
      h('p', null, 'Hash the PDF bytes with the algorithm you choose, and optionally write a sidecar `.sum` file so you can verify the file you sent is the file that arrived.'),
    ]),
    h('div', { class: 'finish-sub-body' }, [
      h('aside', { class: 'finish-settings' }, [
        h('h4', { class: 'finish-settings-title' }, 'Hash'),
        ...settings,
      ]),
      fileArea,
    ]),
  );

  const state = { file: null, algorithm: 'SHA-256', encoding: 'hex', sidecar: true };
  const wire = wireFileArea(root, state, { accept: '*/*', multiple: false });
  wireSettings(root, state, {
    algorithm: 'algorithm',
    encoding: 'encoding',
    sidecar: 'sidecar',
  });

  const actionBtn = root.querySelector('[data-action]');
  actionBtn.querySelector('span').textContent = 'Take checksum';
  actionBtn.addEventListener('click', () => checksumRun(root, state, wire));
  return root;
}

async function checksumRun(root, state, wire) {
  if (!state.file) {
    showToast('Choose a PDF first.', { error: true });
    return;
  }
  const button = root.querySelector('[data-action]');
  setBusy(button, true, 'Hashing…');
  wire.setStatus(`Hashing ${state.file.name} with ${state.algorithm}…`);
  try {
    const bytes = await readFileBytes(state.file);
    const digest = await crypto.subtle.digest(state.algorithm, bytes);
    const hex = toHex(digest);
    const encoded = formatDigest(hex, state.encoding);
    const stamp = new Date().toISOString();

    // Always show the digest in the status line.
    wire.setStatus(`${state.algorithm}: ${encoded}  (${formatBytes(bytes.length)}, ${stamp})`);

    if (state.sidecar) {
      const sidecar = `${encoded}  ${state.file.name}  ${stamp}\n`;
      const baseName = state.file.name.replace(/\.pdf$/i, '') || 'document';
      downloadBlob(new Blob([sidecar], { type: 'text/plain;charset=utf-8' }), `${baseName}.${state.algorithm.toLowerCase()}.sum`);
      showToast(`Saved ${baseName}.${state.algorithm.toLowerCase()}.sum`);
    } else {
      // Copy to clipboard for convenience.
      try {
        await navigator.clipboard.writeText(encoded);
        showToast('Digest copied to clipboard.');
      } catch (err) {
        showToast(encoded);
      }
    }
  } catch (error) {
    console.error('Checksum failed:', error);
    wire.setStatus(error && error.message ? error.message : 'Could not hash the file.');
    showToast('Could not hash the file.', { error: true });
  } finally {
    setBusy(button, false, 'Take checksum');
  }
}

function toHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i += 1) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

function formatDigest(hex, encoding) {
  if (encoding === 'base64') {
    let bin = '';
    for (let i = 0; i < hex.length; i += 2) {
      bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return btoa(bin);
  }
  if (encoding === 'hex-upper') return hex.toUpperCase();
  return hex;
}

// ---------------------------------------------------------------------------
// Shared settings wiring (select / text / range / checkbox)
// ---------------------------------------------------------------------------

function wireSettings(root, state, mapping) {
  for (const [domKey, stateKey] of Object.entries(mapping)) {
    const el = root.querySelector(`[data-setting="${domKey}"]`);
    if (!el) continue;
    if (el.type === 'checkbox') {
      el.checked = state[stateKey];
      el.addEventListener('change', () => { state[stateKey] = el.checked; });
    } else if (el.type === 'range') {
      el.value = state[stateKey];
      const labelEl = el.parentElement?.querySelector('[data-range-value]');
      if (labelEl) labelEl.textContent = `${el.value}${el.dataset.unit || ''}`;
      el.addEventListener('input', () => {
        const num = Number(el.value);
        state[stateKey] = Number.isFinite(num) ? num : el.value;
        if (labelEl) labelEl.textContent = `${el.value}${el.dataset.unit || ''}`;
      });
    } else {
      el.value = state[stateKey];
      el.addEventListener('input', () => { state[stateKey] = el.value; });
      el.addEventListener('change', () => { state[stateKey] = el.value; });
    }
  }
}

function selectRow(label, key, options) {
  return h('label', { class: 'finish-row' }, [
    h('span', { class: 'finish-row-label' }, label),
    h('span', { class: 'finish-row-control' }, [
      h('select', { 'data-setting': key },
        options.map(([value, name]) => h('option', { value }, name))
      ),
      h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'm4.5 6.25 3.5 3.5 3.5-3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
      ),
    ]),
  ]);
}

function textRow(label, key, placeholder, hint) {
  return h('label', { class: 'finish-row' }, [
    h('span', { class: 'finish-row-label' }, label),
    h('span', { class: 'finish-row-control' }, [
      h('input', { type: 'text', 'data-setting': key, placeholder, autocomplete: 'off', spellcheck: 'false' }),
      hint ? h('span', { class: 'finish-row-hint' }, hint) : null,
    ]),
  ]);
}

function textAreaRow(label, key, placeholder, hint) {
  return h('label', { class: 'finish-row finish-row-area' }, [
    h('span', { class: 'finish-row-label' }, label),
    h('span', { class: 'finish-row-control' }, [
      h('textarea', { 'data-setting': key, placeholder, rows: 4, spellcheck: 'false' }),
      hint ? h('span', { class: 'finish-row-hint' }, hint) : null,
    ]),
  ]);
}

function rangeRow(label, key, min, max, value, unit) {
  return h('label', { class: 'finish-row' }, [
    h('span', { class: 'finish-row-label' }, label),
    h('span', { class: 'finish-row-control finish-row-range' }, [
      h('input', { type: 'range', min, max, value, 'data-setting': key, 'data-unit': unit }),
      h('span', { class: 'finish-row-value', 'data-range-value': 'true' }, `${value}${unit}`),
    ]),
  ]);
}

function colorRow(label, key, value) {
  return h('label', { class: 'finish-row' }, [
    h('span', { class: 'finish-row-label' }, label),
    h('span', { class: 'finish-row-control finish-row-color' }, [
      h('input', { type: 'color', value, 'data-setting': key }),
    ]),
  ]);
}

/* Forms — add, read, and fill PDF form fields.

   The PDF spec lets a document carry interactive widgets (text inputs,
   checkboxes, radio groups, dropdowns) that a reader can fill in. This
   tab covers the three things you usually want to do with such a file:

     • Add fields to a flat PDF (turn a scan into a fillable form)
     • Read the answers out of a PDF that already has fields
     • Type answers into a PDF that has fields, then save the filled copy

   pdf-lib does the writing and form manipulation; pdf.js renders the page
   previews so the user can see what the file looks like.

   The tab loads on demand and is split into a side panel (one PDF) and a
   main panel (mode + controls). */

import {
  bytes,
  debounce,
  downloadBlob,
  el,
  emptyState,
  escapeHtml,
  hasFiles,
  injected,
  loadPdfJs,
  loadPdfLib,
  openPdfDocument,
  pickFiles,
  q,
  qa,
  store,
  toast,
} from '../lib.js';
import { printButton } from '../page.js';

const MODES = [
  { id: 'add', label: 'Add fields', note: 'Drop a flat PDF' },
  { id: 'read', label: 'Read answers', note: 'Export JSON or CSV' },
  { id: 'fill', label: 'Fill answers', note: 'Type and save' },
];

const FIELD_TYPES = [
  { id: 'text', label: 'Text' },
  { id: 'checkbox', label: 'Checkbox' },
  { id: 'radio', label: 'Radio' },
  { id: 'dropdown', label: 'Dropdown' },
];

const defaults = {
  mode: 'add',
  // add-mode
  newFieldType: 'text',
  newFieldName: '',
  newFieldPage: 1,
  newFieldOptions: '', // comma-separated, for radio/dropdown
  newFieldRequired: false,
  newFieldMulti: false, // dropdown only
  // read-mode
  readFormat: 'json', // 'json' | 'csv'
  // fill-mode
  flatten: false,
};

const prefs = store('forms:v1', defaults);

const state = {
  mode: prefs.read().mode,
  form: { ...prefs.read() },
  buffer: null,
  name: '',
  size: 0,
  pageCount: 0,
  // add-mode: the list of fields the user has placed on pages
  staged: [],
  // read-mode: the fields parsed out of the loaded PDF
  read: [],
  // fill-mode: the answers the user has typed
  answers: {},
};

const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';

export function start(root) {
  root.innerHTML = layout();
  wire(root);
  paintMode(root);
  return () => {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  };
}

/* ------------------------------------------------------------------ ui ---- */
function layout() {
  return `
<div class="lab-shell fn-shell fm-shell" id="fmShell" data-mode="${state.mode}">
  <section class="panel fn-side" aria-labelledby="fm-side-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">01</span>
        <div><h3 id="fm-side-title">One PDF</h3><p id="fmSideNote">Nothing open yet</p></div>
      </div>
      <div class="panel-header-actions"><button class="button button-light" type="button" id="fmClear"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.2 6.2l7.6 7.6m0-7.6-7.6 7.6"/></svg><span>Clear</span></button></div>
    </div>

    <div class="lab-drop" id="fmDrop" role="button" tabindex="0" aria-label="Choose a PDF for the forms tools">
      <span class="dropzone-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="13" height="13" rx="1.5"/><path d="M6 7h8M6 10h5M6 13h7"/><path d="M13.5 13.5h2v2h-2z" fill="currentColor" stroke="none"/></svg></span>
      <strong>Drop a PDF</strong>
      <span>or click to choose — read and rewritten in this tab</span>
      <span class="dropzone-button">Choose file</span>
    </div>

    <div id="fmCard" class="fn-card"></div>
    <div class="fn-preview" id="fmPreview" data-print-root hidden>
      <canvas id="fmCanvas" aria-label="Top of page one with the current form state drawn on"></canvas>
      <p class="fn-preview-note" id="fmPreviewNote">page 1 · live preview</p>
    </div>
  </section>

  <section class="panel fn-main" aria-labelledby="fm-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="fm-main-title">Work the form</h3><p><span class="live-dot"></span> Nothing is uploaded — you download a new file</p></div>
      </div>
      <div class="panel-header-actions">${printButton()}<span class="lab-count" id="fmStat">no file</span></div>
    </div>

    <div class="lab-modes" role="group" aria-label="Forms mode">
      ${MODES.map((mode) => `<button type="button" class="lab-mode${state.mode === mode.id ? ' is-on' : ''}" data-mode-btn="${mode.id}" aria-pressed="${state.mode === mode.id}"><strong>${mode.label}</strong><small>${mode.note}</small></button>`).join('')}
    </div>

    <div class="lab-body">
      <div class="fn-stage" data-fm-panel="add" hidden>
        <p class="lab-help">Drop a flat PDF, then pick a field type and a unique name, and click on the page preview to place the field. Use the list below to remove or rename a field before downloading.</p>

        <div class="lab-row fm-add-bar">
          <div class="field">
            <span class="field-label">Field type</span>
            <div class="lab-pos-row" role="group" aria-label="Field type">
              ${FIELD_TYPES.map((type) => `<button type="button" class="lab-pos fm-type-btn${state.form.newFieldType === type.id ? ' is-on' : ''}" data-fm-type="${type.id}" aria-pressed="${state.form.newFieldType === type.id}" title="${type.label}"><span>${type.label[0]}</span></button>`).join('')}
            </div>
          </div>
          <label class="field grow"><span class="field-label">Name (must be unique)</span><input class="text-input" id="fmNewName" type="text" value="${escapeHtml(state.form.newFieldName)}" placeholder="e.g. applicant.fullName" autocomplete="off" /></label>
        </div>

        <div class="lab-row fm-add-bar" id="fmOptionsRow" hidden>
          <label class="field grow"><span class="field-label">Options (comma-separated)</span><input class="text-input" id="fmNewOptions" type="text" value="${escapeHtml(state.form.newFieldOptions)}" placeholder="yes, no, maybe" autocomplete="off" /></label>
          <label class="field fm-check"><input type="checkbox" id="fmNewMulti"${state.form.newFieldMulti ? ' checked' : ''} /><span>Allow multiple</span></label>
        </div>

        <div class="lab-row fm-add-bar">
          <label class="field"><span class="field-label">Page</span><input class="text-input" id="fmNewPage" type="number" min="1" step="1" value="1" /></label>
        </div>

        <div class="lab-actions">
          <p class="lab-hint" id="fmAddHint">Open a PDF to start placing fields.</p>
          <div class="lab-actions-row">
            <button class="button button-light" type="button" id="fmAddPlace">Add to page</button>
            <button class="button button-export" type="button" id="fmAddGo">${downloadIcon}<span>Download fillable PDF</span></button>
          </div>
        </div>

        <div class="fm-staged-wrap">
          <h4 class="fm-h4">Placed fields <span class="fm-count" id="fmStagedCount">0</span></h4>
          <div id="fmStaged" class="fm-staged"></div>
        </div>
      </div>

      <div class="fn-stage" data-fm-panel="read" hidden>
        <p class="lab-help">Open a PDF that already has form fields. The tab will list every field, its type, and the value that was filled in, and let you copy or download the answers as JSON or CSV.</p>

        <div class="lab-row fm-add-bar">
          <div class="field">
            <span class="field-label">Format</span>
            <div class="lab-pos-row" role="group" aria-label="Export format">
              <button type="button" class="lab-pos${state.form.readFormat === 'json' ? ' is-on' : ''}" data-fm-fmt="json" aria-pressed="${state.form.readFormat === 'json'}"><span>JSON</span></button>
              <button type="button" class="lab-pos${state.form.readFormat === 'csv' ? ' is-on' : ''}" data-fm-fmt="csv" aria-pressed="${state.form.readFormat === 'csv'}"><span>CSV</span></button>
            </div>
          </div>
        </div>

        <div id="fmReadList" class="fm-read-list"></div>

        <div class="lab-actions">
          <p class="lab-hint" id="fmReadHint">Open a PDF to read its fields.</p>
          <div class="lab-actions-row">
            <button class="button button-light" type="button" id="fmReadCopy">Copy to clipboard</button>
            <button class="button button-export" type="button" id="fmReadDownload">${downloadIcon}<span>Download answers</span></button>
          </div>
        </div>
      </div>

      <div class="fn-stage" data-fm-panel="fill" hidden>
        <p class="lab-help">Open a PDF with form fields. Each field shows up in the list below; type an answer and the value is written into the file when you save.</p>
        <div id="fmFillList" class="fm-fill-list"></div>
        <div class="lab-actions">
          <p class="lab-hint" id="fmFillHint">Open a PDF with form fields to start filling.</p>
          <label class="field fm-check"><input type="checkbox" id="fmFlatten"${state.form.flatten ? ' checked' : ''} /><span>Flatten on save (lock the answers into the page)</span></label>
          <div class="lab-actions-row">
            <button class="button button-light" type="button" id="fmFillClear">Clear answers</button>
            <button class="button button-export" type="button" id="fmFillGo">${downloadIcon}<span>Save filled PDF</span></button>
          </div>
        </div>
      </div>
    </div>
  </section>
</div>
`;
}

/* ----------------------------------------------------------------- wire ---- */
function wire(root) {
  // file picker
  const drop = q('#fmDrop', root);
  const open = () => pickFiles({ accept: 'application/pdf,.pdf', multiple: false }).then(async (files) => {
    const file = files && files[0];
    if (file) await loadFile(file, root);
  });
  drop?.addEventListener('click', open);
  drop?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  drop?.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-hot'); });
  drop?.addEventListener('dragleave', () => drop.classList.remove('is-hot'));
  drop?.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-hot'); const file = e.dataTransfer?.files?.[0]; if (file) loadFile(file, root); });

  // clear
  q('#fmClear', root)?.addEventListener('click', () => clearFile(root));

  // mode tabs
  qa('[data-mode-btn]', root).forEach((node) => {
    node.addEventListener('click', () => {
      state.mode = node.dataset.modeBtn;
      state.form.mode = state.mode;
      prefs.write(state.form);
      paintMode(root);
    });
  });

  // add-mode
  qa('[data-fm-type]', root).forEach((node) => {
    node.addEventListener('click', () => {
      state.form.newFieldType = node.dataset.fmType;
      prefs.write(state.form);
      qa('[data-fm-type]', root).forEach((n) => {
        const on = n.dataset.fmType === state.form.newFieldType;
        n.classList.toggle('is-on', on);
        n.setAttribute('aria-pressed', String(on));
      });
      paintOptionsRow(root);
    });
  });
  q('#fmNewName', root)?.addEventListener('input', (e) => { state.form.newFieldName = e.target.value; prefs.write(state.form); });
  q('#fmNewOptions', root)?.addEventListener('input', (e) => { state.form.newFieldOptions = e.target.value; prefs.write(state.form); });
  q('#fmNewMulti', root)?.addEventListener('change', (e) => { state.form.newFieldMulti = e.target.checked; prefs.write(state.form); });

  // add-mode: canvas click-to-place
  const canvas = q('#fmCanvas', root);
  canvas?.addEventListener('click', (e) => {
    if (state.mode !== 'add' || !state._previewViewport) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // convert canvas pixel → PDF user space
    const [pdfX, pdfY] = state._previewViewport.convertToPdfPoint(cx, cy);
    placeFieldAt(pdfX, pdfY, root);
  });
  q('#fmNewPage', root)?.addEventListener('change', (e) => {
    state.form.newFieldPage = Math.max(1, Number(e.target.value) || 1);
    prefs.write(state.form);
    paintPreview(root);
  });

  // add-mode place + export
  q('#fmAddPlace', root)?.addEventListener('click', () => placeFieldAtCenter(root));
  q('#fmAddGo', root)?.addEventListener('click', () => exportAdd(root));

  // read-mode
  qa('[data-fm-fmt]', root).forEach((node) => {
    node.addEventListener('click', () => {
      state.form.readFormat = node.dataset.fmFmt;
      prefs.write(state.form);
      qa('[data-fm-fmt]', root).forEach((n) => {
        const on = n.dataset.fmFmt === state.form.readFormat;
        n.classList.toggle('is-on', on);
        n.setAttribute('aria-pressed', String(on));
      });
    });
  });
  q('#fmReadCopy', root)?.addEventListener('click', () => copyAnswers(root));
  q('#fmReadDownload', root)?.addEventListener('click', () => downloadAnswers(root));

  // fill-mode
  q('#fmFlatten', root)?.addEventListener('change', (e) => { state.form.flatten = e.target.checked; prefs.write(state.form); });
  q('#fmFillClear', root)?.addEventListener('click', () => clearAnswers(root));
  q('#fmFillGo', root)?.addEventListener('click', () => exportFill(root));
}

/* ---------------------------------------------------------- file load ---- */
async function loadFile(file, root) {
  try {
    const buffer = await file.arrayBuffer();
    state.buffer = buffer;
    state.name = file.name;
    state.size = file.size;

    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), ...(injected.pdfjsAssets || {}) }).promise;
    state.pageCount = doc.numPages;
    await doc.destroy();

    paintCard(root);
    paintMode(root);
    paintStaged(root);
    paintPreview(root);
    parseReadFields(root);
    toast(`Loaded ${file.name} (${state.pageCount} pages)`);
  } catch (err) {
    console.error('forms: loadFile failed', err);
    toast(`Could not open ${file.name}`);
  }
}

function clearFile(root) {
  state.buffer = null;
  state.name = '';
  state.size = 0;
  state.pageCount = 0;
  state.staged = [];
  state.read = [];
  state.answers = {};
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  paintCard(root);
  paintStaged(root);
  paintMode(root);
}

function paintCard(root) {
  const card = q('#fmCard', root);
  if (!card) return;
  if (!state.buffer) {
    card.innerHTML = '';
    return;
  }
  card.innerHTML = `
    <div class="fn-card-row"><span class="fn-card-label">File</span><span class="fn-card-value">${escapeHtml(state.name)}</span></div>
    <div class="fn-card-row"><span class="fn-card-label">Size</span><span class="fn-card-value">${bytes(state.size)}</span></div>
    <div class="fn-card-row"><span class="fn-card-label">Pages</span><span class="fn-card-value">${state.pageCount}</span></div>
  `;
}

function paintPreview(root) {
  if (state.mode !== 'add') return; // only add-mode has a live preview for now
  if (!state.buffer) return;
  // debounce so rapid changes don't thrash
  window.clearTimeout(state._previewTimer);
  state._previewTimer = window.setTimeout(() => renderPreview(root), 120);
}

async function renderPreview(root) {
  const holder = q('#fmPreview', root);
  const canvas = q('#fmCanvas', root);
  if (!holder || !canvas) return;
  if (!state.buffer || state.mode !== 'add') {
    holder.hidden = true;
    return;
  }
  holder.hidden = false;
  try {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: state.buffer.slice(0), isEvalSupported: false }).promise;
    const pageNum = Math.min(Math.max(1, Number(state.form.newFieldPage) || 1), doc.numPages);
    const page = await doc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = 240 / base.width;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    drawStagedOverlay(ctx, viewport, pageNum);
    const note = q('#fmPreviewNote', root);
    if (note) note.textContent = `page ${pageNum} · ${Math.round(base.width)}×${Math.round(base.height)} pt · click to place a field`;
    // store the viewport so click-to-place can convert coords
    state._previewViewport = viewport;
    state._previewPage = pageNum;
    state._previewBase = { w: base.width, h: base.height };
    await doc.destroy();
  } catch (error) {
    console.warn('Forms preview unavailable:', error);
    holder.hidden = true;
  }
}

function drawStagedOverlay(ctx, viewport, pageNum) {
  const items = state.staged.filter((f) => f.page === pageNum);
  ctx.save();
  for (const f of items) {
    // PDF coords: origin bottom-left. Convert top-left to viewport.
    const [x1, y1] = viewport.convertToViewportPoint(f.x, f.y + f.h);
    const [x2, y2] = viewport.convertToViewportPoint(f.x + f.w, f.y);
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    ctx.strokeStyle = '#3a5a40';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    // label
    ctx.fillStyle = '#3a5a40';
    ctx.font = `${Math.max(8, 10 * (viewport.scale || 1))}px "DM Mono", monospace`;
    ctx.textBaseline = 'top';
    const label = `${f.type[0].toUpperCase()} · ${f.name}`;
    const metrics = ctx.measureText(label);
    const labelH = 12 * (viewport.scale || 1);
    ctx.fillStyle = 'rgba(58, 90, 64, 0.85)';
    ctx.fillRect(x, Math.max(0, y - labelH), metrics.width + 8, labelH);
    ctx.fillStyle = '#fcfbf7';
    ctx.fillText(label, x + 4, Math.max(0, y - labelH) + 2);
  }
  ctx.restore();
}

function paintMode(root) {
  const shell = q('#fmShell', root);
  shell.dataset.mode = state.mode;
  qa('[data-mode-btn]', root).forEach((node) => {
    const on = node.dataset.modeBtn === state.mode;
    node.classList.toggle('is-on', on);
    node.setAttribute('aria-pressed', String(on));
  });
  qa('[data-fm-panel]', root).forEach((panel) => {
    panel.hidden = panel.dataset.fmPanel !== state.mode;
  });
  paintOptionsRow(root);
  if (state.mode === 'add') paintPreview(root);

  // update side note
  const note = q('#fmSideNote', root);
  if (note) note.textContent = state.buffer ? `${state.name} · ${state.pageCount} pages` : 'Nothing open yet';
  const stat = q('#fmStat', root);
  if (stat) stat.textContent = state.buffer ? `${state.pageCount} pages` : 'no file';

  // mode-specific hints
  const addHint = q('#fmAddHint', root);
  if (addHint) addHint.textContent = state.buffer ? 'Pick a type, type a name, then click on the page to place it.' : 'Open a PDF to start placing fields.';
  const readHint = q('#fmReadHint', root);
  if (readHint) readHint.textContent = state.buffer ? 'Fields found in this PDF are listed below.' : 'Open a PDF to read its fields.';
  const fillHint = q('#fmFillHint', root);
  if (fillHint) fillHint.textContent = state.buffer ? 'Type answers below; they will be written into the file.' : 'Open a PDF with form fields to start filling.';

  if (state.mode === 'read') paintReadList(root);
  // fill-mode: paintFillList lands in the next commit
}

function paintOptionsRow(root) {
  const row = q('#fmOptionsRow', root);
  if (!row) return;
  const t = state.form.newFieldType;
  row.hidden = !(t === 'radio' || t === 'dropdown');
  // also reflect in the name placeholder
  const nameInput = q('#fmNewName', root);
  if (nameInput && !nameInput.value) {
    nameInput.placeholder = t === 'text' ? 'e.g. applicant.fullName' : t === 'checkbox' ? 'e.g. terms.accepted' : t === 'radio' ? 'e.g. choice.yesNo' : 'e.g. country.select';
  }
}

/* -------------------------------------------------- add-mode ---- */
function defaultDims(type) {
  if (type === 'checkbox') return { w: 14, h: 14 };
  if (type === 'radio') return { w: 14, h: 14 };
  if (type === 'dropdown') return { w: 160, h: 22 };
  return { w: 160, h: 22 };
}

function placeFieldAt(pdfX, pdfY, root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  const name = (state.form.newFieldName || '').trim();
  if (!name) { toast('Give the field a name first'); return; }
  if (state.staged.some((f) => f.name === name)) { toast(`A field named "${name}" is already staged`); return; }
  const type = state.form.newFieldType;
  const page = state._previewPage || Number(state.form.newFieldPage) || 1;
  const dims = defaultDims(type);
  const field = {
    type,
    name,
    page,
    x: pdfX,
    y: pdfY - dims.h, // anchor at top-left
    w: dims.w,
    h: dims.h,
    options: (state.form.newFieldOptions || '').split(',').map((s) => s.trim()).filter(Boolean),
    multi: !!state.form.newFieldMulti,
  };
  state.staged.push(field);
  // auto-increment the name so the next click places a new field
  state.form.newFieldName = nextAutoName(name);
  const nameInput = q('#fmNewName', root);
  if (nameInput) nameInput.value = state.form.newFieldName;
  prefs.write(state.form);
  paintStaged(root);
  paintPreview(root);
  toast(`Placed ${type} "${field.name}" on page ${page}`);
}

function placeFieldAtCenter(root) {
  if (!state._previewBase) { toast('Open a PDF and wait for the preview'); return; }
  const { w, h } = state._previewBase;
  const dims = defaultDims(state.form.newFieldType);
  placeFieldAt((w - dims.w) / 2, (h + dims.h) / 2, root);
}

function nextAutoName(base) {
  // "applicant.fullName" -> "applicant.fullName2", ".2" -> ".3", etc.
  const m = base.match(/^(.*?)(\d+)?$/);
  const stem = m[1];
  const n = m[2] ? Number(m[2]) : 1;
  return `${stem}${n + 1}`;
}

function paintStaged(root) {
  const list = q('#fmStaged', root);
  const count = q('#fmStagedCount', root);
  if (!list) return;
  count.textContent = String(state.staged.length);
  if (state.staged.length === 0) { list.innerHTML = ''; return; }
  list.innerHTML = state.staged.map((f, i) => `
    <div class="fm-staged-row" data-i="${i}">
      <span class="fm-kind">${escapeHtml(f.type)}</span>
      <input class="text-input fm-name-input" data-i="${i}" value="${escapeHtml(f.name)}" />
      <span class="fm-page">p.${f.page}</span>
      <span class="fm-page">${Math.round(f.x)},${Math.round(f.y)}</span>
      <span class="fm-page">${Math.round(f.w)}×${Math.round(f.h)}</span>
      <button class="fm-remove" type="button" data-i="${i}" title="Remove">×</button>
    </div>
  `).join('');
  // wire rename + remove
  qa('.fm-name-input', list).forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const i = Number(e.target.dataset.i);
      const newName = e.target.value.trim();
      if (!newName) { e.target.value = state.staged[i].name; return; }
      if (state.staged.some((f, j) => j !== i && f.name === newName)) {
        toast(`A field named "${newName}" is already staged`);
        e.target.value = state.staged[i].name;
        return;
      }
      state.staged[i].name = newName;
      paintPreview(root);
    });
  });
  qa('.fm-remove', list).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const i = Number(e.target.dataset.i);
      state.staged.splice(i, 1);
      paintStaged(root);
      paintPreview(root);
    });
  });
}

async function exportAdd(root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  if (state.staged.length === 0) { toast('Place at least one field on the page first'); return; }
  const button = q('#fmAddGo', root);
  if (button) button.disabled = true;
  try {
    const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
    const pdfDoc = await PDFDocument.load(state.buffer.slice(0));
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    for (const f of state.staged) {
      const page = pages[f.page - 1];
      if (!page) continue;
      const opts = { x: f.x, y: f.y, width: f.w, height: f.h, borderColor: rgb(0.2, 0.3, 0.25), backgroundColor: rgb(0.98, 0.98, 0.95), textColor: rgb(0.1, 0.1, 0.1), borderWidth: 1, font };
      if (f.type === 'text') {
        const tf = form.createTextField(f.name);
        tf.addToPage(page, opts);
      } else if (f.type === 'checkbox') {
        const cb = form.createCheckBox(f.name);
        cb.addToPage(page, opts);
      } else if (f.type === 'dropdown') {
        const dd = form.createDropdown(f.name);
        if (f.options.length) dd.addOptions(f.options);
        dd.addToPage(page, opts);
      } else if (f.type === 'radio') {
        const rg = form.createRadioGroup(f.name);
        if (f.options.length) {
          // stack each option vertically below the first
          for (let i = 0; i < f.options.length; i++) {
            rg.addOptionToPage(f.options[i], page, { ...opts, y: opts.y - i * (opts.height + 4) });
          }
        } else {
          rg.addOptionToPage('option', page, opts);
        }
      }
    }
    const out = await pdfDoc.save();
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `with-fields-${state.name || 'document.pdf'}`);
    toast(`Wrote ${state.staged.length} field${state.staged.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error('forms: exportAdd failed', err);
    toast('Could not write the PDF — check the field names are unique');
  } finally {
    if (button) button.disabled = false;
  }
}

/* -------------------------------------------------- read-mode ---- */
async function parseReadFields(root) {
  if (!state.buffer) { state.read = []; paintReadList(root); return; }
  try {
    const { PDFDocument } = await loadPdfLib();
    const pdfDoc = await PDFDocument.load(state.buffer.slice(0), { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    const pageIndexByObj = new Map(pages.map((p, i) => [p.ref.objectNumber, i + 1]));
    const fields = form.getFields();
    state.read = fields.map((field) => {
      const widgets = field.acroField.getWidgets();
      const pageNums = widgets
        .map((w) => {
          const P = typeof w.P === 'function' ? w.P() : w.P;
          return P?.objectNumber ? pageIndexByObj.get(P.objectNumber) : null;
        })
        .filter((n) => n);
      const page = pageNums.length ? Math.min(...pageNums) : null;
      const { kind, value } = readFieldValue(field);
      return { name: field.getName(), kind, value, page };
    });
  } catch (err) {
    console.warn('forms: parseReadFields failed', err);
    state.read = [];
  }
  paintReadList(root);
}

function readFieldValue(field) {
  const cn = field.constructor.name;
  if (cn === 'PDFTextField') {
    return { kind: 'text', value: field.getText() || '' };
  }
  if (cn === 'PDFCheckBox') {
    return { kind: 'checkbox', value: field.isChecked() ? 'on' : 'off' };
  }
  if (cn === 'PDFDropdown') {
    const sel = field.getSelected();
    return { kind: 'dropdown', value: sel && sel.length ? sel.join(', ') : '' };
  }
  if (cn === 'PDFOptionList') {
    const sel = field.getSelected();
    return { kind: 'listbox', value: sel && sel.length ? sel.join(', ') : '' };
  }
  if (cn === 'PDFRadioGroup') {
    return { kind: 'radio', value: field.getSelected() || '' };
  }
  if (cn === 'PDFButton') {
    return { kind: 'button', value: '' };
  }
  if (cn === 'PDFSignature') {
    return { kind: 'signature', value: '' };
  }
  return { kind: 'unknown', value: '' };
}

function paintReadList(root) {
  const list = q('#fmReadList', root);
  if (!list) return;
  if (state.read.length === 0) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = state.read.map((f) => `
    <div class="fm-read-row">
      <span class="fm-kind">${escapeHtml(f.kind)}</span>
      <div>
        <div class="fm-name">${escapeHtml(f.name)}</div>
        <div class="fm-value">${escapeHtml(f.value || '—')}</div>
      </div>
      <span class="fm-page">${f.page ? `p.${f.page}` : ''}</span>
    </div>
  `).join('');
}

function readToJson() {
  return JSON.stringify({
    file: state.name,
    pages: state.pageCount,
    fields: state.read.map((f) => ({ name: f.name, type: f.kind, value: f.value, page: f.page })),
  }, null, 2);
}

function readToCsv() {
  const header = 'name,type,value,page';
  const escape = (s) => {
    const v = s == null ? '' : String(s);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const rows = state.read.map((f) => [f.name, f.kind, f.value, f.page ?? ''].map(escape).join(','));
  return [header, ...rows].join('\n');
}

async function copyAnswers(root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  if (state.read.length === 0) { toast('No fields to copy'); return; }
  const text = state.form.readFormat === 'csv' ? readToCsv() : readToJson();
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${state.read.length} field${state.read.length === 1 ? '' : 's'} as ${state.form.readFormat.toUpperCase()}`);
  } catch (err) {
    console.warn('clipboard write failed', err);
    toast('Could not copy — your browser blocked clipboard access');
  }
}

async function downloadAnswers(root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  if (state.read.length === 0) { toast('No fields to download'); return; }
  const text = state.form.readFormat === 'csv' ? readToCsv() : readToJson();
  const mime = state.form.readFormat === 'csv' ? 'text/csv' : 'application/json';
  const ext = state.form.readFormat;
  const base = (state.name || 'answers').replace(/\.pdf$/i, '');
  downloadBlob(new Blob([text], { type: mime }), `answers-${base}.${ext}`);
  toast(`Downloaded ${state.read.length} field${state.read.length === 1 ? '' : 's'} as ${state.form.readFormat.toUpperCase()}`);
}

/* -------------------------------------------------- fill-mode (stub) ---- */
function clearAnswers(root) {
  toast('Fill-mode reset is the next commit.');
}
async function exportFill(root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  toast('Fill-mode writer is the next commit.');
}

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
  // for add-mode: the list of fields the user is staging on each page
  draft: { page: 1, type: 'text', name: '', options: '', required: false, multi: false, x: 56, y: 56, w: 160, h: 24 },
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
        <p class="lab-help">Drop a flat PDF, then place text inputs, checkboxes, radio groups, and dropdowns on a page. The field names must be unique within the document; readers will show them to anyone filling the form.</p>

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
          <label class="field"><span class="field-label">Page</span><input class="text-input" id="fmNewPage" type="number" min="1" step="1" value="${state.draft.page}" /></label>
          <label class="field"><span class="field-label">X (pt)</span><input class="text-input" id="fmNewX" type="number" step="1" value="${state.draft.x}" /></label>
          <label class="field"><span class="field-label">Y (pt)</span><input class="text-input" id="fmNewY" type="number" step="1" value="${state.draft.y}" /></label>
          <label class="field"><span class="field-label">Width (pt)</span><input class="text-input" id="fmNewW" type="number" step="1" value="${state.draft.w}" /></label>
          <label class="field"><span class="field-label">Height (pt)</span><input class="text-input" id="fmNewH" type="number" step="1" value="${state.draft.h}" /></label>
        </div>

        <div class="lab-actions">
          <p class="lab-hint" id="fmAddHint">Open a PDF to start placing fields.</p>
          <div class="lab-actions-row">
            <button class="button button-light" type="button" id="fmAddPlace">Add to page</button>
            <button class="button button-export" type="button" id="fmAddGo">${downloadIcon}<span>Download fillable PDF</span></button>
          </div>
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

  // add-mode place + export
  q('#fmAddPlace', root)?.addEventListener('click', () => addFieldToPage(root));
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
    paintPreview(root);
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
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  paintCard(root);
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
  // TODO: render page 1 to canvas
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

  // update side note
  const note = q('#fmSideNote', root);
  if (note) note.textContent = state.buffer ? `${state.name} · ${state.pageCount} pages` : 'Nothing open yet';
  const stat = q('#fmStat', root);
  if (stat) stat.textContent = state.buffer ? `${state.pageCount} pages` : 'no file';

  // mode-specific hints
  const addHint = q('#fmAddHint', root);
  if (addHint) addHint.textContent = state.buffer ? 'Type a unique name, choose a field type, then Add to page.' : 'Open a PDF to start placing fields.';
  const readHint = q('#fmReadHint', root);
  if (readHint) readHint.textContent = state.buffer ? 'Fields found in this PDF are listed below.' : 'Open a PDF to read its fields.';
  const fillHint = q('#fmFillHint', root);
  if (fillHint) fillHint.textContent = state.buffer ? 'Type answers below; they will be written into the file.' : 'Open a PDF with form fields to start filling.';
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

/* -------------------------------------------------- add-mode (stub) ---- */
// The full add-mode implementation lands in the next commit. For now this
// just validates that the wiring is in place and shows a friendly message.
async function addFieldToPage(root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  toast('Add-field UI is wired; the writer is the next commit.');
}
async function exportAdd(root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  toast('Add-field writer is the next commit.');
}

/* -------------------------------------------------- read-mode (stub) ---- */
async function copyAnswers(root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  toast('Read-answers parser is the next commit.');
}
async function downloadAnswers(root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  toast('Read-answers parser is the next commit.');
}

/* -------------------------------------------------- fill-mode (stub) ---- */
function clearAnswers(root) {
  toast('Fill-mode reset is the next commit.');
}
async function exportFill(root) {
  if (!state.buffer) { toast('Open a PDF first'); return; }
  toast('Fill-mode writer is the next commit.');
}

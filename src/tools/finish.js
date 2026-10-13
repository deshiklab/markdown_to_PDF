/* Finish — the last touches a PDF needs before it goes out: document fields,
   page numbers and footer stamps, blacking out what must not be read, and a
   checksum to prove the file is the one you sent. pdf-lib does the writing and
   pdf.js does the reading, both inside this tab. */
import {
  bytes,
  debounce,
  downloadBlob,
  el,
  emptyState,
  escapeHtml,
  hasFiles,
  loadPdfJs,
  loadPdfLib,
  openPdfDocument,
  parsePageRanges,
  pickFiles,
  q,
  qa,
  store,
  toast,
} from '../lib.js';
import { printButton } from '../page.js';

const MODES = [
  { id: 'meta', label: 'Document fields', note: 'Title, author, dates' },
  { id: 'numbers', label: 'Page numbers', note: 'Footers and stamps' },
  { id: 'redact', label: 'Black out', note: 'Cover or destroy terms' },
  { id: 'hash', label: 'Checksum', note: 'Prove which file this is' },
];

const POSITIONS = ['top-left', 'top-center', 'top-right', 'middle-left', 'centre', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];

const FIELDS = [
  { key: 'title', label: 'Title', get: 'getTitle', set: 'setTitle', placeholder: 'Shown in readers and search results' },
  { key: 'author', label: 'Author', get: 'getAuthor', set: 'setAuthor', placeholder: 'Who wrote it' },
  { key: 'subject', label: 'Subject', get: 'getSubject', set: 'setSubject', placeholder: 'What it is about' },
  { key: 'keywords', label: 'Keywords', get: 'getKeywords', set: 'setKeywords', placeholder: 'comma, separated, list' },
  { key: 'creator', label: 'Creator app', get: 'getCreator', set: 'setCreator', placeholder: 'The tool that made the text' },
  { key: 'producer', label: 'Producer', get: 'getProducer', set: 'setProducer', placeholder: 'The library that wrote the file' },
];

const defaults = {
  mode: 'meta',
  stamp: 'Page {page} of {total}',
  position: 'bottom-center',
  stampSize: 9,
  stampMargin: 28,
  stampStart: 1,
  stampRange: '',
  stampFirst: true,
  stampStyle: 'plain',
  stampColour: '#3d4a40',
  terms: '',
  wholeWord: false,
  ignoreCase: true,
  redactColour: '#000000',
  redactPad: 2,
  redactRange: '',
  flatten: false,
  algo: 'SHA-256',
};

const prefs = store('finish:v1', defaults);

const state = {
  mode: prefs.read().mode,
  form: { ...prefs.read() },
  buffer: null,
  name: '',
  size: 0,
  pageCount: 0,
  version: '',
  encrypted: false,
  meta: null,
  matches: [],
  hash: '',
  busy: false,
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
  const form = state.form;
  return `
<div class="lab-shell fn-shell" id="fnShell" data-mode="${state.mode}">
  <section class="panel fn-side" aria-labelledby="fn-side-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">01</span>
        <div><h3 id="fn-side-title">One PDF</h3><p id="fnSideNote">Nothing open yet</p></div>
      </div>
      <div class="panel-header-actions"><button class="button button-light" type="button" id="fnClear"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.2 6.2l7.6 7.6m0-7.6-7.6 7.6"/></svg><span>Clear</span></button></div>
    </div>

    <div class="lab-drop" id="fnDrop" role="button" tabindex="0" aria-label="Choose a PDF to finish">
      <span class="dropzone-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h5.2l3.3 3.3v9.7H6z"/><path d="M11 3.6v3.3h3.2M8.4 11h4M8.4 13.2h2.6"/></svg></span>
      <strong>Drop a PDF</strong>
      <span>or click to choose — read and rewritten in this tab</span>
      <span class="dropzone-button">Choose file</span>
    </div>

    <div id="fnCard" class="fn-card"></div>
    <div class="fn-preview" id="fnPreview" data-print-root hidden>
      <canvas id="fnCanvas" aria-label="Top of page one with the current edits drawn on"></canvas>
      <p class="fn-preview-note" id="fnPreviewNote">page 1 · live preview of this tab's edits</p>
    </div>
  </section>

  <section class="panel fn-main" aria-labelledby="fn-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="fn-main-title">Finish it</h3><p><span class="live-dot"></span> Nothing is uploaded — you download a new file</p></div>
      </div>
      <div class="panel-header-actions">${printButton()}<span class="lab-count" id="fnStat">no file</span></div>
    </div>

    <div class="lab-modes" role="group" aria-label="Finish mode">
      ${MODES.map((mode) => `<button type="button" class="lab-mode${state.mode === mode.id ? ' is-on' : ''}" data-mode-btn="${mode.id}" aria-pressed="${state.mode === mode.id}"><strong>${mode.label}</strong><small>${mode.note}</small></button>`).join('')}
    </div>

    <div class="lab-body">
      <div class="fn-stage" data-fn-panel="meta">
        <p class="lab-help">These are the fields a reader or file manager shows you. Empty means “leave the file as it is”, and <strong>Clear everything</strong> wipes them so the PDF stops leaking the author’s word-count metadata.</p>
        <div class="fn-meta-grid" id="fnMetaGrid">
          ${FIELDS.map((field) => `<label class="field"><span class="field-label">${field.label}</span><input class="text-input" id="fnMeta-${field.key}" type="text" placeholder="${field.placeholder}" autocomplete="off" /></label>`).join('')}
          <label class="field"><span class="field-label">Created</span><input class="text-input" id="fnMeta-created" type="datetime-local" step="1" /></label>
          <label class="field"><span class="field-label">Modified</span><input class="text-input" id="fnMeta-modified" type="datetime-local" step="1" /></label>
        </div>
        <div class="lab-actions">
          <p class="lab-hint" id="fnMetaHint">Open a PDF to read its current fields.</p>
          <div class="lab-actions-row">
            <button class="button button-light" type="button" id="fnMetaClear">Clear everything</button>
            <button class="button button-export" type="button" id="fnMetaGo">${downloadIcon}<span>Save with new fields</span></button>
          </div>
        </div>
      </div>

      <div class="fn-stage" data-fn-panel="numbers" hidden>
        <p class="lab-help">Tokens: <code>{page}</code> <code>{total}</code> <code>{title}</code> <code>{date}</code> — text is drawn with a standard font, so it covers Latin script.</p>
        <div class="lab-row">
          <label class="field grow"><span class="field-label">Footer text</span>
            <div class="fn-token-row"><input class="text-input" id="fnStampText" type="text" value="${escapeHtml(form.stamp)}" autocomplete="off" />
              <div class="fn-chips" role="group" aria-label="Presets">
                <button class="button button-text" type="button" data-stamp-preset="Page {page} of {total}">Page N of M</button>
                <button class="button button-text" type="button" data-stamp-preset="{page}">Just the number</button>
                <button class="button button-text" type="button" data-stamp-preset="Draft · {date}">Draft + date</button>
              </div>
            </div>
          </label>
        </div>
        <div class="fn-numbers-grid">
          <div class="field">
            <span class="field-label">Placement</span>
            <div class="lab-pos-grid" role="group" aria-label="Stamp position">
              ${POSITIONS.map((position) => `<button type="button" class="lab-pos${form.position === position ? ' is-on' : ''}" data-position="${position}" title="${position.replace(/-/g, ' ')}" aria-label="${position.replace(/-/g, ' ')}" aria-pressed="${form.position === position}"><span></span></button>`).join('')}
            </div>
          </div>
          <div class="fn-numbers-fields">
            <label class="field"><span class="field-label">Size</span><input class="text-input" id="fnStampSize" type="number" min="5" max="60" step="0.5" value="${form.stampSize}" /></label>
            <label class="field"><span class="field-label">Margin</span><input class="text-input" id="fnStampMargin" type="number" min="4" max="160" step="1" value="${form.stampMargin}" /></label>
            <label class="field"><span class="field-label">Start numbering at</span><input class="text-input" id="fnStampStart" type="number" min="0" max="9999" step="1" value="${form.stampStart}" /></label>
            <label class="field"><span class="field-label">Pages</span><input class="text-input" id="fnStampRange" type="text" placeholder="all, or 2-5,8" value="${escapeHtml(form.stampRange)}" autocomplete="off" /></label>
            <label class="field field-switch"><input type="checkbox" class="switch-input" id="fnStampFirst" ${form.stampFirst ? 'checked' : ''} /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Stamp the first page too</span></label>
            <label class="field"><span class="field-label">Colour</span><span class="colour-wrap"><input class="colour-input" id="fnStampColour" type="color" value="${form.stampColour}" /><code id="fnStampColourOut">${form.stampColour}</code></span></label>
          </div>
        </div>
        <div class="lab-actions">
          <p class="lab-hint" id="fnStampHint">—</p>
          <button class="button button-export" type="button" id="fnStampGo">${downloadIcon}<span>Add the stamps</span></button>
        </div>
      </div>

      <div class="fn-stage" data-fn-panel="redact" hidden>
        <p class="lab-help">One term per line (or comma separated). Folio finds every match in the text layer and paints over it. <strong>Flatten the page to an image</strong> also removes the underlying characters, so the text is really gone — that one is a true redaction.</p>
        <label class="field"><span class="field-label">Terms to cover</span><textarea class="tr-paste" id="fnTerms" rows="3" placeholder="patient name&#10;ACME Corp&#10;01234 567 890" aria-label="Terms to black out">${escapeHtml(form.terms)}</textarea></label>
        <div class="fn-redact-grid">
          <label class="field"><span class="field-label">Pages</span><input class="text-input" id="fnRedactRange" type="text" placeholder="all, or 1-3,7" value="${escapeHtml(form.redactRange)}" autocomplete="off" /></label>
          <label class="field"><span class="field-label">Ink</span><span class="colour-wrap"><input class="colour-input" id="fnRedactColour" type="color" value="${form.redactColour}" /><code id="fnRedactColourOut">${form.redactColour}</code></span></label>
          <label class="field"><span class="field-label">Padding</span><input class="text-input" id="fnRedactPad" type="number" min="0" max="14" step="0.5" value="${form.redactPad}" /></label>
          <label class="field field-switch"><input type="checkbox" class="switch-input" id="fnIgnoreCase" ${form.ignoreCase ? 'checked' : ''} /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Ignore case</span></label>
          <label class="field field-switch"><input type="checkbox" class="switch-input" id="fnWholeWord" ${form.wholeWord ? 'checked' : ''} /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Whole words only</span></label>
          <label class="field field-switch"><input type="checkbox" class="switch-input" id="fnFlatten" ${form.flatten ? 'checked' : ''} /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Flatten page to image</span></label>
        </div>
        <div class="fn-findings" id="fnFindings" hidden></div>
        <div class="lab-actions">
          <p class="lab-hint" id="fnRedactHint">Type a term to see how many hits there are.</p>
          <button class="button button-export" type="button" id="fnRedactGo">${downloadIcon}<span>Black out and save</span></button>
        </div>
      </div>

      <div class="fn-stage" data-fn-panel="hash" hidden>
        <p class="lab-help">A hash is a fingerprint of the exact bytes. Quote it when you send a file and anyone can confirm the copy they got is the same one — no upload, no third party.</p>
        <div class="lab-modes fn-algo" role="group" aria-label="Hash algorithm">
          ${['SHA-256', 'SHA-1', 'SHA-512'].map((algo) => `<button type="button" class="lab-mode${state.form.algo === algo ? ' is-on' : ''}" data-algo="${algo}" aria-pressed="${state.form.algo === algo}"><strong>${algo}</strong></button>`).join('')}
        </div>
        <label class="field"><span class="field-label" id="fnHashLabel">Digest</span>
          <textarea class="tr-paste fn-hash-value" id="fnHashValue" rows="3" readonly aria-labelledby="fnHashLabel" placeholder="Open a PDF and the digest appears here"></textarea>
        </label>
        <div class="lab-actions-row fn-hash-actions">
          <button class="button button-light" type="button" id="fnHashCopy">Copy digest</button>
          <button class="button button-light" type="button" id="fnHashSave">${downloadIcon}<span>Save sidecar</span></button>
        </div>
        <label class="field"><span class="field-label">Compare with a digest you were given</span><input class="text-input" id="fnHashVerify" type="text" placeholder="paste 64 hex characters" autocomplete="off" spellcheck="false" /></label>
        <p class="lab-hint" id="fnHashHint">No file open.</p>
      </div>
    </div>
  </section>
</div>`;
}

/* ---------------------------------------------------------------- wiring ---- */
function wire(root) {
  const save = debounce(() => prefs.write(state.form), 250);
  const bind = (id, key, cast = (value) => value, after) => {
    const node = q(`#${id}`, root);
    if (!node) return;
    const handler = () => {
      state.form[key] = cast(node.type === 'checkbox' ? node.checked : node.value);
      save();
      after?.();
    };
    node.addEventListener('input', handler);
    node.addEventListener('change', handler);
  };

  bind('fnStampText', 'stamp', undefined, () => paintStampHint(root));
  bind('fnStampSize', 'stampSize', Number, () => repaintPreview(root));
  bind('fnStampMargin', 'stampMargin', Number, () => paintStampHint(root));
  bind('fnStampStart', 'stampStart', Number, () => paintStampHint(root));
  bind('fnStampRange', 'stampRange');
  bind('fnStampFirst', 'stampFirst', undefined, () => paintStampHint(root));
  bind('fnStampColour', 'stampColour', undefined, () => {
    q('#fnStampColourOut', root).textContent = state.form.stampColour;
    repaintPreview(root);
  });
  bind('fnTerms', 'terms', undefined, () => {
    findMatches(root);
  });
  bind('fnRedactRange', 'redactRange', undefined, () => findMatches(root));
  bind('fnRedactColour', 'redactColour', undefined, () => {
    q('#fnRedactColourOut', root).textContent = state.form.redactColour;
    repaintPreview(root);
  });
  bind('fnRedactPad', 'redactPad', Number, () => repaintPreview(root));
  bind('fnIgnoreCase', 'ignoreCase', undefined, () => findMatches(root));
  bind('fnWholeWord', 'wholeWord', undefined, () => findMatches(root));
  bind('fnFlatten', 'flatten');

  qa('[data-mode-btn]', root).forEach((node) => {
    node.addEventListener('click', () => {
      state.mode = node.dataset.modeBtn;
      state.form.mode = state.mode;
      save();
      paintMode(root);
    });
  });
  qa('[data-stamp-preset]', root).forEach((node) => {
    node.addEventListener('click', () => {
      state.form.stamp = node.dataset.stampPreset;
      q('#fnStampText', root).value = state.form.stamp;
      save();
      paintStampHint(root);
    });
  });
  qa('.lab-pos', root).forEach((node) => {
    node.addEventListener('click', () => {
      state.form.position = node.dataset.position;
      save();
      qa('.lab-pos', root).forEach((other) => {
        const on = other === node;
        other.classList.toggle('is-on', on);
        other.setAttribute('aria-pressed', String(on));
      });
      paintStampHint(root);
    });
  });
  qa('[data-algo]', root).forEach((node) => {
    node.addEventListener('click', () => {
      state.form.algo = node.dataset.algo;
      save();
      qa('[data-algo]', root).forEach((other) => {
        const on = other === node;
        other.classList.toggle('is-on', on);
        other.setAttribute('aria-pressed', String(on));
      });
      computeHash(root);
    });
  });

  const zone = q('#fnDrop', root);
  zone.addEventListener('click', async () => {
    const [file] = await pickFiles({ accept: 'application/pdf', multiple: false });
    if (file) loadFile(file, root);
  });
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      zone.click();
    }
  });
  zone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    zone.classList.remove('is-dragging');
    const [file] = Array.from(event.dataTransfer?.files || []);
    if (file) loadFile(file, root);
    else toast('Drop a PDF file.', true);
  });

  q('#fnClear', root)?.addEventListener('click', () => {
    state.buffer = null;
    state.name = '';
    state.matches = [];
    state.hash = '';
    root.classList.remove('has-input');
    paintCard(root);
    paintMode(root);
    const hash = q('#fnHashValue', root);
    if (hash) hash.value = '';
    toast('Panel cleared. Your file was never anywhere but here.');
  });

  q('#fnMetaGo', root)?.addEventListener('click', () => saveMeta(root));
  q('#fnMetaClear', root)?.addEventListener('click', () => clearMetaFields(root));
  q('#fnStampGo', root)?.addEventListener('click', () => addStamps(root));
  q('#fnRedactGo', root)?.addEventListener('click', () => blackOut(root));
  q('#fnHashCopy', root)?.addEventListener('click', async () => {
    if (!state.hash) return toast('Open a PDF first.', true);
    try {
      await navigator.clipboard.writeText(`${state.hash}  ${state.name}`);
      toast('Digest and filename copied.');
    } catch (error) {
      toast('Your browser blocked the clipboard — select the text instead.', true);
    }
  });
  q('#fnHashSave', root)?.addEventListener('click', () => {
    if (!state.hash) return toast('Open a PDF first.', true);
    const ext = state.form.algo.toLowerCase().replace('sha-', 'sha');
    downloadBlob(new Blob([`${state.hash}  ${state.name}\n`], { type: 'text/plain' }), `${fileNameWithoutExtension(state.name)}.${ext}sum`);
  });
  q('#fnHashVerify', root)?.addEventListener('input', (event) => compareHash(event.target.value, root));

  paintMode(root);
  paintStampHint(root);
}

/* ----------------------------------------------------------- file intake ---- */
async function loadFile(file, root) {
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
    toast('That was not a PDF.', true);
    return;
  }
  state.name = file.name;
  state.size = file.size;
  state.buffer = await file.arrayBuffer();
  state.hash = '';
  state.matches = [];
  root.classList.add('has-input');
  await readMeta(root);
  paintCard(root);
  await computeHash(root);
  paintStampHint(root);
  findMatches(root);
  renderPreview(root);
}

function fileNameWithoutExtension(name) {
  return String(name || 'document').replace(/\.pdf$/i, '');
}

async function readMeta(root) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.load(state.buffer.slice(0), { ignoreEncryption: true, updateMetadata: false });
  state.pageCount = doc.getPageCount();
  state.encrypted = Boolean(doc.isEncrypted);
  const head = new TextDecoder('latin1').decode(new Uint8Array(state.buffer.slice(0, 16)));
  state.version = (/^%PDF-(\d+\.\d+)/.exec(head) || [])[1] ?? '';
  const meta = {};
  for (const field of FIELDS) {
    meta[field.key] = doc[field.get]() ?? '';
  }
  const created = doc.getCreationDate();
  const modified = doc.getModificationDate();
  meta.created = toLocalInput(created);
  meta.modified = toLocalInput(modified);
  state.meta = meta;
  for (const field of FIELDS) {
    const node = q(`#fnMeta-${field.key}`, root);
    if (node) node.value = meta[field.key];
  }
  const createdNode = q('#fnMeta-created', root);
  const modifiedNode = q('#fnMeta-modified', root);
  if (createdNode) createdNode.value = meta.created;
  if (modifiedNode) modifiedNode.value = meta.modified;
  const hint = q('#fnMetaHint', root);
  const sizeText = state.pageCount ? ` · page size ${fmtSize(doc.getPage(0).getSize())}` : ' · this file reports no pages';
  const filled = FIELDS.filter((field) => meta[field.key]).length;
  if (hint) hint.textContent = filled ? `${filled} of ${FIELDS.length} fields are set${sizeText}` : `No document fields are set in this file${sizeText}.`;
  const stat = q('#fnStat', root);
  if (stat) stat.textContent = `${state.pageCount} pages · PDF ${state.version || '?'}`;
}

function fmtSize({ width, height }) {
  return `${Math.round(width)}×${Math.round(height)} pt`;
}

function toLocalInput(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function paintCard(root) {
  const card = q('#fnCard', root);
  const note = q('#fnSideNote', root);
  if (!card) return;
  if (!state.buffer) {
    card.replaceChildren(emptyState({ title: 'No file open', note: 'Pick a PDF and its fields, pages and digest appear here.' }));
    if (note) note.textContent = 'Nothing open yet';
    const preview = q('#fnPreview', root);
    if (preview) preview.hidden = true;
    return;
  }
  const chips = [
    `${state.pageCount} ${state.pageCount === 1 ? 'page' : 'pages'}`,
    bytes(state.size),
    state.version ? `PDF ${state.version}` : '',
    state.encrypted ? 'encrypted' : '',
  ].filter(Boolean);
  card.replaceChildren(
    el('div', { class: 'fn-card-row' }, [
      el('div', { class: 'fn-card-name', text: state.name, title: state.name }),
      el('a', { class: 'button button-light', href: '#', text: 'Replace', onclick: (event) => { event.preventDefault(); q('#fnDrop', root)?.click(); } }),
    ]),
    el('div', { class: 'fn-chip-row' }, chips.map((chip) => el('span', { class: 'fn-chip', text: chip }))),
  );
  if (note) note.textContent = 'Fields, footers and redactions read from this file';
}

/* ------------------------------------------------------------ mode swap ---- */
function paintMode(root) {
  const shell = q('#fnShell', root);
  shell.dataset.mode = state.mode;
  qa('[data-mode-btn]', root).forEach((node) => {
    const on = node.dataset.modeBtn === state.mode;
    node.classList.toggle('is-on', on);
    node.setAttribute('aria-pressed', String(on));
  });
  qa('[data-fn-panel]', root).forEach((panel) => {
    panel.hidden = panel.dataset.fnPanel !== state.mode;
  });
  const preview = q('#fnPreview', root);
  if (preview) preview.hidden = state.mode === 'meta' || state.mode === 'hash' || !state.buffer;
  if (state.buffer) {
    paintCard(root);
    renderPreview(root);
  }
}

/* ------------------------------------------------------------- metadata ---- */
function clearMetaFields(root) {
  for (const field of FIELDS) {
    const node = q(`#fnMeta-${field.key}`, root);
    if (node) node.value = '';
  }
  toast('Fields emptied — press Save with new fields to write it.');
}

async function saveMeta(root) {
  if (!state.buffer) return toast('Open a PDF first.', true);
  await withBusy(root, '#fnMetaGo', 'Writing…', async () => {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.load(state.buffer.slice(0), { ignoreEncryption: true, updateMetadata: false });
    for (const field of FIELDS) {
      const value = String(q(`#fnMeta-${field.key}`, root)?.value ?? '').trim();
      if (field.key === 'keywords') doc.setKeywords(value ? value.split(/[,\n]/).map((word) => word.trim()).filter(Boolean) : []);
      else doc[field.set](value);
    }
    for (const key of ['created', 'modified']) {
      const raw = String(q(`#fnMeta-${key}`, root)?.value ?? '');
      if (!raw) continue;
      const date = new Date(raw);
      if (!Number.isNaN(date.getTime())) {
        if (key === 'created') doc.setCreationDate(date);
        else doc.setModificationDate(date);
      }
    }
    const out = await doc.save({ useObjectStreams: false });
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${fileNameWithoutExtension(state.name)}-fields.pdf`);
    state.buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    state.size = out.byteLength;
    await readMeta(root);
    await computeHash(root);
    toast('Document fields written. Check the fields again to see them.');
  });
}

/* --------------------------------------------------------- page numbers ---- */
function stampLines(pageIndex) {
  const total = state.pageCount || 1;
  const number = pageIndex + Number(state.form.stampStart || 0);
  const title = (state.meta?.title || fileNameWithoutExtension(state.name) || '').trim();
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return String(state.form.stamp || '{page}')
    .replace(/\{page\}/gi, String(number))
    .replace(/\{total\}/gi, String(total))
    .replace(/\{title\}/gi, title)
    .replace(/\{date\}/gi, date);
}

function paintStampHint(root) {
  const hint = q('#fnStampHint', root);
  if (!hint) return;
  if (!state.buffer) {
    hint.textContent = 'Open a PDF to place the stamp on real page sizes.';
    return;
  }
  const sample = stampLines(state.form.stampFirst ? 0 : 1);
  hint.innerHTML = `Page 1 would read <strong>${escapeHtml(sample || '(empty)')}</strong> · ${escapeHtml(state.form.position)} · ${state.form.stampSize}pt · ${state.form.stampMargin}pt in`;
}

async function addStamps(root) {
  if (!state.buffer) return toast('Open a PDF first.', true);
  const range = parsePageRanges(state.form.stampRange, state.pageCount);
  if (!range.ok) {
    toast('Pages need to look like 2-5,8 or "all".', true);
    return;
  }
  await withBusy(root, '#fnStampGo', 'Stamping…', async () => {
    const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
    const doc = await PDFDocument.load(state.buffer.slice(0), { ignoreEncryption: true, updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const widthOf = (text) => font.widthOfTextAtSize(text, Number(state.form.stampSize) || 9);
    const include = new Set();
    range.ranges.forEach(({ start, end }) => {
      for (let page = start; page <= end; page += 1) include.add(page - 1);
    });
    if (!state.form.stampFirst) include.delete(0);
    let done = 0;
    const colour = hexToRgb(state.form.stampColour);
    doc.getPages().forEach((page, index) => {
      if (!include.has(index)) return;
      const text = stampLines(index);
      if (!text) return;
      const { width, height } = page.getSize();
      const rot = ((page.getRotation().angle % 360) + 360) % 360;
      const landscape = rot === 90 || rot === 270;
      const size = Number(state.form.stampSize) || 9;
      const margin = Number(state.form.stampMargin) || 0;
      const textWidth = widthOf(text);
      const W = landscape ? height : width;
      const H = landscape ? width : height;
      const dx = state.form.position.includes('right') ? W - margin - textWidth : state.form.position.includes('left') ? margin : (W - textWidth) / 2;
      const dyUp = state.form.position.includes('top') ? H - margin - size : state.form.position.includes('middle') ? (H - size) / 2 : margin;
      let x = dx;
      let y = dyUp;
      let angle = 0;
      if (rot === 90) {
        x = width - dyUp;
        y = dx;
        angle = 90;
      } else if (rot === 180) {
        x = width - dx;
        y = height - dyUp;
        angle = 180;
      } else if (rot === 270) {
        x = dyUp;
        y = height - dx;
        angle = 270;
      }
      page.drawText(text, { x, y, size, font, color: rgb(...colour), rotate: degrees(angle) });
      done += 1;
    });
    const out = await doc.save({ useObjectStreams: false });
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${fileNameWithoutExtension(state.name)}-numbered.pdf`);
    toast(`${done} ${done === 1 ? 'page' : 'pages'} stamped — the file is in your downloads.`);
  });
}

function hexToRgb(hex) {
  const clean = String(hex || '#000').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
}

/* ------------------------------------------------------------- redaction ---- */
function terms() {
  return String(state.form.terms || '')
    .split(/[\n,]/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

async function collectPages(root) {
  const range = parsePageRanges(state.form.redactRange, state.pageCount);
  if (!range.ok) return { error: 'Pages need to look like 1-3,7 or "all".' };
  const include = new Set();
  range.ranges.forEach(({ start, end }) => {
    for (let page = start; page <= end; page += 1) include.add(page - 1);
  });
  return { include, range };
}

async function scanText() {
  const doc = await openPdfDocument(state.buffer.slice(0));
  const pages = [];
  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.filter((item) => typeof item.str === 'string'));
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

/* Match each term against a whole line, then map the hit back onto the text
   items so the box covers only the characters that matched. */
function findInItems(items, list, { ignoreCase, wholeWord }) {
  const hits = [];
  for (const line of groupLines(items)) {
    let text = '';
    const spans = [];
    line.forEach((item, index) => {
      if (index) text += ' ';
      const start = text.length;
      text += item.str;
      spans.push({ item, start, end: text.length });
    });
    if (!text.trim()) continue;
    for (const term of list) {
      const pattern = wholeWord ? `\\b${escapeRegExp(term)}\\b` : escapeRegExp(term);
      const re = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
      let match = re.exec(text);
      while (match) {
        const from = match.index;
        const to = from + match[0].length;
        const rects = spans
          .filter((span) => span.end > from && span.start < to)
          .map((span) => charRect(span.item, span, from, to));
        if (rects.length) hits.push({ term, rects, text: match[0] });
        if (re.lastIndex === from) re.lastIndex += 1;
        match = re.exec(text);
      }
    }
  }
  return hits;
}

function charRect(item, span, from, to) {
  const x = item.transform[4];
  const y = item.transform[5];
  const length = Math.max(1, span.end - span.start);
  const scale = item.str.length ? item.width / item.str.length : length;
  const left = Math.max(from, span.start) - span.start;
  const right = Math.min(to, span.end) - span.start;
  const height = (item.height || 10) * 0.94;
  return {
    x: x + left * scale,
    y,
    width: Math.max(2, (right - left) * scale),
    height: Math.max(5, height),
  };
}

/* pdf.js hands back one item per run of glyphs; stitch runs that share a
   baseline into lines so a phrase can be matched across them. */
function groupLines(items) {
  const lines = [];
  let current = [];
  let lastY = null;
  for (const item of items) {
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > Math.max(2, (item.height || 10) * 0.45)) {
      if (current.length) lines.push(current);
      current = [];
    }
    current.push(item);
    lastY = y;
    if (item.hasEOL) {
      if (current.length) lines.push(current);
      current = [];
      lastY = null;
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findMatches(root) {
  const box = q('#fnFindings', root);
  const hint = q('#fnRedactHint', root);
  if (!box) return;
  const list = terms();
  if (!state.buffer || !list.length) {
    box.hidden = true;
    state.matches = [];
    if (hint) hint.textContent = state.buffer ? 'Type a term to see how many hits there are.' : 'Open a PDF, then list the words to cover.';
    repaintPreview(root);
    return;
  }
  if (hint) hint.textContent = 'Scanning the text layer…';
  try {
    const pages = await scanText();
    const { include, error } = await collectPages(root);
    if (error) {
      if (hint) { hint.textContent = error; hint.classList.add('is-error'); }
      return;
    }
    const perTerm = new Map(list.map((term) => [term, { count: 0, pages: new Set() }]));
    const matches = [];
    pages.forEach((items, index) => {
      if (!include.has(index)) return;
      const hits = findInItems(items, list, { ignoreCase: state.form.ignoreCase, wholeWord: state.form.wholeWord });
      for (const hit of hits) {
        perTerm.get(hit.term).count += 1;
        perTerm.get(hit.term).pages.add(index + 1);
        matches.push({ page: index, ...hit });
      }
    });
    state.matches = matches;
    box.hidden = false;
    box.replaceChildren(
      ...list.map((term) => {
        const found = perTerm.get(term);
        const pagesText = [...found.pages].slice(0, 6).join(', ');
        return el('div', { class: `fn-finding${found.count ? ' is-hit' : ''}` }, [
          el('span', { class: 'fn-finding-term', text: term }),
          el('span', { class: 'fn-finding-count', text: found.count ? `${found.count}×` : 'no match' }),
          el('span', { class: 'fn-finding-pages', text: found.count ? `p. ${pagesText}${found.pages.size > 6 ? '…' : ''}` : '' }),
        ]);
      }),
    );
    if (hint) {
      hint.classList.remove('is-error');
      hint.textContent = `${matches.length} ${matches.length === 1 ? 'spot' : 'spots'} across ${new Set(matches.map((match) => match.page + 1)).size} page${new Set(matches.map((match) => match.page + 1)).size === 1 ? '' : 's'} · ${state.form.flatten ? 'pages will be flattened, so the characters are gone' : 'ink only — the text layer still holds the words unless you flatten'}`;
    }
    repaintPreview(root);
  } catch (error) {
    console.error(error);
    if (hint) { hint.textContent = `The text layer could not be read: ${error?.message ?? error}`; hint.classList.add('is-error'); }
  }
}

async function blackOut(root) {
  if (!state.buffer) return toast('Open a PDF first.', true);
  const list = terms();
  if (!list.length) return toast('Add at least one term to cover.', true);
  if (!state.matches.length) return toast('Nothing matched those terms — try a looser spelling.', true);
  await withBusy(root, '#fnRedactGo', state.form.flatten ? 'Flattening…' : 'Covering…', async () => {
    const { PDFDocument, rgb } = await loadPdfLib();
    const doc = await PDFDocument.load(state.buffer.slice(0), { ignoreEncryption: true, updateMetadata: false });
    const ink = hexToRgb(state.form.redactColour);
    const pad = Number(state.form.redactPad) || 0;
    const pages = doc.getPages();
    for (const match of state.matches) {
      const page = pages[match.page];
      if (!page) continue;
      for (const rect of match.rects) {
        page.drawRectangle({
          x: rect.x - pad,
          y: rect.y - pad - (rect.height - 1.2),
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
          color: rgb(...ink),
          borderWidth: 0,
        });
      }
    }
    let out = await doc.save({ useObjectStreams: false });
    if (state.form.flatten) {
      out = await flattenPages(out, state.matches.map((match) => match.page));
    }
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${fileNameWithoutExtension(state.name)}${state.form.flatten ? '-redacted' : '-covered'}.pdf`);
    state.buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    state.size = out.byteLength;
    await findMatches(root);
    await computeHash(root);
    toast(state.form.flatten ? 'Redacted for real — those pages are images now.' : 'Covered. Tick “Flatten page to image” if the text must be gone.');
  });
}

async function flattenPages(pdfBytes, pageIndexes) {
  const { PDFDocument } = await loadPdfLib();
  const pdfjs = await loadPdfJs();
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const view = await pdfjs.getDocument({ data: pdfBytes.slice(0), isEvalSupported: false }).promise;
  const flat = new Set(pageIndexes);
  const out = await PDFDocument.create();
  for (const [get, set] of [['getTitle', 'setTitle'], ['getAuthor', 'setAuthor'], ['getSubject', 'setSubject'], ['getCreator', 'setCreator'], ['getProducer', 'setProducer']]) {
    const value = src[get]();
    if (value) out[set](value);
  }
  const keywords = src.getKeywords();
  if (keywords) out.setKeywords(String(keywords).split(',').map((word) => word.trim()).filter(Boolean));
  for (const [get, set] of [['getCreationDate', 'setCreationDate'], ['getModificationDate', 'setModificationDate']]) {
    const date = src[get]();
    if (date) out[set](date);
  }
  for (let index = 0; index < src.getPageCount(); index += 1) {
    if (!flat.has(index)) {
      const [copied] = await out.copyPages(src, [index]);
      out.addPage(copied);
      continue;
    }
    const page = await view.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(2, 1600 / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const binary = atob(dataUrl.split(',')[1]);
    const raw = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) raw[i] = binary.charCodeAt(i);
    const image = await out.embedJpg(raw);
    const size = src.getPage(index).getSize();
    const newPage = out.addPage([size.width, size.height]);
    newPage.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
    page.cleanup();
  }
  await view.destroy();
  return out.save({ useObjectStreams: false });
}

/* ------------------------------------------------------------- checksum ---- */
async function computeHash(root) {
  const box = q('#fnHashValue', root);
  const hint = q('#fnHashHint', root);
  if (!box) return;
  if (!state.buffer) {
    box.value = '';
    state.hash = '';
    if (hint) hint.textContent = 'No file open.';
    return;
  }
  if (hint) hint.textContent = 'Hashing…';
  try {
    const digest = await crypto.subtle.digest(state.form.algo, state.buffer.slice(0));
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    state.hash = hex;
    box.value = hex;
    if (hint) hint.innerHTML = `${bytes(state.size)} · <code>${escapeHtml(state.name)}</code> — quote the digest when you send the file.`;
    const verify = q('#fnHashVerify', root);
    if (verify?.value) compareHash(verify.value, root);
  } catch (error) {
    state.hash = '';
    box.value = '';
    if (hint) { hint.textContent = `The browser refused to hash this file: ${error?.message ?? error}`; hint.classList.add('is-error'); }
  }
}

function compareHash(value, root) {
  const hint = q('#fnHashHint', root);
  if (!hint) return;
  const clean = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!clean) {
    hint.classList.remove('is-error', 'is-match');
    hint.textContent = state.hash ? `${bytes(state.size)} · ${state.name} — quote the digest when you send the file.` : 'No file open.';
    return;
  }
  if (!state.hash) {
    hint.classList.add('is-error');
    hint.classList.remove('is-match');
    hint.textContent = 'Open the PDF this digest belongs to.';
    return;
  }
  const same = clean === state.hash;
  hint.classList.toggle('is-match', same);
  hint.classList.toggle('is-error', !same);
  hint.textContent = same ? 'Match — this is byte-for-byte the same file.' : 'No match. This file is not the one that digest was taken from.';
}

/* ------------------------------------------------------------- preview ---- */
async function renderPreview(root) {
  const holder = q('#fnPreview', root);
  const canvas = q('#fnCanvas', root);
  if (!holder || !canvas) return;
  if (!state.buffer || state.mode === 'meta' || state.mode === 'hash') {
    holder.hidden = true;
    return;
  }
  holder.hidden = false;
  if (state.busy) return;
  try {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: state.buffer.slice(0), isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = 240 / base.width;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    drawOverlay(context, viewport, page);
    const note = q('#fnPreviewNote', root);
    if (note) note.textContent = `page 1 · ${Math.round(base.width)}×${Math.round(base.height)} pt · ${state.pageCount || doc.numPages} pages`;
    await doc.destroy();
  } catch (error) {
    console.warn('Preview unavailable:', error);
    holder.hidden = true;
  }
}

function drawOverlay(context, viewport, page) {
  const { width, height } = page.getViewport({ scale: 1 });
  const size = Number(state.form.stampSize) || 9;
  const margin = Number(state.form.stampMargin) || 0;
  if (state.mode === 'numbers') {
    const text = stampLines(state.form.stampFirst ? 0 : 1);
    if (text) {
      const W = width;
      const H = height;
      const textWidth = text.length * size * 0.5;
      const dx = state.form.position.includes('right') ? W - margin - textWidth : state.form.position.includes('left') ? margin : (W - textWidth) / 2;
      const dyUp = state.form.position.includes('top') ? H - margin - size : state.form.position.includes('middle') ? (H - size) / 2 : margin;
      const [x, y] = viewport.convertToViewportPoint(dx, dyUp);
      context.save();
      context.globalAlpha = 0.85;
      context.fillStyle = state.form.stampColour;
      context.font = `${Math.max(7, size * (viewport.scale || 1))}px "DM Mono", monospace`;
      context.textBaseline = 'bottom';
      context.fillText(text, x, y);
      context.restore();
    }
  }
  if (state.mode === 'redact') {
    const pad = Number(state.form.redactPad) || 0;
    context.save();
    context.fillStyle = state.form.redactColour;
    for (const match of state.matches.filter((item) => item.page === 0)) {
      for (const rect of match.rects) {
        const [x1, y1] = viewport.convertToViewportPoint(rect.x - pad, rect.y + rect.height + pad);
        const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width + pad, rect.y - pad);
        context.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1) || 3, Math.abs(y2 - y1) || 3);
      }
    }
    context.restore();
  }
}

let previewTimer;
function repaintPreview(root) {
  if (!state.buffer || (state.mode !== 'numbers' && state.mode !== 'redact')) return;
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => renderPreview(root), 260);
}

/* --------------------------------------------------------------- busy ---- */
async function withBusy(root, id, label, work) {
  const button = q(id, root);
  if (!button) return;
  if (state.busy) return;
  state.busy = true;
  const original = button.innerHTML;
  button.disabled = true;
  button.classList.add('is-busy');
  button.innerHTML = `<span class="export-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
  try {
    await work();
  } catch (error) {
    console.error(error);
    toast(error?.message || 'That did not work — the message is in the console.', true);
  } finally {
    state.busy = false;
    button.disabled = false;
    button.innerHTML = original;
    button.classList.remove('is-busy');
  }
}

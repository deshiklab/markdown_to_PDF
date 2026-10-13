/* PDF Lab — merge, reorder, split, rotate and watermark PDFs. Everything is
   done locally with pdf-lib; thumbnails come from pdf.js when available. */
import {
  bytes,
  debounce,
  downloadBlob,
  el,
  emptyState,
  escapeHtml,
  hasFiles,
  isFileProtocol,
  loadPdfJs,
  loadPdfLib,
  openPdfDocument,
  makeZip,
  parsePageRanges,
  pickFiles,
  q,
  qa,
  rangeLabel,
  safeFileName,
  store,
  toast,
} from '../lib.js';
import { page, printButton } from '../page.js';

const MODES = [
  { id: 'merge', label: 'Merge & order', note: 'One file from many' },
  { id: 'split', label: 'Split & extract', note: 'Pages out of one file' },
  { id: 'watermark', label: 'Watermark', note: 'Stamp text on pages' },
  { id: 'margins', label: 'Frame & trim', note: 'Real page margins' },
];
/* 72 pt to the inch: pdf-lib works in points, the controls in whatever the
   reader thinks in. */
const MM_PER_UNIT = { mm: 1, in: 25.4, pt: 25.4 / 72 };

const POSITIONS = ['top-left', 'top-center', 'top-right', 'middle-left', 'centre', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];

const defaults = {
  mode: 'merge',
  splitSource: '',
  splitStyle: 'every',
  splitEvery: 1,
  splitRanges: '',
  watermarkSource: '',
  watermarkText: 'DRAFT',
  watermarkSize: 46,
  watermarkOpacity: 18,
  watermarkAngle: 45,
  watermarkColor: '#7d9a7c',
  watermarkPosition: 'centre',
  watermarkAll: true,
  watermarkRange: '',
  mergeName: 'folio-merged',
  marginSource: '',
  marginAction: 'frame',
  marginUnit: 'mm',
  marginTop: 12,
  marginRight: 12,
  marginBottom: 12,
  marginLeft: 12,
};

const prefs = store('pdf-lab:v1', defaults);

const state = {
  sources: [],
  order: [],
  thumbsReady: false,
  busy: false,
  form: { ...prefs.read() },
};

const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';

export function start(root) {
  root.innerHTML = layout();
  const shell = q('#labShell', root);
  shell.dataset.mode = state.form.mode;

  wireDropzone(root);
  qa('[data-mode-btn]', root).forEach((node) => node.addEventListener('click', () => setMode(node.dataset.modeBtn, root)));
  q('#labClear', root)?.addEventListener('click', () => {
    state.sources = [];
    state.order = [];
    state.thumbsReady = false;
    render(root);
    toast('Cleared — nothing is kept from those files.');
  });
  q('#labPickMore', root)?.addEventListener('click', async () => {
    const files = await pickFiles({ accept: 'application/pdf,.pdf', multiple: true });
    await addFiles(files, root);
  });
  q('#labMergeGo', root)?.addEventListener('click', () => exportMerge(root));
  q('#labSplitGo', root)?.addEventListener('click', () => exportSplit(root));
  q('#labWatermarkGo', root)?.addEventListener('click', () => exportWatermark(root));
  q('#labMarginGo', root)?.addEventListener('click', () => exportMargins(root));
  qa('#labMarginUnits [data-margin-unit]', root).forEach((node) => {
    node.addEventListener('click', () => {
      const from = MM_PER_UNIT[state.form.marginUnit] ?? 1;
      const to = MM_PER_UNIT[node.dataset.marginUnit] ?? 1;
      // convert what is on screen, so 0.5in does not silently become 0.5mm
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const key = `margin${side}`;
        state.form[key] = round3((Number(state.form[key]) || 0) * from / to);
      }
      state.form.marginUnit = node.dataset.marginUnit;
      persist(root);
      paintMarginForm(root);
    });
  });
  q('#labMarginCopy', root)?.addEventListener('click', () => {
    const setup = page();
    const unit = MM_PER_UNIT[state.form.marginUnit] ?? 1;
    state.form.marginTop = round3(setup.top / unit);
    state.form.marginRight = round3(setup.right / unit);
    state.form.marginBottom = round3(setup.bottom / unit);
    state.form.marginLeft = round3(setup.left / unit);
    persist(root);
    paintMarginForm(root);
    toast(`Copied ${setup.top} / ${setup.right} / ${setup.bottom} / ${setup.left} mm from the page strip.`);
  });

  bindForm(root);
  render(root);
  return () => {};
}

/* ------------------------------------------------------------------- ui ---- */
function layout() {
  return `
<div class="lab-shell" id="labShell">
  <section class="panel lab-side" aria-labelledby="lab-side-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">01</span>
        <div><h3 id="lab-side-title">Your PDFs</h3><p id="labSideNote">Nothing is uploaded</p></div>
      </div>
      <div class="panel-header-actions">
        <button class="button button-light" type="button" id="labClear"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 6.5h9m-7.9 0 .5 9h5.8l.5-9M8 6.5V4.8h4v1.7"/></svg><span>Clear</span></button>
      </div>
    </div>
    <div class="lab-drop" id="labDrop" role="button" tabindex="0" aria-label="Add PDF files">
      <span class="dropzone-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h5.2l3.3 3.3v9.7H6z"/><path d="M11 3.6v3.3h3.2M10 8.6v4.4m0 0-1.9-1.9m1.9 1.9 1.9-1.9"/></svg></span>
      <strong>Drop PDFs here</strong>
      <span>or click to choose — merge, split, rotate, watermark</span>
      <span class="dropzone-button">Choose files</span>
    </div>
    <ul class="lab-file-list" id="labFileList" role="list"></ul>
    <div class="editor-footer lab-footer">
      <span id="labFileCount">No files yet</span>
      <button class="button button-text" type="button" id="labPickMore">Add more</button>
    </div>
  </section>

  <section class="panel lab-main" aria-labelledby="lab-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="lab-main-title">Do the thing</h3><p><span class="live-dot"></span> Preview updates as you edit</p></div>
      </div>
      <div class="panel-header-actions">${printButton()}<span class="lab-count" id="labPageCount">—</span></div>
    </div>

    <div class="lab-modes" role="group" aria-label="PDF Lab mode">
      ${MODES.map((mode) => `<button type="button" class="lab-mode" data-mode-btn="${mode.id}" aria-pressed="false"><strong>${mode.label}</strong><small>${mode.note}</small></button>`).join('')}
    </div>

    <div class="lab-body">
      <div class="lab-mode-panel" data-mode-panel="merge">
        <p class="lab-help">Turn everything into one file. Drag a page to move it, spin it, skip it, or drop it entirely.</p>
        <ul class="lab-merge-list" id="labMergeList" role="list"></ul>
        <div class="lab-actions">
          <label class="field grow"><span class="field-label">Save as</span><input class="text-input" id="labMergeName" type="text" value="${escapeHtml(state.form.mergeName)}" autocomplete="off" /></label>
          <button class="button button-export" type="button" id="labMergeGo">${downloadIcon}<span>Download merged PDF</span></button>
        </div>
      </div>

      <div class="lab-mode-panel" data-mode-panel="split" hidden>
        <p class="lab-help">Pull pages out of a single file. Several results arrive as a zip.</p>
        <label class="field"><span class="field-label">Source file</span><select class="text-input" id="labSplitSource"></select></label>
        <div class="lab-segmented" role="radiogroup" aria-label="Split style">
          <label class="segment"><input type="radio" name="splitStyle" value="every" /><span>Every N pages</span></label>
          <label class="segment"><input type="radio" name="splitStyle" value="ranges" /><span>Page ranges</span></label>
          <label class="segment"><input type="radio" name="splitStyle" value="single" /><span>One file per page</span></label>
        </div>
        <div class="lab-row">
          <label class="field"><span class="field-label">Chunk size</span><input class="text-input text-input-narrow" id="labSplitEvery" type="number" min="1" max="500" step="1" value="${state.form.splitEvery}" /></label>
          <label class="field grow"><span class="field-label">Ranges</span><input class="text-input" id="labSplitRanges" type="text" placeholder="1-3, 5, 8-10" value="${escapeHtml(state.form.splitRanges)}" /></label>
        </div>
        <p class="lab-hint" id="labSplitHint">Add a PDF to begin.</p>
        <div class="lab-actions"><span></span><button class="button button-export" type="button" id="labSplitGo">${downloadIcon}<span>Download split files</span></button></div>
      </div>

      <div class="lab-mode-panel" data-mode-panel="margins" hidden>
        <p class="lab-help">Change the paper itself: grow every page by a margin, or trim one off. Text stays selectable — this moves the page box, it does not rasterise anything.</p>
        <div class="lab-row">
          <label class="field grow"><span class="field-label">Source file</span><select class="text-input" id="labMarginSource"></select></label>
          <span class="field"><span class="field-label">Units</span>
            <span class="pg-seg-row" id="labMarginUnits">
              <button type="button" class="pg-seg" data-margin-unit="mm">mm</button>
              <button type="button" class="pg-seg" data-margin-unit="in">in</button>
              <button type="button" class="pg-seg" data-margin-unit="pt">pt</button>
            </span>
          </span>
        </div>
        <div class="lab-segmented" role="radiogroup" aria-label="Margin action">
          <label class="segment"><input type="radio" name="marginAction" value="frame" /><span>Add a frame</span></label>
          <label class="segment"><input type="radio" name="marginAction" value="trim" /><span>Trim the edges</span></label>
        </div>
        <div class="lab-row lab-row-margins">
          <label class="field"><span class="field-label">Top</span><input class="text-input text-input-narrow" id="labMarginTop" type="number" min="0" step="any" /></label>
          <label class="field"><span class="field-label">Right</span><input class="text-input text-input-narrow" id="labMarginRight" type="number" min="0" step="any" /></label>
          <label class="field"><span class="field-label">Bottom</span><input class="text-input text-input-narrow" id="labMarginBottom" type="number" min="0" step="any" /></label>
          <label class="field"><span class="field-label">Left</span><input class="text-input text-input-narrow" id="labMarginLeft" type="number" min="0" step="any" /></label>
          <button class="button button-light" type="button" id="labMarginCopy">Copy the strip’s margins</button>
        </div>
        <p class="lab-hint" id="labMarginHint">Add a frame to give a scan a printable border, or trim to cut a fat binding edge off.</p>
        <div class="lab-actions"><span></span><button class="button button-export" type="button" id="labMarginGo">${downloadIcon}<span>Download reframed PDF</span></button></div>
      </div>

      <div class="lab-mode-panel" data-mode-panel="watermark" hidden>
        <p class="lab-help">Stamp a line of text on top of every page. Great before you share a draft.</p>
        <div class="lab-row">
          <label class="field grow"><span class="field-label">Source file</span><select class="text-input" id="labWatermarkSource"></select></label>
          <label class="field grow"><span class="field-label">Watermark text</span><input class="text-input" id="labWatermarkText" type="text" value="${escapeHtml(state.form.watermarkText)}" autocomplete="off" /></label>
        </div>
        <div class="lab-row lab-row-sliders">
          <div class="field"><span class="field-label-row"><span class="field-label">Size</span><output class="range-readout" id="labWatermarkSizeOut">${state.form.watermarkSize} pt</output></span><input class="range-input" id="labWatermarkSize" type="range" min="10" max="120" step="1" value="${state.form.watermarkSize}" /></div>
          <div class="field"><span class="field-label-row"><span class="field-label">Opacity</span><output class="range-readout" id="labWatermarkOpacityOut">${state.form.watermarkOpacity}%</output></span><input class="range-input" id="labWatermarkOpacity" type="range" min="4" max="100" step="1" value="${state.form.watermarkOpacity}" /></div>
          <div class="field"><span class="field-label-row"><span class="field-label">Angle</span><output class="range-readout" id="labWatermarkAngleOut">${state.form.watermarkAngle}°</output></span><input class="range-input" id="labWatermarkAngle" type="range" min="-90" max="90" step="1" value="${state.form.watermarkAngle}" /></div>
          <label class="field field-colour"><span class="field-label">Colour</span><span class="colour-wrap"><input class="colour-input" id="labWatermarkColor" type="color" value="${escapeHtml(state.form.watermarkColor)}" /><code>${escapeHtml(state.form.watermarkColor)}</code></span></label>
        </div>
        <div class="lab-place">
          <div class="lab-pos-grid" role="group" aria-label="Watermark position">
            ${POSITIONS.map((position) => `<button type="button" class="lab-pos" data-position="${position}" aria-pressed="false" title="${position.replace('-', ' ')}" aria-label="${position.replace('-', ' ')}"><span></span></button>`).join('')}
          </div>
          <div class="lab-pos-side">
            <label class="field field-switch"><input type="checkbox" class="switch-input" id="labWatermarkAll" ${state.form.watermarkAll ? 'checked' : ''} /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Every page</span></label>
            <label class="field"><span class="field-label">Or pick pages</span><input class="text-input" id="labWatermarkRange" type="text" placeholder="1, 3-5" value="${escapeHtml(state.form.watermarkRange)}" /></label>
          </div>
        </div>
        <div class="lab-actions"><span class="lab-hint" id="labWatermarkHint"></span><button class="button button-export" type="button" id="labWatermarkGo">${downloadIcon}<span>Download stamped PDF</span></button></div>
      </div>
    </div>
  </section>
</div>`;
}

function wireDropzone(root) {
  const zone = q('#labDrop', root);
  const open = () => pickFiles({ accept: 'application/pdf,.pdf', multiple: true }).then((files) => addFiles(files, root));
  zone.addEventListener('click', open);
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  let depth = 0;
  zone.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('is-dragging');
  });
  zone.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    zone.classList.remove('is-dragging');
    addFiles(Array.from(event.dataTransfer?.files || []), root);
  });
}

/* --------------------------------------------------------------- ingest ---- */
async function addFiles(files, root) {
  const pdfs = files.filter((file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf');
  if (!pdfs.length) {
    if (files.length) toast('PDF Lab reads .pdf files only.', true);
    return;
  }
  const { PDFDocument } = await loadPdfLib();
  for (const file of pdfs) {
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
      const pageCount = doc.getPageCount();
      if (!pageCount) throw new Error('That PDF has no pages.');
      const id = `s${state.sources.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
      state.sources.push({
        id,
        name: file.name,
        size: file.size,
        buffer,
        pageCount,
        pages: Array.from({ length: pageCount }, (_, index) => {
          const page = doc.getPage(index);
          const { width, height } = page.getSize();
          return { index, size: `${Math.round(width)}×${Math.round(height)}`, thumb: null };
        }),
      });
      for (let index = 0; index < pageCount; index += 1) state.order.push({ sourceId: id, pageIndex: index, rotation: 0, skipped: false });
    } catch (error) {
      console.error(error);
      toast(`${file.name} could not be opened — it may be encrypted or damaged.`, true);
    }
  }
  render(root);
  loadThumbs(root).catch((error) => console.warn('Thumbnails skipped:', error));
}

async function loadThumbs(root) {
  if (state.thumbsReady || isFileProtocol || !state.sources.length) return;
  try {
    await loadPdfJs();
  } catch (error) {
    console.warn('Page previews are unavailable:', error);
    return;
  }
  state.thumbsReady = true;
  for (const source of state.sources) {
    let doc;
    try {
      doc = await openPdfDocument(source.buffer.slice(0));
    } catch (error) {
      console.warn('No preview for', source.name, error);
      continue;
    }
    for (const page of source.pages) {
      if (!q(`#labFileList`, root)) return;
      try {
        const pdfPage = await doc.getPage(page.index + 1);
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: 160 / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const context = canvas.getContext('2d');
        await pdfPage.render({ canvasContext: context, viewport }).promise;
        page.thumb = canvas.toDataURL('image/jpeg', 0.7);
      } catch (error) {
        console.warn('Page preview failed', error);
      }
    }
    paintFiles(root);
    paintMergeList(root);
  }
}

/* -------------------------------------------------------------- painting ---- */
function render(root) {
  paintFiles(root);
  paintSelects(root);
  paintMergeList(root);
  paintCounts(root);
  paintSplitHint(root);
  paintWatermarkHint(root);
}

function setMode(mode, root) {
  state.form.mode = mode;
  persist(root);
  paintMode(root);
  paintMergeList(root);
  paintSplitHint(root);
  paintWatermarkHint(root);
}

function paintMode(root) {
  q('#labShell', root).dataset.mode = state.form.mode;
  qa('[data-mode-btn]', root).forEach((node) => {
    const on = node.dataset.modeBtn === state.form.mode;
    node.classList.toggle('is-on', on);
    node.setAttribute('aria-pressed', String(on));
  });
  qa('[data-mode-panel]', root).forEach((panel) => {
    panel.hidden = panel.dataset.modePanel !== state.form.mode;
  });
}

function paintFiles(root) {
  const list = q('#labFileList', root);
  const count = q('#labFileCount', root);
  root.classList.toggle('has-input', state.sources.length > 0);
  const note = q('#labSideNote', root);
  if (note) {
    const pages = state.sources.reduce((total, file) => total + file.pageCount, 0);
    note.textContent = state.sources.length
      ? `${state.sources.length} ${state.sources.length === 1 ? 'file' : 'files'} · ${pages} ${pages === 1 ? 'page' : 'pages'} on this tab`
      : 'Nothing is uploaded';
  }
  list.innerHTML = '';
  if (!state.sources.length) {
    list.classList.remove('has-files');
    list.append(emptyState({ title: 'No PDFs loaded', note: 'Add one or more files to merge, split or stamp them.' }));
    if (count) count.textContent = 'No files yet';
    return;
  }
  list.classList.add('has-files');
  state.sources.forEach((source, sourceIndex) => {
    const card = el('li', { class: 'lab-file', dataset: { source: source.id } }, [
      el('div', { class: 'lab-file-row' }, [
        el('span', { class: 'lab-file-order', text: String(sourceIndex + 1).padStart(2, '0') }),
        el('div', { class: 'lab-file-meta' }, [
          el('strong', { text: source.name, title: source.name }),
          el('small', { text: `${source.pageCount} ${source.pageCount === 1 ? 'page' : 'pages'} · ${bytes(source.size)}` }),
        ]),
        el('div', { class: 'lab-file-actions' }, [
          el('button', { type: 'button', class: 'button button-light lab-mini', dataset: { rotate: source.id }, text: 'Rotate file' }),
          el('button', { type: 'button', class: 'button button-light lab-mini is-danger', dataset: { forget: source.id }, text: 'Remove' }),
        ]),
      ]),
      el('ul', { class: 'lab-thumbs', 'data-print-root': '', role: 'list' }, source.pages.map((page) =>
        el('li', { class: `lab-thumb${page.thumb ? ' is-ready' : ''}` }, [
          page.thumb ? el('img', { src: page.thumb, alt: '', loading: 'lazy' }) : null,
          el('span', { class: 'lab-thumb-index', text: String(page.index + 1) }),
        ]),
      )),
    ]);
    card.querySelector('[data-rotate]')?.addEventListener('click', () => {
      let changed = 0;
      state.order.forEach((entry) => {
        if (entry.sourceId === source.id && !entry.skipped) {
          entry.rotation = (entry.rotation + 90) % 360;
          changed += 1;
        }
      });
      paintMergeList(root);
      toast(changed ? `Rotated ${changed} page${changed === 1 ? '' : 's'} by 90°.` : 'Nothing to rotate.', !changed);
    });
    card.querySelector('[data-forget]')?.addEventListener('click', () => {
      state.sources = state.sources.filter((item) => item.id !== source.id);
      state.order = state.order.filter((entry) => entry.sourceId !== source.id);
      if (state.form.splitSource === source.id) state.form.splitSource = '';
      if (state.form.watermarkSource === source.id) state.form.watermarkSource = '';
      render(root);
    });
    list.append(card);
  });
  if (count) {
    const pages = state.sources.reduce((sum, source) => sum + source.pageCount, 0);
    count.textContent = `${state.sources.length} ${state.sources.length === 1 ? 'file' : 'files'} · ${pages} pages`;
  }
}

function paintSelects(root) {
  const options = state.sources.length
    ? state.sources.map((source) => `<option value="${source.id}">${escapeHtml(source.name)} · ${source.pageCount}p</option>`).join('')
    : '<option value="">Add a PDF first</option>';
  for (const [id, key] of [['#labSplitSource', 'splitSource'], ['#labWatermarkSource', 'watermarkSource'], ['#labMarginSource', 'marginSource']]) {
    const select = q(id, root);
    if (!select) continue;
    const previous = select.value;
    select.innerHTML = options;
    const wanted = state.sources.find((source) => source.id === (state.form[key] || previous));
    select.value = wanted ? wanted.id : state.sources[0]?.id ?? '';
    state.form[key] = select.value;
  }
}

function paintMergeList(root) {
  const list = q('#labMergeList', root);
  if (!list) return;
  list.innerHTML = '';
  if (!state.order.length) {
    list.append(el('li', { class: 'lab-empty', text: 'Pages will line up here once you add a PDF.' }));
    return;
  }
  state.order.forEach((entry, index) => {
    const source = state.sources.find((item) => item.id === entry.sourceId);
    const page = source?.pages[entry.pageIndex];
    if (!source || !page) return;
    const item = el('li', {
      class: `lab-page${entry.skipped ? ' is-skipped' : ''}`,
      draggable: 'true',
      dataset: { index: String(index) },
    }, [
      el('span', { class: 'lab-drag', 'aria-hidden': 'true', html: '<svg viewBox="0 0 12 20" fill="currentColor"><circle cx="3" cy="5" r="1.25"/><circle cx="9" cy="5" r="1.25"/><circle cx="3" cy="10" r="1.25"/><circle cx="9" cy="10" r="1.25"/><circle cx="3" cy="15" r="1.25"/><circle cx="9" cy="15" r="1.25"/></svg>' }),
      el('span', { class: 'lab-page-number', text: String(index + 1) }),
      page.thumb
        ? el('img', { class: 'lab-page-thumb', src: page.thumb, alt: '' })
        : el('span', { class: 'lab-page-thumb is-empty' }),
      el('span', { class: 'lab-page-name' }, [
        el('strong', { text: `${source.name.replace(/\.pdf$/i, '')} · p${entry.pageIndex + 1}` }),
        el('small', { text: `${page.size}${entry.rotation ? ` · rotated ${entry.rotation}°` : ''}${entry.skipped ? ' · skipped' : ''}` }),
      ]),
      el('span', { class: 'lab-page-actions' }, [
        iconButton('Move up', 'up', '<path d="M10 15V5m0 0-3.6 3.6M10 5l3.6 3.6"/>'),
        iconButton('Move down', 'down', '<path d="M10 5v10m0 0 3.6-3.6M10 15l-3.6-3.6"/>'),
        iconButton('Rotate 90° clockwise', 'spin', '<path d="M15.4 9.4a5.4 5.4 0 1 0-.6 3.4M15.8 4.6v4h-4"/>'),
        iconButton(entry.skipped ? 'Include this page' : 'Skip this page', 'skip', entry.skipped ? '<path d="m5.4 10.2 3.2 3.2 6-6.6"/>' : '<path d="M6.2 6.2l7.6 7.6m0-7.6-7.6 7.6"/>'),
        iconButton('Remove from merge', 'cut', '<path d="M5.4 6.4h9.2M7.9 6.4l.5 8.9h3.2l.5-8.9M9.4 4.9h1.2v1.5H9.4m.3 2.2v4.4m1.9-4.4v4.4"/>'),
      ]),
    ]);
    item.addEventListener('click', (event) => {
      const target = event.target.closest('[data-act]');
      if (!target) return;
      const action = target.dataset.act;
      if (action === 'up' && index > 0) [state.order[index - 1], state.order[index]] = [state.order[index], state.order[index - 1]];
      else if (action === 'down' && index < state.order.length - 1) [state.order[index + 1], state.order[index]] = [state.order[index], state.order[index + 1]];
      else if (action === 'spin') entry.rotation = (entry.rotation + 90) % 360;
      else if (action === 'skip') entry.skipped = !entry.skipped;
      else if (action === 'cut') state.order.splice(index, 1);
      paintMergeList(root);
      paintCounts(root);
    });
    item.addEventListener('dragstart', (event) => {
      item.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('is-dragging');
      qa('.is-over', list).forEach((node) => node.classList.remove('is-over'));
    });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      item.classList.add('is-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('is-over'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      item.classList.remove('is-over');
      const from = Number(event.dataTransfer.getData('text/plain'));
      if (!Number.isFinite(from) || from === index) return;
      const [moved] = state.order.splice(from, 1);
      state.order.splice(index, 0, moved);
      paintMergeList(root);
      paintCounts(root);
    });
    list.append(item);
  });
}

function iconButton(label, act, path) {
  return el('button', {
    type: 'button',
    class: 'lab-icon-button',
    dataset: { act },
    'aria-label': label,
    title: label,
    html: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`,
  });
}

function paintCounts(root) {
  const node = q('#labPageCount', root);
  if (!node) return;
  const kept = state.order.filter((entry) => !entry.skipped).length;
  node.textContent = state.sources.length
    ? `${state.sources.length} ${state.sources.length === 1 ? 'file' : 'files'} · ${kept}/${state.order.length} pages`
    : 'no files yet';
}

function activeSource(root, key) {
  const selector = { splitSource: '#labSplitSource', watermarkSource: '#labWatermarkSource', marginSource: '#labMarginSource' }[key] ?? '#labMergeList';
  const id = q(selector, root)?.value;
  return state.sources.find((source) => source.id === id) ?? state.sources[0] ?? null;
}

function paintSplitHint(root) {
  const hint = q('#labSplitHint', root);
  if (!hint) return;
  const source = activeSource(root, 'splitSource');
  hint.classList.remove('is-error');
  if (!source) {
    hint.textContent = 'Add a PDF to begin.';
    return;
  }
  const style = state.form.splitStyle;
  if (style === 'every') {
    const size = Math.max(1, Math.round(Number(state.form.splitEvery) || 1));
    const files = Math.ceil(source.pageCount / size);
    hint.textContent = `${source.pageCount} pages → ${files} ${files === 1 ? 'file' : 'files'} of up to ${size} ${size === 1 ? 'page' : 'pages'}.`;
  } else if (style === 'ranges') {
    const { ranges, ok, errors } = parsePageRanges(state.form.splitRanges, source.pageCount);
    if (!ok) {
      hint.classList.add('is-error');
      hint.textContent = `Not sure about ${errors.map((item) => `"${item}"`).join(', ')} — try 1-3, 5, 8-10.`;
      return;
    }
    hint.textContent = ranges.length ? `Extracting ${rangeLabel(ranges, source.pageCount)}.` : 'Type at least one range, e.g. 1-3.';
  } else {
    hint.textContent = `${source.pageCount} single-page ${source.pageCount === 1 ? 'file' : 'files'}, delivered as a zip.`;
  }
}

function paintMarginForm(root) {
  const unit = state.form.marginUnit ?? 'mm';
  qa('#labMarginUnits [data-margin-unit]', root).forEach((node) => {
    const on = node.dataset.marginUnit === unit;
    node.classList.toggle('is-on', on);
    node.ariaPressed = String(on);
  });
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const node = q(`#labMargin${side}`, root);
    const key = `margin${side}`;
    if (node && document.activeElement !== node) node.value = String(round3(state.form[key]));
  }
  const source = activeSource(root, 'marginSource');
  const hint = q('#labMarginHint', root);
  const action = state.form.marginAction;
  if (!hint) return;
  if (!source) {
    hint.textContent = 'Add a PDF to begin.';
    return;
  }
  const unitLabel = MM_PER_UNIT[unit] === 1 ? 'mm' : unit;
  const margins = [state.form.marginTop, state.form.marginRight, state.form.marginBottom, state.form.marginLeft].map((value) => round3(Number(value) || 0));
  const nothing = margins.every((value) => value === 0);
  const first = source.pages[0];
  hint.textContent = nothing
    ? 'Type a margin on any side — or copy the numbers from the page strip.'
    : `${action === 'frame' ? 'Every page grows' : 'Every page is trimmed'} by ${margins[0]} / ${margins[1]} / ${margins[2]} / ${margins[3]} ${unitLabel} (top, right, bottom, left) across ${source.pageCount} ${source.pageCount === 1 ? 'page' : 'pages'}${first?.width ? ` · e.g. ${Math.round(first.width + (action === 'frame' ? (margins[1] + margins[3]) : -(margins[1] + margins[3])) * (25.4 / 72))} × ${Math.round(first.height + (action === 'frame' ? (margins[0] + margins[2]) : -(margins[0] + margins[2])) * (25.4 / 72))} pt` : ''}.`;
}

/** Points from whatever unit the panel is showing. */
function marginPoints(root) {
  const unit = MM_PER_UNIT[state.form.marginUnit] ?? 1;
  const mm = [state.form.marginTop, state.form.marginRight, state.form.marginBottom, state.form.marginLeft]
    .map((value) => Math.max(0, Number(value) || 0) * unit);
  void root;
  return { top: mm[0] * (72 / 25.4), right: mm[1] * (72 / 25.4), bottom: mm[2] * (72 / 25.4), left: mm[3] * (72 / 25.4) };
}

/**
 * Frame & trim: the page box is what changes, so the text stays text.
 *   frame — the box grows around the content and the content is nudged inside it
 *   trim  — the box shrinks and the content is cropped where the reader sees it
 * Margins are given the way the reader sees the page, so a /Rotate 90 sheet
 * gets its margin on the edge that faces up on screen, and framing never leaves
 * a page upside down.
 */
async function exportMargins(root) {
  await withBusy(root, '#labMarginGo', 'Reframing…', async () => {
    const source = activeSource(root, 'marginSource');
    if (!source) throw new Error('Add a PDF first.');
    const m = marginPoints(root);
    const total = m.top + m.right + m.bottom + m.left;
    const action = state.form.marginAction === 'trim' ? 'trim' : 'frame';
    if (total <= 0) throw new Error('Give the page a margin first — all four sides are zero.');
    const { PDFDocument, degrees } = await loadPdfLib();
    const doc = await PDFDocument.load(source.buffer.slice(0), { ignoreEncryption: true, updateMetadata: false });
    const report = [];
    doc.getPages().forEach((pdfPage, index) => {
      const media = pdfPage.getMediaBox();
      const quarter = ((pdfPage.getRotation().angle % 360) + 360) % 360;
      const swap = quarter === 90 || quarter === 270;
      // the reader's margins, rotated into the page's own coordinate space
      const sides = !swap
        ? { left: m.left, right: m.right, top: m.top, bottom: m.bottom }
        : quarter === 90
          ? { left: m.top, right: m.bottom, top: m.right, bottom: m.left }
          : { left: m.bottom, right: m.top, top: m.left, bottom: m.right };
      const width = Math.max(24, media.width + (action === 'frame' ? sides.left + sides.right : -(sides.left + sides.right)));
      const height = Math.max(24, media.height + (action === 'frame' ? sides.top + sides.bottom : -(sides.top + sides.bottom)));
      pdfPage.setMediaBox(0, 0, width, height);
      if (action === 'frame') pdfPage.translateContent(sides.left - media.x, sides.bottom - media.y);
      if (index === 0) report.push(`${Math.round(media.width)}×${Math.round(media.height)} → ${Math.round(width)}×${Math.round(height)} pt`);
      void degrees;
    });
    save(new Uint8Array(await doc.save({ useObjectStreams: true })), safeFileName(`${stripPdf(source.name)}-${action === 'frame' ? 'framed' : 'trimmed'}`, 'pdf'), source.pageCount);
    toast(`${report[0] ?? ''} ${report[0] ? '· ' : ''}${action === 'frame' ? 'framed' : 'trimmed'} on ${source.pageCount} ${source.pageCount === 1 ? 'page' : 'pages'}.`);
  });
}

function round3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function paintWatermarkHint(root) {
  const hint = q('#labWatermarkHint', root);
  paintMarginForm(root);
  if (!hint) return;
  const source = activeSource(root, 'watermarkSource');
  if (!source) {
    hint.textContent = 'Add a PDF to begin.';
    return;
  }
  const pages = watermarkTargets(source, root);
  const preview = String(state.form.watermarkText || '').trim() || 'DRAFT';
  hint.textContent = `${pages.length} of ${source.pageCount} pages will read “${preview.length > 24 ? `${preview.slice(0, 24)}…` : preview}”.`;
}

function watermarkTargets(source, root) {
  if (state.form.watermarkAll) return source.pages.map((page) => page.index);
  const { ranges, ok } = parsePageRanges(state.form.watermarkRange, source.pageCount);
  if (!ok) return [];
  return ranges.flatMap((range) => indexesOf(range));
  void root;
}

function indexesOf({ start, end }) {
  const out = [];
  for (let index = start - 1; index <= end - 1; index += 1) out.push(index);
  return out;
}

/* ----------------------------------------------------------------- form ---- */
function persist(root) {
  prefs.write(state.form);
  void root;
}

function bindForm(root) {
  const save = debounce(() => persist(root), 200);
  const text = (id, key, cast = (value) => value) => {
    const node = q(id, root);
    if (!node) return;
    if (key in state.form) node.value = state.form[key];
    node.addEventListener('input', () => {
      state.form[key] = cast(node.value);
      save();
      if (key === 'splitStyle' || key.startsWith('split')) paintSplitHint(root);
      if (key.startsWith('watermark')) paintWatermarkHint(root);
      if (key.startsWith('margin')) paintMarginForm(root);
    });
    node.addEventListener('change', () => {
      state.form[key] = cast(node.value);
      save();
    });
  };
  text('#labMergeName', 'mergeName');
  text('#labSplitEvery', 'splitEvery', Number);
  text('#labSplitRanges', 'splitRanges');
  text('#labWatermarkText', 'watermarkText');
  text('#labWatermarkRange', 'watermarkRange');
  text('#labWatermarkSize', 'watermarkSize', Number);
  text('#labWatermarkOpacity', 'watermarkOpacity', Number);
  text('#labWatermarkAngle', 'watermarkAngle', Number);
  text('#labWatermarkColor', 'watermarkColor');
  text('#labMarginTop', 'marginTop', Number);
  text('#labMarginRight', 'marginRight', Number);
  text('#labMarginBottom', 'marginBottom', Number);
  text('#labMarginLeft', 'marginLeft', Number);
  qa('[name="marginAction"]', root).forEach((node) => {
    node.checked = node.value === state.form.marginAction;
    node.addEventListener('change', () => {
      state.form.marginAction = node.value;
      persist(root);
      paintMarginForm(root);
    });
  });
  q('#labMarginSource', root)?.addEventListener('change', (event) => {
    state.form.marginSource = event.target.value;
    persist(root);
    paintMarginForm(root);
  });
  q('#labSplitSource', root)?.addEventListener('change', (event) => {
    state.form.splitSource = event.target.value;
    paintSplitHint(root);
    save();
  });
  q('#labWatermarkSource', root)?.addEventListener('change', (event) => {
    state.form.watermarkSource = event.target.value;
    paintWatermarkHint(root);
    save();
  });
  q('#labWatermarkAll', root)?.addEventListener('change', (event) => {
    state.form.watermarkAll = event.target.checked;
    paintWatermarkHint(root);
    save();
  });
  qa('[name="splitStyle"]', root).forEach((node) => {
    node.checked = node.value === state.form.splitStyle;
    node.closest('.segment')?.classList.toggle('is-on', node.checked);
    node.addEventListener('change', () => {
      state.form.splitStyle = node.value;
      qa('[name="splitStyle"]', root).forEach((other) => other.closest('.segment')?.classList.toggle('is-on', other.checked));
      paintSplitHint(root);
      save();
    });
  });
  const readouts = { '#labWatermarkSize': ['#labWatermarkSizeOut', ' pt'], '#labWatermarkOpacity': ['#labWatermarkOpacityOut', '%'], '#labWatermarkAngle': ['#labWatermarkAngleOut', '°'], '#labWatermarkColor': [null, ''] };
  for (const [inputId, [outId, unit]] of Object.entries(readouts)) {
    q(inputId, root)?.addEventListener('input', (event) => {
      if (outId) q(outId, root).textContent = `${event.target.value}${unit}`;
      if (inputId === '#labWatermarkColor') {
        const code = q('.colour-wrap code', root);
        if (code) code.textContent = event.target.value;
      }
    });
  }
  qa('[data-position]', root).forEach((node) => {
    node.classList.toggle('is-on', node.dataset.position === state.form.watermarkPosition);
    node.setAttribute('aria-pressed', String(node.dataset.position === state.form.watermarkPosition));
    node.addEventListener('click', () => {
      state.form.watermarkPosition = node.dataset.position;
      qa('[data-position]', root).forEach((other) => {
        other.classList.toggle('is-on', other === node);
        other.setAttribute('aria-pressed', String(other === node));
      });
      save();
    });
  });
  paintMode(root);
}

/* --------------------------------------------------------------- export ---- */
async function withBusy(root, buttonId, label, work) {
  if (state.busy) return;
  const node = q(buttonId, root);
  const original = node.innerHTML;
  state.busy = true;
  node.disabled = true;
  node.innerHTML = `<span class="export-spinner" aria-hidden="true"></span><span>${label}</span>`;
  try {
    await work();
  } catch (error) {
    console.error(error);
    toast(error?.message || 'That did not work — check the file and try again.', true);
  } finally {
    state.busy = false;
    node.disabled = false;
    node.innerHTML = original;
  }
}

async function exportMerge(root) {
  await withBusy(root, '#labMergeGo', 'Building…', async () => {
    const kept = state.order.filter((entry) => !entry.skipped);
    if (!kept.length) throw new Error('Include at least one page.');
    const { PDFDocument, degrees } = await loadPdfLib();
    const out = await PDFDocument.create();
    out.setCreator('Folio · PDF Lab');
    const cache = new Map();
    for (const entry of kept) {
      const source = state.sources.find((item) => item.id === entry.sourceId);
      if (!source) continue;
      if (!cache.has(source.id)) cache.set(source.id, await PDFDocument.load(source.buffer.slice(0), { ignoreEncryption: true }));
      const [page] = await out.copyPages(cache.get(source.id), [entry.pageIndex]);
      out.addPage(page);
      if (entry.rotation) page.setRotation(degrees(((page.getRotation().angle ?? 0) + entry.rotation) % 360));
    }
    const title = String(state.form.mergeName || 'folio-merged').trim() || 'folio-merged';
    out.setTitle(title);
    save(new Uint8Array(await out.save({ useObjectStreams: true })), safeFileName(title, 'pdf'), out.getPageCount());
  });
}

async function exportSplit(root) {
  await withBusy(root, '#labSplitGo', 'Splitting…', async () => {
    const source = activeSource(root, 'splitSource');
    if (!source) throw new Error('Add a PDF first.');
    const { PDFDocument } = await loadPdfLib();
    let chunks = [];
    if (state.form.splitStyle === 'every') {
      const size = Math.max(1, Math.round(Number(state.form.splitEvery) || 1));
      for (let start = 1; start <= source.pageCount; start += size) chunks.push({ start, end: Math.min(source.pageCount, start + size - 1) });
    } else if (state.form.splitStyle === 'ranges') {
      const { ranges, ok, errors } = parsePageRanges(state.form.splitRanges, source.pageCount);
      if (!ok) throw new Error(`I could not read ${errors.map((item) => `"${item}"`).join(', ')} — try 1-3, 5, 8-10.`);
      if (!ranges.length) throw new Error('Type at least one range, e.g. 1-3.');
      chunks = ranges;
    } else {
      chunks = Array.from({ length: source.pageCount }, (_, index) => ({ start: index + 1, end: index + 1 }));
    }
    const base = await PDFDocument.load(source.buffer.slice(0), { ignoreEncryption: true });
    const files = [];
    for (const chunk of chunks) {
      const out = await PDFDocument.create();
      out.setCreator('Folio · PDF Lab');
      (await out.copyPages(base, indexesOf(chunk))).forEach((page) => out.addPage(page));
      files.push({ name: chunks.length === 1 ? safeFileName(source.name, 'pdf') : safeFileName(`${stripPdf(source.name)}-${chunk.start}-${chunk.end}`, 'pdf'), data: new Uint8Array(await out.save({ useObjectStreams: true })) });
    }
    if (files.length === 1) save(files[0].data, files[0].name, chunks[0].end - chunks[0].start + 1);
    else {
      const blob = await makeZip(Object.fromEntries(files.map((file) => [file.name, file.data])));
      downloadBlob(blob, safeFileName(`${stripPdf(source.name)}-split`, 'zip'));
      toast(`${files.length} PDFs zipped — all on your device.`);
    }
  });
}

async function exportWatermark(root) {
  await withBusy(root, '#labWatermarkGo', 'Stamping…', async () => {
    const source = activeSource(root, 'watermarkSource');
    if (!source) throw new Error('Add a PDF first.');
    const text = String(state.form.watermarkText || '').trim();
    if (!text) throw new Error('Type some watermark text first.');
    const targets = watermarkTargets(source, root);
    if (!targets.length) throw new Error(state.form.watermarkAll ? 'No pages selected.' : 'Those page numbers do not look right — try 1, 3-5.');
    const { PDFDocument, StandardFonts, degrees, rgb } = await loadPdfLib();
    const doc = await PDFDocument.load(source.buffer.slice(0), { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const size = Number(state.form.watermarkSize) || 46;
    const opacity = Math.min(1, Math.max(0.02, (Number(state.form.watermarkOpacity) || 18) / 100));
    const angle = Number(state.form.watermarkAngle) || 0;
    const { r, g, b } = hexToRgb(state.form.watermarkColor);
    targets.forEach((index) => {
      const page = doc.getPage(index);
      const { width, height } = page.getSize();
      const textWidth = font.widthOfTextAtSize(text, size);
      const { x, y } = placeBox({ width, height, textWidth, size, position: state.form.watermarkPosition });
      page.drawText(text, { x, y, size, font, color: rgb(r, g, b), opacity, rotate: degrees(angle) });
    });
    save(new Uint8Array(await doc.save({ useObjectStreams: true })), safeFileName(`${stripPdf(source.name)}-watermarked`, 'pdf'), targets.length);
  });
}

function placeBox({ width, height, textWidth, size, position }) {
  const pad = Math.min(40, Math.max(16, width * 0.05));
  const rows = { top: height - pad - size, middle: height / 2 - size / 2, centre: height / 2 - size / 2, bottom: pad };
  const cols = { left: pad, center: (width - textWidth) / 2, centre: (width - textWidth) / 2, right: width - pad - textWidth };
  const [row, column = 'centre'] = String(position).split('-');
  return { x: cols[column] ?? cols.centre, y: rows[row] ?? rows.centre };
}

function hexToRgb(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex || '')?.[1] ?? '7d9a7c';
  const int = Number.parseInt(value, 16);
  return { r: ((int >> 16) & 255) / 255, g: ((int >> 8) & 255) / 255, b: (int & 255) / 255 };
}

function stripPdf(name) {
  return String(name || 'document').replace(/\.pdf$/i, '');
}

function save(data, name, pageCount) {
  const blob = new Blob([data], { type: 'application/pdf' });
  downloadBlob(blob, name);
  toast(`${name} is ready — ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}, ${bytes(blob.size)}.`);
}

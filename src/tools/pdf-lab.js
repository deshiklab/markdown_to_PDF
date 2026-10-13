// PDF Lab. Three sub-tools in one panel:
//
//   1. Merge & Reorder — add several PDFs, see every page as a
//      thumbnail, drag to reorder, rotate individual pages, then save
//      one PDF.
//   2. Split — pick one PDF, choose a mode (every N pages, by
//      ranges, odd pages, even pages), get multiple PDFs bundled in
//      a ZIP.
//   3. Watermark — pick one PDF, set text / size / opacity / angle /
//      colour / placement, get a stamped PDF.
//
// All three share the same `loadPdfBytes()` / `readPageThumb` helpers
// and the same per-page model (a { sourceFile, pageIndex, rotation }
// triple). The thumbnail renderer is the meaty bit: it draws each
// page into a small canvas using pdf.js, with the README's
// 'fresh canvas per render' trap in mind.

import {
  h, clear, showToast, readFileBytes, downloadBlob,
  formatBytes, lazy, pickFile,
} from '../lib.js';

const loadPdfLib = lazy(() => import('pdf-lib'));
const loadPdfJs = lazy(() => import('pdfjs-dist/build/pdf.mjs'));
const loadFflate = lazy(() => import('fflate'));

const SUBTABS = [
  { id: 'merge', title: 'Merge & reorder', sub: 'Combine several PDFs, drag to reorder, rotate pages.' },
  { id: 'split', title: 'Split', sub: 'Split one PDF by range, every-N, or odd / even.' },
  { id: 'watermark', title: 'Watermark', sub: 'Stamp text on every page (or a range).' },
];

export function start(root) {
  const panel = h('div', { class: 'tool-pdflab' }, [
    buildSubTabBar(),
    h('div', { class: 'pdflab-stage', id: 'pdflabStage' }),
  ]);
  root.append(panel);

  const subRoots = new Map();
  let active = SUBTABS[0].id;

  function renderActive() {
    const stage = panel.querySelector('#pdflabStage');
    clear(stage);
    if (subRoots.has(active)) {
      stage.append(subRoots.get(active));
    } else {
      const sub = buildSubTool(active);
      subRoots.set(active, sub);
      stage.append(sub);
    }
    panel.querySelectorAll('.pdflab-subtab').forEach((b) => {
      const on = b.dataset.subtab === active;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  panel.querySelectorAll('.pdflab-subtab').forEach((button) => {
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
  return h('div', { class: 'pdflab-subtabs', role: 'tablist', 'aria-label': 'PDF Lab sub-tools' },
    SUBTABS.map((s) => h('button', {
      type: 'button',
      class: 'pdflab-subtab',
      role: 'tab',
      'data-subtab': s.id,
      'aria-selected': 'false',
    }, [
      h('span', { class: 'pdflab-subtab-title' }, s.title),
      h('span', { class: 'pdflab-subtab-sub' }, s.sub),
    ]))
  );
}

function buildSubTool(id) {
  switch (id) {
    case 'merge': return buildMergePanel();
    case 'split': return buildSplitPanel();
    case 'watermark': return buildWatermarkPanel();
    default: throw new Error(`Unknown PDF Lab sub-tool: ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Page model & thumbnails
// ---------------------------------------------------------------------------

/**
 * The Merge panel keeps a list of `pages` where each page is:
 *   { id, fileIndex, pageIndex, rotation, name, file, pdfJs }
 * `file` is the original File, `fileIndex` is its index in the source
 * file list, and `pageIndex` is the 0-based page number inside that
 * file. `pdfJs` is the parsed pdf.js document for `file` (cached).
 * `rotation` is the *additional* rotation in degrees the user wants
 * applied on top of the source page's existing rotation; saved into
 * the output by setting the page's /Rotate.
 */
function makePageModel() {
  return {
    files: [],          // [{ file, name, pdfJs, pdfLib }]
    pages: [],          // [{ id, fileIndex, pageIndex, rotation, name }]
  };
}

let nextPageId = 1;
function newPageId() { return `p-${nextPageId++}-${Date.now().toString(36)}`; }

/**
 * Load a PDF file with both pdf.js (for thumbnails / page count) and
 * pdf-lib (for the merge / save side). Returns `{ file, name, pdfJs,
 * pdfLib }` ready to be pushed into the merge model.
 */
async function loadPdfFile(file) {
  const [pdfjs, pdfLib] = await Promise.all([loadPdfJs(), loadPdfLib()]);
  const bytes = await readFileBytes(file);
  // pdf.js wants a fresh Uint8Array per document so two files don't
  // share a buffer.
  const pdfJsDoc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pdfLibDoc = await pdfLib.PDFDocument.load(bytes, { updateMetadata: false });
  return { file, name: file.name, pdfJs: pdfJsDoc, pdfLib: pdfLibDoc };
}

/**
 * Render a single page to a small canvas and return the canvas.
 * Each call gets a fresh <canvas> element so pdf.js's "no second
 * render on the same canvas" trap is satisfied.
 */
async function renderPageThumb(pdfJsDoc, pageNum, scale = 0.32) {
  const page = await pdfJsDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas;
}

// ---------------------------------------------------------------------------
// 1. Merge & Reorder
// ---------------------------------------------------------------------------

function buildMergePanel() {
  const root = h('div', { class: 'pdflab-sub' });
  const model = makePageModel();

  const head = h('div', { class: 'pdflab-sub-head' }, [
    h('h3', null, 'Merge & reorder'),
    h('p', null, 'Add one or more PDFs. Every page becomes a thumbnail you can drag to reorder or rotate. Then save a single PDF.'),
  ]);

  const fileBar = h('div', { class: 'pdflab-file-bar' }, [
    h('button', { class: 'button button-light', type: 'button', id: 'mergeAdd' }, [
      plusIcon(), ' Add PDF',
    ]),
    h('button', { class: 'button button-text', type: 'button', id: 'mergeClear' }, 'Clear all'),
    h('span', { class: 'pdflab-file-bar-status', id: 'mergeFileStatus' }, 'No files yet.'),
  ]);

  const grid = h('div', { class: 'pdflab-page-grid', id: 'mergeGrid' });
  const foot = h('div', { class: 'pdflab-foot' }, [
    h('span', { class: 'pdflab-status', id: 'mergeStatus' }, 'Add at least one PDF to begin.'),
    h('button', { class: 'button button-export', type: 'button', id: 'mergeAction' }, [
      downloadIcon(), h('span', null, 'Save merged PDF'),
    ]),
  ]);

  root.append(head, fileBar, grid, foot);

  let dragId = null;
  let renderToken = 0;

  async function addFiles(fileList) {
    const arr = Array.from(fileList || []).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!arr.length) {
      showToast('Choose a .pdf file.', { error: true });
      return;
    }
    for (const file of arr) {
      try {
        const entry = await loadPdfFile(file);
        const fileIndex = model.files.length;
        model.files.push(entry);
        for (let i = 0; i < entry.pdfJs.numPages; i += 1) {
          model.pages.push({
            id: newPageId(),
            fileIndex,
            pageIndex: i,
            rotation: 0,
            name: entry.name,
          });
        }
      } catch (error) {
        console.error('Could not load PDF:', error);
        showToast(`Could not read ${file.name}.`, { error: true });
      }
    }
    renderGrid();
  }

  function renderGrid() {
    clear(grid);
    const fileStatus = root.querySelector('#mergeFileStatus');
    const status = root.querySelector('#mergeStatus');
    if (!model.files.length) {
      fileStatus.textContent = 'No files yet.';
      status.textContent = 'Add at least one PDF to begin.';
      return;
    }
    const totalSize = model.files.reduce((s, f) => s + f.file.size, 0);
    fileStatus.textContent = `${model.files.length} file${model.files.length === 1 ? '' : 's'} · ${model.pages.length} page${model.pages.length === 1 ? '' : 's'} · ${formatBytes(totalSize)}`;
    status.textContent = `${model.pages.length} page${model.pages.length === 1 ? '' : 's'} ready. Drag to reorder, click ⟲ to rotate.`;

    const myToken = ++renderToken;
    model.pages.forEach((page, index) => {
      const card = h('div', {
        class: 'pdflab-page',
        draggable: true,
        'data-id': page.id,
        'data-index': index,
      }, [
        h('div', { class: 'pdflab-page-canvas', 'data-canvas': 'true' }),
        h('div', { class: 'pdflab-page-meta' }, [
          h('span', { class: 'pdflab-page-index' }, String(index + 1).padStart(2, '0')),
          h('span', { class: 'pdflab-page-name' }, `${page.name} · p.${page.pageIndex + 1}`),
        ]),
        h('div', { class: 'pdflab-page-actions' }, [
          h('button', {
            type: 'button',
            class: 'pdflab-page-rotate',
            'aria-label': 'Rotate page clockwise',
            title: 'Rotate 90° clockwise',
          }, '⟲'),
          h('button', {
            type: 'button',
            class: 'pdflab-page-remove',
            'aria-label': 'Remove page',
            title: 'Remove from merge',
          }, '×'),
        ]),
      ]);

      // Drag-and-drop reordering.
      card.addEventListener('dragstart', (e) => {
        dragId = page.id;
        card.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Some browsers refuse to start a drag without setData.
        try { e.dataTransfer.setData('text/plain', page.id); } catch (err) { /* noop */ }
      });
      card.addEventListener('dragend', () => {
        dragId = null;
        card.classList.remove('is-dragging');
        grid.querySelectorAll('.pdflab-page').forEach((c) => c.classList.remove('is-drop-target'));
      });
      card.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('is-drop-target');
      });
      card.addEventListener('dragleave', () => card.classList.remove('is-drop-target'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('is-drop-target');
        if (!dragId || dragId === page.id) return;
        const from = model.pages.findIndex((p) => p.id === dragId);
        const to = model.pages.findIndex((p) => p.id === page.id);
        if (from < 0 || to < 0) return;
        const [moved] = model.pages.splice(from, 1);
        model.pages.splice(to, 0, moved);
        dragId = null;
        renderGrid();
      });

      card.querySelector('.pdflab-page-rotate').addEventListener('click', () => {
        page.rotation = (page.rotation + 90) % 360;
        renderGrid();
      });
      card.querySelector('.pdflab-page-remove').addEventListener('click', () => {
        model.pages = model.pages.filter((p) => p.id !== page.id);
        renderGrid();
      });

      grid.append(card);
    });

    // Render the actual thumbnails asynchronously, in order, and only
    // paint the result if the model hasn't changed (myToken).
    (async () => {
      for (let i = 0; i < model.pages.length; i += 1) {
        if (myToken !== renderToken) return;
        const page = model.pages[i];
        const file = model.files[page.fileIndex];
        if (!file) continue;
        const card = grid.querySelector(`[data-id="${page.id}"]`);
        if (!card) continue;
        const slot = card.querySelector('[data-canvas]');
        if (slot.dataset.rendered === '1') continue;
        try {
          const canvas = await renderPageThumb(file.pdfJs, page.pageIndex + 1);
          if (myToken !== renderToken) return;
          if (page.rotation) {
            const rotated = rotateCanvas(canvas, page.rotation);
            slot.append(rotated);
          } else {
            slot.append(canvas);
          }
          slot.dataset.rendered = '1';
        } catch (error) {
          console.error('Thumbnail render failed:', error);
          slot.textContent = 'Could not render';
        }
      }
    })();
  }

  function rotateCanvas(src, deg) {
    const out = document.createElement('canvas');
    if (deg === 90 || deg === 270) {
      out.width = src.height;
      out.height = src.width;
    } else {
      out.width = src.width;
      out.height = src.height;
    }
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return out;
  }

  root.querySelector('#mergeAdd').addEventListener('click', async () => {
    const files = await pickFile({ accept: 'application/pdf,.pdf', multiple: true });
    if (files && files.length) addFiles(files);
  });
  root.querySelector('#mergeClear').addEventListener('click', () => {
    model.files = [];
    model.pages = [];
    renderGrid();
  });
  root.querySelector('#mergeAction').addEventListener('click', () => mergeSave(root, model));

  // Drag-and-drop on the file bar.
  fileBar.addEventListener('dragover', (e) => { e.preventDefault(); fileBar.classList.add('is-drag'); });
  fileBar.addEventListener('dragleave', () => fileBar.classList.remove('is-drag'));
  fileBar.addEventListener('drop', (e) => {
    e.preventDefault();
    fileBar.classList.remove('is-drag');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  return root;
}

async function mergeSave(root, model) {
  if (!model.pages.length) {
    showToast('Add at least one page first.', { error: true });
    return;
  }
  const button = root.querySelector('#mergeAction');
  const status = root.querySelector('#mergeStatus');
  setBusy(button, true, 'Building PDF…');
  status.textContent = `Copying ${model.pages.length} page${model.pages.length === 1 ? '' : 's'}…`;
  try {
    const { PDFDocument } = await loadPdfLib();
    const out = await PDFDocument.create();
    for (let i = 0; i < model.pages.length; i += 1) {
      const page = model.pages[i];
      const source = model.files[page.fileIndex];
      if (!source) continue;
      status.textContent = `Copying page ${i + 1} of ${model.pages.length}…`;
      const [copied] = await out.copyPages(source.pdfLib, [page.pageIndex]);
      // Apply the user's additional rotation on top of the source
      // page's existing /Rotate value.
      const existing = copied.getRotation().angle || 0;
      const final = (existing + page.rotation) % 360;
      copied.setRotation((final * Math.PI) / 180);
      out.addPage(copied);
    }
    const bytes = await out.save();
    const baseName = model.files.length === 1
      ? (model.files[0].name.replace(/\.pdf$/i, '') || 'document')
      : 'merged';
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${baseName}-merged.pdf`);
    status.textContent = `Saved ${baseName}-merged.pdf (${model.pages.length} pages, ${formatBytes(bytes.length)}).`;
    showToast(`Saved ${baseName}-merged.pdf`);
  } catch (error) {
    console.error('Merge failed:', error);
    status.textContent = error && error.message ? error.message : 'Could not save the merged PDF.';
    showToast('Could not save the merged PDF.', { error: true });
  } finally {
    setBusy(button, false, 'Save merged PDF');
  }
}

// ---------------------------------------------------------------------------
// 2. Split
// ---------------------------------------------------------------------------

function buildSplitPanel() {
  const root = h('div', { class: 'pdflab-sub' });

  const settings = [
    selectRow('Mode', 'mode', [
      ['everyN', 'Every N pages'],
      ['ranges', 'Page ranges'],
      ['odd', 'Odd pages only'],
      ['even', 'Even pages only'],
      ['each', 'One file per page'],
    ]),
    rangeRow('N (pages per chunk)', 'n', 1, 200, 5, 'pages'),
    textRow('Ranges', 'ranges', '1-3, 5, 8-10', 'e.g. 1-3, 5, 8-10'),
  ];

  const fileArea = buildSubFileArea({ statusText: 'No PDF yet.' });

  root.append(
    h('div', { class: 'pdflab-sub-head' }, [
      h('h3', null, 'Split'),
      h('p', null, 'Pick a single PDF and choose a split mode. The output is a ZIP of PDFs so the filenames stay distinct.'),
    ]),
    h('div', { class: 'pdflab-sub-body' }, [
      h('aside', { class: 'pdflab-settings' }, [
        h('h4', { class: 'pdflab-settings-title' }, 'Split'),
        ...settings,
      ]),
      fileArea,
    ]),
  );

  const state = { file: null, mode: 'everyN', n: 5, ranges: '1-3, 5, 8-10' };
  const wire = wireSubFileArea(root, state, { accept: 'application/pdf,.pdf' });
  wireSettings(root, state, { mode: 'mode', n: 'n', ranges: 'ranges' });

  // Show only the relevant setting for the picked mode.
  const nRow = root.querySelector('[data-setting="n"]')?.closest('label');
  const rangesRow = root.querySelector('[data-setting="ranges"]')?.closest('label');
  const sync = () => {
    if (nRow) {
      const off = state.mode !== 'everyN';
      nRow.style.opacity = off ? '0.45' : '1';
      nRow.style.pointerEvents = off ? 'none' : 'auto';
    }
    if (rangesRow) {
      const off = state.mode !== 'ranges';
      rangesRow.style.opacity = off ? '0.45' : '1';
      rangesRow.style.pointerEvents = off ? 'none' : 'auto';
    }
  };
  sync();
  root.querySelector('[data-setting="mode"]').addEventListener('change', sync);

  const actionBtn = root.querySelector('[data-action]');
  actionBtn.querySelector('span').textContent = 'Split & zip';
  actionBtn.addEventListener('click', () => splitRun(root, state, wire));
  return root;
}

async function splitRun(root, state, wire) {
  if (!state.file) {
    showToast('Choose a PDF first.', { error: true });
    return;
  }
  const button = root.querySelector('[data-action]');
  setBusy(button, true, 'Splitting…');
  wire.setStatus(`Reading ${state.file.name}…`);
  try {
    const { PDFDocument } = await loadPdfLib();
    const { zip } = await loadFflate();
    const bytes = await readFileBytes(state.file);
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    const total = source.getPageCount();
    const chunks = planChunks(state, total);
    if (!chunks.length) throw new Error('No pages matched the split mode.');

    const baseName = state.file.name.replace(/\.pdf$/i, '') || 'document';
    const filesForZip = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      wire.setStatus(`Building part ${i + 1} of ${chunks.length}…`);
      const out = await PDFDocument.create();
      const copied = await out.copyPages(source, chunk);
      for (const p of copied) out.addPage(p);
      const saved = await out.save();
      const name = chunk.length === 1
        ? `${baseName}-p${String(chunk[0] + 1).padStart(3, '0')}.pdf`
        : `${baseName}-${String(i + 1).padStart(3, '0')}.pdf`;
      filesForZip.push({ name, data: saved });
    }

    const zipped = zip(Object.fromEntries(filesForZip.map((f) => [f.name, f.data])));
    downloadBlob(new Blob([zipped], { type: 'application/zip' }), `${baseName}-split.zip`);
    wire.setStatus(`Saved ${baseName}-split.zip (${chunks.length} part${chunks.length === 1 ? '' : 's'} from ${total} page${total === 1 ? '' : 's'}).`);
    showToast(`Saved ${baseName}-split.zip`);
  } catch (error) {
    console.error('Split failed:', error);
    wire.setStatus(error && error.message ? error.message : 'Could not split the PDF.');
    showToast('Could not split the PDF.', { error: true });
  } finally {
    setBusy(button, false, 'Split & zip');
  }
}

function planChunks(state, total) {
  if (state.mode === 'odd') {
    const pages = [];
    for (let i = 0; i < total; i += 2) pages.push(i);
    return pages.length ? [pages] : [];
  }
  if (state.mode === 'even') {
    const pages = [];
    for (let i = 1; i < total; i += 2) pages.push(i);
    return pages.length ? [pages] : [];
  }
  if (state.mode === 'each') {
    return Array.from({ length: total }, (_, i) => [i]);
  }
  if (state.mode === 'ranges') {
    const indices = parseRanges(state.ranges, total);
    if (!indices.length) return [];
    return [indices];
  }
  // everyN
  const n = Math.max(1, parseInt(state.n, 10) || 1);
  const chunks = [];
  for (let i = 0; i < total; i += n) {
    const chunk = [];
    for (let j = i; j < Math.min(total, i + n); j += 1) chunk.push(j);
    chunks.push(chunk);
  }
  return chunks;
}

function parseRanges(text, total) {
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
      if (i >= 1 && i <= total) out.add(i - 1);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 3. Watermark
// ---------------------------------------------------------------------------

function buildWatermarkPanel() {
  const root = h('div', { class: 'pdflab-sub' });

  const settings = [
    textRow('Text', 'text', 'CONFIDENTIAL', 'Up to one line'),
    rangeRow('Font size', 'fontSize', 8, 200, 48, 'pt'),
    colorRow('Colour', 'color', '#cccccc'),
    rangeRow('Opacity', 'opacity', 5, 100, 25, '%'),
    rangeRow('Rotation', 'rotation', -90, 90, -30, '°'),
    selectRow('Placement', 'placement', [
      ['center', 'Center'],
      ['top', 'Top'],
      ['bottom', 'Bottom'],
      ['top-left', 'Top · left'],
      ['top-right', 'Top · right'],
      ['bottom-left', 'Bottom · left'],
      ['bottom-right', 'Bottom · right'],
    ]),
    selectRow('Pages', 'pages', [['all', 'All pages'], ['range', 'A range…']]),
    textRow('Range', 'range', '1', 'e.g. 1-3, 5'),
  ];

  const fileArea = buildSubFileArea({ statusText: 'No PDF yet.' });

  root.append(
    h('div', { class: 'pdflab-sub-head' }, [
      h('h3', null, 'Watermark'),
      h('p', null, 'Stamp text on every page (or a range). The text is drawn in the page content stream; the source text layer is preserved.'),
    ]),
    h('div', { class: 'pdflab-sub-body' }, [
      h('aside', { class: 'pdflab-settings' }, [
        h('h4', { class: 'pdflab-settings-title' }, 'Watermark'),
        ...settings,
      ]),
      fileArea,
    ]),
  );

  const state = {
    file: null,
    text: 'CONFIDENTIAL',
    fontSize: 48,
    color: '#cccccc',
    opacity: 25,
    rotation: -30,
    placement: 'center',
    pages: 'all',
    range: '',
  };
  const wire = wireSubFileArea(root, state, { accept: 'application/pdf,.pdf' });
  wireSettings(root, state, {
    text: 'text', fontSize: 'fontSize', color: 'color', opacity: 'opacity',
    rotation: 'rotation', placement: 'placement', pages: 'pages', range: 'range',
  });

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
  actionBtn.querySelector('span').textContent = 'Stamp watermark';
  actionBtn.addEventListener('click', () => watermarkRun(root, state, wire));
  return root;
}

async function watermarkRun(root, state, wire) {
  if (!state.file) {
    showToast('Choose a PDF first.', { error: true });
    return;
  }
  if (!state.text || !state.text.trim()) {
    showToast('Watermark text cannot be empty.', { error: true });
    return;
  }
  const button = root.querySelector('[data-action]');
  setBusy(button, true, 'Stamping…');
  wire.setStatus(`Reading ${state.file.name}…`);
  try {
    const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
    const bytes = await readFileBytes(state.file);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const total = doc.getPageCount();
    const targets = state.pages === 'range' ? parseRanges(state.range, total) : Array.from({ length: total }, (_, i) => i);
    if (state.pages === 'range' && !targets.length) throw new Error('The page range did not match any page.');

    const colour = hexToRgb(state.color);
    const opacity = clamp01(Number(state.opacity) / 100);

    for (const pageIndex of targets) {
      const page = doc.getPage(pageIndex);
      const { width: pw, height: ph } = page.getSize();
      const text = state.text;
      const textWidth = font.widthOfTextAtSize(text, Number(state.fontSize));
      const { x, y } = positionFor(state.placement, pw, ph, textWidth, Number(state.fontSize), Number(state.fontSize) * 1.2);

      page.drawText(text, {
        x,
        y,
        size: Number(state.fontSize),
        font,
        color: rgb(colour.r, colour.g, colour.b),
        opacity,
        rotate: degrees(Number(state.rotation)),
      });
    }

    const out = await doc.save();
    const baseName = state.file.name.replace(/\.pdf$/i, '') || 'document';
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${baseName}-watermarked.pdf`);
    wire.setStatus(`Stamped ${targets.length} page${targets.length === 1 ? '' : 's'} into ${baseName}-watermarked.pdf (${formatBytes(out.length)}).`);
    showToast(`Saved ${baseName}-watermarked.pdf`);
  } catch (error) {
    console.error('Watermark failed:', error);
    wire.setStatus(error && error.message ? error.message : 'Could not stamp the PDF.');
    showToast('Could not stamp the PDF.', { error: true });
  } finally {
    setBusy(button, false, 'Stamp watermark');
  }
}

function positionFor(placement, pageW, pageH, textW, fontSize, ascentDescent) {
  let x;
  if (placement === 'top-left' || placement === 'bottom-left') x = 12;
  else if (placement === 'top-right' || placement === 'bottom-right') x = pageW - textW - 12;
  else if (placement === 'top' || placement === 'bottom') x = (pageW - textW) / 2;
  else x = (pageW - textW) / 2; // center
  let y;
  if (placement === 'top' || placement === 'top-left' || placement === 'top-right') y = pageH - ascentDescent;
  else if (placement === 'bottom' || placement === 'bottom-left' || placement === 'bottom-right') y = 12;
  else y = (pageH - ascentDescent) / 2;
  return { x, y };
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 0.8, g: 0.8, b: 0.8 };
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

// ---------------------------------------------------------------------------
// Shared dropzone / file area for the Split and Watermark panels
// ---------------------------------------------------------------------------

function buildSubFileArea({ statusText }) {
  return h('section', { class: 'pdflab-files' }, [
    h('div', { class: 'pdflab-drop', 'data-drop': 'true' }, [
      dropIcon(),
      h('strong', null, 'Drop a PDF here'),
      h('span', null, 'or use the file picker below'),
      h('button', { class: 'button button-light', type: 'button', 'data-pick': 'true' }, 'Choose PDF'),
    ]),
    h('div', { class: 'pdflab-file-list', 'data-files': 'true' }),
    h('div', { class: 'pdflab-foot' }, [
      h('span', { class: 'pdflab-status', 'data-status': 'true' }, statusText),
      h('button', { class: 'button button-export', type: 'button', 'data-action': 'true' }, [
        actionIcon(),
        h('span', null, 'Run'),
      ]),
    ]),
  ]);
}

function wireSubFileArea(root, state, { accept }) {
  const drop = root.querySelector('[data-drop]');
  const list = root.querySelector('[data-files]');
  const pick = root.querySelector('[data-pick]');
  const status = root.querySelector('[data-status]');

  function render() {
    clear(list);
    if (!state.file) return;
    list.append(h('div', { class: 'pdflab-file-row' }, [
      h('span', { class: 'pdflab-file-name' }, state.file.name),
      h('span', { class: 'pdflab-file-size' }, formatBytes(state.file.size)),
      h('button', {
        type: 'button',
        class: 'pdflab-file-remove',
        'aria-label': 'Remove file',
        title: 'Remove',
      }, '×'),
    ]));
    list.querySelector('button').addEventListener('click', () => {
      state.file = null;
      render();
      status.textContent = 'No PDF yet.';
    });
  }

  pick.addEventListener('click', async () => {
    const files = await pickFile({ accept, multiple: false });
    if (files && files.length) {
      state.file = files[0];
      render();
      status.textContent = `Loaded ${state.file.name} (${formatBytes(state.file.size)}).`;
    }
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
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      state.file = e.dataTransfer.files[0];
      render();
      status.textContent = `Loaded ${state.file.name} (${formatBytes(state.file.size)}).`;
    }
  });

  return { render, setStatus: (text) => { status.textContent = text; } };
}

// ---------------------------------------------------------------------------
// Settings wiring (select / text / range / color)
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
  return h('label', { class: 'pdflab-row' }, [
    h('span', { class: 'pdflab-row-label' }, label),
    h('span', { class: 'pdflab-row-control' }, [
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
  return h('label', { class: 'pdflab-row' }, [
    h('span', { class: 'pdflab-row-label' }, label),
    h('span', { class: 'pdflab-row-control' }, [
      h('input', { type: 'text', 'data-setting': key, placeholder, autocomplete: 'off', spellcheck: 'false' }),
      hint ? h('span', { class: 'pdflab-row-hint' }, hint) : null,
    ]),
  ]);
}

function rangeRow(label, key, min, max, value, unit) {
  return h('label', { class: 'pdflab-row' }, [
    h('span', { class: 'pdflab-row-label' }, label),
    h('span', { class: 'pdflab-row-control pdflab-row-range' }, [
      h('input', { type: 'range', min, max, value, 'data-setting': key, 'data-unit': unit }),
      h('span', { class: 'pdflab-row-value', 'data-range-value': 'true' }, `${value}${unit}`),
    ]),
  ]);
}

function colorRow(label, key, value) {
  return h('label', { class: 'pdflab-row' }, [
    h('span', { class: 'pdflab-row-label' }, label),
    h('span', { class: 'pdflab-row-control pdflab-row-color' }, [
      h('input', { type: 'color', value, 'data-setting': key }),
    ]),
  ]);
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = !!busy;
  if (busy) {
    button.innerHTML = '<span class="export-spinner" aria-hidden="true"></span><span>' + label + '</span>';
  } else {
    button.innerHTML = '';
    button.append(downloadIcon());
    const span = document.createElement('span');
    span.textContent = label;
    button.append(span);
  }
}

function plusIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M10 4.5v11M4.5 10h11' })
  );
}

function downloadIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3' })
  );
}

function actionIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3' })
  );
}

function dropIcon() {
  return h('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true', fill: 'none' },
    h('path', { d: 'M16 20.5V5.75m0 0-5.5 5.5M16 5.75l5.5 5.5 M7 19v5.25A2.75 2.75 0 0 0 9.75 27h12.5A2.75 2.75 0 0 0 25 24.25V19', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  );
}

// Converter tab. Four sub-tools in one panel, all running locally:
//
//   1. Photos → PDF — turn a folder of images into a PDF (paper size,
//      fit mode, margin, JPEG quality).
//   2. PDF → Markdown — extract text per page, stitch into a single
//      Markdown document with `<!-- page: N -->` separators.
//   3. PDF → PNG / JPEG — rasterise every page at a chosen DPI.
//   4. Shrink Images — re-encode a batch of images at a target quality
//      and maximum edge, bundled into a ZIP (so filenames are kept).
//
// All four share the same input bar pattern (drop zone + file picker +
// per-tool options + a single primary action), the same toast/error
// plumbing, and the same lazy loading of pdf-lib / pdfjs-dist / fflate.

import {
  h, on, clear, showToast, readFileBytes, readFileDataURL,
  pickFile, downloadBlob, sanitizeFilename, formatBytes, debounce, lazy,
} from '../lib.js';
import {
  paperDimensions, mmToPx, PAPER_LABELS, MARGIN_PRESETS_PX,
} from '../render.js';

// Lazy loaders. Per the README rule, no top-level imports of these.
const loadPdfLib = lazy(() => import('pdf-lib'));
const loadPdfJs = lazy(() => import('pdfjs-dist/build/pdf.mjs'));
const loadFflate = lazy(() => import('fflate'));

const PAPER_SIZES = ['a4', 'letter', 'a5', 'a6'];
const FIT_MODES = [
  ['contain', 'Fit (keep ratio, may letterbox)'],
  ['cover', 'Fill (crop to fill the page)'],
  ['stretch', 'Stretch (ignore ratio)'],
];

export function start(root) {
  // Top-level layout: a tab strip inside the panel that swaps the
  // active sub-tool's UI into the workspace below. Each sub-tool owns
  // its own settings, so they don't fight for shared state.
  const panel = h('div', { class: 'tool-converter' }, [
    buildSubTabBar(),
    h('div', { class: 'converter-stage', id: 'converterStage' }),
  ]);

  root.append(panel);

  const subTabs = ['photos', 'pdf-md', 'pdf-images', 'shrink'];
  let active = subTabs[0];
  const subRoots = new Map();

  function renderActive() {
    const stage = panel.querySelector('#converterStage');
    clear(stage);
    if (subRoots.has(active)) {
      stage.append(subRoots.get(active));
    } else {
      const subRoot = buildSubTool(active);
      subRoots.set(active, subRoot);
      stage.append(subRoot);
    }
    // Sync the sub-tab visual state.
    panel.querySelectorAll('.converter-subtab').forEach((b) => {
      const isActive = b.dataset.subtab === active;
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  // Wire the sub-tab strip.
  panel.querySelectorAll('.converter-subtab').forEach((button) => {
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

// ---------------------------------------------------------------------------
// Sub-tab bar (Photos, PDF → MD, PDF → Images, Shrink Images)
// ---------------------------------------------------------------------------

function buildSubTabBar() {
  return h('div', { class: 'converter-subtabs', role: 'tablist', 'aria-label': 'Converter sub-tools' }, [
    subtabButton('photos', 'Photos → PDF', 'Turn a folder of images into a PDF.'),
    subtabButton('pdf-md', 'PDF → Markdown', 'Pull the text out of a PDF as Markdown.'),
    subtabButton('pdf-images', 'PDF → Images', 'Save every page as a PNG or JPEG.'),
    subtabButton('shrink', 'Shrink Images', 'Re-encode a batch of images and bundle a ZIP.'),
  ]);
}

function subtabButton(id, label, sub) {
  return h('button', {
    type: 'button',
    class: 'converter-subtab',
    role: 'tab',
    'data-subtab': id,
    'aria-selected': 'false',
  }, [
    h('span', { class: 'converter-subtab-title' }, label),
    h('span', { class: 'converter-subtab-sub' }, sub),
  ]);
}

// ---------------------------------------------------------------------------
// Sub-tool: Photos → PDF
// ---------------------------------------------------------------------------

function buildSubTool(id) {
  if (id === 'photos') return buildPhotosToPdf();
  if (id === 'pdf-md') return buildPdfToMarkdown();
  if (id === 'pdf-images') return buildPdfToImages();
  if (id === 'shrink') return buildShrinkImages();
  throw new Error(`Unknown sub-tool: ${id}`);
}

// Common layout for sub-tools: a settings card on the left, a file
// list / drop zone on the right, a single primary action button below.
function buildSubLayout({ title, hint, settings, actionLabel, onAction }) {
  return h('div', { class: 'converter-sub' }, [
    h('div', { class: 'converter-sub-head' }, [
      h('h3', null, title),
      h('p', null, hint),
    ]),
    h('div', { class: 'converter-sub-body' }, [
      h('aside', { class: 'converter-settings' }, settings),
      h('section', { class: 'converter-files' }, [
        h('div', { class: 'converter-drop', 'data-drop': 'true' }, [
          dropIcon(),
          h('strong', null, 'Drop files here'),
          h('span', null, 'or use the file picker below'),
          h('button', { class: 'button button-light', type: 'button', 'data-pick': 'true' }, 'Choose files'),
        ]),
        h('div', { class: 'converter-file-list', 'data-files': 'true' }),
      ]),
    ]),
    h('div', { class: 'converter-sub-foot' }, [
      h('span', { class: 'converter-sub-status', 'data-status': 'true' }, 'No files yet.'),
      h('button', { class: 'button button-export', type: 'button', 'data-action': 'true' }, [
        actionIcon(),
        h('span', null, actionLabel),
      ]),
    ]),
  ]);
}

function buildPhotosToPdf() {
  const settings = [
    selectRow('Paper', 'paper', PAPER_SIZES.map((p) => [p, PAPER_LABELS[p] || p])),
    selectRow('Orientation', 'orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']]),
    selectRow('Margin', 'margin', [
      ['comfortable', 'Comfortable'],
      ['compact', 'Compact'],
      ['wide', 'Wide'],
    ]),
    selectRow('Fit', 'fit', FIT_MODES),
    rangeRow('JPEG quality', 'quality', 60, 100, 92, '%'),
    h('label', { class: 'toggle-row' }, [
      h('input', { type: 'checkbox', 'data-toggle': 'sort-by-name', checked: true }),
      h('span', null, 'Sort files by name before packing'),
    ]),
  ];

  const layout = buildSubLayout({
    title: 'Photos → PDF',
    hint: 'One image per page. JPEG and PNG are the common cases, but anything the browser can decode works.',
    settings,
    actionLabel: 'Build PDF',
    onAction: photosToPdfAction,
  });

  const state = { files: [], paper: 'a4', orientation: 'portrait', margin: 'comfortable', fit: 'contain', quality: 92, sortByName: true };
  wireFilesDropzone(layout, state, { accept: 'image/*', multiple: true });
  wireSettings(layout, state, {
    paper: 'paper',
    orientation: 'orientation',
    margin: 'margin',
    fit: 'fit',
    quality: 'quality',
    'sort-by-name': 'sortByName',
  });
  layout.querySelector('[data-action]').addEventListener('click', () => photosToPdfAction(layout, state));
  return layout;
}

async function photosToPdfAction(layout, state) {
  if (!state.files.length) {
    showToast('Add some photos first.', { error: true });
    return;
  }
  const status = layout.querySelector('[data-status]');
  const button = layout.querySelector('[data-action]');
  setBusy(button, true, 'Building PDF…');
  status.textContent = `Encoding ${state.files.length} image${state.files.length === 1 ? '' : 's'}…`;

  try {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.create();

    // PDF "pt" units: 1 inch = 72 pt, paper is given in mm.
    const dims = paperDimensions(state.paper, state.orientation);
    const pageW = mmToPx(dims.width);   // CSS px
    const pageH = mmToPx(dims.height);
    const margin = MARGIN_PRESETS_PX[state.margin] || MARGIN_PRESETS_PX.comfortable;
    const innerW = pageW - margin.left - margin.right;
    const innerH = pageH - margin.top - margin.bottom;

    // Sort by name if requested, so a folder of `01-…`, `02-…` lands
    // in order even if the picker returned them in a different one.
    const files = state.sortByName
      ? [...state.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      : state.files;

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      status.textContent = `Packing ${i + 1} of ${files.length} — ${file.name}`;
      const page = doc.addPage([pageW, pageH]);
      const ctx = page.node || page; // pdf-lib doesn't expose a context, so we draw via the page's draw methods below.

      const bytes = new Uint8Array(await file.arrayBuffer());
      let image;
      if (/png/i.test(file.type) || /\.png$/i.test(file.name)) {
        image = await doc.embedPng(bytes);
      } else {
        // Everything else (jpeg, webp, gif) goes through embedJpg,
        // which is the common path. WebP isn't directly supported by
        // pdf-lib; fall back to a canvas re-encode for it.
        if (/webp/i.test(file.type) || /\.webp$/i.test(file.name)) {
          const jpeg = await reencodeToJpeg(file, state.quality);
          image = await doc.embedJpg(jpeg);
        } else {
          image = await doc.embedJpg(bytes);
        }
      }
      const placed = placeImage(image, { width: innerW, height: innerH }, state.fit);
      page.drawImage(image, {
        x: margin.left + placed.x,
        y: margin.top + placed.y,
        width: placed.w,
        height: placed.h,
      });
    }

    const bytesOut = await doc.save();
    const baseName = deriveBaseName(state.files.map((f) => f.name)) || 'photos';
    downloadBlob(new Blob([bytesOut], { type: 'application/pdf' }), `${baseName}.pdf`);
    status.textContent = `Done — ${state.files.length} page${state.files.length === 1 ? '' : 's'} packed into ${baseName}.pdf (${formatBytes(bytesOut.length)}).`;
    showToast(`Saved ${baseName}.pdf`);
  } catch (error) {
    console.error('Photos → PDF failed:', error);
    status.textContent = error && error.message ? error.message : 'Something went wrong.';
    showToast('Could not build the PDF.', { error: true });
  } finally {
    setBusy(button, false, 'Build PDF');
  }
}

function placeImage(image, box, fit) {
  const { width: iw, height: ih } = image.scale(1);
  const { width: bw, height: bh } = box;
  let drawW, drawH, x, y;
  if (fit === 'stretch') {
    drawW = bw;
    drawH = bh;
    x = 0;
    y = 0;
  } else {
    const ratio = Math.min(bw / iw, bh / ih);
    if (fit === 'cover') {
      const big = Math.max(bw / iw, bh / ih);
      drawW = iw * big;
      drawH = ih * big;
    } else {
      drawW = iw * ratio;
      drawH = ih * ratio;
    }
    x = (bw - drawW) / 2;
    y = (bh - drawH) / 2;
  }
  return { x, y, w: drawW, h: drawH };
}

async function reencodeToJpeg(file, quality) {
  const dataUrl = await readFileDataURL(file);
  const img = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return dataUrlToBytes(canvas.toDataURL('image/jpeg', quality / 100));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be decoded.'));
    img.src = src;
  });
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Sub-tool: PDF → Markdown
// ---------------------------------------------------------------------------

function buildPdfToMarkdown() {
  const settings = [
    selectRow('Pages', 'pages', [['all', 'All pages'], ['range', 'A range…']]),
    textRow('From / to', 'range', '1', '1-N (e.g. 2-9)'),
    h('label', { class: 'toggle-row' }, [
      h('input', { type: 'checkbox', 'data-toggle': 'page-markers', checked: true }),
      h('span', null, 'Insert `<!-- page: N -->` markers between pages'),
    ]),
    h('label', { class: 'toggle-row' }, [
      h('input', { type: 'checkbox', 'data-toggle': 'heuristic-headings', checked: true }),
      h('span', null, 'Try to detect headings from line breaks'),
    ]),
  ];

  const layout = buildSubLayout({
    title: 'PDF → Markdown',
    hint: 'Choose a single PDF. The text layer is extracted; scanned pages come back empty (OCR is on the bench for later).',
    settings,
    actionLabel: 'Convert',
    onAction: pdfToMarkdownAction,
  });

  const state = { files: [], pages: 'all', range: '', pageMarkers: true, heuristicHeadings: true };
  wireFilesDropzone(layout, state, { accept: 'application/pdf,.pdf', multiple: false });
  wireSettings(layout, state, {
    pages: 'pages',
    range: 'range',
    'page-markers': 'pageMarkers',
    'heuristic-headings': 'heuristicHeadings',
  });
  // Hide the range field unless "A range…" is selected.
  const rangeRow = layout.querySelector('[data-setting="range"]')?.closest('label');
  if (rangeRow) {
    const sync = () => { rangeRow.style.opacity = state.pages === 'range' ? '1' : '0.45'; rangeRow.style.pointerEvents = state.pages === 'range' ? 'auto' : 'none'; };
    sync();
    layout.querySelector('[data-setting="pages"]').addEventListener('change', () => { sync(); });
  }
  layout.querySelector('[data-action]').addEventListener('click', () => pdfToMarkdownAction(layout, state));
  return layout;
}

async function pdfToMarkdownAction(layout, state) {
  if (!state.files.length) {
    showToast('Choose a PDF first.', { error: true });
    return;
  }
  const status = layout.querySelector('[data-status]');
  const button = layout.querySelector('[data-action]');
  setBusy(button, true, 'Reading…');
  status.textContent = `Loading ${state.files[0].name}…`;

  try {
    const pdfjs = await loadPdfJs();
    const data = await readFileBytes(state.files[0]);
    const loadingTask = pdfjs.getDocument({ data });
    const pdf = await loadingTask.promise;
    const total = pdf.numPages;
    const range = state.pages === 'range' ? parseRange(state.range, total) : null;
    if (range && !range.length) throw new Error('The page range did not match any page.');
    const indices = range ? range : Array.from({ length: total }, (_, i) => i + 1);
    const parts = [];
    for (let i = 0; i < indices.length; i += 1) {
      const pageNum = indices[i];
      status.textContent = `Reading page ${i + 1} of ${indices.length} (${pageNum}/${total})…`;
      const page = await pdf.getPage(pageNum);
      const text = await page.getTextContent();
      const md = textContentToMarkdown(text, { heuristicHeadings: state.heuristicHeadings });
      if (state.pageMarkers) {
        if (parts.length) parts.push('');
        parts.push(`<!-- page: ${pageNum} -->`);
        parts.push('');
      }
      parts.push(md);
    }
    const out = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    const blob = new Blob([out], { type: 'text/markdown;charset=utf-8' });
    const baseName = state.files[0].name.replace(/\.pdf$/i, '') || 'document';
    downloadBlob(blob, `${baseName}.md`);
    status.textContent = `Done — ${indices.length} page${indices.length === 1 ? '' : 's'} into ${baseName}.md (${formatBytes(blob.size)}).`;
    showToast(`Saved ${baseName}.md`);
    // Keep the document open for the user; don't tear down pdf.js here.
  } catch (error) {
    console.error('PDF → Markdown failed:', error);
    status.textContent = error && error.message ? error.message : 'Could not read the PDF.';
    showToast('Could not read the PDF.', { error: true });
  } finally {
    setBusy(button, false, 'Convert');
  }
}

function parseRange(text, total) {
  if (!text) return null;
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

function textContentToMarkdown(textContent, { heuristicHeadings }) {
  if (!textContent || !textContent.items || !textContent.items.length) return '';
  // pdf.js gives us items with .str, .transform (for font size), and
  // .hasEOL. We group by approximate Y coordinate to reconstruct
  // paragraphs, then heuristically promote larger text to headings.
  const items = textContent.items.filter((it) => typeof it.str === 'string');
  if (!items.length) return '';

  // Bucket by line: items within ~2px of each other in Y are the same
  // physical line on the page.
  const lines = [];
  let current = null;
  for (const item of items) {
    const y = item.transform ? item.transform[5] : 0;
    const fontHeight = item.transform ? Math.abs(item.transform[3] || item.height || 0) : 0;
    if (!current || Math.abs(current.y - y) > Math.max(2, fontHeight * 0.4)) {
      current = { y, height: fontHeight, parts: [] };
      lines.push(current);
    }
    current.parts.push({ str: item.str, height: fontHeight, eol: !!item.hasEOL });
  }

  // Figure out the most common line height so we can spot "big" lines
  // that probably correspond to headings.
  const heights = lines.map((l) => l.height).filter((h) => h > 0);
  const baseline = heights.length ? median(heights) : 12;

  const out = [];
  let prevBlank = true;
  for (const line of lines) {
    const text = line.parts.map((p) => p.str).join('').replace(/\s+/g, ' ').trim();
    if (!text) { prevBlank = true; continue; }
    let level = 0;
    if (heuristicHeadings && line.height > 0) {
      const ratio = line.height / baseline;
      if (ratio >= 1.8) level = 1;
      else if (ratio >= 1.45) level = 2;
      else if (ratio >= 1.2) level = 3;
    }
    if (level > 0) {
      if (!prevBlank) out.push('');
      out.push(`${'#'.repeat(level)} ${text}`);
    } else {
      out.push(text);
    }
    prevBlank = false;
  }
  return out.join('\n');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Sub-tool: PDF → Images
// ---------------------------------------------------------------------------

function buildPdfToImages() {
  const settings = [
    selectRow('Format', 'format', [['png', 'PNG (lossless)'], ['jpeg', 'JPEG (smaller)']]),
    rangeRow('DPI', 'dpi', 72, 300, 144, 'dpi'),
    selectRow('Pages', 'pages', [['all', 'All pages'], ['range', 'A range…']]),
    textRow('From / to', 'range', '1', '1-N (e.g. 2-9)'),
    rangeRow('JPEG quality', 'quality', 50, 100, 90, '%'),
  ];

  const layout = buildSubLayout({
    title: 'PDF → Images',
    hint: 'Rasterise every page of a PDF to PNG or JPEG at the DPI you choose. PNG is lossless; JPEG produces a ZIP for a smaller bundle.',
    settings,
    actionLabel: 'Render images',
    onAction: pdfToImagesAction,
  });

  const state = { files: [], format: 'png', dpi: 144, pages: 'all', range: '', quality: 90 };
  wireFilesDropzone(layout, state, { accept: 'application/pdf,.pdf', multiple: false });
  wireSettings(layout, state, {
    format: 'format',
    dpi: 'dpi',
    pages: 'pages',
    range: 'range',
    quality: 'quality',
  });

  // Disable the quality row unless JPEG is selected.
  const qualityRow = layout.querySelector('[data-setting="quality"]')?.closest('label');
  const sync = () => {
    if (!qualityRow) return;
    const off = state.format !== 'jpeg';
    qualityRow.style.opacity = off ? '0.45' : '1';
    qualityRow.style.pointerEvents = off ? 'none' : 'auto';
  };
  sync();
  layout.querySelector('[data-setting="format"]').addEventListener('change', sync);

  const rangeRowEl = layout.querySelector('[data-setting="range"]')?.closest('label');
  if (rangeRowEl) {
    const syncRange = () => {
      const off = state.pages !== 'range';
      rangeRowEl.style.opacity = off ? '0.45' : '1';
      rangeRowEl.style.pointerEvents = off ? 'none' : 'auto';
    };
    syncRange();
    layout.querySelector('[data-setting="pages"]').addEventListener('change', syncRange);
  }

  layout.querySelector('[data-action]').addEventListener('click', () => pdfToImagesAction(layout, state));
  return layout;
}

async function pdfToImagesAction(layout, state) {
  if (!state.files.length) {
    showToast('Choose a PDF first.', { error: true });
    return;
  }
  const status = layout.querySelector('[data-status]');
  const button = layout.querySelector('[data-action]');
  setBusy(button, true, 'Rendering…');
  status.textContent = `Loading ${state.files[0].name}…`;

  try {
    const pdfjs = await loadPdfJs();
    const { zip } = await loadFflate();
    const data = await readFileBytes(state.files[0]);
    const pdf = await pdfjs.getDocument({ data }).promise;
    const total = pdf.numPages;
    const range = state.pages === 'range' ? parseRange(state.range, total) : null;
    if (range && !range.length) throw new Error('The page range did not match any page.');
    const indices = range ? range : Array.from({ length: total }, (_, i) => i + 1);
    const baseName = state.files[0].name.replace(/\.pdf$/i, '') || 'document';
    const mime = state.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const ext = state.format === 'jpeg' ? 'jpg' : 'png';
    const scale = state.dpi / 72;

    const filesForZip = [];
    for (let i = 0; i < indices.length; i += 1) {
      const pageNum = indices[i];
      status.textContent = `Rendering page ${i + 1} of ${indices.length} (${pageNum}/${total})…`;
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      // pdf.js refuses a second render task on a canvas it has painted
      // before; allocate a fresh one per page (README note).
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, state.quality / 100));
      const ab = await blob.arrayBuffer();
      const name = `${baseName}-page-${String(pageNum).padStart(3, '0')}.${ext}`;
      if (state.format === 'jpeg' || indices.length > 1) {
        filesForZip.push({ name, data: new Uint8Array(ab) });
      } else {
        // Single PNG: download directly so the user gets a file, not
        // a 1-entry zip.
        downloadBlob(blob, name);
        status.textContent = `Done — ${name} (${formatBytes(blob.size)}).`;
        showToast(`Saved ${name}`);
        setBusy(button, false, 'Render images');
        return;
      }
    }

    if (state.format === 'png' && filesForZip.length > 1) {
      // PNG as a ZIP — the user asked for a folder of images, so
      // bundling them avoids 30 separate downloads.
      const zipped = zip(Object.fromEntries(filesForZip.map((f) => [f.name, f.data])));
      downloadBlob(new Blob([zipped], { type: 'application/zip' }), `${baseName}-pages.zip`);
      status.textContent = `Done — ${filesForZip.length} PNGs bundled into ${baseName}-pages.zip (${formatBytes(filesForZip.reduce((s, f) => s + f.data.length, 0))} before zip).`;
      showToast(`Saved ${baseName}-pages.zip`);
    } else {
      // JPEG or single PNG already downloaded above.
      const total = filesForZip.reduce((s, f) => s + f.data.length, 0);
      status.textContent = `Done — ${filesForZip.length} image${filesForZip.length === 1 ? '' : 's'} saved (${formatBytes(total)}).`;
    }
  } catch (error) {
    console.error('PDF → Images failed:', error);
    status.textContent = error && error.message ? error.message : 'Could not render the PDF.';
    showToast('Could not render the PDF.', { error: true });
  } finally {
    setBusy(button, false, 'Render images');
  }
}

// ---------------------------------------------------------------------------
// Sub-tool: Shrink Images
// ---------------------------------------------------------------------------

function buildShrinkImages() {
  const settings = [
    rangeRow('Max edge', 'maxEdge', 400, 6000, 1920, 'px'),
    rangeRow('JPEG quality', 'quality', 30, 100, 75, '%'),
    selectRow('Output format', 'format', [['jpeg', 'JPEG'], ['webp', 'WebP'], ['keep', 'Keep original format']]),
    h('label', { class: 'toggle-row' }, [
      h('input', { type: 'checkbox', 'data-toggle': 'bundle-zip', checked: true }),
      h('span', null, 'Bundle into a single ZIP (recommended for >1 file)'),
    ]),
  ];

  const layout = buildSubLayout({
    title: 'Shrink Images',
    hint: 'Re-encode images so they take less space. The original filenames are kept inside the ZIP so a folder of `IMG_1234.jpg` stays a folder of `IMG_1234.jpg`.',
    settings,
    actionLabel: 'Shrink',
    onAction: shrinkImagesAction,
  });

  const state = { files: [], maxEdge: 1920, quality: 75, format: 'jpeg', bundleZip: true };
  wireFilesDropzone(layout, state, { accept: 'image/*', multiple: true });
  wireSettings(layout, state, {
    maxEdge: 'maxEdge',
    quality: 'quality',
    format: 'format',
    'bundle-zip': 'bundleZip',
  });
  layout.querySelector('[data-action]').addEventListener('click', () => shrinkImagesAction(layout, state));
  return layout;
}

async function shrinkImagesAction(layout, state) {
  if (!state.files.length) {
    showToast('Add some images first.', { error: true });
    return;
  }
  const status = layout.querySelector('[data-status]');
  const button = layout.querySelector('[data-action]');
  setBusy(button, true, 'Shrinking…');
  status.textContent = `Processing ${state.files.length} image${state.files.length === 1 ? '' : 's'}…`;

  try {
    const { zip, strToU8 } = await loadFflate();
    const out = [];
    let totalIn = 0;
    let totalOut = 0;
    for (let i = 0; i < state.files.length; i += 1) {
      const file = state.files[i];
      totalIn += file.size;
      status.textContent = `Processing ${i + 1} of ${state.files.length} — ${file.name}`;
      const targetType = pickOutputType(file, state.format);
      const reencoded = await shrinkOne(file, { maxEdge: state.maxEdge, quality: state.quality, type: targetType });
      totalOut += reencoded.length;
      out.push({ name: renameToExt(file.name, targetType), data: reencoded });
    }

    if (state.bundleZip || state.files.length > 1) {
      const zipped = zip(Object.fromEntries(out.map((f) => [f.name, f.data])));
      const baseName = deriveBaseName(state.files.map((f) => f.name)) || 'images';
      downloadBlob(new Blob([zipped], { type: 'application/zip' }), `${baseName}-shrunk.zip`);
      status.textContent = `Done — ${state.files.length} image${state.files.length === 1 ? '' : 's'}, ${formatBytes(totalIn)} → ${formatBytes(totalOut)} (${ratio(totalIn, totalOut)}).`;
      showToast(`Saved ${baseName}-shrunk.zip`);
    } else {
      // Single file, no zip.
      const only = out[0];
      const blob = new Blob([only.data], { type: guessMimeFromName(only.name) });
      downloadBlob(blob, only.name);
      status.textContent = `Done — ${only.name} (${formatBytes(only.data.length)}).`;
      showToast(`Saved ${only.name}`);
    }
  } catch (error) {
    console.error('Shrink failed:', error);
    status.textContent = error && error.message ? error.message : 'Could not shrink the images.';
    showToast('Could not shrink the images.', { error: true });
  } finally {
    setBusy(button, false, 'Shrink');
  }
}

function pickOutputType(file, format) {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  // Keep original.
  if (file.type) return file.type;
  return 'image/jpeg';
}

function renameToExt(name, mime) {
  const base = name.replace(/\.[^.]+$/, '');
  if (mime === 'image/jpeg') return `${base}.jpg`;
  if (mime === 'image/webp') return `${base}.webp`;
  if (mime === 'image/png') return `${base}.png`;
  return name;
}

function guessMimeFromName(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'png') return 'image/png';
  return 'application/octet-stream';
}

async function shrinkOne(file, { maxEdge, quality, type }) {
  const dataUrl = await readFileDataURL(file);
  const img = await loadImage(dataUrl);
  let { naturalWidth: w, naturalHeight: h } = img;
  const longEdge = Math.max(w, h);
  if (longEdge > maxEdge) {
    const scale = maxEdge / longEdge;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrlOut = canvas.toDataURL(type, quality / 100);
  return dataUrlToBytes(dataUrlOut);
}

function ratio(before, after) {
  if (!before) return '—';
  const r = after / before;
  return `${(r * 100).toFixed(0)}% of original`;
}

function deriveBaseName(names) {
  if (!names.length) return null;
  // Try to find a common prefix: if all files share "01-name" and the
  // only thing that varies is the leading index, return the prefix.
  // Otherwise, fall back to the first name minus its trailing index.
  const stripped = names.map((n) => n.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]*/, ''));
  if (stripped.every((s) => s === stripped[0])) return sanitizeFilename(stripped[0]) || 'bundle';
  // Pick the longest common prefix.
  let prefix = stripped[0] || '';
  for (const s of stripped.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return sanitizeFilename(prefix.replace(/[-_.\s]+$/, '')) || 'bundle';
}

// ---------------------------------------------------------------------------
// Shared dropzone / settings / file-list plumbing
// ---------------------------------------------------------------------------

function wireFilesDropzone(layout, state, { accept, multiple }) {
  const drop = layout.querySelector('[data-drop]');
  const list = layout.querySelector('[data-files]');
  const pick = layout.querySelector('[data-pick]');
  const status = layout.querySelector('[data-status]');

  const render = () => {
    clear(list);
    if (!state.files.length) {
      status.textContent = 'No files yet.';
    } else {
      status.textContent = `${state.files.length} file${state.files.length === 1 ? '' : 's'} ready (${formatBytes(state.files.reduce((s, f) => s + f.size, 0))}).`;
    }
    state.files.forEach((file, index) => {
      const row = h('div', { class: 'converter-file-row' }, [
        h('span', { class: 'converter-file-name' }, file.name),
        h('span', { class: 'converter-file-size' }, formatBytes(file.size)),
        h('button', {
          type: 'button',
          class: 'converter-file-remove',
          'aria-label': `Remove ${file.name}`,
          title: 'Remove',
        }, '×'),
      ]);
      row.querySelector('button').addEventListener('click', () => {
        state.files.splice(index, 1);
        render();
      });
      list.append(row);
    });
  };

  const addFiles = (files) => {
    const list = Array.from(files || []);
    if (!multiple) {
      state.files = list.slice(0, 1);
    } else {
      state.files.push(...list);
    }
    render();
  };

  pick.addEventListener('click', async () => {
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

  render();
}

function wireSettings(layout, state, mapping) {
  for (const [domKey, stateKey] of Object.entries(mapping)) {
    const el = layout.querySelector(`[data-setting="${domKey}"]`);
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
  return h('label', { class: 'converter-row' }, [
    h('span', { class: 'converter-row-label' }, label),
    h('span', { class: 'converter-row-control' }, [
      h('select', { 'data-setting': key },
        options.map(([value, name]) => h('option', { value }, name))
      ),
      chevronDown(),
    ]),
  ]);
}

function textRow(label, key, placeholder, hint) {
  return h('label', { class: 'converter-row' }, [
    h('span', { class: 'converter-row-label' }, label),
    h('span', { class: 'converter-row-control' }, [
      h('input', { type: 'text', 'data-setting': key, placeholder, autocomplete: 'off', spellcheck: 'false' }),
      hint ? h('span', { class: 'converter-row-hint' }, hint) : null,
    ]),
  ]);
}

function rangeRow(label, key, min, max, value, unit) {
  return h('label', { class: 'converter-row' }, [
    h('span', { class: 'converter-row-label' }, label),
    h('span', { class: 'converter-row-control converter-row-range' }, [
      h('input', { type: 'range', min, max, value, 'data-setting': key, 'data-unit': unit }),
      h('span', { class: 'converter-row-value', 'data-range-value': 'true' }, `${value}${unit}`),
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

function chevronDown() {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    h('path', { d: 'm4.5 6.25 3.5 3.5 3.5-3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  );
}

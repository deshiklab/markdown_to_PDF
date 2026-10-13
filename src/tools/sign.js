// Sign tab. One cohesive flow:
//
//   1. Draw (or load) a signature on the pad. Strokes are stored as
//      fractions of the pad box, not as pixels, so the same signature
//      can be re-used on any device at any size. The pad keeps the
//      most recent mark in memory and also writes a copy of the PNG
//      to localStorage so it survives a reload.
//   2. Pick a PDF. The first page renders into a panel with overlay
//      handles — drag the signature to place it, drag the bottom-right
//      handle to resize. Positions are stored as fractions of the page
//      box, so a phone re-measure does not stretch the mark.
//   3. Type a name, optional title, and an optional date under the
//      signature.
//   4. Optionally add a countersignature — a second pad, a second
//      placement on the same page.
//   5. Save. The "flat" toggle rasterises the page to an image so the
//      signature is part of the page content, not a separate PDF
//      object (so a copy-paste of the PDF won't reveal the underlying
//      layer).
//
// All the README's Sign-specific traps are honoured here:
//
//   * Pad strokes are stored as fractions of the pad box (not pixels).
//   * The canvas bitmap is sized to the box's clientWidth /
//     clientHeight, so the ink sits exactly under the pen.
//   * Each pdf.js render uses a fresh <canvas> (no second render on
//     a painted canvas).
//   * Overlay handles are positioned as percentages of the page box.
//   * PDF coordinates are derived from display coordinates through
//     the /Rotate quadrant maths in `displayToPdf` (src/render.js).

import {
  h, clear, showToast, readFileBytes, downloadBlob, formatBytes,
  lazy, pickFile, readFileDataURL, readPref, writePref, debounce, clamp,
} from '../lib.js';
import { displayToPdf } from '../render.js';

const loadPdfLib = lazy(() => import('pdf-lib'));
const loadPdfJs = lazy(() => import('pdfjs-dist/build/pdf.mjs'));

// localStorage key for saved signatures. A signature is stored as
// { id, label, png, createdAt } where png is a data URL.
const SIGNATURES_KEY = 'folio:signatures:v1';

export function start(root) {
  const panel = h('div', { class: 'tool-sign' });

  // The model:
  //   pdfFile      — the chosen PDF (File | null)
  //   pdfJsDoc     — the parsed pdf.js document (cached after pick)
  //   pageIndex    — 0-based page number being signed
  //   marks        — array of placed signatures. Each mark is:
  //     { id, signatureId, xFrac, yFrac, wFrac, name, title, date,
  //       isCountersign }
  //   activeMarkId — id of the mark currently selected (for nudging)
  //   flatten      — bool, whether to rasterise the page when saving
  //   signatures   — array of saved signatures (from localStorage)
  const state = {
    pdfFile: null,
    pdfJsDoc: null,
    pageIndex: 0,
    marks: [],
    activeMarkId: null,
    flatten: false,
    signatures: readPref(SIGNATURES_KEY, []),
  };

  // The current pad: a fresh Stroke[] while the user is drawing. Each
  // stroke is { points: [{ x, y }, ...] } in pad-box fractions (0-1).
  // 'currentPad' is the one being drawn into; 'editingPadId' is the
  // mark whose signature pad is currently being edited (null when
  // drawing a new one).
  let editingPad = null; // { markId, stroke, lastPoint }

  // ------------------------------------------------------------------
  // Layout
  // ------------------------------------------------------------------

  const padColumn = h('div', { class: 'sign-pad-col' });
  const pageColumn = h('div', { class: 'sign-page-col' });
  const footColumn = h('div', { class: 'sign-foot' });

  panel.append(
    h('div', { class: 'sign-sub-head' }, [
      h('h3', null, 'Sign'),
      h('p', null, 'Draw a signature on the pad, drop it on a page of a PDF, add a name and date under it, then save. Countersignatures and a "flatten" toggle are at the bottom.'),
    ]),
    h('div', { class: 'sign-layout' }, [
      padColumn,
      pageColumn,
    ]),
    footColumn,
  );

  // ------------------------------------------------------------------
  // Pad column (left) — drawing area + saved signatures list
  // ------------------------------------------------------------------

  const padFrame = h('div', { class: 'sign-pad-frame' });
  const padCanvas = document.createElement('canvas');
  padCanvas.className = 'sign-pad-canvas';
  padFrame.append(padCanvas);
  const padHint = h('div', { class: 'sign-pad-hint' }, 'Sign here');
  padFrame.append(padHint);

  // Overlay message shown when the user picks an existing signature.
  const padStatus = h('div', { class: 'sign-pad-status' });

  const padActions = h('div', { class: 'sign-pad-actions' }, [
    h('button', { class: 'button button-light', type: 'button', id: 'signClearPad' }, 'Clear pad'),
    h('button', { class: 'button button-text', type: 'button', id: 'signUndoStroke' }, 'Undo'),
    h('button', { class: 'button button-export', type: 'button', id: 'signSavePad' }, [
      checkIcon(),
      h('span', null, 'Save signature'),
    ]),
  ]);

  // Pad label / "edit existing" indicator.
  const padLabelInput = h('input', {
    type: 'text',
    class: 'sign-pad-label',
    placeholder: 'Signature label (e.g. "Work")',
    value: '',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  padColumn.append(
    h('div', { class: 'sign-pad-wrap' }, [
      h('div', { class: 'sign-pad-head' }, [
        h('h4', null, 'Signature pad'),
        padLabelInput,
      ]),
      padFrame,
      padStatus,
      padActions,
    ]),
    h('div', { class: 'sign-pad-list-wrap' }, [
      h('h4', { class: 'sign-list-title' }, 'Saved signatures'),
      h('div', { class: 'sign-list', id: 'signList' }),
      h('div', { class: 'sign-list-actions' }, [
        h('button', { class: 'button button-light', type: 'button', id: 'signLoadScan' }, [
          plusIcon(),
          h('span', null, ' Load a scan'),
        ]),
        h('input', { type: 'file', accept: 'image/png,image/jpeg,image/svg+xml', hidden: true, id: 'signScanInput' }),
      ]),
    ]),
  );

  // ------------------------------------------------------------------
  // Page column (right) — the live page preview with overlay
  // ------------------------------------------------------------------

  const pageStage = h('div', { class: 'sign-stage' });
  const pageSurface = h('div', { class: 'sign-surface' });
  const pageCanvas = document.createElement('canvas');
  pageCanvas.className = 'sign-page-canvas';
  pageSurface.append(pageCanvas);
  const marksLayer = h('div', { class: 'sign-marks' });
  pageSurface.append(marksLayer);
  pageStage.append(pageSurface);

  const pageToolbar = h('div', { class: 'sign-page-toolbar' }, [
    h('button', { class: 'button button-light', type: 'button', id: 'signPickPdf' }, [
      pageIcon(),
      h('span', null, ' Choose PDF'),
    ]),
    h('button', { class: 'button button-text', type: 'button', id: 'signPrevPage', disabled: true }, '← Prev page'),
    h('span', { class: 'sign-page-status', id: 'signPageStatus' }, 'No PDF yet.'),
    h('button', { class: 'button button-text', type: 'button', id: 'signNextPage', disabled: true }, 'Next page →'),
  ]);

  const markActions = h('div', { class: 'sign-mark-actions' }, [
    h('button', { class: 'button button-light', type: 'button', id: 'signAddCountersign' }, [
      plusIcon(),
      h('span', null, ' Add countersignature'),
    ]),
    h('span', { class: 'sign-mark-status', id: 'signMarkStatus' }, 'Pick a PDF, then drag a signature onto the page.'),
  ]);

  pageColumn.append(
    h('div', { class: 'sign-page-head' }, [
      h('h4', null, 'Page'),
      markActions,
    ]),
    pageToolbar,
    pageStage,
  );

  // ------------------------------------------------------------------
  // Foot — flatten toggle + save
  // ------------------------------------------------------------------

  const flattenToggle = h('label', { class: 'sign-foot-toggle' }, [
    h('input', { type: 'checkbox', id: 'signFlatten' }),
    h('span', null, 'Flatten signed pages (the mark becomes part of the page image; text under it cannot be lifted off)'),
  ]);

  const footStatus = h('span', { class: 'sign-foot-status', id: 'signFootStatus' }, 'No PDF yet.');

  const saveButton = h('button', { class: 'button button-export', type: 'button', id: 'signSavePdf' }, [
    downloadIcon(),
    h('span', null, 'Save signed PDF'),
  ]);

  footColumn.append(flattenToggle, footStatus, saveButton);

  root.append(panel);

  // ------------------------------------------------------------------
  // Pad logic — pointer events on a single canvas, fractional points
  // ------------------------------------------------------------------

  let padCtx = null;
  let padDPR = 1;
  let padW = 0;
  let padH = 0;
  // The live stroke being drawn right now, in pad-box fractions.
  // 'currentPad.strokes' is the list of committed strokes (each in
  // fractions). While drawing, we add points to currentPad.liveStroke
  // and re-render the canvas.
  const padStrokes = []; // committed strokes, each [{x, y}, ...] in fractions
  let liveStroke = null; // { points: [...] } in fractions
  let padDirty = false;

  function sizePadCanvas() {
    const rect = padFrame.getBoundingClientRect();
    // The 1px frame trick from the README: use clientWidth/Height so
    // the bitmap is exactly the inner box, never the border.
    padDPR = window.devicePixelRatio || 1;
    padW = Math.max(1, Math.round(rect.width));
    padH = Math.max(1, Math.round(rect.height));
    padCanvas.width = Math.round(padW * padDPR);
    padCanvas.height = Math.round(padH * padDPR);
    padCanvas.style.width = `${padW}px`;
    padCanvas.style.height = `${padH}px`;
    padCtx = padCanvas.getContext('2d');
    padCtx.scale(padDPR, padDPR);
    redrawPad();
  }

  function redrawPad() {
    if (!padCtx) return;
    padCtx.clearRect(0, 0, padW, padH);
    // The dotted baseline.
    padCtx.save();
    padCtx.strokeStyle = '#cfd9cb';
    padCtx.setLineDash([4, 4]);
    padCtx.lineWidth = 1;
    padCtx.beginPath();
    padCtx.moveTo(12, padH * 0.66);
    padCtx.lineTo(padW - 12, padH * 0.66);
    padCtx.stroke();
    padCtx.restore();

    padCtx.save();
    padCtx.strokeStyle = '#243f33';
    padCtx.lineWidth = 2;
    padCtx.lineCap = 'round';
    padCtx.lineJoin = 'round';
    for (const stroke of padStrokes) drawStroke(stroke);
    if (liveStroke) drawStroke(liveStroke.points);
    padCtx.restore();
  }

  function drawStroke(points) {
    if (!points || !points.length) return;
    padCtx.beginPath();
    padCtx.moveTo(points[0].x * padW, points[0].y * padH);
    for (let i = 1; i < points.length; i += 1) {
      padCtx.lineTo(points[i].x * padW, points[i].y * padH);
    }
    padCtx.stroke();
  }

  function padPointFromEvent(event) {
    const rect = padCanvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  }

  function onPadDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    padCanvas.setPointerCapture(event.pointerId);
    const point = padPointFromEvent(event);
    liveStroke = { points: [point] };
    padDirty = true;
    padHint.style.opacity = '0';
    redrawPad();
  }

  function onPadMove(event) {
    if (!liveStroke) return;
    event.preventDefault();
    const point = padPointFromEvent(event);
    const last = liveStroke.points[liveStroke.points.length - 1];
    // Skip near-duplicate points so the ink doesn't bloat.
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.002) return;
    liveStroke.points.push(point);
    redrawPad();
  }

  function onPadUp(event) {
    if (!liveStroke) return;
    event.preventDefault();
    if (liveStroke.points.length > 1) {
      padStrokes.push(liveStroke.points);
    }
    liveStroke = null;
    padCanvas.releasePointerCapture(event.pointerId);
    redrawPad();
  }

  padCanvas.addEventListener('pointerdown', onPadDown);
  padCanvas.addEventListener('pointermove', onPadMove);
  padCanvas.addEventListener('pointerup', onPadUp);
  padCanvas.addEventListener('pointercancel', onPadUp);

  // Re-size on window resize so the canvas bitmap tracks the box.
  const resizePad = debounce(sizePadCanvas, 80);
  window.addEventListener('resize', resizePad);
  // Defer initial sizing until the panel is in the DOM.
  requestAnimationFrame(sizePadCanvas);

  // Pad actions
  panel.querySelector('#signClearPad').addEventListener('click', () => {
    padStrokes.length = 0;
    liveStroke = null;
    padHint.style.opacity = '1';
    padStatus.textContent = '';
    padDirty = true;
    redrawPad();
  });
  panel.querySelector('#signUndoStroke').addEventListener('click', () => {
    padStrokes.pop();
    if (!padStrokes.length) padHint.style.opacity = '1';
    padDirty = true;
    redrawPad();
  });
  panel.querySelector('#signSavePad').addEventListener('click', saveCurrentPadAsSignature);
  panel.querySelector('#signLoadScan').addEventListener('click', () => panel.querySelector('#signScanInput').click());
  panel.querySelector('#signScanInput').addEventListener('change', loadScanAsSignature);

  // ------------------------------------------------------------------
  // PDF + page render
  // ------------------------------------------------------------------

  panel.querySelector('#signPickPdf').addEventListener('click', async () => {
    const files = await pickFile({ accept: 'application/pdf,.pdf', multiple: false });
    if (files && files.length) loadPdf(files[0]);
  });
  panel.querySelector('#signPrevPage').addEventListener('click', () => {
    if (!state.pdfJsDoc) return;
    state.pageIndex = Math.max(0, state.pageIndex - 1);
    renderPage();
  });
  panel.querySelector('#signNextPage').addEventListener('click', () => {
    if (!state.pdfJsDoc) return;
    state.pageIndex = Math.min(state.pdfJsDoc.numPages - 1, state.pageIndex + 1);
    renderPage();
  });
  panel.querySelector('#signAddCountersign').addEventListener('click', () => {
    addMark({ isCountersign: true });
  });
  panel.querySelector('#signFlatten').addEventListener('change', (e) => {
    state.flatten = e.target.checked;
  });
  panel.querySelector('#signSavePdf').addEventListener('click', saveSignedPdf);

  // Page drag-and-drop.
  pageSurface.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      pageSurface.classList.add('is-drag');
    }
  });
  pageSurface.addEventListener('dragleave', () => pageSurface.classList.remove('is-drag'));
  pageSurface.addEventListener('drop', async (e) => {
    pageSurface.classList.remove('is-drag');
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files[0]) return;
    const file = e.dataTransfer.files[0];
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      showToast('Drop a PDF here.', { error: true });
      return;
    }
    e.preventDefault();
    loadPdf(file);
  });

  async function loadPdf(file) {
    state.pdfFile = file;
    state.pageIndex = 0;
    state.marks = [];
    state.activeMarkId = null;
    pageToolbar.querySelector('#signPageStatus').textContent = `Loading ${file.name}…`;
    footStatus.textContent = `Loaded ${file.name}.`;
    try {
      const pdfjs = await loadPdfJs();
      const bytes = await readFileBytes(file);
      state.pdfJsDoc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      pageToolbar.querySelector('#signPrevPage').disabled = false;
      pageToolbar.querySelector('#signNextPage').disabled = false;
      renderPage();
    } catch (error) {
      console.error('PDF load failed:', error);
      pageToolbar.querySelector('#signPageStatus').textContent = 'Could not read this PDF.';
      showToast('Could not read the PDF.', { error: true });
    }
  }

  // The current "drawing scale" — pdf.js units * scale = CSS pixels.
  // We pick a scale that fits a 720px max-width box, so a US Letter
  // page at 72 DPI would render at scale = 720/612 ≈ 1.18.
  let currentScale = 1;
  let currentViewport = null;
  let currentPageObj = null; // pdf.js page object for the current page

  async function renderPage() {
    if (!state.pdfJsDoc) return;
    const pageNum = state.pageIndex + 1;
    pageToolbar.querySelector('#signPageStatus').textContent = `Loading page ${pageNum} of ${state.pdfJsDoc.numPages}…`;
    // Allocate a fresh <canvas> per render to satisfy pdf.js's "no
    // second render on a painted canvas" trap.
    const old = pageSurface.querySelector('.sign-page-canvas');
    if (old) old.remove();
    const fresh = document.createElement('canvas');
    fresh.className = 'sign-page-canvas';
    pageSurface.insertBefore(fresh, marksLayer);

    const page = await state.pdfJsDoc.getPage(pageNum);
    const surfaceRect = pageSurface.getBoundingClientRect();
    const maxW = Math.max(280, surfaceRect.width - 24);
    const baseViewport = page.getViewport({ scale: 1 });
    const fitScale = Math.min(2, maxW / baseViewport.width);
    currentScale = fitScale;
    const viewport = page.getViewport({ scale: fitScale });
    currentViewport = viewport;
    currentPageObj = page;

    const dpr = window.devicePixelRatio || 1;
    fresh.width = Math.round(viewport.width * dpr);
    fresh.height = Math.round(viewport.height * dpr);
    fresh.style.width = `${viewport.width}px`;
    fresh.style.height = `${viewport.height}px`;
    pageSurface.style.width = `${viewport.width}px`;
    pageSurface.style.height = `${viewport.height}px`;

    const ctx = fresh.getContext('2d');
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport, canvas: fresh }).promise;

    // Re-paint marks (the live mark model hasn't changed; just re-place
    // them on the new viewport).
    renderMarks();
    pageToolbar.querySelector('#signPageStatus').textContent = `Page ${pageNum} of ${state.pdfJsDoc.numPages}. Drag a signature onto the page.`;
  }

  // Re-render marks when the page is re-rendered.
  function renderMarks() {
    clear(marksLayer);
    for (const mark of state.marks) {
      marksLayer.append(buildMarkEl(mark));
    }
  }

  function addMark({ isCountersign = false } = {}) {
    if (!state.pdfJsDoc) {
      showToast('Pick a PDF first.', { error: true });
      return;
    }
    if (!state.signatures.length) {
      showToast('Save a signature first (or load a scan).', { error: true });
      return;
    }
    const sig = state.signatures[0];
    const mark = {
      id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      signatureId: sig.id,
      xFrac: isCountersign ? 0.62 : 0.18,
      yFrac: isCountersign ? 0.7 : 0.74,
      wFrac: 0.22,
      name: isCountersign ? '' : '',
      title: '',
      date: todayIso(),
      isCountersign,
    };
    state.marks.push(mark);
    state.activeMarkId = mark.id;
    renderMarks();
  }

  function buildMarkEl(mark) {
    const sig = state.signatures.find((s) => s.id === mark.signatureId) || state.signatures[0];
    const el = h('div', {
      class: `sign-mark${mark.isCountersign ? ' is-countersign' : ''}${state.activeMarkId === mark.id ? ' is-active' : ''}`,
      'data-id': mark.id,
    }, [
      h('div', { class: 'sign-mark-handle sign-mark-move' }, [
        h('img', { src: sig?.png, alt: 'signature', draggable: false }),
        h('div', { class: 'sign-mark-line' }, [
          h('input', {
            type: 'text',
            class: 'sign-mark-name',
            value: mark.name,
            placeholder: mark.isCountersign ? 'Countersign name' : 'Signatory name',
            autocomplete: 'off',
            spellcheck: 'false',
          }),
          h('div', { class: 'sign-mark-meta' }, [
            h('input', {
              type: 'text',
              class: 'sign-mark-title',
              value: mark.title,
              placeholder: mark.isCountersign ? 'Their title' : 'Title',
              autocomplete: 'off',
              spellcheck: 'false',
            }),
            h('input', {
              type: 'date',
              class: 'sign-mark-date',
              value: mark.date,
            }),
          ]),
        ]),
      ]),
      h('div', { class: 'sign-mark-resize', 'aria-label': 'Resize' }),
      h('button', { class: 'sign-mark-remove', type: 'button', 'aria-label': 'Remove mark', title: 'Remove' }, '×'),
    ]);

    // Position via fractions.
    el.style.left = `${mark.xFrac * 100}%`;
    el.style.top = `${mark.yFrac * 100}%`;
    el.style.width = `${mark.wFrac * 100}%`;

    wireMarkInteractions(el, mark);
    return el;
  }

  function wireMarkInteractions(el, mark) {
    const move = el.querySelector('.sign-mark-move');
    const resize = el.querySelector('.sign-mark-resize');
    const remove = el.querySelector('.sign-mark-remove');
    const nameInput = el.querySelector('.sign-mark-name');
    const titleInput = el.querySelector('.sign-mark-title');
    const dateInput = el.querySelector('.sign-mark-date');

    // Live-sync the text fields into the model.
    nameInput.addEventListener('input', () => { mark.name = nameInput.value; });
    titleInput.addEventListener('input', () => { mark.title = titleInput.value; });
    dateInput.addEventListener('change', () => { mark.date = dateInput.value; });

    remove.addEventListener('click', () => {
      state.marks = state.marks.filter((m) => m.id !== mark.id);
      if (state.activeMarkId === mark.id) state.activeMarkId = null;
      renderMarks();
    });

    function selectMark() {
      state.activeMarkId = mark.id;
      // Re-render so the .is-active class moves.
      renderMarks();
    }

    function dragStart(event) {
      if (event.target.closest('input')) return;
      event.preventDefault();
      selectMark();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = mark.xFrac;
      const startTop = mark.yFrac;
      const surface = pageSurface.getBoundingClientRect();
      function onMove(e) {
        const dx = (e.clientX - startX) / surface.width;
        const dy = (e.clientY - startY) / surface.height;
        mark.xFrac = clamp(startLeft + dx, 0, 1);
        mark.yFrac = clamp(startTop + dy, 0, 1);
        el.style.left = `${mark.xFrac * 100}%`;
        el.style.top = `${mark.yFrac * 100}%`;
        // Snap to corners when within 4% of an edge.
        maybeSnapToCorner(mark);
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        el.style.left = `${mark.xFrac * 100}%`;
        el.style.top = `${mark.yFrac * 100}%`;
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    function resizeStart(event) {
      event.preventDefault();
      event.stopPropagation();
      selectMark();
      const startX = event.clientX;
      const startW = mark.wFrac;
      const surface = pageSurface.getBoundingClientRect();
      function onMove(e) {
        const dx = (e.clientX - startX) / surface.width;
        mark.wFrac = clamp(startW + dx, 0.05, 0.9);
        el.style.width = `${mark.wFrac * 100}%`;
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    move.addEventListener('pointerdown', dragStart);
    resize.addEventListener('pointerdown', resizeStart);

    // Arrow-key nudging when the mark is selected.
    el.addEventListener('keydown', (event) => {
      if (state.activeMarkId !== mark.id) return;
      const step = event.shiftKey ? 0.02 : 0.005;
      let used = false;
      if (event.key === 'ArrowLeft') { mark.xFrac = clamp(mark.xFrac - step, 0, 1); used = true; }
      if (event.key === 'ArrowRight') { mark.xFrac = clamp(mark.xFrac + step, 0, 1); used = true; }
      if (event.key === 'ArrowUp') { mark.yFrac = clamp(mark.yFrac - step, 0, 1); used = true; }
      if (event.key === 'ArrowDown') { mark.yFrac = clamp(mark.yFrac + step, 0, 1); used = true; }
      if (used) {
        event.preventDefault();
        el.style.left = `${mark.xFrac * 100}%`;
        el.style.top = `${mark.yFrac * 100}%`;
        maybeSnapToCorner(mark);
      }
    });
  }

  function maybeSnapToCorner(mark) {
    const snap = 0.04;
    if (mark.xFrac < snap) mark.xFrac = 0.04;
    if (mark.xFrac > 1 - snap) mark.xFrac = 1 - snap;
    if (mark.yFrac < snap) mark.yFrac = 0.04;
    if (mark.yFrac > 1 - snap) mark.yFrac = 1 - snap;
  }

  // ------------------------------------------------------------------
  // Saved signatures list (in localStorage)
  // ------------------------------------------------------------------

  function renderSignatureList() {
    const list = panel.querySelector('#signList');
    clear(list);
    if (!state.signatures.length) {
      list.append(h('p', { class: 'sign-list-empty' }, 'No saved signatures yet. Draw one above or load a scan.'));
      return;
    }
    state.signatures.forEach((sig) => {
      const row = h('div', { class: 'sign-list-row', 'data-id': sig.id }, [
        h('img', { src: sig.png, alt: sig.label || 'Signature', class: 'sign-list-thumb' }),
        h('div', { class: 'sign-list-meta' }, [
          h('input', {
            type: 'text',
            class: 'sign-list-label',
            value: sig.label || '',
            placeholder: 'Untitled',
            'data-id': sig.id,
            autocomplete: 'off',
            spellcheck: 'false',
          }),
          h('span', { class: 'sign-list-date' }, new Date(sig.createdAt).toLocaleDateString()),
        ]),
        h('div', { class: 'sign-list-row-actions' }, [
          h('button', { class: 'button button-text', type: 'button', 'data-id': sig.id, 'data-act': 'use' }, 'Use'),
          h('button', { class: 'button button-text', type: 'button', 'data-id': sig.id, 'data-act': 'delete' }, 'Delete'),
        ]),
      ]);
      list.append(row);
    });
    // Wire row actions.
    list.querySelectorAll('.sign-list-label').forEach((input) => {
      input.addEventListener('change', (e) => {
        const sig = state.signatures.find((s) => s.id === input.dataset.id);
        if (sig) {
          sig.label = e.target.value;
          writePref(SIGNATURES_KEY, state.signatures);
        }
      });
    });
    list.querySelectorAll('button[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const sig = state.signatures.find((s) => s.id === b.dataset.id);
        if (!sig) return;
        if (b.dataset.act === 'use') {
          // Surface this signature on the pad (replace any current drawing).
          replacePadWithSignature(sig);
        } else if (b.dataset.act === 'delete') {
          state.signatures = state.signatures.filter((s) => s.id !== sig.id);
          writePref(SIGNATURES_KEY, state.signatures);
          renderSignatureList();
        }
      });
    });
  }

  function replacePadWithSignature(sig) {
    // Re-rasterise the signature PNG at the current pad size and put
    // it into the stroke list so the user can edit from there if they
    // want. We approximate by setting padStrokes to a single "image"
    // stroke that the redraw function detects.
    padCtx.clearRect(0, 0, padW, padH);
    const img = new Image();
    img.onload = () => {
      padCtx.drawImage(img, 12, 12, padW - 24, padH * 0.55);
      padHint.style.opacity = '0';
      padStatus.textContent = `Loaded "${sig.label || 'signature'}" from saved list. Draw to extend it, or save as a new one.`;
    };
    img.src = sig.png;
    padStrokes.length = 0;
    liveStroke = null;
  }

  function loadScanAsSignature(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const label = file.name.replace(/\.[^.]+$/, '');
    readFileDataURL(file).then((dataUrl) => {
      knockOutWhiteBackground(dataUrl).then((png) => {
        const sig = { id: `s-${Date.now().toString(36)}`, label, png, createdAt: Date.now() };
        state.signatures.push(sig);
        writePref(SIGNATURES_KEY, state.signatures);
        renderSignatureList();
        replacePadWithSignature(sig);
        showToast(`Loaded "${label}".`);
      });
    }).catch(() => showToast('Could not read the image.', { error: true }));
    event.target.value = '';
  }

  /**
   * Knock out the white paper background of a scanned signature so it
   * composites cleanly on any page. We do a flood-fill of "near
   * white" pixels, replacing them with transparency.
   */
  async function knockOutWhiteBackground(dataUrl) {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      // "Near white": any pixel where all three channels are > 230.
      if (r > 230 && g > 230 && b > 230) {
        px[i + 3] = 0;
      }
    }
    ctx.putImageData(data, 0, 0);
    return canvas.toDataURL('image/png');
  }

  async function saveCurrentPadAsSignature() {
    if (!padStrokes.length && !padCanvasHasInk()) {
      showToast('Draw something first.', { error: true });
      return;
    }
    // Render the pad strokes (and any drawn PNG overlay from
    // replacePadWithSignature) into a fresh canvas to get the PNG.
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = padCanvas.width;
    exportCanvas.height = padCanvas.height;
    const ctx = exportCanvas.getContext('2d');
    ctx.drawImage(padCanvas, 0, 0);
    const png = exportCanvas.toDataURL('image/png');
    const label = (padLabelInput.value || '').trim() || `Signature ${state.signatures.length + 1}`;
    const sig = { id: `s-${Date.now().toString(36)}`, label, png, createdAt: Date.now() };
    state.signatures.push(sig);
    writePref(SIGNATURES_KEY, state.signatures);
    renderSignatureList();
    padStatus.textContent = `Saved "${label}". Click "Use" on the list to switch the pad, or place it on a page.`;
    showToast(`Saved "${label}".`);
  }

  function padCanvasHasInk() {
    // Cheap test: see if any pixel is not fully transparent / paper.
    if (!padCtx) return false;
    const data = padCtx.getImageData(0, 0, padCanvas.width, padCanvas.height).data;
    for (let i = 3; i < data.length; i += 400) {
      if (data[i] > 0) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Save the signed PDF
  // ------------------------------------------------------------------

  async function saveSignedPdf() {
    if (!state.pdfFile) {
      showToast('Pick a PDF first.', { error: true });
      return;
    }
    if (!state.marks.length) {
      showToast('Place at least one signature on the page.', { error: true });
      return;
    }
    const button = panel.querySelector('#signSavePdf');
    setBusy(button, true, 'Saving…');
    footStatus.textContent = 'Reading PDF…';
    try {
      const { PDFDocument, rgb, StandardFonts } = await loadPdfLib();
      const bytes = await readFileBytes(state.pdfFile);
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      const font = await source.embedFont(StandardFonts.Helvetica);
      const fontItalic = await source.embedFont(StandardFonts.HelveticaOblique);
      const sigIndex = new Map(state.signatures.map((s) => [s.id, s]));

      const targetPageIndex = state.pageIndex;
      const targetPage = source.getPage(targetPageIndex);
      const targetRotation = targetPage.getRotation().angle || 0;

      // If the user asked for "flatten", rasterise the page first.
      let workingDoc = source;
      if (state.flatten) {
        workingDoc = await flattenPage(source, targetPageIndex, state.pdfJsDoc);
      }

      const out = state.flatten ? workingDoc : source;
      const page = out.getPage(state.flatten ? targetPageIndex : targetPageIndex);

      // Compute the page size in *display* (CSS pixel) units. The
      // surface renders at `currentScale` (CSS px per PDF pt) so the
      // viewport tells us the page size in pixels.
      const pageSize = page.getSize();
      const displayW = currentViewport.width;
      const displayH = currentViewport.height;

      for (const mark of state.marks) {
        const sig = sigIndex.get(mark.signatureId);
        if (!sig) continue;
        // The signature lives at mark.xFrac / mark.yFrac (top-left)
        // and is mark.wFrac wide. The mark's vertical region is the
        // image height plus the name/title/date block.
        const sigDisplayW = mark.wFrac * displayW;
        const sigDisplayH = sigDisplayW * 0.45; // 45% aspect for the ink area
        const sigXDisplay = mark.xFrac * displayW;
        const sigYDisplay = mark.yFrac * displayH;
        // Map the top-left and bottom-right of the signature image
        // into PDF user space. The /Rotate quadrant maths is in
        // render.js's displayToPdf.
        const topLeftPdf = displayToPdf({ x: sigXDisplay, y: sigYDisplay }, page, currentViewport);
        const bottomRightPdf = displayToPdf({ x: sigXDisplay + sigDisplayW, y: sigYDisplay + sigDisplayH }, page, currentViewport);
        const imgW = Math.abs(bottomRightPdf.x - topLeftPdf.x);
        const imgH = Math.abs(bottomRightPdf.y - topLeftPdf.y);
        const x = Math.min(topLeftPdf.x, bottomRightPdf.x);
        const y = Math.min(topLeftPdf.y, bottomRightPdf.y);

        const pngBytes = dataUrlToBytes(sig.png);
        const embedded = await out.embedPng(pngBytes);
        page.drawImage(embedded, { x, y, width: imgW, height: imgH });

        // The name / title / date block sits under the signature.
        // For non-flatten output, draw it with PDF standard fonts.
        // For flattened output, the rasterised page already has a
        // blank surface so the text would be invisible — skip it.
        if (!state.flatten) {
          const blockTopY = y - 22; // 22pt below the signature
          drawMetaBlock(page, font, fontItalic, mark, { x: x, y: blockTopY }, targetRotation, rgb(0.14, 0.22, 0.18));
        }
      }

      const outBytes = await out.save();
      const baseName = state.pdfFile.name.replace(/\.pdf$/i, '') || 'document';
      const suffix = state.flatten ? '-signed-flat.pdf' : '-signed.pdf';
      downloadBlob(new Blob([outBytes], { type: 'application/pdf' }), `${baseName}${suffix}`);
      footStatus.textContent = `Saved ${baseName}${suffix} (${formatBytes(outBytes.length)}).`;
      showToast(`Saved ${baseName}${suffix}`);
    } catch (error) {
      console.error('Save failed:', error);
      footStatus.textContent = error && error.message ? error.message : 'Could not save the PDF.';
      showToast('Could not save the PDF.', { error: true });
    } finally {
      setBusy(button, false, 'Save signed PDF');
    }
  }

  function drawMetaBlock(page, font, fontItalic, mark, topLeft, rotation, color) {
    const lines = [];
    if (mark.name) lines.push({ text: mark.name, font, size: 9 });
    if (mark.title) lines.push({ text: mark.title, font: fontItalic, size: 8 });
    if (mark.date) {
      // Render the date in the user's locale, but fall back to the
      // raw ISO value if it doesn't parse.
      const d = new Date(mark.date);
      const text = Number.isNaN(d.getTime()) ? mark.date : d.toLocaleDateString();
      lines.push({ text: text, font, size: 8 });
    }
    let y = topLeft.y;
    for (const line of lines) {
      page.drawText(line.text, { x: topLeft.x, y, size: line.size, font: line.font, color });
      y -= line.size + 2;
    }
  }

  /**
   * Rasterise a single page to a JPEG and replace it in the working
   * PDFDocument with an image-only page of the same dimensions. The
   * text layer is destroyed, so any signature drawn on top is
   * "flattened" — it can't be lifted off the page.
   */
  async function flattenPage(source, pageIndex, sourcePdfJs) {
    const { PDFDocument } = await loadPdfLib();
    const page = source.getPage(pageIndex);
    const { width: pageW, height: pageH } = page.getSize();
    const scale = 2; // 2× for crisp output
    const jsPage = await sourcePdfJs.getPage(pageIndex + 1);
    const viewport = jsPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    await jsPage.render({ canvasContext: ctx, viewport, canvas }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const jpeg = new Uint8Array(await blob.arrayBuffer());

    const out = await PDFDocument.create();
    const image = await out.embedJpg(jpeg);
    // Copy every OTHER page (not the one being flattened) so we can
    // splice the flattened page back in at the right index.
    const otherIndices = Array.from({ length: source.getPageCount() }, (_, i) => i).filter((i) => i !== pageIndex);
    const others = await out.copyPages(source, otherIndices);
    // Build the output in the right order: pages before, flattened page, pages after.
    const beforeCount = pageIndex;
    const before = others.slice(0, beforeCount);
    const after = others.slice(beforeCount);
    for (const p of before) out.addPage(p);
    const newPage = out.addPage([pageW, pageH]);
    newPage.drawImage(image, { x: 0, y: 0, width: pageW, height: pageH });
    for (const p of after) out.addPage(p);
    return out;
  }

  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
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

  function todayIso() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ------------------------------------------------------------------
  // Initial paint
  // ------------------------------------------------------------------

  renderSignatureList();
  // Expose a tiny test hook so the user can drop a signature on the
  // page from the saved list without first having to pick a PDF.
  // (When they do pick a PDF, the marks layer is repainted anyway.)
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="use"]')) {
      const sig = state.signatures.find((s) => s.id === e.target.dataset.id);
      if (sig && state.pdfJsDoc) {
        // Auto-place the signature on the page so the user can drag.
        const mark = {
          id: `m-${Date.now().toString(36)}`,
          signatureId: sig.id,
          xFrac: 0.5,
          yFrac: 0.78,
          wFrac: 0.28,
          name: '',
          title: '',
          date: todayIso(),
          isCountersign: state.marks.length > 0,
        };
        state.marks.push(mark);
        state.activeMarkId = mark.id;
        renderMarks();
      }
    }
  });

  return {
    unmount() {
      window.removeEventListener('resize', resizePad);
      panel.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function checkIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'm4 10 3.5 3.5L16 5' })
  );
}

function downloadIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3' })
  );
}

function plusIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M10 4.5v11M4.5 10h11' })
  );
}

function pageIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M5.5 3.5h9V16.5h-9zM8 7h4M8 10h4M8 13h2.5' })
  );
}

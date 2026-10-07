/* Converter — the everyday plumbing: photos into a PDF, a PDF back into text
   or images, and a quick image shrink. All local, all one click. */
import {
  bytes,
  debounce,
  downloadBlob,
  el,
  escapeHtml,
  hasFiles,
  loadPdfJs,
  loadPdfLib,
  pdfjsAssetOptions,
  makeZip,
  pickFiles,
  q,
  qa,
  safeFileName,
  store,
  toast,
} from '../lib.js';
import { onPage, page, printButton } from '../page.js';

const MODES = [
  { id: 'images', label: 'Photos → PDF', note: 'Build a clean PDF from images' },
  { id: 'text', label: 'PDF → text', note: '.txt, .md, .html, .doc' },
  { id: 'images-out', label: 'PDF → images', note: 'Every page as PNG or JPEG' },
  { id: 'shrink', label: 'Shrink images', note: 'Resize + recompress' },
];

const PAGES = { a4: [210, 297], letter: [215.9, 279.4], a5: [148, 210], a4l: [297, 210] };
const MM = 96 / 25.4;
const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';

const prefs = store('converter:v1', {
  mode: 'images',
  pageSize: 'a4',
  fit: 'contain',
  margin: 'strip',
  quality: 86,
  autoOrientation: true,
  capSize: 2400,
  textFormat: 'md',
  pageBreaks: true,
  imageFormat: 'png',
  imageScale: 2,
  shrinkMax: 2000,
  shrinkQuality: 80,
  shrinkFormat: 'jpeg',
});

const state = {
  form: { ...prefs.read() },
  images: [],
  pdfs: [],
  busy: false,
};

export function start(root) {
  root.innerHTML = layout();
  wire(root);
  paintMode(root);
  renderImages(root);
  renderPdf(root);
  return () => state.images.forEach((image) => URL.revokeObjectURL(image.url));
}

/* ------------------------------------------------------------------ ui ---- */
function layout() {
  return `
<div class="cv-shell" id="cvShell">
  <section class="panel cv-side" aria-labelledby="cv-side-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">01</span>
        <div><h3 id="cv-side-title">Input</h3><p id="cvSideNote">Drop it, we'll handle it</p></div>
      </div>
      <div class="panel-header-actions"><span class="lab-count" id="cvCount">nothing yet</span></div>
    </div>

    <div class="lab-drop" id="cvDrop" role="button" tabindex="0">
      <span class="dropzone-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="5" width="13.2" height="10" rx="1.4"/><circle cx="7.4" cy="8.8" r="1.1"/><path d="m4.6 13.6 3.4-3.2 2.4 2.2 2.5-2.4 3.1 3"/></svg></span>
      <strong id="cvDropTitle">Drop images here</strong>
      <span id="cvDropNote">JPG, PNG, WebP, GIF, HEIC if your browser decodes it</span>
      <span class="dropzone-button">Choose files</span>
    </div>

    <div class="cv-stage" data-stage="images" data-print-root>
      <ul class="cv-grid" id="cvGrid" role="list"></ul>
    </div>
    <div class="cv-stage" data-stage="pdf" data-print-root hidden>
      <ul class="cv-pdf-list" id="cvPdfList" role="list"></ul>
    </div>
  </section>

  <section class="panel cv-main" aria-labelledby="cv-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="cv-main-title">Output</h3><p><span class="live-dot"></span> Tune, then download</p></div>
      </div>
      <div class="panel-header-actions">${printButton()}<span class="lab-count" id="cvEstimate">—</span></div>
    </div>

    <div class="lab-modes cv-modes" role="group" aria-label="Converter mode">
      ${MODES.map((mode) => `<button type="button" class="lab-mode" data-cv-mode="${mode.id}" aria-pressed="false"><strong>${mode.label}</strong><small>${mode.note}</small></button>`).join('')}
    </div>

    <div class="lab-body">
      <div class="cv-panel" data-cv-panel="images">
        <div class="lab-row">
          <label class="field"><span class="field-label">Page</span>
            <select class="text-input" id="cvPageSize">
              <option value="a4">A4</option><option value="letter">US Letter</option><option value="a5">A5</option><option value="a4l">A4 landscape</option>
            </select>
          </label>
          <label class="field"><span class="field-label">Fit</span>
            <select class="text-input" id="cvFit"><option value="contain">Whole image</option><option value="cover">Fill the page</option><option value="page">Size the page to the image</option></select>
          </label>
          <label class="field"><span class="field-label">Margin</span>
            <select class="text-input" id="cvMargin"><option value="strip">From the page strip</option><option value="none">None</option><option value="small">Small (8mm)</option><option value="wide">Wide (18mm)</option></select>
          </label>
          <div class="field"><span class="field-label-row"><span class="field-label">Quality</span><output class="range-readout" id="cvQualityOut">86%</output></span><input class="range-input" id="cvQuality" type="range" min="40" max="100" step="1" /></div>
        </div>
        <p class="lab-hint" id="cvImagesHint">Add at least one image.</p>
        <div class="lab-actions"><span class="lab-hint" id="cvImagesNote"></span><button class="button button-export" type="button" id="cvImagesGo">${downloadIcon}<span>Download PDF</span></button></div>
      </div>

      <div class="cv-panel" data-cv-panel="text" hidden>
        <div class="lab-row">
          <label class="field"><span class="field-label">Format</span>
            <select class="text-input" id="cvTextFormat">
              <option value="md">Markdown (.md)</option><option value="txt">Plain text (.txt)</option><option value="html">Web page (.html)</option><option value="doc">Word (.doc)</option>
            </select>
          </label>
          <label class="field field-switch"><input type="checkbox" class="switch-input" id="cvPageBreaks" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Mark page breaks</span></label>
        </div>
        <p class="lab-help">Scanned pages have no text layer, so they come out empty. For those, use <em>PDF → images</em> and print the pages instead.</p>
        <pre class="cv-snippet" id="cvSnippet" aria-live="polite">No PDF chosen yet.</pre>
        <div class="lab-actions">
          <button class="button button-light" type="button" id="cvTextCopy"><span>Copy all</span></button>
          <button class="button button-export" type="button" id="cvTextGo">${downloadIcon}<span>Download</span></button>
        </div>
      </div>

      <div class="cv-panel" data-cv-panel="images-out" hidden>
        <div class="lab-row">
          <label class="field"><span class="field-label">Type</span>
            <select class="text-input" id="cvImageFormat"><option value="png">PNG (lossless)</option><option value="jpeg">JPEG (smaller)</option></select>
          </label>
          <label class="field"><span class="field-label">Resolution</span>
            <select class="text-input" id="cvImageScale"><option value="1">Screen (72 dpi)</option><option value="2">Print (150 dpi)</option><option value="3">Sharp (220 dpi)</option></select>
          </label>
          <div class="field"><span class="field-label-row"><span class="field-label">JPEG quality</span><output class="range-readout" id="cvShrinkQualityOut">80%</output></span><input class="range-input" id="cvOutQuality" type="range" min="40" max="100" /></div>
        </div>
        <p class="lab-hint" id="cvImagesOutHint">Pick a PDF above.</p>
        <div class="lab-actions"><span class="lab-hint" id="cvImagesOutNote"></span><button class="button button-export" type="button" id="cvImagesOutGo">${downloadIcon}<span>Download images</span></button></div>
      </div>

      <div class="cv-panel" data-cv-panel="shrink" hidden>
        <div class="lab-row">
          <label class="field"><span class="field-label">Type</span>
            <select class="text-input" id="cvShrinkFormat"><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select>
          </label>
          <label class="field"><span class="field-label">Longest side</span>
            <select class="text-input" id="cvShrinkMax"><option value="1200">1200 px</option><option value="1600">1600 px</option><option value="2000">2000 px</option><option value="2400">2400 px</option><option value="0">Keep size</option></select>
          </label>
          <div class="field"><span class="field-label-row"><span class="field-label">Quality</span><output class="range-readout" id="cvShrinkQ2Out">80%</output></span><input class="range-input" id="cvShrinkQuality" type="range" min="30" max="100" /></div>
        </div>
        <p class="lab-hint" id="cvShrinkHint">Add images and we'll show you the saving.</p>
        <ul class="cv-shrink-list" id="cvShrinkList" role="list"></ul>
        <div class="lab-actions"><span></span><button class="button button-export" type="button" id="cvShrinkGo">${downloadIcon}<span>Download shrunk images</span></button></div>
      </div>
    </div>
  </section>
</div>`;
}

function wire(root) {
  const save = debounce(() => prefs.write(state.form), 200);
  qa('[data-cv-mode]', root).forEach((node) => node.addEventListener('click', () => {
    state.form.mode = node.dataset.cvMode;
    save();
    paintMode(root);
  }));

  const bind = (id, key, cast = (value) => value, after) => {
    const node = q(`#${id}`, root);
    if (!node) return;
    if (key in state.form) {
      if (node.type === 'checkbox') node.checked = Boolean(state.form[key]);
      else node.value = state.form[key];
    }
    const handler = () => {
      state.form[key] = cast(node.type === 'checkbox' ? node.checked : node.value);
      save();
      after?.();
    };
    node.addEventListener('input', handler);
    node.addEventListener('change', handler);
  };
  bind('cvPageSize', 'pageSize', undefined, () => estimateImages(root));
  onPage(() => {
    // photo pages follow the strip while that option is chosen
    if (state.form.margin === 'strip') {
      const select = q('#cvMargin', root);
      if (select) select.value = 'strip';
    }
  });
  bind('cvFit', 'fit', undefined, () => estimateImages(root));
  bind('cvMargin', 'margin', undefined, () => estimateImages(root));
  bind('cvQuality', 'quality', Number, () => {
    q('#cvQualityOut', root).textContent = `${state.form.quality}%`;
    estimateImages(root);
  });
  bind('cvTextFormat', 'textFormat');
  bind('cvPageBreaks', 'pageBreaks', undefined, () => paintSnippet(root));
  bind('cvImageFormat', 'imageFormat', undefined, () => estimateOut(root));
  bind('cvImageScale', 'imageScale', Number, () => estimateOut(root));
  bind('cvOutQuality', 'quality', Number, () => {
    q('#cvShrinkQualityOut', root).textContent = `${state.form.quality}%`;
  });
  bind('cvShrinkFormat', 'shrinkFormat');
  bind('cvShrinkMax', 'shrinkMax', Number);
  bind('cvShrinkQuality', 'shrinkQuality', Number, () => {
    q('#cvShrinkQ2Out', root).textContent = `${state.form.shrinkQuality}%`;
  });

  const drop = q('#cvDrop', root);
  const open = () => pickFiles({ accept: acceptFor(state.form.mode), multiple: true }).then((files) => handleFiles(files, root));
  drop.addEventListener('click', open);
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  let depth = 0;
  drop.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    drop.classList.add('is-dragging');
  });
  drop.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  drop.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) drop.classList.remove('is-dragging');
  });
  drop.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    drop.classList.remove('is-dragging');
    handleFiles(Array.from(event.dataTransfer?.files || []), root);
  });

  q('#cvImagesGo', root)?.addEventListener('click', () => imagesToPdf(root));
  q('#cvTextGo', root)?.addEventListener('click', () => textOut(root));
  q('#cvTextCopy', root)?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(textBody(state.pdfs[0], state.form.textFormat));
      toast('Text copied.');
    } catch (error) {
      toast('Your browser blocked the clipboard — use the download instead.', true);
    }
  });
  q('#cvImagesOutGo', root)?.addEventListener('click', () => pagesToImages(root));
  q('#cvShrinkGo', root)?.addEventListener('click', () => shrinkImages(root));
}

function acceptFor(mode) {
  if (mode === 'images') return 'image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif';
  if (mode === 'shrink') return 'image/*';
  return 'application/pdf,.pdf';
}

async function handleFiles(files, root) {
  if (!files.length) return;
  const wantsPdf = state.form.mode === 'text' || state.form.mode === 'images-out';
  if (wantsPdf) {
    const pdfs = files.filter((file) => /\.pdf$/i.test(file.name));
    for (const file of pdfs) {
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        const doc = await loadPdfJs().then((pdfjs) => pdfjs.getDocument({ data: buffer.slice(0), isEvalSupported: false }).promise);
        const pages = [];
        for (let index = 1; index <= doc.numPages; index += 1) {
          const page = await doc.getPage(index);
          const content = await page.getTextContent();
          let text = '';
          let pending = '';
          for (const item of content.items) {
            if (!('str' in item)) continue;
            pending += item.str;
            if (item.hasEOL) {
              text += `${pending.trim()}\n`;
              pending = '';
            }
          }
          text += pending.trim();
          const viewport = page.getViewport({ scale: 1 });
          pages.push({ index, text: text.replace(/\n{3,}/g, '\n\n').trim(), width: viewport.width, height: viewport.height });
        }
        await doc.destroy?.();
        state.pdfs.push({ name: file.name, size: file.size, buffer, pages });
      } catch (error) {
        console.error(error);
        toast(`${file.name} could not be read.`, true);
      }
    }
    if (!pdfs.length) toast('That tab wants a .pdf file.', true);
    paintMode(root);
    paintSnippet(root);
    return;
  }
  const images = files.filter((file) => /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name));
  for (const file of images) {
    try {
      const url = URL.createObjectURL(file);
      const dims = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ image });
        image.onerror = () => reject(new Error('decode failed'));
        image.src = url;
      });
      state.images.push({
        id: `i${state.images.length + 1}`,
        name: file.name,
        size: file.size,
        type: file.type,
        url,
        file,
        width: dims.image.naturalWidth,
        height: dims.image.naturalHeight,
        rotation: 0,
      });
    } catch (error) {
      console.error(error);
      toast(`${file.name} could not be decoded.`, true);
    }
  }
  if (!images.length) toast('That tab wants image files.', true);
  paintMode(root);
  paintShrinkList(root);
}

/* ------------------------------------------------------------ painting ---- */
function paintMode(root) {
  q('#cvShell', root).dataset.mode = state.form.mode;
  root.classList.toggle('has-input', state.images.length + state.pdfs.length > 0);
  qa('[data-cv-mode]', root).forEach((node) => {
    const on = node.dataset.cvMode === state.form.mode;
    node.classList.toggle('is-on', on);
    node.setAttribute('aria-pressed', String(on));
  });
  qa('[data-cv-panel]', root).forEach((panel) => {
    panel.hidden = panel.dataset.cvPanel !== state.form.mode;
  });
  const needsPdf = state.form.mode === 'text' || state.form.mode === 'images-out';
  q('[data-stage="images"]', root).hidden = needsPdf;
  q('[data-stage="pdf"]', root).hidden = !needsPdf;
  q('#cvDropTitle', root).textContent = needsPdf ? 'Drop a PDF' : 'Drop images here';
  q('#cvDropNote', root).textContent = needsPdf ? 'We read it in the browser, never upload it' : 'JPG, PNG, WebP, GIF, AVIF — as many as you like';
  q('#cvCount', root).textContent = needsPdf
    ? state.pdfs.length
      ? `${state.pdfs.length} pdf`
      : 'no pdf yet'
    : state.images.length
      ? `${state.images.length} image${state.images.length === 1 ? '' : 's'}`
      : 'no images yet';
  renderImages(root);
  renderPdf(root);
  estimateImages(root);
  estimateOut(root);
  paintShrinkList(root);
  paintSideNote(root);
}

function paintSideNote(root) {
  const note = q('#cvSideNote', root);
  if (!note) return;
  const one = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const pages = state.pdfs.reduce((total, pdf) => total + pdf.pages.length, 0);
  if (state.form.mode === 'text' || state.form.mode === 'images-out') {
    note.textContent = state.pdfs.length ? `${one(state.pdfs.length, 'pdf')} · ${pages} ${pages === 1 ? 'page' : 'pages'} read locally` : 'One PDF, any page count';
  } else if (state.form.mode === 'shrink') {
    note.textContent = state.images.length ? `${one(state.images.length, 'image')} to squeeze · ${bytes(state.images.reduce((sum, image) => sum + (image.file?.size ?? image.size ?? 0), 0))}` : 'Drop the photos you want lighter';
  } else {
    note.textContent = state.images.length ? `${one(state.images.length, 'image')} ready — drag to reorder` : "Drop it, we'll handle it";
  }
}

function renderImages(root) {
  const list = q('#cvGrid', root);
  if (!list) return;
  list.innerHTML = '';
  if (!state.images.length) {
    list.append(el('li', { class: 'lab-empty', text: 'Images you add will show up here, in order.' }));
    return;
  }
  state.images.forEach((image, index) => {
    const item = el('li', { class: 'cv-cell', draggable: 'true', dataset: { index: String(index) } }, [
      el('span', { class: 'cv-cell-order', text: String(index + 1).padStart(2, '0') }),
      el('img', { src: image.url, alt: image.name, loading: 'lazy', style: `transform:rotate(${image.rotation}deg)` }),
      el('span', { class: 'cv-cell-foot' }, [
        el('small', { text: `${image.width}×${image.height}` }),
        el('small', { text: bytes(image.size) }),
      ]),
      el('span', { class: 'cv-cell-actions' }, [
        iconButton('Rotate right', 'spin', '<path d="M15.4 9.4a5.4 5.4 0 1 0-.6 3.4M15.8 4.6v4h-4"/>'),
        iconButton('Move left', 'left', '<path d="M12.5 5.5 8 10l4.5 4.5"/>'),
        iconButton('Move right', 'right', '<path d="M7.5 5.5 12 10l-4.5 4.5"/>'),
        iconButton('Remove', 'del', '<path d="M6.2 6.2l7.6 7.6m0-7.6-7.6 7.6"/>'),
      ]),
    ]);
    item.addEventListener('click', (event) => {
      const target = event.target.closest('[data-act]');
      if (!target) return;
      const act = target.dataset.act;
      if (act === 'spin') image.rotation = (image.rotation + 90) % 360;
      else if (act === 'left' && index > 0) [state.images[index - 1], state.images[index]] = [state.images[index], state.images[index - 1]];
      else if (act === 'right' && index < state.images.length - 1) [state.images[index + 1], state.images[index]] = [state.images[index], state.images[index + 1]];
      else if (act === 'del') {
        URL.revokeObjectURL(image.url);
        state.images.splice(index, 1);
      }
      paintMode(root);
      paintShrinkList(root);
    });
    item.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      item.classList.add('is-dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('is-dragging'));
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      item.classList.add('is-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('is-over'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      item.classList.remove('is-over');
      const from = Number(event.dataTransfer.getData('text/plain'));
      if (!Number.isFinite(from) || from === index) return;
      const [moved] = state.images.splice(from, 1);
      state.images.splice(index, 0, moved);
      renderImages(root);
    });
    list.append(item);
  });
  paintSideNote(root);
}

function renderPdf(root) {
  const list = q('#cvPdfList', root);
  if (!list) return;
  list.innerHTML = '';
  if (!state.pdfs.length) {
    list.append(el('li', { class: 'lab-empty', text: 'Add a PDF to extract its text or pages.' }));
    return;
  }
  state.pdfs.forEach((pdf, index) => {
    const item = el('li', { class: 'lab-file' }, [
      el('div', { class: 'lab-file-row' }, [
        el('span', { class: 'lab-file-order', text: String(index + 1).padStart(2, '0') }),
        el('div', { class: 'lab-file-meta' }, [
          el('strong', { text: pdf.name, title: pdf.name }),
          el('small', { text: `${pdf.pages.length} pages · ${bytes(pdf.size)} · ${countWords(pdf)} words` }),
        ]),
        el('div', { class: 'lab-file-actions' }, [el('button', { type: 'button', class: 'button button-light lab-mini is-danger', text: 'Remove', dataset: { drop: String(index) } })]),
      ]),
    ]);
    item.querySelector('[data-drop]')?.addEventListener('click', () => {
      state.pdfs.splice(index, 1);
      renderPdf(root);
      paintSnippet(root);
    });
    list.append(item);
  });
  paintSideNote(root);
}

function countWords(pdf) {
  return pdf.pages.reduce((sum, page) => sum + (page.text.match(/\S+/g)?.length ?? 0), 0);
}

function iconButton(label, act, path) {
  return el('button', { type: 'button', class: 'lab-icon-button', dataset: { act }, 'aria-label': label, title: label, html: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">${path}</svg>` });
}

/* ----------------------------------------------------------- estimates ---- */
function estimateImages(root) {
  const hint = q('#cvImagesHint', root);
  const note = q('#cvImagesNote', root);
  if (!hint) return;
  const count = state.images.length;
  if (!count) {
    hint.textContent = 'Add at least one image.';
    if (note) note.textContent = '';
    return;
  }
  const total = state.images.reduce((sum, image) => sum + image.size, 0);
  hint.textContent = `${count} ${count === 1 ? 'image' : 'images'} → ${count}-page PDF · sources ${bytes(total)}`;
  if (note) note.textContent = `Page: ${(PAGES[state.form.pageSize] ?? PAGES.a4).join(' × ')} mm`;
}

function estimateOut(root) {
  const hint = q('#cvImagesOutHint', root);
  if (!hint) return;
  const pdf = state.pdfs[0];
  if (!pdf) {
    hint.textContent = 'Pick a PDF above.';
    return;
  }
  const scale = Number(state.form.imageScale) || 2;
  hint.textContent = `${pdf.pages.length} pages at roughly ${Math.round(595 * scale)}×${Math.round(842 * scale)} px each`;
}

function paintShrinkList(root) {
  const list = q('#cvShrinkList', root);
  if (!list) return;
  list.innerHTML = '';
  const items = state.images.length ? state.images : [];
  if (!items.length) {
    list.append(el('li', { class: 'lab-empty', text: 'Add images to see the saving.' }));
    return;
  }
  items.forEach((image) => {
    list.append(
      el('li', { class: 'cv-shrink-row' }, [
        el('img', { src: image.url, alt: '', loading: 'lazy' }),
        el('span', { class: 'cv-shrink-name' }, [el('strong', { text: image.name }), el('small', { text: `${image.width}×${image.height} · ${bytes(image.size)}` })]),
        el('span', { class: 'cv-shrink-when', text: 'ready' }),
      ]),
    );
  });
}

/* -------------------------------------------------------------- helpers ---- */
async function withBusy(root, id, label, work) {
  if (state.busy) return;
  const node = q(id, root);
  const original = node.innerHTML;
  state.busy = true;
  node.disabled = true;
  node.innerHTML = `<span class="export-spinner" aria-hidden="true"></span><span>${label}</span>`;
  try {
    await work();
  } catch (error) {
    console.error(error);
    toast(error?.message || 'That did not work.', true);
  } finally {
    state.busy = false;
    node.disabled = false;
    node.innerHTML = original;
  }
}

async function ensureDecoded(image) {
  if (image.element?.complete && image.element.naturalWidth) return image.element;
  const node = new Image();
  node.src = image.url;
  await (node.decode ? node.decode().catch(() => {}) : new Promise((resolve) => {
    node.onload = resolve;
    node.onerror = resolve;
  }));
  image.element = node;
  return node;
}

/** Paint an image element onto a canvas at a bounded size, then read it back. */
function raster(element, { maxSide = 0, quality = 85, format = 'jpeg', rotation = 0 } = {}) {
  const naturalWidth = element.naturalWidth || 1;
  const naturalHeight = element.naturalHeight || 1;
  const swapped = Math.abs(rotation % 180) === 90;
  const boxWidth = swapped ? naturalHeight : naturalWidth;
  const boxHeight = swapped ? naturalWidth : naturalHeight;
  const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(boxWidth, boxHeight)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(boxWidth * scale));
  canvas.height = Math.max(1, Math.round(boxHeight * scale));
  const context = canvas.getContext('2d');
  const type = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
  if (type !== 'image/png') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((rotation * Math.PI) / 180);
  const drawWidth = swapped ? canvas.height : canvas.width;
  const drawHeight = swapped ? canvas.width : canvas.height;
  context.drawImage(element, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  return { canvas, dataUrl: canvas.toDataURL(type, quality / 100), type };
}

function toBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function dataUrlToBlob(dataUrl) {
  const mime = /data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'application/octet-stream';
  return new Blob([toBytes(dataUrl)], { type: mime });
}

/* --------------------------------------------------------------- export ---- */
async function imagesToPdf(root) {
  if (!state.images.length) {
    toast('Add a few images first.', true);
    return;
  }
  await withBusy(root, '#cvImagesGo', 'Building PDF…', async () => {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.create();
    doc.setCreator('Folio · Converter');
    const [pageWidthMm, pageHeightMm] = PAGES[state.form.pageSize] ?? PAGES.a4;
    /* "From the page strip" reads the shared setup; the named sizes stay for
       anyone who wants a quick, even border around every photo. */
    let margin = { top: 0, right: 0, bottom: 0, left: 0 };
    if (state.form.margin === 'small') margin = { top: 8, right: 8, bottom: 8, left: 8 };
    else if (state.form.margin === 'wide') margin = { top: 18, right: 18, bottom: 18, left: 18 };
    else if (state.form.margin === 'strip') {
      const setup = page();
      margin = { top: setup.margins.top, right: setup.margins.right, bottom: setup.margins.bottom, left: setup.margins.left };
    }
    const marginX = (margin.left + margin.right) * MM;
    const marginY = (margin.top + margin.bottom) * MM;
    let keepPng = 0;
    for (const image of state.images) {
      const element = await ensureDecoded(image);
      const isPng = /png$/i.test(image.type) && state.form.quality > 92;
      if (isPng) keepPng += 1;
      const { dataUrl } = raster(element, {
        maxSide: state.form.capSize || 2600,
        quality: state.form.quality,
        format: isPng ? 'png' : 'jpeg',
        rotation: image.rotation,
      });
      const raw = toBytes(dataUrl);
      const embedded = isPng ? await doc.embedPng(raw) : await doc.embedJpg(raw);
      const swapped = Math.abs(image.rotation % 180) === 90;
      const ratio = (swapped ? embedded.height / embedded.width : embedded.width / embedded.height) || 1;
      const sizePage = state.form.fit === 'page';
      const pageWidth = sizePage ? Math.max(72, (swapped ? embedded.height : embedded.width) + marginX) : pageWidthMm * MM;
      const pageHeight = sizePage ? Math.max(72, (swapped ? embedded.width : embedded.height) + marginY) : pageHeightMm * MM;
      const page = doc.addPage([pageWidth, pageHeight]);
      const available = { width: Math.max(24, pageWidth - marginX), height: Math.max(24, pageHeight - marginY) };
      let drawWidth = available.width;
      let drawHeight = drawWidth / ratio;
      const tooTall = drawHeight > available.height;
      if (state.form.fit === 'contain' && tooTall) {
        drawHeight = available.height;
        drawWidth = drawHeight * ratio;
      } else if (state.form.fit === 'cover') {
        if (ratio > available.width / available.height) {
          drawHeight = available.height;
          drawWidth = drawHeight * ratio;
        } else {
          drawWidth = available.width;
          drawHeight = drawWidth / ratio;
        }
      } else if (tooTall) {
        drawHeight = available.height;
        drawWidth = drawHeight * ratio;
      }
      if (state.form.fit !== 'cover') {
        // contain/page keep the whole frame; cover intentionally crops in the encoder
      }
      page.drawImage(embedded, {
        x: margin.left * MM + Math.max(0, (available.width - drawWidth) / 2),
        y: margin.bottom * MM + Math.max(0, (available.height - drawHeight) / 2),
        width: drawWidth,
        height: drawHeight,
      });
    }
    const data = new Uint8Array(await doc.save({ useObjectStreams: true }));
    downloadBlob(new Blob([data], { type: 'application/pdf' }), safeFileName('folio-photos', 'pdf'));
    toast(`PDF saved — ${state.images.length} pages, ${bytes(data.byteLength)}${keepPng ? ` · ${keepPng} kept lossless` : ''}.`);
  });
}

function textBody(pdf, format) {
  if (!pdf) return '';
  const pages = pdf.pages;
  const joiner = state.form.pageBreaks ? '\n\n---\n\n' : '\n\n';
  if (format === 'txt') {
    return pages.map((page) => (state.form.pageBreaks ? `— page ${page.index} —\n${page.text}` : page.text)).join('\n\n');
  }
  if (format === 'html' || format === 'doc') {
    const inner = pages
      .map((page) => `<section class="page"><h2>Page ${page.index}</h2>${page.text.split(/\n{2,}/).map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`).join('')}</section>`)
      .join(state.form.pageBreaks ? '<hr />' : '');
    return `<!doctype html><html><head><meta charset="utf-8"/><title>${escapeHtml(pdf.name)}</title><style>body{font:15px/1.7 Georgia,serif;color:#232a26;max-width:44rem;margin:3rem auto;padding:0 1.25rem}h2{font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:#7b857a}p{margin:0 0 1rem}hr{border:0;border-top:1px solid #e5e5df;margin:3rem 0}</style></head><body>${inner}</body></html>`;
  }
  return pages.map((page) => `## Page ${page.index}\n\n${page.text}`).join(state.form.pageBreaks ? '\n\n---\n\n' : joiner);
}

function paintSnippet(root) {
  const node = q('#cvSnippet', root);
  if (!node) return;
  const pdf = state.pdfs[0];
  if (!pdf) {
    node.textContent = 'No PDF chosen yet.';
    return;
  }
  const body = textBody(pdf, state.form.textFormat);
  const preview = state.form.textFormat === 'txt' || state.form.textFormat === 'md' ? body.slice(0, 1400) : `${body.length.toLocaleString()} characters of markup ready to download`;
  node.textContent = preview || 'No selectable text found in this PDF.';
}

async function textOut(root) {
  const pdf = state.pdfs[0];
  if (!pdf) {
    toast('Add a PDF first.', true);
    return;
  }
  const format = state.form.textFormat;
  const body = textBody(pdf, format);
  if (!body.trim()) {
    toast('That PDF has no text layer to pull out.', true);
    return;
  }
  const mime = { txt: 'text/plain', md: 'text/markdown', html: 'text/html', doc: 'application/msword' }[format];
  const payload = format === 'doc' ? `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"/></head><body>${pdf.pages.map((page) => `<h2>Page ${page.index}</h2>${page.text.split(/\n{2,}/).map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`).join('')}`).join('<br style="page-break-before:always"/>')}</body></html>` : body;
  downloadBlob(new Blob([payload], { type: `${mime};charset=utf-8` }), safeFileName(`${pdf.name.replace(/\.pdf$/i, '')}-${format}`, format));
  toast(`Saved as .${format} — ${bytes(payload.length)}.`);
}

async function pagesToImages(root) {
  const pdf = state.pdfs[0];
  if (!pdf) {
    toast('Add a PDF first.', true);
    return;
  }
  await withBusy(root, '#cvImagesOutGo', 'Rendering pages…', async () => {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: pdf.buffer.slice(0), isEvalSupported: false, ...pdfjsAssetOptions() }).promise;
    const scale = Number(state.form.imageScale) || 2;
    const type = state.form.imageFormat === 'png' ? 'image/png' : 'image/jpeg';
    const entries = {};
    const base = pdf.name.replace(/\.pdf$/i, '');
    for (let index = 1; index <= doc.numPages; index += 1) {
      const page = await doc.getPage(index);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d');
      if (type === 'image/jpeg') {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = canvas.toBlob ? await new Promise((resolve) => canvas.toBlob(resolve, type, (Number(state.form.quality) || 80) / 100)) : dataUrlToBlob(canvas.toDataURL(type, (Number(state.form.quality) || 80) / 100));
      entries[`${base}-page-${String(index).padStart(2, '0')}.${type === 'image/png' ? 'png' : 'jpg'}`] = new Uint8Array(await blob.arrayBuffer());
      q('#cvImagesOutNote', root).textContent = `Rendered ${index} of ${doc.numPages}`;
    }
    await doc.destroy?.();
    const names = Object.keys(entries);
    if (names.length === 1) {
      downloadBlob(new Blob([entries[names[0]]], { type }), names[0]);
      toast('Page saved as an image.');
    } else {
      downloadBlob(await makeZip(entries), safeFileName(`${base}-pages`, 'zip'));
      toast(`${names.length} images zipped — on your device only.`);
    }
  });
}

async function shrinkImages(root) {
  if (!state.images.length) {
    toast('Add images first.', true);
    return;
  }
  await withBusy(root, '#cvShrinkGo', 'Shrinking…', async () => {
    const format = state.form.shrinkFormat;
    const type = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
    const entries = {};
    let before = 0;
    let after = 0;
    for (const image of state.images) {
      const element = await ensureDecoded(image);
      const { dataUrl } = raster(element, { maxSide: Number(state.form.shrinkMax) || 0, quality: Number(state.form.shrinkQuality) || 80, format, rotation: image.rotation });
      const blob = dataUrlToBlob(dataUrl);
      before += image.size;
      after += blob.size;
      const name = `${image.name.replace(/\.[a-z0-9]+$/i, '')}-folio.${format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpg'}`;
      entries[name] = new Uint8Array(await blob.arrayBuffer());
      const row = qa('.cv-shrink-row', root)[state.images.indexOf(image)];
      if (row) row.querySelector('.cv-shrink-when').textContent = `${bytes(image.size)} → ${bytes(blob.size)}`;
    }
    const names = Object.keys(entries);
    if (names.length === 1) downloadBlob(new Blob([entries[names[0]]], { type }), names[0]);
    else downloadBlob(await makeZip(entries), 'folio-shrunk-images.zip');
    const saved = before ? Math.max(0, Math.round((1 - after / before) * 100)) : 0;
    toast(`${names.length} images ready — about ${saved}% smaller.`);
  });
}

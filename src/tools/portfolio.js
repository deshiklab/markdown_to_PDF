/* Portfolio — turn a folder of photos into a proper, printed-looking PDF book:
   cover, plates, captions, colophon. Nothing leaves the browser except the
   images you add, and even those stay in memory. */
import { bytes, debounce, el, escapeHtml, q, qa, readImage, rasterize, store, toast, pickFiles, hasFiles } from '../lib.js';
import { printButton, setPage } from '../page.js';
import { PAGE_SIZES, exportHtmlAsPdf, pagePixelSize } from '../render.js';

const LAYOUTS = [
  { id: 'plate', label: 'One plate', note: 'A single image, breathing room', per: 1 },
  { id: 'pair', label: 'Diptych', note: 'Two frames side by side', per: 2 },
  { id: 'stack', label: 'Stacked pair', note: 'Two frames, one above the other', per: 2 },
  { id: 'grid3', label: 'Three across', note: 'A tight contact row', per: 3 },
  { id: 'mosaic', label: 'Mosaic', note: 'Four to a page', per: 4 },
  { id: 'story', label: 'Editorial', note: 'Full page image, caption on its own', per: 1 },
];

const TONES = [
  { id: 'paper', label: 'Warm paper' },
  { id: 'chalk', label: 'Gallery white' },
  { id: 'ink', label: 'Dark room' },
];

const COVERS = ['none', 'first', 'upload'];

const defaults = {
  title: 'Quiet Hours',
  subtitle: 'Photographs from the wet season',
  author: '',
  location: 'Dhaka',
  year: String(new Date().getFullYear()),
  layout: 'plate',
  pageSize: 'a4l',
  tone: 'paper',
  theme: 'editorial',
  captions: true,
  numbers: true,
  cover: 'first',
  gap: 16,
  padding: 46,
  ratio: 'auto',
  showIndex: false,
  grain: false,
  printQuality: false,
};

const prefs = store('portfolio:v1', defaults);
const state = { photos: [], form: { ...prefs.read() }, busy: false, cover: null };

const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';

export function start(root) {
  root.innerHTML = layout();
  wire(root);
  render(root);
  return () => state.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
}

/* ------------------------------------------------------------------ ui ---- */
function layout() {
  const form = state.form;
  return `
<div class="pf-shell">
  <section class="panel pf-side" aria-labelledby="pf-side-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">01</span>
        <div><h3 id="pf-side-title">The shoot</h3><p id="pfSideNote">Add frames, set the words</p></div>
      </div>
      <div class="panel-header-actions"><button class="button button-light" type="button" id="pfAdd"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11m-5.5-5.5h11"/></svg><span>Add</span></button></div>
    </div>

    <div class="lab-drop" id="pfDrop" role="button" tabindex="0" aria-label="Add photographs">
      <span class="dropzone-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="5" width="13.2" height="10" rx="1.4"/><circle cx="7.4" cy="8.8" r="1.1"/><path d="m4.6 13.6 3.4-3.2 2.4 2.2 2.5-2.4 3.1 3"/></svg></span>
      <strong>Drop your photos</strong>
      <span>They stay on this device</span>
      <span class="dropzone-button">Choose photos</span>
    </div>

    <div class="pf-fields">
      <label class="field"><span class="field-label">Series title</span><input class="text-input" id="pfTitle" type="text" value="${escapeHtml(form.title)}" autocomplete="off" /></label>
      <label class="field"><span class="field-label">Subtitle</span><input class="text-input" id="pfSubtitle" type="text" value="${escapeHtml(form.subtitle)}" autocomplete="off" /></label>
      <div class="lab-row">
        <label class="field grow"><span class="field-label">Photographer</span><input class="text-input" id="pfAuthor" type="text" value="${escapeHtml(form.author)}" placeholder="Your name" autocomplete="off" /></label>
        <label class="field"><span class="field-label">Place</span><input class="text-input text-input-narrow" id="pfLocation" type="text" value="${escapeHtml(form.location)}" autocomplete="off" /></label>
        <label class="field"><span class="field-label">Year</span><input class="text-input text-input-narrow" id="pfYear" type="text" value="${escapeHtml(form.year)}" inputmode="numeric" autocomplete="off" /></label>
      </div>
    </div>

    <div class="pf-photos-head"><span id="pfPhotoCount">No photos yet</span><button class="button button-text" type="button" id="pfShuffle">Shuffle</button></div>
    <ul class="pf-photos" id="pfPhotos" role="list"></ul>

    <div class="pf-notes">
      <label class="field"><span class="field-label">Colophon</span><textarea class="tr-paste" id="pfColophon" rows="3" placeholder="Contact, gear, a line of thanks…">${escapeHtml(form.colophonText ?? '')}</textarea></label>
    </div>
  </section>

  <section class="panel pf-main" aria-labelledby="pf-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="pf-main-title">Your book, live</h3><p><span class="live-dot"></span> Exactly the pages you will download</p></div>
      </div>
      <div class="panel-header-actions">
        ${printButton()}
        <span class="lab-count" id="pfPages">0 pages</span>
        <button class="button button-export" type="button" id="pfExport">${downloadIcon}<span>Download PDF</span></button>
      </div>
    </div>

    <div class="pf-controls">
      <label class="field"><span class="field-label">Layout</span>
        <select class="text-input" id="pfLayout">${LAYOUTS.map((layout2) => `<option value="${layout2.id}">${layout2.label}</option>`).join('')}</select>
      </label>
      <label class="field"><span class="field-label">Paper</span>
        <select class="text-input" id="pfSize">${Object.entries(PAGE_SIZES).map(([value, page]) => `<option value="${value}">${page.label}</option>`).join('')}</select>
      </label>
      <label class="field"><span class="field-label">Tone</span>
        <select class="text-input" id="pfTone">${TONES.map((tone) => `<option value="${tone.id}">${tone.label}</option>`).join('')}</select>
      </label>
      <label class="field"><span class="field-label">Crop</span>
        <select class="text-input" id="pfRatio">
          <option value="auto">As shot</option>
          <option value="1">Square 1:1</option>
          <option value="1.5">Classic 3:2</option>
          <option value="1.333">Portrait 4:3</option>
          <option value="2.39">Cinema 2.39:1</option>
        </select>
      </label>
      <label class="field"><span class="field-label">Cover</span>
        <select class="text-input" id="pfCover">${COVERS.map((value) => `<option value="${value}">${value === 'none' ? 'Title page only' : value === 'first' ? 'First photo' : 'Chosen photo'}</option>`).join('')}</select>
      </label>
    </div>

    <div class="pf-sliders">
      <div class="field"><span class="field-label-row"><span class="field-label">Page padding</span><output class="range-readout" id="pfPaddingOut">${form.padding}px</output></span><input class="range-input" id="pfPadding" type="range" min="8" max="110" value="${form.padding}" /></div>
      <div class="field"><span class="field-label-row"><span class="field-label">Gap</span><output class="range-readout" id="pfGapOut">${form.gap}px</output></span><input class="range-input" id="pfGap" type="range" min="0" max="72" value="${form.gap}" /></div>
      <label class="field field-switch"><input type="checkbox" class="switch-input" id="pfCaptions" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Captions</span></label>
      <label class="field field-switch"><input type="checkbox" class="switch-input" id="pfNumbers" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Page numbers</span></label>
      <label class="field field-switch"><input type="checkbox" class="switch-input" id="pfIndex" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Contents page</span></label>
      <label class="field field-switch"><input type="checkbox" class="switch-input" id="pfGrain" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Paper grain</span></label>
      <label class="field field-switch" title="Larger images, sharper on paper, bigger file"><input type="checkbox" class="switch-input" id="pfPrint" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Print quality</span></label>
    </div>

    <div class="pf-cover-pick" id="pfCoverPick" hidden>
      <button class="button button-light" type="button" id="pfCoverChoose"><svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="5" width="13.2" height="10" rx="1.4"/><circle cx="7.4" cy="8.8" r="1.1"/><path d="m4.6 13.6 3.4-3.2 2.4 2.2 2.5-2.4 3.1 3"/></svg><span>Choose a cover</span></button>
      <span class="pf-cover-thumb" id="pfCoverThumb" hidden><img alt="" /></span>
      <span class="pf-cover-state" id="pfCoverState">Nothing picked yet — the title page shows alone.</span>
      <button class="button button-text" type="button" id="pfCoverClear" hidden>Remove</button>
    </div>

    <div class="pf-stage" id="pfStage" data-print-root></div>
    <div class="preview-footer"><span><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4.25 3.5h9.5v11h-9.5z"/><path d="M7 6.5h4m-4 2.5h4m-4 2.5h2.5"/></svg><span id="pfStatus">Nothing on the desk yet</span></span><span>Scroll the pages, then download</span></div>
  </section>
</div>`;
}

function wire(root) {
  const save = debounce(() => prefs.write(state.form), 220);
  const paint = debounce(() => render(root), 120);
  const bind = (id, key, cast = (value) => value, after) => {
    const node = q(`#${id}`, root);
    if (!node) return;
    if (key in state.form) {
      if (node.type === 'checkbox') node.checked = Boolean(state.form[key]);
      else node.value = state.form[key] ?? '';
    }
    const handler = () => {
      state.form[key] = cast(node.type === 'checkbox' ? node.checked : node.value);
      if (id === 'pfPadding') q('#pfPaddingOut', root).textContent = `${state.form.padding}px`;
      if (id === 'pfGap') q('#pfGapOut', root).textContent = `${state.form.gap}px`;
      if (id === 'pfLayout' && state.form.layout === 'story') q('#pfGap', root).disabled = true;
      save();
      after?.(state.form[key]);
      paint();
    };
    node.addEventListener('input', handler);
    node.addEventListener('change', handler);
  };
  bind('pfTitle', 'title');
  bind('pfSubtitle', 'subtitle');
  bind('pfAuthor', 'author');
  bind('pfLocation', 'location');
  bind('pfYear', 'year');
  bind('pfLayout', 'layout');
  bind('pfSize', 'pageSize', undefined, () => {
    // the book's paper is the strip's paper: one sheet, previewed and printed
    const size = state.form.pageSize;
    setPage({ sheet: size === 'a4l' ? 'a4' : size, orientation: size === 'a4l' ? 'landscape' : 'portrait' });
  });
  bind('pfTone', 'tone');
  bind('pfRatio', 'ratio');
  bind('pfCover', 'cover');

  q('#pfCoverChoose', root)?.addEventListener('click', async () => {
    const [file] = await pickFiles({ accept: 'image/*', multiple: false });
    if (!file) return;
    try {
      const info = await readImage(file);
      if (state.cover?.url) URL.revokeObjectURL(state.cover.url);
      state.cover = { ...info, name: file.name, size: file.size };
      if (state.form.cover !== 'upload') {
        state.form.cover = 'upload';
        const select = q('#pfCover', root);
        if (select) select.value = 'upload';
        save();
      }
      toast('Cover set — it prints on the title page.');
      render(root);
    } catch (error) {
      console.error(error);
      toast('That image could not be read.', true);
    }
  });
  q('#pfCoverClear', root)?.addEventListener('click', () => {
    if (state.cover?.url) URL.revokeObjectURL(state.cover.url);
    state.cover = null;
    render(root);
  });
  bind('pfPadding', 'padding', Number);
  bind('pfGap', 'gap', Number);
  bind('pfCaptions', 'captions');
  bind('pfNumbers', 'numbers');
  bind('pfIndex', 'showIndex');
  bind('pfGrain', 'grain');
  bind('pfPrint', 'printQuality', undefined, (value) => {
    const status = q('#pfStatus', root);
    if (status) status.textContent = value ? 'Print quality on — sharper pages, larger file' : `${state.photos.length} frames ready`;
  });
  bind('pfColophon', 'colophonText');

  const drop = q('#pfDrop', root);
  const open = () => pickFiles({ accept: 'image/*', multiple: true }).then((files) => addPhotos(files, root));
  drop.addEventListener('click', open);
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  q('#pfAdd', root)?.addEventListener('click', open);
  let depth = 0;
  const dragOn = (node) => {
    node.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      node.classList.add('is-dragging');
    });
    node.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    node.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) node.classList.remove('is-dragging');
    });
    node.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      node.classList.remove('is-dragging');
      addPhotos(Array.from(event.dataTransfer?.files || []), root);
    });
  };
  dragOn(drop);
  dragOn(q('#pfStage', root));

  q('#pfShuffle', root)?.addEventListener('click', () => {
    for (let index = state.photos.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [state.photos[index], state.photos[swap]] = [state.photos[swap], state.photos[index]];
    }
    render(root);
    toast('Shuffled — press Undo with ⌘Z if you liked the old order.');
  });

  q('#pfExport', root)?.addEventListener('click', () => exportPdf(root));
}

async function addPhotos(files, root) {
  const images = files.filter((file) => /^image\//.test(file.type) || /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(file.name));
  if (!images.length) {
    if (files.length) toast('That tab only takes image files.', true);
    return;
  }
  for (const file of images) {
    try {
      const source = await readImage(file);
      const id = `p${state.photos.length + 1}-${Math.random().toString(36).slice(2, 6)}`;
      state.photos.push({
        id,
        name: file.name,
        size: file.size,
        url: source.url,
        image: source.image,
        width: source.width,
        height: source.height,
        caption: '',
        dataUrl: null,
      });
    } catch (error) {
      console.error(error);
      toast(`${file.name} could not be read.`, true);
    }
  }
  await prepare(root);
}

async function prepare(root) {
  const status = q('#pfStatus', root);
  const missing = state.photos.filter((photo) => !photo.dataUrl);
  if (!missing.length) {
    render(root);
    return;
  }
  const layout = LAYOUTS.find((item) => item.id === state.form.layout) ?? LAYOUTS[0];
  const boost = state.form.printQuality ? 1.5 : 1;
  const maxSide = Math.round((layout.per <= 1 ? 2400 : layout.per === 2 ? 1700 : 1300) * boost);
  for (const [index, photo] of missing.entries()) {
    if (status) status.textContent = `Preparing frames ${index + 1}/${missing.length}…`;
    const quality = state.form.printQuality ? 0.95 : photo.size > 900_000 ? 0.86 : 0.92;
    const { dataUrl, width, height } = rasterize(photo, { maxSize: maxSide, quality, type: 'image/jpeg' });
    photo.dataUrl = dataUrl;
    photo.outWidth = width;
    photo.outHeight = height;
    photo.outBytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    void layout;
  }
  if (status) status.textContent = `${state.photos.length} frames ready`;
  render(root);
}

/* ------------------------------------------------------------ rendering ---- */
function pageRatio() {
  const page = PAGE_SIZES[state.form.pageSize] ?? PAGE_SIZES.a4;
  return page.width / page.height;
}

function render(root) {
  renderPhotoList(root);
  const stage = q('#pfStage', root);
  if (!stage) return;
  const photos = state.photos;
  q('#pfPhotoCount', root).textContent = photos.length ? `${photos.length} ${photos.length === 1 ? 'frame' : 'frames'}` : 'No photos yet';
  const html = document.createElement('div');
  html.className = `pf-book tone-${state.form.tone}${state.form.grain ? ' has-grain' : ''}`;
  html.style.setProperty('--pf-padding', `${state.form.padding}px`);
  html.style.setProperty('--pf-gap', `${state.form.gap}px`);
  html.style.setProperty('--pf-ratio', String(pageRatio()));
  html.innerHTML = pagesHtml();
  stage.innerHTML = '';
  if (!photos.length) {
    stage.append(el('div', { class: 'empty-preview' }, [
      el('div', { class: 'empty-icon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="10" width="34" height="28" rx="2"/><path d="m12 32 8-8 6 6 7-7 5 5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18" cy="19" r="2.6"/></svg>' }),
      el('strong', { text: 'Your book starts empty' }),
      el('span', { text: 'Add a handful of photos and the cover, plates and colophon appear here.' }),
    ]));
    q('#pfPages', root).textContent = '0 pages';
    return;
  }
  stage.append(html);
  const count = html.querySelectorAll('.pf-page').length;
  paintCover(root);
  root.classList.toggle('has-input', state.photos.length > 0);
  q('#pfPages', root).textContent = `${count} ${count === 1 ? 'page' : 'pages'}`;
  q('#pfStatus', root).textContent = `${photos.length} frames · ${state.form.pageSize.toUpperCase()} · ${LAYOUTS.find((item) => item.id === state.form.layout)?.label}`;
  wirePhotoRows(root);
}

function coverBlock(kind) {
  const form = state.form;
  const photo = kind === 'upload' ? state.cover : state.photos[0];
  const text = `
    <div class="pf-cover-text">
      <p class="pf-cover-kicker">${escapeHtml(form.author || 'Photographs')}</p>
      <h1>${escapeHtml(form.title || 'Untitled series')}</h1>
      ${form.subtitle ? `<p class="pf-cover-sub">${escapeHtml(form.subtitle)}</p>` : ''}
      <p class="pf-cover-meta">${[form.location, form.year].filter(Boolean).map((value) => escapeHtml(value)).join(' · ')}</p>
    </div>`;
  return { cls: `pf-cover${photo ? ' has-image' : ''}`, body: `${photo ? `<img src="${photo.dataUrl ?? photo.url}" alt="" />` : ''}${text}` };
}

function pagesData() {
  const form = state.form;
  const photos = state.photos;
  const layout = LAYOUTS.find((item) => item.id === form.layout) ?? LAYOUTS[0];
  const pages = [];
  if (form.cover !== 'none') pages.push(coverBlock(form.cover));

  if (form.showIndex && photos.length) {
    pages.push({
      cls: 'pf-index',
      body: `<h2>Contents</h2><ol>${photos
        .map(
          (photo, index) =>
            `<li><span class="pf-index-num">${String(index + 1).padStart(2, '0')}</span><span class="pf-index-name">${escapeHtml(
              photo.caption || photo.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]/g, ' '),
            )}</span><span class="pf-index-dots"></span><span class="pf-index-page">${index + 1}</span></li>`,
        )
        .join('')}</ol>`,
    });
  }

  let number = 1;
  if (layout.id === 'story') {
    photos.forEach((photo) => {
      pages.push({ cls: 'pf-plate pf-full', body: `<figure class="pf-frame">${frame(photo, 'full')}</figure>` });
      number += 1;
      if (form.captions && photo.caption) {
        pages.push({ cls: 'pf-story-caption', body: `<p>${escapeHtml(photo.caption)}</p>`, quiet: true });
        number += 1;
      }
    });
  } else {
    for (let index = 0; index < photos.length; index += layout.per) {
      const slice = photos.slice(index, index + layout.per);
      const cls = { plate: 'is-one', pair: 'is-two', stack: 'is-two is-stack', grid3: 'is-three', mosaic: 'is-four' }[layout.id] ?? 'is-one';
      pages.push({
        cls: `pf-plate ${cls}`,
        body: slice.map((photo) => `<figure class="pf-frame">${frame(photo, layout.id)}</figure>`).join(''),
      });
      number += 1;
    }
  }

  const colophonText = String(form.colophonText ?? '').trim();
  pages.push({
    cls: 'pf-colophon',
    quiet: true,
    body: `<h2>Colophon</h2>${
      colophonText
        ? colophonText
            .split(/\n{2,}/)
            .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`)
            .join('')
        : `<p class="pf-muted">Set in Playfair Display and DM Sans. Photographed on available light and printed on ${(PAGE_SIZES[form.pageSize] ?? PAGE_SIZES.a4).label} — assembled in the browser, with nothing uploaded.</p>`
    }<p class="pf-sign">${escapeHtml(form.author || form.title || 'Folio')}</p>`,
  });

  return pages;
}

function pagesHtml() {
  const showNumbers = state.form.numbers;
  return pagesData()
    .map((page, index) => {
      const label = index === 0 || page.quiet ? '' : `<span class="pf-page-number">${index}</span>`;
      const numbered = showNumbers && label ? ' has-number' : '';
      return `<section class="pf-page ${page.cls}${numbered}">${page.body}${label}</section>`;
    })
    .join('');
}

function frame(photo, layoutId) {
  const src = photo.dataUrl ?? photo.url;
  const natural = (photo.width || 1) / (photo.height || 1);
  const forced = Number(state.form.ratio);
  const ratio = state.form.ratio === 'auto' || !Number.isFinite(forced) || forced <= 0 ? natural : forced;
  const fit = state.form.ratio === 'auto' ? 'contain' : 'cover';
  const caption = state.form.captions && photo.caption && layoutId !== 'full' ? `<figcaption>${escapeHtml(photo.caption)}</figcaption>` : '';
  return `<div class="pf-frame-box" style="--frame-ratio:${ratio.toFixed(4)};--frame-fit:${fit}"><img src="${src}" alt="${escapeHtml(
    photo.caption || photo.name,
  )}" loading="lazy" /></div>${caption}`;
}

function wirePhotoRows(root) {
  qa('.pf-photo', root).forEach((node) => {
    const id = node.dataset.photo;
    const photo = state.photos.find((item) => item.id === id);
    if (!photo) return;
    const caption = node.querySelector('.pf-photo-caption');
    if (caption) {
      caption.value = photo.caption;
      caption.addEventListener('input', () => {
        photo.caption = caption.value;
        debounce(() => render(root), 300)();
      });
    }
    node.querySelector('[data-remove]')?.addEventListener('click', () => {
      URL.revokeObjectURL(photo.url);
      state.photos = state.photos.filter((item) => item.id !== id);
      render(root);
    });
    node.querySelector('[data-left]')?.addEventListener('click', () => {
      const index = state.photos.findIndex((item) => item.id === id);
      if (index <= 0) return;
      [state.photos[index - 1], state.photos[index]] = [state.photos[index], state.photos[index - 1]];
      render(root);
    });
    node.querySelector('[data-right]')?.addEventListener('click', () => {
      const index = state.photos.findIndex((item) => item.id === id);
      if (index === -1 || index >= state.photos.length - 1) return;
      [state.photos[index + 1], state.photos[index]] = [state.photos[index], state.photos[index + 1]];
      render(root);
    });
    node.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', id);
      node.classList.add('is-dragging');
    });
    node.addEventListener('dragend', () => node.classList.remove('is-dragging'));
    node.addEventListener('dragover', (event) => {
      event.preventDefault();
      node.classList.add('is-over');
    });
    node.addEventListener('dragleave', () => node.classList.remove('is-over'));
    node.addEventListener('drop', (event) => {
      event.preventDefault();
      node.classList.remove('is-over');
      const from = state.photos.findIndex((item) => item.id === event.dataTransfer.getData('text/plain'));
      const to = state.photos.findIndex((item) => item.id === id);
      if (from === -1 || to === -1 || from === to) return;
      const [moved] = state.photos.splice(from, 1);
      state.photos.splice(to, 0, moved);
      render(root);
    });
  });
}

function paintCover(root) {
  const pick = q('#pfCoverPick', root);
  if (!pick) return;
  pick.hidden = state.form.cover !== 'upload';
  const thumb = q('#pfCoverThumb', root);
  const state_note = q('#pfCoverState', root);
  const clear = q('#pfCoverClear', root);
  if (!state.cover) {
    thumb.hidden = true;
    clear.hidden = true;
    state_note.textContent = 'Nothing picked yet — the title page shows alone.';
    return;
  }
  thumb.hidden = false;
  clear.hidden = false;
  thumb.querySelector('img').src = state.cover.url;
  state_note.textContent = `${state.cover.name} · ${state.cover.width}×${state.cover.height}`;
}

function paintSideNote(root) {
  const note = q('#pfSideNote', root);
  if (!note) return;
  const total = state.photos.reduce((sum, photo) => sum + (photo.size ?? photo.file?.size ?? 0), 0);
  note.textContent = state.photos.length
    ? `${state.photos.length} ${state.photos.length === 1 ? 'frame' : 'frames'} · ${bytes(total)} on this tab`
    : 'Add frames, set the words';
}

function renderPhotoList(root) {
  const list = q('#pfPhotos', root);
  if (!list) return;
  paintSideNote(root);
  list.innerHTML = '';
  if (!state.photos.length) {
    list.append(el('li', { class: 'lab-empty', text: 'Add photos and they will line up here — drag to reorder, add a caption for the plate.' }));
    return;
  }
  state.photos.forEach((photo, index) => {
    list.append(
      el('li', { class: 'pf-photo', draggable: 'true', dataset: { photo: photo.id } }, [
        el('span', { class: 'pf-photo-thumb' }, el('img', { src: photo.url, alt: '', loading: 'lazy' })),
        el('div', { class: 'pf-photo-body' }, [
          el('strong', { class: 'pf-photo-name', text: `${String(index + 1).padStart(2, '0')} · ${photo.name}`, title: photo.name }),
          el('small', { text: `${photo.width}×${photo.height} · ${bytes(photo.size)}${photo.outBytes ? ` → ${bytes(photo.outBytes)}` : ''}` }),
          el('input', { class: 'pf-photo-caption', type: 'text', placeholder: 'Caption (optional)', 'aria-label': `Caption for ${photo.name}`, autocomplete: 'off' }),
        ]),
        el('div', { class: 'pf-photo-actions' }, [
          el('button', { type: 'button', class: 'lab-icon-button', dataset: { left: '' }, 'aria-label': 'Move earlier', title: 'Move earlier', html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 5.5 8 10l4.5 4.5"/></svg>' }),
          el('button', { type: 'button', class: 'lab-icon-button', dataset: { right: '' }, 'aria-label': 'Move later', title: 'Move later', html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 5.5 12 10l-4.5 4.5"/></svg>' }),
          el('button', { type: 'button', class: 'lab-icon-button is-danger', dataset: { remove: '' }, 'aria-label': 'Remove photo', title: 'Remove', html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 6.2l7.6 7.6m0-7.6-7.6 7.6"/></svg>' }),
        ]),
      ]),
    );
  });
  wirePhotoRows(root);
}

/* --------------------------------------------------------------- export ---- */
async function exportPdf(root) {
  if (!state.photos.length) {
    toast('Add at least one photograph.', true);
    return;
  }
  const button = q('#pfExport', root);
  const original = button.innerHTML;
  state.busy = true;
  button.disabled = true;
  button.innerHTML = '<span class="export-spinner" aria-hidden="true"></span><span>Setting the type…</span>';
  try {
    await prepare(root);
    const pageWidth = pagePixelSize(state.form.pageSize);
    const html = pagesHtml();
    await exportHtmlAsPdf({
      html: `<div class="pf-book pf-export tone-${state.form.tone}${state.form.grain ? ' has-grain' : ''}" style="--pf-padding:${state.form.padding}px;--pf-gap:${state.form.gap}px;--pf-export-width:${pageWidth}px">${html}</div>`,
      filename: `${(state.form.title || 'folio-portfolio').replace(/[^\w\d]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.pdf`,
      theme: state.form.theme === 'modern' ? 'modern' : 'editorial',
      margin: 'none',
      pageSize: state.form.pageSize,
      scale: state.form.printQuality ? 3 : 2,
      onStatus: (message) => {
        button.querySelector('span:last-child').textContent = message;
      },
    });
  } catch (error) {
    console.error(error);
    toast(error?.message || 'The book could not be printed.', true);
  } finally {
    state.busy = false;
    button.disabled = false;
    button.innerHTML = original;
  }
}

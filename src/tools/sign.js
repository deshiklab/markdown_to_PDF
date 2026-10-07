/* Sign — draw a signature on a pad, keep the marks in this browser, then place
   one on the dotted line with a name, a title and a date under it. A second
   pad is there for whoever is countersigning. pdf-lib writes, pdf.js shows the
   page, and the position you drag is the position that gets drawn. */
import {
  debounce,
  downloadBlob,
  el,
  escapeHtml,
  hasFiles,
  loadPdfJs,
  loadPdfLib,
  pickFiles,
  q,
  qa,
  store,
  toast,
} from '../lib.js';
import { printButton } from '../page.js';

const MODES = [
  { id: 'pad', label: 'Draw the mark', note: 'Pad, ink, saved signatures' },
  { id: 'place', label: 'Place it', note: 'Drag it onto the page' },
  { id: 'seal', label: 'Check and seal', note: 'Countersign, flatten, save' },
];

const POSITIONS = ['top-left', 'top-center', 'top-right', 'middle-left', 'centre', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];

const INKS = [
  { value: '#16161a', label: 'black' },
  { value: '#12307a', label: 'blue' },
  { value: '#6b1f1f', label: 'red' },
];

const PARTY = {
  a: { key: 'a', title: 'Your signature', short: 'Party A' },
  b: { key: 'b', title: 'Countersignature', short: 'Party B' },
};

const defaults = {
  mode: 'pad',
  ink: '#12307a',
  pen: 2.6,
  knock: 214,
  markA: '',
  markB: '',
  widthA: 132,
  widthB: 116,
  pageA: 1,
  pageB: 1,
  nameA: '',
  nameB: '',
  titleA: '',
  titleB: '',
  ruleA: 'dotted',
  ruleB: 'dotted',
  dateA: 'today',
  dateB: 'today',
  captionSize: 8.5,
  captionInk: '#6b7368',
  textInk: '#16161a',
  previewPage: 1,
  flatten: false,
};

const prefs = store('sign:v1', defaults);
const markStore = store('sign:marks:v1', { marks: [] });

const PAD_EXPORT_WIDTH = 1400;
const PAD_HEIGHT = 190;

const state = {
  mode: prefs.read().mode,
  form: { ...prefs.read() },
  marks: markStore.read().marks ?? [],
  strokes: [],
  live: null,
  drawing: false,
  buffer: null,
  name: '',
  pageCount: 0,
  pageSizes: [],
  rotations: [],
  busy: false,
  render: null,
};

/* Each placed block: x and y are the top-left corner of the mark, in display
   points (the page as it is shown, after /Rotate), so dragging is 1:1 with px. */
const blocks = {
  a: { x: 0, y: 0 },
  b: { x: 0, y: 0 },
};

const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';
const penIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 16.5h4l9-9a1.9 1.9 0 0 0-2.7-2.7l-9 9z"/><path d="M11.4 6.2 13.8 8.6"/></svg>';

export function start(root) {
  root.innerHTML = layout();
  wire(root);
  paintMode(root);
  paintMarks(root);
  requestAnimationFrame(() => sizePad(root));
  return () => {
    if (state.onResize) window.removeEventListener('resize', state.onResize);
    state.observer?.disconnect();
    state.strokes = [];
    state.live = null;
  };
}

/* ------------------------------------------------------------------ ui ---- */
function layout() {
  const form = state.form;
  return `
<div class="lab-shell sg-shell" id="sgShell" data-mode="${state.mode}">
  <section class="panel sg-side" aria-labelledby="sg-side-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">01</span>
        <div><h3 id="sg-side-title">The pad</h3><p id="sgSideNote">Draw once, sign many — saved in this browser</p></div>
      </div>
      <div class="panel-header-actions"><button class="button button-light" type="button" id="sgUploadBtn"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M10 13.5V4.2m0 0L6.9 7.3M10 4.2l3.1 3.1M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg><span>Use an image</span></button></div>
    </div>

    <div class="sg-pad-wrap">
      <canvas id="sgPad" class="sg-pad" aria-label="Signature drawing pad. Draw with a mouse, finger or pen."></canvas>
      <p class="sg-pad-note" id="sgPadNote">Sign inside the lines — the empty space is thrown away when you save.</p>
    </div>

    <div class="sg-toolbar" role="group" aria-label="Pen">
      <div class="sg-inks" id="sgInks">
        ${INKS.map((ink) => `<button type="button" class="sg-ink${form.ink === ink.value ? ' is-on' : ''}" data-ink="${ink.value}" style="--ink:${ink.value}" aria-pressed="${form.ink === ink.value}" aria-label="${ink.label} ink"><span></span></button>`).join('')}
      </div>
      <label class="field sg-pen"><span class="field-label">Pen</span><input class="range-input" id="sgPen" type="range" min="1.2" max="6" step="0.2" value="${form.pen}" /></label>
      <button class="button button-light" type="button" id="sgUndo">Undo</button>
      <button class="button button-light" type="button" id="sgClearPad">Clear</button>
    </div>

    <div class="sg-save-row">
      <label class="field grow"><span class="field-label">Name this signature</span><input class="text-input" id="sgMarkName" type="text" placeholder="Blue ink — passport size" autocomplete="off" /></label>
      <button class="button button-export" type="button" id="sgSaveMark">${penIcon}<span>Keep it</span></button>
    </div>

    <div class="sg-marks-head">
      <h4>Saved on this device</h4>
      <span class="lab-count" id="sgMarkCount">none yet</span>
    </div>
    <div class="sg-marks" id="sgMarks"></div>
  </section>

  <section class="panel sg-main" aria-labelledby="sg-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="sg-main-title">On the dotted line</h3><p><span class="live-dot"></span> Nothing is uploaded — you download a new file</p></div>
      </div>
      <div class="panel-header-actions">${printButton()}<span class="lab-count" id="sgStat">no file</span></div>
    </div>

    <div class="lab-modes" role="group" aria-label="Sign mode">
      ${MODES.map((mode) => `<button type="button" class="lab-mode${state.mode === mode.id ? ' is-on' : ''}" data-mode-btn="${mode.id}" aria-pressed="${state.mode === mode.id}"><strong>${mode.label}</strong><small>${mode.note}</small></button>`).join('')}
    </div>

    <div class="lab-body">
      <div class="sg-stage-panel" data-sg-panel="pad">
        <p class="lab-help">Draw with a mouse, a finger or a stylus — the stroke gets thicker when you move slowly, thinner when you flick. <strong>Keep it</strong> stores the mark in this browser only, so the next document takes one click. If you already have a scan of your signature, use <em>Use an image</em> and Folio knocks the paper out.</p>
        <div class="sg-knock">
          <label class="field"><span class="field-label">Paper knockout for images</span><input class="range-input" id="sgKnock" type="range" min="0" max="250" step="2" value="${form.knock}" /></label>
          <p class="lab-hint" id="sgKnockHint">${form.knock ? `Pixels lighter than ${form.knock} go transparent.` : 'Off — the whole image is kept.'}</p>
        </div>
        <div class="sg-card" id="sgCard"></div>
      </div>

      <div class="sg-stage-panel" data-sg-panel="place" hidden>
        <div class="lab-drop" id="sgDrop" role="button" tabindex="0" aria-label="Choose a PDF to sign">
          <span class="dropzone-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h5.2l3.3 3.3v9.7H6z"/><path d="M11 3.6v3.3h3.2M8.4 11h4M8.4 13.2h2.6"/></svg></span>
          <strong>Drop the document</strong>
          <span>or click to choose — it is opened here, never sent anywhere</span>
          <span class="dropzone-button">Choose file</span>
        </div>

        <div class="sg-dropzone-off" id="sgNoFile">${emptyStateHtml()}</div>

        <div class="sg-work" id="sgWork" hidden>
          <div class="sg-work-head">
            <label class="field sg-page-field"><span class="field-label">Preview page</span><input class="text-input" id="sgPreviewPage" type="number" min="1" step="1" value="${form.previewPage}" /></label>
            <p class="lab-hint" id="sgStageHint">Drag a mark to move it. Arrow keys nudge, <kbd>Shift</kbd> + arrows move further.</p>
          </div>
          <div class="sg-stage" id="sgStage" data-print-root>
            <div class="sg-paper" id="sgPaper">
              <canvas id="sgCanvas" aria-label="The page you are signing, with the signature blocks on it"></canvas>
              <button type="button" class="sg-handle" data-handle="a" hidden aria-label="Your signature — drag to move"><img alt="" /></button>
              <button type="button" class="sg-handle" data-handle="b" hidden aria-label="Countersignature — drag to move"><img alt="" /></button>
            </div>
          </div>

          <div class="sg-parties">
            ${partyForm('a')}
            ${partyForm('b')}
          </div>

          <div class="lab-actions">
            <p class="lab-hint" id="sgPlaceHint">Pick a signature for each side, then drag it onto the line.</p>
            <div class="lab-actions-row">
              <button class="button button-text" type="button" data-quick="side">Side by side</button>
              <button class="button button-text" type="button" data-quick="below">One under the other</button>
              <button class="button button-text" type="button" data-quick="same">Same page for both</button>
            </div>
          </div>
        </div>
      </div>

      <div class="sg-stage-panel" data-sg-panel="seal" hidden>
        <p class="lab-help">What gets drawn, and how permanent it should be. <strong>Flatten the signed pages</strong> paints the page into one image, so the mark can no longer be lifted off — the price is that text on those pages stops being selectable.</p>
        <div class="sg-summary" id="sgSummary"></div>
        <div class="sg-seal-grid">
          <label class="field field-switch"><input type="checkbox" class="switch-input" id="sgFlatten" ${form.flatten ? 'checked' : ''} /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Flatten the signed pages</span></label>
          <label class="field field-switch"><input type="checkbox" class="switch-input" id="sgRuleShadow" checked /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Fade the caption to grey</span></label>
        </div>
        <div class="sg-honesty">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="6.6"/><path d="M10 6.6v4.1M10 13.1v.6"/></svg>
          <p>A drawn signature is a picture on the page, not a cryptographic one — there is no certificate and nothing to tell you if the file was changed afterwards. Quote a checksum when it matters.</p>
          <button class="button button-light" type="button" id="sgGoFinish">Checksum it in Finish</button>
        </div>
        <div class="lab-actions">
          <p class="lab-hint" id="sgSealHint">No document open.</p>
          <button class="button button-export" type="button" id="sgSignGo">${downloadIcon}<span>Sign and save</span></button>
        </div>
      </div>
    </div>
  </section>
</div>`;
}

function emptyStateHtml() {
  return '<div class="empty-state"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M3.5 14.5c2.4-6 4.2 3.2 6.4-1.6 1.4-3 2.2 2.6 4.6-.9"/></svg><p>Open a PDF and the page appears here, ready for a mark.</p></div>';
}

function partyForm(key) {
  const party = PARTY[key];
  const options = () => state.marks.map((mark) => `<option value="${mark.id}"${state.form[key === 'a' ? 'markA' : 'markB'] === mark.id ? ' selected' : ''}>${escapeHtml(mark.name)}</option>`).join('');
  return `
  <div class="sg-party" data-party="${key}">
    <div class="sg-party-head">
      <strong>${party.title}</strong>
      <span class="sg-party-tag">${party.short}</span>
    </div>
    <div class="sg-party-fields">
      <label class="field"><span class="field-label">Signature</span><select class="text-input" data-field="${key === 'a' ? 'markA' : 'markB'}" aria-label="${party.short} signature">${options() || '<option value="">Nothing saved yet</option>'}</select></label>
      <label class="field"><span class="field-label">Page</span><input class="text-input" type="number" min="1" step="1" data-field="${key === 'a' ? 'pageA' : 'pageB'}" value="${state.form[key === 'a' ? 'pageA' : 'pageB']}" /></label>
      <label class="field"><span class="field-label">Width</span><input class="text-input" type="number" min="40" max="420" step="2" data-field="${key === 'a' ? 'widthA' : 'widthB'}" value="${state.form[key === 'a' ? 'widthA' : 'widthB']}" /></label>
      <label class="field"><span class="field-label">Name under the line</span><input class="text-input" type="text" data-field="${key === 'a' ? 'nameA' : 'nameB'}" value="${escapeHtml(state.form[key === 'a' ? 'nameA' : 'nameB'])}" placeholder="Deshika Rahman" autocomplete="off" /></label>
      <label class="field"><span class="field-label">Title</span><input class="text-input" type="text" data-field="${key === 'a' ? 'titleA' : 'titleB'}" value="${escapeHtml(state.form[key === 'a' ? 'titleA' : 'titleB'])}" placeholder="Director, Studio" autocomplete="off" /></label>
      <label class="field"><span class="field-label">Line</span><select class="text-input" data-field="${key === 'a' ? 'ruleA' : 'ruleB'}"><option value="none">nothing</option><option value="dotted"${state.form[key === 'a' ? 'ruleA' : 'ruleB'] === 'dotted' ? ' selected' : ''}>dotted</option><option value="solid"${state.form[key === 'a' ? 'ruleA' : 'ruleB'] === 'solid' ? ' selected' : ''}>solid</option></select></label>
      <label class="field"><span class="field-label">Date</span><select class="text-input" data-field="${key === 'a' ? 'dateA' : 'dateB'}"><option value="none"${state.form[key === 'a' ? 'dateA' : 'dateB'] === 'none' ? ' selected' : ''}>no date</option><option value="today"${state.form[key === 'a' ? 'dateA' : 'dateB'] === 'today' ? ' selected' : ''}>today</option><option value="beside"${state.form[key === 'a' ? 'dateA' : 'dateB'] === 'beside' ? ' selected' : ''}>today, on the right</option></select></label>
      <div class="field">
        <span class="field-label">Snap to</span>
        <div class="lab-pos-grid sg-pos-grid" role="group" aria-label="${party.short} position">
          ${POSITIONS.map((position) => `<button type="button" class="lab-pos" data-pos="${key}:${position}" title="${position.replace(/-/g, ' ')}" aria-label="${party.short} ${position.replace(/-/g, ' ')}"><span></span></button>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- wiring ---- */
function wire(root) {
  const save = debounce(() => prefs.write(state.form), 250);

  qa('[data-mode-btn]', root).forEach((node) => {
    node.addEventListener('click', () => {
      state.mode = node.dataset.modeBtn;
      state.form.mode = state.mode;
      save();
      paintMode(root);
    });
  });

  qa('[data-ink]', root).forEach((node) => {
    node.addEventListener('click', () => {
      state.form.ink = node.dataset.ink;
      save();
      qa('[data-ink]', root).forEach((other) => {
        const on = other === node;
        other.classList.toggle('is-on', on);
        other.setAttribute('aria-pressed', String(on));
      });
      repaintPad(root);
    });
  });

  const pen = q('#sgPen', root);
  pen?.addEventListener('input', () => {
    state.form.pen = Number(pen.value);
    save();
  });

  const knock = q('#sgKnock', root);
  knock?.addEventListener('input', () => {
    state.form.knock = Number(knock.value);
    save();
    const hint = q('#sgKnockHint', root);
    if (hint) hint.textContent = state.form.knock ? `Pixels lighter than ${state.form.knock} go transparent.` : 'Off — the whole image is kept.';
  });

  wirePad(root);
  wireDrop(root);
  wireHandles(root);

  qa('[data-field]', root).forEach((node) => {
    const handler = () => {
      state.form[node.dataset.field] = node.type === 'number' ? Number(node.value) : node.value;
      save();
      // only a page change needs a new bitmap; sizes and captions are overlay maths
      if (node.dataset.field.startsWith('page')) {
        clampPages(root);
        renderStage(root);
      } else {
        paintStageScale(root);
      }
      paintSeal(root);
    };
    node.addEventListener('input', handler);
    node.addEventListener('change', handler);
  });

  qa('[data-quick]', root).forEach((node) => {
    node.addEventListener('click', () => quickPlace(node.dataset.quick, root));
  });
  qa('[data-pos]', root).forEach((node) => {
    node.addEventListener('click', () => {
      const [key, position] = node.dataset.pos.split(':');
      snapTo(key, position, root);
      qa(`[data-pos^="${key}:"]`, root).forEach((other) => other.classList.toggle('is-on', other === node));
    });
  });

  q('#sgPreviewPage', root)?.addEventListener('input', (event) => {
    state.form.previewPage = Number(event.target.value) || 1;
    save();
    clampPages(root);
    renderStage(root);
  });
  q('#sgFlatten', root)?.addEventListener('change', (event) => {
    state.form.flatten = event.target.checked;
    save();
    paintSeal(root);
  });
  q('#sgRuleShadow', root)?.addEventListener('change', (event) => {
    state.form.captionInk = event.target.checked ? '#6b7368' : '#16161a';
    save();
    renderStage(root);
  });
  q('#sgGoFinish', root)?.addEventListener('click', () => {
    window.location.hash = '#/finish';
  });
  q('#sgSignGo', root)?.addEventListener('click', () => sign(root));
  q('#sgUploadBtn', root)?.addEventListener('click', async () => {
    const files = await pickFiles({ accept: 'image/*', multiple: true });
    for (const file of files) await addImageMark(file, root);
  });
  q('#sgSaveMark', root)?.addEventListener('click', () => savePadMark(root));
  q('#sgUndo', root)?.addEventListener('click', () => {
    state.strokes.pop();
    repaintPad(root);
  });
  q('#sgClearPad', root)?.addEventListener('click', () => {
    state.strokes = [];
    repaintPad(root);
  });

  state.onResize = () => {
    sizePad(root);
    renderStage(root);
  };
  window.addEventListener('resize', state.onResize);
  // a signature must not be cropped just because the panel got narrower
  if ('ResizeObserver' in window) {
    const pad = q('#sgPad', root);
    if (pad) {
      state.observer = new window.ResizeObserver(() => sizePad(root));
      state.observer.observe(pad);
    }
  }

  paintSeal(root);
}

/* ----------------------------------------------------------------- pad ---- */
function wirePad(root) {
  const canvas = q('#sgPad', root);
  if (!canvas) return;
  /* Strokes are kept as fractions of the pad box, not as pixels inside it. The
     panel is a sidebar on a desktop and full width on a phone, and a phone
     re-measures itself when the keyboard appears: pixel coordinates recorded at
     one width land in the wrong place at another, which the customer sees as
     their own signature drifting — and as a stretched mark, because the export
     re-paints the same points. Fractions survive any resize. */
  const box = () => ({ w: canvas.clientWidth || 520, h: canvas.clientHeight || PAD_HEIGHT });
  const pointOf = (event) => {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = box();
    return {
      x: (event.clientX - rect.left - canvas.clientLeft) / w,
      y: (event.clientY - rect.top - canvas.clientTop) / h,
    };
  };
  /* The nib is sized in screen pixels (a fast stroke tapers), so the distance
     that feeds it has to be measured in pixels too, not in fractions. */
  const widthAt = (previous, next) => {
    const { w, h } = box();
    if (!previous) return state.form.pen;
    const distance = Math.hypot((next.x - previous.x) * w, (next.y - previous.y) * h);
    const speed = Math.min(1, distance / 26);
    return state.form.pen * (1 - 0.45 * speed);
  };
  const nib = (widthPx) => widthPx / box().w;

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    state.drawing = true;
    const point = pointOf(event);
    state.live = { ink: state.form.ink, points: [{ ...point, w: nib(widthAt(null, point)) }] };
    state.strokes.push(state.live);
    repaintPad(root);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!state.drawing || !state.live) return;
    const events = event.getCoalescedEvents?.() ?? [event];
    const { w, h } = box();
    let previous = state.live.points[state.live.points.length - 1];
    for (const move of events) {
      const point = pointOf(move);
      if (Math.hypot((point.x - previous.x) * w, (point.y - previous.y) * h) < 0.8) continue;
      const width = nib(widthAt(previous, point));
      state.live.points.push({ ...point, w: (previous.w + width) / 2 });
      previous = state.live.points[state.live.points.length - 1];
    }
    repaintPad(root);
  });
  const stop = () => {
    if (!state.drawing) return;
    state.drawing = false;
    state.live = null;
    const note = q('#sgPadNote', root);
    if (note) note.textContent = state.strokes.length ? `${state.strokes.length} stroke${state.strokes.length === 1 ? '' : 's'} — save it when it looks like you.` : 'Draw on the pad.';
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  /* No pointerleave: the pointer is captured, and a flourish that overshoots the
     edge of the pad (or a page that scrolls under the pointer) should come back
     rather than end the stroke mid-letter. */
}

function sizePad(root) {
  const canvas = q('#sgPad', root);
  if (!canvas || !canvas.clientWidth) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.style.height = `${PAD_HEIGHT}px`;
  // the bitmap has to cover the box inside the 1px frame, not the frame itself —
  // a 2-pixel difference is a signature that is drawn slightly off the pen
  const width = canvas.clientWidth || 520;
  const height = canvas.clientHeight || PAD_HEIGHT;
  if (canvas.width === Math.round(width * ratio) && canvas.height === Math.round(height * ratio)) return;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  repaintPad(root);
}

/* Width and height are of the canvas being painted, so the same stroke looks
   the same on the 1x pad and on the wide export canvas. */
function paintPadStroke(context, stroke, width, height) {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = stroke.ink;
  const points = stroke.points;
  if (!points.length) return;
  if (points.length === 1) {
    context.fillStyle = stroke.ink;
    context.beginPath();
    context.arc(points[0].x * width, points[0].y * height, (points[0].w * width) / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    context.beginPath();
    context.lineWidth = Math.max(0.6, ((from.w + to.w) / 2) * width);
    context.moveTo(from.x * width, from.y * height);
    const next = points[index + 1];
    if (next) context.quadraticCurveTo(to.x * width, to.y * height, ((to.x + next.x) / 2) * width, ((to.y + next.y) / 2) * height);
    else context.lineTo(to.x * width, to.y * height);
    context.stroke();
  }
}

function repaintPad(root) {
  const canvas = q('#sgPad', root);
  if (!canvas) return;
  const context = canvas.getContext('2d');
  context.save();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#fdfdf8';
  context.fillRect(0, 0, canvas.width, canvas.height);
  // the ruled line a signature normally sits on
  context.strokeStyle = '#dfe3d8';
  context.lineWidth = 1;
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(canvas.width * 0.06, canvas.height * 0.76);
  context.lineTo(canvas.width * 0.94, canvas.height * 0.76);
  context.stroke();
  context.setLineDash([]);
  for (const stroke of state.strokes) paintPadStroke(context, stroke, canvas.width, canvas.height);
  context.restore();
}

/* ------------------------------------------------------------ exports ---- */
/* The pad is drawn on screen in CSS pixels; the mark is re-rendered at a fixed
   export width on a transparent canvas and cropped to its own ink. */
function padMarkCanvas(root) {
  const source = q('#sgPad', root);
  if (!source || !state.strokes.length) return null;
  const canvas = document.createElement('canvas');
  canvas.width = PAD_EXPORT_WIDTH;
  canvas.height = Math.round(PAD_EXPORT_WIDTH * ((source.clientHeight || PAD_HEIGHT) / (source.clientWidth || 520)));
  const context = canvas.getContext('2d');
  for (const stroke of state.strokes) paintPadStroke(context, stroke, canvas.width, canvas.height);
  return trimCanvas(canvas);
}

/* Cut away the empty margin so a placed mark is the ink, not the canvas. */
function trimCanvas(canvas) {
  const context = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = context.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < 12) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) return canvas;
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.05) + 4;
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width, maxX + pad + 1);
  const bottom = Math.min(height, maxY + pad + 1);
  const out = document.createElement('canvas');
  out.width = right - left;
  out.height = bottom - top;
  out.getContext('2d').drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function addImageMark(file, root) {
  if (!/^image\//.test(file.type)) {
    toast('Use a PNG or JPG of the signature.', true);
    return;
  }
  try {
    const url = URL.createObjectURL(file);
    const image = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error('decode failed'));
      node.src = url;
    });
    const scale = Math.min(1, PAD_EXPORT_WIDTH / image.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const threshold = Number(state.form.knock) || 0;
    if (threshold) {
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const bytesOf = frame.data;
      for (let index = 0; index < bytesOf.length; index += 4) {
        const light = (bytesOf[index] * 0.299 + bytesOf[index + 1] * 0.587 + bytesOf[index + 2] * 0.114) > threshold;
        if (light) bytesOf[index + 3] = 0;
      }
      context.putImageData(frame, 0, 0);
    }
    const trimmed = trimCanvas(canvas);
    URL.revokeObjectURL(url);
    pushMark({
      name: file.name.replace(/\.[a-z]+$/i, '').slice(0, 40) || 'Scanned signature',
      dataUrl: trimmed.toDataURL('image/png'),
      width: trimmed.width,
      height: trimmed.height,
    }, root);
    toast(`${file.name} is on the pad — it never left this tab.`);
  } catch (error) {
    console.error(error);
    toast('That image could not be read.', true);
  }
}

function pushMark(mark, root) {
  const record = { id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, savedAt: Date.now(), ...mark };
  state.marks = [...state.marks, record].slice(-12);
  if (!writeMarks()) toast('Saved for this session — the browser refused to store it.', true);
  if (!state.form.markA) state.form.markA = record.id;
  else if (!state.form.markB) state.form.markB = record.id;
  prefs.write(state.form);
  rebuildPartySelects(root);
  paintMarks(root);
  paintSeal(root);
  renderStage(root);
  return record;
}

function writeMarks() {
  return markStore.write({ marks: state.marks });
}

function savePadMark(root) {
  const canvas = padMarkCanvas(root);
  if (!canvas) return toast('Draw something first — the pad is empty.', true);
  const input = q('#sgMarkName', root);
  const name = (input?.value || '').trim() || `Signature ${state.marks.length + 1}`;
  pushMark({ name, dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }, root);
  if (input) input.value = '';
  toast(`${name} kept on this device.`);
}

function rebuildPartySelects(root) {
  qa('[data-field="markA"], [data-field="markB"]').forEach((node) => {
    const current = node.value;
    node.replaceChildren(
      ...(state.marks.length
        ? state.marks.map((mark) => new Option(mark.name, mark.id, false, mark.id === (current || state.form[node.dataset.field])))
        : [new Option('Nothing saved yet', '', false, true)]),
    );
    if (state.marks.length) node.value = state.form[node.dataset.field] || state.marks[0].id;
  });
}

function paintMarks(root) {
  const list = q('#sgMarks', root);
  const count = q('#sgMarkCount', root);
  if (!list) return;
  if (count) count.textContent = state.marks.length ? `${state.marks.length} on this device` : 'none yet';
  if (!state.marks.length) {
    list.replaceChildren(el('p', { class: 'sg-marks-empty', text: 'Nothing kept yet. Draw a signature above and press Keep it.' }));
    return;
  }
  if (!state.marks.some((mark) => mark.id === state.form.markA)) state.form.markA = state.marks[0].id;
  if (!state.marks.some((mark) => mark.id === state.form.markB)) state.form.markB = state.marks[state.marks.length - 1].id;
  rebuildPartySelects(root);
  list.replaceChildren(
    ...state.marks.map((mark) => {
      const card = el('div', { class: 'sg-mark' });
      card.append(
        el('span', { class: 'sg-mark-thumb' }, [el('img', { src: mark.dataUrl, alt: '', loading: 'lazy' })]),
        el('div', { class: 'sg-mark-body' }, [
          el('input', {
            class: 'text-input sg-mark-name',
            value: mark.name,
            'aria-label': 'Name of this signature',
            onchange: (event) => {
              mark.name = event.target.value.trim() || mark.name;
              writeMarks();
              rebuildPartySelects(root);
              paintSeal(root);
            },
          }),
          el('span', { class: 'sg-mark-size', text: `${mark.width}×${mark.height} px` }),
        ]),
        el('div', { class: 'sg-mark-actions' }, [
          el('button', { class: 'button button-text', type: 'button', text: 'A', 'data-use': 'a', title: 'Use for your signature', onclick: () => useMark(mark, 'markA', root) }),
          el('button', { class: 'button button-text', type: 'button', text: 'B', 'data-use': 'b', title: 'Use for the countersignature', onclick: () => useMark(mark, 'markB', root) }),
          el('button', {
            class: 'button button-text sg-mark-del',
            type: 'button',
            text: 'Remove',
            onclick: () => {
              state.marks = state.marks.filter((item) => item.id !== mark.id);
              for (const key of ['markA', 'markB']) if (state.form[key] === mark.id) state.form[key] = state.marks[0]?.id ?? '';
              writeMarks();
              prefs.write(state.form);
              paintMarks(root);
              paintSeal(root);
              renderStage(root);
              toast('Removed from this browser.');
            },
          }),
        ]),
      );
      return card;
    }),
  );
}

function useMark(mark, field, root) {
  state.form[field] = mark.id;
  prefs.write(state.form);
  rebuildPartySelects(root);
  paintMarks(root);
  paintSeal(root);
  renderStage(root);
  toast(`${mark.name} → ${field === 'markA' ? 'your signature' : 'the countersignature'}.`);
}

/* ---------------------------------------------------------- the document ---- */
function wireDrop(root) {
  const zone = q('#sgDrop', root);
  if (!zone) return;
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
}

async function loadFile(file, root) {
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
    toast('That tab wants a PDF.', true);
    return;
  }
  state.name = file.name;
  state.buffer = await file.arrayBuffer();
  root.classList.add('has-input');
  try {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.load(state.buffer.slice(0), { ignoreEncryption: true, updateMetadata: false });
    state.pageCount = doc.getPageCount();
    state.pageSizes = doc.getPages().map((page) => page.getSize());
    state.rotations = doc.getPages().map((page) => (((page.getRotation().angle % 360) + 360) % 360));
  } catch (error) {
    console.error(error);
    toast('This PDF could not be opened for writing.', true);
    return;
  }
  state.form.previewPage = 1;
  state.form.pageA = 1;
  state.form.pageB = 1;
  const node = q('#sgPreviewPage', root);
  if (node) node.value = 1;
  seedBlocks();
  paintCard(root);
  clampPages(root);
  paintMode(root);
  paintSeal(root);
}

function seedBlocks() {
  for (const key of ['a', 'b']) {
    const margin = 64;
    const width = Number(state.form[key === 'a' ? 'widthA' : 'widthB']) || 120;
    const size = displaySize(state.form.previewPage - 1);
    const mark = markFor(key);
    const height = mark ? (width * mark.height) / mark.width : 56;
    blocks[key].x = key === 'a' ? margin : Math.max(margin, size.width - margin - width);
    blocks[key].y = Math.max(margin, size.height - margin - height - 30);
  }
}

function markFor(key) {
  const id = state.form[key === 'a' ? 'markA' : 'markB'];
  return state.marks.find((mark) => mark.id === id) ?? null;
}

function displaySize(pageIndex) {
  const size = state.pageSizes[pageIndex] ?? { width: 595, height: 842 };
  const rot = state.rotations[pageIndex] ?? 0;
  return rot === 90 || rot === 270 ? { width: size.height, height: size.width } : size;
}

function clampPages(root) {
  if (!state.pageCount) return;
  for (const key of ['previewPage', 'pageA', 'pageB']) {
    const value = Math.min(state.pageCount, Math.max(1, Math.round(Number(state.form[key]) || 1)));
    state.form[key] = value;
  }
  for (const [field, form] of [['#sgPreviewPage', 'previewPage'], ['[data-field="pageA"]', 'pageA'], ['[data-field="pageB"]', 'pageB']]) {
    const node = q(field, root);
    if (node) node.value = state.form[form];
  }
}

function blockHeight(key) {
  const mark = markFor(key);
  const width = Number(state.form[key === 'a' ? 'widthA' : 'widthB']) || 120;
  const markHeight = mark ? (width * mark.height) / mark.width : 0.62 * width;
  const rule = state.form[key === 'a' ? 'ruleA' : 'ruleB'];
  const name = (state.form[key === 'a' ? 'nameA' : 'nameB'] || (rule === 'none' ? '' : mark?.name) || '').trim();
  const title = (state.form[key === 'a' ? 'titleA' : 'titleB'] || '').trim();
  return markHeight + (rule === 'none' ? 0 : 8) + (name ? 11 : 0) + (title ? 9.5 : 0) + 2;
}

function snapTo(key, position, root) {
  const size = displaySize(state.form.previewPage - 1);
  const width = Number(state.form[key === 'a' ? 'widthA' : 'widthB']) || 120;
  const height = blockHeight(key);
  const margin = 56;
  blocks[key].x = position.includes('right') ? size.width - margin - width : position.includes('left') ? margin : (size.width - width) / 2;
  blocks[key].y = position.includes('top') ? margin : position.includes('middle') ? (size.height - height) / 2 : size.height - margin - height;
  renderStage(root);
  paintSeal(root);
}

function quickPlace(what, root) {
  if (!state.buffer) return toast('Open a PDF first.', true);
  const size = displaySize(state.form.previewPage - 1);
  const widthA = Number(state.form.widthA) || 132;
  const widthB = Number(state.form.widthB) || 116;
  if (what === 'side') {
    const gap = 40;
    const total = widthA + gap + widthB;
    const left = Math.max(40, (size.width - total) / 2);
    const top = size.height - Math.max(blockHeight('a'), blockHeight('b')) - 72;
    blocks.a.x = left;
    blocks.b.x = left + widthA + gap;
    blocks.a.y = blocks.b.y = Math.max(40, top);
    state.form.pageB = state.form.previewPage;
  } else if (what === 'below') {
    const left = Math.max(48, size.width * 0.12);
    blocks.a.x = left;
    blocks.b.x = left;
    blocks.a.y = size.height - blockHeight('a') - 84;
    blocks.b.y = blocks.a.y + blockHeight('a') + 46;
    state.form.pageB = state.form.previewPage;
  } else {
    state.form.pageB = state.form.previewPage;
  }
  clampPages(root);
  renderStage(root);
  paintSeal(root);
  toast('Placed — nudge it with the arrow keys if the line is fussy.');
}

/* -------------------------------------------------------------- preview ---- */
/* Preview renders are queued: two feeds in quick notice (or a resize during a
   drop) used to leave a cleared canvas behind, because each render reset the
   canvas size before bailing out when a newer one took over. */
let stageChain = Promise.resolve();
function renderStage(root) {
  stageChain = stageChain.then(() => renderStageNow(root)).catch((error) => {
    console.error('Sign preview could not be drawn:', error);
  });
  return stageChain;
}

/* pdf.js refuses a second render task on a canvas element it has already been
   asked to paint, so each repaint swaps in a fresh one — loading a second
   document into this tab used to leave the preview blank. */
function takeCanvas(root) {
  const holder = q('#sgPaper', root);
  if (!holder) return null;
  const previous = q('#sgCanvas', root);
  const canvas = el('canvas', {
    id: 'sgCanvas',
    'aria-label': previous?.getAttribute('aria-label') ?? 'The page you are signing, with the signature blocks on it',
  });
  if (previous) previous.replaceWith(canvas);
  else holder.prepend(canvas);
  return canvas;
}

async function renderStageNow(root) {
  const stage = q('#sgStage', root);
  // while an export is running pdf.js is rasterising pages itself, so the
  // preview waits for its turn instead of colliding with it
  if (!stage || !state.buffer || state.busy) return;
  const canvas = takeCanvas(root);
  if (!canvas) return;
  const index = Math.max(0, Math.min(state.pageCount - 1, (Number(state.form.previewPage) || 1) - 1));
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: state.buffer.slice(0), isEvalSupported: false }).promise;
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  // render at the size the canvas is actually shown, so the bitmap is never upscaled
  const cssWidth = canvas.clientWidth || Math.min(460, stage.clientWidth - 24) || 460;
  const scale = Math.min(2.4, cssWidth / base.width);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport }).promise;
  state.render = { viewport, base, index };
  page.cleanup();
  await doc.destroy();
  paintStageScale(root);
}

function paintStageScale(root) {
  const base = state.render?.base;
  if (!base) return;
  for (const key of ['a', 'b']) {
    const handle = q(`.sg-handle[data-handle="${key}"]`, root);
    if (!handle) continue;
    const mark = markFor(key);
    const onThisPage = state.form[key === 'a' ? 'pageA' : 'pageB'] === state.form.previewPage;
    handle.hidden = !onThisPage || !mark;
    if (handle.hidden) continue;
    // everything is a share of the page box, so the overlay follows the render
    const width = Number(state.form[key === 'a' ? 'widthA' : 'widthB']) || 120;
    const height = mark ? (width * mark.height) / mark.width : 0.6 * width;
    handle.style.left = `${(blocks[key].x / base.width) * 100}%`;
    handle.style.top = `${(blocks[key].y / base.height) * 100}%`;
    handle.style.width = `${(width / base.width) * 100}%`;
    handle.style.height = `${(height / base.height) * 100}%`;
    handle.setAttribute('aria-label', `${PARTY[key].title} on page ${state.form[key === 'a' ? 'pageA' : 'pageB']}, ${Math.round(blocks[key].x)} by ${Math.round(blocks[key].y)} points from the top left — drag or arrow keys to move`);
    const image = handle.querySelector('img');
    if (image && mark && image.src !== mark.dataUrl) image.src = mark.dataUrl;
  }
  const hint = q('#sgStageHint', root);
  if (hint) {
    const off = ['a', 'b'].filter((key) => state.form[key === 'a' ? 'pageA' : 'pageB'] !== state.form.previewPage).map((key) => `${PARTY[key].short} is on page ${state.form[key === 'a' ? 'pageA' : 'pageB']}`);
    hint.textContent = off.length ? `${off.join(' · ')} — change “Preview page” to see it.` : 'Drag a mark to move it. Arrow keys nudge, Shift + arrows move further.';
  }
}

function wireHandles(root) {
  const stage = q('#sgStage', root);
  if (!stage) return;
  qa('.sg-handle', stage).forEach((handle) => {
    const key = handle.dataset.handle;
    let start = null;
    handle.addEventListener('pointerdown', (event) => {
      const base = state.render?.base;
      const rect = handle.parentElement?.getBoundingClientRect();
      const scale = base && rect?.width ? rect.width / base.width : 0;
      if (!scale) return;
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      start = { x: event.clientX, y: event.clientY, bx: blocks[key].x, by: blocks[key].y, scale };
    });
    handle.addEventListener('pointermove', (event) => {
      if (!start) return;
      const size = displaySize(state.form.previewPage - 1);
      const width = Number(state.form[key === 'a' ? 'widthA' : 'widthB']) || 120;
      const height = blockHeight(key);
      blocks[key].x = Math.min(size.width - width, Math.max(0, start.bx + (event.clientX - start.x) / start.scale));
      blocks[key].y = Math.min(size.height - height, Math.max(0, start.by + (event.clientY - start.y) / start.scale));
      paintStageScale(root);
    });
    const end = () => {
      if (!start) return;
      start = null;
      paintSeal(root);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      blocks[key].x += move[0] * step;
      blocks[key].y += move[1] * step;
      paintStageScale(root);
      paintSeal(root);
    });
  });
}

/* --------------------------------------------------------------- sealing ---- */
function paintCard(root) {
  const card = q('#sgCard', root);
  if (!card) return;
  if (!state.buffer) {
    card.replaceChildren(el('p', { class: 'sg-marks-empty', text: 'No document open. The pad works anyway — your marks are kept whether or not a PDF is loaded.' }));
    const stat = q('#sgStat', root);
    if (stat) stat.textContent = 'no file';
    return;
  }
  card.replaceChildren(
    el('div', { class: 'sg-card-row' }, [
      el('div', { class: 'sg-card-name', text: state.name, title: state.name }),
      el('a', { class: 'button button-light', href: '#', text: 'Replace', onclick: (event) => { event.preventDefault(); q('#sgDrop', root)?.click(); } }),
    ]),
    el('div', { class: 'sg-chip-row' }, [
      el('span', { class: 'sg-chip', text: `${state.pageCount} ${state.pageCount === 1 ? 'page' : 'pages'}` }),
      el('span', { class: 'sg-chip', text: `${state.marks.length} saved mark${state.marks.length === 1 ? '' : 's'}` }),
      el('span', { class: 'sg-chip', text: state.form.flatten ? 'pages will be flattened' : 'text layer kept' }),
    ]),
  );
  const stat = q('#sgStat', root);
  if (stat) stat.textContent = `${state.pageCount} ${state.pageCount === 1 ? 'page' : 'pages'} · ${state.marks.length} saved ${state.marks.length === 1 ? 'mark' : 'marks'}`;
}

function paintSeal(root) {
  paintCard(root);
  const box = q('#sgSummary', root);
  const hint = q('#sgSealHint', root);
  const lines = ['a', 'b'].map((key) => {
    const mark = markFor(key);
    const page = state.form[key === 'a' ? 'pageA' : 'pageB'];
    const width = Math.round(Number(state.form[key === 'a' ? 'widthA' : 'widthB']) || 120);
    const name = (state.form[key === 'a' ? 'nameA' : 'nameB'] || '').trim();
    const title = (state.form[key === 'a' ? 'titleA' : 'titleB'] || '').trim();
    const rule = state.form[key === 'a' ? 'ruleA' : 'ruleB'];
    const date = state.form[key === 'a' ? 'dateA' : 'dateB'];
    return { key, mark, page, width, name, title, rule, date, x: Math.round(blocks[key].x), y: Math.round(blocks[key].y) };
  });
  if (box) {
    box.replaceChildren(
      ...lines.map((line) =>
        el('div', { class: `sg-summary-row${line.mark ? '' : ' is-empty'}` }, [
          el('span', { class: 'sg-summary-who', text: PARTY[line.key].title }),
          el('span', { class: 'sg-summary-mark', text: line.mark ? line.mark.name : 'nothing chosen' }),
          el('span', { class: 'sg-summary-where', text: line.mark ? `page ${line.page} · ${line.width}pt wide · ${line.x}×${line.y} pt from the top left` : 'add a mark in the pad panel' }),
          el('span', { class: 'sg-summary-under', text: [line.name || (line.rule !== 'none' ? 'the mark’s own name' : ''), line.title, line.date !== 'none' ? (line.date === 'beside' ? 'date at the right' : 'date under') : ''].filter(Boolean).join(' · ') || 'no caption' }),
        ]),
      ),
    );
  }
  if (hint) {
    if (!state.buffer) hint.textContent = 'No document open.';
    else {
      const count = lines.filter((line) => line.mark).length;
      hint.textContent = `${count} signature${count === 1 ? '' : 's'} will be drawn${state.form.flatten ? ' on flattened pages' : ''}.`;
    }
  }
  const button = q('#sgSignGo', root);
  if (button) button.disabled = !state.buffer || !lines.some((line) => line.mark);
}

function dateText() {
  return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function sign(root) {
  if (!state.buffer) return toast('Open a PDF first.', true);
  const plans = ['a', 'b']
    .map((key) => {
      const mark = markFor(key);
      if (!mark) return null;
      return { key, mark, page: Math.max(1, Math.min(state.pageCount, state.form[key === 'a' ? 'pageA' : 'pageB'])), width: Number(state.form[key === 'a' ? 'widthA' : 'widthB']) || 120 };
    })
    .filter(Boolean);
  if (!plans.length) return toast('Choose a signature for at least one side.', true);

  await withBusy(root, '#sgSignGo', state.form.flatten ? 'Flattening and signing…' : 'Signing…', async () => {
    const signed = await drawSignatures(plans);
    const out = state.form.flatten ? await flattenPages(signed, [...new Set(plans.map((plan) => plan.page - 1))]) : signed;
    downloadBlob(new Blob([out], { type: 'application/pdf' }), `${state.name.replace(/\.pdf$/i, '')}-signed.pdf`);
    toast(`${plans.length} signature${plans.length === 1 ? '' : 's'} drawn${state.form.flatten ? ' into the page image' : ''}. The file is in your downloads.`);
  });
}

async function drawSignatures(plans) {
  const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
  const doc = await PDFDocument.load(state.buffer.slice(0), { ignoreEncryption: true, updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const plan of plans) {
    const page = doc.getPage(plan.page - 1);
    const image = await doc.embedPng(await dataUrlToBytes(plan.mark.dataUrl));
    const size = page.getSize();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const display = rot === 90 || rot === 270 ? { width: size.height, height: size.width } : size;
    const key = plan.key;
    const height = (plan.width * image.height) / image.width;
    const frame = { width: size.width, height: size.height, rot };
    const draw = (dx, dyUp, op) => op(page, displayToPdf(dx, dyUp, frame), rot);
    const drawText = (dx, dyUp, text, options) => {
      const anchor = displayToPdf(dx, dyUp, frame);
      page.drawText(text, { ...options, x: anchor.x, y: anchor.y, rotate: degrees(rot) });
    };
    const ink = hexToRgb(state.form.textInk);
    const captionInk = hexToRgb(state.form.captionInk);
    const blockTop = blocks[key].y;
    const markBottom = display.height - blockTop - height;

    draw(blocks[key].x, markBottom, (target, anchor, angle) => target.drawImage(image, {
      x: anchor.x,
      y: anchor.y,
      width: plan.width,
      height,
      rotate: degrees(angle),
    }));

    const rule = state.form[key === 'a' ? 'ruleA' : 'ruleB'];
    let cursor = markBottom - 6;
    if (rule !== 'none') {
      const start = displayToPdf(blocks[key].x, cursor, frame);
      const end = displayToPdf(blocks[key].x + plan.width, cursor, frame);
      drawRule(page, rgb, start, end, ink, rule);
      cursor -= 5;
    }
    const name = (state.form[key === 'a' ? 'nameA' : 'nameB'] || (rule === 'none' ? '' : plan.mark.name) || '').trim();
    const title = (state.form[key === 'a' ? 'titleA' : 'titleB'] || '').trim();
    const date = state.form[key === 'a' ? 'dateA' : 'dateB'];
    const captionSize = Number(state.form.captionSize) || 8.5;
    if (name) {
      drawText(blocks[key].x, cursor - captionSize, name, { size: captionSize, font: bold, color: rgb(...captionInk) });
      if (date === 'beside') {
        const text = dateText();
        const offset = Math.max(0, plan.width - font.widthOfTextAtSize(text, captionSize));
        drawText(blocks[key].x + offset, cursor - captionSize, text, { size: captionSize, font, color: rgb(...captionInk) });
      }
      cursor -= captionSize + 3;
    }
    if (title) {
      drawText(blocks[key].x, cursor - (captionSize - 1), title, { size: captionSize - 1, font, color: rgb(...captionInk) });
      cursor -= captionSize + 2;
    }
    if (date === 'today' && !name && !title) {
      drawText(blocks[key].x, cursor - captionSize, dateText(), { size: captionSize, font, color: rgb(...captionInk) });
    }
  }
  return doc.save({ useObjectStreams: false });
}

function drawRule(page, rgbOf, start, end, ink, rule) {
  page.drawLine({
    start,
    end,
    thickness: 0.7,
    color: rgbOf(...ink),
    dashArray: rule === 'dotted' ? [1.6, 1.8] : [],
  });
}

/* display-space bottom-left → PDF user space, for the four /Rotate quadrants. */
function displayToPdf(dx, dyUp, { width, height, rot }) {
  if (rot === 90) return { x: width - dyUp, y: dx };
  if (rot === 180) return { x: width - dx, y: height - dyUp };
  if (rot === 270) return { x: dyUp, y: height - dx };
  return { x: dx, y: dyUp };
}

async function flattenPages(pdfBytes, pageIndexes) {
  const { PDFDocument, degrees } = await loadPdfLib();
  const pdfjs = await loadPdfJs();
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const view = await pdfjs.getDocument({ data: pdfBytes.slice(0), isEvalSupported: false }).promise;
  const flat = new Set(pageIndexes);
  const out = await PDFDocument.create();
  for (const [get, set] of [['getTitle', 'setTitle'], ['getAuthor', 'setAuthor'], ['getSubject', 'setSubject'], ['getCreator', 'setCreator'], ['getProducer', 'setProducer']]) {
    const value = src[get]();
    if (value) out[set](value);
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
    const raw = await dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92));
    const image = await out.embedJpg(raw);
    const size = src.getPage(index).getSize();
    const newPage = out.addPage([size.width, size.height]);
    const pageRotation = src.getPage(index).getRotation().angle;
    if (pageRotation) newPage.setRotation(degrees(pageRotation));
    newPage.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
    page.cleanup();
  }
  await view.destroy();
  return out.save({ useObjectStreams: false });
}

async function dataUrlToBytes(dataUrl) {
  const binary = atob(String(dataUrl).split(',')[1] ?? '');
  const raw = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) raw[index] = binary.charCodeAt(index);
  return raw;
}

function hexToRgb(hex) {
  const clean = String(hex || '#000').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
}

/* -------------------------------------------------------------- modes ---- */
function paintMode(root) {
  const shell = q('#sgShell', root);
  if (shell) shell.dataset.mode = state.mode;
  qa('[data-mode-btn]', root).forEach((node) => {
    const on = node.dataset.modeBtn === state.mode;
    node.classList.toggle('is-on', on);
    node.setAttribute('aria-pressed', String(on));
  });
  qa('[data-sg-panel]', root).forEach((panel) => {
    panel.hidden = panel.dataset.sgPanel !== state.mode;
  });
  const work = q('#sgWork', root);
  const off = q('#sgNoFile', root);
  if (work) work.hidden = !state.buffer;
  if (off) off.hidden = Boolean(state.buffer);
  if (state.mode === 'pad') requestAnimationFrame(() => sizePad(root));
  if (state.mode === 'place') requestAnimationFrame(() => { paintStageScale(root); renderStage(root); });
  if (state.buffer) paintCard(root);
  paintSeal(root);
}

async function withBusy(root, id, label, work) {
  const button = q(id, root);
  if (!button || state.busy) return;
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
    button.innerHTML = original;
    button.classList.remove('is-busy');
    renderStage(root);
    paintSeal(root);
  }
}

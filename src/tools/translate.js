/* Live Translate — pull text out of a PDF (or the Markdown studio), translate
   it block by block, watch it arrive, then write it back.

   Two ways of keeping a page's shape:

   * On the page (overlay) — every block of source text is white-boxed and the
     translation is drawn where the original stood, in the same size and the
     same column, shrinking to fit rather than reflowing. Tables, images and
     multi-column layouts survive because nothing moves. Latin scripts go in as
     real, selectable text; everything else is drawn as a crisp picture, since
     a PDF font browser-side cannot encode Bengali or Arabic.
   * Re-typeset — blocks are recognised as headings, quotes, list items and
     paragraphs and set fresh on the paper from the shared page setup, with
     document-wide typography and per-block overrides.

   Translation calls go straight from this browser to the provider you pick. */
import {
  debounce,
  downloadBlob,
  el,
  escapeHtml,
  loadPdfJs,
  loadPdfLib,
  pdfjsAssetOptions,
  q,
  qa,
  safeFileName,
  store,
  toast,
} from '../lib.js';
import { exportHtmlAsPdf } from '../render.js';
import { marginsMm, onPage, page, printButton, sheetMm } from '../page.js';
import { isLatinText, isRtlText, layoutParagraph, measureContext, paintParagraph, paragraphCanvas } from '../textimage.js';

const LANGUAGES = [
  ['auto', 'Auto detect (recommended)'],
  ['en', 'English'],
  ['bn', 'Bengali — বাংলা'],
  ['hi', 'Hindi — हिन्दी'],
  ['ur', 'Urdu — اردو'],
  ['ar', 'Arabic — العربية'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['pt', 'Portuguese'],
  ['it', 'Italian'],
  ['nl', 'Dutch'],
  ['tr', 'Turkish'],
  ['fa', 'Persian'],
  ['id', 'Indonesian'],
  ['ms', 'Malay'],
  ['th', 'Thai'],
  ['vi', 'Vietnamese'],
  ['zh-CN', 'Chinese (simplified)'],
  ['zh-TW', 'Chinese (traditional)'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['ru', 'Russian'],
  ['uk', 'Ukrainian'],
  ['pl', 'Polish'],
  ['cs', 'Czech'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['fi', 'Finnish'],
  ['no', 'Norwegian'],
  ['el', 'Greek'],
  ['he', 'Hebrew'],
  ['sw', 'Swahili'],
  ['ta', 'Tamil'],
  ['te', 'Telugu'],
  ['mr', 'Marathi'],
  ['ne', 'Nepali'],
  ['si', 'Sinhala'],
  ['my', 'Burmese'],
  ['km', 'Khmer'],
  ['lo', 'Lao'],
  ['ro', 'Romanian'],
  ['hu', 'Hungarian'],
  ['bg', 'Bulgarian'],
  ['sr', 'Serbian'],
  ['hr', 'Croatian'],
  ['sk', 'Slovak'],
  ['sl', 'Slovenian'],
  ['lt', 'Lithuanian'],
  ['lv', 'Latvian'],
  ['et', 'Estonian'],
  ['ca', 'Catalan'],
  ['af', 'Afrikaans'],
  ['am', 'Amharic'],
  ['ha', 'Hausa'],
  ['yo', 'Yoruba'],
  ['zu', 'Zulu'],
];

const RTL_TARGETS = new Set(['ar', 'ur', 'fa', 'he', 'ps', 'sd', 'ug', 'yi']);

const PROVIDERS = {
  gtx: { label: 'Google (free endpoint)', note: 'Best quality, one request per block', maxChars: 4500, batch: false },
  mymemory: { label: 'MyMemory', note: 'Generous for short documents, no key needed', maxChars: 460, batch: false },
  libre: { label: 'LibreTranslate (own server)', note: 'Fully self-hosted — add your URL below', maxChars: 4000, batch: true },
  manual: { label: 'No translation service', note: 'Extract the lines and type them yourself', maxChars: 0, batch: false, manual: true },
};

/* Typefaces the browser already has — no font files to ship, no uploads. */
const FAMILIES = [
  ['auto', 'Match the language', "'DM Sans', 'Avenir Next', system-ui, sans-serif", 400],
  ['dm-sans', 'DM Sans (interface)', "'DM Sans', 'Avenir Next', system-ui, sans-serif", 400],
  ['playfair', 'Playfair Display (editorial)', "'Playfair Display', Georgia, 'Times New Roman', serif", 500],
  ['georgia', 'Georgia (classic serif)', "Georgia, 'Times New Roman', serif", 400],
  ['system', 'System UI', "system-ui, -apple-system, 'Segoe UI', sans-serif", 400],
  ['noto-bn', 'Noto Sans Bengali', "'Noto Sans Bengali', 'Nirmala UI', 'Vrinda', sans-serif", 400],
  ['noto-ar', 'Noto Naskh Arabic', "'Noto Naskh Arabic', 'Segoe UI', Tahoma, sans-serif", 400],
  ['noto-cjk', 'Noto Sans CJK', "'Noto Sans CJK SC', 'Noto Sans JP', 'Hiragino Sans', 'Microsoft YaHei', sans-serif", 400],
  ['mono', 'DM Mono', "'DM Mono', ui-monospace, 'SFMono-Regular', monospace", 400],
];

const defaultsV2 = {
  provider: 'gtx',
  target: 'bn',
  source: 'auto',
  libreUrl: '',
  libreKey: '',
  batch: false,
  delay: 220,
  bilingual: false,
  keepPages: true,
  showSource: true,
  glossary: '',
  theme: 'editorial',
  fidelity: 'page',
  original: 'cover',
  fitPaper: false,
  cover: '#ffffff',
  ink: '#1c211d',
  typography: {
    family: 'dm-sans',
    size: 12,
    lineHeight: 1.5,
    spacing: 10,
    align: 'left',
    indent: 0,
    rtl: 'auto',
  },
  blockOverrides: {},
};

/* v1 kept a paper size here and no typography; carry the reader's choices over. */
const legacy = store('translate:v1', {}).read();
const prefs = store('translate:v2', defaultsV2);
const stored = prefs.read();
const form = {
  ...stored,
  typography: { ...defaultsV2.typography, ...(stored.typography ?? {}), ...(stored.typography ? {} : {}) },
  blockOverrides: { ...(stored.blockOverrides ?? {}) },
};
if (legacy.provider && !window.localStorage.getItem('folio:translate:v2')) {
  Object.assign(form, {
    provider: legacy.provider ?? form.provider,
    target: legacy.target ?? form.target,
    source: legacy.source ?? form.source,
    libreUrl: legacy.libreUrl ?? '',
    libreKey: legacy.libreKey ?? '',
    glossary: legacy.glossary ?? '',
    showSource: legacy.showSource ?? form.showSource,
  });
}

const state = {
  segments: [],
  pages: [],
  running: false,
  controller: null,
  origin: 'nothing',
  originLabel: '',
  fileName: 'translated',
  pageCount: 0,
  glossary: [],
  pdfBytes: null,
  pdfDoc: null,
  selected: null,
  overlayPage: 0,
  overlayScale: 1,
};

const PT_PER_MM = 72 / 25.4;

const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';
const eyeIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2.8 10S5.8 5.4 10 5.4 17.2 10 17.2 10 14.2 14.6 10 14.6 2.8 10 2.8 10Z"/><circle cx="10" cy="10" r="1.9"/></svg>';

export function start(root) {
  root.innerHTML = layout();
  hydrate(root);
  wire(root);
  renderList(root);
  renderPreview(root, true);
  return () => state.controller?.abort();
}

/* ------------------------------------------------------------------ ui ---- */
function layout() {
  const sourceOptions = LANGUAGES.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('');
  const targetOptions = LANGUAGES.filter(([value]) => value !== 'auto').map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('');
  return `
<div class="tr-shell">
  <section class="panel tr-side" aria-labelledby="tr-side-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">01</span>
        <div><h3 id="tr-side-title">Bring text in</h3><p id="trSideNote">PDF, Markdown studio, or paste</p></div>
      </div>
      <div class="panel-header-actions"><span class="lab-count" id="trOriginState">empty</span></div>
    </div>

    <div class="tr-sources">
      <label class="tr-source" data-source="pdf">
        <input type="radio" name="trSourceKind" value="pdf" checked />
        <span class="tr-source-text"><strong>A PDF on this device</strong><small>Text is extracted locally with pdf.js</small></span>
      </label>
      <label class="tr-source" data-source="markdown">
        <input type="radio" name="trSourceKind" value="markdown" />
        <span class="tr-source-text"><strong>The Markdown studio</strong><small>Translate whatever is in the editor right now</small></span>
      </label>
      <label class="tr-source" data-source="paste">
        <input type="radio" name="trSourceKind" value="paste" />
        <span class="tr-source-text"><strong>Paste or type</strong><small>Free text, split into paragraphs</small></span>
      </label>
    </div>

    <div class="tr-source-body" data-body="pdf">
      <div class="lab-drop" id="trPdfDrop" role="button" tabindex="0" aria-label="Choose a PDF to translate">
        <span class="dropzone-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h5.2l3.3 3.3v9.7H6z"/><path d="M11 3.6v3.3h3.2"/></svg></span>
        <strong>Drop a PDF</strong>
        <span id="trPdfName">or click to choose a file</span>
      </div>
    </div>
    <div class="tr-source-body" data-body="markdown" hidden>
      <p class="lab-help">Uses the document currently open in the Markdown → PDF tab, Markdown syntax and all.</p>
      <button class="button button-light" type="button" id="trPullMarkdown">Load from the Markdown studio</button>
    </div>
    <div class="tr-source-body" data-body="paste" hidden>
      <textarea class="tr-paste" id="trPaste" rows="8" placeholder="Paste anything — letters, an article, a recipe…" aria-label="Text to translate"></textarea>
      <button class="button button-light" type="button" id="trLoadPaste">Use this text</button>
    </div>

    <p class="lab-help tr-fidelity-note" id="trFidelityNote"></p>
  </section>

  <section class="panel tr-main" aria-labelledby="tr-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="tr-main-title">Translate live</h3><p><span class="live-dot"></span> Each block lands as it arrives</p></div>
      </div>
      <div class="panel-header-actions tr-header-actions">
        <button class="button button-light" type="button" id="trStop" hidden>Stop</button>
        ${printButton()}
        <button class="button button-export" type="button" id="trPdf">${downloadIcon}<span>PDF</span></button>
      </div>
    </div>

    <div class="tr-controls">
      <label class="field"><span class="field-label">From</span>
        <select class="text-input" id="trFrom">${sourceOptions}</select>
      </label>
      <span class="tr-arrow" aria-hidden="true">→</span>
      <label class="field"><span class="field-label">Into</span>
        <select class="text-input" id="trTo">${targetOptions}</select>
      </label>
      <label class="field"><span class="field-label">Provider</span>
        <select class="text-input" id="trProvider">
          ${Object.entries(PROVIDERS).map(([key, value]) => `<option value="${key}">${value.label}</option>`).join('')}
        </select>
      </label>
      <button class="button button-export" type="button" id="trRun">${'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.2 8.4 14l7-8.4"/></svg>'}<span>Translate</span></button>
    </div>
    <p class="tr-provider-note" id="trProviderNote"></p>

    <div class="tr-extras" id="trExtras" hidden>
      <label class="field"><span class="field-label">LibreTranslate server</span><input class="text-input" id="trLibreUrl" type="url" placeholder="https://translate.yourserver.com" /></label>
      <label class="field"><span class="field-label">Key (optional)</span><input class="text-input" id="trLibreKey" type="text" placeholder="not stored anywhere but this tab" /></label>
    </div>

    <div class="tr-fidelity" role="group" aria-label="How the translation is written back">
      <span class="field"><span class="field-label">Fidelity</span>
        <span class="pg-seg-row" id="trFidelity">
          <button type="button" class="pg-seg" data-fidelity="page">On the page</button>
          <button type="button" class="pg-seg" data-fidelity="retype">Re-typeset</button>
        </span>
      </span>
      <label class="field tr-overlay-only"><span class="field-label">Original text</span>
        <select class="text-input" id="trOriginal">
          <option value="cover">Covered by the translation</option>
          <option value="keep">Kept — translation on the next page</option>
        </select>
      </label>
      <label class="field field-switch tr-overlay-only"><input type="checkbox" class="switch-input" id="trFit" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Fit onto the paper in the strip</span></label>
      <label class="field field-colour tr-overlay-only"><span class="field-label">Cover with</span><span class="colour-wrap"><input class="colour-input" id="trCover" type="color" /><code id="trCoverCode">#ffffff</code></span></label>
      <label class="field field-colour tr-overlay-only"><span class="field-label">Ink</span><span class="colour-wrap"><input class="colour-input" id="trInk" type="color" /><code id="trInkCode">#1c211d</code></span></label>
      <label class="field field-switch" id="trBilingualWrap"><input type="checkbox" class="switch-input" id="trBilingual" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Two-column PDF</span></label>
    </div>
    <p class="tr-hint" id="trFidelityHint"></p>

    <div class="tr-progress" role="status" aria-live="polite">
      <div class="tr-progress-bar"><span id="trProgressBar"></span></div>
      <span class="tr-progress-text" id="trProgressText">Nothing to translate yet</span>
    </div>

    <div class="tr-list" id="trList" role="list"></div>

    <div class="tr-foot">
      <div class="tr-foot-left">
        <label class="field field-switch"><input type="checkbox" class="switch-input" id="trShowSource" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Show the original</span></label>
        <label class="field field-switch"><input type="checkbox" class="switch-input" id="trBatch" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Batch requests (faster)</span></label>
        <label class="field field-select-sm"><span class="field-label">Style</span>
          <select class="text-input" id="trTheme">
            <option value="editorial">Editorial</option><option value="modern">Modern</option><option value="warm">Warm paper</option>
          </select>
        </label>
      </div>
      <div class="tr-foot-right">
        <button class="button button-light" type="button" id="trTxt"><span>.txt</span></button>
        <button class="button button-light" type="button" id="trMd"><span>.md</span></button>
        <button class="button button-light" type="button" id="trCopy"><span>Copy</span></button>
        <button class="button button-text" type="button" id="trGlossary"><span>Glossary</span></button>
      </div>
    </div>

    <div class="tr-glossary" id="trGlossaryPanel" hidden>
      <p class="lab-help">One per line, <code>term = fixed translation</code>. Applied after the machine pass — perfect for names, product words, and jargon.</p>
      <textarea class="tr-paste" id="trGlossaryText" rows="4" placeholder="Dhaka = ঢাকা&#10;BSc = BSc  (leave acronyms alone)"></textarea>
    </div>
  </section>

  <section class="panel tr-preview" aria-labelledby="tr-preview-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">03</span>
        <div><h3 id="tr-preview-title">Page preview</h3><p><span class="live-dot"></span> Exactly what the PDF will hold</p></div>
      </div>
      <div class="panel-header-actions">
        <span class="lab-count" id="trPreviewNote">nothing yet</span>
        <button class="button button-text" type="button" id="trPreviewToggle">Hide</button>
      </div>
    </div>
    <div class="tr-preview-note">
      <span id="trPreviewWhere">unchanged original layout</span>
      <span class="tr-page-nav" id="trPageNav" hidden>
        <button class="button button-text" type="button" id="trPagePrev">‹</button>
        <span class="lab-count" id="trPageLabel">page 1 / 1</span>
        <button class="button button-text" type="button" id="trPageNext">›</button>
      </span>
    </div>
    <div class="tr-preview-stage" id="trPreviewStage">
      <div class="tr-scaler" id="trScaler">
        <div class="tr-zoom" id="trZoom">
          <article class="paper tr-sheet" data-print-root data-theme="${escapeHtml(form.theme)}" data-page-size="a4" data-orientation="portrait" aria-label="Translated document preview">
            <div class="document-content" id="trPaper"></div>
            <canvas id="trOverlay" class="tr-overlay-canvas" hidden aria-label="The original page with the translation drawn over it"></canvas>
          </article>
        </div>
      </div>
    </div>

    <div class="tr-type" id="trType">
      <div class="tr-type-head">
        <span class="lab-count">Typography${''}</span>
        <span class="tr-type-scope" id="trTypeScope">applies to the whole document</span>
      </div>
      <div class="tr-type-grid">
        <label class="field"><span class="field-label">Typeface</span>
          <select class="text-input" id="trFamily">${FAMILIES.map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join('')}</select>
        </label>
        <label class="field"><span class="field-label-row"><span class="field-label">Size</span><output class="range-readout" id="trSizeOut">12 pt</output></span><input class="range-input" id="trSize" type="range" min="7" max="26" step="0.5" /></label>
        <label class="field"><span class="field-label-row"><span class="field-label">Line height</span><output class="range-readout" id="trLeadOut">1.5</output></span><input class="range-input" id="trLead" type="range" min="1.05" max="2.4" step="0.05" /></label>
        <label class="field"><span class="field-label-row"><span class="field-label">Paragraph gap</span><output class="range-readout" id="trGapOut">10 pt</output></span><input class="range-input" id="trGap" type="range" min="0" max="32" step="1" /></label>
        <label class="field"><span class="field-label-row"><span class="field-label">First-line indent</span><output class="range-readout" id="trIndentOut">0 pt</output></span><input class="range-input" id="trIndent" type="range" min="0" max="28" step="1" /></label>
        <span class="field"><span class="field-label">Alignment</span>
          <span class="pg-seg-row" id="trAlign" role="group" aria-label="Text alignment">
            <button type="button" class="pg-seg" data-align="left">Left</button>
            <button type="button" class="pg-seg" data-align="center">Centre</button>
            <button type="button" class="pg-seg" data-align="right">Right</button>
            <button type="button" class="pg-seg" data-align="justify">Justify</button>
          </span>
        </span>
        <label class="field field-switch"><input type="checkbox" class="switch-input" id="trRtl" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Right-to-left</span></label>
      </div>
      <div class="tr-blockpanel" id="trBlock" hidden>
        <div class="tr-blockpanel-head">
          <span class="lab-count" id="trBlockName">No block selected</span>
          <span>
            <button class="button button-text" type="button" id="trBlockClear">Clear this block</button>
            <button class="button button-text" type="button" id="trBlockClose">Done</button>
          </span>
        </div>
        <p class="lab-help">Overrules the document style for one block — click a paragraph in the preview, or a row in the list.</p>
        <div class="tr-blockpanel-grid">
          <span class="field"><span class="field-label">Alignment</span>
            <span class="pg-seg-row" id="trBlockAlign" role="group" aria-label="Block alignment">
              <button type="button" class="pg-seg" data-align="">Auto</button>
              <button type="button" class="pg-seg" data-align="left">Left</button>
              <button type="button" class="pg-seg" data-align="center">Centre</button>
              <button type="button" class="pg-seg" data-align="right">Right</button>
              <button type="button" class="pg-seg" data-align="justify">Justify</button>
            </span>
          </span>
          <label class="field"><span class="field-label">Size (empty = document)</span><input class="text-input text-input-narrow" id="trBlockSize" type="number" min="6" max="48" step="0.5" placeholder="auto" /></label>
          <span class="field"><span class="field-label">Weight</span>
            <span class="pg-seg-row" id="trBlockWeight" role="group" aria-label="Block weight">
              <button type="button" class="pg-seg" data-weight="">Auto</button>
              <button type="button" class="pg-seg" data-weight="400">Regular</button>
              <button type="button" class="pg-seg" data-weight="600">Medium</button>
              <button type="button" class="pg-seg" data-weight="700">Bold</button>
            </span>
          </span>
          <span class="field"><span class="field-label">Block type</span>
            <span class="pg-seg-row" id="trBlockStyle" role="group" aria-label="Block type">
              <button type="button" class="pg-seg" data-style="">Auto</button>
              <button type="button" class="pg-seg" data-style="para">Paragraph</button>
              <button type="button" class="pg-seg" data-style="heading">Heading</button>
              <button type="button" class="pg-seg" data-style="quote">Quote</button>
              <button type="button" class="pg-seg" data-style="list">List</button>
            </span>
          </span>
        </div>
      </div>
    </div>
  </section>
</div>`;
}

function hydrate(root) {
  q('#trFrom', root).value = form.source;
  q('#trTo', root).value = form.target;
  q('#trProvider', root).value = form.provider;
  q('#trLibreUrl', root).value = form.libreUrl;
  q('#trLibreKey', root).value = form.libreKey;
  q('#trBatch', root).checked = Boolean(form.batch);
  q('#trBilingual', root).checked = Boolean(form.bilingual);
  q('#trShowSource', root).checked = Boolean(form.showSource);
  q('#trTheme', root).value = form.theme;
  q('#trGlossaryText', root).value = form.glossary;
  q('#trOriginal', root).value = form.original;
  q('#trFit', root).checked = Boolean(form.fitPaper);
  q('#trCover', root).value = form.cover;
  q('#trInk', root).value = form.ink;
  const type = form.typography;
  q('#trFamily', root).value = type.family;
  q('#trSize', root).value = String(type.size);
  q('#trLead', root).value = String(type.lineHeight);
  q('#trGap', root).value = String(type.spacing);
  q('#trIndent', root).value = String(type.indent);
  q('#trRtl', root).checked = type.rtl === 'rtl';
  parseGlossary();
  paintFidelity(root);
  paintTypography(root);
}

function wire(root) {
  const save = debounce(() => prefs.write(form), 250);
  const onChange = (id, key, cast = (value) => value, after) => {
    const node = q(id, root);
    if (!node) return;
    const handler = () => {
      const value = node.type === 'checkbox' ? node.checked : node.value;
      form[key] = cast(value);
      save();
      after?.();
    };
    node.addEventListener('change', handler);
    node.addEventListener('input', handler);
  };
  onChange('#trFrom', 'source');
  onChange('#trTo', 'target', (value) => {
    if (form.typography.rtl === 'auto') q('#trRtl', root).checked = RTL_TARGETS.has(value);
    return value;
  }, () => {
    if (form.typography.rtl === 'auto') form.typography.rtl = RTL_TARGETS.has(form.target) ? 'rtl' : 'ltr';
    paintTypography(root);
    renderPreview(root);
  });
  onChange('#trProvider', 'provider', undefined, () => paintProvider(root));
  onChange('#trLibreUrl', 'libreUrl');
  onChange('#trLibreKey', 'libreKey');
  onChange('#trBatch', 'batch');
  onChange('#trBilingual', 'bilingual', undefined, () => renderPreview(root));
  onChange('#trShowSource', 'showSource', undefined, () => paintListMode(root));
  onChange('#trTheme', 'theme', undefined, () => renderPreview(root));
  onChange('#trGlossaryText', 'glossary', undefined, () => {
    parseGlossary();
    if (state.segments.some((segment) => segment.translated)) renderList(root);
  });
  onChange('#trOriginal', 'original', undefined, () => {
    paintFidelity(root);
    renderPreview(root);
  });
  onChange('#trFit', 'fitPaper', undefined, () => renderPreview(root));
  onChange('#trCover', 'cover', undefined, () => {
    q('#trCoverCode', root).textContent = form.cover;
    renderPreview(root);
  });
  onChange('#trInk', 'ink', undefined, () => {
    q('#trInkCode', root).textContent = form.ink;
    renderPreview(root);
  });

  /* typography — document-wide */
  const typeOn = (selector, key, cast = (v) => v, after) => {
    const node = q(selector, root);
    if (!node) return;
    const handler = () => {
      const value = node.type === 'checkbox' ? node.checked : node.value;
      form.typography[key] = cast(value);
      save();
      paintTypography(root);
      after?.();
    };
    node.addEventListener('change', handler);
    node.addEventListener('input', handler);
  };
  typeOn('#trFamily', 'family', undefined, () => {
    // a target script usually wants its own face
    if (form.typography.family === 'dm-sans') return;
    renderPreview(root);
  });
  typeOn('#trSize', 'size', Number);
  typeOn('#trLead', 'lineHeight', Number);
  typeOn('#trGap', 'spacing', Number);
  typeOn('#trIndent', 'indent', Number);
  typeOn('#trRtl', 'rtl', (value) => (value ? 'rtl' : 'ltr'));

  q('#trAlign', root)?.addEventListener('click', (event) => {
    const node = event.target.closest('[data-align]');
    if (!node) return;
    form.typography.align = node.dataset.align;
    save();
    paintTypography(root);
    renderPreview(root);
  });

  q('#trFidelity', root)?.addEventListener('click', (event) => {
    const node = event.target.closest('[data-fidelity]');
    if (!node) return;
    form.fidelity = node.dataset.fidelity;
    save();
    paintFidelity(root);
    renderPreview(root, true);
  });

  /* per-block overrides */
  const blockOn = (selector, key, cast = (v) => v) => {
    q(selector, root)?.addEventListener('click', (event) => {
      const node = event.target.closest('[data-' + key + ']');
      if (!node || !state.selected) return;
      const override = { ...(form.blockOverrides[state.selected] ?? {}) };
      const value = cast(node.dataset[key]);
      if (value === '' || value === null || value === undefined) delete override[key];
      else override[key] = value;
      form.blockOverrides[state.selected] = override;
      save();
      paintBlockPanel(root);
      renderPreview(root);
    });
  };
  blockOn('#trBlockAlign', 'align');
  blockOn('#trBlockWeight', 'weight');
  blockOn('#trBlockStyle', 'style');
  onChange('#trBlockSize', 'blockSizeDraft', undefined, () => {});
  q('#trBlockSize', root)?.addEventListener('input', (event) => {
    if (!state.selected) return;
    const override = { ...(form.blockOverrides[state.selected] ?? {}) };
    const value = Number(event.target.value);
    if (!event.target.value.trim() || !Number.isFinite(value)) delete override.size;
    else override.size = value;
    form.blockOverrides[state.selected] = override;
    save();
    renderPreview(root);
  });
  q('#trBlockClear', root)?.addEventListener('click', () => {
    if (!state.selected) return;
    delete form.blockOverrides[state.selected];
    save();
    paintBlockPanel(root);
    renderPreview(root);
  });
  q('#trBlockClose', root)?.addEventListener('click', () => {
    state.selected = null;
    paintBlockPanel(root);
    renderPreview(root);
  });

  qa('[name="trSourceKind"]', root).forEach((node) => {
    node.addEventListener('change', () => {
      qa('.tr-source', root).forEach((label) => label.classList.toggle('is-on', label.contains(node)));
      qa('[data-body]', root).forEach((body) => {
        body.hidden = body.dataset.body !== node.value;
      });
    });
  });
  q('.tr-source[data-source="pdf"]', root)?.classList.add('is-on');

  const openPicker = () => pickOne(root);
  const drop = q('#trPdfDrop', root);
  drop.addEventListener('click', openPicker);
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  });
  let depth = 0;
  drop.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    depth += 1;
    drop.classList.add('is-dragging');
  });
  drop.addEventListener('dragover', (event) => event.preventDefault());
  drop.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) drop.classList.remove('is-dragging');
  });
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    drop.classList.remove('is-dragging');
    const file = Array.from(event.dataTransfer?.files || []).find((item) => /\.pdf$/i.test(item.name));
    if (file) ingestPdf(file, root);
    else toast('That was not a PDF.', true);
  });

  q('#trPullMarkdown', root)?.addEventListener('click', () => {
    const input = q('#markdownInput');
    if (!input?.value.trim()) {
      toast('The Markdown studio is empty — write something first.', true);
      return;
    }
    ingestMarkdown(input.value, root);
  });
  q('#trLoadPaste', root)?.addEventListener('click', () => {
    const value = q('#trPaste', root).value;
    if (!value.trim()) {
      toast('Paste some text first.', true);
      return;
    }
    ingestText(value, 'pasted-text', root);
  });

  q('#trRun', root)?.addEventListener('click', () => (state.running ? stop(root) : run(root)));
  q('#trStop', root)?.addEventListener('click', () => stop(root));
  q('#trPdf', root)?.addEventListener('click', () => exportPdf(root));
  q('#trTxt', root)?.addEventListener('click', () => downloadText('text/plain', root));
  q('#trMd', root)?.addEventListener('click', () => downloadText('text/markdown', root, true));
  q('#trCopy', root)?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(asPlainText());
      toast('Translated text copied.');
    } catch (error) {
      console.error(error);
      toast('Your browser blocked the clipboard — try the .txt download.', true);
    }
  });
  q('#trGlossary', root)?.addEventListener('click', () => {
    const panel = q('#trGlossaryPanel', root);
    panel.hidden = !panel.hidden;
  });
  q('#trPreviewToggle', root)?.addEventListener('click', (event) => {
    const stage = q('#trPreviewStage', root);
    stage.classList.toggle('is-hidden');
    event.target.textContent = stage.classList.contains('is-hidden') ? 'Show' : 'Hide';
    paintScale(root);
  });
  q('#trPagePrev', root)?.addEventListener('click', () => {
    state.overlayPage = Math.max(0, state.overlayPage - 1);
    renderPreview(root, true);
  });
  q('#trPageNext', root)?.addEventListener('click', () => {
    state.overlayPage = Math.min(state.pages.length - 1, state.overlayPage + 1);
    renderPreview(root, true);
  });
  q('#trPaper', root)?.addEventListener('click', (event) => {
    const node = event.target.closest('[data-seg]');
    if (!node) return;
    selectBlock(root, node.dataset.seg);
  });

  onPage(() => {
    renderPreview(root, true);
  });
  window.addEventListener('resize', () => paintScale(root), { passive: true });
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => paintScale(root));
    observer.observe(q('#trPreviewStage', root));
  }

  paintProvider(root);
  paintScale(root);
}

/** The sheet in the preview is a real page; scale it to whatever room we have. */
function paintScale(root) {
  const stage = q('#trPreviewStage', root);
  const zoom = q('#trZoom', root);
  const scaler = q('#trScaler', root);
  const sheet = q('.tr-sheet', root);
  if (!stage || !zoom || !scaler || !sheet) return;
  const available = stage.clientWidth || 520;
  const naturalWidth = sheet.offsetWidth || 1;
  const scale = Math.min(1, available / naturalWidth);
  zoom.style.transform = `scale(${scale})`;
  scaler.style.width = `${naturalWidth * scale}px`;
  scaler.style.height = `${(sheet.offsetHeight || 1) * scale}px`;
  state.previewScale = scale;
}

function selectBlock(root, id) {
  state.selected = state.selected === id ? null : id;
  paintBlockPanel(root);
  renderPreview(root);
  // the list row and the block agree on what is selected
  qa('.tr-row', root).forEach((row) => row.classList.toggle('is-selected', row.id === `seg-${state.selected}`));
  if (state.selected) q(`#seg-${state.selected}`, root)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function paintBlockPanel(root) {
  const panel = q('#trBlock', root);
  if (!panel) return;
  const segment = state.segments.find((item) => item.id === state.selected);
  panel.hidden = !segment;
  if (!segment) return;
  const override = form.blockOverrides[segment.id] ?? {};
  q('#trBlockName', root).textContent = `${segment.label} · ${segment.style ?? 'paragraph'}${Object.keys(override).length ? ' · restyled' : ''}`;
  const paint = (selector, value) => {
    qa(`${selector} [data-align], ${selector} [data-weight], ${selector} [data-style]`, root).forEach((node) => {
      const key = node.dataset.align !== undefined ? 'align' : node.dataset.weight !== undefined ? 'weight' : 'style';
      const on = String(value[key] ?? '') === node.dataset[key];
      node.classList.toggle('is-on', on);
      node.ariaPressed = String(on);
    });
  };
  paint('#trBlockAlign, #trBlockWeight, #trBlockStyle', override);
  const size = q('#trBlockSize', root);
  if (size && document.activeElement !== size) size.value = override.size ? String(override.size) : '';
}

function paintFidelity(root) {
  const overlay = form.fidelity === 'page';
  qa('#trFidelity [data-fidelity]', root).forEach((node) => {
    const on = node.dataset.fidelity === form.fidelity;
    node.classList.toggle('is-on', on);
    node.ariaPressed = String(on);
  });
  qa('.tr-overlay-only', root).forEach((node) => {
    node.classList.toggle('is-off', !overlay);
    node.querySelectorAll('input, select').forEach((input) => { input.disabled = !overlay; });
  });
  q('#trBilingualWrap', root)?.classList.toggle('is-off', overlay);
  q('#trBilingual', root).disabled = overlay;
  const note = q('#trFidelityHint', root);
  if (note) {
    note.textContent = overlay
      ? 'On the page: every block of source text is boxed out and the translation is drawn back in the same place, at the same size, shrinking to fit. Tables, pictures and columns stay put.'
      : 'Re-typeset: blocks are recognised as headings, quotes, lists and paragraphs and set fresh on the paper from the strip above, with the typography below.';
  }
  const side = q('#trFidelityNote', root);
  if (side) {
    side.textContent = overlay
      ? `Extraction keeps each block’s exact position and size, so the page can be rebuilt block for block. ${state.origin === 'pdf' ? '' : 'Text sources have no page to keep — switch to Re-typeset for those.'}`
      : 'Paragraphs are poured onto a fresh sheet — good for reading, not for pixel-faithful decks.';
  }
  const where = q('#trPreviewWhere', root);
  if (where) where.textContent = overlay ? 'original layout, translation in place' : 're-typeset on the paper above';
}

function paintTypography(root) {
  const type = form.typography;
  const family = FAMILIES.find(([id]) => id === type.family) ?? FAMILIES[0];
  q('#trSizeOut', root).textContent = `${type.size} pt`;
  q('#trLeadOut', root).textContent = String(type.lineHeight);
  q('#trGapOut', root).textContent = `${type.spacing} pt`;
  q('#trIndentOut', root).textContent = `${type.indent} pt`;
  qa('#trAlign [data-align]', root).forEach((node) => {
    const on = node.dataset.align === type.align;
    node.classList.toggle('is-on', on);
    node.ariaPressed = String(on);
  });
  const rtl = type.rtl === 'rtl';
  const rtlBox = q('#trRtl', root);
  if (rtlBox) rtlBox.checked = rtl;
  const scope = q('#trTypeScope', root);
  if (scope) scope.textContent = `${family[1]} · ${type.size} pt · ${rtl ? 'right-to-left' : type.align}`;
  const sheet = q('.tr-sheet', root);
  if (sheet) {
    sheet.style.fontFamily = family[2];
    sheet.style.setProperty('--tr-size', `${(type.size * (96 / 72)).toFixed(2)}px`);
    sheet.style.setProperty('--tr-lead', String(type.lineHeight));
    sheet.style.setProperty('--tr-gap', `${(type.spacing * (96 / 72)).toFixed(2)}px`);
    sheet.style.setProperty('--tr-indent', `${(type.indent * (96 / 72)).toFixed(2)}px`);
    sheet.style.setProperty('--tr-align', type.align);
    sheet.style.direction = rtl ? 'rtl' : 'ltr';
  }
  paintTypographyControls(root);
}

function paintTypographyControls(root) {
  const wrap = q('#trType', root);
  if (!wrap) return;
  const overlay = form.fidelity === 'page';
  wrap.classList.toggle('is-overlay', overlay);
  const scope = q('#trTypeScope', root);
  if (scope && overlay) scope.textContent = 'used where a block has no room and has to be drawn as a picture';
}

/* ------------------------------------------------------------- ingest ---- */
function pickOne(root) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) resolve(file);
      input.remove();
    });
    document.body.append(input);
    input.click();
  }).then((file) => ingestPdf(file, root));
}

async function ingestPdf(file, root) {
  if (!file) return;
  const label = q('#trPdfName', root);
  const originLabel = q('#trOriginState', root);
  label.textContent = `Reading ${file.name}…`;
  try {
    const pdfjs = await loadPdfJs();
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);
    state.pdfBytes = data.slice();
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, ...pdfjsAssetOptions() }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      if (label) label.textContent = `Reading page ${pageNumber} of ${doc.numPages}…`;
      const pdfPage = await doc.getPage(pageNumber);
      const content = await pdfPage.getTextContent();
      const extracted = extractBlocks(content.items, pdfPage.view, pageNumber);
      pages.push(extracted);
    }
    state.pdfDoc = doc;
    state.pages = pages;
    pageBitmapCache = new Map();
    state.pageCount = doc.numPages;
    state.origin = 'pdf';
    state.originLabel = file.name;
    state.fileName = file.name.replace(/\.pdf$/i, '');
    state.overlayPage = 0;
    state.segments = buildSegments(pages, 'pdf');
    if (label) label.textContent = `${file.name} · ${doc.numPages} pages`;
    if (originLabel) originLabel.textContent = `${state.segments.length} blocks`;
    afterIngest(root);
    toast(state.segments.length ? `Loaded ${doc.numPages} pages · ${state.segments.length} blocks — ready to translate.` : 'No text found in that PDF.', !state.segments.length);
  } catch (error) {
    console.error(error);
    if (label) label.textContent = 'Could not read that file';
    toast(error?.message || 'That PDF could not be read.', true);
  }
}

/**
 * Turn a page's text items into blocks: lines first (same baseline, no gap),
 * then lines into blocks (small vertical gap, similar size). Each block keeps
 * the geometry the overlay needs and the shape the re-typesetter needs.
 */
function extractBlocks(items, view, pageNumber) {
  const [x0, y0, x1, y1] = view;
  const box = { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
  const lines = [];
  for (const item of items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const size = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;
    const baseline = item.transform[5];
    const startX = item.transform[4];
    const width = item.width || 0;
    const last = lines[lines.length - 1];
    const sameLine = last && Math.abs(last.baseline - baseline) <= Math.max(1.1, size * 0.42);
    const near = last && startX - last.right <= Math.max(size * 0.9, 2.5);
    if (sameLine && near) {
      const space = startX - last.right;
      last.text += `${space > size * 0.22 && !/\s$/.test(last.text) ? ' ' : ''}${item.str}`;
      last.right = Math.max(last.right, startX + width);
      last.size = Math.max(last.size, size);
      last.baseline = Math.min(last.baseline, baseline);
    } else {
      lines.push({ text: item.str, x: startX, right: startX + width, baseline, size });
    }
  }
  lines.forEach((line) => {
    line.text = line.text.replace(/\s+/g, ' ').trim();
  });
  const kept = lines.filter((line) => line.text);
  kept.sort((a, b) => b.baseline - a.baseline);
  if (kept.length) {
    const sizes = kept.map((line) => line.size).sort((a, b) => a - b);
    const body = sizes[Math.floor(sizes.length / 2)];
    const blocks = [];
    for (const line of kept) {
      const previous = blocks[blocks.length - 1];
      const gap = previous ? previous.bottomBaseline - line.baseline : Infinity;
      const roomy = previous ? gap <= Math.max(3.4, Math.max(previous.size, line.size) * 1.05) : false;
      const sameKind = previous ? Math.abs(line.size - previous.size) <= Math.max(1.6, previous.size * 0.3) : false;
      const overlaps = previous ? Math.min(previous.right, line.right) - Math.max(previous.x, line.x) > 0 : false;
      if (previous && roomy && sameKind && overlaps) {
        previous.lines.push(line);
        previous.bottomBaseline = Math.min(previous.baseline, line.baseline);
        previous.baseline = line.baseline;
        previous.right = Math.max(previous.right, line.right);
        previous.x = Math.min(previous.x, line.x);
        previous.text = `${previous.text} ${line.text}`;
      } else {
        blocks.push({
          page: pageNumber,
          x: line.x,
          right: line.right,
          baseline: line.baseline,
          bottomBaseline: line.baseline,
          size: line.size,
          text: line.text,
          lines: [line],
        });
      }
    }
    blocks.forEach((block, index) => {
      const useSize = block.lines.map((line) => line.size).sort((a, b) => a - b)[Math.floor(block.lines.length / 2)];
      block.size = useSize;
      const lineHeight = useSize * 1.22;
      block.yTop = box.y1 - block.lines[0].baseline - useSize * 0.82;
      const bottomBaseline = block.lines[block.lines.length - 1].baseline;
      block.height = Math.max(lineHeight, block.lines[0].baseline - bottomBaseline + useSize * 1.2);
      block.yBottom = block.yTop + block.height;
      block.width = Math.max(6, block.right - block.x);
      block.lineBoxes = block.lines.map((line) => ({
        x: line.x,
        y: box.y1 - line.baseline - line.size * 0.82,
        width: Math.max(2, line.right - line.x),
        height: Math.max(2, line.size * 1.2),
      }));
      block.align = detectAlign(block, box);
      block.rtl = isRtlText(block.text);
      block.index = index;
      block.id = `p${pageNumber}-b${index}`;
      block.style = classifyBlock(block, body, box);
    });
    // the room below a block is only known once every block has a position
    blocks.forEach((block, index) => {
      const next = blocks[index + 1];
      block.gapBelow = next
        ? Math.max(0, next.yTop - block.yBottom)
        : Math.max(0, box.height - 24 - block.yBottom);
    });
    blockIds(blocks, pageNumber);
    return { number: pageNumber, box, blocks, bodySize: body };
  }
  return { number: pageNumber, box, blocks: [], bodySize: 12 };
}

function blockIds(blocks, pageNumber) {
  blocks.forEach((block, index) => { block.id = `p${pageNumber}-b${index}`; });
}

function detectAlign(block, box) {
  const lines = block.lines;
  if (lines.length < 2) return block.rtl ? 'right' : 'left';
  const lefts = lines.map((line) => line.x - block.x);
  const rights = lines.map((line) => block.right - line.right);
  const maxLeft = Math.max(...lefts);
  const maxRight = Math.max(...rights);
  if (maxLeft < 1.6 && maxRight > block.width * 0.12) return 'left';
  if (maxRight < 1.6 && maxLeft > block.width * 0.12) return 'right';
  if (maxLeft > block.width * 0.08 && maxRight > block.width * 0.08 && lines[0].x - block.x > block.width * 0.02) return 'center';
  return block.rtl ? 'right' : 'left';
}

function classifyBlock(block, body, box) {
  const text = block.text;
  if (/^([•·▪‣◦*\-–—]|\(?\d{1,2}[.)]|[ivx]{1,4}[.)])\s+/i.test(text)) return 'list';
  if (/^[“"']/.test(text) && block.size <= body * 1.08 && block.x > box.x0 + (box.width * 0.06)) return 'quote';
  if (block.size > body * 1.22) return 'heading';
  if (block.size < body * 0.86) return 'small';
  return 'para';
}

function buildSegments(pages, origin) {
  const segments = [];
  for (const pageInfo of pages) {
    for (const block of pageInfo.blocks) {
      segments.push({
        id: block.id,
        page: pageInfo.number,
        label: `page ${pageInfo.number} · block ${block.index + 1}`,
        source: block.text,
        translated: '',
        status: 'idle',
        error: '',
        style: block.style,
        bodySize: pages.find((entry) => entry.number === pageInfo.number)?.bodySize ?? null,
        rect: { x: block.x, yTop: block.yTop, width: block.width, height: block.height, right: block.right, gapBelow: block.gapBelow, align: block.align, rtl: block.rtl, size: block.size, lineBoxes: block.lineBoxes },
        origin,
      });
    }
  }
  return segments;
}

function ingestMarkdown(markdown, root) {
  const text = String(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_`>#|]/g, ' ');
  ingestText(text, 'from-markdown', root);
  q('[name="trSourceKind"][value="markdown"]', root).checked = true;
}

function ingestText(text, name, root) {
  const paragraphs = String(text)
    .split(/\n\s*\n/)
    .map((value) => value.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  state.segments = paragraphs.map((value, index) => ({
    id: `t${index}`,
    page: 1,
    label: `paragraph ${index + 1}`,
    source: value,
    translated: '',
    status: 'idle',
    error: '',
    style: /^[“"']/.test(value) ? 'quote' : 'para',
    rect: null,
    origin: 'text',
  }));
  state.pages = [];
  state.pdfBytes = null;
  state.origin = 'text';
  state.originLabel = name;
  state.fileName = name;
  state.pageCount = 1;
  if (/[\u0980-\u09ff]/.test(text)) form.typography.family = form.typography.family === 'dm-sans' ? 'noto-bn' : form.typography.family;
  afterIngest(root);
  if (!state.segments.length) toast('Nothing to translate in that — it looked empty.', true);
}

function afterIngest(root) {
  state.selected = null;
  if (state.origin !== 'pdf' && form.fidelity === 'page') form.fidelity = 'retype';
  q('#trOriginState', root).textContent = `${state.segments.length} ${state.origin === 'pdf' ? 'blocks' : 'paragraphs'}`;
  renderList(root);
  resetProgress(state.segments.length);
  paintFidelity(root);
  paintBlockPanel(root);
  renderPreview(root, true);
}

/* --------------------------------------------------------- translation ---- */
function parseGlossary() {
  state.glossary = String(form.glossary || '')
    .split('\n')
    .map((line) => /^\s*(.+?)\s*=\s*(.+?)\s*$/.exec(line))
    .filter(Boolean)
    .map(([, from, to]) => [new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), to]);
}

function applyGlossary(text) {
  let out = text;
  for (const [pattern, replacement] of state.glossary) out = out.replace(pattern, replacement);
  return out;
}

function resetProgress(total) {
  q('#trProgressBar').style.width = '0%';
  q('#trProgressText').textContent = total ? `${total} blocks ready` : 'Nothing to translate yet';
}

function setProgress(done, total, label) {
  const bar = q('#trProgressBar');
  const text = q('#trProgressText');
  if (bar) bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  if (text) text.textContent = label;
}

async function run(root) {
  const pending = state.segments.filter((segment) => segment.source && segment.status !== 'done');
  if (!pending.length) {
    toast(state.segments.length ? 'Everything is already translated.' : 'Add some text to translate first.', !state.segments.length);
    return;
  }
  if (form.provider === 'libre' && !/^https?:\/\//i.test(form.libreUrl || '')) {
    toast('LibreTranslate needs your server URL — open Provider settings below.', true);
    q('#trExtras', root).hidden = false;
    q('#trLibreUrl', root).focus();
    return;
  }
  if (PROVIDERS[form.provider]?.manual) {
    pending.forEach((segment) => {
      segment.status = 'ready';
      segment.error = '';
    });
    renderList(root);
    renderPreview(root);
    setProgress(0, state.segments.length, `${pending.length} ${pending.length === 1 ? 'block' : 'blocks'} ready — type a translation and the PDF follows`);
    toast('No request was sent — these lines are yours to fill in.');
    return;
  }
  state.running = true;
  state.controller = new AbortController();
  q('#trStop', root).hidden = false;
  q('#trRun span', root).textContent = 'Translating…';
  q('#trRun').classList.add('is-busy');

  const maxChars = PROVIDERS[form.provider].maxChars;
  const batches = form.batch && PROVIDERS[form.provider].batch !== false ? chunkBatches(pending, maxChars) : pending.map((segment) => [segment]);

  try {
    for (const [batchIndex, batch] of batches.entries()) {
      if (!state.running) break;
      setProgress(batchIndex / batches.length, 1, `Translating ${Math.min((batchIndex + 1) * batch.length, pending.length)} of ${pending.length}…`);
      batch.forEach((segment) => {
        segment.status = 'busy';
        paintSegment(segment, root);
      });
      try {
        const results = await translateBatch(batch.map((segment) => segment.source), { signal: state.controller.signal });
        batch.forEach((segment, index) => {
          segment.translated = applyGlossary(results[index] ?? '');
          segment.status = segment.translated ? 'done' : 'error';
          if (!segment.translated) segment.error = 'The provider returned nothing.';
        });
      } catch (error) {
        if (!state.running) break;
        batch.forEach((segment) => {
          segment.status = 'error';
          segment.error = humanError(error);
        });
      }
      batch.forEach((segment) => paintSegment(segment, root));
      renderPreview(root);
      if (form.delay > 0 && state.running) await new Promise((resolve) => window.setTimeout(resolve, form.delay));
    }
  } finally {
    const done = state.segments.filter((segment) => segment.status === 'done').length;
    const failed = state.segments.filter((segment) => segment.status === 'error').length;
    state.running = false;
    state.controller = null;
    q('#trStop', root).hidden = true;
    q('#trRun span', root).textContent = failed ? 'Retry failed' : 'Translate';
    setProgress(done, state.segments.length, `${done} translated${failed ? ` · ${failed} failed` : ''}`);
    renderList(root);
    renderPreview(root, true);
  }
}

function stop(root) {
  state.running = false;
  state.controller?.abort();
  q('#trStop', root).hidden = true;
  q('#trRun span', root).textContent = 'Translate';
  setProgress(state.segments.filter((segment) => segment.status === 'done').length, state.segments.length, 'Stopped — press Translate to carry on');
}

function chunkBatches(pending, maxChars) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const segment of pending) {
    const length = segment.source.length + 1;
    if (current.length && size + length > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += length;
    if (segment.source.length > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function humanError(error) {
  const message = String(error?.message || error || '');
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'The translation provider could not be reached. Check your connection, or switch to a self-hosted provider.';
  }
  if (/429|quota|too many/i.test(message)) return 'That provider hit its rate limit — slow the pace or try again in a minute.';
  if (/403|forbidden|unauthor/i.test(message)) return 'That provider refused the request — a key or a different provider may be needed.';
  return message;
}

async function translateBatch(texts, { signal }) {
  const trimmed = texts.map((text) => String(text).replace(/\s+/g, ' ').trim());
  if (form.provider === 'libre') {
    const base = String(form.libreUrl || '').replace(/\/+$/, '');
    const response = await fetch(`${base}/translate`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: trimmed, source: form.source === 'auto' ? 'auto' : form.source, target: form.target, format: 'text', api_key: form.libreKey || undefined }),
    });
    if (!response.ok) throw new Error(`Provider replied ${response.status}`);
    const data = await response.json();
    const list = Array.isArray(data?.translations) ? data.translations.map((item) => item.text) : [];
    if (!list.length) throw new Error('The response did not contain any text.');
    return list;
  }
  if (form.provider === 'mymemory') {
    return Promise.all(
      trimmed.map(async (text) => {
        const url = new URL('https://api.mymemory.translated.net/get');
        url.searchParams.set('q', text);
        url.searchParams.set('langpair', `${form.source === 'auto' ? 'Autodetect' : form.source}|${form.target}`);
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Provider replied ${response.status}`);
        const data = await response.json();
        if (data?.responseStatus && Number(data.responseStatus) !== 200) throw new Error(data.responseStatusText || 'MyMemory refused that text.');
        return String(data?.responseData?.translatedText ?? '');
      }),
    );
  }
  // Google's free web endpoint: one request per block, returns nested arrays.
  const out = [];
  for (const text of trimmed) {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', form.source === 'auto' ? 'auto' : form.source);
    url.searchParams.set('tl', form.target);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Provider replied ${response.status}`);
    const data = await response.json();
    out.push(Array.isArray(data?.[0]) ? data[0].map((chunk) => chunk?.[0] ?? '').join('') : '');
  }
  return out;
}

/* ------------------------------------------------------------ rendering ---- */
function rowBody(segment) {
  const body = el('div', { class: 'tr-row-body' });
  body.append(el('div', { class: 'tr-row-source', text: segment.source || segment.note || '' }));
  if (segment.status === 'error' && segment.error) {
    body.append(el('div', { class: 'tr-row-error', text: segment.error }));
  }
  const target = el('div', { class: 'tr-row-target' });
  if (segment.status === 'busy') {
    target.append(el('span', { class: 'tr-shimmer', text: segment.translated || 'translating…' }));
  } else {
    const textarea = el('textarea', {
      rows: '2',
      placeholder: segment.status === 'error' || segment.status === 'ready'
        ? 'Type or paste the translation for this block'
        : 'Waiting…',
      'aria-label': `Translation for ${segment.label}`,
      text: segment.translated,
    });
    target.append(textarea);
  }
  body.append(target);
  return body;
}

function buildRow(root, segment) {
  const row = el('div', { class: `tr-row is-${segment.status}${state.selected === segment.id ? ' is-selected' : ''}`, id: `seg-${segment.id}`, role: 'listitem' }, [
    el('span', { class: 'tr-row-status', 'aria-hidden': 'true' }),
    el('button', { class: 'tr-row-pick', type: 'button', title: 'Restyle this block', 'aria-label': `Restyle ${segment.label}`, html: eyeIcon }),
    rowBody(segment),
    el('button', { class: 'button button-text tr-row-retry', type: 'button', text: 'Retry', hidden: segment.status !== 'error' }),
  ]);
  wireRow(root, row, segment);
  return row;
}

function wireRow(root, row, segment) {
  const textarea = row.querySelector('textarea');
  if (textarea) {
    const grow = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(220, Math.max(38, textarea.scrollHeight))}px`;
    };
    grow();
    textarea.addEventListener('input', () => {
      segment.translated = textarea.value;
      if (textarea.value.trim()) {
        segment.status = 'done';
        segment.error = '';
      }
      row.className = `tr-row is-${segment.status}`;
      grow();
      renderPreview(root);
    });
  }
  row.querySelector('.tr-row-pick')?.addEventListener('click', () => {
    state.selected = segment.id;
    paintBlockPanel(root);
    renderPreview(root);
    if (q('#trBlock', root)?.hidden === false) q('#trBlock', root).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  row.querySelector('.tr-row-retry')?.addEventListener('click', () => {
    segment.status = 'idle';
    runOne(root, segment, row);
  });
}

function renderList(root) {
  const list = q('#trList', root);
  if (!list) return;
  paintSideNote(root);
  list.innerHTML = '';
  if (!state.segments.length) {
    list.append(el('div', { class: 'tr-empty' }, [
      el('p', { text: 'Your blocks will line up here.' }),
      el('small', { text: 'Pick a source on the left, then press Translate. Each block is replaced as it arrives.' }),
    ]));
    return;
  }
  let lastPage = null;
  state.segments.forEach((segment) => {
    if (form.keepPages && state.origin === 'pdf' && segment.page !== lastPage) {
      lastPage = segment.page;
      list.append(el('p', { class: 'tr-page-marker', text: `Page ${segment.page}` }));
    }
    list.append(buildRow(root, segment));
  });
  paintListMode(root);
  paintSideNote(root);
}

function paintSideNote(root) {
  root.classList.toggle('has-input', state.segments.length > 0);
  const note = q('#trSideNote', root);
  if (!note) return;
  if (!state.segments.length) {
    note.textContent = 'PDF, Markdown studio, or paste';
    return;
  }
  const where = state.origin === 'pdf' ? `from ${state.originLabel}` : state.origin === 'markdown' ? 'from the Markdown studio' : 'from your text';
  const typed = state.segments.filter((segment) => segment.translated).length;
  note.textContent = `${state.segments.length} ${state.segments.length === 1 ? 'block' : 'blocks'} ${where}${typed ? ` · ${typed} translated` : ''}`;
}

async function runOne(root, segment, row) {
  row.className = 'tr-row is-busy';
  try {
    const [value] = await translateBatch([segment.source], { signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30000) : undefined });
    segment.translated = applyGlossary(value ?? '');
    segment.status = segment.translated ? 'done' : 'error';
    segment.error = segment.translated ? '' : 'Nothing came back.';
  } catch (error) {
    segment.status = 'error';
    segment.error = humanError(error);
  }
  const fresh = buildRow(root, segment);
  row.replaceWith(fresh);
  renderPreview(root);
}

function paintSegment(segment, root) {
  const row = document.getElementById(`seg-${segment.id}`);
  if (!row) return;
  row.replaceWith(buildRow(root ?? q('.tr-shell')?.closest('.tool-panel'), segment));
}

function paintListMode(root) {
  qa('.tr-row-source', root).forEach((node) => {
    node.style.display = form.showSource ? '' : 'none';
  });
}

function paintProvider(root) {
  const provider = PROVIDERS[form.provider] ?? PROVIDERS.gtx;
  const note = q('#trProviderNote', root);
  if (provider.manual) {
    note.innerHTML = `<span>${provider.label}</span> · ${provider.note} · nothing leaves this tab at all — the preview and the PDF update as you type.`;
  } else {
    note.innerHTML = `<span>${provider.label}</span> · ${provider.note} · max ${provider.maxChars} characters per request. Requests leave this browser tab directly — nothing is stored by Folio.`;
  }
  q('#trExtras', root).hidden = form.provider !== 'libre';
  const label = q('#trRun span', root);
  if (label && !state.running) label.textContent = provider.manual ? 'Prepare blocks' : 'Translate';
}

/* -------------------------------------------------------------- type ---- */
function familyFor(target = form.target) {
  const chosen = FAMILIES.find(([id]) => id === form.typography.family) ?? FAMILIES[0];
  if (form.typography.family === 'auto') {
    if (/^(bn|hi|mr|ne|ta|te|si)$/.test(target)) return FAMILIES.find(([id]) => id === 'noto-bn');
    if (/^(ar|ur|fa|he|ps|sd)$/.test(target)) return FAMILIES.find(([id]) => id === 'noto-ar');
    if (/^(zh|ja|ko)/.test(target)) return FAMILIES.find(([id]) => id === 'noto-cjk');
  }
  return chosen;
}

function overrideFor(segment) {
  return form.blockOverrides?.[segment.id] ?? {};
}

function blockStyle(segment) {
  const override = overrideFor(segment);
  const type = form.typography;
  const heading = (override.style ?? segment.style) === 'heading';
  const list = (override.style ?? segment.style) === 'list';
  const quote = (override.style ?? segment.style) === 'quote';
  let size = override.size ?? type.size;
  void heading; void quote; void list;
  if (!override.size && segment.origin === 'pdf' && segment.rect?.size && segment.bodySize) {
    // follow the source's own hierarchy: a heading stays a heading, a footnote stays small
    size = type.size * Math.min(1.9, Math.max(0.78, segment.rect.size / segment.bodySize));
  } else if (!override.size && heading) {
    size = type.size * 1.5;
  }
  return {
    align: override.align ?? (type.align === 'justify' ? 'justify' : type.align),
    size,
    weight: override.weight ?? (heading ? 600 : 400),
    kind: override.style ?? segment.style ?? 'para',
    indent: type.indent,
    rtl: type.rtl === 'rtl',
  };
}

/* ------------------------------------------------------------ preview ---- */
let previewTimer;
let previewGeneration = 0;
function renderPreview(root, immediate = false) {
  window.clearTimeout(previewTimer);
  const generation = ++previewGeneration;
  const draw = async () => {
    if (form.fidelity === 'page' && state.pages.length) await paintOverlayPreview(root, generation);
    else paintRetypePreview(root);
    if (generation === previewGeneration) paintScale(root);
  };
  if (immediate) draw();
  else previewTimer = window.setTimeout(draw, 160);
}

function paintRetypePreview(root) {
  const frame = q('#trPaper', root);
  const canvas = q('#trOverlay', root);
  const sheet = q('.tr-sheet', root);
  if (!frame || !sheet) return;
  if (canvas) canvas.hidden = true;
  frame.hidden = false;
  sheet.classList.remove('is-overlay');
  const translated = state.segments.filter((segment) => segment.translated).length;
  const typed = state.origin === 'pdf' ? form.target : 'text';
  sheet.dataset.theme = form.theme;
  sheet.dataset.pageSize = page().sheet;
  sheet.dataset.orientation = page().orientation;
  frame.innerHTML = translated ? translatedHtml() : `<div class="empty-preview"><strong>Nothing on the page yet</strong><span>Load a PDF and press Translate — the sheet fills in as blocks arrive.</span></div>`;
  const note = q('#trPreviewNote', root);
  if (note) note.textContent = `${translated}/${state.segments.length} blocks`;
  q('#trPageNav', root).hidden = true;
  void typed;
}

function segmentText(segment) {
  return (segment.translated || '').trim();
}

/** The retypeset document: headings, quotes, lists and paragraphs, with overrides. */
function translatedHtml() {
  const blocks = state.segments.filter((segment) => segment.source);
  const pages = form.keepPages && state.origin === 'pdf'
    ? [...blocks.reduce((map, segment) => {
      if (!map.has(segment.page)) map.set(segment.page, []);
      map.get(segment.page).push(segment);
      return map;
    }, new Map())]
    : [[null, blocks]];
  const render = (segment) => {
    const target = segmentText(segment);
    const source = segment.source.trim();
    const style = blockStyle(segment);
    const value = target || source;
    const rtl = style.rtl || isRtlText(value);
    const options = [];
    if (style.align !== form.typography.align) options.push(`text-align:${style.align}`);
    if (style.size !== form.typography.size) options.push(`font-size:${(style.size * (96 / 72)).toFixed(2)}px`);
    if (style.weight !== 400) options.push(`font-weight:${style.weight}`);
    if (rtl !== (form.typography.rtl === 'rtl')) options.push(`direction:${rtl ? 'rtl' : 'ltr'}`);
    const inline = options.length ? ` style="${options.join(';')}"` : '';
    const cls = `tr-block tr-block-${style.kind}${state.selected === segment.id ? ' is-selected' : ''}${target ? '' : ' is-untranslated'}`;
    const attrs = ` class="${cls}" data-seg="${segment.id}" tabindex="0" role="button" aria-label="Block: ${escapeHtml(segment.label)}"`;
    if (form.bilingual && target) {
      return `<div${attrs}${inline}><p class="tr-pair"><span class="tr-pair-target">${escapeHtml(value)}</span><span class="tr-pair-source">${escapeHtml(source)}</span></p></div>`;
    }
    if (style.kind === 'list') return `<p${attrs}${inline}><span class="tr-bullet" aria-hidden="true">•</span> ${escapeHtml(value)}</p>`;
    if (style.kind === 'heading') return `<h2${attrs}${inline}>${escapeHtml(value)}</h2>`;
    if (style.kind === 'quote') return `<blockquote${attrs}${inline}>${escapeHtml(value)}</blockquote>`;
    return `<p${attrs}${inline}>${escapeHtml(value)}</p>`;
  };
  if (!blocks.some((segment) => segment.translated)) return '';
  return pages
    .map(([pageNumber, group]) => {
      const head = form.keepPages && pageNumber ? `<p class="tr-doc-page">Page ${pageNumber}</p>` : '';
      return head + group.map(render).join('');
    })
    .join('');
}

/* ----------------------------------------------------- overlay preview ---- */
async function paintOverlayPreview(root, generation = previewGeneration) {
  const canvas = q('#trOverlay', root);
  const frame = q('#trPaper', root);
  const sheet = q('.tr-sheet', root);
  if (!canvas || !sheet) return;
  const pageInfo = state.pages[state.overlayPage] ?? state.pages[0];
  if (!pageInfo) return;
  frame.hidden = true;
  canvas.hidden = false;
  sheet.classList.add('is-overlay');
  const box = pageInfo.box;
  const display = Math.max(320, Math.min(760, (q('#trPreviewStage', root)?.clientWidth || 560) - 24));
  const scale = display / box.width;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.max(2, Math.round(box.width * scale * dpr));
  const pixelHeight = Math.max(2, Math.round(box.height * scale * dpr));

  /* Painted off-screen and blitted in one go: two overlapping repaints (a
     keystroke and a resize, say) would otherwise interleave and leave the
     original text showing through the boxes. */
  const buffer = document.createElement('canvas');
  buffer.width = pixelWidth;
  buffer.height = pixelHeight;
  const ctx = buffer.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = form.cover;
  ctx.fillRect(0, 0, box.width * scale, box.height * scale);
  try {
    const bitmap = await renderPageBitmap(pageInfo.number, box, scale * dpr);
    if (generation !== previewGeneration) return;
    if (bitmap) ctx.drawImage(bitmap, 0, 0, box.width * scale, box.height * scale);
  } catch (error) {
    console.error(error);
  }
  ctx.save();
  ctx.scale(scale, scale);
  for (const segment of state.segments.filter((item) => item.page === pageInfo.number)) {
    const target = segmentText(segment);
    if (!target) continue;
    const plan = overlayPlan(segment, target);
    if (form.original === 'cover') {
      ctx.fillStyle = form.cover;
      for (const line of segment.rect.lineBoxes) {
        ctx.fillRect(line.x - 0.8, line.y - plan.layout.fontSize * 0.16, line.width + 1.6, line.height + plan.layout.fontSize * 0.24);
      }
    }
    paintParagraph(ctx, plan.layout, { x: plan.x, y: plan.y, color: form.ink });
    if (state.selected === segment.id) {
      ctx.save();
      ctx.strokeStyle = '#527453';
      ctx.lineWidth = 1 / scale;
      ctx.setLineDash([4 / scale, 3 / scale]);
      ctx.strokeRect(segment.rect.x - 1, segment.rect.yTop - 2, segment.rect.width + 2, plan.layout.height + 6);
      ctx.restore();
    }
  }
  ctx.restore();

  if (generation !== previewGeneration) return;
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  canvas.style.width = `${(box.width * scale).toFixed(1)}px`;
  canvas.style.height = `${(box.height * scale).toFixed(1)}px`;
  canvas.getContext('2d').drawImage(buffer, 0, 0);
  const translated = state.segments.filter((segment) => segment.translated).length;
  const note = q('#trPreviewNote', root);
  if (note) note.textContent = `${translated}/${state.segments.length} blocks`;
  const nav = q('#trPageNav', root);
  if (nav) nav.hidden = state.pages.length < 2;
  const label = q('#trPageLabel', root);
  if (label) label.textContent = `page ${state.overlayPage + 1} / ${state.pages.length}`;
}

let pageBitmapCache = new Map();
async function renderPageBitmap(pageNumber, box, scale) {
  const key = `${state.fileName}:${pageNumber}:${scale.toFixed(3)}`;
  if (pageBitmapCache.has(key)) return pageBitmapCache.get(key);
  if (!state.pdfDoc) return null;
  const doc = state.pdfDoc;
  const pdfPage = await doc.getPage(pageNumber);
  const viewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(box.width * scale);
  canvas.height = Math.round(box.height * scale);
  const task = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: pdfPage.getViewport({ scale: (box.width * scale) / viewport.width, rotation: 0 }) });
  await task.promise;
  if (pageBitmapCache.size > 8) pageBitmapCache = new Map();
  pageBitmapCache.set(key, canvas);
  return canvas;
}

/**
 * Where the translation goes for one block: the same column, the same top, the
 * same size where it fits, shrunk when it doesn't, allowed to spill into the
 * gap below (but never into the next block).
 */
function overlayPlan(segment, text) {
  const rect = segment.rect;
  const type = form.typography;
  const override = overrideFor(segment);
  const rtl = override.rtl ?? (type.rtl === 'rtl' || rect.rtl || isRtlText(text));
  const align = override.align ?? rect.align ?? (rtl ? 'right' : 'left');
  const family = familyFor();
  const measure = measureContext(family[2], override.weight ?? family[3] ?? 400);
  const slack = Math.min(rect.gapBelow, rect.size * 1.6);
  const layout = layoutParagraph({
    measure,
    text,
    maxWidth: rect.width,
    maxHeight: rect.height + slack,
    fontSize: override.size ?? rect.size * (type.size / 12),
    lineHeight: Math.max(1.05, type.lineHeight),
    align,
    rtl,
    minScale: 0.55,
  });
  return {
    layout: { ...layout, family: family[2], weight: override.weight ?? family[3] ?? 400 },
    x: rect.x,
    y: rect.yTop,
    latin: isLatinText(text),
  };
}

/* ------------------------------------------------------------- export ---- */
async function exportPdf(root) {
  const done = state.segments.filter((segment) => segment.translated).length;
  if (!done) {
    toast('Translate something first, then the PDF is ready to go.', true);
    return;
  }
  const button = q('#trPdf', root);
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = '<span class="export-spinner" aria-hidden="true"></span><span>Preparing…</span>';
  try {
    if (form.fidelity === 'page' && state.pdfBytes && state.pages.length) await exportOverlayPdf();
    else {
      await exportHtmlAsPdf({
        html: translatedHtml(),
        filename: safeFileName(`${state.fileName || 'document'}-${form.target}-typeset`, 'pdf'),
        style: form.theme,
        setup: page(),
      });
    }
  } catch (error) {
    console.error(error);
    toast(error?.message || 'The PDF could not be built.', true);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

/**
 * The page-faithful export: copy each page, box out the source blocks, draw the
 * translation back in place. Latin text stays as selectable text; anything the
 * standard fonts can't encode is drawn as a picture of the same paragraph.
 */
async function exportOverlayPdf() {
  const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
  const source = await PDFDocument.load(state.pdfBytes.slice(), { updateMetadata: false, ignoreEncryption: true });
  const out = await PDFDocument.create();
  const helvetica = await out.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await out.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(...hexToRgb(form.ink));
  const cover = rgb(...hexToRgb(form.cover));
  const setup = page();
  const sheet = sheetMm(setup);
  const margins = marginsMm(setup);
  const keepOriginal = form.original === 'keep';
  const pictureCache = new Map();

  for (const pageInfo of state.pages) {
    const [originalPage] = await out.copyPages(source, [pageInfo.number - 1]);
    out.addPage(originalPage);
    let target = originalPage;
    if (keepOriginal) {
      const [copy] = await out.copyPages(source, [pageInfo.number - 1]);
      target = copy;
      out.addPage(copy);
    }
    const media = originalPage.getMediaBox();
    const box = { x: media.x, y: media.y, width: media.width, height: media.height };
    const toPdf = (x, yTop, width, height) => ({
      x: box.x + x,
      y: box.y + box.height - (yTop + height),
      width,
      height,
    });

    for (const segment of state.segments.filter((item) => item.page === pageInfo.number)) {
      const text = segmentText(segment);
      if (!text) continue;
      const plan = overlayPlan(segment, text);
      const lineHeight = plan.layout.fontSize * plan.layout.lineHeight;
      if (!keepOriginal) {
        for (const line of segment.rect.lineBoxes) {
          const rect = toPdf(line.x - 0.8, line.y - plan.layout.fontSize * 0.16, line.width + 1.6, line.height + plan.layout.fontSize * 0.24);
          target.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: cover, opacity: 1 });
        }
      }
      if (plan.latin) {
        const font = (plan.layout.weight ?? 400) >= 600 ? helveticaBold : helvetica;
        plan.layout.lines.forEach((line, index) => {
          const top = plan.y + index * lineHeight;
          const baselineTop = top + plan.layout.fontSize * 0.8;
          const x = plan.x + line.x;
          try {
            target.drawText(line.text, { x, y: box.y + box.height - baselineTop, size: plan.layout.fontSize, font, color: ink });
          } catch (error) {
            // a stray character the font can't encode — draw that line as a picture
            console.warn('Falling back to an image for one line:', error?.message);
            const picture = paragraphCanvas({
              text: line.text,
              width: Math.max(8, line.width + 2),
              height: plan.layout.fontSize * 1.4,
              fontSize: plan.layout.fontSize,
              lineHeight: 1.2,
              align: 'left',
              rtl: false,
              family: plan.layout.family,
              weight: plan.layout.weight,
              color: form.ink,
              pixelRatio: 4,
            });
            pictureCache.set(`${segment.id}-${index}`, picture);
          }
        });
      } else {
        const picture = paragraphCanvas({
          text,
          width: plan.layout.width,
          height: Math.max(plan.layout.height + 2, plan.layout.fontSize * 1.3),
          fontSize: plan.layout.fontSize,
          lineHeight: plan.layout.lineHeight,
          align: plan.layout.align,
          rtl: plan.layout.rtl,
          family: plan.layout.family,
          weight: plan.layout.weight,
          color: form.ink,
          pixelRatio: 4,
        });
        pictureCache.set(segment.id, picture);
      }
    }

    // pictures go down after the covers so a shrink never clips them
    for (const [key, picture] of pictureCache) {
      const segment = state.segments.find((item) => key === item.id || key.startsWith(`${item.id}-`));
      if (!segment || segment.page !== pageInfo.number) continue;
      const plan = overlayPlan(segment, segmentText(segment));
      const lineIndex = key.includes('-') && key !== segment.id ? Number(key.split('-').pop()) : null;
      const width = picture.width;
      const height = picture.height;
      const px = lineIndex === null ? plan.x : plan.x + (plan.layout.lines[lineIndex]?.x ?? 0);
      const py = plannerTop(plan, lineIndex);
      const embedded = await out.embedPng(picture.bytes());
      const rect = toPdf(px, py, width, height);
      target.drawImage(embedded, { x: rect.x, y: rect.y, width, height });
    }
    pictureCache.clear();

    /* "Fit onto the paper": the source page is scaled into the strip's page,
       margin box and all, and every page ends up that size and upright. */
    if (form.fitPaper) {
      const sheetW = sheet.width * PT_PER_MM;
      const sheetH = sheet.height * PT_PER_MM;
      const boxW = (sheetW - (margins.left + margins.right) * PT_PER_MM);
      const boxH = (sheetH - (margins.top + margins.bottom) * PT_PER_MM);
      const scale = Math.min(boxW / box.width, boxH / box.height);
      const tx = margins.left * PT_PER_MM + Math.max(0, (boxW - box.width * scale) / 2);
      const ty = margins.bottom * PT_PER_MM + Math.max(0, (boxH - box.height * scale) / 2);
      for (const sheetPage of [originalPage, keepOriginal ? out.getPage(out.getPageCount() - 1) : null].filter(Boolean)) {
        sheetPage.setMediaBox(0, 0, sheetW, sheetH);
        sheetPage.setRotation(degrees(0));
        sheetPage.scaleContent(scale, scale);
        sheetPage.translateContent(tx, ty);
      }
    }
  }

  const bytes = await out.save();
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), safeFileName(`${state.fileName || 'document'}-${form.target}${form.original === 'keep' ? '-side-by-side' : ''}`, 'pdf'));
  toast('Saved — your file is in the downloads folder.');
}

function plannerTop(plan, lineIndex) {
  if (lineIndex === null) return plan.y;
  const lineHeight = plan.layout.fontSize * plan.layout.lineHeight;
  return plan.y + lineIndex * lineHeight;
}

/** '#rrggbb' as three 0–1 components, for pdf-lib's rgb(). */
function hexToRgb(hex) {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim());
  if (!match) return [0.11, 0.13, 0.11];
  return [parseInt(match[1], 16) / 255, parseInt(match[2], 16) / 255, parseInt(match[3], 16) / 255];
}

/* ------------------------------------------------------------- text out ---- */
function asPlainText() {
  return state.segments.map((segment) => (segment.translated || segment.source).trim()).join('\n\n');
}

function asMarkdownText() {
  const lines = [`# ${state.fileName || 'translated'} — ${LANGUAGES.find(([code]) => code === form.target)?.[1] ?? form.target}`, ''];
  let page = null;
  for (const segment of state.segments) {
    if (!segment.source) continue;
    if (form.keepPages && state.origin === 'pdf' && segment.page !== page) {
      page = segment.page;
      lines.push(`## Page ${page}`, '');
    }
    const kind = segment.style ?? 'para';
    const text = (segment.translated || segment.source).trim();
    lines.push(kind === 'heading' ? `### ${text}` : kind === 'list' ? `- ${text}` : kind === 'quote' ? `> ${text}` : text, '');
    if (form.showSource) lines.push(`> ${segment.source.trim().replace(/\n/g, ' ')}`, '');
  }
  return lines.join('\n');
}

function downloadText(type, root, markdown = false) {
  void root;
  if (!state.segments.length) {
    toast('Nothing to save yet.', true);
    return;
  }
  const body = markdown ? asMarkdownText() : asPlainText();
  downloadBlob(new Blob([body], { type }), safeFileName(`${state.fileName || 'translated'}-${form.target}`, markdown ? 'md' : 'txt'));
}

/* Live Translate — pull text out of a PDF (or the Markdown studio), translate
   it segment by segment, watch it arrive, then re-export as a styled PDF.
   Translation calls go straight from this browser to the provider you pick. */
import { debounce, downloadBlob, el, escapeHtml, loadPdfJs, pdfjsAssetOptions, q, qa, safeFileName, store, toast } from '../lib.js';
import { exportHtmlAsPdf } from '../render.js';

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


const PROVIDERS = {
  gtx: { label: 'Google (free endpoint)', note: 'Best quality, one request per segment', maxChars: 4500, batch: false },
  mymemory: { label: 'MyMemory', note: 'Generous for short documents, no key needed', maxChars: 460, batch: false },
  libre: { label: 'LibreTranslate (own server)', note: 'Fully self-hosted — add your URL below', maxChars: 4000, batch: true },
  manual: { label: 'No translation service', note: 'Extract the lines and type them yourself', maxChars: 0, batch: false, manual: true },
};

const defaults = {
  provider: 'gtx',
  target: 'bn',
  source: 'auto',
  libreUrl: '',
  libreKey: '',
  batch: false,
  delay: 220,
  bilingual: true,
  keepPages: true,
  showSource: true,
  glossary: '',
  theme: 'editorial',
  pageSize: 'a4',
};

const prefs = store('translate:v1', defaults);
const form = { ...prefs.read() };

const state = {
  segments: [],
  running: false,
  controller: null,
  origin: 'nothing',
  fileName: 'translated',
  pageCount: 0,
  glossary: [],
};

const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';

export function start(root) {
  root.innerHTML = layout();
  hydrate(root);
  wire(root);
  renderList(root);
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
  </section>

  <section class="panel tr-main" aria-labelledby="tr-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="tr-main-title">Translate live</h3><p><span class="live-dot"></span> Each line lands as it arrives</p></div>
      </div>
      <div class="panel-header-actions tr-header-actions">
        <button class="button button-light" type="button" id="trStop" hidden>Stop</button>
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

    <div class="tr-progress" role="status" aria-live="polite">
      <div class="tr-progress-bar"><span id="trProgressBar"></span></div>
      <span class="tr-progress-text" id="trProgressText">Nothing to translate yet</span>
    </div>

    <div class="tr-list" id="trList" role="list"></div>

    <div class="tr-foot">
      <div class="tr-foot-left">
        <label class="field field-switch"><input type="checkbox" class="switch-input" id="trShowSource" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Show the original</span></label>
        <label class="field field-switch"><input type="checkbox" class="switch-input" id="trBilingual" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Two-column PDF</span></label>
        <label class="field field-switch"><input type="checkbox" class="switch-input" id="trBatch" /><span class="switch-track" aria-hidden="true"></span><span class="field-label">Batch requests (faster)</span></label>
        <label class="field field-select-sm"><span class="field-label">Style</span>
          <select class="text-input" id="trTheme">
            <option value="editorial">Editorial</option><option value="modern">Modern</option><option value="warm">Warm paper</option>
          </select>
        </label>
        <label class="field field-select-sm"><span class="field-label">Paper</span>
          <select class="text-input" id="trPage">
            <option value="a4">A4</option><option value="letter">US Letter</option><option value="a5">A5</option>
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
      <div class="panel-header-actions"><button class="button button-text" type="button" id="trPreviewToggle">Hide</button></div>
    </div>
    <div class="tr-preview-note"><span class="lab-count" id="trPreviewNote">nothing yet</span><span>Style and paper come from the controls above</span></div>
    <div class="tr-preview-stage" id="trPreviewStage">
      <article class="paper" data-theme="${escapeHtml(form.theme)}" data-margin="comfortable" data-orientation="portrait" aria-label="Translated document preview">
        <div class="document-content" id="trPaper"></div>
      </article>
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
  q('#trPage', root).value = form.pageSize;
  q('#trGlossaryText', root).value = form.glossary;
  parseGlossary();
}

function wire(root) {
  const save = debounce(() => prefs.write(form), 250);
  const onChange = (id, key, cast = (value) => value, after) => {
    const node = q(id, root);
    if (!node) return;
    const handler = () => {
      form[key] = cast(node.type === 'checkbox' ? node.checked : node.value);
      save();
      after?.();
    };
    node.addEventListener('change', handler);
    node.addEventListener('input', handler);
  };
  onChange('#trFrom', 'source');
  onChange('#trTo', 'target');
  onChange('#trProvider', 'provider', undefined, () => paintProvider(root));
  onChange('#trLibreUrl', 'libreUrl');
  onChange('#trLibreKey', 'libreKey');
  onChange('#trBatch', 'batch');
  onChange('#trBilingual', 'bilingual', undefined, () => renderPdfPreview(root));
  onChange('#trShowSource', 'showSource', undefined, () => paintListMode(root));
  onChange('#trTheme', 'theme', undefined, () => renderPdfPreview(root));
  onChange('#trPage', 'pageSize', undefined, () => renderPdfPreview(root));
  onChange('#trGlossaryText', 'glossary', undefined, () => {
    parseGlossary();
    if (state.segments.some((segment) => segment.translated)) renderList(root);
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

  const openPicker = () => pickOne();
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
      await navigator.clipboard.writeText(asPlainText(root));
      toast('Translated text copied.');
    } catch (error) {
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
  });
  paintProvider(root);
  renderPdfPreview(root);
}

function pickOne() {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) resolve(file);
      input.remove();
    });
    document.body.append(input);
    input.click();
  }).then((file) => ingestPdf(file, q('.tr-shell').closest('.tool-panel')));
}

/* ------------------------------------------------------------- ingest ---- */
async function ingestPdf(file, root) {
  if (!file) return;
  const label = q('#trPdfName', root);
  const originLabel = q('#trOriginState', root);
  label.textContent = `Reading ${file.name}…`;
  try {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, ...pdfjsAssetOptions() }).promise;
    const segments = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      if (label) label.textContent = `Reading page ${pageNumber} of ${doc.numPages}…`;
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      let line = [];
      let last = null;
      const lines = [];
      const pushLine = () => {
        const text = line.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
        line = [];
      };
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = Math.round(item.transform[5]);
        if (last !== null && Math.abs(y - last) > 3) pushLine();
        line.push(item);
        last = y;
        if (item.hasEOL) pushLine();
      }
      pushLine();
      const paragraphs = lines.join('\n').split(/\n{2,}/).map((value) => value.replace(/\n/g, ' ').trim()).filter(Boolean);
      paragraphs.forEach((text, index) => segments.push({ id: `p${pageNumber}-${index}`, page: pageNumber, label: `page ${pageNumber}, line ${index + 1}`, source: text, translated: '', status: 'idle', error: '' }));
      if (!paragraphs.length) segments.push({ id: `p${pageNumber}-0`, page: pageNumber, label: `page ${pageNumber}`, source: '', translated: '', status: 'idle', note: 'No selectable text on this page — it may be a scan.', error: '' });
    }
    await doc.cleanup?.();
    state.segments = segments;
    state.origin = 'pdf';
    state.originLabel = file.name;
    state.fileName = file.name.replace(/\.pdf$/i, '');
    state.pageCount = doc.numPages;
    if (label) label.textContent = `${file.name} · ${doc.numPages} pages`;
    if (originLabel) originLabel.textContent = `${segments.length} segments`;
    renderList(root);
    resetProgress(segments.length);
    renderPdfPreview(root);
    toast(segments.length ? `Loaded ${doc.numPages} pages — ready to translate.` : 'No text found in that PDF.', !segments.length);
  } catch (error) {
    console.error(error);
    if (label) label.textContent = 'Could not read that file';
    toast(error?.message || 'That PDF could not be read.', true);
  }
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
  state.segments = paragraphs.map((value, index) => ({ id: `t${index}`, page: 1, label: `line ${index + 1}`, source: value, translated: '', status: 'idle', error: '' }));
  state.origin = 'text';
  state.originLabel = name;
  state.fileName = name;
  state.pageCount = 1;
  q('#trOriginState', root).textContent = `${state.segments.length} segments`;
  renderList(root);
  resetProgress(state.segments.length);
  renderPdfPreview(root);
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
  q('#trProgressText').textContent = total ? `${total} segments ready` : 'Nothing to translate yet';
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
    renderPdfPreview(root);
    setProgress(0, state.segments.length, `${pending.length} ${pending.length === 1 ? 'line' : 'lines'} ready — type a translation and the PDF follows`);
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
      renderPdfPreview(root);
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
    renderPdfPreview(root);
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
  // Google's free web endpoint: one request per segment, returns nested arrays.
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
        ? 'Type or paste the translation for this line'
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
  const row = el('div', { class: `tr-row is-${segment.status}`, id: `seg-${segment.id}`, role: 'listitem' }, [
    el('span', { class: 'tr-row-status', 'aria-hidden': 'true' }),
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
      renderPdfPreview(root);
    });
  }
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
      el('p', { text: 'Your paragraphs will line up here.' }),
      el('small', { text: 'Pick a source on the left, then press Translate. Each line is replaced as it arrives.' }),
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
  note.textContent = `${state.segments.length} ${state.segments.length === 1 ? 'segment' : 'segments'} ${where}${typed ? ` · ${typed} translated` : ''}`;
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
  renderPdfPreview(root);
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
  if (label && !state.running) label.textContent = provider.manual ? 'Prepare lines' : 'Translate';
}

function translatedHtml() {
  const blocks = state.segments
    .filter((segment) => segment.source)
    .map((segment) => {
      const target = (segment.translated || '').trim();
      const source = segment.source.trim();
      const value = target || source;
      if (!form.bilingual || !target) return `<p>${escapeHtml(value)}</p>`;
      return `<p class="tr-pair"><span class="tr-pair-target">${escapeHtml(value)}</span><span class="tr-pair-source">${escapeHtml(source)}</span></p>`;
    })
    .join('');
  const pages = [];
  if (form.keepPages && state.origin === 'pdf') {
    const grouped = new Map();
    state.segments.forEach((segment) => {
      if (!grouped.has(segment.page)) grouped.set(segment.page, []);
      grouped.get(segment.page).push(segment);
    });
    return Array.from(grouped.entries())
      .map(
        ([page, segments]) =>
          `<h2 class="tr-doc-page">Page ${page}</h2>` +
          segments
            .filter((segment) => segment.source)
            .map((segment) => {
              const target = (segment.translated || '').trim();
              return form.bilingual && target
                ? `<p class="tr-pair"><span class="tr-pair-target">${escapeHtml(target)}</span><span class="tr-pair-source">${escapeHtml(segment.source.trim())}</span></p>`
                : `<p>${escapeHtml(target || segment.source.trim())}</p>`;
            })
            .join(''),
      )
      .join('<hr />');
  }
  return blocks || `<p class="tr-doc-empty">Nothing translated yet.</p>`;
  void pages;
}

function asPlainText() {
  return state.segments.map((segment) => (segment.translated || segment.source).trim()).join('\n\n');
}

function asMarkdownText(root) {
  void root;
  const lines = [`# ${state.fileName || 'translated'} — ${LANGUAGES.find(([code]) => code === form.target)?.[1] ?? form.target}`, ''];
  let page = null;
  for (const segment of state.segments) {
    if (!segment.source) continue;
    if (form.keepPages && state.origin === 'pdf' && segment.page !== page) {
      page = segment.page;
      lines.push(`## Page ${page}`, '');
    }
    lines.push((segment.translated || segment.source).trim(), '');
    if (form.showSource) lines.push(`> ${segment.source.trim().replace(/\n/g, ' ')}`, '');
  }
  return lines.join('\n');
}

let previewTimer;
function renderPdfPreview(root) {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(async () => {
    const frame = q('#trPaper', root);
    const sheet = q('.tr-preview .paper', root);
    if (!frame || !sheet) return;
    sheet.dataset.theme = form.theme;
    const translated = state.segments.filter((segment) => segment.translated).length;
    const html = translatedHtml();
    frame.innerHTML = translated ? html : `<div class="empty-preview"><strong>Nothing on the page yet</strong><span>Load a PDF and press Translate — the sheet fills in as lines arrive.</span></div>`;
    const note = q('#trPreviewNote', root);
    if (note) note.textContent = `${translated}/${state.segments.length} segments translated`;
  }, 200);
}

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
    await exportHtmlAsPdf({
      html: translatedHtml(),
      filename: safeFileName(`${state.fileName || 'document'}-${form.target}`, 'pdf'),
      theme: form.theme,
      margin: 'comfortable',
      pageSize: form.pageSize,
    });
  } catch (error) {
    console.error(error);
    toast(error?.message || 'The PDF could not be built.', true);
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function downloadText(type, root, markdown = false) {
  if (!state.segments.length) {
    toast('Nothing to save yet.', true);
    return;
  }
  const body = markdown ? asMarkdownText(root) : asPlainText();
  downloadBlob(new Blob([body], { type }), safeFileName(`${state.fileName || 'translated'}-${form.target}`, markdown ? 'md' : 'txt'));
}

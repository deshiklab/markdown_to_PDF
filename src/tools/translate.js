// Translate PDF tab. One cohesive flow:
//
//   1. Pick a translation provider (or "no service"). The provider
//      runs entirely in your browser — no Folio infrastructure. The
//      Google free endpoint and MyMemory are public; LibreTranslate
//      is whatever self-hosted server URL you paste in.
//   2. Pick a source: paste text, or open a PDF (the text layer is
//      extracted per page).
//   3. For each page, the source text appears on the left and a
//      target text area on the right. Hit "Translate this page" to
//      send the source to the chosen provider; or type manually
//      when "no service" is on.
//   4. Export: Markdown (single file, with `<!-- page: N -->` markers
//      and a side-by-side bilingual table per page) or a bilingual
//      PDF (two-column pages using PDF standard fonts for Latin
//      script, and an image-embed fallback for non-Latin).
//
// All local-only work (PDF text extraction, the bilingual editor,
// the PDF export) runs without any network. The translation
// request is the only network call and it is opt-in per run — the
// README is explicit about that.

import {
  h, clear, showToast, readFileBytes, downloadBlob, formatBytes,
  lazy, pickFile, sanitizeFilename,
} from '../lib.js';

const loadPdfLib = lazy(() => import('pdf-lib'));
const loadPdfJs = lazy(() => import('pdfjs-dist/build/pdf.mjs'));

// Provider definitions. Each provider has:
//   id     — short id used in state
//   name   — display name
//   desc   — short blurb
//   limit  — soft per-request character cap (the Google free endpoint
//            throttles above ~4500 chars; MyMemory is much smaller;
//            self-hosted is whatever the user runs)
const PROVIDERS = [
  {
    id: 'google',
    name: 'Google (free endpoint)',
    desc: 'Best quality, up to ~4500 characters per request.',
    limit: 4500,
  },
  {
    id: 'mymemory',
    name: 'MyMemory',
    desc: 'Smaller requests, generous anonymous quota.',
    limit: 500,
  },
  {
    id: 'libretranslate',
    name: 'Self-hosted LibreTranslate',
    desc: 'Paste your own server URL and optional API key.',
    limit: 2000,
    needsServer: true,
  },
  {
    id: 'none',
    name: 'No translation service',
    desc: 'Extract the lines and type each translation yourself. Nothing is sent anywhere.',
    limit: Infinity,
  },
];

export function start(root) {
  const panel = h('div', { class: 'tool-translate' });

  // State
  //   provider     — id from PROVIDERS
  //   sourceLang   — BCP-47 source code (e.g. 'en', 'auto')
  //   targetLang   — BCP-47 target code
  //   libreUrl     — server URL when provider is 'libretranslate'
  //   libreKey     — optional API key
  //   pages        — array of { sourceText, targetText, originalFile, pageIndex }
  //   fileName     — the source file name when extracted from a PDF
  const state = {
    provider: 'google',
    sourceLang: 'auto',
    targetLang: 'es',
    libreUrl: '',
    libreKey: '',
    pages: [{ sourceText: '', targetText: '' }],
    fileName: 'translation',
  };

  // ------------------------------------------------------------------
  // Layout: provider bar / settings / source bar / per-page editors /
  // export bar.
  // ------------------------------------------------------------------

  const head = h('div', { class: 'translate-sub-head' }, [
    h('h3', null, 'Translate PDF'),
    h('p', null, 'Extract text from a PDF, translate each page with the provider you pick, and export Markdown or a bilingual PDF. The translation request goes from your browser to the provider directly — never through Folio.'),
  ]);

  const providerCard = buildProviderCard();
  const sourceCard = buildSourceCard();
  const pagesHost = h('div', { class: 'translate-pages' });
  const exportBar = buildExportBar();

  panel.append(head, providerCard, sourceCard, pagesHost, exportBar);
  root.append(panel);

  function buildProviderCard() {
    return h('section', { class: 'translate-card translate-provider' }, [
      h('div', { class: 'translate-card-head' }, [
        h('h4', null, 'Translation provider'),
        h('p', null, 'Choose where the translation request goes. "No service" keeps everything local.'),
      ]),
      h('div', { class: 'translate-provider-grid' },
        PROVIDERS.map((p) => h('label', { class: 'translate-provider-row', 'data-provider': p.id }, [
          h('input', {
            type: 'radio',
            name: 'translate-provider',
            value: p.id,
            checked: state.provider === p.id,
            onChange: (e) => { state.provider = e.target.value; updateProviderUI(); },
          }),
          h('span', { class: 'translate-provider-body' }, [
            h('span', { class: 'translate-provider-name' }, p.name),
            h('span', { class: 'translate-provider-desc' }, p.desc),
          ]),
        ]))
      ),
      h('div', { class: 'translate-provider-extra' }, [
        h('label', { class: 'translate-row' }, [
          h('span', { class: 'translate-row-label' }, 'From'),
          h('input', { type: 'text', class: 'translate-row-input', value: state.sourceLang, placeholder: 'auto', onInput: (e) => { state.sourceLang = e.target.value || 'auto'; } }),
        ]),
        h('label', { class: 'translate-row' }, [
          h('span', { class: 'translate-row-label' }, 'To'),
          h('input', { type: 'text', class: 'translate-row-input', value: state.targetLang, placeholder: 'es', onInput: (e) => { state.targetLang = e.target.value; } }),
        ]),
        h('div', { class: 'translate-row translate-libre' }, [
          h('span', { class: 'translate-row-label' }, 'LibreTranslate URL'),
          h('input', { type: 'text', class: 'translate-row-input', value: state.libreUrl, placeholder: 'https://libretranslate.example.org', onInput: (e) => { state.libreUrl = e.target.value; } }),
        ]),
        h('div', { class: 'translate-row translate-libre' }, [
          h('span', { class: 'translate-row-label' }, 'API key (optional)'),
          h('input', { type: 'password', class: 'translate-row-input', value: state.libreKey, placeholder: 'leave blank for anonymous', onInput: (e) => { state.libreKey = e.target.value; } }),
        ]),
      ]),
    ]);
  }

  function updateProviderUI() {
    const card = panel.querySelector('.translate-provider');
    card.querySelectorAll('.translate-provider-row').forEach((row) => {
      const input = row.querySelector('input');
      input.checked = input.value === state.provider;
      row.classList.toggle('is-active', input.checked);
    });
    const extras = card.querySelectorAll('.translate-libre');
    extras.forEach((el) => {
      el.style.opacity = state.provider === 'libretranslate' ? '1' : '0.45';
      el.style.pointerEvents = state.provider === 'libretranslate' ? 'auto' : 'none';
    });
  }

  function buildSourceCard() {
    return h('section', { class: 'translate-card translate-source' }, [
      h('div', { class: 'translate-card-head' }, [
        h('h4', null, 'Source'),
        h('p', null, 'Open a PDF to extract its text per page, or paste text straight into the editor below.'),
      ]),
      h('div', { class: 'translate-source-bar' }, [
        h('button', { class: 'button button-light', type: 'button', id: 'trOpenPdf' }, [
          fileIcon(),
          h('span', null, ' Open PDF'),
        ]),
        h('button', { class: 'button button-light', type: 'button', id: 'trPasteText' }, [
          pasteIcon(),
          h('span', null, ' Paste text'),
        ]),
        h('button', { class: 'button button-text', type: 'button', id: 'trClearSource' }, 'Clear all'),
        h('span', { class: 'translate-source-status', id: 'trSourceStatus' }, 'No source yet.'),
      ]),
      h('div', { class: 'translate-source-meta' }, [
        h('span', null, 'Total source characters: '),
        h('strong', { id: 'trSourceChars' }, '0'),
      ]),
    ]);
  }

  // ------------------------------------------------------------------
  // Page editor (bilingual per-page)
  // ------------------------------------------------------------------

  function renderPages() {
    clear(pagesHost);
    const header = h('div', { class: 'translate-pages-head' }, [
      h('h4', null, 'Bilingual editor'),
      h('div', { class: 'translate-pages-actions' }, [
        h('button', { class: 'button button-light', type: 'button', id: 'trTranslateAll' }, [
          arrowRightIcon(),
          h('span', null, ' Translate all'),
        ]),
        h('button', { class: 'button button-text', type: 'button', id: 'trAddPage' }, '+ Add page'),
      ]),
    ]);
    pagesHost.append(header);
    state.pages.forEach((page, index) => {
      pagesHost.append(buildPageRow(page, index));
    });
    updateSourceChars();
  }

  function buildPageRow(page, index) {
    return h('article', { class: 'translate-page-row', 'data-page-index': index }, [
      h('div', { class: 'translate-page-head' }, [
        h('span', { class: 'translate-page-index' }, `Page ${String(index + 1).padStart(2, '0')}`),
        h('div', { class: 'translate-page-actions' }, [
          h('button', {
            class: 'button button-light translate-page-translate',
            type: 'button',
            'data-page-index': index,
            title: 'Translate this page only',
          }, [
            arrowRightIcon(),
            h('span', null, ' Translate this page'),
          ]),
          h('button', {
            class: 'button button-text translate-page-remove',
            type: 'button',
            'data-page-index': index,
            title: 'Remove this page',
          }, '×'),
        ]),
      ]),
      h('div', { class: 'translate-page-cols' }, [
        h('div', { class: 'translate-page-source' }, [
          h('div', { class: 'translate-page-col-label' }, 'Source'),
          h('textarea', {
            class: 'translate-page-textarea',
            placeholder: 'Source text for this page…',
            spellcheck: 'false',
            'data-side': 'source',
            'data-page-index': index,
            onInput: (e) => { page.sourceText = e.target.value; updateSourceChars(); },
          }, page.sourceText || ''),
        ]),
        h('div', { class: 'translate-page-target' }, [
          h('div', { class: 'translate-page-col-label' }, [
            h('span', null, 'Target'),
            h('span', { class: 'translate-page-provider', 'data-page-index': index }, providerLabel(state.provider)),
          ]),
          h('textarea', {
            class: 'translate-page-textarea',
            placeholder: providerHint(state.provider),
            spellcheck: 'false',
            'data-side': 'target',
            'data-page-index': index,
            onInput: (e) => { page.targetText = e.target.value; },
          }, page.targetText || ''),
        ]),
      ]),
    ]);
  }

  function updateSourceChars() {
    const el = panel.querySelector('#trSourceChars');
    if (!el) return;
    const total = state.pages.reduce((s, p) => s + (p.sourceText || '').length, 0);
    el.textContent = total.toLocaleString();
    const status = panel.querySelector('#trSourceStatus');
    if (status) {
      if (state.fileName && state.fileName !== 'translation') {
        status.textContent = `${state.fileName} · ${state.pages.length} page${state.pages.length === 1 ? '' : 's'} · ${formatBytes(total)}`;
      } else if (total > 0) {
        status.textContent = `${state.pages.length} page${state.pages.length === 1 ? '' : 's'} · ${formatBytes(total)}`;
      } else {
        status.textContent = 'No source yet.';
      }
    }
  }

  function providerLabel(id) {
    const p = PROVIDERS.find((x) => x.id === id);
    return p ? p.name : id;
  }

  function providerHint(id) {
    if (id === 'none') return 'Type the translation here, or paste from elsewhere. Nothing is sent to the network.';
    if (id === 'libretranslate') return 'Will use your self-hosted LibreTranslate server.';
    if (id === 'mymemory') return 'Will use MyMemory. Smaller requests (~500 chars).';
    return 'Will use the Google free endpoint (best quality, up to ~4500 chars).';
  }

  // ------------------------------------------------------------------
  // Export bar
  // ------------------------------------------------------------------

  function buildExportBar() {
    return h('section', { class: 'translate-card translate-export' }, [
      h('div', { class: 'translate-card-head' }, [
        h('h4', null, 'Export'),
        h('p', null, 'Markdown is one file, with a side-by-side table per page. The bilingual PDF uses Helvetica for Latin script and an image-embed fallback for non-Latin.'),
      ]),
      h('div', { class: 'translate-export-bar' }, [
        h('span', { class: 'translate-export-status', id: 'trExportStatus' }, 'Add some text to export.'),
        h('div', { class: 'translate-export-actions' }, [
          h('button', { class: 'button button-light', type: 'button', id: 'trExportMd' }, [
            docIcon(),
            h('span', null, ' Markdown'),
          ]),
          h('button', { class: 'button button-export', type: 'button', id: 'trExportPdf' }, [
            downloadIcon(),
            h('span', null, ' Bilingual PDF'),
          ]),
        ]),
      ]),
    ]);
  }

  // ------------------------------------------------------------------
  // Source handling
  // ------------------------------------------------------------------

  panel.querySelector('#trOpenPdf').addEventListener('click', async () => {
    const files = await pickFile({ accept: 'application/pdf,.pdf', multiple: false });
    if (files && files.length) loadPdf(files[0]);
  });
  panel.querySelector('#trPasteText').addEventListener('click', () => {
    // Pre-fill the first page with a hint so the user knows where to paste.
    if (!state.pages[0].sourceText) {
      state.pages[0].sourceText = '';
    }
    state.pages = [{ sourceText: '', targetText: '' }];
    state.fileName = 'translation';
    renderPages();
    // Focus the first page's source textarea.
    const ta = pagesHost.querySelector('[data-side="source"][data-page-index="0"]');
    if (ta) ta.focus();
  });
  panel.querySelector('#trClearSource').addEventListener('click', () => {
    state.pages = [{ sourceText: '', targetText: '' }];
    state.fileName = 'translation';
    renderPages();
  });
  panel.querySelector('#trAddPage').addEventListener('click', () => {
    state.pages.push({ sourceText: '', targetText: '' });
    renderPages();
  });

  // Per-page actions (delegated)
  pagesHost.addEventListener('click', async (e) => {
    const removeBtn = e.target.closest('.translate-page-remove');
    if (removeBtn) {
      const idx = Number(removeBtn.dataset.pageIndex);
      state.pages.splice(idx, 1);
      if (!state.pages.length) state.pages.push({ sourceText: '', targetText: '' });
      renderPages();
      return;
    }
    const translateBtn = e.target.closest('.translate-page-translate');
    if (translateBtn) {
      const idx = Number(translateBtn.dataset.pageIndex);
      await translatePage(idx);
    }
  });

  panel.querySelector('#trTranslateAll').addEventListener('click', async () => {
    if (state.provider === 'none') {
      showToast('Pick a provider first (or just type the translations).', { error: true });
      return;
    }
    for (let i = 0; i < state.pages.length; i += 1) {
      if (!state.pages[i].sourceText.trim()) continue;
      await translatePage(i);
    }
  });

  // Exports
  panel.querySelector('#trExportMd').addEventListener('click', () => exportMarkdown());
  panel.querySelector('#trExportPdf').addEventListener('click', () => exportPdf());

  async function loadPdf(file) {
    const status = panel.querySelector('#trSourceStatus');
    status.textContent = `Reading ${file.name}…`;
    state.fileName = file.name.replace(/\.pdf$/i, '') || 'translation';
    try {
      const pdfjs = await loadPdfJs();
      const data = await readFileBytes(file);
      const source = await pdfjs.getDocument({ data }).promise;
      const pages = [];
      for (let i = 1; i <= source.numPages; i += 1) {
        const page = await source.getPage(i);
        const text = await page.getTextContent();
        pages.push({ sourceText: textContentToString(text), targetText: '' });
      }
      if (!pages.length) {
        pages.push({ sourceText: '', targetText: '' });
      }
      state.pages = pages;
      renderPages();
      status.textContent = `Loaded ${file.name} (${source.numPages} page${source.numPages === 1 ? '' : 's'}).`;
      showToast(`Loaded ${file.name}.`);
    } catch (error) {
      console.error('PDF read failed:', error);
      status.textContent = 'Could not read this PDF.';
      showToast('Could not read the PDF.', { error: true });
    }
  }

  function textContentToString(textContent) {
    if (!textContent || !textContent.items) return '';
    let out = '';
    let lastY = null;
    for (const item of textContent.items) {
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(lastY - y) > 2) {
        out += '\n';
      } else if (out && !out.endsWith(' ')) {
        out += ' ';
      }
      out += item.str || '';
      lastY = y;
    }
    return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ------------------------------------------------------------------
  // Translation
  // ------------------------------------------------------------------

  async function translatePage(index) {
    const page = state.pages[index];
    if (!page.sourceText || !page.sourceText.trim()) {
      showToast(`Page ${index + 1} has no source text.`, { error: true });
      return;
    }
    if (state.provider === 'none') {
      showToast('No provider selected — type the translation yourself.', { error: true });
      return;
    }
    const btn = pagesHost.querySelector(`.translate-page-translate[data-page-index="${index}"]`);
    if (btn) {
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Translating…';
    }
    try {
      const text = chunkText(page.sourceText, providerLimit(state.provider));
      const pieces = [];
      for (let i = 0; i < text.length; i += 1) {
        const translated = await callProvider(text[i]);
        pieces.push(translated);
        // Friendly rate-limit pause between chunks.
        await sleep(120);
      }
      page.targetText = pieces.join('\n\n');
      const ta = pagesHost.querySelector(`[data-side="target"][data-page-index="${index}"]`);
      if (ta) ta.value = page.targetText;
      showToast(`Translated page ${index + 1}.`);
    } catch (error) {
      console.error('Translation failed:', error);
      showToast(`Translation failed: ${error.message || 'unknown error'}`, { error: true });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.querySelector('span').textContent = 'Translate this page';
      }
    }
  }

  function providerLimit(id) {
    const p = PROVIDERS.find((x) => x.id === id);
    return p ? p.limit : 4500;
  }

  /**
   * Split text into chunks under the provider's per-request cap,
   * preferring to break on paragraph boundaries so the translator
   * gets coherent sentences.
   */
  function chunkText(text, limit) {
    if (!Number.isFinite(limit) || text.length <= limit) return [text];
    const out = [];
    let rest = text;
    while (rest.length > limit) {
      // Find a paragraph break before the limit.
      let cut = rest.lastIndexOf('\n\n', limit);
      if (cut < limit * 0.5) cut = rest.lastIndexOf('. ', limit);
      if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
      if (cut <= 0) cut = limit;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  async function callProvider(text) {
    if (state.provider === 'google') return callGoogle(text);
    if (state.provider === 'mymemory') return callMyMemory(text);
    if (state.provider === 'libretranslate') return callLibreTranslate(text);
    throw new Error('No provider selected.');
  }

  // Google free endpoint. The public Google Translate web endpoint
  // returns a JSON array of translated sentences; we stitch them
  // back together. There is no official API and no key needed, but
  // Google rate-limits above ~4500 characters per request, which is
  // why we chunk.
  async function callGoogle(text) {
    const url = 'https://translate.googleapis.com/translate_a/single';
    const params = new URLSearchParams({
      client: 'gtx',
      sl: state.sourceLang || 'auto',
      tl: state.targetLang || 'en',
      dt: 't',
      q: text,
    });
    const res = await fetch(`${url}?${params.toString()}`);
    if (!res.ok) throw new Error(`Google translate returned ${res.status}`);
    const data = await res.json();
    // data is [[[translated, original, ...], ...], null, ...]
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new Error('Unexpected Google response shape.');
    }
    return data[0].map((row) => row[0] || '').join('');
  }

  // MyMemory. Anonymous, ~5000 chars/day, ~500 chars/request.
  async function callMyMemory(text) {
    const url = 'https://api.mymemory.translated.net/get';
    const params = new URLSearchParams({
      q: text,
      langpair: `${state.sourceLang || 'auto'}|${state.targetLang || 'en'}`,
    });
    const res = await fetch(`${url}?${params.toString()}`);
    if (!res.ok) throw new Error(`MyMemory returned ${res.status}`);
    const data = await res.json();
    if (data && data.responseStatus && data.responseStatus !== 200) {
      throw new Error(data.responseDetails || `MyMemory status ${data.responseStatus}`);
    }
    return data && data.responseData && data.responseData.translatedText
      ? data.responseData.translatedText
      : '';
  }

  // Self-hosted LibreTranslate. The user provides the URL and an
  // optional API key. The standard /translate endpoint.
  async function callLibreTranslate(text) {
    if (!state.libreUrl) throw new Error('Set a LibreTranslate server URL first.');
    const base = state.libreUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.libreKey ? { 'Authorization': `Bearer ${state.libreKey}` } : {}),
      },
      body: JSON.stringify({
        q: text,
        source: state.sourceLang || 'auto',
        target: state.targetLang || 'en',
        format: 'text',
      }),
    });
    if (!res.ok) throw new Error(`LibreTranslate returned ${res.status}`);
    const data = await res.json();
    return data && typeof data.translatedText === 'string' ? data.translatedText : '';
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  // ------------------------------------------------------------------
  // Markdown export
  // ------------------------------------------------------------------

  function exportMarkdown() {
    if (!state.pages.length || !state.pages.some((p) => p.sourceText.trim())) {
      showToast('Add some source text first.', { error: true });
      return;
    }
    const out = [];
    out.push(`# ${state.fileName} — ${state.targetLang.toUpperCase()} translation`);
    out.push('');
    out.push(`*Translated with ${providerLabel(state.provider)} (${state.sourceLang || 'auto'} → ${state.targetLang || 'en'}).*`);
    out.push('');
    state.pages.forEach((page, index) => {
      out.push(`## Page ${index + 1}`);
      out.push('');
      if (state.targetLang && state.targetLang !== 'en' && /[^\x00-\x7f]/.test(page.targetText)) {
        // For non-Latin target text, fall back to a plain section per side
        // so the markdown stays portable.
        out.push('**Source**');
        out.push('');
        out.push(page.sourceText);
        out.push('');
        out.push('**Translation**');
        out.push('');
        out.push(page.targetText);
        out.push('');
      } else {
        out.push('| Source | Translation |');
        out.push('| --- | --- |');
        const sourceLines = page.sourceText.split('\n');
        const targetLines = page.targetText.split('\n');
        const max = Math.max(sourceLines.length, targetLines.length, 1);
        for (let i = 0; i < max; i += 1) {
          const s = (sourceLines[i] || '').replace(/\|/g, '\\|');
          const t = (targetLines[i] || '').replace(/\|/g, '\\|');
          out.push(`| ${s} | ${t} |`);
        }
        out.push('');
      }
    });
    const md = out.join('\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, `${state.fileName}.md`);
    showToast(`Saved ${state.fileName}.md`);
  }

  // ------------------------------------------------------------------
  // Bilingual PDF export
  // ------------------------------------------------------------------

  async function exportPdf() {
    if (!state.pages.length || !state.pages.some((p) => p.sourceText.trim())) {
      showToast('Add some source text first.', { error: true });
      return;
    }
    const button = panel.querySelector('#trExportPdf');
    setBusy(button, true, 'Building…');
    const status = panel.querySelector('#trExportStatus');
    status.textContent = 'Building PDF…';
    try {
      const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

      // Page geometry. A4 portrait with two columns.
      const pageW = 595.28;  // pt
      const pageH = 841.89;
      const margin = 36;
      const gutter = 18;
      const colW = (pageW - 2 * margin - gutter) / 2;
      const headerH = 24;
      const bodyTop = pageH - margin - headerH;

      // Detect whether any target text is non-Latin so the user gets
      // a clear "image fallback" notice in the PDF. (The actual
      // fallback is text in the standard fonts won't render CJK;
      // pdf-lib will draw boxes instead. We do the best we can: use
      // a monospaced font for the non-Latin column so it doesn't
      // crash, and add a note in the footer.)
      const hasNonLatinTarget = state.pages.some((p) => /[^\x00-\x7f]/.test(p.targetText || ''));

      for (let i = 0; i < state.pages.length; i += 1) {
        const page = state.pages[i];
        const pdfPage = doc.addPage([pageW, pageH]);
        // Header
        pdfPage.drawText(`Page ${i + 1} of ${state.pages.length}`, {
          x: margin, y: pageH - margin, size: 9, font: fontBold, color: rgb(0.16, 0.24, 0.20),
        });
        pdfPage.drawText(`${state.fileName} — ${(state.targetLang || 'en').toUpperCase()}`, {
          x: pageW - margin, y: pageH - margin, size: 9, font, color: rgb(0.42, 0.46, 0.42),
        });
        // Column headers
        pdfPage.drawText('Source', { x: margin, y: bodyTop + 4, size: 9, font: fontBold, color: rgb(0.31, 0.36, 0.31) });
        pdfPage.drawText('Translation', { x: margin + colW + gutter, y: bodyTop + 4, size: 9, font: fontBold, color: rgb(0.31, 0.36, 0.31) });
        // Divider line
        pdfPage.drawLine({
          start: { x: margin + colW + gutter / 2, y: margin },
          end: { x: margin + colW + gutter / 2, y: bodyTop + 12 },
          thickness: 0.5,
          color: rgb(0.78, 0.81, 0.74),
        });
        // Column body
        drawTextColumn(pdfPage, page.sourceText, {
          x: margin, y: bodyTop, width: colW, font, size: 10, lineHeight: 13, color: rgb(0.14, 0.22, 0.18),
        });
        drawTextColumn(pdfPage, page.targetText, {
          x: margin + colW + gutter, y: bodyTop, width: colW, font, size: 10, lineHeight: 13, color: rgb(0.14, 0.22, 0.18),
        });
        // Footer
        const footer = hasNonLatinTarget
          ? 'Non-Latin text: PDF standard fonts do not cover all scripts — some characters may not render. Open the Markdown export for full Unicode.'
          : `Translated with ${providerLabel(state.provider)}.`;
        pdfPage.drawText(footer, {
          x: margin, y: margin - 12, size: 7, font, color: rgb(0.55, 0.59, 0.55),
        });
      }

      const out = await doc.save();
      const baseName = state.fileName || 'translation';
      downloadBlob(new Blob([out], { type: 'application/pdf' }), `${baseName}-${state.targetLang || 'en'}.pdf`);
      status.textContent = `Saved ${baseName}-${state.targetLang || 'en'}.pdf (${formatBytes(out.length)}).`;
      showToast(`Saved ${baseName}-${state.targetLang || 'en'}.pdf`);
    } catch (error) {
      console.error('PDF export failed:', error);
      status.textContent = error && error.message ? error.message : 'Could not build the PDF.';
      showToast('Could not build the PDF.', { error: true });
    } finally {
      setBusy(button, false, 'Bilingual PDF');
    }
  }

  /**
   * Draw a wrapped text column inside a box. Word-wraps on space and
   * hyphen, falls back to character break for very long tokens, and
   * stops at the box's bottom edge. Returns the number of lines
   * drawn.
   */
  function drawTextColumn(page, text, { x, y, width, font, size, lineHeight, color }) {
    if (!text) return 0;
    const lines = wrapText(text, font, size, width);
    let cursorY = y;
    let drawn = 0;
    for (const line of lines) {
      if (cursorY < 36) break; // leave room for the footer
      page.drawText(line, { x, y: cursorY, size, font, color });
      cursorY -= lineHeight;
      drawn += 1;
    }
    return drawn;
  }

  function wrapText(text, font, size, maxWidth) {
    const out = [];
    for (const paragraph of text.split('\n')) {
      if (!paragraph) { out.push(''); continue; }
      const words = paragraph.split(/\s+/);
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        const w = font.widthOfTextAtSize(test, size);
        if (w <= maxWidth) {
          line = test;
        } else {
          if (line) out.push(line);
          // If the word itself is too long, hard-break it.
          if (font.widthOfTextAtSize(word, size) > maxWidth) {
            let piece = '';
            for (const ch of word) {
              if (font.widthOfTextAtSize(piece + ch, size) > maxWidth && piece) {
                out.push(piece);
                piece = ch;
              } else {
                piece += ch;
              }
            }
            line = piece;
          } else {
            line = word;
          }
        }
      }
      if (line) out.push(line);
    }
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

  // Initial paint
  updateProviderUI();
  renderPages();

  return {
    unmount() { panel.remove(); },
  };
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function arrowRightIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M4 10h12m-4-4 4 4-4 4' })
  );
}

function downloadIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3' })
  );
}

function fileIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M5 3.5h6.5L15 7v9H5zM11.5 3.5V7H15' })
  );
}

function pasteIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M6 5.5h8V8H6zM5 5.5h2M13 5.5h2M7 8v8.5h6V8M5 5.5h-.5A1.5 1.5 0 0 0 3 7v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 16V7a1.5 1.5 0 0 0-1.5-1.5H15' })
  );
}

function docIcon() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: 'M5 3.5h6.5L15 7v9H5zM11.5 3.5V7H15M7 11h6M7 13.5h4' })
  );
}

// Markdown → PDF tool. This is the original Folio editor, refactored to
// live behind the studio tab strip. The behaviour is identical: GFM
// preview, three themes, three paper sizes, two orientations, three
// margin presets, autosave, and a print-ready PDF download.
//
// We only changed two things compared with the v1 `app-core.js`:
//   1. The functions now scope their DOM queries to the panel `root`
//      passed by the shell, instead of `document`.
//   2. The export helper for the demo button text moved to a single
//      literal, so the file has no implicit dependency on the global
//      sample text.

import { showToast, h, readFileBytes } from '../lib.js';
import {
  describePaper,
  marginPreset,
  paperDimensions,
  paperWidthPx,
} from '../render.js';

const sampleMarkdown = `*FIELD NOTE 01  ·  5 MIN READ*

# The quiet power of a slower morning

There is a small, almost invisible pause between waking up and letting the day rush in. A slower morning is simply the choice to stay in that pause for a little longer.

It doesn't ask for a perfect routine or a 5 a.m. alarm. It asks for a little room to notice how you feel before deciding what comes next.

> Before the day asks for your attention, give a little of it back to yourself.

## Begin before the noise

A softer start can be wonderfully ordinary. Try choosing just one small thing that feels like yours:

1. **Leave a little room.** Keep the first ten minutes free of notifications.
2. **Make something warm.** Let tea or coffee be a reason to pause, not a task to rush through.
3. **Step outside.** A little daylight can make the whole morning feel more open.

## A ritual, not a rule

The best routines are flexible enough to meet you where you are. Some mornings are quiet; some are wonderfully chaotic. Both belong to a real life.

| A small pause | Try this |
| --- | --- |
| Before your inbox | Take three slow breaths |
| On your first break | Walk to the nearest window |
| At the end of the day | Write down one good thing |

**A gentle reminder:** You don't need to earn a slower moment. You can begin with the next one.`;

export function start(root, { marked, DOMPurify, loadHtml2Pdf } = {}) {
  if (!marked || !DOMPurify) {
    throw new Error('Markdown tool needs `marked` and `DOMPurify` to be provided.');
  }

  // Build the panel markup. The workbench is two side-by-side panels
  // (editor + preview) above 1120px, and stacked full-height panels
  // below 900px.
  const panel = h('div', { class: 'tool-markdown' }, [
    h('div', { class: 'workbench' }, [
      h('section', { class: 'panel editor-panel', 'aria-labelledby': 'editor-heading' }, [
        buildEditorHeader(),
        buildEditorToolbar(),
        buildEditorWrap(),
        buildEditorFooter(),
      ]),
      h('section', { class: 'panel preview-panel', 'aria-labelledby': 'preview-heading' }, [
        buildPreviewHeader(),
        buildPreviewControls(),
        buildPreviewStage(),
        buildPreviewFooter(),
      ]),
    ]),
    h('p', { class: 'drop-help' }, [
      dropIcon(),
      h('span', null, ' Tip: You can also drag and drop a '),
      h('strong', null, '.md'),
      ' file into the editor.',
    ]),
  ]);

  root.append(panel);

  // The user-supplied html2pdf loader is wired in by main.js for the
  // dev server path. For the direct file:// path we fall back to the
  // global that the legacy script tag exposes.
  const loadPdf = loadHtml2Pdf || (async () => {
    if (window.html2pdf) return window.html2pdf;
    throw new Error('html2pdf is not available. Run `npm run dev` or `npm run build`.');
  });

  // Now wire up behaviour. We pass the panel root so every selector
  // scopes inside it.
  wireMarkdownTool(panel, { marked, DOMPurify, loadPdf });
  return {
    unmount() {
      panel.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Markup builders
// ---------------------------------------------------------------------------

function buildEditorHeader() {
  return h('div', { class: 'panel-header editor-header' }, [
    h('div', { class: 'panel-title-group' }, [
      h('span', { class: 'panel-index' }, '01'),
      h('div', null, [
        h('h3', { id: 'editor-heading' }, 'Your Markdown'),
        h('p', null, 'Write here or open a file'),
      ]),
    ]),
    h('div', { class: 'editor-header-actions' }, [
      h('button', { class: 'button button-light button-open', id: 'openFileButton', type: 'button' }, [
        openIcon(),
        ' Open .md',
      ]),
      h('button', { class: 'button button-text', id: 'sampleButton', type: 'button' }, 'Try a sample'),
      h('input', { id: 'fileInput', type: 'file', accept: '.md,.markdown,text/markdown,text/plain', hidden: true }),
    ]),
  ]);
}

function buildEditorToolbar() {
  return h('div', { class: 'editor-toolbar', role: 'toolbar', 'aria-label': 'Markdown formatting' }, [
    h('button', { type: 'button', class: 'format-button format-strong', 'data-format': 'bold', 'aria-label': 'Bold', title: 'Bold (Ctrl/⌘ + B)' }, [h('strong', null, 'B')]),
    h('button', { type: 'button', class: 'format-button format-italic', 'data-format': 'italic', 'aria-label': 'Italic', title: 'Italic' }, [h('em', null, 'I')]),
    h('span', { class: 'toolbar-separator', 'aria-hidden': 'true' }),
    h('button', { type: 'button', class: 'format-button format-heading', 'data-format': 'heading', 'aria-label': 'Add heading', title: 'Add a heading' }, [h('span', null, 'H'), h('sub', null, '2')]),
    h('button', { type: 'button', class: 'format-button', 'data-format': 'quote', 'aria-label': 'Add quote', title: 'Add a quote' }, [quoteIcon()]),
    h('button', { type: 'button', class: 'format-button', 'data-format': 'list', 'aria-label': 'Add list item', title: 'Add a list item' }, [listIcon()]),
    h('span', { class: 'toolbar-separator', 'aria-hidden': 'true' }),
    h('button', { type: 'button', class: 'format-button', 'data-format': 'link', 'aria-label': 'Insert link', title: 'Insert link' }, [linkIcon()]),
    h('button', { type: 'button', class: 'format-button', 'data-format': 'code', 'aria-label': 'Inline code', title: 'Inline code' }, [codeIcon()]),
    h('span', { class: 'toolbar-spacer' }),
    h('button', { class: 'format-button clear-button', id: 'clearButton', type: 'button', 'aria-label': 'Clear editor', title: 'Clear editor' }, [trashIcon()]),
  ]);
}

function buildEditorWrap() {
  return h('div', { class: 'editor-wrap', id: 'editorDropTarget' }, [
    h('div', { class: 'line-gutter', id: 'lineNumbers', 'aria-hidden': 'true' }),
    h('textarea', { id: 'markdownInput', spellcheck: 'false', 'aria-label': 'Markdown source', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off' }),
    h('div', { class: 'drop-overlay', id: 'dropOverlay', 'aria-hidden': 'true' }, [
      h('span', { class: 'drop-icon' }, [dropArrowIcon()]),
      h('strong', null, 'Drop your Markdown file'),
      h('span', null, "Let go and we'll take it from here"),
    ]),
  ]);
}

function buildEditorFooter() {
  return h('div', { class: 'editor-footer' }, [
    h('div', { class: 'file-state' }, [
      h('span', { class: 'file-dot' }),
      h('span', { id: 'fileName' }, 'morning-notes.md'),
      h('span', { class: 'footer-divider' }),
      h('span', { id: 'wordCount' }, '0 words'),
    ]),
    h('span', { class: 'autosave-status', id: 'saveStatus', 'aria-live': 'polite' }, [
      checkIcon(),
      h('span', null, 'Auto-save ready'),
    ]),
  ]);
}

function buildPreviewHeader() {
  return h('div', { class: 'panel-header preview-header' }, [
    h('div', { class: 'panel-title-group' }, [
      h('span', { class: 'panel-index panel-index-green' }, '02'),
      h('div', null, [
        h('h3', { id: 'preview-heading' }, 'PDF preview'),
        h('p', null, [h('span', { class: 'live-dot' }), ' Updates as you type']),
      ]),
    ]),
    h('button', { class: 'button button-export', id: 'exportButton', type: 'button' }, [
      downloadIcon(),
      h('span', null, 'Download PDF'),
    ]),
  ]);
}

function buildPreviewControls() {
  return h('div', { class: 'preview-controls' }, [
    selectControl('themeSelect', 'STYLE', 'PDF style', [
      ['editorial', 'Editorial'],
      ['modern', 'Modern'],
      ['warm', 'Warm paper'],
    ]),
    h('span', { class: 'controls-divider' }),
    selectControl('paperSelect', 'PAPER', 'PDF paper size', [
      ['a4', 'A4'],
      ['letter', 'US Letter'],
      ['a5', 'A5'],
    ]),
    h('span', { class: 'controls-divider controls-divider-orientation' }),
    selectControl('orientationSelect', 'ORIENTATION', 'PDF page orientation', [
      ['portrait', 'Portrait'],
      ['landscape', 'Landscape'],
    ]),
    h('span', { class: 'controls-divider controls-divider-margin' }),
    selectControl('marginSelect', 'MARGINS', 'PDF page margins', [
      ['comfortable', 'Comfortable'],
      ['compact', 'Compact'],
      ['wide', 'Wide'],
    ]),
    h('span', { class: 'preview-live-label' }, [h('span'), ' LIVE']),
  ]);
}

function selectControl(id, label, ariaLabel, options) {
  return h('label', { class: 'select-control' }, [
    h('span', null, label),
    h('select', { id, 'aria-label': ariaLabel },
      options.map(([value, name]) => h('option', { value }, name))
    ),
    chevronDown(),
  ]);
}

function buildPreviewStage() {
  return h('div', { class: 'preview-stage', id: 'previewStage' },
    h('article', {
      class: 'paper',
      id: 'paper',
      'data-theme': 'editorial',
      'data-margin': 'comfortable',
      'data-orientation': 'portrait',
      'aria-label': 'Rendered Markdown document',
    }, [
      h('div', { class: 'document-content', id: 'previewContent' }),
    ])
  );
}

function buildPreviewFooter() {
  return h('div', { class: 'preview-footer' }, [
    h('span', null, [pageIcon(), h('span', { id: 'paperStatus' }, 'A4 · Portrait')]),
    h('span', null, 'What you see is what you save'),
  ]);
}

// ---------------------------------------------------------------------------
// Icons (kept here so the tool is self-contained)
// ---------------------------------------------------------------------------

function openIcon() { return svg('M3.25 6.5a1.5 1.5 0 0 1 1.5-1.5h3.1l1.55 1.75h5.85a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-10.5a1.5 1.5 0 0 1-1.5-1.5v-8.25Z M10 9.25v4.5m-2-2 2 2 2-2'); }
function quoteIcon() { return svg('M8.2 5.1c-2.8.8-4.1 2.7-4.1 5.5v4.1h5.1v-5H6.8c.2-1.1.8-1.8 2-2.3l-.6-2.3Zm7.6 0c-2.8.8-4.1 2.7-4.1 5.5v4.1h5.1v-5h-2.4c.2-1.1.8-1.8 2-2.3l-.6-2.3Z'); }
function listIcon() { return svg('M4.5 5.5a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Zm0 4.5a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Zm0 4.5a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8ZM8 5.5h8m-8 4.5h8m-8 4.5h8'); }
function linkIcon() { return svg('M8 12.3 12 8.2m-5.1 6.1H5.7a3.2 3.2 0 0 1 0-6.4h3m2.6-2.2h3a3.2 3.2 0 1 1 0 6.4h-1.2'); }
function codeIcon() { return svg('m7 6-4 4 4 4m6-8 4 4-4 4m-1-10-2 12'); }
function trashIcon() { return svg('M5.5 6.5h9m-7.9 0 .5 9h5.8l.5-9M8 6.5V4.8h4v1.7m-3 2.2v4.8m2-4.8v4.8'); }
function downloadIcon() { return svg('M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3'); }
function checkIcon() { return svg('m3.5 8.2 2.8 2.8 6.2-6.4'); }
function dropArrowIcon() { return svg('M16 20.5V5.75m0 0-5.5 5.5M16 5.75l5.5 5.5 M7 19v5.25A2.75 2.75 0 0 0 9.75 27h12.5A2.75 2.75 0 0 0 25 24.25V19'); }
function dropIcon() { return svg('M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3'); }
function pageIcon() { return svg('M4.25 3.5h9.5v11h-9.5z M7 6.5h4m-4 2.5h4m-4 2.5h2.5'); }
function chevronDown() { return svg('m4.5 6.25 3.5 3.5 3.5-3.5'); }

function svg(d) {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' },
    h('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.35, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  );
}

// ---------------------------------------------------------------------------
// Behaviour (this is the heart of the tool — every event handler and
// the PDF export)
// ---------------------------------------------------------------------------

function wireMarkdownTool(root, { marked, DOMPurify, loadPdf }) {
  const input = root.querySelector('#markdownInput');
  const previewContent = root.querySelector('#previewContent');
  const paper = root.querySelector('#paper');
  const paperSelect = root.querySelector('#paperSelect');
  const themeSelect = root.querySelector('#themeSelect');
  const marginSelect = root.querySelector('#marginSelect');
  const orientationSelect = root.querySelector('#orientationSelect');
  const saveStatus = root.querySelector('#saveStatus');
  const saveStatusText = saveStatus.querySelector('span');
  const fileNameLabel = root.querySelector('#fileName');
  const wordCountLabel = root.querySelector('#wordCount');
  const lineNumbers = root.querySelector('#lineNumbers');
  const fileInput = root.querySelector('#fileInput');
  const editorPanel = root.querySelector('.editor-panel');
  const dropTarget = root.querySelector('#editorDropTarget');
  const openFileButton = root.querySelector('#openFileButton');
  const exportButton = root.querySelector('#exportButton');
  const paperStatus = root.querySelector('#paperStatus');

  const workspaceStorageKey = 'folio:workspace:v1';
  let currentFileName = 'morning-notes.md';
  let saveTimeout;
  let dragDepth = 0;
  let isExporting = false;

  marked.use({ gfm: true, breaks: false });

  function setSaveStatus(label, state = 'saved') {
    saveStatusText.textContent = label;
    saveStatus.dataset.state = state;
  }

  function readSavedWorkspace() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(workspaceStorageKey) || 'null');
      return saved && typeof saved.markdown === 'string' ? saved : null;
    } catch (error) {
      console.warn('Local draft could not be read:', error);
      return null;
    }
  }

  function saveWorkspaceNow() {
    window.clearTimeout(saveTimeout);
    saveTimeout = null;
    try {
      window.localStorage.setItem(workspaceStorageKey, JSON.stringify({
        markdown: input.value,
        fileName: currentFileName,
        theme: themeSelect.value,
        paper: paperSelect.value,
        margin: marginSelect.value,
        orientation: orientationSelect.value,
        updatedAt: Date.now(),
      }));
      setSaveStatus('Saved locally', 'saved');
      return true;
    } catch (error) {
      console.warn('Local draft could not be saved:', error);
      setSaveStatus('Local save unavailable', 'error');
      return false;
    }
  }

  function scheduleSave() {
    window.clearTimeout(saveTimeout);
    setSaveStatus('Saving…', 'saving');
    saveTimeout = window.setTimeout(saveWorkspaceNow, 450);
  }

  function renderMarkdown() {
    const source = input.value;
    const trimmed = source.trim();
    if (!trimmed) {
      previewContent.innerHTML = `
        <div class="empty-preview">
          <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
            <path d="M12 7.5h16l8 8V40H12V7.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            <path d="M28 8v8h8M18 23h12M18 28h12M18 33h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <strong>Your preview will appear here</strong>
          <span>Start typing in Markdown to bring your page to life.</span>
        </div>`;
    } else {
      try {
        const rawHtml = marked.parse(source);
        previewContent.innerHTML = DOMPurify.sanitize(rawHtml, {
          USE_PROFILES: { html: true },
          ADD_ATTR: ['target', 'rel'],
        });
        previewContent.querySelectorAll('a').forEach((link) => {
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
        });
      } catch (error) {
        previewContent.textContent = 'This Markdown could not be previewed. Please check the source and try again.';
        console.error('Markdown rendering failed:', error);
      }
    }

    const words = trimmed.match(/\S+/g)?.length ?? 0;
    wordCountLabel.textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    const numberOfLines = Math.max(1, source.split('\n').length);
    lineNumbers.textContent = Array.from({ length: numberOfLines }, (_, index) => index + 1).join('\n');
  }

  function setFileName(name) {
    currentFileName = name || 'untitled.md';
    fileNameLabel.textContent = currentFileName;
    fileNameLabel.title = currentFileName;
  }

  function setEditorValue(value, name = currentFileName) {
    input.value = value;
    setFileName(name);
    renderMarkdown();
    input.scrollTop = 0;
    input.scrollLeft = 0;
    input.setSelectionRange(0, 0);
    lineNumbers.scrollTop = 0;
  }

  function updatePaperSettings() {
    paper.dataset.theme = themeSelect.value;
    paper.dataset.margin = marginSelect.value;
    paper.dataset.orientation = orientationSelect.value;
    paperStatus.textContent = describePaper(paperSelect.value, orientationSelect.value);
    paper.setAttribute('aria-label', `${describePaper(paperSelect.value, orientationSelect.value).toLowerCase()} document preview`);
  }

  function selectFile(file) {
    if (!file) return;
    const isMarkdown = /\.(md|markdown)$/i.test(file.name) || file.type === 'text/markdown';
    if (!isMarkdown) {
      showToast('Please choose a Markdown file ending in .md or .markdown.', { error: true });
      return;
    }
    file.text().then((content) => {
      const name = file.name || 'untitled.md';
      setEditorValue(content, name);
      scheduleSave();
      showToast(`Loaded ${name}`);
    }).catch(() => {
      showToast('That file could not be opened. Please try another Markdown file.', { error: true });
    });
  }

  function normalizedPdfName(name) {
    const base = name.replace(/\.(md|markdown)$/i, '').trim() || 'document';
    const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-');
    return `${safe || 'document'}.pdf`;
  }

  function getPdfPageWidthPixels() {
    return paperWidthPx(paperSelect.value, orientationSelect.value);
  }

  function createPdfDocument() {
    const pageWidth = getPdfPageWidthPixels();
    const root = document.createElement('div');
    root.className = 'pdf-export-root';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = `position:absolute;top:0;left:-10000px;width:${pageWidth}px;overflow:visible;pointer-events:none;z-index:-1;`;

    const exportPaper = paper.cloneNode(true);
    exportPaper.removeAttribute('id');
    exportPaper.classList.remove('is-exporting');
    exportPaper.classList.add('pdf-export');
    exportPaper.style.width = `${pageWidth}px`;
    exportPaper.style.maxWidth = 'none';
    exportPaper.style.minHeight = '0';
    exportPaper.style.height = 'auto';
    exportPaper.style.margin = '0';
    exportPaper.style.overflow = 'visible';
    exportPaper.style.boxShadow = 'none';

    const m = marginPreset(marginSelect.value);
    exportPaper.style.padding = `${m.top}px ${m.right}px ${m.bottom}px`;

    const content = exportPaper.querySelector('.document-content');
    content?.removeAttribute('id');
    if (content) {
      content.style.fontSize = '14px';
      content.style.lineHeight = '1.72';
      content.querySelectorAll('h1').forEach((element) => { element.style.fontSize = '31px'; });
      content.querySelectorAll('h2').forEach((element) => { element.style.fontSize = '22px'; });
      content.querySelectorAll('h3').forEach((element) => { element.style.fontSize = '18px'; });
      content.querySelectorAll('h4').forEach((element) => { element.style.fontSize = '16px'; });
      content.querySelectorAll('table').forEach((element) => { element.style.fontSize = '11px'; });
      content.querySelectorAll('pre').forEach((element) => { element.style.overflow = 'visible'; });
    }

    root.append(exportPaper);
    document.body.append(root);
    return { root, exportPaper };
  }

  async function downloadPdf() {
    if (isExporting) return;
    if (!input.value.trim()) {
      showToast('Add some Markdown first, then your PDF is ready to go.', { error: true });
      input.focus();
      return;
    }

    isExporting = true;
    exportButton.disabled = true;
    exportButton.innerHTML = '<span class="export-spinner" aria-hidden="true"></span><span>Preparing PDF…</span>';
    let exportRoot;

    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const html2pdf = await loadPdf();
      const { root, exportPaper } = createPdfDocument();
      exportRoot = root;
      const targetPageWidth = getPdfPageWidthPixels();
      const options = {
        margin: 0,
        filename: normalizedPdfName(currentFileName),
        image: { type: 'jpeg', quality: 0.98 },
        enableLinks: true,
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: false,
          backgroundColor: null,
          logging: false,
          scrollY: 0,
          windowWidth: Math.max(window.innerWidth, targetPageWidth, 1024),
        },
        jsPDF: {
          unit: 'mm',
          format: paperSelect.value,
          orientation: orientationSelect.value,
          compress: true,
        },
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: ['blockquote', 'pre', 'table', 'img'],
        },
      };

      await html2pdf().set(options).from(exportPaper).save();
      showToast('Your PDF is ready — happy sharing!');
    } catch (error) {
      console.error('PDF export failed:', error);
      showToast('We couldn’t make that PDF. Please try again or use a shorter document.', { error: true });
    } finally {
      exportRoot?.remove();
      exportButton.disabled = false;
      exportButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Download PDF</span>';
      isExporting = false;
    }
  }

  function replaceSelection(before, after = before, emptyText = '') {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const selected = input.value.slice(start, end);
    const replacement = `${before}${selected || emptyText}${after}`;
    input.setRangeText(replacement, start, end, 'select');
    const selectionStart = start + before.length;
    const selectionEnd = selectionStart + (selected || emptyText).length;
    input.setSelectionRange(selectionStart, selectionEnd);
    input.focus();
    renderMarkdown();
    scheduleSave();
  }

  function prefixSelectedLines(prefix) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const lineStart = input.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    let lineEnd = input.value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = input.value.length;
    const block = input.value.slice(lineStart, lineEnd);
    const updated = block.split('\n').map((line) => `${prefix}${line}`).join('\n');
    input.setRangeText(updated, lineStart, lineEnd, 'select');
    input.setSelectionRange(lineStart, lineStart + updated.length);
    input.focus();
    renderMarkdown();
    scheduleSave();
  }

  openFileButton.addEventListener('click', () => fileInput.click());
  root.querySelector('#sampleButton').addEventListener('click', () => {
    setEditorValue(sampleMarkdown, 'morning-notes.md');
    scheduleSave();
    showToast('Sample Markdown loaded. Make it your own!');
  });
  root.querySelector('#clearButton').addEventListener('click', () => {
    setEditorValue('', 'untitled.md');
    scheduleSave();
    input.focus();
    showToast('Editor cleared. Start fresh whenever you’re ready.');
  });
  fileInput.addEventListener('change', (event) => {
    selectFile(event.target.files?.[0]);
    fileInput.value = '';
  });
  input.addEventListener('input', () => {
    renderMarkdown();
    scheduleSave();
  });
  input.addEventListener('scroll', () => { lineNumbers.scrollTop = input.scrollTop; }, { passive: true });
  exportButton.addEventListener('click', downloadPdf);
  [themeSelect, paperSelect, marginSelect, orientationSelect].forEach((control) => {
    control.addEventListener('change', () => {
      updatePaperSettings();
      scheduleSave();
    });
  });

  root.querySelectorAll('[data-format]').forEach((button) => {
    button.addEventListener('click', () => {
      switch (button.dataset.format) {
        case 'bold': replaceSelection('**', '**', 'bold text'); break;
        case 'italic': replaceSelection('*', '*', 'italic text'); break;
        case 'heading': prefixSelectedLines('## '); break;
        case 'quote': prefixSelectedLines('> '); break;
        case 'list': prefixSelectedLines('- '); break;
        case 'link': replaceSelection('[', '](https://example.com)', 'link text'); break;
        case 'code': replaceSelection('`', '`', 'code'); break;
        default: break;
      }
    });
  });

  input.addEventListener('keydown', (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key === 'Enter') {
      event.preventDefault();
      downloadPdf();
    } else if (modifier && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      replaceSelection('**', '**', 'bold text');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
      renderMarkdown();
      scheduleSave();
    }
  });

  function hasDraggedFiles(event) {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  document.addEventListener('dragenter', (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    editorPanel.classList.add('is-dragging');
  });
  document.addEventListener('dragover', (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasDraggedFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    const nextTarget = event.relatedTarget;
    const remainsInEditor = nextTarget instanceof Node && dropTarget.contains(nextTarget);
    if (dragDepth === 0 && !remainsInEditor) editorPanel.classList.remove('is-dragging');
  });
  document.addEventListener('drop', (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    editorPanel.classList.remove('is-dragging');
    selectFile(event.dataTransfer?.files?.[0]);
  });

  window.addEventListener('keydown', (event) => {
    if (currentFileName && event.target && (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT')) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      fileInput.click();
    } else if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault();
      const saved = saveWorkspaceNow();
      showToast(saved ? 'Draft saved on this device.' : 'Local saving is unavailable in this browser.', { error: !saved });
    }
  });

  window.addEventListener('beforeunload', () => {
    if (saveTimeout) saveWorkspaceNow();
  });

  const savedWorkspace = readSavedWorkspace();
  if (savedWorkspace) {
    const supportedThemes = ['editorial', 'modern', 'warm'];
    const supportedPapers = ['a4', 'letter', 'a5'];
    const supportedMargins = ['comfortable', 'compact', 'wide'];
    themeSelect.value = supportedThemes.includes(savedWorkspace.theme) ? savedWorkspace.theme : 'editorial';
    paperSelect.value = supportedPapers.includes(savedWorkspace.paper) ? savedWorkspace.paper : 'a4';
    marginSelect.value = supportedMargins.includes(savedWorkspace.margin) ? savedWorkspace.margin : 'comfortable';
    orientationSelect.value = savedWorkspace.orientation === 'landscape' ? 'landscape' : 'portrait';
    setEditorValue(savedWorkspace.markdown, savedWorkspace.fileName || 'untitled.md');
    setSaveStatus('Draft restored', 'saved');
  } else {
    setEditorValue(sampleMarkdown, currentFileName);
    setSaveStatus('Auto-save ready', 'saved');
  }
  updatePaperSettings();
}

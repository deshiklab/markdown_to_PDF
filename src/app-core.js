window.startFolioApp = function startFolioApp({ marked, DOMPurify, loadHtml2Pdf }) {
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

const input = document.querySelector('#markdownInput');
const previewContent = document.querySelector('#previewContent');
const paper = document.querySelector('#paper');
const paperSelect = document.querySelector('#paperSelect');
const themeSelect = document.querySelector('#themeSelect');
const marginSelect = document.querySelector('#marginSelect');
const orientationSelect = document.querySelector('#orientationSelect');
const saveStatus = document.querySelector('#saveStatus');
const saveStatusText = saveStatus.querySelector('span');
const fileNameLabel = document.querySelector('#fileName');
const wordCountLabel = document.querySelector('#wordCount');
const lineNumbers = document.querySelector('#lineNumbers');
const fileInput = document.querySelector('#fileInput');
const editorPanel = document.querySelector('.editor-panel');
const dropTarget = document.querySelector('#editorDropTarget');
const openFileButton = document.querySelector('#openFileButton');
const exportButton = document.querySelector('#exportButton');
const toast = document.querySelector('#toast');
const paperStatus = document.querySelector('#paperStatus');


function studioIsVisible() {
  const panel = document.querySelector('#panel-markdown');
  return !panel || !panel.hidden;
}

const workspaceStorageKey = 'folio:workspace:v1';
let currentFileName = 'morning-notes.md';
let toastTimeout;
let saveTimeout;
let dragDepth = 0;
let isExporting = false;

marked.use({
  gfm: true,
  breaks: false,
});

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

function showToast(message, isError = false) {
  if (window.folioToast) {
    window.folioToast(message, isError);
    return;
  }
  window.clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  toastTimeout = window.setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

/* The sheet belongs to the whole suite: page.js owns the paper size, the
   margins and the print scale, and the studio's own controls are a second face
   of the same store. Offline (no module support) the locals are the fallback. */
const pageApi = () => window.folioPage;

function paintPaperSize() {
  const setup = pageApi()?.page();
  if (setup) {
    paper.dataset.pageSize = setup.sheet;
    paper.dataset.orientation = setup.orientation;
    return setup;
  }
  paper.dataset.pageSize = paperSelect.value;
  paper.dataset.orientation = orientationSelect.value;
  return null;
}

function updatePaperSettings() {
  paper.dataset.theme = themeSelect.value;
  paper.dataset.margin = marginSelect.value;
  const setup = paintPaperSize();
  const label = pageApi()?.sheetMm(setup).label ?? { a4: 'A4', letter: 'US Letter', a5: 'A5' }[paperSelect.value] ?? 'A4';
  const orientation = (setup?.orientation ?? orientationSelect.value) === 'landscape' ? 'Landscape' : 'Portrait';
  paperStatus.textContent = `${label} · ${orientation}`;
  paper.setAttribute('aria-label', `${label} ${orientation.toLowerCase()} document preview`);
}

/** Mirror a change made in the shared strip back onto the studio's controls. */
function syncStudioControls(next) {
  if (!next) return;
  if (paperSelect.querySelector(`option[value="${next.sheet}"]`)) paperSelect.value = next.sheet;
  orientationSelect.value = next.orientation;
  if (next.preset !== 'custom' && marginSelect.querySelector(`option[value="${next.preset}"]`)) marginSelect.value = next.preset;
  updatePaperSettings();
}

window.folioSyncStudio = syncStudioControls;

function selectFile(file) {
  if (!file) return;
  const isMarkdown = /\.(md|markdown)$/i.test(file.name) || file.type === 'text/markdown';
  if (!isMarkdown) {
    showToast('Please choose a Markdown file ending in .md or .markdown.', true);
    return;
  }
  file.text().then((content) => {
    const name = file.name || 'untitled.md';
    setEditorValue(content, name);
    scheduleSave();
    showToast(`Loaded ${name}`);
  }).catch(() => {
    showToast('That file could not be opened. Please try another Markdown file.', true);
  });
}

function normalizedPdfName(name) {
  const base = name.replace(/\.(md|markdown)$/i, '').trim() || 'document';
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-');
  return `${safe || 'document'}.pdf`;
}

function getPdfPageWidthPixels() {
  const dimensions = {
    a4: { width: 210, height: 297 },
    letter: { width: 215.9, height: 279.4 },
    a5: { width: 148, height: 210 },
  };
  const page = dimensions[paperSelect.value] ?? dimensions.a4;
  const widthInMillimeters = orientationSelect.value === 'landscape' ? page.height : page.width;
  return Math.round(widthInMillimeters * (96 / 25.4));
}

function createPdfDocument() {
  const pageWidth = pageApi()?.sheetPx() ?? getPdfPageWidthPixels();
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

  exportPaper.style.padding = pageApi()?.marginCss(undefined, 0, 'px')
    ?? '58px 64px 70px';
  const setup = pageApi()?.page();
  if (setup) exportPaper.dataset.pageSize = setup.sheet;
  exportPaper.dataset.margin = marginSelect.value;

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
    showToast('Add some Markdown first, then your PDF is ready to go.', true);
    input.focus();
    return;
  }

  isExporting = true;
  exportButton.disabled = true;
  exportButton.innerHTML = '<span class="export-spinner" aria-hidden="true"></span><span>Preparing PDF…</span>';
  let exportRoot;

  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const html2pdf = await loadHtml2Pdf();
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
    showToast('We couldn’t make that PDF. Please try again or use a shorter document.', true);
  } finally {
    exportRoot?.remove();
    exportButton.disabled = false;
    exportButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg><span>Download PDF</span>';
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
document.querySelector('#sampleButton').addEventListener('click', () => {
  setEditorValue(sampleMarkdown, 'morning-notes.md');
  scheduleSave();
  showToast('Sample Markdown loaded. Make it your own!');
});
document.querySelector('#clearButton').addEventListener('click', () => {
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
    const api = pageApi();
    if (api) {
      if (control === paperSelect) api.setPage({ sheet: paperSelect.value });
      else if (control === orientationSelect) api.setPage({ orientation: orientationSelect.value });
      else if (control === marginSelect) api.setPage({ preset: marginSelect.value });
    }
    updatePaperSettings();
    scheduleSave();
  });
});

document.querySelectorAll('[data-format]').forEach((button) => {
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
  if (!hasDraggedFiles(event) || !studioIsVisible()) return;
  event.preventDefault();
  dragDepth += 1;
  editorPanel.classList.add('is-dragging');
});
document.addEventListener('dragover', (event) => {
  if (!hasDraggedFiles(event) || !studioIsVisible()) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (event) => {
  if (!hasDraggedFiles(event) || !studioIsVisible()) return;
  dragDepth = Math.max(0, dragDepth - 1);
  const nextTarget = event.relatedTarget;
  const remainsInEditor = nextTarget instanceof Node && dropTarget.contains(nextTarget);
  if (dragDepth === 0 && !remainsInEditor) editorPanel.classList.remove('is-dragging');
});
document.addEventListener('drop', (event) => {
  if (!hasDraggedFiles(event) || !studioIsVisible()) return;
  event.preventDefault();
  dragDepth = 0;
  editorPanel.classList.remove('is-dragging');
  selectFile(event.dataTransfer?.files?.[0]);
});

window.addEventListener('keydown', (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (!studioIsVisible()) return;
  if (modifier && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    fileInput.click();
  } else if (modifier && event.key.toLowerCase() === 's') {
    event.preventDefault();
    const saved = saveWorkspaceNow();
    showToast(saved ? 'Draft saved on this device.' : 'Local saving is unavailable in this browser.', !saved);
  }
});

window.addEventListener('beforeunload', () => {
  if (saveTimeout) saveWorkspaceNow();
});

const savedWorkspace = readSavedWorkspace();
if (savedWorkspace) {
  const supportedThemes = ['editorial', 'modern', 'warm'];
  const supportedPapers = ['a4', 'letter', 'a5'];
  const supportedMargins = ['comfortable', 'compact', 'wide', 'book', 'none'];
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
/* The shared strip can change the sheet from any tab, so follow it — and seed
   it once from an older saved workspace so nobody's settings move under them. */
const pageApiAtBoot = window.folioPage;
if (pageApiAtBoot) {
  if (savedWorkspace && !window.localStorage.getItem('folio:page:v1')) {
    const supportedSheets = ['a4', 'letter', 'a5'];
    pageApiAtBoot.setPage({
      sheet: supportedSheets.includes(savedWorkspace.paper) ? savedWorkspace.paper : 'a4',
      orientation: savedWorkspace.orientation === 'landscape' ? 'landscape' : 'portrait',
      preset: ['comfortable', 'compact', 'wide', 'book', 'none'].includes(savedWorkspace.margin) ? savedWorkspace.margin : 'comfortable',
    });
  }
  pageApiAtBoot.onPage(syncStudioControls);
  syncStudioControls(pageApiAtBoot.page());
}

document.querySelector('#printButton')?.addEventListener('click', () => pageApi()?.printSheet());

updatePaperSettings();

};

/* One shared "paper" renderer, so the Translate and Portfolio tabs print the
   same looking document as the Markdown studio. */
import { escapeHtml, loadHtml2PdfBridge, toast } from './lib.js';

export const PAGE_SIZES = {
  a4: { label: 'A4', width: 210, height: 297 },
  letter: { label: 'US Letter', width: 215.9, height: 279.4 },
  a5: { label: 'A5', width: 148, height: 210 },
  a4l: { label: 'A4 landscape', width: 297, height: 210, orientation: 'landscape' },
  square: { label: 'Square 1:1', width: 210, height: 210 },
};

/* Mirrors the --paper-margin values in styles.css, in pixels at 96 dpi. */
const MARGIN_PX = {
  tight: '40px',
  comfortable: '64px',
  wide: '94px',
  none: '18px',
};

export function pagePixelSize(pageSize = 'a4') {
  const page = PAGE_SIZES[pageSize] ?? PAGE_SIZES.a4;
  return Math.round(page.width * (96 / 25.4));
}

/** A paper sheet detached from the page — used for previews and for exports. */
export function buildPaperSheet({
  pageSize = 'a4',
  margin = 'comfortable',
  style = 'editorial',
  className = 'pdf-export-page',
} = {}) {
  const sheet = document.createElement('article');
  sheet.className = `paper ${style}-paper ${className}`;
  sheet.dataset.pageSize = pageSize;
  sheet.setAttribute('aria-hidden', 'true');
  const width = pagePixelSize(pageSize);
  sheet.style.cssText = `width:${width}px;max-width:none;min-height:0;height:auto;margin:0;box-shadow:none;overflow:visible;border:1px solid #e5e0d6;border-radius:2px;padding:${MARGIN_PX[margin] ?? MARGIN_PX.comfortable};`;
  return sheet;
}

/**
 * Render HTML (or plain text) onto a full-width paper sheet and save it as a
 * PDF with html2pdf. Sanitised input only: callers pass either trusted markup
 * or the plain-text fallback.
 */
export async function exportHtmlAsPdf({
  html,
  text = '',
  filename = 'folio-document.pdf',
  style = 'editorial',
  margin = 'comfortable',
  pageSize = 'a4',
  scale = 2,
  onStatus,
} = {}) {
  if (!html && !text) throw new Error('Nothing to render.');
  const html2pdf = await loadHtml2PdfBridge();
  const pageWidth = pagePixelSize(pageSize);

  const stage = document.createElement('div');
  stage.className = 'pdf-export-root';
  stage.style.cssText = `position:absolute;top:0;left:-10000px;width:${pageWidth}px;overflow:visible;pointer-events:none;z-index:-1;`;

  const sheet = buildPaperSheet({ pageSize, margin, style });
  const content = document.createElement('div');
  content.className = 'document-content pdf-document';
  if (html) content.innerHTML = html;
  else {
    content.innerHTML = String(text)
      .split(/\n{2,}/)
      .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`)
      .join('');
  }
  sheet.append(content);
  stage.append(sheet);
  document.body.append(stage);

  onStatus?.('Laying out the page…');
  if (document.fonts?.ready) await document.fonts.ready;

  const format = PAGE_SIZES[pageSize] ?? PAGE_SIZES.a4;
  try {
    await html2pdf()
      .set({
        margin: 0,
        filename,
        image: { type: 'jpeg', quality: 0.97 },
        enableLinks: true,
        html2canvas: {
          scale,
          useCORS: true,
          allowTaint: false,
          backgroundColor: null,
          logging: false,
          scrollY: 0,
          windowWidth: Math.max(window.innerWidth, pageWidth, 1024),
        },
        jsPDF: {
          unit: 'mm',
          format: [format.width, format.height],
          orientation: format.orientation ?? 'portrait',
          compress: true,
        },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['blockquote', 'pre', 'table', 'img', 'figure'] },
      })
      .from(sheet)
      .save();
    toast('Saved — your file is in the downloads folder.');
  } finally {
    stage.remove();
  }
}

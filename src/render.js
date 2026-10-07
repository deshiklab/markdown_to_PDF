/* One shared "paper" renderer, so the Translate and Portfolio tabs print the
   same looking document as the Markdown studio. */
import { escapeHtml, loadHtml2PdfBridge, toast } from './lib.js';
import { marginCss, page, sheetMm } from './page.js';

/* Kept for the tools that name a paper directly (Portfolio's square, Convert's
   sizes); the sheet itself now comes from the shared page setup in page.js. */
export const PAGE_SIZES = {
  a4: { label: 'A4', width: 210, height: 297 },
  letter: { label: 'US Letter', width: 215.9, height: 279.4 },
  legal: { label: 'US Legal', width: 215.9, height: 355.6 },
  a5: { label: 'A5', width: 148, height: 210 },
  a4l: { label: 'A4 landscape', width: 297, height: 210, orientation: 'landscape' },
  square: { label: 'Square 1:1', width: 210, height: 210 },
  postcard: { label: 'Postcard 6×4in', width: 152.4, height: 101.6 },
};

/* Older callers passed a named margin; the shared setup stores millimetres, so
   the names are read as the presets they always were. */
const MARGIN_PRESETS = {
  tight: { top: 10, right: 10, bottom: 10, left: 10, gutter: 0 },
  compact: { top: 12, right: 11, bottom: 12, left: 11, gutter: 0 },
  comfortable: { top: 16, right: 14, bottom: 16, left: 14, gutter: 0 },
  wide: { top: 22, right: 19, bottom: 22, left: 19, gutter: 0 },
  none: { top: 4, right: 4, bottom: 4, left: 4, gutter: 0 },
};

/** The page setup a tool is exporting with: the shared one, or a legacy override. */
export function resolvePage({ pageSize, orientation, margin } = {}) {
  const shared = page();
  const patch = {};
  if (pageSize && PAGE_SIZES[pageSize]) patch.sheet = pageSize;
  if (orientation === 'portrait' || orientation === 'landscape') patch.orientation = orientation;
  if (PAGE_SIZES[pageSize]?.orientation === 'landscape') patch.orientation = 'landscape';
  if (margin && MARGIN_PRESETS[margin]) {
    Object.assign(patch, MARGIN_PRESETS[margin], { preset: 'custom' });
  }
  return Object.keys(patch).length ? { ...shared, ...patch, margins: { ...shared.margins, ...(MARGIN_PRESETS[margin] ?? {}) } } : shared;
}

/** Width of a sheet in CSS pixels (96 dpi). `spec` may be a size key or a setup. */
export function pagePixelSize(spec = 'a4') {
  if (spec && typeof spec === 'object') return Math.round(sheetMm(spec).width * (96 / 25.4));
  const sheet = PAGE_SIZES[spec] ?? PAGE_SIZES.a4;
  return Math.round(sheet.width * (96 / 25.4));
}

/** A paper sheet detached from the page — used for previews and for exports. */
export function buildPaperSheet({ pageSize, orientation, margin, style = 'editorial', className = 'pdf-export-page', setup } = {}) {
  const spec = setup ?? resolvePage({ pageSize, orientation, margin });
  const sheet = document.createElement('article');
  sheet.className = `paper ${style}-paper ${className}`;
  sheet.dataset.pageSize = spec.sheet;
  sheet.setAttribute('aria-hidden', 'true');
  const width = pagePixelSize(spec);
  sheet.style.cssText = `width:${width}px;max-width:none;min-height:0;height:auto;margin:0;box-shadow:none;overflow:visible;border:1px solid #e5e0d6;border-radius:2px;padding:${marginCss(spec, 0, 'px')};`;
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
  margin,
  pageSize,
  orientation,
  scale = 2,
  onStatus,
} = {}) {
  if (!html && !text) throw new Error('Nothing to render.');
  const html2pdf = await loadHtml2PdfBridge();
  const spec = resolvePage({ pageSize, orientation, margin });
  const pageWidth = pagePixelSize(spec);

  const stage = document.createElement('div');
  stage.className = 'pdf-export-root';
  stage.style.cssText = `position:absolute;top:0;left:-10000px;width:${pageWidth}px;overflow:visible;pointer-events:none;z-index:-1;`;

  const sheet = buildPaperSheet({ setup: spec, style });
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

  const format = sheetMm(spec);
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

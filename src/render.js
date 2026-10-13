// Shared paper math for everything that turns HTML or a canvas composition
// into a printable page. Both the Markdown → PDF editor and the Photo
// Portfolio book use this so a "comfortable / compact / wide" margin
// preset or an A4 / US Letter / A5 paper size means the same thing in
// every tool.

export const PAPER_DIMENSIONS_MM = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
  a5: { width: 148, height: 210 },
  a6: { width: 105, height: 148 },
  b5: { width: 176, height: 250 },
  // Square formats for the photo portfolio.
  s210: { width: 210, height: 210 },
  s250: { width: 250, height: 250 },
};

export const MM_PER_INCH = 25.4;
export const PX_PER_INCH = 96;

/**
 * Return the page width and height in millimetres for a given paper size
 * and orientation.
 */
export function paperDimensions(paper, orientation = 'portrait') {
  const dims = PAPER_DIMENSIONS_MM[paper] || PAPER_DIMENSIONS_MM.a4;
  if (orientation === 'landscape') {
    return { width: dims.height, height: dims.width };
  }
  return { width: dims.width, height: dims.height };
}

/**
 * Convert a millimetre length into CSS pixels at 96 DPI.
 */
export function mmToPx(mm) {
  return mm * (PX_PER_INCH / MM_PER_INCH);
}

/**
 * Return the page width in pixels for the current settings. Used by the
 * Markdown export (which renders into a fixed-width off-screen element)
 * and by the Portfolio's html2pdf target.
 */
export function paperWidthPx(paper, orientation = 'portrait') {
  const { width } = paperDimensions(paper, orientation);
  return Math.round(mmToPx(width));
}

/**
 * Return the page height in pixels for the current settings.
 */
export function paperHeightPx(paper, orientation = 'portrait') {
  const { height } = paperDimensions(paper, orientation);
  return Math.round(mmToPx(height));
}

/**
 * Margin presets in pixels. These are matched in `paddingByMargin` in
 * the Markdown exporter and re-used by the Portfolio so the two tools
 * stay consistent if we tweak them.
 */
export const MARGIN_PRESETS_PX = {
  comfortable: { top: 58, right: 64, bottom: 70, left: 64 },
  compact: { top: 42, right: 48, bottom: 54, left: 48 },
  wide: { top: 72, right: 78, bottom: 82, left: 78 },
};

export function marginPreset(name) {
  return MARGIN_PRESETS_PX[name] || MARGIN_PRESETS_PX.comfortable;
}

/**
 * Compute the safe content area in pixels for a paper + orientation +
 * margin combo. Useful for the photo book when a plate has to fit
 * inside the print region.
 */
export function contentArea(paper, orientation, margin) {
  const dims = paperDimensions(paper, orientation);
  const m = marginPreset(margin);
  return {
    width: mmToPx(dims.width) - m.left - m.right,
    height: mmToPx(dims.height) - m.top - m.bottom,
    offsetX: m.left,
    offsetY: m.top,
  };
}

/**
 * Format a paper size for the status line ("A4 · Portrait" etc.).
 */
export const PAPER_LABELS = {
  a4: 'A4',
  letter: 'US Letter',
  a5: 'A5',
  a6: 'A6',
  b5: 'B5',
  s210: 'Square 210',
  s250: 'Square 250',
};

export function describePaper(paper, orientation) {
  const label = PAPER_LABELS[paper] || paper.toUpperCase();
  return `${label} · ${orientation === 'landscape' ? 'Landscape' : 'Portrait'}`;
}

/**
 * Convert a `display-space` coordinate (a percentage of the rendered page
 * box, or a pixel offset inside it) into PDF user space, accounting for
 * the page's `/Rotate` value. The Sign tool and Finish's overlay handles
 * both rely on this.
 */
export function displayToPdf(coord, page, viewport) {
  const { width: viewW, height: viewH } = viewport;
  const { width: pageW, height: pageH } = page.getSize();
  const rotate = page.getRotation().angle || 0;
  // PDF coordinate origin is bottom-left; the viewport origin is top-left.
  // For rotation 0 the mapping is: xPdf = (x / viewW) * pageW, yPdf = pageH - (y / viewH) * pageH.
  // For other rotations we rotate the mapped point about the page centre.
  const xRatio = coord.x / viewW;
  const yRatio = coord.y / viewH;
  let xPdf = xRatio * pageW;
  let yPdf = pageH - yRatio * pageH;
  if (rotate === 90) {
    const tmp = xPdf;
    xPdf = yPdf;
    yPdf = pageW - tmp;
  } else if (rotate === 180) {
    xPdf = pageW - xPdf;
    yPdf = pageH - yPdf;
  } else if (rotate === 270) {
    const tmp = xPdf;
    xPdf = pageH - yPdf;
    yPdf = tmp;
  }
  return { x: xPdf, y: yPdf };
}

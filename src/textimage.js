/* Text as pixels, for the places a PDF font can't go.

   pdf-lib's standard fonts cover Latin-1 and little else, so Bengali, Arabic,
   Devanagari, Thai, CJK and friends have to be drawn as pictures. This module
   lays a paragraph out the way the browser would — wrapping, alignment, RTL,
   auto-shrinking to fit a box — and hands back either a canvas to draw onto the
   screen or PNG bytes to drop into a page. Sign uses it for marks, Translate
   uses it for every block it paints back onto a page. */

const PT_PER_PX = 0.75; // a "px" here is a CSS pixel; 1 pdf point = 1/72in

export function fontString(size, family = 'DM Sans', weight = 400, style = 'normal') {
  const stack = /^[\w\s"',-]+$/.test(family) ? family : 'DM Sans, sans-serif';
  return `${style} ${weight} ${size}px ${stack}, sans-serif`;
}

/** Latin-1-ish text is safe for pdf-lib's standard fonts; everything else is not. */
export function isLatinText(text = '') {
  return !/[^\u0000-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2026\u2022\u20ac]/.test(String(text));
}

export function isRtlText(text = '') {
  const rtl = /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u0780-\u07bf\ufb1d-\ufdff\ufe70-\ufeff]/;
  const strong = String(text).match(/[A-Za-z\u0590-\u08ff\u4e00-\u9fff]/g) ?? [];
  let rtlCount = 0;
  let ltrCount = 0;
  for (const char of strong) (rtl.test(char) ? rtlCount++ : ltrCount++);
  return rtlCount > ltrCount;
}

/** Break a run of text so it fits `maxWidth`, honouring spaces and CJK breaks. */
export function wrapLines(ctx, text, maxWidth, { breakAnywhere = false } = {}) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return [];
  const fits = (candidate) => ctx.measureText(candidate).width <= maxWidth;
  const lines = [];
  const cjk = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u0e00-\u0e7f]/;
  let current = '';
  const push = () => {
    if (current.trim()) lines.push(current.trim());
    current = '';
  };
  const words = value.split(' ');
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (fits(next) || !current) {
      current = next;
      // a single word wider than the box: chop it up rather than overflow
      while (!fits(current) && current.length > 1) {
        let cut = current.length - 1;
        if (breakAnywhere || cjk.test(current)) cut = Math.max(1, Math.min(cut, Math.floor(current.length * 0.9)));
        else {
          const match = current.match(/[\s-]/g);
          if (match && current.lastIndexOf('-') > 0) cut = current.lastIndexOf('-') + 1;
        }
        lines.push(current.slice(0, cut).trim());
        current = current.slice(cut);
      }
      continue;
    }
    if (cjk.test(word) || breakAnywhere) {
      let rest = ` ${word}`;
      while (rest && !fits(current + rest)) {
        let take = rest.length;
        while (take > 1 && !fits(current + rest.slice(0, take))) take -= 1;
        current += rest.slice(0, take);
        push();
        rest = rest.slice(take);
      }
      current += rest;
      continue;
    }
    push();
    current = word;
  }
  push();
  return lines.length ? lines : [value];
}

/**
 * Lay a paragraph inside a box. Returns positioned lines in box-local pixels.
 * `fontSize` comes back as the size that was actually used — the layout shrinks
 * to fit when `maxHeight` is tight, which is what keeps a translation on the
 * line it belongs to.
 */
export function layoutParagraph({
  measure,
  text,
  maxWidth,
  maxHeight = Infinity,
  fontSize = 12,
  lineHeight = 1.25,
  align = 'left',
  rtl = false,
  minScale = 0.62,
  allowOverflow = false,
}) {
  const width = Math.max(8, maxWidth);
  const attempt = (size) => {
    measure.fontSize = size;
    const lines = wrapLines(measure, text, width);
    return { size, lines, height: lines.length * size * lineHeight };
  };
  let best = attempt(fontSize);
  if (best.height > maxHeight && Number.isFinite(maxHeight)) {
    const floor = fontSize * minScale;
    let low = floor;
    let high = fontSize;
    for (let i = 0; i < 12; i += 1) {
      const mid = (low + high) / 2;
      const tryLayout = attempt(mid);
      if (tryLayout.height <= maxHeight) low = mid;
      else high = mid;
    }
    best = attempt(low);
  }
  const lines = best.lines.map((line) => {
    measure.fontSize = best.size;
    const lineWidth = measure.measureText(line).width;
    let x = 0;
    if (align === 'center') x = (width - lineWidth) / 2;
    else if (align === 'right' || (align === 'start' && rtl)) x = width - lineWidth;
    else if (align === 'justify' && rtl) x = width - lineWidth;
    return { text: line, x: Math.max(0, x), width: lineWidth };
  });
  return {
    fontSize: best.size,
    lineHeight,
    rtl,
    align,
    family: measure.family,
    weight: measure.weight,
    style: measure.style,
    width,
    height: lines.length * best.size * lineHeight,
    lines,
    overflow: best.height > maxHeight && Number.isFinite(maxHeight),
    allowOverflow,
  };
}

/** A stand-in for a 2D context that only knows how to measure text. */
export function measureContext(family = 'DM Sans', weight = 400, style = 'normal') {
  const ctx = document.createElement('canvas').getContext('2d');
  return {
    fontSize: 12,
    family,
    weight,
    style,
    measureText(text) {
      ctx.font = fontString(this.fontSize, this.family, this.weight, this.style);
      return ctx.measureText(text);
    },
  };
}

/** Draw a laid-out paragraph onto a 2D context at (x, y) — y is the top edge. */
export function paintParagraph(ctx, layout, { x = 0, y = 0, color = '#1c211d' } = {}) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.direction = layout.rtl ? 'rtl' : 'ltr';
  ctx.font = fontString(layout.fontSize, layout.family, layout.weight, layout.style);
  layout.lines.forEach((line, index) => {
    const lineY = y + index * layout.fontSize * layout.lineHeight;
    const lineX = layout.rtl ? x + layout.width - line.x - line.width : x + line.x;
    ctx.fillText(line.text, lineX, lineY);
  });
  ctx.restore();
}

/**
 * Render a paragraph into its own canvas — the picture we hand to a PDF.
 * Returns { canvas, bytes(), width, height, layout } in CSS pixels.
 */
export function paragraphCanvas({
  text,
  width,
  height,
  fontSize = 12,
  lineHeight = 1.25,
  align = 'left',
  rtl = false,
  family = 'DM Sans',
  weight = 400,
  style = 'normal',
  color = '#1c211d',
  pixelRatio = 3,
  minScale = 0.62,
}) {
  const measure = measureContext(family, weight, style);
  const layout = layoutParagraph({
    measure,
    text,
    maxWidth: width,
    maxHeight: height,
    fontSize,
    lineHeight,
    align,
    rtl,
    minScale,
    allowOverflow: true,
  });
  const drawWidth = Math.max(4, Math.ceil(width + 2));
  const drawHeight = Math.max(4, Math.ceil(layout.height + 2));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(drawWidth * pixelRatio);
  canvas.height = Math.ceil(drawHeight * pixelRatio);
  const ctx = canvas.getContext('2d');
  ctx.scale(pixelRatio, pixelRatio);
  paintParagraph(ctx, layout, { x: 0, y: 0, color });
  return {
    canvas,
    width: drawWidth,
    height: drawHeight,
    layout,
    bytes: (type = 'image/png') => canvasBytes(canvas, type),
  };
}

/** PNG (or JPEG) bytes from a canvas, ready for pdf-lib's embedPng/embedJpg. */
export function canvasBytes(canvas, type = 'image/png', quality = 0.94) {
  const url = type === 'image/jpeg' ? canvas.toDataURL(type, quality) : canvas.toDataURL(type);
  return dataUrlToBytes(url);
}

export function dataUrlToBytes(dataUrl) {
  const [head, body] = String(dataUrl).split(',');
  if (!body) return null;
  const binary = /;base64/i.test(head) ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function pxToPt(px) {
  return px * PT_PER_PX;
}

export function ptToPx(pt) {
  return pt / PT_PER_PX;
}

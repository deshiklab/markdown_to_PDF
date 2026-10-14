/* Letterhead & invoice — generate a single-page branded letterhead
   from a few fields and an optional logo. Foundation: the letterhead
   generator. Invoices and an "overlay on an existing PDF" mode are
   later commits. */

import {
  bytes,
  debounce,
  downloadBlob,
  escapeHtml,
  loadPdfLib,
  pickFiles,
  q,
  safeFileName,
  store,
  toast,
} from '../lib.js';
import { marginsMm, page, printButton, sheetMm } from '../page.js';

const LAYOUTS = [
  { id: 'classic', label: 'Classic', note: 'Header band, body, footer band.' },
  { id: 'minimal', label: 'Minimal', note: 'Top-left mark, bottom rule.' },
  { id: 'modern', label: 'Modern', note: 'Right-aligned mark, side rule.' },
];

const downloadIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8m0 0 3-3m-3 3-3-3M4.5 12.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>';

const defaults = {
  layout: 'classic',
  companyName: 'Acme Studio',
  tagline: 'Brand, type & motion',
  address: '12 High Street\nLondon EC1A 1AA\nUnited Kingdom',
  phone: '+44 20 7946 0958',
  email: 'hello@acme.studio',
  website: 'acme.studio',
  accent: '#315f50',
  logoSize: 60, /* PDF points, the height of the logo block */
  saveName: 'folio-letterhead',
};

const prefs = store('letterhead:v1', defaults);
const state = {
  form: { ...prefs.read() },
  logo: null, /* { bytes, type, width, height } once an image is loaded */
  busy: false,
};

export function start(root) {
  root.innerHTML = layout();
  wireForm(root);
  wireLogo(root);
  wireExport(root);
  paintForm(root);
  paintPreview(root);
  return () => {};
}

/* ------------------------------------------------------------------ ui ---- */
function layout() {
  return `
<div class="lh-shell" id="lhShell">
  <section class="panel lh-side" aria-labelledby="lh-side-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index">01</span>
        <div><h3 id="lh-side-title">Identity</h3><p>Company details, logo, accent</p></div>
      </div>
      <div class="panel-header-actions">${printButton()}</div>
    </div>
    <div class="editor-footer lh-footer">
      <span id="lhStatus">Pick a layout, fill the form, export.</span>
    </div>
  </section>

  <section class="panel lh-main" aria-labelledby="lh-main-title">
    <div class="panel-header">
      <div class="panel-title-group">
        <span class="panel-index panel-index-green">02</span>
        <div><h3 id="lh-main-title">Letterhead</h3><p><span class="live-dot"></span> Preview updates as you type</p></div>
      </div>
      <div class="panel-header-actions">
        <button class="button button-export" type="button" id="lhExport">${downloadIcon}<span>Download letterhead PDF</span></button>
      </div>
    </div>
    <div class="lh-body">
      <div class="lh-grid">
        <label class="field"><span class="field-label">Layout</span>
          <select class="text-input" id="lhLayout">
            ${LAYOUTS.map((l) => `<option value="${l.id}">${escapeHtml(l.label)} — ${escapeHtml(l.note)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span class="field-label">Accent colour</span>
          <span class="colour-wrap"><input class="colour-input" id="lhAccent" type="color" value="${escapeHtml(state.form.accent)}" /><code id="lhAccentCode">${escapeHtml(state.form.accent)}</code></span>
        </label>
      </div>
      <div class="lh-grid">
        <label class="field grow"><span class="field-label">Company name</span>
          <input class="text-input" id="lhCompany" type="text" value="${escapeHtml(state.form.companyName)}" autocomplete="organization" />
        </label>
        <label class="field grow"><span class="field-label">Tagline</span>
          <input class="text-input" id="lhTagline" type="text" value="${escapeHtml(state.form.tagline)}" placeholder="optional" />
        </label>
      </div>
      <label class="field"><span class="field-label">Address</span>
        <textarea class="text-input lh-textarea" id="lhAddress" rows="3" placeholder="Street, city, postcode, country">${escapeHtml(state.form.address)}</textarea>
      </label>
      <div class="lh-grid">
        <label class="field"><span class="field-label">Phone</span>
          <input class="text-input" id="lhPhone" type="text" value="${escapeHtml(state.form.phone)}" placeholder="optional" />
        </label>
        <label class="field"><span class="field-label">Email</span>
          <input class="text-input" id="lhEmail" type="text" value="${escapeHtml(state.form.email)}" placeholder="optional" />
        </label>
        <label class="field"><span class="field-label">Website</span>
          <input class="text-input" id="lhWebsite" type="text" value="${escapeHtml(state.form.website)}" placeholder="optional" />
        </label>
      </div>
      <div class="lh-grid">
        <div class="field grow">
          <span class="field-label">Logo (PNG or JPG)</span>
          <div class="lh-logo-row">
            <button class="button button-light" type="button" id="lhPickLogo">Choose image</button>
            <span class="lh-hint" id="lhLogoHint">No image — the mark is set in plain type.</span>
          </div>
        </div>
        <label class="field"><span class="field-label">Logo size (pt)</span>
          <div class="range-row">
            <input class="range-input" id="lhLogoSize" type="range" min="24" max="160" step="2" value="${state.form.logoSize}" />
            <output class="range-readout" id="lhLogoSizeOut">${state.form.logoSize} pt</output>
          </div>
        </label>
      </div>
      <label class="field"><span class="field-label">Save as</span>
        <input class="text-input" id="lhSaveName" type="text" value="${escapeHtml(state.form.saveName)}" />
      </label>
    </div>
    <div class="lh-preview-wrap" id="lhPreviewWrap">
      <div class="lh-preview" id="lhPreview" aria-label="Letterhead preview"></div>
    </div>
  </section>
</div>`;
}

function wireForm(root) {
  const save = debounce(() => prefs.write(state.form), 200);
  const fields = [
    ['#lhLayout', 'layout', (v) => v],
    ['#lhCompany', 'companyName'],
    ['#lhTagline', 'tagline'],
    ['#lhAddress', 'address'],
    ['#lhPhone', 'phone'],
    ['#lhEmail', 'email'],
    ['#lhWebsite', 'website'],
    ['#lhAccent', 'accent'],
    ['#lhSaveName', 'saveName'],
  ];
  for (const [id, key, cast] of fields) {
    const node = q(id, root);
    if (!node) continue;
    node.addEventListener('input', () => {
      state.form[key] = cast ? cast(node.value) : node.value;
      if (key === 'accent') {
        const code = q('#lhAccentCode', root);
        if (code) code.textContent = node.value;
      }
      save();
      paintPreview(root);
    });
  }
  const logoSize = q('#lhLogoSize', root);
  const logoSizeOut = q('#lhLogoSizeOut', root);
  if (logoSize) {
    logoSize.addEventListener('input', () => {
      state.form.logoSize = Number(logoSize.value);
      if (logoSizeOut) logoSizeOut.textContent = `${state.form.logoSize} pt`;
      save();
      paintPreview(root);
    });
  }
}

function wireLogo(root) {
  const button = q('#lhPickLogo', root);
  const hint = q('#lhLogoHint', root);
  const open = () => pickFiles({ accept: 'image/png,image/jpeg,image/*', multiple: false })
    .then((files) => {
      const file = files && files[0];
      if (!file) return;
      if (!/^image\/(png|jpe?g)$/i.test(file.type)) {
        toast('Letterhead accepts PNG or JPG logos.', true);
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        const bytes = new Uint8Array(reader.result);
        try {
          const dims = await readImageDimensions(bytes, file.type);
          state.logo = { bytes, type: file.type, width: dims.width, height: dims.height, name: file.name };
          if (hint) hint.textContent = `${file.name} — ${state.logo.width}×${state.logo.height}`;
          paintPreview(root);
        } catch (err) {
          console.error('letterhead: could not read logo', err);
          toast('That image could not be read.', true);
        }
      };
      reader.onerror = () => toast('That image could not be read.', true);
      reader.readAsArrayBuffer(file);
    });
  button?.addEventListener('click', open);
}

/* Read the pixel dimensions of a PNG or JPG. The PNG header carries
   width and height in bytes 16-23; JPGs need a quick scan for the
   SOFn marker. */
async function readImageDimensions(bytes, type) {
  if (type === 'image/png' && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return { width, height };
  }
  /* For JPG we read the canvas in the browser; the helper injected
     from main.js (rasterize) does the same. We just need the natural
     size. */
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image load failed'));
      el.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function wireExport(root) {
  q('#lhExport', root)?.addEventListener('click', () => exportLetterhead(root));
}

/* ---------------------------------------------------------------- preview ---- */
/* Render the letterhead as HTML in the preview area. The CSS is set
   up to mimic the PDF rendering exactly: same font, same widths in
   millimetres, same accent colour. */
function paintPreview(root) {
  const target = q('#lhPreview', root);
  if (!target) return;
  const setup = page();
  const sheet = sheetMm(setup);
  const margins = marginsMm(setup);
  const css = previewCss({ ...sheet, margins }, state.form);
  target.style.width = `${Math.min(720, sheet.width * 2.4)}px`;
  target.style.height = `${Math.min(720, sheet.width * 2.4) * (sheet.height / sheet.width)}px`;
  target.innerHTML = `<style>${css}</style><div class="lh-page">${renderLetterheadHtml(state)}</div>`;
}

function previewCss(sheet, form) {
  /* The preview is rendered at a fixed CSS scale: 1mm = 2.4px gives a
     595-ish px preview for A4 portrait (210mm × 2.4 = 504px), and
     the page proportions are preserved. */
  const px = (mm) => `${mm * 2.4}px`;
  const ptToPx = (pt) => `${pt * 2.4 * 0.3528}px`;
  return `
    .lh-page { width: ${px(sheet.width)}; height: ${px(sheet.height)}; padding: ${px(sheet.margins.top)} ${px(sheet.margins.right)} ${px(sheet.margins.bottom)} ${px(sheet.margins.left)}; box-sizing: border-box; background: #fff; color: #1f2c1e; font-family: 'Charter', 'Georgia', 'Times New Roman', serif; box-shadow: 0 6px 24px rgba(0,0,0,0.08); display: flex; flex-direction: column; }
    .lh-masthead { display: flex; align-items: center; gap: 14px; padding-bottom: 14px; border-bottom: 1px solid #d3d8ce; }
    .lh-masthead.is-modern { justify-content: flex-end; text-align: right; }
    .lh-masthead.is-minimal { border-bottom: none; padding-bottom: 8px; }
    .lh-masthead img { max-height: 60px; max-width: 220px; object-fit: contain; }
    .lh-masthead .lh-mark { display: flex; flex-direction: column; }
    .lh-masthead strong { font-size: 22pt; color: ${form.accent}; letter-spacing: 0.5px; }
    .lh-masthead small { font-size: 9pt; color: #5d6a5b; margin-top: 2px; }
    .lh-masthead .lh-tagline { font-style: italic; color: #5d6a5b; font-size: 10pt; }
    .lh-spacer { flex: 1; }
    .lh-body { flex: 1; }
    .lh-body p { font-size: 11pt; line-height: 1.5; color: #28342a; }
    .lh-footer { display: flex; gap: 24px; align-items: baseline; padding-top: 14px; border-top: 1px solid #d3d8ce; color: #4f5b4d; font-size: 9pt; }
    .lh-footer.is-modern { border-top: none; border-left: 1px solid ${form.accent}; padding-left: 14px; padding-top: 0; }
    .lh-footer.is-minimal { border-top: 1px solid ${form.accent}; padding-top: 8px; }
    .lh-footer > div { display: flex; flex-direction: column; }
    .lh-footer .lh-label { color: ${form.accent}; font-weight: 700; text-transform: uppercase; font-size: 7pt; letter-spacing: 0.6px; margin-bottom: 2px; }
    .lh-rule { height: 4px; background: ${form.accent}; margin: 0 0 12px; border-radius: 1px; }
    .lh-rule.is-bottom { margin: 12px 0 0; }
  `;
}

function renderLetterheadHtml(state) {
  const form = state.form;
  const layout = LAYOUTS.find((l) => l.id === form.layout) || LAYOUTS[0];
  const logo = state.logo ? `<img src="data:${state.logo.type};base64,${arrayBufferToBase64(state.logo.bytes)}" alt="" />` : '';
  const mark = logo || '';
  const markText = !logo ? `<div class="lh-mark"><strong>${escapeHtml(form.companyName || ' ')}</strong><small>${escapeHtml(form.tagline || '')}</small></div>` : `<div class="lh-mark"><strong>${escapeHtml(form.companyName || ' ')}</strong><small>${escapeHtml(form.tagline || '')}</small></div>`;
  const addressLines = (form.address || '').split('\n').filter(Boolean);
  const footerBits = [];
  if (addressLines.length) footerBits.push({ label: 'Address', value: addressLines.join(' · ') });
  if (form.phone) footerBits.push({ label: 'Phone', value: form.phone });
  if (form.email) footerBits.push({ label: 'Email', value: form.email });
  if (form.website) footerBits.push({ label: 'Web', value: form.website });
  const footerHtml = footerBits.map((b) => `<div><span class="lh-label">${b.label}</span><span>${escapeHtml(b.value)}</span></div>`).join('');
  const bodyHtml = `<p style="margin-top: 0;">Dear ${escapeHtml(form.companyName ? 'team' : 'reader')},</p><p>This is your letterhead. Type over the body, paste in your letter, save the document. The header and footer come from the Identity panel on the left — change a field and the preview updates live.</p>`;
  if (layout.id === 'minimal') {
    return `
      <div class="lh-rule"></div>
      <div class="lh-masthead is-minimal">${mark}${markText}</div>
      <div class="lh-spacer"></div>
      <div class="lh-body">${bodyHtml}</div>
      <div class="lh-footer is-minimal">${footerHtml}</div>
    `;
  }
  if (layout.id === 'modern') {
    return `
      <div class="lh-masthead is-modern">${markText}${mark}</div>
      <div class="lh-spacer"></div>
      <div class="lh-body">${bodyHtml}</div>
      <div class="lh-footer is-modern">${footerHtml}</div>
    `;
  }
  /* classic */
  return `
    <div class="lh-masthead">${mark}${markText}</div>
    <div class="lh-spacer"></div>
    <div class="lh-body">${bodyHtml}</div>
    <div class="lh-footer">${footerHtml}</div>
  `;
}

function arrayBufferToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ---------------------------------------------------------------- export ---- */
function paintForm(root) {
  q('#lhLayout', root).value = state.form.layout;
  q('#lhCompany', root).value = state.form.companyName;
  q('#lhTagline', root).value = state.form.tagline;
  q('#lhAddress', root).value = state.form.address;
  q('#lhPhone', root).value = state.form.phone;
  q('#lhEmail', root).value = state.form.email;
  q('#lhWebsite', root).value = state.form.website;
  q('#lhAccent', root).value = state.form.accent;
  q('#lhSaveName', root).value = state.form.saveName;
  q('#lhLogoSize', root).value = state.form.logoSize;
  q('#lhLogoSizeOut', root).textContent = `${state.form.logoSize} pt`;
}

async function exportLetterhead(root) {
  if (!state.form.companyName) { toast('Add a company name first.'); return; }
  await withBusy(root, '#lhExport', 'Composing…', async () => {
    const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
    const setup = page();
    const sheet = sheetMm(setup);
    const margins = marginsMm(setup);
    const out = await PDFDocument.create();
    const sheetW = mmToPt(sheet.width);
    const sheetH = mmToPt(sheet.height);
    const page0 = out.addPage([sheetW, sheetH]);
    const helv = await out.embedFont(StandardFonts.Helvetica);
    const helvBold = await out.embedFont(StandardFonts.HelveticaBold);
    const helvIt = await out.embedFont(StandardFonts.HelveticaOblique);
    const accent = hexToRgb(state.form.accent);
    const ink = rgb(0.12, 0.18, 0.16);
    const muted = rgb(0.31, 0.36, 0.34);
    const layout = LAYOUTS.find((l) => l.id === state.form.layout) || LAYOUTS[0];
    const marginL = mmToPt(margins.left);
    const marginR = mmToPt(margins.right);
    const marginT = mmToPt(margins.top);
    const marginB = mmToPt(margins.bottom);
    const contentW = sheetW - marginL - marginR;
    /* Accent rule (top, classic/modern only). */
    if (layout.id === 'classic') {
      page0.drawRectangle({ x: marginL, y: sheetH - marginT - 4, width: contentW, height: 4, color: accent });
    }
    let cursorY = sheetH - marginT;
    if (layout.id !== 'minimal') cursorY -= 12;
    /* Logo + masthead. */
    let logoBoxH = 0;
    if (state.logo) {
      const img = await out.embedJpg(state.logo.bytes).catch(async () => out.embedPng(state.logo.bytes));
      const aspect = state.logo.width / state.logo.height;
      logoBoxH = state.form.logoSize;
      const drawW = Math.min(logoBoxH * aspect, contentW * 0.4);
      const drawH = drawW / aspect;
      const logoX = layout.id === 'modern' ? marginL + contentW - drawW : marginL;
      page0.drawImage(img, { x: logoX, y: cursorY - drawH, width: drawW, height: drawH });
    }
    const textX = state.logo ? (layout.id === 'modern' ? marginL : marginL + Math.min(state.form.logoSize * (state.logo.width / state.logo.height), contentW * 0.4) + 14) : marginL;
    const alignRight = layout.id === 'modern';
    const companySize = layout.id === 'modern' ? 16 : 18;
    const companyY = cursorY - 16;
    page0.drawText(state.form.companyName || ' ', { x: alignRight ? marginL + contentW - helvBold.widthOfTextAtSize(state.form.companyName || ' ', companySize) : textX, y: companyY, size: companySize, font: helvBold, color: accent });
    if (state.form.tagline) {
      const tagY = companyY - 12;
      page0.drawText(state.form.tagline, { x: alignRight ? marginL + contentW - helvIt.widthOfTextAtSize(state.form.tagline, 9) : textX, y: tagY, size: 9, font: helvIt, color: muted });
      cursorY = tagY - 4;
    } else {
      cursorY = companyY - 4;
    }
    /* Divider below masthead. */
    if (layout.id === 'classic' || layout.id === 'modern') {
      page0.drawLine({ start: { x: marginL, y: cursorY - 6 }, end: { x: marginL + contentW, y: cursorY - 6 }, thickness: 0.6, color: rgb(0.83, 0.85, 0.81) });
      cursorY -= 18;
    } else {
      cursorY -= 10;
    }
    /* Body placeholder. */
    const bodyTop = cursorY;
    /* The body region extends from `bodyTop` down to a footer that
       sits at marginB + footer height + a small gap. */
    const footerReserve = state.form.address || state.form.phone || state.form.email || state.form.website ? 60 : 0;
    const bodyBottom = marginB + footerReserve;
    const intro = `Dear reader,`;
    const filler = `This is your letterhead. The header and footer come from the Identity panel on the left; the body is yours to write.`;
    page0.drawText(intro, { x: marginL, y: bodyTop - 12, size: 11, font: helv, color: ink });
    /* word-wrap the filler so it fits in contentW. */
    const fillerLines = wrapText(filler, helv, 11, contentW);
    let lineY = bodyTop - 26;
    for (const line of fillerLines) {
      if (lineY < bodyBottom + 12) break;
      page0.drawText(line, { x: marginL, y: lineY, size: 11, font: helv, color: ink });
      lineY -= 14;
    }
    /* Footer. */
    if (footerReserve) {
      const footerY = marginB + 36;
      const cols = [];
      if (state.form.address) cols.push({ label: 'Address', value: state.form.address });
      if (state.form.phone) cols.push({ label: 'Phone', value: state.form.phone });
      if (state.form.email) cols.push({ label: 'Email', value: state.form.email });
      if (state.form.website) cols.push({ label: 'Web', value: state.form.website });
      /* Divider. */
      if (layout.id !== 'modern') {
        page0.drawLine({ start: { x: marginL, y: footerY + 16 }, end: { x: marginL + contentW, y: footerY + 16 }, thickness: 0.6, color: layout.id === 'minimal' ? accent : rgb(0.83, 0.85, 0.81) });
      } else {
        page0.drawLine({ start: { x: marginL, y: marginB }, end: { x: marginL, y: marginB + 50 }, thickness: 0.8, color: accent });
      }
      /* Lay the columns across. */
      const colW = contentW / cols.length;
      cols.forEach((col, i) => {
        const x = marginL + colW * i;
        page0.drawText(col.label.toUpperCase(), { x, y: footerY + 4, size: 7, font: helvBold, color: accent });
        const lines = col.value.split('\n');
        let ty = footerY - 6;
        for (const line of lines) {
          if (ty < marginB - 4) break;
          page0.drawText(line, { x, y: ty, size: 9, font: helv, color: muted });
          ty -= 11;
        }
      });
    }
    /* Accent rule (bottom, classic only). */
    if (layout.id === 'classic') {
      page0.drawRectangle({ x: marginL, y: marginB - 8, width: contentW, height: 2, color: accent });
    }
    const output = await out.save({ useObjectStreams: false });
    const stem = (state.form.saveName || 'folio-letterhead').trim() || 'folio-letterhead';
    const name = safeFileName(stem, 'pdf');
    downloadBlob(new Blob([output], { type: 'application/pdf' }), name);
    toast(`${name} is ready — 1 page, ${bytes(output.length)}.`);
  });
}

function mmToPt(mm) { return mm * 72 / 25.4; }

/* pdf-lib colours are plain objects with red/green/blue in [0, 1];
   rgb() inside the exportLetterhead closure wraps that, but this
   helper is called from outside the closure, so we just return the
   same shape directly. */
function hexToRgb(hex) {
  const cleaned = String(hex || '').replace('#', '');
  const full = cleaned.length === 3 ? cleaned.split('').map((c) => c + c).join('') : cleaned;
  const n = parseInt(full, 16);
  return { type: 'RGB', red: ((n >> 16) & 0xff) / 255, green: ((n >> 8) & 0xff) / 255, blue: (n & 0xff) / 255 };
}

function wrapText(text, font, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const tentative = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(tentative, size) <= maxWidth) current = tentative;
    else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function withBusy(root, buttonId, label, work) {
  const button = q(buttonId, root);
  if (!button) return work();
  const previous = button.disabled;
  button.disabled = true;
  const original = button.innerHTML;
  button.innerHTML = `<span class="busy-dot"></span><span>${label}</span>`;
  state.busy = true;
  try {
    return await work();
  } finally {
    state.busy = false;
    button.disabled = previous;
    button.innerHTML = original;
  }
}

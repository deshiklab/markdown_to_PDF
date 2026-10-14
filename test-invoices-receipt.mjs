/* Invoices receipt template: title swap, tax suppression, QR + barcode
   embedded as PNGs. Drives the real exportInvoice end-to-end through
   JSDOM, then decodes the PDF to verify the rendered text and the
   embedded image resources. */
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import zlib from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = __dirname;
const results = [];
function t(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then((info) => {
      results.push({ name, ok: true, info });
      console.log(`  pass  ${name}${info ? '  ' + info : ''}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, err: String(err && err.stack || err) });
      console.log(`  FAIL  ${name}\n        ${err && err.stack || err}`);
    });
}
function assert(cond, msg) { if (!cond) throw new Error(`assert: ${msg}`); }

/* ---------- PDF stream decoders (reuse the pattern from test-sign.mjs) -- */
function decodeAllStreams(pdf) {
  /* Find every "stream\n ... \nendstream" block, then attempt FlateDecode. */
  const out = [];
  const streamTag = Buffer.from('stream\n');
  const endTag = Buffer.from('\nendstream');
  const endTagNoEol = Buffer.from('endstream');
  let i = 0;
  while (i < pdf.length) {
    const start = pdf.indexOf(streamTag, i);
    if (start < 0) break;
    let dataStart = start + streamTag.length;
    /* Some encoders omit the trailing \n after "stream" — handle both. */
    if (pdf[dataStart] === 0x0d && pdf[dataStart + 1] === 0x0a) dataStart += 2;
    else if (pdf[dataStart] === 0x0a) dataStart += 1;
    let end = pdf.indexOf(endTag, dataStart);
    let endLen = endTag.length;
    if (end < 0) {
      end = pdf.indexOf(endTagNoEol, dataStart);
      endLen = endTagNoEol.length;
    }
    if (end < 0) break;
    const slice = pdf.subarray(dataStart, end);
    /* The slice may still have a trailing \n or \r\n; trim it. */
    let trimmed = slice;
    if (trimmed.length && trimmed[trimmed.length - 1] === 0x0a) trimmed = trimmed.subarray(0, trimmed.length - 1);
    if (trimmed.length && trimmed[trimmed.length - 1] === 0x0d) trimmed = trimmed.subarray(0, trimmed.length - 1);
    try {
      const inflated = zlib.inflateSync(trimmed);
      out.push(Buffer.from(inflated));
    } catch (err) {
      /* Not Flate-encoded — keep the raw bytes for callers that want them. */
      out.push(Buffer.from(trimmed));
    }
    i = end + endLen;
  }
  return out;
}

function textInStream(buf) {
  /* Decode every <hex> Tj and (literal) Tj operand. Returns the joined
     text the PDF actually draws. */
  const out = [];
  const s = buf.toString('latin1');
  /* Hex strings: <...> Tj */
  const hexRe = /<([0-9a-fA-F\s]+)>\s*Tj/g;
  let m;
  while ((m = hexRe.exec(s))) {
    const hex = m[1].replace(/\s+/g, '');
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
      str += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    out.push(str);
  }
  /* Literal strings: ( ... ) Tj */
  const litRe = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
  while ((m = litRe.exec(s))) {
    out.push(m[1].replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))).replace(/\\([\\()])/g, '$1'));
  }
  /* TJ arrays: [(part1) (part2)] — best effort, just take the parts. */
  const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
  while ((m = tjArrRe.exec(s))) {
    const parts = m[1];
    const innerHex = /<([0-9a-fA-F\s]+)>/g;
    let im;
    while ((im = innerHex.exec(parts))) {
      const hex = im[1].replace(/\s+/g, '');
      let str = '';
      for (let i = 0; i < hex.length; i += 2) str += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      out.push(str);
    }
    const innerLit = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
    while ((im = innerLit.exec(parts))) {
      out.push(im[1].replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))).replace(/\\([\\()])/g, '$1'));
    }
  }
  return out.join('');
}

function allTextInPdf(pdf) {
  const streams = decodeAllStreams(pdf);
  return streams.map(textInStream).join('\n');
}

function embeddedImageCount(pdf) {
  /* Count the *main* image XObjects, not their alpha SMasks. SMasks
     in pdf-lib are themselves /Type /XObject /Subtype /Image but
     use /DeviceGray color space. The main images use /DeviceRGB. */
  const s = pdf.toString('latin1');
  const matches = s.match(/\/Type\s*\/XObject\s*\/Subtype\s*\/Image\b[\s\S]*?\/ColorSpace\s*\/DeviceRGB/g);
  return matches ? matches.length : 0;
}

/* ---------- Test scaffolding ----------------------------------------- */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Node = window.Node;
globalThis.localStorage = window.localStorage;
window.localStorage.clear();

const mod = await import(pathToFileURL(path.join(repo, 'src/tools/invoices.js')).href);
const root = window.document.getElementById('root');
root.innerHTML = mod.__test.layout();
mod.__test.paintForm(root);
mod.__test.wireForm(root);

/* Set up state: a populated invoice in receipt template with QR + barcode. */
mod.__test.setState({
  number: 'RCP-001',
  template: 'receipt',
  qrPayload: 'https://example.com/r/RCP-001',
  barcodePayload: 'RCP-001',
  notes: '',
  paidDate: '14 Oct 2026',
});
mod.__test.getState().identity.companyName = 'Acme Inc.';
mod.__test.getState().lines = [
  { desc: 'Coffee', qty: 2, price: 4.5, taxRate: null, discountType: 'none', discountValue: 0 },
  { desc: 'Croissant', qty: 1, price: 3.25, taxRate: null, discountType: 'none', discountValue: 0 },
];

/* Capture the download: override URL.createObjectURL + a clickable anchor
   so the export's downloadBlob lands in memory instead of the JSDOM
   filesystem. */
let lastBlob = null;
const captureCreate = (blob) => { lastBlob = blob; return 'blob:fake'; };
const captureRevoke = () => {};
window.URL.createObjectURL = captureCreate;
window.URL.revokeObjectURL = captureRevoke;
if (typeof globalThis.URL !== 'undefined' && globalThis.URL !== window.URL) {
  globalThis.URL.createObjectURL = captureCreate;
  globalThis.URL.revokeObjectURL = captureRevoke;
}

/* Capture lastTextBuf for the next test by re-reading the blob. */
let lastTextBuf = null;
let lastText = null;

await t('exportInvoice produces a non-empty PDF blob', async () => {
  await mod.__test.exportInvoice(root);
  assert(lastBlob, 'no blob was created');
  assert(lastBlob.size > 1000, `PDF too small: ${lastBlob.size} bytes`);
  lastTextBuf = Buffer.from(await lastBlob.arrayBuffer());
  lastText = allTextInPdf(lastTextBuf);
  console.log(`        PDF: ${lastBlob.size} bytes`);
});

await t('PDF says RECEIPT, not INVOICE', () => {
  assert(lastText.includes('RECEIPT'), `RECEIPT not found in PDF text:\n${lastText.slice(0, 400)}`);
  assert(!lastText.includes('INVOICE'), `INVOICE should not appear, but found it in:\n${lastText.slice(0, 400)}`);
});

await t('PDF omits the Due date and shows Paid', () => {
  assert(!lastText.includes('DUE'), 'DUE should not appear in receipt');
  assert(lastText.includes('Paid in full'), 'Paid-in-full should appear in receipt');
});

await t('PDF omits the Tax line in the line-table header and totals', () => {
  assert(!lastText.includes('TAX'), `TAX should not appear in receipt PDF; found: ${lastText.match(/.{0,30}TAX.{0,30}/)?.[0]}`);
  assert(!lastText.includes('Subtotal after discount'), 'Subtotal-after-discount should not appear');
  assert(!lastText.includes('Total due'), 'Total-due should not appear in receipt');
});

await t('PDF embeds two images (QR + barcode)', () => {
  const count = embeddedImageCount(lastTextBuf);
  assert(count >= 2, `expected at least 2 embedded images (QR + barcode), found ${count}`);
  console.log(`        embedded images: ${count}`);
});

await t('exportInvoice still works for non-receipt templates', async () => {
  /* Reset to the classic template. The PDF should now say INVOICE again
     and the receipt-specific code paths should not interfere. */
  mod.__test.setState({ template: 'classic', qrPayload: '', barcodePayload: '', paidDate: '' });
  await mod.__test.exportInvoice(root);
  const buf = Buffer.from(await lastBlob.arrayBuffer());
  const text = allTextInPdf(buf);
  assert(text.includes('INVOICE'), 'classic template should still say INVOICE');
  assert(text.includes('TAX') || text.includes('DUE'), 'classic should still show the TAX column or DUE date');
});

const ok = results.every((r) => r.ok);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(ok ? 0 : 1);

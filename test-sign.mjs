/* End-to-end test: Sign tab — reason, location, with-time, custom date.
   Run with: node test-sign.mjs
   This file is not part of the public site; it lives at the repo root for
   developers who want to check the export roundtrip after a change. */
import { JSDOM } from 'jsdom';
import { writeFile, readFile } from 'node:fs/promises';
import zlib from 'node:zlib';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window; globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement; globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.File = window.File; globalThis.FileReader = window.FileReader; globalThis.Blob = window.Blob;
globalThis.FormData = window.FormData;
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const root = '/home/user/markdown_to_PDF';
const mod = await import(`file://${root}/src/tools/sign.js`);
const mount = window.document.getElementById('root');
mod.start(mount);

import('pdf-lib').then(async (pdfLib) => {
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText('CONTRACT', { x: 200, y: 700, size: 30, font, color: rgb(0, 0, 0) });
  p.drawText('Party A: __________________', { x: 100, y: 200, size: 12, font });
  p.drawText('Party B: __________________', { x: 100, y: 100, size: 12, font });
  const srcBytes = await doc.save();
  await writeFile('/tmp/test-sign-input.pdf', srcBytes);
  const file = new window.File([srcBytes], 'contract.pdf', { type: 'application/pdf' });
  /* Set the source state directly — loadFile uses pickFiles which opens a
     system dialog. We only need state.buffer + state.pageCount + state.pageSizes. */
  mod.__test.state.name = file.name;
  mod.__test.state.buffer = srcBytes.buffer.slice(srcBytes.byteOffset, srcBytes.byteOffset + srcBytes.byteLength);
  mod.__test.state.pageCount = 1;
  mod.__test.state.pageSizes = [{ width: 595, height: 842 }];
  mod.__test.state.rotations = [0];
  mod.__test.state.form.previewPage = 1;
  mod.__test.state.form.pageA = 1;
  mod.__test.state.form.pageB = 1;

  /* Inject a fake signature mark. Use 1×1 metadata so snap and draw agree. */
  const fakeMark = {
    id: 'mtest1',
    name: 'Test signature',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    width: 1,
    height: 1,
    savedAt: Date.now(),
  };
  mod.__test.state.marks = [fakeMark];
  mod.__test.state.form.markA = fakeMark.id;
  const select = mount.querySelector('[data-field="markA"]');
  if (select) select.innerHTML = `<option value="${fakeMark.id}" selected>${fakeMark.name}</option>`;
  const snapBtn = mount.querySelector('[data-pos="a:bottom-left"]');
  snapBtn?.click();

  /* Verify the form has the new fields. */
  const reasonA = mount.querySelector('[data-field="reasonA"]');
  const reasonB = mount.querySelector('[data-field="reasonB"]');
  const locationA = mount.querySelector('[data-field="locationA"]');
  const locationB = mount.querySelector('[data-field="locationB"]');
  const dateA = mount.querySelector('[data-field="dateA"]');
  const customA = mount.querySelector('[data-sg-date-custom="a"]');
  if (!reasonA || !reasonB || !locationA || !locationB) {
    console.error('[FAIL] new reason/location fields missing'); process.exit(1);
  }
  if (!dateA) { console.error('[FAIL] dateA missing'); process.exit(1); }
  const dateOptions = Array.from(dateA.options).map((o) => o.value).join(',');
  if (dateOptions !== 'none,today,beside,withTime,custom') {
    console.error('[FAIL] dateA options wrong:', dateOptions); process.exit(1);
  }
  if (!customA?.hidden) { console.error('[FAIL] customA should be hidden by default'); process.exit(1); }

  /* Trigger the change to "custom" — should reveal the custom-date field. */
  dateA.value = 'custom';
  dateA.dispatchEvent(new window.Event('change', { bubbles: true }));
  if (customA.hidden) { console.error('[FAIL] customA should be visible after change'); process.exit(1); }
  dateA.value = 'today';
  dateA.dispatchEvent(new window.Event('change', { bubbles: true }));

  /* Set up a signing scenario. */
  mod.__test.state.form.markA = mod.__test.state.marks[0].id;
  mod.__test.state.form.nameA = 'Deshika Rahman';
  mod.__test.state.form.titleA = 'Director';
  mod.__test.state.form.reasonA = 'I agree to the terms';
  mod.__test.state.form.locationA = 'Dhaka, BD';
  mod.__test.state.form.dateA = 'withTime';
  mod.__test.state.form.dateCustomA = '15 Sep 2026, 10:30';

  /* Verify dateString for each mode. */
  const cases = [
    { mode: 'withTime', expected: /^\d{2} \w{3} \d{4}, \d{2}:\d{2}$/ },
    { mode: 'custom', expected: /^15 Sep 2026, 10:30$/ },
    { mode: 'today', expected: /^\d{2} \w{3} \d{4}$/ },
    { mode: 'none', expected: '' },
  ];
  for (const c of cases) {
    mod.__test.state.form.dateA = c.mode;
    const got = mod.__test.dateString('a');
    if (c.expected instanceof RegExp) {
      if (!c.expected.test(got)) { console.error(`[FAIL] dateString(${c.mode}):`, got); process.exit(1); }
    } else if (got !== c.expected) {
      console.error(`[FAIL] dateString(${c.mode}):`, JSON.stringify(got)); process.exit(1);
    }
  }
  console.log('[OK] all four date modes render correctly');

  /* Sign and inspect output. */
  mod.__test.state.form.dateA = 'withTime';
  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = { blob }; return 'blob:test'; };
  const signBtn = mount.querySelector('#sgSignGo');
  if (signBtn?.disabled) { console.error('[FAIL] sign button disabled'); process.exit(1); }
  signBtn.click();
  await new Promise((r) => setTimeout(r, 4000));
  if (!captured) { console.error('[FAIL] no PDF'); process.exit(1); }
  const outBytes = new Uint8Array(await captured.blob.arrayBuffer());
  await writeFile('/tmp/test-sign-output.pdf', outBytes);
  console.log(`[OK] signed PDF: ${outBytes.length} bytes`);

  /* Read the file and concatenate all flate-decoded streams. */
  const rawBytes = await readFile('/tmp/test-sign-output.pdf');
  const allText = decodeAllStreams(rawBytes);
  /* Check every expected caption is present as a hex-encoded Tj string. */
  const expected = ['Deshika Rahman', 'Director', 'I agree to the terms', 'Dhaka, BD'];
  for (const e of expected) {
    const hex = bytesToHex(e);
    if (!allText.includes(hex)) { console.error(`[FAIL] missing "${e}" (hex ${hex})`); process.exit(1); }
  }
  const dateHex = bytesToHex(mod.__test.dateString('a'));
  if (!allText.includes(dateHex)) { console.error(`[FAIL] missing date "${mod.__test.dateString('a')}"`); process.exit(1); }
  console.log(`[OK] all 5 captions present: ${expected.join(', ')} + ${mod.__test.dateString('a')}`);

  /* Test 2: custom-date path. */
  mod.__test.state.form.dateA = 'custom';
  mod.__test.state.form.dateCustomA = '01 Jan 2027';
  captured = null;
  signBtn.click();
  await new Promise((r) => setTimeout(r, 4000));
  if (!captured) { console.error('[FAIL] no PDF (custom)'); process.exit(1); }
  const outBytes2 = new Uint8Array(await captured.blob.arrayBuffer());
  await writeFile('/tmp/test-sign-custom.pdf', outBytes2);
  const rawBytes2 = await readFile('/tmp/test-sign-custom.pdf');
  const allText2 = decodeAllStreams(rawBytes2);
  const customHex = bytesToHex('01 Jan 2027');
  if (!allText2.includes(customHex)) { console.error('[FAIL] custom date "01 Jan 2027" missing'); process.exit(1); }
  console.log('[OK] custom date "01 Jan 2027" present in PDF');

  /* Test 3: regression — the original "today" mode with no other captions
     should still draw the date on its own line. */
  mod.__test.state.form.nameA = '';
  mod.__test.state.form.titleA = '';
  mod.__test.state.form.reasonA = '';
  mod.__test.state.form.locationA = '';
  mod.__test.state.form.dateA = 'today';
  mod.__test.state.form.dateCustomA = '';
  captured = null;
  signBtn.click();
  await new Promise((r) => setTimeout(r, 4000));
  if (!captured) { console.error('[FAIL] no PDF (today only)'); process.exit(1); }
  const outBytes3 = new Uint8Array(await captured.blob.arrayBuffer());
  await writeFile('/tmp/test-sign-today.pdf', outBytes3);
  const rawBytes3 = await readFile('/tmp/test-sign-today.pdf');
  const allText3 = decodeAllStreams(rawBytes3);
  /* The mark name should appear as the name (the rule is 'dotted', so
     the mark name is used as the caption). */
  const todayMarkHex = bytesToHex('Test signature');
  if (!allText3.includes(todayMarkHex)) {
    console.error('[FAIL] "today" mode should use the mark name as caption');
    process.exit(1);
  }
  const todayDate = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const dateOnlyHex = bytesToHex(todayDate);
  if (!allText3.includes(dateOnlyHex)) {
    console.error(`[FAIL] "today" mode should draw date "${todayDate}"`);
    process.exit(1);
  }
  console.log(`[OK] "today" alone still draws mark name + date (${todayDate})`);

  process.exit(0);
});

function bytesToHex(str) {
  return Array.from(new TextEncoder().encode(str)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function decodeAllStreams(buf) {
  const parts = [];
  let pos = 0;
  while (pos < buf.length) {
    const head = buf.indexOf(Buffer.from('stream\n'), pos);
    if (head === -1) break;
    const start = head + 'stream\n'.length;
    const tail = buf.indexOf(Buffer.from('endstream'), start);
    if (tail === -1) break;
    let end = tail;
    if (buf[end - 1] === 0x0a) end -= 1;
    if (buf[end - 1] === 0x0d) end -= 1;
    try {
      parts.push(zlib.inflateSync(buf.slice(start, end)).toString('latin1'));
    } catch {
      /* not a flate stream */
    }
    pos = tail + 'endstream'.length;
  }
  return parts.join('\n');
}

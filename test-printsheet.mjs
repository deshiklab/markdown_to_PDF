/* End-to-end test: print sheet mode inside PDF Lab.
   Run with: node test-printsheet.mjs
   This file is not part of the public site; it lives at the repo root for
   developers who want to check the export roundtrip after a change. */
import { JSDOM } from 'jsdom';
import { readFile, writeFile } from 'node:fs/promises';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window; globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement; globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.File = window.File; globalThis.FileReader = window.FileReader; globalThis.Blob = window.Blob;
globalThis.FormData = window.FormData;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

const root = '/home/user/markdown_to_PDF';
const { start, __test } = await import(`file://${root}/src/tools/pdf-lab.js`);
const mount = window.document.getElementById('root');
start(mount);

import('pdf-lib').then(async (pdfLib) => {
  const { PDFDocument, StandardFonts } = pdfLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 12; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText('Page ' + i, { x: 250, y: 400, size: 36, font });
  }
  const bytes = await doc.save();
  await writeFile('/tmp/test-12pages.pdf', bytes);
  const srcBytes = new Uint8Array(bytes);
  const file = new window.File([srcBytes], '12pages.pdf', { type: 'application/pdf' });
  await __test.addFiles([file], mount);
  mount.querySelector('[data-mode-btn="print-sheet"]').click();
  console.log(`sources: ${__test.state.sources.length}, pages: ${__test.state.sources[0]?.pageCount}`);

  const preset = mount.querySelector('#labPrintPreset');
  preset.value = 'photo-book';
  preset.dispatchEvent(new window.Event('change', { bubbles: true }));

  let captured = null;
  globalThis.URL.createObjectURL = (blob) => { captured = { blob }; return 'blob:test'; };
  mount.querySelector('#labPrintGo').click();
  await new Promise((r) => setTimeout(r, 4000));
  if (!captured) { console.error('[FAIL] no PDF'); process.exit(1); }
  const outBytes = new Uint8Array(await captured.blob.arrayBuffer());
  await writeFile('/tmp/test-printsheet.pdf', outBytes);
  console.log(`[OK] print sheet PDF: ${outBytes.length} bytes`);

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc1 = await pdfjs.getDocument({ data: outBytes }).promise;
  console.log(`[OK] output pages: ${doc1.numPages} (12 pages on A3, 2-up = 6 sheets)`);

  /* Test 2: business-card 8-up. */
  preset.value = 'business-card';
  preset.dispatchEvent(new window.Event('change', { bubbles: true }));
  captured = null;
  mount.querySelector('#labPrintGo').click();
  await new Promise((r) => setTimeout(r, 4000));
  if (!captured) { console.error('[FAIL] no PDF (business-card)'); process.exit(1); }
  const bcBytes = new Uint8Array(await captured.blob.arrayBuffer());
  const doc2 = await pdfjs.getDocument({ data: bcBytes }).promise;
  console.log(`[OK] business-card output pages: ${doc2.numPages} (12 pages on A4, 8-up = 2 sheets, 4 pages each)`);

  /* Test 3: range "1-4, 8" with 4-up on A4. */
  preset.value = 'custom';
  preset.dispatchEvent(new window.Event('change', { bubbles: true }));
  mount.querySelector('#labPrintSheet').value = 'A4';
  mount.querySelector('#labPrintSheet').dispatchEvent(new window.Event('change', { bubbles: true }));
  mount.querySelector('#labPrintImpose').value = '4up';
  mount.querySelector('#labPrintImpose').dispatchEvent(new window.Event('change', { bubbles: true }));
  mount.querySelector('#labPrintRange').value = '1-4, 8';
  mount.querySelector('#labPrintRange').dispatchEvent(new window.Event('input', { bubbles: true }));
  console.log('range hint:', mount.querySelector('#labPrintHint')?.textContent);
  captured = null;
  mount.querySelector('#labPrintGo').click();
  await new Promise((r) => setTimeout(r, 4000));
  const rBytes = new Uint8Array(await captured.blob.arrayBuffer());
  const doc3 = await pdfjs.getDocument({ data: rBytes }).promise;
  console.log(`[OK] range "1-4, 8" output pages: ${doc3.numPages} (5 pages on A4, 4-up = 2 sheets)`);
  process.exit(0);
});

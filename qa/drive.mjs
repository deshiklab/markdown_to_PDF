/* Folio QA driver.
     node qa/drive.mjs frame     — the shared page setup: strip, previews, @page, page boxes
     node qa/drive.mjs trfmt     — Translate: extraction, page-faithful export, re-typeset
     node qa/drive.mjs sign      — the Sign tab, end to end, with PDF checks
     node qa/drive.mjs finish    — the Finish tab, end to end
     node qa/drive.mjs regress   — every other tab: does the main button still export?
     node qa/drive.mjs pad       — the signature pad: ink under the pointer at nine widths
     node qa/drive.mjs touch     — phone gestures and tap targets
     node qa/drive.mjs audit     — geometry sweep over tabs x viewports (overflow + clipping)
     node qa/drive.mjs all       — all of the above
   Fixtures are generated on the fly; a dev server must be listening on
   FOLIO_URL (default http://127.0.0.1:5173/). */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { DOWNLOADS, SHOTS, flag, files, feed, fixture, goto, open, report, say, sleep, snapshot, text, type, value, waitForDownload } from './lib.mjs';
import { makeFixtures } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const step = process.argv[2] ?? 'all';
const TABS = (process.env.TABS ?? 'markdown,pdf-lab,translate,convert,portfolio,finish,sign').split(',');
const SIZES = (process.env.SIZES ?? '1600x1000,1440x900,1024x800,900x900,768x1024,600x900,430x900,390x844,320x700').split(',');

await makeFixtures();
mkdirSync(SHOTS, { recursive: true });
let browser;
let page;

/* Each step runs in its own browser: Chromium starts refusing automatic
   downloads after a few from one origin, and a shared page would also leak the
   viewport and prefs from one step into the next. */
async function session(fn) {
  const opened = await open();
  browser = opened.browser;
  page = opened.page;
  try {
    await fn();
  } finally {
    await browser.close();
    browser = null;
    page = null;
  }
}

/* ------------------------------------------------------------------ pdf ---- */
async function pdfInfo(path) {
  const { PDFDocument } = require('pdf-lib');
  const bytes = readFileSync(path);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  const view = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
  let content = '';
  const pages = [];
  for (let index = 1; index <= view.numPages; index += 1) {
    const viewPage = await view.getPage(index);
    const extracted = await viewPage.getTextContent();
    const words = extracted.items.map((item) => item.str).join(' ');
    content += `${words}\n`;
    let images = 0;
    try {
      const operators = await viewPage.getOperatorList();
      images = operators.fnArray.filter((code) => code === pdfjs.OPS.paintImageXObject).length;
    } catch {
      /* operator lists are not always available; the text checks still stand */
    }
    pages.push({ words, images });
    viewPage.cleanup();
  }
  await view.destroy();
  return {
    pages: doc.getPageCount(),
    mediaBox: doc.getPage(0).getSize(),
    sizes: doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return `${Math.round(width)}x${Math.round(height)}`;
    }),
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    text: content,
    pageInfo: pages,
    bytes: bytes.length,
  };
}

/* A quick signature of the painted page, so we only measure once it settles
   (the app may replace the canvas element while a newer render is queued). */
const stageSample = () => page.evaluate(() => {
  const canvas = document.querySelector('#sgCanvas');
  if (!canvas || !canvas.width || canvas.getBoundingClientRect().width < 40) return null;
  const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let dark = 0;
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) opaque += 1;
    if (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < 205) dark += 1;
  }
  return { dark, opaque, id: canvas.width * 100000 + canvas.height, css: Math.round(canvas.getBoundingClientRect().width) };
});

async function waitForStage() {
  let previous = null;
  for (let i = 0; i < 60; i += 1) {
    const sample = await stageSample();
    if (sample && sample.opaque > sample.dark && previous && sample.dark === previous.dark && sample.id === previous.id) return sample;
    previous = sample;
    await sleep(300);
  }
  return null;
}

/* Load a file into the Sign tab, let the app render page 1, and take a
   luminance profile of it. Diffing the profile of a document before and after
   signing shows exactly where the signature landed — no colour guesswork. */
async function bandsOf(path, { shot = '' } = {}) {
  await page.click('[data-mode-btn="place"]');
  await feed(page, '#sgDrop', [path]);
  if (!(await waitForStage())) flag(`preview did not paint for ${path.split('/').pop()}`);
  return page.evaluate(({ shot }) => {
    const canvas = document.querySelector('#sgCanvas');
    if (!canvas || !canvas.width) return null;
    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const bands = new Array(8).fill(0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const luminance = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (luminance < 205) bands[Math.min(7, Math.floor(y / (height / 8)))] += 1;
      }
    }
    return { bands, size: [width, height], png: shot ? canvas.toDataURL('image/png').split(',')[1] : null };
  }, { shot });
}

function total(ink) {
  return ink ? ink.bands.reduce((a, b) => a + b, 0) : 0;
}

/* ------------------------------------------------------------------ sign ---- */
/* A snap click repaints the stage, and the repaint can rebuild the button under
   the pointer — the click then lands on a node that is already gone and the mark
   stays where it was. So place it, read the handle back off the sheet, and try
   again until the mark is in the band it was asked for. */
async function placeParty(key, position) {
  const [row, column] = position.split('-');
  const wantY = { top: 0, middle: 1, bottom: 2 }[row];
  const wantX = { left: 0, centre: 1, center: 1, middle: 1, right: 2 }[column];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.click(`[data-pos="${key}:${position}"]`);
    await sleep(430);
    const band = await page.evaluate(({ party }) => {
      const paper = document.querySelector('#sgPaper');
      const handle = document.querySelector(`[data-handle="${party}"]`);
      if (!paper || !handle || handle.hidden) return null;
      const sheet = paper.getBoundingClientRect();
      const box = handle.getBoundingClientRect();
      return [
        Math.floor((((box.x - sheet.x) + box.width / 2) / sheet.width) * 3),
        Math.floor((((box.y - sheet.y) + box.height / 2) / sheet.height) * 3),
      ].map((value) => Math.min(2, Math.max(0, value)));
    }, { party: key });
    if (band && band[0] === wantX && band[1] === wantY) return true;
    say(`place ${key}:${position}`, `attempt ${attempt} — handle in band ${band ? band.join(',') : 'not shown'}`);
  }
  flag(`the ${key} mark never moved to ${position} after three attempts`);
  return false;
}

async function sign() {
  await page.setViewport({ width: 1440, height: 1000 });
  await goto(page, '#/sign', 1900);
  say('tabs', await page.$$eval('.tool-tab', (nodes) => nodes.length));
  say('panel', await page.$eval('.tool-panel:not([hidden])', (node) => node.id));
  say('marks at start', await text(page, '#sgMarkCount'));

  // draw a signature: a crossing flourish, in the pad's own coordinate space
  await page.$eval('#sgPad', (node) => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  await sleep(240);
  const box = await page.$eval('#sgPad', (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  });
  const stroke = (scale) => {
    const pts = [[0.14, 0.62], [0.26, 0.24], [0.34, 0.72], [0.46, 0.2], [0.56, 0.66], [0.68, 0.28], [0.78, 0.6], [0.88, 0.34]];
    return pts.map(([fx, fy]) => [box.x + fx * box.w * scale, box.y + fy * box.h]);
  };
  let path = stroke(1);
  await page.mouse.move(path[0][0], path[0][1]);
  await page.mouse.down();
  for (const [x, y] of path.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
  await sleep(500);
  path = stroke(1).map(([x, y]) => [x + 12, y - 9]);
  await page.mouse.move(path[0][0], path[0][1]);
  await page.mouse.down();
  for (const [x, y] of path.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
  await sleep(600);
  say('pad note', await text(page, '#sgPadNote'));

  await type(page, '#sgMarkName', 'Blue ink — test');
  await page.click('#sgSaveMark');
  await sleep(900);
  say('marks kept', await text(page, '#sgMarkCount'));
  say('thumb size', await page.$eval('.sg-mark-thumb img', (node) => `${node.naturalWidth}x${node.naturalHeight}`).catch(() => 'none'));
  const mark = await page.evaluate(() => {
    const img = document.querySelector('.sg-mark-thumb img');
    return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  say('mark canvas', `${mark?.w}x${mark?.h}`);
  if (!mark || mark.w < 500 || mark.w > 1400 || mark.h > 1400) flag(`saved mark is ${JSON.stringify(mark)}, expected a cropped PNG under the 1400px export box`);

  // the library is the point: it has to survive a reload
  await goto(page, '#/sign', 1600);
  say('marks after reload', await text(page, '#sgMarkCount'));
  if (!/1 on this device/.test(await text(page, '#sgMarkCount'))) flag('saved signature did not survive a reload');

  /* ---- place it on a page ---- */
  await page.click('[data-mode-btn="place"]');
  await sleep(500);
  await feed(page, '#sgDrop', ['alpha.pdf']);
  await sleep(3200);
  say('stat', await text(page, '#sgStat'));
  say('work visible', await page.$eval('#sgWork', (node) => !node.hidden));
  say('handles shown', await page.$$eval('.sg-handle:not([hidden])', (nodes) => nodes.map((n) => n.dataset.handle).join('+') || 'none'));
  say('canvas', await page.$eval('#sgCanvas', (node) => `${node.width}x${node.height}`).catch(() => 'none'));

  await page.click('.sg-mark [data-use="b"]');
  await sleep(700);
  say('handles now', await page.$$eval('.sg-handle:not([hidden])', (nodes) => nodes.map((n) => n.dataset.handle).join('+') || 'none'));
  await placeParty('a', 'bottom-right');
  await placeParty('b', 'bottom-left');
  await sleep(700);
  const geo = await page.evaluate(() => {
    document.querySelector('#sgPaper')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const paper = document.querySelector('#sgPaper').getBoundingClientRect();
    const read = (key) => {
      const node = document.querySelector(`.sg-handle[data-handle="${key}"]`);
      if (!node || node.hidden) return null;
      const r = node.getBoundingClientRect();
      return { l: (r.x - paper.x) / paper.width, t: (r.y - paper.y) / paper.height, w: r.width / paper.width, h: r.height / paper.height, hidden: false };
    };
    return { paper: [Math.round(paper.width), Math.round(paper.height)], a: read('a'), b: read('b') };
  });
  say('A handle', geo.a ? `left ${(geo.a.l * 100).toFixed(0)}% top ${(geo.a.t * 100).toFixed(0)}% width ${(geo.a.w * 100).toFixed(0)}% of paper ${geo.paper.join('x')}` : 'HIDDEN');
  say('B handle', geo.b ? `left ${(geo.b.l * 100).toFixed(0)}% top ${(geo.b.t * 100).toFixed(0)}%` : 'HIDDEN');
  if (!geo.a) flag('the signature handle vanished from the page preview');
  else {
    if (geo.a.l + geo.a.w > 0.98 || geo.a.t < 0.5) flag(`bottom-right snap put the mark off the page: ${JSON.stringify(geo.a)}`);
    if (geo.b && geo.b.l > 0.3) flag(`bottom-left countersignature is not on the left: ${JSON.stringify(geo.b)}`);
  }

  // give it a caption, and a countersignature
  await type(page, '[data-field="nameA"]', 'Deshika Rahman');
  await type(page, '[data-field="titleA"]', 'Director, Folio Studio');
  await type(page, '[data-field="nameB"]', 'A. Counter');
  await sleep(700);
  say('seal hint', await text(page, '#sgSealHint'));
  await page.click('[data-mode-btn="seal"]');
  await sleep(500);
  say('summary', await page.$$eval('.sg-summary-row', (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim().slice(0, 84)).join(' || ')));
  await page.screenshot({ path: `${SHOTS}/sign-seal.png` }).catch(() => {});

  const before = snapshot();
  await page.click('#sgSignGo');
  const signed = await waitForDownload(before);
  say('signed file', signed ?? 'NONE');
  if (!signed) flag('no signed PDF was downloaded');
  else {
    const info = await pdfInfo(`${DOWNLOADS}/${signed}`);
    say('pages/sizes', `${info.pages} · ${info.sizes.join(' ')}`);
    say('text layer', `name=${info.text.includes('Deshika Rahman')} title=${info.text.includes('Director, Folio Studio')} other=${info.text.includes('A. Counter')} prose=${info.text.includes('quick brown fox')}`);
    if (info.pages !== 3 || info.sizes.some((size) => size !== '595x842')) flag(`signing changed the document: ${info.pages} pages ${info.sizes.join(' ')}`);
    if (!info.text.includes('Deshika Rahman') || !info.text.includes('A. Counter')) flag('caption text missing from the signed file');
    if (!info.text.includes('quick brown fox')) flag('the text layer was destroyed even though flatten was off');
    const drawn = info.pageInfo.map((item) => item.images);
    say('images drawn per page', drawn.join(','));
    if (drawn[0] < 2) flag(`page 1 should carry both signature images, saw ${drawn[0]}`);
    if (drawn.slice(1).some((count) => count)) flag(`pages 2-3 should be untouched, saw images ${drawn.slice(1).join(',')}`);
  }

  if (signed) {
    const clean = await bandsOf(fixture('alpha.pdf'));
    const ink = await bandsOf(`${DOWNLOADS}/${signed}`, { shot: 'signed-page1' });
    if (!clean || !ink) flag('the preview renderer gave no pixels to compare');
    else {
      const diff = ink.bands.map((value, index) => value - clean.bands[index]);
      say('bands fixture', clean.bands.join(' '));
      say('bands signed', ink.bands.join(' '));
      say('added per band', `${diff.join(' ')} · page ${ink.size.join('x')}`);
      if (ink.png) writeFileSync(`${SHOTS}/signed-page1.png`, Buffer.from(ink.png, 'base64'));
      const lower = diff.slice(5).reduce((a, b) => a + b, 0);
      const upper = diff.slice(0, 5).reduce((a, b) => a + b, 0);
      if (lower < 200) flag(`no signature ink added to the bottom of the page: ${diff.join(' ')}`);
      if (upper > lower * 0.25) flag(`signature ink showed up above the footer as well: ${diff.join(' ')}`);
    }
  }

  // now flatten, and check the text really does merge into the page
  await page.click('[data-mode-btn="seal"]');
  await page.$eval('#sgFlatten', (node) => {
    if (!node.checked) node.click();
  });
  await sleep(400);
  const beforeFlat = snapshot();
  await page.click('#sgSignGo');
  const flat = await waitForDownload(beforeFlat, { seconds: 70 });
  say('flattened file', flat ?? 'NONE');
  if (flat) {
    const info = await pdfInfo(`${DOWNLOADS}/${flat}`);
    const first = info.pageInfo[0];
    const rest = info.pageInfo.slice(1);
    say('flattened', `${info.pages} pages · ${Math.round(info.bytes / 1024)} KB · page 1 text=${JSON.stringify((first.words || '').slice(0, 18))} images=${first.images}`);
    if (first.words.includes('quick brown fox')) flag('flatten was on but page 1 is still selectable text');
    if (!first.images) flag('page 1 was not flattened into an image');
    if (!rest.every((item) => item.words.includes('Section one of alpha'))) flag('flatten spilled over onto pages that should not change');
    if (info.pages !== 3) flag(`flatten lost pages: ${info.pages}`);
    if (info.sizes.some((size) => size !== '595x842')) flag(`flatten changed page sizes: ${info.sizes.join(' ')}`);
  } else flag('no flattened signed PDF was downloaded');

  /* ---- a page that is rotated: the mark must still land where you put it ---- */
  await page.click('[data-mode-btn="place"]');
  await feed(page, '#sgDrop', ['rot90.pdf']);
  await sleep(3400);
  say('rotated canvas', await page.$eval('#sgCanvas', (node) => `${node.width}x${node.height}`).catch(() => 'none'));
  await placeParty('a', 'bottom-right');
  await placeParty('b', 'top-left');
  await sleep(600);
  await page.$eval('#sgFlatten', (node) => {
    if (node.checked) node.click();
  });
  const beforeRot = snapshot();
  await page.click('[data-mode-btn="seal"]');
  await page.click('#sgSignGo');
  const rotSigned = await waitForDownload(beforeRot);
  say('rotated signed file', rotSigned ?? 'NONE');
  if (rotSigned) {
    const info = await pdfInfo(`${DOWNLOADS}/${rotSigned}`);
    say('rotated out', `${info.pages} pages · ${info.sizes.join(' ')} · caption=${info.text.includes('Deshika Rahman')} · images=${info.pageInfo.map((item) => item.images).join(',')}`);
    if (info.pages !== 2) flag(`rotated fixture came out with ${info.pages} pages`);
    if (info.pageInfo[0].images < 2) flag('nothing was drawn on the rotated page');
    if (info.pageInfo[1].images) flag('the second page of the rotated file was signed too');
    const clean = await bandsOf(fixture('rot90.pdf'));
    const ink = await bandsOf(`${DOWNLOADS}/${rotSigned}`, { shot: 'rotated-page1' });
    if (clean && ink) {
      const diff = ink.bands.map((value, index) => value - clean.bands[index]);
      say('rotated bands added', diff.join(' '));
      if (writeFileSync && ink.png) writeFileSync(`${SHOTS}/rotated-page1.png`, Buffer.from(ink.png, 'base64'));
      // A went bottom-right, B went top-left, so both ends of the page must gain ink and the middle must not
      const ends = diff[0] + diff[1] + diff[6] + diff[7];
      const middle = diff.slice(2, 6).reduce((a, b) => a + b, 0);
      if (diff[6] + diff[7] < 120) flag(`the /Rotate 90 bottom-right mark is missing from the bottom of the page: ${diff.join(' ')}`);
      if (diff[0] + diff[1] < 60) flag(`the /Rotate 90 top-left countersignature is missing from the top: ${diff.join(' ')}`);
      if (middle > ends * 0.3) flag(`ink wandered into the middle of the rotated page: ${diff.join(' ')}`);
    } else flag('rotated page render comparison produced no data');
  }
}

/* ---------------------------------------------------------------- finish ---- */
async function finish() {
  await page.setViewport({ width: 1440, height: 1000 });
  await goto(page, '#/finish', 1900);
  await feed(page, '#fnDrop', ['alpha.pdf']);
  await sleep(3000);
  say('chips', await page.$$eval('.fn-chip', (nodes) => nodes.map((n) => n.textContent.trim()).join(' · ')));
  say('title read', await value(page, '#fnMeta-title'));
  await page.click('[data-mode-btn="hash"]');
  await sleep(500);
  const digest = await value(page, '#fnHashValue');
  say('sha256', /^[0-9a-f]{64}$/.test(digest || '') ? 'ok' : `bad (${digest})`);
  await type(page, '#fnHashVerify', digest || '');
  say('verify', await text(page, '#fnHashHint'));
  await page.click('[data-mode-btn="meta"]');
  await sleep(400);
  await type(page, '#fnMeta-title', 'Alpha — signed off');
  const before = snapshot();
  await page.click('#fnMetaGo');
  const fields = await waitForDownload(before);
  say('fields file', fields ?? 'NONE');
  if (fields) {
    const info = await pdfInfo(`${DOWNLOADS}/${fields}`);
    say('fields round-trip', `title=${info.title} author=${info.author}`);
    if (info.title !== 'Alpha — signed off') flag('document title was not written');
    if (info.author !== 'Deshika Rahman') flag('author was clobbered while saving fields');
  }
  await page.click('[data-mode-btn="numbers"]');
  await type(page, '#fnStampText', '{page} of {total}');
  await page.click('[data-position="bottom-right"]');
  const before2 = snapshot();
  await page.click('#fnStampGo');
  const numbered = await waitForDownload(before2);
  say('numbered file', numbered ?? 'NONE');
  if (numbered) {
    const info = await pdfInfo(`${DOWNLOADS}/${numbered}`);
    say('footers', `1 of 3=${info.text.includes('1 of 3')} 3 of 3=${info.text.includes('3 of 3')}`);
    if (!info.text.includes('1 of 3') || !info.text.includes('3 of 3')) flag('page numbers missing from the footer');
  }
  await page.click('[data-mode-btn="redact"]');
  await type(page, '#fnTerms', 'fox\nACME Corp\nqzzz');
  await sleep(2600);
  say('findings', await page.$$eval('.fn-finding', (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join(' | ')));
  await page.click('#fnFlatten');
  const before3 = snapshot();
  await page.click('#fnRedactGo');
  const redacted = await waitForDownload(before3, { seconds: 70 });
  say('redacted file', redacted ?? 'NONE');
  if (redacted) {
    const info = await pdfInfo(`${DOWNLOADS}/${redacted}`);
    say('redaction', `fox=${info.text.includes('fox')} ACME=${info.text.includes('ACME')} pages=${info.pages}`);
    if (info.text.includes('fox') || info.text.includes('ACME')) flag('flattened redaction still left the words in the text layer');
  }
}

/* --------------------------------------------------------------- regress ---- */
async function regress() {
  await page.setViewport({ width: 1440, height: 1000 });
  await goto(page, '#/', 1200);
  await page.click('#sampleButton');
  await sleep(1500);
  say('studio preview', await page.$$eval('#previewContent *', (nodes) => `${nodes.length} nodes`));
  const before = snapshot();
  await page.click('#exportButton');
  say('studio pdf', (await waitForDownload(before)) ?? 'NONE');

  await goto(page, '#/pdf-lab', 1700);
  await feed(page, '#labDrop', ['alpha.pdf', 'beta.pdf']);
  await sleep(3200);
  say('lab counts', `${await text(page, '#labFileCount')} · ${await text(page, '#labPageCount')}`);
  let snap = snapshot();
  await page.click('#labMergeGo');
  say('merge', (await waitForDownload(snap)) ?? 'NONE');
  snap = snapshot();
  await page.click('[data-mode-btn="watermark"]');
  await type(page, '#labWatermarkText', 'FOLIO PROOF');
  await page.click('#labWatermarkGo');
  say('watermark', (await waitForDownload(snap)) ?? 'NONE');

  await goto(page, '#/translate', 1700);
  await feed(page, '#trPdfDrop', ['alpha.pdf']);
  await sleep(3600);
  say('translate segments', await text(page, '#trOriginState'));
  snap = snapshot();
  await page.click('#trMd');
  say('translate markdown', (await waitForDownload(snap)) ?? 'NONE');

  await goto(page, '#/convert', 1700);
  await feed(page, '#cvDrop', ['wide.png', 'tall.png']);
  await sleep(2600);
  say('convert count', await text(page, '#cvCount'));
  snap = snapshot();
  await page.click('#cvImagesGo');
  say('photos→pdf', (await waitForDownload(snap)) ?? 'NONE');
  await page.evaluate(() => document.querySelector('#cvGrid [data-act="del"]')?.click());
  await sleep(900);
  say('count after delete', await text(page, '#cvCount'));
  if (/no images yet/.test(await text(page, '#cvCount'))) flag('converter count went stale after deleting an image');

  await goto(page, '#/portfolio', 1700);
  await feed(page, '#pfDrop', ['wide.png', 'tall.png', 'square.png']);
  await sleep(4200);
  say('portfolio', `${await text(page, '#pfPhotoCount')} · ${await text(page, '#pfPages')}`);
  snap = snapshot();
  await page.click('#pfExport');
  say('book pdf', (await waitForDownload(snap, { seconds: 70 })) ?? 'NONE');
}

/* ----------------------------------------------------------- the pad ---- */
/* The pad is the one place where a wrong canvas size is felt in the hand: the
   ink has to appear under the pointer, at every width, and the panel must not
   spill out of itself. */
async function pad() {
  const widths = (process.env.PAD_SIZES ?? '1600,1280,1024,900,768,600,430,390,320').split(',').map(Number);
  // fractions of the pad box the pointer is moved to, and the same pad report
  const draw = async (from, to) => {
    await page.$eval('#sgPad', (node) => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await sleep(220);
    const box = await page.$eval('#sgPad', (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x + node.clientLeft, y: r.y + node.clientTop, w: node.clientWidth, h: node.clientHeight };
    });
    const at = (p) => [box.x + box.w * p[0], box.y + box.h * p[1]];
    const a = at(from);
    const b = at(to);
    await page.mouse.move(a[0], a[1]);
    await page.mouse.down();
    await page.mouse.move(b[0], b[1], { steps: 12 });
    await page.mouse.up();
    await sleep(360);
    const ink = await page.evaluate(() => {
      const canvas = document.querySelector('#sgPad');
      const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      let count = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          // ink is the only saturated colour on a paper-white pad
          if (data[i + 3] > 200 && Math.abs(data[i] - data[i + 2]) > 12) {
            count += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (!count) return null;
      return {
        box: [canvas.clientWidth, canvas.clientHeight],
        bitmap: [canvas.width, canvas.height],
        from: [minX / width, minY / height],
        to: [maxX / width, maxY / height],
        count,
      };
    });
    return { box, ink };
  };
  const near = (a, b) => Math.abs(a - b) * 100 < 5;
  for (const width of widths) {
    await page.setViewport({ width, height: 900, hasTouch: width < 700, isMobile: width < 700 });
    await goto(page, '#/sign', 1900);
    await page.click('[data-mode-btn="pad"]').catch(() => {});
    await sleep(500);
    const report = await page.evaluate(() => {
      const panel = document.querySelector('.sg-side');
      const canvas = document.querySelector('#sgPad');
      const rect = (node) => (node ? (node.hidden ? 'hidden' : `${Math.round(node.getBoundingClientRect().width)}x${Math.round(node.getBoundingClientRect().height)}`) : 'MISSING');
      const edge = panel.getBoundingClientRect();
      const spills = [];
      for (const node of panel.querySelectorAll('*')) {
        const r = node.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.right > edge.right + 1.5 || r.left < edge.left - 1.5) spills.push(`${node.tagName.toLowerCase()}#${node.id || node.className.split(' ')[0]}@${Math.round(r.left)}-${Math.round(r.right)}`);
      }
      const tiny = [];
      for (const node of panel.querySelectorAll('p,span,small,label,button')) {
        const style = getComputedStyle(node);
        const size = parseFloat(style.fontSize);
        const colour = style.color.match(/\d+/g).slice(0, 3).map(Number);
        const lum = (c) => {
          const v = c.map((x) => x / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
          return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
        };
        const ratio = (0.99 + 0.05) / (lum(colour) + 0.05);
        const filled = ['BUTTON', 'INPUT'].includes(node.tagName) || node.closest('button');
        if (!filled && node.textContent.trim().length > 3 && (size < 9.5 || ratio < 4.4)) tiny.push(`${node.tagName.toLowerCase()}#${node.id || node.className.split(' ')[0]} ${size}px/${ratio.toFixed(1)}`);
      }
      return {
        pad: rect(canvas),
        bitmap: [canvas.width, canvas.height],
        css: [canvas.clientWidth, canvas.clientHeight],
        styleHeight: getComputedStyle(canvas).height,
        dpr: window.devicePixelRatio,
        note: rect(document.querySelector('#sgPadNote')),
        toolbar: rect(document.querySelector('.sg-toolbar')),
        saveRow: rect(document.querySelector('.sg-save-row')),
        keep: rect(document.querySelector('#sgSaveMark')),
        name: document.querySelector('#sgMarkName')?.getBoundingClientRect().width ?? 0,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        spills: [...new Set(spills)].slice(0, 6),
        tiny: [...new Set(tiny)].slice(0, 8),
      };
    });
    await page.click('#sgClearPad').catch(() => {});
    await sleep(160);
    const first = await draw([0.2, 0.7], [0.8, 0.3]);
    // a phone that re-measures itself (keyboard, rotation) must not move the ink
    // keep the emulation flags identical — puppeteer reloads the page when
    // isMobile changes, which would wipe the pad and look like a bug
    await page.setViewport({ width: Math.round(width * 0.78), height: 900, hasTouch: width < 700, isMobile: width < 700 });
    await sleep(700);
    const after = await page.evaluate(() => {
      const canvas = document.querySelector('#sgPad');
      return { css: [canvas.clientWidth, canvas.clientHeight], bitmap: [canvas.width, canvas.height] };
    });
    const moved = await page.evaluate(() => {
      const canvas = document.querySelector('#sgPad');
      const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      let count = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          if (data[i + 3] > 200 && Math.abs(data[i] - data[i + 2]) > 12) {
            count += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return count ? { from: [minX / width, minY / height], to: [maxX / width, maxY / height], count } : null;
    });
    say(`${width}px`, `pad ${report.pad} css ${report.css.join('x')} bitmap ${report.bitmap.join('x')} · ink ${first.ink ? `${(first.ink.from[0] * 100).toFixed(0)}%→${(first.ink.to[0] * 100).toFixed(0)}%` : 'MISSING'} · after resize ${moved ? `${(moved.from[0] * 100).toFixed(0)}%→${(moved.to[0] * 100).toFixed(0)}%` : 'GONE'}`);
    if (report.docOverflow > 0) flag(`${width}px: document overflows by ${report.docOverflow}px`);
    if (report.spills.length) flag(`${width}px: pad panel spills: ${report.spills.join(' | ')}`);
    if (report.tiny.length) flag(`${width}px: micro copy below the house floor: ${report.tiny.join(' | ')}`);
    if (report.bitmap[0] !== report.css[0] || report.bitmap[1] !== report.css[1]) flag(`${width}px: pad bitmap ${report.bitmap.join('x')} does not match its CSS box ${report.css.join('x')} at dpr ${report.dpr} — the ink is stretched`);
    if (!first.ink) flag(`${width}px: nothing was drawn on the pad`);
    else {
      const xs = [first.ink.from[0], first.ink.to[0]].sort((a, b) => a - b);
      const ys = [first.ink.from[1], first.ink.to[1]].sort((a, b) => a - b);
      if (!near(xs[0], 0.2) || !near(xs[1], 0.8)) flag(`${width}px: the stroke spans x ${xs.map((v) => `${Math.round(v * 100)}%`).join('→')}, the pointer went from 20% to 80%`);
      if (!near(ys[0], 0.3) || !near(ys[1], 0.7)) flag(`${width}px: the stroke spans y ${ys.map((v) => `${Math.round(v * 100)}%`).join('→')}, the pointer went from 70% to 30%`);
      if (first.ink.count < 300) flag(`${width}px: only ${first.ink.count} ink pixels for a full-diagonal stroke`);
      if (!moved) flag(`${width}px: the stroke disappeared when the panel was resized`);
      else if (!near(moved.from[0], first.ink.from[0]) || !near(moved.to[0], first.ink.to[0])) {
        flag(`${width}px → ${Math.round(width * 0.78)}px: the ink slid from ${Math.round(first.ink.from[0] * 100)}%/${Math.round(first.ink.to[0] * 100)}% to ${Math.round(moved.from[0] * 100)}%/${Math.round(moved.to[0] * 100)}% — a resize must not move a signature`);
      }
      if (after.bitmap[0] !== after.css[0] || after.bitmap[1] !== after.css[1]) flag(`${width}px: after a resize the bitmap is ${after.bitmap.join('x')} for a ${after.css.join('x')} box`);
    }
    await page.screenshot({ path: `${SHOTS}/pad-${width}.png`, clip: { x: 0, y: 0, width, height: 900 } });
  }
}

/* ----------------------------------------------------------------- audit ---- */
/* ------------------------------------------------------------- translate ---- */
/* The two promises of this tab: a page-faithful version that keeps the original
   layout, and a re-typeset version you can style. Both are checked against the
   bytes of the PDF that comes out, not just the pixels on screen. */
async function trfmt() {
  await goto(page, '#/translate', 1600);
  await feed(page, '#trPdfDrop', ['alpha.pdf']);
  await sleep(3800);
  const blocks = Number((await text(page, '#trOriginState')).match(/(\d+)/)?.[1] ?? 0);
  say('blocks extracted', `${blocks} from alpha.pdf · ${await text(page, '#trPreviewWhere')}`);
  if (blocks < 10) flag(`only ${blocks} blocks came out of a 3-page fixture — extraction looks broken`);

  await page.select('#trProvider', 'manual');
  await sleep(250);
  await page.click('#trRun');
  await sleep(1100);
  const ready = await page.$$eval('.tr-row.is-ready', (nodes) => nodes.length);
  say('manual pass', `${ready} rows waiting for a translation`);
  if (ready !== blocks) flag(`${ready} rows ready out of ${blocks} blocks`);

  const boxes = await page.$$('.tr-row textarea');
  const typed = ['Sunset over the harbour', 'সূর্যাস্ত বন্দরের উপরে', 'Patient Zero signed the ACME Corp agreement on 12 March 1999.'];
  for (let index = 0; index < typed.length; index += 1) {
    await boxes[index].click();
    await boxes[index].type(typed[index]);
    await sleep(260);
  }
  await sleep(700);
  say('overlay preview', await text(page, '#trPreviewNote'));

  const overlay = await page.evaluate(() => {
    const canvas = document.querySelector('#trOverlay');
    const sheet = document.querySelector('.tr-sheet');
    return {
      visible: !canvas.hidden,
      ratio: +(canvas.width / canvas.height).toFixed(3),
      sheetPad: getComputedStyle(sheet).padding,
      page: sheet.dataset.pageSize,
    };
  });
  say('overlay canvas', `visible ${overlay.visible} · ratio ${overlay.ratio} (A4 is 0.707) · sheet ${overlay.page} padding ${overlay.sheetPad}`);
  if (!overlay.visible) flag('the overlay canvas never showed — the page-faithful preview is not painting');
  if (Math.abs(overlay.ratio - 595 / 842) > 0.02) flag(`overlay canvas ratio ${overlay.ratio} is not the source page's`);
  if (!/^0px($| )/.test(overlay.sheetPad)) flag(`the overlay sheet has ${overlay.sheetPad} of padding — the page must sit flush`);

  let before = snapshot();
  await page.evaluate(() => document.querySelector('#trPdf').click());
  const faithful = await waitForDownload(before, { seconds: 90 });
  say('page-faithful export', faithful ?? 'NONE');
  if (!faithful) flag('the overlay export produced no file');

  if (faithful) {
    const info = await pdfInfo(`${DOWNLOADS}/${faithful}`);
    const streams = await pageStreams(`${DOWNLOADS}/${faithful}`);
    const white = (streams.match(/1 1 1 rg/g) ?? []).length;
    const prints = (streams.match(/\bTj\b|\bTJ\b/g) ?? []).length;
    say('exported content', `${info.pages} pages · ${info.sizes[0]}pt · images on p1 ${info.pageInfo[0].images} · white fills ${white} · text runs ${prints}`);
    if (white < 3) flag(`only ${white} white fills in the page stream — the source text may not have been boxed out`);
    if (info.pageInfo[0].images < 1) flag('the non-Latin translation was not drawn as a picture');
    const placed = info.pageInfo[0].words.includes('Sunset over the harbour') || info.pageInfo[0].words.includes('Sunset');
    say('translation in the text layer', placed ? 'yes — selectable, and the picture carries the Bengali' : 'not found as one run');
    if (!placed) flag('the Latin translation is not in the exported text layer');
    const firstPage = await pdfItems(`${DOWNLOADS}/${faithful}`, 1);
    const heading = firstPage.find((item) => item.str.includes('Sunset'));
    if (heading) {
      say('drawn at', `x ${heading.x} y ${heading.y} · ${heading.size}pt (source heading sat at x 56 y 760 · 18pt and had to shrink)`);
      if (Math.abs(heading.x - 56) > 2) flag(`the translation landed at x ${heading.x}, the source line starts at 56`);
      if (heading.size > 18.01) flag(`the translation was set at ${heading.size}pt — bigger than the source line it replaces`);
    } else {
      flag('could not find the translated heading in the exported page');
    }
    if (!info.pageInfo[0].words.includes('Signed at')) flag('the cover step took the untouched lines with it');
  }

  /* the same strip reaches the Converter: a photo page inset by the margins */
  await goto(page, '#/convert', 1500);
  await feed(page, '#cvDrop', ['wide.png']);
  await sleep(2400);
  const offsets = {};
  for (const mode of ['none', 'strip']) {
    await page.select('#cvMargin', mode);
    await sleep(320);
    const snap = snapshot();
    await page.evaluate(() => document.querySelector('#cvImagesGo').click());
    const file = await waitForDownload(snap, { seconds: 60 });
    offsets[mode] = file ? await imageOrigin(`${DOWNLOADS}/${file}`) : null;
    if (file) rmSync(`${DOWNLOADS}/${file}`, { force: true });
  }
  say('photo margins', `none → x ${offsets.none} · from the strip → x ${offsets.strip}`);
  if (Math.abs(offsets.none ?? 0) > 0.5) flag(`with no margin the photo should sit at x 0, not ${offsets.none}`);
  if (!(offsets.strip > 8)) flag(`"from the page strip" put the photo at x ${offsets.strip} — the margins did not reach the Converter`);
  await goto(page, '#/translate', 1800);

  /* keep the original and print the translation beside it */
  await page.select('#trOriginal', 'keep');
  await sleep(700);
  before = snapshot();
  await page.evaluate(() => document.querySelector('#trPdf').click());
  const sideBySide = await waitForDownload(before, { seconds: 90 });
  say('side-by-side export', sideBySide ?? 'NONE');
  if (sideBySide) {
    const info = await pdfInfo(`${DOWNLOADS}/${sideBySide}`);
    const firstPage = await pdfItems(`${DOWNLOADS}/${sideBySide}`, 1);
    const hasOriginal = firstPage.some((item) => item.str.includes('The quick brown fox'));
    const translationPage = await pdfItems(`${DOWNLOADS}/${sideBySide}`, 2);
    const hasTranslation = translationPage.some((item) => item.str.includes('Sunset'));
    say('side-by-side pages', `${info.pages} · original still on page 1: ${hasOriginal} · translation on page 2: ${hasTranslation}`);
    if (!hasOriginal) flag('the original text is gone even though "kept" was chosen');
    if (!hasTranslation) flag('the translation is not on the page after the original');
  }
  await page.select('#trOriginal', 'cover');
  await sleep(400);

  /* re-typeset, with document typography and one block overruled */
  await page.click('[data-fidelity="retype"]');
  await sleep(1200);
  const retyped = await page.evaluate(() => ({
    blocks: document.querySelectorAll('#trPaper .tr-block').length,
    headings: document.querySelectorAll('#trPaper h2.tr-block').length,
    selected: document.querySelectorAll('#trPaper .is-selected').length,
  }));
  say('re-typeset blocks', `${retyped.blocks} blocks · ${retyped.headings} headings`);
  if (retyped.blocks !== blocks) flag(`re-typeset shows ${retyped.blocks} blocks, extraction found ${blocks}`);

  await page.evaluate(() => {
    document.querySelectorAll('#trPaper .tr-block')[1]?.click();
  });
  await sleep(300);
  await page.click('#trBlockStyle [data-style="quote"]');
  await page.click('#trBlockAlign [data-align="right"]');
  await page.evaluate(() => {
    const node = document.querySelector('#trBlockSize');
    node.value = '15';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.select('#trFamily', 'georgia');
  await page.evaluate(() => {
    const set = (id, value) => {
      const node = document.querySelector(id);
      node.value = String(value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#trSize', 13);
    set('#trIndent', 14);
  });
  await sleep(900);
  const styles = await page.evaluate(() => {
    const sheet = document.querySelector('.tr-sheet');
    const list = [...document.querySelectorAll('#trPaper .tr-block')];
    const heading = list[0];
    const styled = list[1];
    return {
      family: getComputedStyle(sheet).fontFamily.split(',')[0],
      headingSize: parseFloat(getComputedStyle(heading).fontSize),
      bodySize: parseFloat(getComputedStyle(list[2]).fontSize),
      firstIndent: parseFloat(getComputedStyle(heading).textIndent),
      styledTag: styled?.tagName,
      styledSize: styled ? parseFloat(getComputedStyle(styled).fontSize) : null,
      styledAlign: styled ? getComputedStyle(styled).textAlign : null,
      overrides: JSON.parse(localStorage.getItem('folio:translate:v2')).blockOverrides,
    };
  });
  const bodyPx = 13 * (96 / 72);
  say('typography', `${styles.family} · heading ${styles.headingSize}px · body ${styles.bodySize}px (asked for ${bodyPx.toFixed(1)}) · indent ${styles.firstIndent}px · styled block ${styles.styledTag}/${styles.styledSize}/${styles.styledAlign}`);
  if (!/georgia/i.test(styles.family)) flag(`typeface did not follow the control (${styles.family})`);
  if (Math.abs(styles.bodySize - bodyPx) > 1.5) flag(`document size did not follow the control (${styles.bodySize}px, wanted ${bodyPx.toFixed(1)})`);
  if (styles.headingSize <= styles.bodySize) flag('the source hierarchy was lost — the heading is not bigger than the body');
  if (styles.firstIndent < 15) flag(`first-line indent did not apply (${styles.firstIndent}px)`);
  if (styles.styledAlign !== 'right') flag(`the per-block alignment was not applied (${styles.styledAlign})`);
  if (styles.styledSize === styles.bodySize) flag('the per-block size did not take');
  if (!styles.overrides || Object.keys(styles.overrides).length !== 1) flag(`expected exactly one block override, got ${JSON.stringify(styles.overrides)}`);

  before = snapshot();
  await page.evaluate(() => document.querySelector('#trPdf').click());
  const restyled = await waitForDownload(before, { seconds: 90 });
  say('re-typeset export', restyled ?? 'NONE');
  if (restyled) {
    const info = await pdfInfo(`${DOWNLOADS}/${restyled}`);
    const page = info.pageInfo[0];
    say('re-typeset page', `${info.sizes[0]}pt · ${info.pages} pages · ${page.words.length} chars of text · ${page.images} images`);
    // the re-typeset route is html2canvas + jsPDF, so the page arrives as a
    // picture (same as the Markdown studio's download) — check the geometry
    if (page.images < 1) flag('the re-typeset PDF has no page image — it did not render');
    const [w, h] = info.sizes[0].split('x').map(Number);
    if (Math.abs(w - 595) > 3 || Math.abs(h - 842) > 3) flag(`the re-typeset page is ${info.sizes[0]}pt, not the A4 sheet the strip asked for`);
    const streams = await pageStreams(`${DOWNLOADS}/${restyled}`);
    if (/1 1 1 rg/.test(streams)) flag('the re-typeset sheet is drawing the source boxes as well as the page (two exports mixed together)');
  }

  /* printing from this tab, with the shared page setup */
  await page.evaluate(() => {
    window.__prints = 0;
    window.print = () => { window.__prints += 1; };
  });
  await page.click('#panel-translate [data-print-go]');
  await sleep(400);
  const printed = await page.evaluate(() => ({ calls: window.__prints, tool: document.body.dataset.printTool }));
  say('print from translate', `${printed.calls}× · print tool “${printed.tool}”`);
  if (printed.calls !== 1 || printed.tool !== 'translate') flag(`translate printed ${printed.calls} times with tool “${printed.tool}”`);
}

/** The top-left of the first image drawn on page one, in points. */
async function imageOrigin(path) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false, verbosity: 0 }).promise;
  const viewPage = await doc.getPage(1);
  const ops = await viewPage.getOperatorList();
  let x = 0;
  let seen = false;
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    if (ops.fnArray[i] === pdfjs.OPS.paintImageXObject) break;
    if (ops.fnArray[i] === pdfjs.OPS.transform) {
      const [, , , , e, f] = ops.argsArray[i];
      x += e;
      seen = seen || Math.abs(e) > 0 || Math.abs(f) > 0;
    }
  }
  await doc.destroy();
  return seen ? +x.toFixed(1) : 0;
}

/** The inflated content streams of a PDF, straight from the file. */
async function pageStreams(path) {
  const raw = readFileSync(path);
  const text = raw.toString('latin1');
  const chunks = [];
  let index = 0;
  while (true) {
    const start = text.indexOf('stream', index);
    if (start === -1) break;
    const end = text.indexOf('endstream', start);
    if (end === -1) break;
    let from = start + 6;
    while (from < end && [10, 13, 32].includes(raw[from])) from += 1; // a stream may open with a newline
    const body = raw.subarray(from, end);
    try {
      chunks.push(inflateSync(Buffer.from(body)).toString('latin1'));
    } catch {
      /* not a deflate stream — skip it */
    }
    index = end + 9;
  }
  return chunks.join('\n');
}

/** Text items on a page, with the position pdf.js reports. */
async function pdfItems(path, pageNumber) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = readFileSync(path);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
  const viewPage = await doc.getPage(pageNumber);
  const content = await viewPage.getTextContent();
  const items = content.items.filter((item) => 'str' in item && item.str.trim()).map((item) => ({
    str: item.str,
    x: +item.transform[4].toFixed(1),
    y: +item.transform[5].toFixed(1),
    size: +Math.hypot(item.transform[2], item.transform[3]).toFixed(2),
  }));
  await doc.destroy();
  return items;
}

/* --------------------------------------------------------------- frame ---- */
/* The strip is meant to be one sheet for every tab: set it here, read it back
   from the previews, and make sure the studio's own controls still agree. Then
   the same numbers go through the printer and through PDF Lab's frame & trim,
   where they have to change the actual page. */
async function frame() {
  await goto(page, '#/markdown', 1400);

  const stripState = () => page.evaluate(() => {
    const strip = document.querySelector('#pageStrip');
    return {
      collapsed: strip.classList.contains('is-collapsed'),
      sheet: strip.querySelector('#pgSheet').value,
      preset: strip.querySelector('#pgPreset').value,
      unit: strip.querySelector('[data-unit].is-on')?.dataset.unit,
      readout: strip.querySelector('#pgReadout').textContent,
      values: [...strip.querySelectorAll('input[data-side]')].map((n) => `${n.dataset.side}=${n.value}`).join(' '),
    };
  });

  if ((await stripState()).collapsed) {
    await page.click('#pgToggle');
    await sleep(320);
  }
  await page.select('#pgSheet', 'a5');
  await page.select('#pgPreset', 'book');
  await sleep(420);
  const book = await stripState();
  say('strip preset', `${book.sheet} · ${book.preset} · ${book.unit} · ${book.values}`);
  say('strip readout', book.readout);

  const studio = await page.evaluate(() => {
    const paper = document.querySelector('#paper');
    const padding = getComputedStyle(paper).padding;
    const computed = padding.split(' ').map((v) => Math.round(parseFloat(v)));
    return {
      paperSize: paper.dataset.pageSize,
      studioPaper: document.querySelector('#paperSelect').value,
      studioMargin: document.querySelector('#marginSelect').value,
      status: document.querySelector('#paperStatus').textContent,
      padding: computed.join('/'),
      sides: {
        left: computed[3],
        right: computed[1],
        top: computed[0],
        bottom: computed[2],
      },
    };
  });
  say('studio followed', `${studio.paperSize} = ${studio.studioPaper} · ${studio.studioMargin} · ${studio.status}`);
  // measured against the numbers in the strip right now, gutter included
  const live = await stripState();
  const num = (key) => Number(live.values.match(new RegExp(`${key}=([\\d.]+)`))?.[1] ?? NaN);
  const mmToPx = 96 / 25.4;
  const wantLeft = (num('left') + num('gutter')) * mmToPx;
  const wantTop = num('top') * mmToPx;
  if (Math.abs(studio.sides.top - wantTop) > 1.5) flag(`studio sheet top padding ${studio.sides.top}px, expected ${wantTop.toFixed(0)}px`);
  if (Math.abs(studio.sides.left - wantLeft) > 1.5) flag(`studio sheet left padding ${studio.sides.left}px, expected ${wantLeft.toFixed(0)}px (gutter included)`);
  if (studio.padding.split('/').some((value) => value === 'NaN')) flag('studio sheet padding did not parse — the sheet has no margin');

  // per-side edit + units + mirror, then a fresh tab reads the same numbers back
  await page.evaluate(() => {
    const set = (side, value) => {
      const node = document.querySelector(`#pageStrip input[data-side="${side}"]`);
      node.value = String(value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('top', 24); set('bottom', 30);
  });
  await page.click('#pageStrip [data-unit="in"]');
  await sleep(420);
  const inches = await stripState();
  const topIn = Number(inches.values.match(/top=([\d.]+)/)?.[1]);
  if (Math.abs(topIn - 24 / 25.4) > 0.02) flag(`unit switch lost the value: ${topIn}in is not 24mm`);
  say('unit switch', `${topIn}in · preset ${inches.preset}`);
  if (inches.preset !== 'custom') flag('editing a side should mark the preset custom');

  await goto(page, '#/translate', 1400);
  const carried = await page.evaluate(() => {
    const strip = document.querySelector('#pageStrip');
    return {
      sheet: strip.querySelector('#pgSheet').value,
      top: strip.querySelector('input[data-side="top"]').value,
      unit: strip.querySelector('[data-unit].is-on')?.dataset.unit,
      paperPad: getComputedStyle(document.querySelector('.tr-sheet')).padding || '0px',
    };
  });
  say('carried to translate', `${carried.sheet} · top ${carried.top}${carried.unit ?? ''} · sheet padding ${carried.paperPad}`);
  if (carried.sheet !== 'a5') flag(`Translate did not inherit the paper size (${carried.sheet})`);

  const sheetPixels = await page.evaluate(() => {
    const sheet = document.querySelector('.tr-sheet');
    return { w: Math.round(sheet.offsetWidth), h: Math.round(sheet.offsetHeight) };
  });
  const a5 = { w: 148 * (96 / 25.4), h: 210 * (96 / 25.4) };
  if (Math.abs(sheetPixels.w - a5.w) > 6 || Math.abs(sheetPixels.h - a5.h) > 8) {
    flag(`preview sheet is ${sheetPixels.w}x${sheetPixels.h}px, an A5 page is ${Math.round(a5.w)}x${Math.round(a5.h)}px`);
  } else {
    say('preview sheet', `${sheetPixels.w}x${sheetPixels.h}px = A5 at 96dpi`);
  }

  // the printer gets @page, so every sheet keeps the margin (not just page one)
  await goto(page, '#/markdown', 1400);
  const printed = await page.evaluate(() => {
    window.__prints = 0;
    window.print = () => { window.__prints += 1; };
    document.body.dataset.printTool = '';
    document.querySelector('#exportButton').scrollIntoView({ block: 'center' });
    return window.folioPage.readoutText();
  });
  await page.click('#printButton');
  await sleep(400);
  const printState = await page.evaluate(() => ({
    calls: window.__prints,
    tool: document.body.dataset.printTool,
    style: document.querySelector('#folioPageStyle')?.textContent ?? '',
  }));
  say('print called', `${printState.calls}× with print tool “${printState.tool}” from ${printed}`);
  if (printState.calls !== 1) flag(`Print button called window.print ${printState.calls} times`);
  if (!/@page \{ size: 148mm 210mm/.test(printState.style)) flag(`@page did not take the A5 sheet: ${printState.style.slice(0, 120)}`);
  if (!/@page \{[^}]*margin: 2[0-9.]+mm/.test(printState.style)) flag(`@page did not take the margins: ${printState.style.slice(0, 160)}`);
  const printedPdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
  writeFileSync(`${DOWNLOADS}/print-${Date.now()}.pdf`, printedPdf);
  await sleep(300);
  const printedFile = files().find((name) => name.startsWith('print-'));
  if (printedFile) {
    const info = await pdfInfo(`${DOWNLOADS}/${printedFile}`);
    const page = info.pageInfo[0];
    const size = info.sizes[0];
    const marginPx = 24 * (96 / 25.4) * 0.75;
    const firstY = Number(page?.words ? 0 : 0);
    void firstY;
    say('print geometry', `${size}pt · ${info.pages} pages · text on page 1: ${page?.words.length ?? 0} chars`);
    const [px, py] = size.split('x').map(Number);
    if (Math.abs(px - 420) > 2 || Math.abs(py - 595) > 2) flag(`printed page is ${size}pt, A5 is 420x595pt`);
    const topItem = await page.marginProbe?.();
    void topItem;
    void marginPx;
    // the margin has to repeat: page two's first line starts inside the sheet too
    const second = await pdfTopLine(`${DOWNLOADS}/${printedFile}`, 2);
    const first = await pdfTopLine(`${DOWNLOADS}/${printedFile}`, 1);
    say('top line (pt from the top)', `page 1 ${first} · page 2 ${second}`);
    if (first && first < 45) flag(`page 1 starts ${first}pt from the top — the 24mm margin did not apply`);
    if (second && second < 45) flag(`page 2 starts ${second}pt from the top — the margin did not repeat on the next sheet`);
  } else {
    flag('the printed PDF never landed in the downloads folder');
  }

  // frame & trim: the file's own page box has to change, and stay text
  await goto(page, '#/pdf-lab', 1600);
  await feed(page, '#labDrop', ['alpha.pdf']);
  await sleep(2600);
  await page.click('[data-mode-btn="margins"]');
  await sleep(500);
  await page.evaluate(() => {
    const set = (id, value) => {
      const node = document.querySelector(id);
      node.value = String(value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.querySelector('[data-margin-unit="mm"]').click();
    set('#labMarginTop', 10); set('#labMarginRight', 0); set('#labMarginBottom', 0); set('#labMarginLeft', 20);
  });
  await sleep(500);
  say('frame hint', await text(page, '#labMarginHint'));
  let before = snapshot();
  await page.click('#labMarginGo');
  const framed = await waitForDownload(before, { seconds: 60 });
  say('framed file', framed ?? 'NONE');
  if (framed) {
    const info = await pdfInfo(`${DOWNLOADS}/${framed}`);
    say('framed geometry', `${info.sizes.slice(0, 2).join(' | ')} · ${info.pageCount ?? info.pages} pages`);
    const [w, h] = info.sizes[0].split('x').map(Number);
    // 20mm on the left, 10mm along the top: 56.7pt and 28.3pt
    if (Math.abs(w - 651.7) > 4 || Math.abs(h - 870.3) > 4) flag(`framed page is ${info.sizes[0]}pt, 652x870 expected (20mm left, 10mm top)`);
    const words = info.pageInfo[0].words.length;
    if (words < 100) flag(`framed page lost its text (${words} chars) — it should stay selectable`);
    else say('framed text', `${words} characters still selectable`);
  }

  await page.evaluate(() => {
    const set = (id, value) => {
      const node = document.querySelector(id);
      node.value = String(value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const radio = document.querySelector('[name="marginAction"][value="trim"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#labMarginCopy').click();
    set('#labMarginTop', 30); set('#labMarginRight', 30); set('#labMarginBottom', 30); set('#labMarginLeft', 30);
  });
  await sleep(600);
  say('trim hint', await text(page, '#labMarginHint'));
  before = snapshot();
  await page.click('#labMarginGo');
  const trimmed = await waitForDownload(before, { seconds: 60 });
  say('trimmed file', trimmed ?? 'NONE');
  if (trimmed) {
    const info = await pdfInfo(`${DOWNLOADS}/${trimmed}`);
    say('trimmed geometry', `${info.sizes.slice(0, 2).join(' | ')}`);
    const [w, h] = info.sizes[0].split('x').map(Number);
    if (Math.abs(w - 425) > 4 || Math.abs(h - 672) > 4) flag(`trimmed page is ${info.sizes[0]}pt, 425x672 expected (30mm off each edge)`);
  }
}

/** How far the first line of text sits from the top of a printed page. */
async function pdfTopLine(path, pageNumber) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = readFileSync(path);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
  const viewPage = await doc.getPage(pageNumber);
  const content = await viewPage.getTextContent();
  const views = viewPage.getViewport({ scale: 1 });
  let top = null;
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const y = views.height - item.transform[5];
    top = top === null ? y : Math.min(top, y);
  }
  await doc.destroy();
  return top === null ? null : +top.toFixed(1);
}

async function audit() {
  for (const size of SIZES) {
    const [w, h] = size.split('x').map(Number);
    await page.setViewport({ width: w, height: h });
    for (const tab of TABS) {
      await goto(page, `#/${tab === 'markdown' ? '' : tab}`, tab === 'markdown' ? 1000 : 1500);
      const result = await page.evaluate(() => {
        const doc = document.documentElement;
        const clipped = [];
        for (const node of document.querySelectorAll('.tool-panel:not([hidden]) *, #siteHeader > *, #siteFooter *')) {
          const rect = node.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          const scroller = node.closest('.tool-nav-scroll, .editor-toolbar, [data-overflow-ok]');
          if (!scroller && (rect.right > window.innerWidth + 1.5 || rect.left < -1.5)) {
            clipped.push(`${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}@${Math.round(rect.left)}-${Math.round(rect.right)}`);
          }
          if (!node.children.length && node.textContent.trim() && node.scrollWidth - node.clientWidth > 2 && getComputedStyle(node).overflowX === 'hidden') {
            clipped.push(`CLIP:${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]} "${node.textContent.trim().slice(0, 16)}"`);
          }
        }
        const nav = document.querySelector('#toolNav .tool-nav-scroll');
        const active = document.querySelector('#toolNav [data-tool].is-active');
        if (nav && active) {
          const box = nav.getBoundingClientRect();
          const card = active.getBoundingClientRect();
          if (card.left < box.left - 1.5 || card.right > box.right + 1.5) {
            clipped.push(`NAV:${active.dataset.tool} card ${Math.round(card.left)}-${Math.round(card.right)} is outside the strip ${Math.round(box.left)}-${Math.round(box.right)}`);
          }
        }
        return { overflow: doc.scrollWidth - doc.clientWidth, clipped: [...new Set(clipped)].slice(0, 4) };
      });
      if (result.overflow > 0) flag(`${size} ${tab}: horizontal overflow ${result.overflow}px`);
      if (result.clipped.length) flag(`${size} ${tab}: ${result.clipped.join(' | ')}`);
      await page.screenshot({ path: `${SHOTS}/${size}-${tab}.png`, clip: { x: 0, y: 0, width: w, height: Math.min(h, 1000) } }).catch(() => {});
    }
    say(size, 'checked');
  }
}

async function touch() {
  await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
  await goto(page, '#/sign', 2400);
  // a touch draw: the pad must take the gesture instead of scrolling the page
  const drawn = await page.evaluate(() => new Promise((resolve) => {
    const canvas = document.querySelector('#sgPad');
    const rect = canvas.getBoundingClientRect();
    const at = (fx, fy) => ({ clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy });
    const send = (type, fx, fy) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      buttons: type === 'pointerup' ? 0 : 1,
      ...at(fx, fy),
    }));
    send('pointerdown', 0.16, 0.62);
    for (const [fx, fy] of [[0.3, 0.24], [0.46, 0.72], [0.62, 0.28], [0.8, 0.64]]) send('pointermove', fx, fy);
    send('pointerup', 0.8, 0.64);
    setTimeout(() => resolve({ pad: [Math.round(rect.width), Math.round(rect.height)], note: document.querySelector('#sgPadNote').textContent }), 500);
  }));
  say('pad on a phone', `${drawn.pad.join('x')} · ${drawn.note}`);
  await page.click('#sgSaveMark');
  await sleep(800);
  say('marks kept', await text(page, '#sgMarkCount'));
  await page.click('[data-mode-btn="place"]');
  await sleep(600);
  await feed(page, '#sgDrop', ['alpha.pdf']);
  await sleep(3800);
  await placeParty('a', 'bottom-center');
  await sleep(900);
  const geo = await page.evaluate(() => {
    const paper = document.querySelector('#sgPaper').getBoundingClientRect();
    const node = document.querySelector('.sg-handle[data-handle="a"]');
    if (!node || node.hidden) return 'HIDDEN';
    const r = node.getBoundingClientRect();
    return { handle: [Math.round(r.width), Math.round(r.height)], left: Math.round(r.x - paper.x), smallest: Math.round(Math.min(r.width, r.height)), docHeight: document.documentElement.scrollHeight };
  });
  say('phone placement', typeof geo === 'string' ? geo : `handle ${geo.handle.join('x')} at x${geo.left} · tap target ${geo.smallest}px · page ${geo.docHeight}px tall`);
  if (typeof geo === 'string') flag('the signature handle is not shown on a phone');
  else if (geo.smallest < 24) flag(`the signature handle is only ${geo.smallest}px tall to tap on a phone`);
  await page.screenshot({ path: `${SHOTS}/sign-390.png` });
  const before = snapshot();
  await page.click('[data-mode-btn="seal"]');
  await sleep(400);
  await page.click('#sgSignGo');
  const name = await waitForDownload(before);
  say('phone signed file', name ?? 'NONE');
  if (!name) flag('no signed file was produced on a phone-sized viewport');
}

const isolated = {
  frame: () => session(frame),
  trfmt: () => session(trfmt),
  pad: () => session(pad),
  sign: () => session(sign),
  touch: () => session(touch),
  finish: () => session(finish),
  regress: () => session(regress),
  audit: () => session(audit),
  all: async () => {
    await session(frame);
    await session(trfmt);
    await session(pad);
    await session(sign);
    await session(touch);
    await session(finish);
    await session(regress);
    await session(audit);
  },
};

if (!isolated[step]) {
  console.error(`unknown step "${step}" — pick one of ${Object.keys(isolated).join(', ')}`);
  process.exit(2);
}

try {
  await isolated[step]();
} catch (error) {
  flag(`harness threw: ${error?.message ?? error}`);
} finally {
  if (browser) await browser.close();
}
const code = report(step);
console.log(`• downloads: ${files().join(', ') || 'none'}`);
process.exit(code ? 1 : 0);

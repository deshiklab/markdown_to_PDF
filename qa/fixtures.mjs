/* Folio QA fixtures — small PDFs and images written on demand so the browser
   harness has something real to load. Nothing here is committed; the files live
   in qa/.fixtures/. Requires the project's own pdf-lib. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '.fixtures');
mkdirSync(FIXTURES, { recursive: true });

const LINES = [
  'The quick brown fox jumps over the lazy dog. Section one of alpha.',
  'Patient Zero signed the ACME Corp agreement on 12 March 1999.',
  'Nothing else worth redacting on this page, only prose.',
];

async function pdf(name, { pages = 3, rotate = 0, title = name } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor('Deshika Rahman');
  doc.setProducer('folio qa fixtures');
  doc.setCreationDate(new Date('2024-05-02T09:15:00'));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${name} — page ${index + 1}`, { x: 56, y: 760, size: 18, font: bold, color: rgb(0.15, 0.2, 0.17) });
    LINES.forEach((line, offset) => page.drawText(line, { x: 56, y: 700 - offset * 26, size: 11, font, color: rgb(0.25, 0.28, 0.25) }));
    page.drawText('Signed at: ______________________', { x: 56, y: 120, size: 10, font, color: rgb(0.3, 0.32, 0.3) });
    if (rotate) page.setRotation(degrees(rotate));
  }
  const bytes = await doc.save();
  writeFileSync(join(FIXTURES, `${name}.pdf`), bytes);
  return join(FIXTURES, `${name}.pdf`);
}

/* A plain PNG made from raw scanlines — no image library needed. */
function png(width, height, shift) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width * 3 + 1);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = Math.round((Math.sin((x + shift) / 26) * 0.5 + 0.5) * 205 + 25);
      row[2 + x * 3] = Math.round((Math.sin((y - shift) / 21) * 0.5 + 0.5) * 185 + 35);
      row[3 + x * 3] = Math.round((Math.sin((x + y) / 34) * 0.5 + 0.5) * 195 + 45);
    }
    rows.push(row);
  }
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc = (buf) => {
    let c = -1;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function images() {
  const out = {};
  for (const [name, w, h, shift] of [['wide', 900, 560, 0], ['tall', 600, 900, 40], ['square', 700, 700, 90]]) {
    const path = join(FIXTURES, `${name}.png`);
    writeFileSync(path, png(w, h, shift));
    out[name] = path;
  }
  return out;
}

export async function makeFixtures() {
  const out = {
    alpha: await pdf('alpha', { pages: 3, title: 'Alpha document' }),
    beta: await pdf('beta', { pages: 2, title: 'Beta document' }),
    rot90: await pdf('rot90', { pages: 2, rotate: 90, title: 'Rotated page fixture' }),
    ...images(),
  };
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('fixtures.mjs')) {
  const made = await makeFixtures();
  for (const [name, path] of Object.entries(made)) console.log('  fixture', name.padEnd(7), path.replace(`${FIXTURES}/`, ''));
}

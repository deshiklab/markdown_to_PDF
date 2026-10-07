# qa/ — the browser harness

Folio's tools write real files, so the only honest way to check them is to drive
the page in a browser and read the output back. This folder does that. It is
development tooling only: nothing here ships in the bundle, and the fixtures are
synthetic — the harness never touches your documents.

## Run it

```bash
npm run dev -- --host 0.0.0.0 --port 5173   # in one terminal
npm i --no-save puppeteer-core @sparticuz/chromium   # deliberately not a project dependency
npm run qa:fixtures
npm run qa -- sign          # or: finish, regress, audit, all
```

`npm run qa -- all` runs everything and exits non-zero if anything is wrong. The
URL is taken from `FOLIO_URL` (default `http://127.0.0.1:5173/`).

Chromium from `@sparticuz/chromium` needs a few shared libraries that are missing
on some images. If the browser refuses to start, unpack them once:

```bash
mkdir -p /tmp/al2023 && node -e "
const fs=require('fs'),zlib=require('zlib');
fs.writeFileSync('/tmp/al2023/a.tar', zlib.brotliDecompressSync(fs.readFileSync('node_modules/@sparticuz/chromium/bin/al2023.tar.br')));" \
  && tar -xf /tmp/al2023/a.tar -C /tmp/al2023
```

The harness picks up `/tmp/al2023/lib` (or `qa/.chromium-lib`) automatically.

## What each step covers

| Step | What it proves |
| --- | --- |
| `pad` | The pad's geometry at nine widths: the canvas bitmap matches the CSS box inside its 1 px frame, a stroke lands where the pointer went, and a panel that re-measures itself (a rotate, an on-screen keyboard, a breakpoint) neither drops the ink nor slides it — coordinates are stored as fractions, so the saved mark matches what was drawn |
| `touch` | A 390 px phone with `hasTouch`: draw with touch pointer events, save the mark, place it, drag a 70 px handle by tap, and download the signed file |
| `sign` | Drawing on the pad saves a cropped PNG, the library survives a reload, a placed mark lands where the overlay showed it (measured by diffing the rendered page before and after signing), `/Rotate 90` pages are honoured, captions reach the text layer, and *Flatten* really removes the page's text |
| `finish` | Fields read back and are written without clobbering the author, `{page} of {total}` footers land on the pages, redaction finds terms across text runs and destroys characters only when flattening is on, and the digest round-trips |
| `regress` | Every other tab still exports: studio PDF, merge, watermark, split ZIP, translation exports, photos → PDF, the photo book |
| `audit` | Nine viewport widths × seven tabs: no horizontal overflow, nothing clipped by `overflow: hidden`, no console errors |

Artifacts land in `qa/out/` — downloaded PDFs in `qa/out/downloads/`, screenshots
in `qa/out/shots/`. Both are gitignored, along with the generated `qa/.fixtures/`.

## Writing a check

Prefer measurements over appearances: read the PDF back with `pdfInfo()` (pdf-lib
+ pdf.js from the project's own `node_modules`) or diff rendered pixels, as
`qa/drive.mjs` does. `flag()` records a problem and the run exits non-zero, so a
suite that prints `sign: clean` is one that passed.

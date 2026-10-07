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
npm run qa -- trfmt         # or: frame, pad, sign, touch, finish, regress, audit, all
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
| `frame` | The shared page setup, end to end: paper + preset + a per-side edit + a unit switch in the strip reach the studio's sheet (padding in px, gutter included), carry to another tab, and size the Translate preview to a real A5 at 96 dpi; the Print button calls `window.print` once with `data-print-tool` set and an `@page` rule carrying the sheet *and* its margins; `page.pdf()` comes back at 420×595 pt with the first line of text 75 pt down on page one **and on page two** (padding would have lost it); PDF Lab's Frame & trim grows 595×842 to 652×870 pt with the text still selectable, and trims it to 425×672; the Converter's "from the page strip" insets the photo by 52.9 pt where "none" leaves it at 0 |
| `trfmt` | Translate's two promises. Extraction finds 15 blocks in the 3-page fixture and offers one row per block; the page-faithful export is a copy of the original with white fills over the source lines, the Latin translation in the text layer (found at x 56, the source line's own left edge, at 16.9 pt because the longer text had to shrink) and the Bengali drawn as one image; *keep the original* doubles the pages and leaves the source text intact; re-typeset honours the typeface, size, first-line indent and hierarchy and applies a per-block override (a quote, 15 pt, right-aligned); the re-typeset PDF is the A4 sheet the strip asked for; Print fires once from this tab |
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

Three traps this harness has already hit, worth knowing before adding a check:

- `html { scroll-behavior: smooth }` animates *every* scroll, including the ones
  the harness makes. A `scrollIntoView()` inside a pointer gesture leaves the
  page still gliding, so the ink lands somewhere else. Always scroll with
  `{ behavior: 'instant' }`, and give the page a frame to settle.
- Chromium overwrites a download that reuses a filename instead of adding
  ` (1)`, so `snapshot()` records name **and size/mtime**: two exports of the
  same document would otherwise look like one.
- Sticky chrome (the tab bar and the page strip) covers the top of a panel, and
  Puppeteer's own scroll can leave a button underneath it — the click then lands
  on the strip. `page.click` in `lib.mjs` centres the target and nudges it clear
  of the sticky bars first.

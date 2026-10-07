# Folio — Markdown to PDF, and friends

A small, private, browser-based document studio. Write Markdown and export it as a PDF, stitch PDFs together, translate a document line by line, turn a folder of photos into a printed-looking portfolio, swap between photos, pages and text, and give a document its last pass before it goes out. Every tool runs in the browser: no upload, no account, no server round-trip.

## What is in it

| Tab | What it does | Where the work happens |
| --- | --- | --- |
| **Markdown → PDF** | The editor: GFM preview, three document themes, autosave, and a print-ready download on the shared paper setup (below) | `src/app-core.js`, html2pdf.js |
| **PDF Lab** | Merge and reorder pages from several PDFs, rotate a page or a whole file, skip pages, split one file into ranges or fixed-size chunks, stamp a text watermark with size, opacity, angle, colour and placement, and **frame or trim the real page box** — add a printable border around every page or cut a fat binding edge off, in mm, inches or points, with the text still selectable | `pdf-lib` + `pdf.js` for page thumbnails |
| **Translate PDF** | Pull each page's text out **block by block with its exact position and size**, translate it live, and write it back either **on the page** (the original layout survives — tables, images and columns stay put) or **re-typeset** on the shared paper with document-wide typography and per-block overrides | `pdf.js` for extraction and the page underlay, `pdf-lib` for the page-faithful export, html2pdf for the re-typeset one, one network call per block for the translation itself |
| **Converter** | Photos → PDF (page size, fit, margins from the page strip or a plain 8/18 mm border, quality), PDF → Markdown text, PDF → PNG/JPEG images, and a "shrink images" pass that keeps filenames | canvas + `pdf-lib` + `fflate` for ZIPs |
| **Photo Portfolio** | A photo book with cover, plates, colophon and page numbers — six layouts, five paper sizes, three tones, caption and numbering switches, then export as a PDF book | canvas compositing + html2pdf |
| **Sign** | Draw a signature on a pad (or drop in a scan and knock the paper out), keep marks in this browser, then place one on the dotted line with a name, title and date under it — with a second pad for whoever is countersigning, snap-to corners, nudging by hand, and an optional flatten so the mark cannot be lifted off | pointer events on a canvas, `pdf-lib` for `embedPng` and the drawing, `pdf.js` for the live page you drag on |
| **Finish** | One file, four small jobs: read and rewrite the document fields (title, author, subject, keywords, creator, dates), stamp `{page}`/`{total}` footers with placement, size, margin and range, black out terms — optionally flattening the page so the characters really are gone — and take or verify a SHA-2/SHA-3 checksum with a sidecar `.sum` file | `pdf-lib` for the writing, `pdf.js` for the text layer and the live preview, `crypto.subtle` for the digest |

Tabs load on demand, so the editor stays fast and only the tool you open pulls in its library. `src/shell.js` owns the tab strip, hash routing (`#/pdf-lab`), keyboard roving focus, the panel switcher on phones, and a per-tab intro line; each tool is a module that exports `start(root)`.

## Page & print

One strip sits under the tab bar, on every tab, and it is the single source of truth for paper: **A4, US Letter, US Legal, A5, A3, square and 6×4 postcard**, portrait or landscape, and margins in **mm, inches or points**. Margins come as presets (Comfortable, Compact, Wide, **Book / bound** with a binding gutter that can mirror to the inside edge, Near bleed) or as four free per-side fields, plus a print scale and a switch for printing background colour. The strip folds to a single line on a phone and unrolls when you tap it.

That one setting is used by:

- the studio preview and its **Download PDF**,
- **Translate**'s preview sheet and its exports,
- **Portfolio**'s book (its Paper control writes back to the strip, so the preview, the export and a print all agree),
- **Converter**'s photo pages, which default to "From the page strip",
- **PDF Lab**, **Finish** and **Sign** as the sheet their Print button prints on.

Every tab carries a **Print** button. Printing uses real `@page` margins rather than padding on the sheet — padding is applied once, at the top of the box, so page two of a long document would start at the very edge of the paper. `@page` margins repeat on every sheet, which is exactly what a printer needs, and the preview sheet shows the same numbers.

## Run it

```bash
npm install
npm run dev
```

Open the local URL Vite prints, usually `http://localhost:5173/`. Production build:

```bash
npm run build
npm run preview
```

### Opening `index.html` straight from disk

Double-clicking `index.html` still works, but browsers refuse to import ES modules from a `file://` origin, so **only the Markdown studio runs in that mode** — the other tabs say so and point back at `npm run dev`. If you want the whole studio offline, build once and serve the folder:

```bash
npm run build
npx serve dist   # or any static server
```

## Privacy

Files never leave the browser: parsing, thumbnails, rasterising, ZIPs and PDF writing all happen locally, and settings live in `localStorage`. The single exception is translation, which by nature has to ask a model for a translation. That request goes from your browser directly to the provider you pick, never through Folio infrastructure, and it is opt-in per run:

- **Google (free endpoint)** — best quality, up to about 4500 characters per request.
- **MyMemory** — smaller requests, generous anonymous quota.
- **Self-hosted LibreTranslate** — paste your own server URL and optional API key; nothing goes anywhere else.
- **No translation service** — extract the lines and type each translation yourself. Nothing is sent anywhere, and the preview, downloads and PDF export keep working as you type.

Signatures are kept as small PNGs in `localStorage` under this browser profile — clear your site data and they are gone, and nothing is synced anywhere. A placed signature is a picture drawn onto the page, not a digital signature: there is no certificate, and nothing in the file proves it was not edited afterwards. Tick **Flatten the signed pages** if the mark must not be liftable, and take a checksum in the Finish tab when you want proof of which file you sent.

Useful to know: PDFs written by PDF Lab and Converter keep the text layer of your source pages, and so does Translate's **On the page** mode. That mode draws the translation in the same place, at the same size, in the same column as the block it replaces, shrinking the type when the new words are longer rather than reflowing the page — so a table, a figure or a two-column layout is still where it was. Latin scripts go in as real, selectable text; a script the PDF standard fonts cannot encode (Bengali, Arabic, Devanagari, Thai, CJK…) is drawn as a crisp picture of the paragraph instead, because there is no font to embed and nothing is downloaded to make one. **Re-typeset** mode pours the same blocks onto a fresh sheet from the page setup above: click any block in the preview (or the eye beside a row) to give it its own alignment, size, weight or type, and the document-wide typography — typeface, size, line height, paragraph gap, first-line indent, alignment, right-to-left — carries the rest. A source PDF does not need to be a "good" PDF for this: extraction works line by line, then groups lines into blocks by baseline and leading.

Portfolio lays text on the page with PDF standard fonts, so it is Latin-only for now. Finish paints an opaque layer over redacted words, which hides them but does not remove them — tick **Flatten page to image** when the text itself has to go.

## Notes for development

- `pdfjs-dist` is pinned to **4.10.38**. Later 5.x builds call `Uint8Array.prototype.toHex()`, which is only available in very recent browsers, and page previews break everywhere older.
- `vite.config.js` copies pdf.js `cmaps` and `standard_fonts` into `dist/pdfjs/` (and points at `node_modules/pdfjs-dist` during `npm run dev`) so documents with non-ASCII encodings parse instead of failing silently.
- Tool modules must not import a heavy library at the top level of the app entry — add them to the `loaders` map in `src/main.js` and they will only load when the tab opens.
- Shared pieces live in `src/lib.js` (DOM, files, toasts, lazy loaders, local prefs), `src/page.js` (the page setup every tab reads and the strip that edits it), `src/render.js` (the paper maths `exportHtmlAsPdf` and Portfolio use), `src/textimage.js` (laying text out into a canvas — wrapping, alignment, RTL, shrink-to-fit — for the places a PDF font cannot go) and `src/styles.css` (the whole design system, including every tool).
- `src/page.js` stores **millimetres** and derives everything else: the `@page` rule, the on-screen sheet (`--pg-pad`, `--pg-sheet`), the pixel padding for HTML→PDF exports (`marginCss(spec, 0, 'px')`) and PDF Lab's page-box maths. `@page`'s margin is the *printed* margin and repeats on every sheet; the sheet itself carries no padding in print, or page two would start at the paper's edge. A print scale below 100 works by growing the `@page` margins, since `@page` has no scale of its own.
- `qa/` is a headless browser harness: `npm run qa -- all` drives every tab (steps `frame`, `trfmt`, `pad`, `sign`, `touch`, `finish`, `regress`, `audit`), reads the PDFs back with `pdf-lib` and pdf.js, and exits non-zero when a check fails. `frame` covers the shared page setup end to end (strip → studio → preview → `@page` → printed millimetres, then PDF Lab's page boxes and the Converter's insets); `trfmt` covers the translation (extraction, the page-faithful export's content stream, keep-the-original, re-typeset typography, per-block overrides). It needs `puppeteer-core` and `@sparticuz/chromium`, which are deliberately **not** project dependencies — `npm i --no-save` them. See `qa/README.md`.
- Two pdf.js traps this codebase has already hit: `page.render()` resolves through its `.promise` **property** (calling `.promise()` throws, and the preview then paints but never finishes its bookkeeping), and pdf.js refuses a second render task on a canvas element it has painted before — Sign swaps in a fresh `<canvas>` for each repaint.
- The Sign pad keeps every stroke as **fractions of the pad box**, never as pixels inside it: the panel is a sidebar on a desktop and full width on a phone, and a phone re-measures itself when the keyboard appears. The same points feed the exported mark, so pixel coordinates would save a signature that is stretched. The canvas bitmap is sized to the box *inside* its 1 px frame (`clientWidth`/`clientHeight`), otherwise the ink sits slightly off the pen.
- `.tool-nav-scroll` uses `scroll-snap-type: x proximity` with `scroll-snap-align: center` on the cards, so a scroll position that is not centred on a card gets nudged back. Anything that brings the active tab into view (`keepActiveTabVisible` in `src/shell.js`) must aim for the centred position — and must run on resize and after `document.fonts.ready`, not only on click.
- Anything drawn onto a page has to be placed in the page's *display* space and mapped into PDF space with the `/Rotate` quadrant maths (`displayToPdf` in `src/tools/sign.js`, the inverse of the stamp maths in `finish.js`). Overlay handles should be positioned in percentages of the page box, never in measured pixels, or they race the browser's first layout.
- `frames()` for HTML→PDF exports — the second argument of `scaleContent`, and the x/y translation — are **added** to whatever the page already had, not absolute. Translate's "fit onto the paper" sets a fresh media box first, so the addition lands where it should; a page with an odd `/Rotate` needs its four margins rotated into page space before they are applied (the reader's "top" is not the page's `top` on a 90° sheet).
- A sheet that a scaler measures must not also be sized by it: `.paper[data-page-size]` takes its width from `var(--pg-w)` (the paper), not from its container `100%`, or `.tr-scaler` and the sheet chase each other down to nothing on first paint.
- Printing is driven through `printSheet()` in `src/page.js`, which marks `body[data-print-tool]` so only the standing tool's sheet is visible to the printer and no off-screen export scaffolding is dragged onto the paper. `@media print` hides `.paper.pdf-export-page` — the HTML→PDF stage is in the DOM, and without that it printed a second copy.
- Preview canvases paint into an off-screen buffer and are blitted in one go (Translate's overlay): a keystroke and a resize can both start a repaint, and two `drawImage` passes interleaving on the visible canvas leaves the original text showing through the boxes.

## Responsive behaviour

The layout was audited in a real browser from `320px` to `1600px`:

- One shared `--page-pad` gutter token keeps full-bleed elements (the tab strip, panel edges) inside the viewport, so nothing triggers sideways scroll; `overflow-x: clip` is the safety net, not the mechanism.
- The tab strip is a scrollable, masked list with prev/next arrows on wider screens and snap on touch; `←`/`→`/`Home`/`End` move between tabs, and on phones the same seven tabs become a big tap target switcher above the panel. The card you are standing on is kept fully inside the strip — on load, on a click, after a rotate and after the web font re-measures the cards — so an active tab is never half cut off by the edge fade.
- Studio panels are side-by-side from `1120px` up, and switch to two full-height tabs (Editor / Preview) below `900px`.
- Every tool uses auto-fit grids, so file lists, photo grids, watermarks and controls reflow at 1, 2, 3 and 4 columns without breakpoint soup.
- Touch: `pointer: coarse` grows icon buttons to 34px, always shows hover-only actions, hides the file-type chip line, and pins the toast above the safe area.
- `prefers-reduced-motion: reduce` and `forced-colors: active` are both handled.
- The tab strip fades its edges only when it can actually scroll, and switching tabs while deep in a long tool brings the strip back into view instead of leaving you at the new tool's footer.
- Micro copy is legible: every label under 10.5px was darkened to at least 4.5:1 against the paper (the design still reads quiet, it just no longer needs a magnifier).
- The page strip is sticky under the tab bar while the tools run and stops sticking at the end of the panels, so it never floats over the ideas list or the footer. On a phone it folds to one line (`A4 · 16mm margin · actual size`) with its own Print button, and opens into a two-column board rather than a wall of full-width fields. On a short screen (`max-height: 780px`) it does not stick at all: it would otherwise eat a fifth of the window.
- `@media print` prints the sheet, not the app: toolbars, side panels and notices collapse, so Cmd-P from the studio or the Translate preview gives a clean document whose margins are the ones in the strip, and the Portfolio book prints one page per sheet.

## More tools on the bench

Rough notes for what comes next, also listed at the bottom of the page: **sign and countersign** (a pad you can drag onto a page, then export a signed-looking file), **batch rename & merge** (a folder of files named `01 - Title.pdf` becomes one book in order), **bookmarks & links** (read a PDF's outline, split by it, rewrite the links inside), **OCR for scans** (Tesseract.js, so photographed pages become searchable text), **Exif studio**, a **print dialog sheet** with bleed and crop marks, a **zine maker**, and **invoice & letterhead** templates.

Shipped from that list already: the signature pad and countersignature flow (the Sign tab), the PDF metadata editor, page-number and footer stamps and PDF checksum + redaction (the four panels of the Finish tab), plus **page & print everywhere and real page framing** — the shared sheet in every tab, Print in every tab, and Frame & trim in PDF Lab. Still open from the older notes: watermark removal, extract selected pages, compress and flatten, DPI presets, and a bleed/crop-mark preset that builds on Frame & trim.

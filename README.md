# Folio — Markdown to PDF, and friends

A small, private, browser-based document studio. Write Markdown and export it as a PDF, stitch PDFs together, translate a document line by line, turn a folder of photos into a printed-looking portfolio, and swap between photos, pages and text. Every tool runs in the browser: no upload, no account, no server round-trip.

## What is in it

| Tab | What it does | Where the work happens |
| --- | --- | --- |
| **Markdown → PDF** | The editor: GFM preview, three document themes, A4 / US Letter / A5, three margins, portrait or landscape, print-ready download, autosave | `src/app-core.js`, html2pdf.js |
| **PDF Lab** | Merge and reorder pages from several PDFs, rotate a page or a whole file, skip pages, split one file into ranges or fixed-size chunks, stamp a text watermark with size, opacity, angle, colour and placement | `pdf-lib` + `pdf.js` for page thumbnails |
| **Translate PDF** | Pull text out page by page, translate each segment live into a bilingual editor, keep the source visible, export a translated PDF or Markdown | `pdf.js` for extraction, `pdf-lib` + html2pdf for output, one network call for the translation itself |
| **Converter** | Photos → PDF (page size, fit, margin, quality), PDF → Markdown text, PDF → PNG/JPEG images, and a "shrink images" pass that keeps filenames | canvas + `pdf-lib` + `fflate` for ZIPs |
| **Photo Portfolio** | A photo book with cover, plates, colophon and page numbers — six layouts, five paper sizes, three tones, caption and numbering switches, then export as a PDF book | canvas compositing + html2pdf |

Tabs load on demand, so the editor stays fast and only the tool you open pulls in its library. `src/shell.js` owns the tab strip, hash routing (`#/pdf-lab`), keyboard roving focus, the panel switcher on phones, and a per-tab intro line; each tool is a module that exports `start(root)`.

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

Useful to know: PDFs written by PDF Lab and Converter keep the text layer of your source pages. The Translate and Portfolio tabs lay text on the page with PDF standard fonts, which cover Latin script — for Bengali, Arabic, CJK and friends, the translation is fully visible in the bilingual **two-column PDF** and in the Markdown export, and non-Latin source pages still come through as images in **Show original** mode.

## Notes for development

- `pdfjs-dist` is pinned to **4.10.38**. Later 5.x builds call `Uint8Array.prototype.toHex()`, which is only available in very recent browsers, and page previews break everywhere older.
- `vite.config.js` copies pdf.js `cmaps` and `standard_fonts` into `dist/pdfjs/` (and points at `node_modules/pdfjs-dist` during `npm run dev`) so documents with non-ASCII encodings parse instead of failing silently.
- Tool modules must not import a heavy library at the top level of the app entry — add them to the `loaders` map in `src/main.js` and they will only load when the tab opens.
- Shared pieces live in `src/lib.js` (DOM, files, toasts, lazy loaders, local prefs), `src/render.js` (the paper maths both `exportHtmlAsPdf` and Portfolio use) and `src/styles.css` (the whole design system, including every tool).

## Responsive behaviour

The layout was audited in a real browser from `320px` to `1600px`:

- One shared `--page-pad` gutter token keeps full-bleed elements (the tab strip, panel edges) inside the viewport, so nothing triggers sideways scroll; `overflow-x: clip` is the safety net, not the mechanism.
- The tab strip is a scrollable, masked list with prev/next arrows on wider screens and snap on touch; `←`/`→`/`Home`/`End` move between tabs, and on phones the same five tabs become a big tap target switcher above the panel.
- Studio panels are side-by-side from `1120px` up, and switch to two full-height tabs (Editor / Preview) below `900px`.
- Every tool uses auto-fit grids, so file lists, photo grids, watermarks and controls reflow at 1, 2, 3 and 4 columns without breakpoint soup.
- Touch: `pointer: coarse` grows icon buttons to 34px, always shows hover-only actions, hides the file-type chip line, and pins the toast above the safe area.
- `prefers-reduced-motion: reduce` and `forced-colors: active` are both handled; `@media print` still prints only the paper sheet.

## More tools on the bench

Rough notes for what comes next, also listed at the bottom of the page: PDF checksum + redaction, batch rename & merge, signature pad, OCR for scans (Tesseract.js), Exif studio, print dialog sheet with bleed and crop marks, zine maker, invoice & letterhead, page-number and footer stamps, watermark removal, extract selected pages, PDF metadata editor, compress and flatten, DPI presets, split by bookmarks, and a canvas for signing or annotating.

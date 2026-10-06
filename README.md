# Folio — Markdown to PDF

A small, private, browser-based Markdown editor and PDF converter. Paste Markdown or open a local `.md` file, adjust the PDF style and page size, preview it live, then download a print-ready PDF. Source files stay in the browser; no upload or account is required.

## Open directly in your browser

1. Install the local dependencies once from the project folder:

   ```bash
   npm install
   ```

2. Open `index.html` in your browser (double-click it, or choose **Open File** in your browser).

The direct-file mode loads its Markdown, sanitizing, PDF, and font libraries from the local `node_modules` folder. No development server or internet connection is needed after `npm install` completes.

## Run with the Vite development server

```bash
npm run dev
```

Open the local URL Vite prints, usually `http://localhost:5173/`. This mode is useful for development and hot reload. Avoid opening `index.html` with a generic static server; use Vite so package imports are bundled correctly.

For a production build:

```bash
npm run build
npm run preview
```

## Features

- Open or drag-and-drop `.md` / `.markdown` files
- Live GitHub-flavored Markdown preview with safe HTML sanitization
- Editorial, Modern, and Warm Paper document themes
- A4, US Letter, and A5 page sizes, with three margin presets
- Download a PDF directly in the browser
- Basic formatting shortcuts and a starter document
- Responsive layout; document processing happens on-device

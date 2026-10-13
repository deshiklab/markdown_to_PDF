// Studio entry point. The single import is responsible for three things:
//   1. Loading the heavy parser (marked) and the sanitizer (DOMPurify).
//   2. Registering every tab with the shell (lazy, so the editor stays
//      fast and only the tool you open pulls in its library).
//   3. Mounting the shell into the page after the DOM is ready.
//
// Important: per the README, tools must NOT import a heavy library at
// the top level of the app entry. Each tool's `load()` does its own
// dynamic import so the Markdown tab doesn't drag in pdf-lib, pdf.js,
// etc. unless the user opens one of them.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { mountStudioShell, registerTab } from './shell.js';

const toolLoaders = {
  markdown: () => import('./tools/markdown.js'),
  converter: () => import('./tools/converter.js'),
  finish: () => import('./tools/finish.js'),
  pdfLab: () => import('./tools/pdf-lab.js'),
  sign: () => import('./tools/sign.js'),
  translate: () => import('./tools/translate.js'),
  portfolio: () => import('./tools/portfolio.js'),
};

const tabDefinitions = [
  {
    id: 'markdown',
    index: '01',
    label: 'Markdown → PDF',
    description: 'Write, preview, export',
    intro: 'The original Folio editor: GFM Markdown, three themes, A4 / Letter / A5, and a print-ready PDF in one click.',
    load: (root) => toolLoaders.markdown().then((mod) => mod.start(root, { marked, DOMPurify })),
  },
  {
    id: 'converter',
    index: '02',
    label: 'Converter',
    description: 'Photos & PDFs',
    intro: 'Turn a folder of photos into a PDF, pull text out of a PDF as Markdown, save each page as an image, or shrink a batch of images into a ZIP.',
    load: (root) => toolLoaders.converter().then((mod) => mod.start(root)),
  },
  {
    id: 'pdf-lab',
    index: '03',
    label: 'PDF Lab',
    description: 'Merge, split, rotate',
    intro: 'Stitch PDFs together, reorder pages, rotate a page or a whole file, split one file into ranges, or stamp a text watermark.',
    load: (root) => toolLoaders.pdfLab().then((mod) => mod.start(root)),
  },
  {
    id: 'finish',
    index: '04',
    label: 'Finish',
    description: 'Metadata, footer, redact, checksum',
    intro: 'Edit document fields, stamp `{page}` / `{total}` footers, black out terms with an optional flatten, and take a SHA checksum with a sidecar `.sum` file.',
    load: (root) => toolLoaders.finish().then((mod) => mod.start(root)),
  },
  {
    id: 'sign',
    index: '05',
    label: 'Sign',
    description: 'Sign & countersign',
    intro: 'Draw a signature, place it on a page with a name and date, add a countersignature, and optionally flatten so the mark cannot be lifted off.',
    load: (root) => toolLoaders.sign().then((mod) => mod.start(root)),
  },
  {
    id: 'translate',
    index: '06',
    label: 'Translate PDF',
    description: 'Page by page',
    intro: 'Extract text page by page, translate each segment with the provider you choose, and export a bilingual PDF or Markdown.',
    load: (root) => toolLoaders.translate().then((mod) => mod.start(root)),
  },
  {
    id: 'portfolio',
    index: '07',
    label: 'Photo Portfolio',
    description: 'Photo book',
    intro: 'Build a printed-looking portfolio with a cover, plates, colophon and page numbers — six layouts, three tones, then export as a PDF book.',
    load: (root) => toolLoaders.portfolio().then((mod) => mod.start(root)),
  },
];

for (const tab of tabDefinitions) {
  registerTab(tab);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const root = document.querySelector('.app-shell') || document.body;
    mountStudioShell(root);
  }, { once: true });
} else {
  const root = document.querySelector('.app-shell') || document.body;
  mountStudioShell(root);
}

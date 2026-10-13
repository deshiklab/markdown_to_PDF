import { marked } from 'marked';
import DOMPurify from 'dompurify';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './app-core.js';
import { injected } from './lib.js';
import { startShell } from './shell.js';

/* The bundle keeps the first paint tiny: heavy PDF code is only pulled in when
   a tab actually asks for it. */
injected.marked = marked;
injected.DOMPurify = DOMPurify;
injected.loadHtml2Pdf = async () => (await import('html2pdf.js')).default;
injected.loadPdfLib = async () => import('pdf-lib');
injected.loadZip = async () => import('fflate');
const pdfjsRoot = import.meta.env.DEV ? '/node_modules/pdfjs-dist' : `${import.meta.env.BASE_URL || '/'}pdfjs`;
injected.pdfjsAssets = {
  cMapUrl: `${pdfjsRoot}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${pdfjsRoot}/standard_fonts/`,
};

injected.loadPdfJs = async () => {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return pdfjs;
};

const tools = {
  'pdf-lab': () => import('./tools/pdf-lab.js'),
  translate: () => import('./tools/translate.js'),
  convert: () => import('./tools/convert.js'),
  portfolio: () => import('./tools/portfolio.js'),
  finish: () => import('./tools/finish.js'),
  sign: () => import('./tools/sign.js'),
};

window.startFolioApp({
  marked,
  DOMPurify,
  loadHtml2Pdf: injected.loadHtml2Pdf,
});

startShell({ loaders: tools });

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './app-core.js';

window.startFolioApp({
  marked,
  DOMPurify,
  loadHtml2Pdf: async () => {
    const { default: html2pdf } = await import('html2pdf.js');
    return html2pdf;
  },
});

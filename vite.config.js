import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);

/**
 * pdf.js needs its character-map and standard-font data next to the app to read
 * CJK and legacy PDFs. They ship inside node_modules, so we copy them into the
 * build instead of adding ~4 MB to the repository.
 */
function copyPdfjsData(outDir) {
  return {
    name: 'folio-copy-pdfjs-data',
    apply: 'build',
    writeBundle() {
      const root = dirname(require.resolve('pdfjs-dist/package.json'));
      for (const folder of ['cmaps', 'standard_fonts']) {
        const from = resolve(root, folder);
        const to = resolve(outDir, 'pdfjs', folder);
        if (!existsSync(from)) continue;
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['.e2b.app'],
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  // The PDF renderer is loaded only when exporting, so keep its larger chunk separate.
  build: {
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('pdfjs-dist')) return 'pdfjs';
          if (id.includes('pdf-lib')) return 'pdf-lib';
          if (id.includes('html2pdf') || id.includes('html2canvas') || id.includes('jspdf') || id.includes('canvg')) return 'html2pdf';
          return;
        },
      },
    },
  },
  plugins: [copyPdfjsData(resolve(process.cwd(), 'dist'))],
});

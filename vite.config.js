import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Recursive directory copy. Used to ship pdf.js's `cmaps` and
// `standard_fonts` folders with the production build so documents
// with non-ASCII encodings parse instead of failing silently.
function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
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
  // The PDF renderer is loaded only when exporting, so keep its larger chunk separate.
  build: {
    chunkSizeWarningLimit: 1000,
  },
  plugins: [
    {
      name: 'copy-pdfjs-assets',
      apply: 'build',
      closeBundle() {
        const pdfjsRoot = 'node_modules/pdfjs-dist';
        for (const folder of ['cmaps', 'standard_fonts']) {
          const src = join(pdfjsRoot, folder);
          const dest = join('dist', 'pdfjs', folder);
          try {
            copyDirRecursive(src, dest);
            console.log(`copied pdf.js ${folder} -> ${dest}`);
          } catch (error) {
            // pdfjs-dist layout changes between minor versions; warn
            // rather than fail so the build still goes through.
            console.warn(`could not copy pdf.js ${folder}: ${error.message}`);
          }
        }
      },
    },
  ],
});

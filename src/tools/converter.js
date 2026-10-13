// Converter tool (stub for Phase 1). The real implementation lives in
// the next commit; for now we mount a clear "coming soon" panel so the
// tab strip works end-to-end and the lazy loader is exercised.

import { h } from '../lib.js';

export function start(root) {
  const panel = h('div', { class: 'tool-placeholder' }, [
    h('div', { class: 'tool-placeholder-inner' }, [
      h('span', { class: 'tool-placeholder-tag' }, 'Phase 2'),
      h('h2', null, 'Converter'),
      h('p', null, 'Photos → PDF, PDF → Markdown, PDF → PNG/JPEG, and a "shrink images" pass. Lands in the next commit, on top of this studio shell.'),
    ]),
  ]);
  root.append(panel);
  return {
    unmount() { panel.remove(); },
  };
}

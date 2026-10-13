// PDF Lab tool (stub for Phase 1).

import { h } from '../lib.js';

export function start(root) {
  const panel = h('div', { class: 'tool-placeholder' }, [
    h('div', { class: 'tool-placeholder-inner' }, [
      h('span', { class: 'tool-placeholder-tag' }, 'Phase 2'),
      h('h2', null, 'PDF Lab'),
      h('p', null, 'Merge, reorder, rotate, split, and watermark — built on pdf-lib and pdf.js page thumbnails. Arrives in a follow-up commit.'),
    ]),
  ]);
  root.append(panel);
  return {
    unmount() { panel.remove(); },
  };
}

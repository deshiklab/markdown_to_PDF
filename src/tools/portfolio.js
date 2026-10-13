// Photo Portfolio tool (stub for Phase 1).

import { h } from '../lib.js';

export function start(root) {
  const panel = h('div', { class: 'tool-placeholder' }, [
    h('div', { class: 'tool-placeholder-inner' }, [
      h('span', { class: 'tool-placeholder-tag' }, 'Phase 3'),
      h('h2', null, 'Photo Portfolio'),
      h('p', null, 'Cover, plates, colophon, page numbers — six layouts × five paper sizes × three tones, exported as a PDF book. Scheduled for Phase 3.'),
    ]),
  ]);
  root.append(panel);
  return {
    unmount() { panel.remove(); },
  };
}

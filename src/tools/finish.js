// Finish tool (stub for Phase 1).

import { h } from '../lib.js';

export function start(root) {
  const panel = h('div', { class: 'tool-placeholder' }, [
    h('div', { class: 'tool-placeholder-inner' }, [
      h('span', { class: 'tool-placeholder-tag' }, 'Phase 2'),
      h('h2', null, 'Finish'),
      h('p', null, 'Edit metadata, stamp page numbers, redact terms with an optional flatten, and take a SHA checksum with a sidecar .sum file. Arrives in a follow-up commit.'),
    ]),
  ]);
  root.append(panel);
  return {
    unmount() { panel.remove(); },
  };
}

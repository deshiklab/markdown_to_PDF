// Sign tool (stub for Phase 1).

import { h } from '../lib.js';

export function start(root) {
  const panel = h('div', { class: 'tool-placeholder' }, [
    h('div', { class: 'tool-placeholder-inner' }, [
      h('span', { class: 'tool-placeholder-tag' }, 'Phase 2'),
      h('h2', null, 'Sign'),
      h('p', null, 'Draw a signature, place it on a page with a name and date, add a countersignature, and optionally flatten. Fraction-based coordinates so a phone re-measure does not stretch the mark. Arrives in a follow-up commit.'),
    ]),
  ]);
  root.append(panel);
  return {
    unmount() { panel.remove(); },
  };
}

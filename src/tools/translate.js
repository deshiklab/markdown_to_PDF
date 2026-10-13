// Translate PDF tool (stub for Phase 1).

import { h } from '../lib.js';

export function start(root) {
  const panel = h('div', { class: 'tool-placeholder' }, [
    h('div', { class: 'tool-placeholder-inner' }, [
      h('span', { class: 'tool-placeholder-tag' }, 'Phase 3'),
      h('h2', null, 'Translate PDF'),
      h('p', null, 'Page-by-page extraction, bilingual editor, three translation providers (Google free, MyMemory, self-hosted LibreTranslate), and a "no service" mode that keeps everything local. Scheduled for Phase 3 after the four local-only tools land.'),
    ]),
  ]);
  root.append(panel);
  return {
    unmount() { panel.remove(); },
  };
}

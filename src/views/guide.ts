// Guidance that fades (George, 7 Nov 2026; redesign E). A screen's "how this works" line shows the
// first three times a person sees that screen, then folds into a "?" that brings it back (hub.js,
// counted in that browser). Without script it always shows.
import { html, Html } from '../web/html.js';

export function guide(key: string, text: Html | string, cls = 'muted small'): Html {
  return html`<div class="guide ${cls}" data-guide="${key}"><span class="guide-text">${text}</span><button type="button" class="guide-q" aria-label="How this works" aria-expanded="true" title="How this works">?</button></div>`;
}

// Guidance that fades (George, 7 Nov 2026; redesign E). A screen's "how this works" line shows the
// first three times a person sees that screen, then folds into a "?" that brings it back (hub.js,
// counted in that browser). Without script it always shows.
import { html, Html } from '../web/html.js';

/** The manual page for each screen's line (docs/manual). */
const HELP: Record<string, string> = { board: 'board', pipeline: 'pipeline', jobs: 'jobs', me: 'my-day', 'job-steps': 'job', 'new-job': 'new-job', count: 'count-and-offcuts' };

export function guide(key: string, text: Html | string, cls = 'muted small'): Html {
  const help = HELP[key];
  return html`<div class="guide ${cls}" data-guide="${key}"><span class="guide-text">${text}${help ? html` <a href="/help/${help}">Manual</a>` : ''}</span><button type="button" class="guide-q" aria-label="How this works" aria-expanded="true" title="How this works">?</button></div>`;
}

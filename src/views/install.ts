// Done with photos on install (George, 7 Nov 2026; R13): Jobman's install checklist cut to what
// matters. Ticking Install cabinets done asks whether the gaps were adjusted and the site left
// clean, and takes up to three photos. They sit on the job and in History.
import { html, Html } from '../web/html.js';
import type { StepRow } from '../domain/checks.js';

export type InstallStep = Pick<StepRow, 'id' | 'kind' | 'label' | 'done_at' | 'gaps_adjusted' | 'site_clean'>;

/** Only the standard Install cabinets step asks the questions. */
export function asksOnDone(s: Pick<StepRow, 'kind' | 'label'>): boolean {
  return s.kind === 'install' && !s.label;
}

/** The tick as a small form: the two questions, photos, Done. Posts to the usual done route, multipart. */
export function installDoneForm(s: InstallStep, back: string, summary: Html, cls = 'pop install'): Html {
  return html`<details class="${cls}"><summary class="check" aria-label="Install cabinets: tap when done" role="button">${summary}</summary>
    <form class="popbody" method="post" action="/steps/${s.id}/done" enctype="multipart/form-data" data-photos>
      <input type="hidden" name="done" value="1"><input type="hidden" name="back" value="${back}">
      <div class="fixgrid">
        <fieldset class="f yn"><legend>Gaps adjusted?</legend><label><input type="radio" name="gaps" value="1" required> Yes</label><label><input type="radio" name="gaps" value="0"> No</label></fieldset>
        <fieldset class="f yn"><legend>Site left clean?</legend><label><input type="radio" name="clean" value="1" required> Yes</label><label><input type="radio" name="clean" value="0"> No</label></fieldset>
      </div>
      <label class="f">Photos (up to 3)<input type="file" name="photo" accept="image/*" capture="environment" multiple></label>
      <div class="acts"><button class="btn primary" type="submit">Install done</button></div>
    </form></details>`;
}

/** After the tick: the answers and the photos, under the step. */
export function installSummary(s: InstallStep, photoIds: number[]): Html {
  if (!s.done_at || (s.gaps_adjusted == null && s.site_clean == null && !photoIds.length)) return html``;
  const yn = (v: boolean | null | undefined, what: string) => v == null ? '' : html`<span class="spill ${v ? 'done' : 'over'}">${what}: ${v ? 'yes' : 'no'}</span>`;
  return html`<div class="inst-done"><div class="pills">${yn(s.gaps_adjusted, 'Gaps adjusted')}${yn(s.site_clean, 'Site clean')}</div>
    ${photoIds.length ? html`<div class="photos">${photoIds.map((pid) => html`<a href="/steps/${s.id}/photos/${pid}" target="_blank" rel="noopener"><img src="/steps/${s.id}/photos/${pid}" alt="Install photo" loading="lazy"></a>`)}</div>` : ''}
  </div>`;
}

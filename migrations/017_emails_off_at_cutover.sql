-- Cutover, 8 Nov 2026 (George): the real emails start for George and Christine only. Everyone else's
-- "Gets emails" is off until George ticks them on under Settings → People.
update people set email_digest = false
 where email not in ('george@aalborkitchens.com.au', 'design@aalborkitchens.com.au');

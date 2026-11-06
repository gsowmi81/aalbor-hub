-- Clearing the pending queue before a fresh rebuild (George, 6 Nov 2026). The bot's token, or an
-- Editor on the Suggestions screen, marks every pending suggestion superseded, with a reason.
-- Each row records when, why, and who: decided_by for an Editor, decided_by_token for the bot.
-- Accepted, declined, "Buildertrend is wrong" and failed ones never change. Still no job edits.

alter table suggestions add column decided_by_token integer references api_tokens (id);

create or replace function hub_suggestion_guard() returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  actor text := hub_actor();
  tok   integer := hub_token();
  r     text;
begin
  if actor = 'system' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Suggestions are kept, never deleted' using errcode = '42501';
  end if;
  -- Deleting a job clears job_id on its suggestions (on delete set null).
  if tg_op = 'UPDATE' and new.job_id is null and old.job_id is not null
     and (to_jsonb(new) - 'job_id') = (to_jsonb(old) - 'job_id') then
    return new;
  end if;

  if actor is null and tok is not null then
    if tg_op = 'INSERT' then
      new.token_id := tok;
      new.status := 'pending';
      new.decided_by := null;
      new.decided_at := null;
      new.superseded_by := null;
      new.failure := '';
      new.decision_note := '';
      return new;
    end if;
    -- Supersede a pending one: by a newer one (superseded_by), or in a bulk clear before a
    -- fresh rebuild (decision_note says why). Recorded against the token, with the time.
    if old.status = 'pending' and new.status = 'superseded'
       and (to_jsonb(new) - 'status' - 'superseded_by' - 'decision_note' - 'decided_at' - 'decided_by_token')
         = (to_jsonb(old) - 'status' - 'superseded_by' - 'decision_note' - 'decided_at' - 'decided_by_token') then
      new.decided_by_token := tok;
      new.decided_at := now();
      new.decision_note := left(new.decision_note, 300);
      return new;
    end if;
    raise exception 'An API token can only add suggestions and supersede pending ones' using errcode = '42501';
  end if;
  if actor is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select role into r from people where id = actor::integer and active;
  if r is distinct from 'editor' then
    raise exception 'Only Editors can act on suggestions' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Suggestions come from the bot' using errcode = '42501';
  end if;
  if old.status <> 'pending' then
    raise exception 'That suggestion has already been dealt with' using errcode = '42501';
  end if;
  -- (An accepted add_job also records the job it made.)
  if new.status not in ('accepted', 'declined', 'bt_wrong', 'failed', 'superseded')
     or (to_jsonb(new) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'failure' - 'job_id')
        <> (to_jsonb(old) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'failure' - 'job_id')
     or (new.status = 'superseded' and new.job_id is distinct from old.job_id)
     or (new.job_id is distinct from old.job_id and not (old.type = 'add_job' and old.job_id is null)) then
    raise exception 'Only the decision on a suggestion can change' using errcode = '42501';
  end if;
  new.decided_by := actor::integer;
  new.decided_at := now();
  return new;
end;
$$;

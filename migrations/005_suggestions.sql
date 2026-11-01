-- Suggestions (George, 1 Nov 2026): a bot (Grokbot) compares the hub with Buildertrend each
-- weekday and posts proposed changes through /api. Nothing changes until an Editor accepts.
-- The bot signs in with an API token; it can add and read suggestions and read jobs, never edit.

-- ---------- Text settings (the suggestions email) ----------

create table app_settings (
  key   text primary key,
  value text not null,
  label text not null,
  sort  integer not null default 0
);
insert into app_settings (key, value, label, sort) values
  ('suggestions_email', 'design@aalborkitchens.com.au', 'Email new suggestions to', 10);

-- ---------- Change log: which suggestion a change came from ----------

alter table change_log add column suggestion_id bigint;

create or replace function hub_log() returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  actor text := hub_actor();
  who   text;
  rid   text;
begin
  if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then
    return null;
  end if;
  if actor = 'system' or actor is null then
    who := 'System';
  else
    select name into who from people where id = actor::integer;
  end if;
  rid := coalesce(to_jsonb(new), to_jsonb(old)) ->> case when tg_table_name in ('decisions', 'settings', 'job_templates', 'app_settings') then 'key' else 'id' end;
  insert into change_log (table_name, record_id, action, person_id, person_name, before, after, suggestion_id)
  values (tg_table_name, rid, lower(tg_op),
          case when actor ~ '^\d+$' then actor::integer end, coalesce(who, 'Unknown'),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          nullif(current_setting('hub.suggestion_id', true), '')::bigint);
  return null;
end;
$$;

create trigger app_settings_guard before insert or update or delete on app_settings for each row execute function hub_guard();
create trigger app_settings_log after insert or update or delete on app_settings for each row execute function hub_log();

-- ---------- API tokens (owners create and revoke them) ----------

create table api_tokens (
  id           serial primary key,
  name         text not null,
  token_hash   text not null unique,
  created_by   integer references people (id),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   integer references people (id)
);

-- The token acting, if the request came through /api with one (set by withToken()).
create function hub_token() returns integer language sql stable
set search_path = public, pg_temp as $$
  select t.id from api_tokens t
  where t.id = nullif(current_setting('hub.token_id', true), '')::integer and t.revoked_at is null
$$;

create function hub_token_guard() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if hub_actor() = 'system' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Tokens are revoked, never deleted' using errcode = '42501';
  end if;
  if not hub_is_owner() then
    raise exception 'Only an owner can create or revoke API tokens' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := hub_actor()::integer;
    new.revoked_at := null;
    new.revoked_by := null;
    return new;
  end if;
  -- Owners can only revoke (once); everything else stays as it was.
  if old.revoked_at is null and new.revoked_at is not null
     and (to_jsonb(new) - 'revoked_at' - 'revoked_by') = (to_jsonb(old) - 'revoked_at' - 'revoked_by') then
    new.revoked_by := hub_actor()::integer;
    return new;
  end if;
  raise exception 'A token can only be revoked' using errcode = '42501';
end;
$$;
create trigger api_tokens_guard before insert or update or delete on api_tokens for each row execute function hub_token_guard();

-- Every API call, whether or not its token was good. Written by the system only.
create table api_calls (
  id       bigserial primary key,
  token_id integer references api_tokens (id),
  at       timestamptz not null default now(),
  method   text not null,
  path     text not null,
  status   integer not null,
  items    integer,
  ip       text
);
create index api_calls_at on api_calls (at desc);
create trigger api_calls_guard before insert or update or delete on api_calls for each row execute function hub_system_only();

-- ---------- Suggestions ----------

create table suggestions (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  source         text not null default 'Grokbot',
  batch_id       text not null,
  token_id       integer references api_tokens (id),
  job_id         integer references jobs (id) on delete set null,
  job_number     text,
  stage_key      text,
  type           text not null check (type in ('update_date', 'update_status', 'tick_confirmed', 'add_job', 'note')),
  field          text,
  current_value  text,
  proposed_value text,
  reason         text not null default '',
  priority       text not null default 'normal' check (priority in ('urgent', 'normal', 'info')),
  status         text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'bt_wrong', 'superseded', 'failed')),
  superseded_by  bigint references suggestions (id),
  decided_by     integer references people (id),
  decided_at     timestamptz,
  decision_note  text not null default '',
  failure        text not null default '',
  payload        jsonb
);
create index suggestions_pending on suggestions (status, priority);
create index suggestions_job on suggestions (job_id);
create index suggestions_batch on suggestions (batch_id);

-- Who may do what with a suggestion:
--   the bot's token: add new pending ones (and its own newer one supersedes an older one);
--   Editors: decide pending ones (accept, decline, Buildertrend is wrong, failed). Once decided, it stays.
--   Nobody deletes them except the system.
create function hub_suggestion_guard() returns trigger language plpgsql
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
    if old.status = 'pending' and new.status = 'superseded'
       and (to_jsonb(new) - 'status' - 'superseded_by') = (to_jsonb(old) - 'status' - 'superseded_by') then
      return new;
    end if;
    raise exception 'An API token can only add suggestions' using errcode = '42501';
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
  if new.status not in ('accepted', 'declined', 'bt_wrong', 'failed')
     or (to_jsonb(new) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'failure' - 'job_id')
        <> (to_jsonb(old) - 'status' - 'decided_by' - 'decided_at' - 'decision_note' - 'failure' - 'job_id')
     or (new.job_id is distinct from old.job_id and not (old.type = 'add_job' and old.job_id is null)) then
    raise exception 'Only the decision on a suggestion can change' using errcode = '42501';
  end if;
  new.decided_by := actor::integer;
  new.decided_at := now();
  return new;
end;
$$;
create trigger suggestions_guard before insert or update or delete on suggestions for each row execute function hub_suggestion_guard();

-- A newer suggestion for the same job, stage and field replaces an older pending one.
-- Notes are never merged.
create function hub_suggestion_supersede() returns trigger language plpgsql
set search_path = public, pg_temp as $$
begin
  if new.type = 'note' then
    return null;
  end if;
  update suggestions set status = 'superseded', superseded_by = new.id
  where status = 'pending' and id <> new.id and type = new.type
    and lower(coalesce(job_number, '')) = lower(coalesce(new.job_number, ''))
    and coalesce(stage_key, '') = coalesce(new.stage_key, '')
    and coalesce(field, '') = coalesce(new.field, '');
  return null;
end;
$$;
create trigger suggestions_supersede after insert on suggestions for each row execute function hub_suggestion_supersede();

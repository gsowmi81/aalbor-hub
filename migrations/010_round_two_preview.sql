-- Round two of the preview (George, 7 Nov 2026; docs/jobman-review.html R5, R9, R11):
-- capacity in hours per area, flagged problems with photos, and email nudges.

-- ---------- Capacity in hours per area (R5) ----------
-- Jobman's labour centre: hours available each weekday. A kitchen's factory or install day
-- counts as hours_per_day hours (the existing setting). The old "kitchens a week" settings
-- become the starting hours: kitchens × default days × hours per day, spread over five days.

create table labour_centres (
  key   text primary key check (key in ('factory', 'install')),
  label text not null,
  mon   numeric(4, 1) not null default 0 check (mon >= 0),
  tue   numeric(4, 1) not null default 0 check (tue >= 0),
  wed   numeric(4, 1) not null default 0 check (wed >= 0),
  thu   numeric(4, 1) not null default 0 check (thu >= 0),
  fri   numeric(4, 1) not null default 0 check (fri >= 0),
  sort  integer not null default 0
);

-- A period with different hours: a shutdown (0), someone on leave, an extra pair of hands.
create table capacity_adjustments (
  id       serial primary key,
  centre   text not null references labour_centres (key) on delete cascade,
  from_day date not null,
  to_day   date not null,
  hours    numeric(4, 1) not null check (hours >= 0),
  reason   text not null default '',
  check (to_day >= from_day)
);

do $$
declare
  hpd numeric := coalesce((select value from settings where key = 'hours_per_day'), 8);
  fk  numeric := coalesce((select value from settings where key = 'factory_kitchens_per_week'), 2);
  fd  numeric := coalesce((select value from settings where key = 'default_factory_days'), 2);
  ik  numeric := coalesce((select value from settings where key = 'install_kitchens_per_week'), 2);
  idd numeric := coalesce((select value from settings where key = 'default_install_days'), 3);
  f   numeric := round(fk * fd * hpd / 5, 1);
  i   numeric := round(ik * idd * hpd / 5, 1);
begin
  insert into labour_centres (key, label, mon, tue, wed, thu, fri, sort) values
    ('factory', 'Factory', f, f, f, f, f, 10),
    ('install', 'Install crew', i, i, i, i, i, 20);
end $$;

delete from settings where key in ('factory_kitchens_per_week', 'install_kitchens_per_week');
update settings set label = 'Hours in a factory or install day (a kitchen''s day, a rework''s hours)' where key = 'hours_per_day';

-- ---------- Flag a problem (R9) ----------
-- Jobman's job alert: a type with someone responsible, one line, photos. Raised from My day or
-- a step by anyone who can tick (Doers and Editors). Lands on Attention for the responsible
-- person and the Editors. Rework stays for work that has to be done again; a flag is "I'm stuck".

create table issue_types (
  key         text primary key,
  label       text not null,
  responsible integer references people (id),
  sort        integer not null default 0,
  active      boolean not null default true
);
insert into issue_types (key, label, sort) values
  ('materials_short', 'Materials short or wrong', 10),
  ('drawing_query',   'Drawing query', 20),
  ('site_not_ready',  'Site not ready', 30),
  ('damaged',         'Something damaged', 40),
  ('machine',         'Machine or tool problem', 50),
  ('other',           'Something else', 60);
-- Starting owners by the names the team uses; George changes them in Settings.
update issue_types t set responsible = p.id from people p where t.key = 'materials_short' and p.active and p.name ilike 'angela%';
update issue_types t set responsible = p.id from people p where t.key = 'drawing_query' and p.active and (p.name ilike 'christine%' or p.email = 'design@aalborkitchens.com.au');
update issue_types t set responsible = p.id from people p where t.key = 'site_not_ready' and p.active and p.name ilike 'george%';
update issue_types t set responsible = p.id from people p where t.key in ('damaged', 'machine') and p.active and p.name ilike 'phil%';

create table issues (
  id         serial primary key,
  job_id     integer not null references jobs (id) on delete cascade,
  step_id    integer references steps (id) on delete set null,
  type_key   text not null references issue_types (key),
  note       text not null,
  raised_by  integer references people (id),
  raised_at  timestamptz not null default now(),
  status     text not null default 'open' check (status in ('open', 'looking', 'fixed')),
  closed_at  timestamptz,
  closed_by  integer references people (id),
  close_note text not null default '',
  rework_id  integer references rework (id) on delete set null
);
create index issues_open on issues (status) where status <> 'fixed';

-- Photos live in the database (a few hundred at most, resized on the phone before upload).
create table issue_photos (
  id           serial primary key,
  issue_id     integer not null references issues (id) on delete cascade,
  content_type text not null,
  bytes        bytea not null,
  size         integer not null,
  added_by     integer references people (id),
  added_at     timestamptz not null default now()
);

-- ---------- Email nudges (R11) ----------
alter table people add column email_digest boolean not null default true;
-- One row per day and kind, so a restart never sends the same nudges twice.
create table digest_runs (
  day    date not null,
  kind   text not null,
  sent   integer not null default 0,
  ran_at timestamptz not null default now(),
  primary key (day, kind)
);

-- ---------- Roles ----------
-- Doers may raise a flag (with photos) and, when they raised it or are responsible for its
-- type, move it along (status, close note). Everything else about Doers is as before.
create or replace function hub_guard() returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  actor text := hub_actor();
  r     text;
  pid   integer;
  kept  text[] := array['done_at', 'done_by', 'note'];
  issue_kept text[] := array['status', 'closed_at', 'closed_by', 'close_note'];
begin
  if actor is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if actor = 'system' then
    return coalesce(new, old);
  end if;
  pid := actor::integer;
  select role into r from people where id = pid and active;
  if r is null then
    raise exception 'This person has no access' using errcode = '42501';
  end if;

  -- Whoever ticks a step is recorded as the one who did it.
  -- (Nested ifs: PL/pgSQL doesn't short-circuit, and other tables have no done_at.)
  if tg_table_name = 'steps' and tg_op = 'UPDATE' then
    if new.done_at is distinct from old.done_at then
      new.done_by := case when new.done_at is null then null else pid end;
    end if;
  end if;
  if tg_table_name = 'rework' and tg_op = 'INSERT' then
    new.raised_by := pid;
  end if;
  if tg_table_name = 'issues' and tg_op = 'INSERT' then
    new.raised_by := pid;
  end if;
  if tg_table_name = 'issues' and tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      new.closed_by := case when new.status = 'fixed' then pid else null end;
      new.closed_at := case when new.status = 'fixed' then now() else null end;
    end if;
  end if;
  if tg_table_name = 'issue_photos' and tg_op = 'INSERT' then
    new.added_by := pid;
  end if;

  if r = 'editor' then
    return coalesce(new, old);
  end if;
  if r = 'doer' then
    -- Doers tick steps done (and add a note), raise rework with its tasks, and flag problems.
    if tg_table_name = 'steps' and tg_op = 'UPDATE' then
      if (to_jsonb(new) - kept) = (to_jsonb(old) - kept) then
        return new;
      end if;
    end if;
    if tg_table_name = 'steps' and tg_op = 'INSERT' then
      if new.kind = 'rework' and new.rework_area is not null and new.start_date is null and new.end_date is null
         and not new.confirmed and new.done_at is null then
        if exists (select 1 from rework w where w.id = new.rework_id and w.raised_by = pid and w.closed_on is null) then
          return new;
        end if;
      end if;
    end if;
    if tg_table_name = 'rework' and tg_op = 'INSERT' then
      if new.closed_on is null and new.extra_hours is null and new.extra_material_cost is null then
        return new;
      end if;
    end if;
    if tg_table_name = 'issues' and tg_op = 'INSERT' then
      if new.status = 'open' and new.rework_id is null then
        return new;
      end if;
    end if;
    if tg_table_name = 'issues' and tg_op = 'UPDATE' then
      if (to_jsonb(new) - issue_kept) = (to_jsonb(old) - issue_kept) then
        if old.raised_by = pid or exists (select 1 from issue_types t where t.key = old.type_key and t.responsible = pid) then
          return new;
        end if;
      end if;
    end if;
    if tg_table_name = 'issue_photos' and tg_op = 'INSERT' then
      if exists (select 1 from issues i where i.id = new.issue_id and i.raised_by = pid and i.status <> 'fixed') then
        return new;
      end if;
    end if;
    raise exception 'Doers can tick steps, raise rework and flag problems, nothing else' using errcode = '42501';
  end if;
  raise exception 'Viewers can''t change anything' using errcode = '42501';
end;
$$;

-- The change log keys a row by its id, or by key for the keyed tables; digest_runs by day and kind.
create or replace function hub_log() returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  actor text := hub_actor();
  who   text;
  rid   text;
  j     jsonb := coalesce(to_jsonb(new), to_jsonb(old));
begin
  if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then
    return null;
  end if;
  if actor = 'system' or actor is null then
    who := 'System';
  else
    select name into who from people where id = actor::integer;
  end if;
  rid := case
    when tg_table_name = 'digest_runs' then (j ->> 'day') || ' ' || (j ->> 'kind')
    when tg_table_name in ('decisions', 'settings', 'job_templates', 'app_settings', 'labour_centres', 'issue_types') then j ->> 'key'
    else j ->> 'id' end;
  insert into change_log (table_name, record_id, action, person_id, person_name, before, after, suggestion_id)
  values (tg_table_name, rid, lower(tg_op),
          case when actor ~ '^\d+$' then actor::integer end, coalesce(who, 'Unknown'),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          nullif(current_setting('hub.suggestion_id', true), '')::bigint);
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['labour_centres', 'capacity_adjustments', 'issue_types', 'issues', 'digest_runs'] loop
    execute format('create trigger %I_guard before insert or update or delete on %I for each row execute function hub_guard()', t, t);
    execute format('create trigger %I_log after insert or update or delete on %I for each row execute function hub_log()', t, t);
  end loop;
end $$;
-- Photos are guarded but not logged: the change log would otherwise hold every image.
create trigger issue_photos_guard before insert or update or delete on issue_photos for each row execute function hub_guard();

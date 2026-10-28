-- Aalbor Hub, Phase 1 (Production) schema.
-- Roles are enforced here, not in the app: hub_guard() refuses any write the
-- signed-in person's role can't make, and hub_log() records every change.
-- The app tells Postgres who is signed in with set_config('hub.person_id', ...)
-- inside each write transaction (see src/db/pool.ts, withPerson()).

create extension if not exists citext;

create table people (
  id         serial primary key,
  name       text not null,
  email      citext not null unique,
  role       text not null default 'viewer' check (role in ('editor', 'doer', 'viewer')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table settings (
  key   text primary key,
  value integer not null,
  label text not null,
  sort  integer not null default 0
);

create table blocked_days (
  id     serial primary key,
  day    date not null,
  scope  text not null default 'all' check (scope in ('all', 'factory')),
  reason text not null default '',
  unique (day, scope)
);

create table jobs (
  id           serial primary key,
  job_number   text unique,
  brand        text not null default 'Aalbor' check (brand in ('Aalbor', 'Origin')),
  client_name  text not null,
  suburb       text not null default '',
  scope        text not null default '',
  door_finish  text not null default 'melamine' check (door_finish in ('melamine', 'polyurethane')),
  has_stone    boolean not null default true,
  site_start   date,
  factory_days integer not null default 2 check (factory_days between 1 and 30),
  install_days integer not null default 3 check (install_days between 1 and 30),
  status       text not null default 'live' check (status in ('live', 'on_hold', 'complete', 'cancelled')),
  at_risk      boolean not null default false,
  notes        text not null default '',
  added_on     date not null default current_date,
  created_at   timestamptz not null default now()
);

create table rework (
  id                  serial primary key,
  job_id              integer not null references jobs (id) on delete cascade,
  cause               text check (cause in ('drafting', 'measure', 'factory', 'install', 'supplier', 'client change')),
  note                text not null,
  raised_by           integer references people (id),
  raised_at           timestamptz not null default now(),
  closed_on           date,
  extra_hours         numeric(6, 1),
  extra_material_cost numeric(10, 2)
);

create table steps (
  id         serial primary key,
  job_id     integer not null references jobs (id) on delete cascade,
  kind       text not null check (kind in (
               'contract_drafting', 'check_measure', 'production_drawings',
               'materials_ordered', 'materials_in', 'factory',
               'doors_to_painting', 'doors_back', 'delivery', 'install',
               'stone_measure', 'stone_install', 'rework')),
  rework_id  integer references rework (id) on delete cascade,
  label      text not null default '',
  start_date date,
  end_date   date,
  confirmed  boolean not null default false,
  owner      text not null default '',
  done_at    timestamptz,
  done_by    integer references people (id),
  note       text not null default '',
  sort       integer not null default 0,
  check (end_date is null or (start_date is not null and end_date >= start_date)),
  check ((kind = 'rework') = (rework_id is not null))
);
-- One of each standard step per job; rework steps can repeat.
create unique index steps_one_per_kind on steps (job_id, kind) where kind <> 'rework';
create index steps_dates on steps (start_date, end_date);

-- An "OK as is" on a Needs a decision item. The fingerprint is the dates the
-- item was judged on; if they change, the item shows again.
create table decisions (
  key         text primary key,
  fingerprint text not null,
  decided_by  integer references people (id),
  decided_at  timestamptz not null default now(),
  note        text not null default ''
);

create table change_log (
  id          bigserial primary key,
  table_name  text not null,
  record_id   text not null,
  action      text not null,
  person_id   integer,
  person_name text not null,
  changed_at  timestamptz not null default now(),
  before      jsonb,
  after       jsonb
);
create index change_log_record on change_log (table_name, record_id);

-- Sign-in. These two are written only by the sign-in code, as the system.
create table sign_in_links (
  token_hash text primary key,
  person_id  integer not null references people (id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz
);

create table sessions (
  token_hash text primary key,
  person_id  integer not null references people (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Who is acting: a person id, or 'system' for migrations, the import and sign-in.
create function hub_actor() returns text language sql stable as $$
  select coalesce(nullif(current_setting('hub.person_id', true), ''),
                  case when current_setting('hub.system', true) = 'on' then 'system' end)
$$;

create function hub_guard() returns trigger language plpgsql as $$
declare
  actor text := hub_actor();
  r     text;
  pid   integer;
  kept  text[] := array['done_at', 'done_by', 'note'];
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

  if r = 'editor' then
    return coalesce(new, old);
  end if;
  if r = 'doer' then
    -- Doers tick steps done (and add a note), and raise rework. Nothing else.
    if tg_table_name = 'steps' and tg_op = 'UPDATE' then
      if (to_jsonb(new) - kept) = (to_jsonb(old) - kept) then
        return new;
      end if;
    end if;
    if tg_table_name = 'rework' and tg_op = 'INSERT' then
      if new.closed_on is null and new.extra_hours is null and new.extra_material_cost is null then
        return new;
      end if;
    end if;
    raise exception 'Doers can tick steps and raise rework, nothing else' using errcode = '42501';
  end if;
  raise exception 'Viewers can''t change anything' using errcode = '42501';
end;
$$;

create function hub_log() returns trigger language plpgsql as $$
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
  rid := coalesce(to_jsonb(new), to_jsonb(old)) ->> case when tg_table_name in ('decisions', 'settings') then 'key' else 'id' end;
  insert into change_log (table_name, record_id, action, person_id, person_name, before, after)
  values (tg_table_name, rid, lower(tg_op),
          case when actor ~ '^\d+$' then actor::integer end, coalesce(who, 'Unknown'),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['people', 'settings', 'blocked_days', 'jobs', 'rework', 'steps', 'decisions'] loop
    execute format('create trigger %I_guard before insert or update or delete on %I for each row execute function hub_guard()', t, t);
    execute format('create trigger %I_log after insert or update or delete on %I for each row execute function hub_log()', t, t);
  end loop;
end $$;

-- Sign-in tables accept writes from the system only.
create function hub_system_only() returns trigger language plpgsql as $$
begin
  if current_setting('hub.system', true) is distinct from 'on' then
    raise exception 'Only the sign-in code writes here' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger sign_in_links_guard before insert or update or delete on sign_in_links for each row execute function hub_system_only();
create trigger sessions_guard before insert or update or delete on sessions for each row execute function hub_system_only();

-- The change log can only grow.
create function hub_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'The change log can''t be edited' using errcode = '42501';
end;
$$;
create trigger change_log_append_only before update or delete on change_log for each row execute function hub_log_append_only();

insert into settings (key, value, label, sort) values
  ('factory_kitchens_per_week',   2, 'Factory: kitchens a week', 10),
  ('install_kitchens_per_week',   2, 'Install crew: kitchens a week', 20),
  ('check_measures_per_day',      3, 'Check measures a day (Gus)', 30),
  ('default_factory_days',        2, 'Default factory days per job', 40),
  ('default_install_days',        3, 'Default install days per job', 50),
  ('drafting_days',               5, 'Drafting for contract: working days', 60),
  ('check_measure_after_start',   3, 'Check measure: working days after site start', 70),
  ('drawings_days',               5, 'Production drawings: signed off within (working days of check measure)', 80),
  ('materials_lead_days',         3, 'Materials in: working days after ordering', 90),
  ('painting_days',              10, 'Painting: working days doors are away', 100),
  ('install_weeks_melamine',      4, 'Install: weeks after site start (melamine)', 110),
  ('install_weeks_poly',          5, 'Install: weeks after site start (polyurethane)', 120),
  ('stone_measure_after_install', 1, 'Stone measure: working days after install finishes', 130),
  ('stone_install_after_measure', 5, 'Stone install: working days after stone measure', 140),
  ('stone_install_max',          10, 'Stone install: warn if more than this many working days after measure', 150);

-- NSW public holidays 2026 to 2028, including the extra weekday given when a
-- holiday falls on a weekend. Check against nsw.gov.au each year; editable in Settings.
insert into blocked_days (day, scope, reason) values
  ('2026-01-01', 'all', 'New Year''s Day'),
  ('2026-01-26', 'all', 'Australia Day'),
  ('2026-04-03', 'all', 'Good Friday'),
  ('2026-04-06', 'all', 'Easter Monday'),
  ('2026-06-08', 'all', 'King''s Birthday'),
  ('2026-10-05', 'all', 'Labour Day'),
  ('2026-12-25', 'all', 'Christmas Day'),
  ('2026-12-28', 'all', 'Boxing Day (additional day)'),
  ('2027-01-01', 'all', 'New Year''s Day'),
  ('2027-01-26', 'all', 'Australia Day'),
  ('2027-03-26', 'all', 'Good Friday'),
  ('2027-03-29', 'all', 'Easter Monday'),
  ('2027-06-14', 'all', 'King''s Birthday'),
  ('2027-10-04', 'all', 'Labour Day'),
  ('2027-12-27', 'all', 'Christmas Day (additional day)'),
  ('2027-12-28', 'all', 'Boxing Day (additional day)'),
  ('2028-01-03', 'all', 'New Year''s Day (additional day)'),
  ('2028-01-26', 'all', 'Australia Day'),
  ('2028-04-14', 'all', 'Good Friday'),
  ('2028-04-17', 'all', 'Easter Monday'),
  ('2028-04-25', 'all', 'Anzac Day'),
  ('2028-06-12', 'all', 'King''s Birthday'),
  ('2028-10-02', 'all', 'Labour Day'),
  ('2028-12-25', 'all', 'Christmas Day'),
  ('2028-12-26', 'all', 'Boxing Day');

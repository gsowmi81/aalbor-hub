-- Round 2 (George, 30 Oct 2026): job templates for new jobs, and a private record of who
-- was responsible for each rework that only owners (George and Gus) can see.

-- ---------- Job templates ----------

create table job_templates (
  key           text primary key,
  name          text not null,
  door_finish   text not null check (door_finish in ('melamine', 'polyurethane')),
  has_painting  boolean not null,
  has_stone     boolean not null default true,
  factory_days  integer not null check (factory_days between 1 and 30),
  install_days  integer not null check (install_days between 1 and 30),
  install_weeks integer not null check (install_weeks between 1 and 52),
  sort          integer not null default 0
);

-- Templates are keyed by name, so the change log records them by key (like settings).
create or replace function hub_log() returns trigger language plpgsql as $$
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
  rid := coalesce(to_jsonb(new), to_jsonb(old)) ->> case when tg_table_name in ('decisions', 'settings', 'job_templates') then 'key' else 'id' end;
  insert into change_log (table_name, record_id, action, person_id, person_name, before, after)
  values (tg_table_name, rid, lower(tg_op),
          case when actor ~ '^\d+$' then actor::integer end, coalesce(who, 'Unknown'),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end;
$$;

create trigger job_templates_guard before insert or update or delete on job_templates for each row execute function hub_guard();
create trigger job_templates_log after insert or update or delete on job_templates for each row execute function hub_log();

-- The two George asked for. Install weeks come from the old settings (4 melamine, 5 poly).
insert into job_templates (key, name, door_finish, has_painting, has_stone, factory_days, install_days, install_weeks, sort)
select 'kitchen_poly', 'Kitchen, polyurethane painted doors', 'polyurethane', true, true, 2, 3,
       coalesce((select value from settings where key = 'install_weeks_poly'), 5), 10
union all
select 'kitchen_melamine', 'Kitchen, melamine doors', 'melamine', false, true, 2, 3,
       coalesce((select value from settings where key = 'install_weeks_melamine'), 4), 20;

-- Install weeks now live on the templates.
delete from settings where key in ('install_weeks_melamine', 'install_weeks_poly');

alter table jobs add column template text references job_templates (key) on update cascade;

-- ---------- Owners ----------

alter table people add column is_owner boolean not null default false;
update people set is_owner = true where email in ('george@aalborkitchens.com.au', 'gus@originbathrooms.com.au');

create function hub_is_owner() returns boolean language plpgsql stable as $$
declare
  actor text := hub_actor();
  ok    boolean;
begin
  if actor = 'system' then return true; end if;
  if actor is null or actor !~ '^\d+$' then return false; end if;
  select is_owner and active into ok from people where id = actor::integer;
  return coalesce(ok, false);
end;
$$;

-- Only an owner can make someone an owner, or change an owner's own record (their email,
-- role or access), so no one else can take over an owner's sign-in.
create function hub_owner_guard() returns trigger language plpgsql as $$
begin
  if hub_is_owner() then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' and new.is_owner then
    raise exception 'Only an owner can make someone an owner' using errcode = '42501';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.is_owner then
    raise exception 'Only an owner can change an owner''s details' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.is_owner then
    raise exception 'Only an owner can make someone an owner' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger people_owner_guard before insert or update or delete on people for each row execute function hub_owner_guard();

-- Who was responsible for a rework. Row-level security: the database returns nothing to
-- anyone but an owner, and refuses their writes. Not in change_log (History would show it).
create table rework_responsible (
  rework_id   integer primary key references rework (id) on delete cascade,
  responsible text not null,
  note        text not null default '',
  set_by      integer references people (id),
  set_at      timestamptz not null default now()
);
alter table rework_responsible enable row level security;
alter table rework_responsible force row level security;
create policy owners_only on rework_responsible using (hub_is_owner()) with check (hub_is_owner());

-- Owners-only history of those records. Anyone's change can write a line (a rework deleted
-- by an Editor removes its record), but only owners can read them, and nobody can edit them.
create table owners_log (
  id          bigserial primary key,
  rework_id   integer not null,
  action      text not null,
  person_name text not null,
  changed_at  timestamptz not null default now(),
  before      jsonb,
  after       jsonb
);
alter table owners_log enable row level security;
alter table owners_log force row level security;
create policy owners_read on owners_log for select using (hub_is_owner());
create policy anyone_writes on owners_log for insert with check (true);
create trigger owners_log_append_only before update or delete on owners_log for each row execute function hub_log_append_only();

create function hub_owners_log() returns trigger language plpgsql as $$
declare
  actor text := hub_actor();
  who   text;
begin
  if actor ~ '^\d+$' then select name into who from people where id = actor::integer; end if;
  insert into owners_log (rework_id, action, person_name, before, after)
  values (coalesce(new.rework_id, old.rework_id), lower(tg_op), coalesce(who, 'System'),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end;
$$;
create trigger rework_responsible_log after insert or update or delete on rework_responsible for each row execute function hub_owners_log();

-- Round two revisions (George, 6 Nov 2026).
-- Rework is a mini job: when it's raised, pick its tasks from the standard ones (drafting,
-- factory work, delivery, install). Each rework step records which standard step it stands
-- for, so the board shows it in that step's row, in red. Factory and install tasks say how
-- many hours they need, which counts toward the weekly capacity warnings.

alter table steps add column rework_area text
  check (rework_area in ('production_drawings', 'factory', 'delivery', 'install'));
alter table steps add constraint steps_area_only_on_rework check (rework_area is null or kind = 'rework');
alter table steps add column hours numeric(5, 1) check (hours is null or hours > 0);

insert into settings (key, value, label, sort) values
  ('rework_drawings_days', 1, 'Rework drawings: working days', 160),
  ('hours_per_day',        8, 'Rework: hours in a factory or install day', 170);

-- Doers (Gus, Phil, the factory sign-in) can now pick the tasks when they raise a rework.
-- Only undated, unconfirmed tasks, only on an open rework they raised themselves; an Editor
-- dates them. Everything else about Doers is as before.
create or replace function hub_guard() returns trigger language plpgsql
set search_path = public, pg_temp as $$
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
    -- Doers tick steps done (and add a note), and raise rework with its tasks. Nothing else.
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
    raise exception 'Doers can tick steps and raise rework, nothing else' using errcode = '42501';
  end if;
  raise exception 'Viewers can''t change anything' using errcode = '42501';
end;
$$;

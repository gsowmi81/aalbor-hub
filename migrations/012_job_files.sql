-- Files on a job (George, 7 Nov 2026): plans attached to the job itself, not a link, each classed
-- as contract plans, production plans or other, with a version number per class so the latest is
-- unmistakable and the earlier ones stay on record. Editors add and remove; everyone opens.
-- The record (job_files) is in the change log; the bytes (job_file_blobs) are guarded but not logged.

create table job_files (
  id           serial primary key,
  job_id       integer not null references jobs (id) on delete cascade,
  kind         text not null check (kind in ('contract_plans', 'production_plans', 'other')),
  version      integer not null,
  name         text not null,
  content_type text not null,
  size         integer not null,
  note         text not null default '',
  added_by     integer references people (id),
  added_at     timestamptz not null default now(),
  unique (job_id, kind, version)
);
create index job_files_job on job_files (job_id);

create table job_file_blobs (
  file_id integer primary key references job_files (id) on delete cascade,
  bytes   bytea not null
);

-- hub_guard: whoever adds a file is recorded on it. Doers and Viewers fall through to the usual refusal.
create or replace function hub_guard() returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  actor text := hub_actor();
  r     text;
  pid   integer;
  kept  text[] := array['done_at', 'done_by', 'note', 'gaps_adjusted', 'site_clean'];
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
  if tg_table_name = 'step_photos' and tg_op = 'INSERT' then
    new.added_by := pid;
  end if;
  if tg_table_name = 'job_files' and tg_op = 'INSERT' then
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
    -- Install photos go with the tick (George, 7 Nov 2026).
    if tg_table_name = 'step_photos' and tg_op = 'INSERT' then
      return new;
    end if;
    raise exception 'Doers can tick steps, raise rework and flag problems, nothing else' using errcode = '42501';
  end if;
  raise exception 'Viewers can''t change anything' using errcode = '42501';
end;
$$;

create trigger job_files_guard before insert or update or delete on job_files for each row execute function hub_guard();
create trigger job_files_log after insert or update or delete on job_files for each row execute function hub_log();
create trigger job_file_blobs_guard before insert or update or delete on job_file_blobs for each row execute function hub_guard();

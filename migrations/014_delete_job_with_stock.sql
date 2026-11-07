-- Deleting a job that has stock moves (picked or received for it) failed: the cascade that clears
-- job_id on the ledger counted as an edit. The ledger's rows never change otherwise.
create or replace function hub_guard() returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare
  actor text := hub_actor();
  r     text;
  pid   integer;
  kept  text[] := array['done_at', 'done_by', 'note', 'gaps_adjusted', 'site_clean'];
  issue_kept text[] := array['status', 'closed_at', 'closed_by', 'close_note'];
  order_kept text[] := array['status', 'received_qty', 'received_on', 'note'];
  stock boolean;
begin
  if actor is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if actor = 'system' then
    return coalesce(new, old);
  end if;
  pid := actor::integer;
  select role, can_stock into r, stock from people where id = pid and active;
  if r is null then
    raise exception 'This person has no access' using errcode = '42501';
  end if;

  -- Stock (George, 7 Nov 2026): who did what is stamped on the row; the ledger is never edited.
  if tg_table_name = 'stock_moves' then
    -- Deleting a job or an order only unlinks the move (on delete set null); everything else stays as written.
    if tg_op = 'UPDATE' and (to_jsonb(new) - 'job_id' - 'order_id') = (to_jsonb(old) - 'job_id' - 'order_id') then
      return new;
    end if;
    if tg_op <> 'INSERT' then
      raise exception 'The stock ledger is never changed; add a correcting move instead' using errcode = '42501';
    end if;
    new.moved_by := pid;
  end if;
  if tg_table_name = 'orders' and tg_op = 'INSERT' then
    new.listed_by := pid;
  end if;
  if tg_table_name = 'offcuts' and tg_op = 'INSERT' then
    new.logged_by := pid;
  end if;
  if tg_table_name = 'offcuts' and tg_op = 'UPDATE' then
    if new.used_at is distinct from old.used_at then
      new.used_by := case when new.used_at is null then null else pid end;
    end if;
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
  -- Someone with the Stock tick (Angela) does anything on the stock tables, whatever their role.
  if stock and tg_table_name in ('stock_items', 'code_aliases', 'stock_moves', 'offcuts', 'job_materials', 'orders') then
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
    -- The floor: receive, pick, count, log an offcut, say a bin is running low (George, 7 Nov 2026).
    if tg_table_name = 'stock_moves' and tg_op = 'INSERT' then
      if new.kind in ('received', 'picked', 'counted', 'offcut') then
        return new;
      end if;
    end if;
    if tg_table_name = 'offcuts' then
      return coalesce(new, old);
    end if;
    if tg_table_name = 'orders' and tg_op = 'INSERT' then
      if new.reason = 'low' and new.status = 'listed' then
        return new;
      end if;
    end if;
    if tg_table_name = 'orders' and tg_op = 'UPDATE' then
      if (to_jsonb(new) - order_kept) = (to_jsonb(old) - order_kept) then
        return new;
      end if;
    end if;
    -- Picking, and stock that came in for the job (receiving marks the line as on hand).
    if tg_table_name = 'job_materials' and tg_op = 'UPDATE' then
      if (to_jsonb(new) - array['picked', 'allocated']) = (to_jsonb(old) - array['picked', 'allocated']) then
        return new;
      end if;
    end if;
    raise exception 'Doers can tick steps, raise rework and flag problems, nothing else' using errcode = '42501';
  end if;
  raise exception 'Viewers can''t change anything' using errcode = '42501';
end;
$$;

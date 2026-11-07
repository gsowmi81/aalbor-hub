-- Stock (George, 7 Nov 2026; the review's R14 to R20) and the factory TV.
-- The catalogue is the 183 lines of the Notion "Stock Items" database (data/notion-stock-2026-11-07.csv),
-- with the 7 Jul 2026 stocktake as the opening balance in the ledger. No prices, no valuation.

-- The factory TV link: a key in the address, made in Settings. Empty means no TV link yet.
insert into app_settings (key, value, label, sort) values ('tv_token', '', 'Factory TV link key', 30) on conflict (key) do nothing;

-- The Stock tick: anyone with it (Angela) can do everything on the stock tables, whatever their role.
alter table people add column can_stock boolean not null default false;

create table stock_items (
  id           serial primary key,
  code         text not null default '',           -- the Cabinet Vision / supplier code; what a cut list matches on
  name         text not null,
  category     text not null default '',           -- the Notion grouping: Boards – full sheets, Edging, Runners – Titus...
  kind         text not null check (kind in ('board', 'edging', 'hardware', 'consumable', 'other')),
  unit         text not null default 'each',
  supplier     text not null default '',
  lead_days    integer not null default 5,         -- working days from order to in
  minimum      numeric(10,2),                      -- standing lines only: at or under this is "running low"
  reorder_qty  numeric(10,2),                      -- how much to order when low
  bin          text not null default '',           -- bin or shelf label; the QR on it opens "Running low"
  image_url    text not null default '',           -- the supplier's picture, a link only
  standing     boolean not null default false,     -- always stocked: on the Friday count and the low-stock rule
  needs_check  boolean not null default false,     -- Notion "Verify": recount at the next walk
  use_down     boolean not null default false,     -- obsolete: use on legacy jobs, never reorder
  active       boolean not null default true,
  notes        text not null default '',
  created_at   timestamptz not null default now()
);
create unique index stock_items_code on stock_items (lower(code)) where code <> '';
create index stock_items_name on stock_items (lower(name));

-- Other codes that mean the same item (a cut list's spelling, a supplier's old code).
create table code_aliases (
  alias   text primary key,
  item_id integer not null references stock_items (id) on delete cascade
);

-- The ledger: on hand is never typed, it is the sum of these. Append-only.
create table stock_moves (
  id        serial primary key,
  item_id   integer not null references stock_items (id) on delete cascade,
  kind      text not null check (kind in ('opening', 'received', 'picked', 'counted', 'adjusted', 'offcut')),
  qty       numeric(10,2) not null,                -- signed: received +, picked −, counted = the difference
  job_id    integer references jobs (id) on delete set null,
  order_id  integer,
  reason    text not null default '',
  moved_by  integer references people (id),
  moved_at  timestamptz not null default now()
);
create index stock_moves_item on stock_moves (item_id, moved_at);

-- Offcuts of non-stocked colours over half a sheet: colour, size, where it is.
create table offcuts (
  id        serial primary key,
  item_id   integer not null references stock_items (id) on delete cascade,
  length_mm integer not null,
  width_mm  integer not null,
  location  text not null default '',
  note      text not null default '',
  logged_by integer references people (id),
  logged_at timestamptz not null default now(),
  used_at   timestamptz,
  used_by   integer references people (id)
);

-- Materials a job needs (from the Cabinet Vision cut list or typed), and where each line is coming from.
create table job_materials (
  id        serial primary key,
  job_id    integer not null references jobs (id) on delete cascade,
  item_id   integer not null references stock_items (id),
  qty       numeric(10,2) not null check (qty > 0),
  allocated numeric(10,2) not null default 0,      -- taken from stock on hand by sourcing
  picked    numeric(10,2) not null default 0,      -- left the shelf for this job
  nested    boolean not null default false,        -- sheet counts are right only after nesting
  note      text not null default '',
  unique (job_id, item_id)
);

-- The order list and what came of it. No order numbers, no prices.
create table orders (
  id           serial primary key,
  item_id      integer not null references stock_items (id),
  qty          numeric(10,2) not null check (qty > 0),
  job_id       integer references jobs (id) on delete set null,   -- null: for stock
  reason       text not null check (reason in ('shortfall', 'low', 'job', 'manual')),
  status       text not null default 'listed' check (status in ('listed', 'ordered', 'received', 'cancelled')),
  order_by     date,                               -- factory date minus the supplier's lead days
  listed_by    integer references people (id),
  listed_at    timestamptz not null default now(),
  ordered_on   date,
  expected     date,
  received_qty numeric(10,2) not null default 0,
  received_on  date,
  note         text not null default ''
);
create index orders_item on orders (item_id, status);

-- The change log keys code_aliases by the alias.
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
    when tg_table_name = 'code_aliases' then j ->> 'alias'
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

do $$
declare t text;
begin
  foreach t in array array['stock_items', 'code_aliases', 'offcuts', 'job_materials', 'orders'] loop
    execute format('create trigger %I_guard before insert or update or delete on %I for each row execute function hub_guard()', t, t);
    execute format('create trigger %I_log after insert or update or delete on %I for each row execute function hub_log()', t, t);
  end loop;
end $$;
-- The ledger is its own record: guarded (append-only), not logged twice.
create trigger stock_moves_guard before insert or update or delete on stock_moves for each row execute function hub_guard();

-- ---------- The catalogue from Notion, and the 7 Jul 2026 stocktake as the opening balance ----------
create temporary table seed_items (code text, name text, category text, kind text, unit text, supplier text, standing boolean, needs_check boolean, use_down boolean, notes text, on_hand numeric, last_counted date);
insert into seed_items values
('BL162', 'Basin mixer', 'Bathroom / PC items', 'other', 'pcs', '', false, false, false, '', 3, '2026-07-07'),
('', 'Floor waste 115x115x90 tile insert', 'Bathroom / PC items', 'other', 'pcs', '', false, false, false, '', 1, '2026-07-07'),
('OS-2', 'Trinity toilet', 'Bathroom / PC items', 'other', 'pcs', '', false, false, false, '', 1, '2026-07-07'),
('QL400 + TB865', 'Vanity', 'Bathroom / PC items', 'other', 'pcs', '', false, false, false, '', 1, '2026-07-07'),
('QL750-36', 'Vanity – 750', 'Bathroom / PC items', 'other', 'pcs', '', false, false, false, '', 1, '2026-07-07'),
('', 'Alabaster Matte', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'Added 13 Sep 2026. Hannah Gutmann kitchen uppers. Edging ''Alabaster Sheen'' exists — confirm Matte edging needed.', null, null),
('', 'Antique White', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, false, false, '', 3, '2026-07-07'),
('', 'Blossom White Matte', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'No count in source – count at walk-through', null, null),
('', 'Bottega Oak Woodmatt', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'Added 13 Sep 2026 for demand tracking — count on hand at next Friday walk. Anton Bergheim doors.', null, null),
('1038 - 1621412 DS', 'Carcass texture particle board', 'Boards – full sheets', 'board', 'sheet', '', true, true, false, 'No count in source – core carcass board, count and set min at walk-through', null, null),
('', 'Classic White Matte', 'Boards – full sheets', 'board', 'sheet', 'Polytec', true, false, false, 'White buffer stock – candidate for min level Notion code: 2415mm.', 34, '2026-07-07'),
('', 'Classic White Sheen', 'Boards – full sheets', 'board', 'sheet', 'Polytec', true, false, false, 'White buffer stock – candidate for min level Notion code: 2415mm.', 38, '2026-07-07'),
('', 'Florentine Walnut Woodmatt', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'Added 13 Sep 2026. Hannah Gutmann (lowers/tall/laundry/vanity), Nathalia Yamamoto (uppers/laundry/vanities). Recurring colour — candidate for a min level.', null, null),
('', 'Formica brushed silver', 'Boards – full sheets', 'board', 'sheet', 'Trademaster', false, false, false, '', 6, '2026-07-07'),
('', 'Plantation Ash', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'Added 13 Sep 2026. Peter Jones kitchen.', null, null),
('', 'Polar White Matte', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, false, false, '', 1, '2026-07-07'),
('', 'Polar White Sheen', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'No count in source – count at walk-through', null, null),
('', 'Polytec Woodmatt – oak/alpine range (Boston Oak, Prime Oak, Natural Oak, Alpine)', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, '14 sheets total across the colours listed – split by colour at walk-through (Prime Oak listed twice in source) Notion code: 2415mm.', 14, '2026-07-07'),
('', 'Prime Oak Woodmatt', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'Added 13 Sep 2026. Was lumped in ''Polytec Woodmatt – oak/alpine range'' (14 sheets, unsplit) — split the count at next walk. Wissam kitchen + laundry doors.', null, null),
('', 'Raw MDF 18mm', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'Added 13 Sep 2026. 2-pac door substrate (Tesoriero, Patch, Sharpe) + raw bulkheads. Calandra used ~9 sheets.', null, null),
('', 'Satin White', 'Boards – full sheets', 'board', 'sheet', '', false, true, false, 'Added 13 Sep 2026. NOT the same as Classic White (Sheen/Matte) — George 13 Sep. Brand to confirm. Sean McGing kitchen + laundry: check qty on hand covers the job before 18 Sep check measure. Elaine Jackson was sold as Satin White but her BOM was entered as White sheen — confirm which was cut.', null, null),
('', 'Stone Grey Matte', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, false, false, '', 1, '2026-07-07'),
('', 'Tasmanian Oak Woodmatt', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'Added 13 Sep 2026 (board; edging line already exists). Charley Meyer, Nicole Delaat.', null, null),
('', 'Verdelho Smooth', 'Boards – full sheets', 'board', 'sheet', 'Polytec', false, true, false, 'Added 13 Sep 2026. Nicola Parry vanities. Edging line exists as ''Verdalo Smooth'' (spelling).', null, null),
('', '2/10 separating agent (edgebander)', 'Consumables', 'consumable', 'unit', 'Trademaster', true, false, false, 'Edgebander consumable – never run out Notion code: LCM.', 1, '2026-07-07'),
('', 'Black corflute', 'Consumables', 'consumable', 'sheet', '', false, false, false, 'Unopened', 2, '2026-07-07'),
('', 'Clear floor protectors – 1 metre', 'Consumables', 'consumable', 'pcs', '', false, false, false, 'Unopened', 5, '2026-07-07'),
('DUSTEFH80MM', 'Dust extraction flexible hose 80mm x 100m', 'Consumables', 'consumable', 'roll', '', false, false, false, '', 3, '2026-07-07'),
('SC1000', 'Fullertak contact glue – 20L pail', 'Consumables', 'consumable', 'pail', 'Fuller', true, false, false, 'Open/part-used – never run out', 1, '2026-07-07'),
('', 'LC 2.30 purifying agent (edgebander)', 'Consumables', 'consumable', 'unit', 'Trademaster', true, false, false, 'Edgebander consumable – never run out Notion code: LCM.', 1, '2026-07-07'),
('', 'Melamine cleaner', 'Consumables', 'consumable', 'unit', '', true, false, false, 'Open/part-used', 1, '2026-07-07'),
('POLY02/75', 'POLY01 / POLY02 dust bags', 'Consumables', 'consumable', 'pcs', 'Eurofit', true, false, false, 'Extraction consumable – never run out', 2, '2026-07-07'),
('', 'Power Wash A1 Evolution – 20L', 'Consumables', 'consumable', 'pail', '', false, false, false, '', 1, '2026-07-07'),
('', 'Super Clear sprayable contact', 'Consumables', 'consumable', 'unit', 'Bostik', true, false, false, 'Open/part-used', 1, '2026-07-07'),
('', 'Turps – 4 litre', 'Consumables', 'consumable', 'bottle', 'Diggers', true, false, false, '', 3, '2026-07-07'),
('', 'Drill bits 160mm x 5.5mm', 'Cutting – bits & blades', 'consumable', 'pcs', '', true, false, false, '', 3, '2026-07-07'),
('', 'Drill bits 160mm x 6.5mm', 'Cutting – bits & blades', 'consumable', 'pcs', '', true, false, false, '', 16, '2026-07-07'),
('', 'Drill bits 160mm x 6mm', 'Cutting – bits & blades', 'consumable', 'pcs', '', true, false, false, '', 5, '2026-07-07'),
('', 'Drill bits 350mm x 12mm', 'Cutting – bits & blades', 'consumable', 'pcs', '', true, false, false, '', 2, '2026-07-07'),
('', 'Router bits', 'Cutting – bits & blades', 'consumable', 'pcs', '', true, false, false, 'Itemise types at walk-through', 3, '2026-07-07'),
('', 'Alabaster Sheen', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.5, '2026-07-07'),
('', 'Amaro Matt', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.25, '2026-07-07'),
('', 'Antique White', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 1, '2026-07-07'),
('', 'Artisan Oak Matte', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.25, '2026-07-07'),
('', 'Avion Grey Venette', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.25, '2026-07-07'),
('', 'Avon Sheen', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.25, '2026-07-07'),
('', 'Black Wood Matt', 'Edging', 'edging', 'roll', '', false, false, false, '', 0.5, '2026-07-07'),
('', 'Bottega Oak Woodmatt', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.5, '2026-07-07'),
('', 'Café Crème Sheen', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 1.25, '2026-07-07'),
('', 'Camembert Sheen', 'Edging', 'edging', 'roll', '', false, false, false, '', 1, '2026-07-07'),
('', 'Caraway', 'Edging', 'edging', 'roll', '', false, false, false, '', 0.25, '2026-07-07'),
('', 'Classic White Sheen ABS', 'Edging', 'edging', 'roll', '', true, false, false, 'Matches white board range – candidate for min level', 1, '2026-07-07'),
('', 'Euro Beech', 'Edging', 'edging', 'roll', 'Trademaster', false, false, false, '', 0.25, '2026-07-07'),
('', 'European Walnut Matt', 'Edging', 'edging', 'roll', '', false, false, false, '', 1, '2026-07-07'),
('', 'Exotic Wood Matt', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.25, '2026-07-07'),
('', 'Marina Grey', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 1, '2026-07-07'),
('', 'Mountain Pepper Matte', 'Edging', 'edging', 'roll', '', false, false, false, '', 1.25, '2026-07-07'),
('', 'Mountain Pepper Sheen', 'Edging', 'edging', 'roll', '', false, false, false, '', 0.25, '2026-07-07'),
('', 'Oyster Grey Matte', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 1, '2026-07-07'),
('', 'Oyster Grey Sheen', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.5, '2026-07-07'),
('', 'Pannacotta Matt', 'Edging', 'edging', 'roll', '', false, false, false, 'Name normalised from ''pannecotte matt''', 0.5, '2026-07-07'),
('', 'Polar White Matte ABS', 'Edging', 'edging', 'roll', '', true, false, false, 'Matches white board range – candidate for min level', 2, '2026-07-07'),
('', 'Porcelain Matte', 'Edging', 'edging', 'roll', '', false, false, false, 'Name normalised from ''Porclain matte''', 0.5, '2026-07-07'),
('', 'Snowdrift Gloss', 'Edging', 'edging', 'roll', 'Trademaster', false, false, false, '', 3, '2026-07-07'),
('', 'Stone Grey', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.25, '2026-07-07'),
('', 'Tasmanian Oak Woodmatt', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.5, '2026-07-07'),
('', 'Verdalo Smooth', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.5, '2026-07-07'),
('', 'White Mist Matte', 'Edging', 'edging', 'roll', 'Polytec', false, false, false, '', 0.25, '2026-07-07'),
('', 'BIN WB', 'Hardware – misc', 'hardware', 'pcs', 'Eurofit', false, false, false, '', 10, '2026-07-07'),
('20w19', 'Ceiling bathroom fan 20W – ducted', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 1, '2026-07-07'),
('', 'Ceiling exhaust fan – bathrooms', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 4, '2026-07-07'),
('', 'Ceiling mounted oyster lights – 3 temp', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 10, '2026-07-07'),
('', 'Chrome 20mm fitting bracket', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 125, '2026-07-07'),
('', 'Chrome pillar centre', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 24, '2026-07-07'),
('', 'Cupboard L brackets', 'Hardware – misc', 'hardware', 'pack', '', false, false, false, '', 1, '2026-07-07'),
('', 'Door handles – 460mm', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 16, '2026-07-07'),
('', 'Door hinges', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 5, '2026-07-07'),
('2645-835-001', 'Feet', 'Hardware – misc', 'hardware', 'pcs', 'Titus', true, false, false, '', 16, '2026-07-07'),
('RB-04T', 'Folding door top track – 2500mm', 'Hardware – misc', 'hardware', 'length', 'Eurofit', false, false, false, '', 2, '2026-07-07'),
('', 'Laminate 3.6m', 'Hardware – misc', 'hardware', 'sheet', 'Trademaster', false, false, false, '', 1, '2026-07-07'),
('3528-W-60RW', 'LED strip', 'Hardware – misc', 'hardware', 'reel', 'OzLED', false, false, false, '', 10, '2026-07-07'),
('2699-835-001', 'Legs – size 100', 'Hardware – misc', 'hardware', 'pcs', 'Titus', false, false, false, '', 1, '2026-07-07'),
('2672-835-001', 'Legs – size 140', 'Hardware – misc', 'hardware', 'pcs', 'Titus', false, false, false, '', 1, '2026-07-07'),
('', 'Light strip maintenance box – misc items', 'Hardware – misc', 'hardware', 'box', '', false, false, false, 'Mixed contents – itemise only if it matters', 1, '2026-07-07'),
('', 'Mixed bag of legs', 'Hardware – misc', 'hardware', 'bag', '', false, false, false, 'Sort or bin at walk-through', 1, '2026-07-07'),
('ES0-02', 'Oval rail supports – chrome', 'Hardware – misc', 'hardware', 'pcs', 'Eurofit', false, false, false, '', 50, '2026-07-07'),
('915.7188.350.00', 'Push catch', 'Hardware – misc', 'hardware', 'pcs', 'Titus', true, false, false, '', 61, '2026-07-07'),
('', 'Rode fitting brackets (round)', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 20, '2026-07-07'),
('', 'Silver pillar centre', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 35, '2026-07-07'),
('655-5214-51-100', 'Slimline front bar for internal drawer', 'Hardware – misc', 'hardware', 'pcs', 'Tekform', false, false, false, '', 13, '2026-07-07'),
('6558189-511-00', 'Slimline front basic panels', 'Hardware – misc', 'hardware', 'pcs', 'Tekform', false, false, false, '', 21, '2026-07-07'),
('H001-96', 'Tapered bow handle', 'Hardware – misc', 'hardware', 'pcs', 'Eurofit', false, false, false, '', 30, '2026-07-07'),
('', 'Transformer for downlight 12V', 'Hardware – misc', 'hardware', 'pcs', '', false, false, false, '', 20, '2026-07-07'),
('', 'Vinyl wrap', 'Hardware – misc', 'hardware', 'roll', '', false, false, false, '', 6, '2026-07-07'),
('', 'Wardrobe rod fittings', 'Hardware – misc', 'hardware', 'packet', '', false, false, false, '', 1, '2026-07-07'),
('', '110 degree hinges', 'Hinges & plates', 'hardware', 'pcs', 'Titus', true, true, false, 'Unusually high count – recount at walk-through', 1264, '2026-07-07'),
('', '165 degree hinge', 'Hinges & plates', 'hardware', 'pcs', '', false, false, false, '', 61, '2026-07-07'),
('', 'Bi-fold hinge', 'Hinges & plates', 'hardware', 'pcs', '', false, false, false, '', 200, '2026-07-07'),
('', 'Blind corner', 'Hinges & plates', 'hardware', 'pcs', 'Bella', false, true, false, 'High count – recount at walk-through', 400, '2026-07-07'),
('', 'Blind corner hinge', 'Hinges & plates', 'hardware', 'pcs', 'Titus', false, false, false, '', 183, '2026-07-07'),
('', 'Cover plates – standard hinges', 'Hinges & plates', 'hardware', 'pcs', 'Titus', true, false, false, '', 150, '2026-07-07'),
('', 'Hinge mounting plate', 'Hinges & plates', 'hardware', 'pcs', 'Bella', true, true, false, 'Unusually high count – recount at walk-through', 1782, '2026-07-07'),
('700-OK02-054-00', 'Hinges', 'Hinges & plates', 'hardware', 'pcs', 'Titus', true, false, false, '', 150, '2026-07-07'),
('', 'Hinges 175', 'Hinges & plates', 'hardware', 'pcs', 'Titus', false, false, false, '', 50, '2026-07-07'),
('', 'Hinges – bi-fold', 'Hinges & plates', 'hardware', 'pcs', 'Titus', false, false, false, 'Second bi-fold line (141) also appears under Obsolete – confirm which is which at walk-through', 141, '2026-07-07'),
('', 'LAMA hinges', 'Hinges & plates', 'hardware', 'pcs', 'Titus', false, false, false, '', 243, '2026-07-07'),
('', 'Mounting hinge plates', 'Hinges & plates', 'hardware', 'pcs', 'Titus', true, true, false, 'Unusually high count – recount at walk-through', 2954, '2026-07-07'),
('', 'Push catches – door dampener plastic grey', 'Hinges & plates', 'hardware', 'pcs', 'Bella Group', false, false, false, '', 2, '2026-07-07'),
('T90D8', 'Soft close hinges', 'Hinges & plates', 'hardware', 'pcs', 'Bella', true, false, false, '', 100, '2026-07-07'),
('OPK4-650-00', 'Soft close hinges', 'Hinges & plates', 'hardware', 'carton', 'Titus', true, false, false, '', 4, '2026-07-07'),
('608.8U08.360.001', 'Capri profile C section 3600 / Foggy Silver', 'Kicks & profiles', 'hardware', 'length', '', false, false, false, '', 25, '2026-07-07'),
('608.8U10.360.001', 'Capri profile J section 3600 / Foggy Silver', 'Kicks & profiles', 'hardware', 'length', '', false, false, false, '', 29, '2026-07-07'),
('', 'Grey kick – full length', 'Kicks & profiles', 'hardware', 'length', '', false, false, false, '', 1, '2026-07-07'),
('', 'Kickboard plinth strip 2400mm', 'Kicks & profiles', 'hardware', 'length', 'Trademaster', false, false, false, '', 1, '2026-07-07'),
('', 'Mirror kicks – 3030 x 270', 'Kicks & profiles', 'hardware', 'length', '', false, false, false, '', 1, '2026-07-07'),
('DA-1MD', 'Aiphone intercom', 'Misc', 'other', 'pcs', 'Aiphone', false, true, false, 'No count in source', null, null),
('', 'Banner artwork BIG', 'Misc', 'other', 'pcs', 'Mesh Direct', false, false, false, '', 1, '2026-07-07'),
('', 'Banner artwork SMALL', 'Misc', 'other', 'pcs', 'Mesh Direct', false, false, false, '', 5, '2026-07-07'),
('', 'Cutlery trays s/steel organiser', 'Misc', 'other', 'pcs', 'Bella Group', false, false, false, '', 4, '2026-07-07'),
('', 'Google review tap plates', 'Misc', 'other', 'pcs', '', false, false, false, '', 3, '2026-07-07'),
('', 'Riggamate gloves XL', 'Misc', 'other', 'pcs', 'Signet', true, false, false, '2 boxes of 12', 24, '2026-07-07'),
('248-OT13-050-ST', 'Hinges', 'Obsolete – use-down', 'hardware', 'pcs', 'Titus', false, false, true, 'Available for legacy-spec jobs – not on weekly walk-check', 600, '2026-07-07'),
('244-0259-050-00', 'Hinges (not incl. plate)', 'Obsolete – use-down', 'hardware', 'carton', 'Titus', false, false, true, 'Available for legacy-spec jobs – not on weekly walk-check', 11, '2026-07-07'),
('', 'Hinges – bi-fold', 'Obsolete – use-down', 'hardware', 'pcs', 'Titus', false, false, true, 'Available for legacy-spec jobs – not on weekly walk-check', 141, '2026-07-07'),
('BIN-400 S1W', 'BIN-400 S1W', 'Runners – Bella', 'hardware', 'box', 'Bella', true, false, false, 'Unopened', 3, '2026-07-07'),
('BIN-400 S2W', 'BIN-400 S2W', 'Runners – Bella', 'hardware', 'box', 'Bella', true, false, false, 'Unopened', 6, '2026-07-07'),
('BIN-400 S3W', 'BIN-400 S3W', 'Runners – Bella', 'hardware', 'box', 'Bella', true, false, false, 'Unopened', 7, '2026-07-07'),
('BIN-450 S2W', 'BIN-450 S2W', 'Runners – Bella', 'hardware', 'box', 'Bella', true, false, false, 'Unopened', 1, '2026-07-07'),
('BIN-500 S1W', 'BIN-500 S1W', 'Runners – Bella', 'hardware', 'box', 'Bella', true, false, false, 'Unopened', 7, '2026-07-07'),
('BIN-550 S1W', 'BIN-550 S1W', 'Runners – Bella', 'hardware', 'box', 'Bella', true, false, false, 'Unopened', 12, '2026-07-07'),
('BIN-550 S2W', 'BIN-550 S2W', 'Runners – Bella', 'hardware', 'box', 'Bella', true, true, false, 'Listed twice in source (2 + 4) – merged, verify at walk-through', 6, '2026-07-07'),
('BIN-550 S3W', 'BIN-550 S3W', 'Runners – Bella', 'hardware', 'box', 'Bella', true, false, false, 'Unopened', 4, '2026-07-07'),
('655 8T27 150', '655 8T27 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 9, '2026-07-07'),
('655 8T35 150', '655 8T35 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 4, '2026-07-07'),
('655 8T40 150', '655 8T40 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, true, false, 'Listed twice in source (3 + 3) – merged, verify', 6, '2026-07-07'),
('655 8U35 150', '655 8U35 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 1, '2026-07-07'),
('655 8U40 150', '655 8U40 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 2, '2026-07-07'),
('655 8U45 150', '655 8U45 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 4, '2026-07-07'),
('655 8V27 150', '655 8V27 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 1, '2026-07-07'),
('655 8V35 150', '655 8V35 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 5, '2026-07-07'),
('655 8V40 150', '655 8V40 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 1, '2026-07-07'),
('655 8Z27 150', '655 8Z27 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 5, '2026-07-07'),
('655 8Z40 150', '655 8Z40 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 7, '2026-07-07'),
('655 8Z40 185', '655 8Z40 185', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 1, '2026-07-07'),
('656 8T45 150', '656 8T45 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 5, '2026-07-07'),
('656 8T50 150', '656 8T50 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 7, '2026-07-07'),
('656 8U27 150', '656 8U27 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 3, '2026-07-07'),
('656 8U35 150', '656 8U35 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 1, '2026-07-07'),
('656 8U45 185', '656 8U45 185', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 5, '2026-07-07'),
('656 8U50 150', '656 8U50 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 3, '2026-07-07'),
('656 8V35 150', '656 8V35 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 4, '2026-07-07'),
('656 8V45 150', '656 8V45 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 2, '2026-07-07'),
('656 8V50 150', '656 8V50 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 4, '2026-07-07'),
('656 8Z35 150', '656 8Z35 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '1 ctn = 4 drawers', 4, '2026-07-07'),
('656 8Z45 150', '656 8Z45 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 6, '2026-07-07'),
('656 8Z45 185', '656 8Z45 185', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 4, '2026-07-07'),
('656 8Z50 150', '656 8Z50 150', 'Runners – Titus', 'hardware', 'carton', 'Titus', true, false, false, '', 4, '2026-07-07'),
('', 'Bench top bolts', 'Screws & fixings', 'hardware', 'packet', '', true, false, false, '', 3, '2026-07-07'),
('', 'Chipfast 4.0 x 65mm', 'Screws & fixings', 'hardware', 'box', '', true, false, false, 'Open boxes', 2, '2026-07-07'),
('', 'Gyprock screws', 'Screws & fixings', 'hardware', 'packet', '', true, false, false, '', 1, '2026-07-07'),
('', 'Packers mixed – 75mm', 'Screws & fixings', 'hardware', 'box', '', true, false, false, 'Open box', 1, '2026-07-07'),
('', 'Screws #10 x 100', 'Screws & fixings', 'hardware', 'box', 'Eurofit', true, false, false, 'Open box', 1, '2026-07-07'),
('', 'Screws #10 x 65', 'Screws & fixings', 'hardware', 'box', 'Eurofit', true, false, false, 'Open boxes', 2, '2026-07-07'),
('', 'Screws #10 x 75', 'Screws & fixings', 'hardware', 'box', 'Eurofit', true, false, false, '', 2, '2026-07-07'),
('', 'Screws #6 – 5/8"', 'Screws & fixings', 'hardware', 'box', '', true, false, false, '', 5, '2026-07-07'),
('', 'Screws #6.3-2.2 x 10', 'Screws & fixings', 'hardware', 'box', '', true, false, false, '', 12, '2026-07-07'),
('', 'Screws #8 x 28', 'Screws & fixings', 'hardware', 'carton', '', true, false, false, '+1 open box', 6, '2026-07-07'),
('', 'Screws #8 x 5/8"', 'Screws & fixings', 'hardware', 'box', '', true, false, false, '', 4, '2026-07-07'),
('', 'Screws #8 x 65', 'Screws & fixings', 'hardware', 'box', 'Eurofit', true, false, false, '', 4, '2026-07-07'),
('', 'Screws 8 x 40', 'Screws & fixings', 'hardware', 'box', '', true, false, false, '', 2, '2026-07-07'),
('', 'Screws 8 x 50', 'Screws & fixings', 'hardware', 'box', '', true, false, false, '', 9, '2026-07-07'),
('', 'Screws Titus 4 x 25mm', 'Screws & fixings', 'hardware', 'box', 'Titus', true, false, false, 'Open box', 1, '2026-07-07'),
('', 'Screws Wurth 4 x 50/30mm', 'Screws & fixings', 'hardware', 'carton', 'Wurth', true, false, false, '+1 open box', 7, '2026-07-07'),
('', 'Shelf pins', 'Screws & fixings', 'hardware', 'packet', '', true, false, false, '', 2, '2026-07-07'),
('', 'Spot nails 1-3/4" – 45mm', 'Screws & fixings', 'hardware', 'box', 'Eurofit', true, false, false, '', 1, '2026-07-07'),
('', 'Spot nails 16GA 1-3/4" – 44mm', 'Screws & fixings', 'hardware', 'box', 'Eurofit', true, false, false, '', 3, '2026-07-07'),
('', 'Spot nails – 16 gauge (1-3/4")', 'Screws & fixings', 'hardware', 'carton', 'Eurofit', true, false, false, '', 3, '2026-07-07'),
('', 'Strong hold brackets (white)', 'Screws & fixings', 'hardware', 'pcs', 'Eurofit', false, false, false, '', 3, '2026-07-07'),
('', 'Wall plugs (blue) 14-16G screw', 'Screws & fixings', 'hardware', 'box', '', true, false, false, 'Open box', 1, '2026-07-07'),
('', 'Wall plugs (green) 6.5 x 50', 'Screws & fixings', 'hardware', 'box', '', true, false, false, '', 7, '2026-07-07'),
('', 'Wall plugs (green) 7mm x 35mm', 'Screws & fixings', 'hardware', 'packet', '', true, false, false, '', 1, '2026-07-07'),
('', 'Wall plugs (orange) 6mm x 50mm', 'Screws & fixings', 'hardware', 'packet', '', true, false, false, '', 1, '2026-07-07'),
('', 'Wall plugs (orange) plug set in container', 'Screws & fixings', 'hardware', 'set', '', false, false, false, '320 pcs', 320, '2026-07-07');
insert into stock_items (code, name, category, kind, unit, supplier, standing, needs_check, use_down, notes)
  select code, name, category, kind, unit, supplier, standing, needs_check, use_down, notes from seed_items;
insert into stock_moves (item_id, kind, qty, reason, moved_at)
  select i.id, 'opening', s.on_hand, 'Opening balance: stocktake 7 Jul 2026 (from Notion)', coalesce(s.last_counted, date '2026-07-07')::timestamptz
  from seed_items s join stock_items i on i.name = s.name and i.category = s.category and i.code = s.code
  where s.on_hand is not null;
drop table seed_items;

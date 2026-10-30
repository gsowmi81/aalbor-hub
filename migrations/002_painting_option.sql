-- Painting is its own choice on a job (George, 30 Oct 2026): not every job needs it,
-- whatever the door finish. Existing jobs keep what they had: polyurethane jobs paint.
alter table jobs add column has_painting boolean not null default false;

-- Fix the Notion import: it read "Polytec" (the board brand) as polyurethane, so these five
-- melamine jobs were loaded as polyurethane with painting steps. Only jobs still in that state.
update jobs set door_finish = 'melamine'
 where door_finish = 'polyurethane'
   and job_number in ('260916', '260923', '261006', '261022', '270308');  -- Parry, Delaat, Gutmann, Jones, Yamamoto

update jobs set has_painting = (door_finish = 'polyurethane');

-- Their empty painting steps go. A painting step someone has dated or ticked stays,
-- and its job keeps painting switched on.
update jobs j set has_painting = true
 where not j.has_painting
   and exists (select 1 from steps s where s.job_id = j.id and s.kind in ('doors_to_painting', 'doors_back')
               and (s.start_date is not null or s.done_at is not null));
delete from steps s using jobs j
 where s.job_id = j.id and not j.has_painting
   and s.kind in ('doors_to_painting', 'doors_back') and s.label = ''
   and s.start_date is null and s.done_at is null;

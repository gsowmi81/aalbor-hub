-- Rework items can sit in any row of the board (George, 6 Nov 2026): the category picked when
-- adding one says which standard step it stands for, and so which row it shows in, in red.
alter table steps drop constraint steps_rework_area_check;
alter table steps add constraint steps_rework_area_check check (rework_area in (
  'contract_drafting', 'check_measure', 'production_drawings', 'materials_ordered',
  'factory', 'delivery', 'install', 'stone_install'));

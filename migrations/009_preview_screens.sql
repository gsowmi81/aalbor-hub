-- The preview round (George, 7 Nov 2026): pinned dates, areas per person for My day,
-- a drawings link per job, and a message for the board.

-- A pinned date is a promise (install, usually, once the client has it). No shift, squeeze or
-- dragged move changes it; a clash with it needs "Move anyway". Confirmed keeps meaning
-- "matches Buildertrend"; pinned means "set on purpose and not to be moved".
alter table steps add column pinned boolean not null default false;

-- Which board rows a person works in: their steps on My day. Editors set it in Settings.
alter table people add column areas text[] not null default '{}';
alter table people add constraint people_areas_known check (
  areas <@ array['contract', 'measure', 'drawings', 'orders', 'factory', 'install', 'stone']::text[]);

-- Where the drawings live (a Dropbox, OneDrive or Buildertrend folder): a web address only, no files.
alter table jobs add column drawings_url text not null default '';

-- One line from George or Christine at the top of My day and the board, like Jobman's message bar.
insert into app_settings (key, value, label, sort) values ('board_message', '', 'Message on My day and the board', 20)
  on conflict (key) do nothing;

-- Starting areas, by the names the team uses. George changes them in Settings.
update people set areas = array['factory'] where areas = '{}' and (name ilike 'phil%' or name ilike '%factory%');
update people set areas = array['measure'] where areas = '{}' and name ilike 'gus%';
update people set areas = array['contract', 'drawings', 'orders'] where areas = '{}' and (name ilike 'christine%' or email = 'design@aalborkitchens.com.au');
update people set areas = array['install'] where areas = '{}' and (name ilike 'sione%' or name ilike '%install%');

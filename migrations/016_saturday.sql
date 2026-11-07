-- Saturday as a working day (George, 7 Nov 2026): off by default. When the switch is on, Saturdays
-- count as working days everywhere (proposed dates, moves, the Board and TV columns, Needs a decision
-- stops saying "a Saturday"), and each crew has Saturday hours for capacity. Sundays stay off.
alter table labour_centres add column sat numeric(4, 1) not null default 0 check (sat >= 0);

insert into settings (key, value, label, sort) values
  ('saturday_working', 0, 'Saturdays are working days (0 no, 1 yes)', 170);

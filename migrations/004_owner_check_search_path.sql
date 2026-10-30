-- The nightly backup (pg_dump) runs with an empty search_path, so hub_is_owner() couldn't
-- find hub_actor() or people, and the backup of 31 Oct 2026 failed. Pin the search path on
-- the functions that row-level security and the triggers call.
alter function hub_actor() set search_path = public, pg_temp;
alter function hub_is_owner() set search_path = public, pg_temp;
alter function hub_owner_guard() set search_path = public, pg_temp;
alter function hub_owners_log() set search_path = public, pg_temp;
alter function hub_guard() set search_path = public, pg_temp;
alter function hub_log() set search_path = public, pg_temp;

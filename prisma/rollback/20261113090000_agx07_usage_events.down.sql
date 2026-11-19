-- Rollback of AGX-07 (20261113090000_agx07_usage_events).
DROP TABLE IF EXISTS "usage_event";
DROP FUNCTION IF EXISTS "usage_event_no_update"();
DROP TYPE IF EXISTS "UsageKind";

-- D5b option b: the scheduled export reaches in chat only the ADMINs who chose it.
-- Additive: no existing row changes (nobody receives it until they choose).
ALTER TABLE "membership" ADD COLUMN "scheduled_export_since" timestamptz;

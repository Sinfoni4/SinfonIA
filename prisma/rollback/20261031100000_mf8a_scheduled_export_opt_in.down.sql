-- Rollback of the scheduled export choice (D5b option b). Run as the schema owner before
-- reverting the code:
--   psql -v ON_ERROR_STOP=1 --single-transaction -f prisma/rollback/20261031100000_mf8a_scheduled_export_opt_in.down.sql
-- The choices made are lost; the previous code sends the export to every linked ADMIN.
ALTER TABLE "membership" DROP COLUMN "scheduled_export_since";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261031100000_mf8a_scheduled_export_opt_in';

-- Rollback of 20261127100000_sector_record_versions: removes the history of the entries and the
-- voiding. Voided entries become ordinary entries again (their deadlines stay closed): take an
-- encrypted backup first, and redeploy the previous release before running this.
DROP TABLE IF EXISTS "sector_record_version";
DROP FUNCTION IF EXISTS sector_record_version_deny_update();
DROP TYPE IF EXISTS "SectorRecordAction";
ALTER TABLE "sector_record"
  DROP CONSTRAINT IF EXISTS "sector_record_void_complete",
  DROP CONSTRAINT IF EXISTS "sector_record_version_positive",
  DROP COLUMN IF EXISTS "version",
  DROP COLUMN IF EXISTS "void_reason",
  DROP COLUMN IF EXISTS "voided_at",
  DROP COLUMN IF EXISTS "voided_by";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261127100000_sector_record_versions';

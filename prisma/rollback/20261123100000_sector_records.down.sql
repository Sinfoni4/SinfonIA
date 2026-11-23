-- Rollback of 20261123100000_sector_records: removes the registers of the sector functions and
-- the link of their deadlines (the deadlines themselves stay, unlinked). Deletes data: take an
-- encrypted backup first.
ALTER TABLE "compliance_deadline" DROP CONSTRAINT IF EXISTS "compliance_deadline_sector_record_id_fkey";
DROP INDEX IF EXISTS "compliance_deadline_sector_record_id_key";
ALTER TABLE "compliance_deadline" DROP COLUMN IF EXISTS "sector_record_id";
DROP TABLE IF EXISTS "sector_record";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123100000_sector_records';

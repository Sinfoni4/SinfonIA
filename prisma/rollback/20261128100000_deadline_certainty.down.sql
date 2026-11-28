-- Rollback of 20261128100000_deadline_certainty: every deadline is reminded again as confirmed.
-- Redeploy the previous release first; take an encrypted backup.
ALTER TABLE "compliance_deadline"
  DROP COLUMN IF EXISTS "certainty",
  DROP COLUMN IF EXISTS "verified_at",
  DROP COLUMN IF EXISTS "verified_by";
DROP TYPE IF EXISTS "DeadlineCertainty";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261128100000_deadline_certainty';

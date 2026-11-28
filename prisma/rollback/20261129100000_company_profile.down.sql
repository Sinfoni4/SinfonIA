-- Rollback of 20261129100000_company_profile: removes the company profiles and their checks.
-- Redeploy the previous release first; take an encrypted backup (the profiles are lost).
DROP TABLE IF EXISTS "company_profile_review";
DROP TABLE IF EXISTS "company_profile_version";
DROP FUNCTION IF EXISTS company_profile_deny_update();
DROP TYPE IF EXISTS "ProfileReviewOutcome";
DROP TYPE IF EXISTS "ProfileSource";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261129100000_company_profile';

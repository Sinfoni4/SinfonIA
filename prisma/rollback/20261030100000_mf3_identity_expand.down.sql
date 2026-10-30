-- Rollback of MF3 (expand step, M1): removes everything 20261030100000_mf3_identity_expand added
-- and nothing else. Data of the legacy columns is untouched: the application keeps working on it.
-- Run as the schema owner, in one transaction:
--   psql -v ON_ERROR_STOP=1 --single-transaction -f prisma/rollback/20261030100000_mf3_identity_expand.down.sql

DROP TRIGGER IF EXISTS mf3_sync_whatsapp ON "whatsapp_identity";
DROP TRIGGER IF EXISTS mf3_sync_user ON "user";
DROP FUNCTION IF EXISTS mf3_sync_whatsapp();
DROP FUNCTION IF EXISTS mf3_sync_user();
DROP FUNCTION IF EXISTS mf3_link_channel(uuid, "ChannelType", text);

DROP TABLE IF EXISTS "access_grant_beneficiary";
DROP TABLE IF EXISTS "access_grant";
DROP TABLE IF EXISTS "invitation";
DROP TABLE IF EXISTS "auth_challenge";
DROP TABLE IF EXISTS "session";
DROP TABLE IF EXISTS "organization_relation";
DROP TABLE IF EXISTS "channel_identity";
DROP TABLE IF EXISTS "membership";

ALTER TABLE "user"
  DROP COLUMN IF EXISTS "platform_role",
  DROP COLUMN IF EXISTS "auth_version",
  DROP COLUMN IF EXISTS "email_verified_at",
  DROP COLUMN IF EXISTS "status";

ALTER TABLE "tenant"
  DROP COLUMN IF EXISTS "deletion_scheduled_at",
  DROP COLUMN IF EXISTS "deactivated_at",
  DROP COLUMN IF EXISTS "status",
  DROP COLUMN IF EXISTS "type";

DROP TYPE IF EXISTS "BeneficiaryStatus";
DROP TYPE IF EXISTS "GrantOperation";
DROP TYPE IF EXISTS "GrantStatus";
DROP TYPE IF EXISTS "GranteeType";
DROP TYPE IF EXISTS "AuthChallengePurpose";
DROP TYPE IF EXISTS "RelationStatus";
DROP TYPE IF EXISTS "RelationType";
DROP TYPE IF EXISTS "ChannelType";
DROP TYPE IF EXISTS "MembershipStatus";
DROP TYPE IF EXISTS "PlatformRole";
DROP TYPE IF EXISTS "UserStatus";
DROP TYPE IF EXISTS "OrganizationStatus";
DROP TYPE IF EXISTS "OrganizationType";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030100000_mf3_identity_expand';

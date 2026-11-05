-- Rollback of 20261107090000_b2_custom_roles: memberships go back to their base role.
DROP TRIGGER IF EXISTS membership_custom_role_match ON "membership";
DROP FUNCTION IF EXISTS enforce_membership_custom_role();
ALTER TABLE "membership" DROP CONSTRAINT IF EXISTS "membership_custom_role_id_fkey";
DROP INDEX IF EXISTS "membership_custom_role_id_idx";
ALTER TABLE "membership" DROP COLUMN IF EXISTS "custom_role_id";
DROP TABLE IF EXISTS "org_role";

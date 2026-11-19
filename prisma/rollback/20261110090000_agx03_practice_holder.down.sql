-- Rollback of AGX-03 (20261110090000_agx03_practice_holder).
ALTER TABLE "practice" DROP CONSTRAINT IF EXISTS "practice_holder_user_id_fkey";
DROP INDEX IF EXISTS "practice_tenant_id_holder_user_id_idx";
ALTER TABLE "practice" DROP COLUMN IF EXISTS "holder_user_id";

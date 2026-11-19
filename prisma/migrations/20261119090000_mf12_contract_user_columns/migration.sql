-- MF12 step 5 (docs/FASE1_CORE_E_MODULI.md §7): contraction of the old model on "user".
-- Organizations and roles of a person are in "membership" (MF4), chat links in
-- "channel_identity" (MF3); since MF12 steps 1-3 the application neither reads nor writes these
-- columns (tests/mf12.legacy-columns.test.ts). To apply only after the verification period on
-- staging, with a backup. Rollback: prisma/rollback/20261107100000_mf12_contract_user_columns.down.sql

-- The trigger that mirrored the old columns into membership and channel_identity.
DROP TRIGGER IF EXISTS mf3_sync_user ON "user";
DROP FUNCTION IF EXISTS mf3_sync_user();

-- DropForeignKey
ALTER TABLE "user" DROP CONSTRAINT "user_tenant_id_fkey";

-- DropIndex
DROP INDEX "user_tenant_id_idx";

-- DropIndex
DROP INDEX "user_tenant_id_id_idx";

-- DropIndex
DROP INDEX "user_tenant_id_telegram_id_key";

-- AlterTable
ALTER TABLE "user" DROP COLUMN "role",
DROP COLUMN "telegram_id",
DROP COLUMN "tenant_id";

-- Rollback of 20261106090000_a03_tenant_features.
ALTER TABLE "tenant" DROP CONSTRAINT IF EXISTS "tenant_disabled_features_known";
ALTER TABLE "tenant" DROP COLUMN IF EXISTS "disabled_features";

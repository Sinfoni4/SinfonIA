-- A03 (voce 16, B15): functions the platform turns off for one organization from the console.
-- An empty list keeps everything on, as before; the values are checked by the application
-- (src/core/features/features.ts) and limited here to the known names.
-- Rollback: prisma/rollback/20261106090000_a03_tenant_features.down.sql
ALTER TABLE "tenant" ADD COLUMN "disabled_features" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_disabled_features_known" CHECK (
  "disabled_features" <@ ARRAY['ai_chat', 'documents', 'deadlines', 'assistance', 'exports', 'delegations', 'network_stats']::TEXT[]
);

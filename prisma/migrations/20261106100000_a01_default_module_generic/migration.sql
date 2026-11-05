-- A01 (docs/FASE1_CORE_E_MODULI.md §1): an organization created without a sector gets the
-- generic module, not the music one. Existing organizations keep their module.
-- Rollback: prisma/rollback/20261106100000_a01_default_module_generic.down.sql
ALTER TABLE "tenant" ALTER COLUMN "module" SET DEFAULT 'generic';

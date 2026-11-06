-- Rollback of AGX-02 (20261109090000_agx02_company_identifiers).
ALTER TABLE "tenant" DROP COLUMN IF EXISTS "external_refs";
ALTER TABLE "tenant" DROP COLUMN IF EXISTS "vat_number";
ALTER TABLE "tenant" DROP COLUMN IF EXISTS "tax_code";

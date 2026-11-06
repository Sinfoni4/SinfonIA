-- AGX-02: identifiers of a company (codice fiscale / CUAA, partita IVA, codes in other systems).
ALTER TABLE "tenant" ADD COLUMN "tax_code" TEXT;
ALTER TABLE "tenant" ADD COLUMN "vat_number" TEXT;
ALTER TABLE "tenant" ADD COLUMN "external_refs" JSONB;

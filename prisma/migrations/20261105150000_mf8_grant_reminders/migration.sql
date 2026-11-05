-- MF8 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §2.4, decision D3): the grantor is told 30 and
-- 7 days before a delegation ends; these columns keep each reminder to one per validity (a
-- renewal clears them). Additive only.
ALTER TABLE "access_grant"
  ADD COLUMN "reminded_30_at" TIMESTAMPTZ,
  ADD COLUMN "reminded_7_at" TIMESTAMPTZ;

CREATE INDEX "access_grant_status_valid_until_idx" ON "access_grant"("status", "valid_until");

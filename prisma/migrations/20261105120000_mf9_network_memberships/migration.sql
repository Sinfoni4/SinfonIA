-- MF9 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §1.2-§1.3, decision D4): memberships of companies
-- in networks, and the minimal profile a network sees of its members. Additive only.

-- I1: minimal profile of an organization (municipality and sector), set by its administrator.
ALTER TABLE "tenant"
  ADD COLUMN "municipality" TEXT,
  ADD COLUMN "sector" TEXT;

-- Who ended a membership, and whether the company refused it before it started.
ALTER TABLE "organization_relation"
  ADD COLUMN "ended_by" UUID,
  ADD COLUMN "refused" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "organization_relation_parent_org_id_status_idx"
  ON "organization_relation"("parent_org_id", "status");

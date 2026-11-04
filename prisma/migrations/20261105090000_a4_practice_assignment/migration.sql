-- A4 (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §5): who follows a practice. An administrator or
-- operator of the organization; when that person is deleted the practice goes back to nobody.
-- Additive only.
ALTER TABLE "practice"
  ADD COLUMN "assigned_to" UUID,
  ADD COLUMN "assigned_at" TIMESTAMPTZ;

CREATE INDEX "practice_tenant_id_assigned_to_idx" ON "practice"("tenant_id", "assigned_to");

ALTER TABLE "practice" ADD CONSTRAINT "practice_assigned_to_fkey"
  FOREIGN KEY ("assigned_to") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A1 (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §4.2, decision H9): data read from a document,
-- confirmed or corrected by a person. The read result (ocr_result) is never changed: the confirmed
-- values sit next to it, with who confirmed them and when. Additive only.
ALTER TABLE "practice_attachment"
  ADD COLUMN "validated_data" JSONB,
  ADD COLUMN "validated_at" TIMESTAMPTZ,
  ADD COLUMN "validated_by" UUID;

-- The review queue of an organization: documents not yet confirmed.
CREATE INDEX "practice_attachment_tenant_id_validated_at_idx"
  ON "practice_attachment"("tenant_id", "validated_at");

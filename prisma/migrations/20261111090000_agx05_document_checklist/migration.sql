-- AGX-05: the computed document checklist. An attachment can say which expected document of the
-- practice's type it is (expected_key, a key of the module), and a person can reject it with a
-- reason. Additive only: older attachments are simply not linked and not rejected.
ALTER TABLE "practice_attachment"
  ADD COLUMN "expected_key" TEXT,
  ADD COLUMN "rejected_at" TIMESTAMPTZ,
  ADD COLUMN "rejected_by" UUID,
  ADD COLUMN "rejection_reason" TEXT;

CREATE INDEX "practice_attachment_practice_id_expected_key_idx"
  ON "practice_attachment"("practice_id", "expected_key");

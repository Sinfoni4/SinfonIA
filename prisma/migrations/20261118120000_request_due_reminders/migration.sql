-- Reminders of the documents asked for with a date (AGX-06 follow-up): whoever must send the
-- document hears it two days before and on the day; these columns keep each reminder to one per
-- request. Additive only.
ALTER TABLE "document_request"
  ADD COLUMN "reminded_before_at" TIMESTAMPTZ,
  ADD COLUMN "reminded_due_at" TIMESTAMPTZ;

CREATE INDEX "document_request_tenant_id_status_due_date_idx"
  ON "document_request"("tenant_id", "status", "due_date");

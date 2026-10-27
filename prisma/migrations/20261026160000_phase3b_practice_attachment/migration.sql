-- Phase 3B: Practice Attachment and Document AI/OCR Table
CREATE TYPE "OcrStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- Practice Attachment Table
CREATE TABLE "practice_attachment" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "practice_id" uuid NOT NULL,
  "file_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "file_size" integer NOT NULL,
  "storage_path" text NOT NULL,
  "ocr_status" "OcrStatus" NOT NULL DEFAULT 'PENDING',
  "ocr_result" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "practice_attachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "practice_attachment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "practice_attachment_practice_id_fkey" FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "practice_attachment_tenant_id_idx" ON "practice_attachment"("tenant_id");
CREATE INDEX "practice_attachment_practice_id_idx" ON "practice_attachment"("practice_id");
CREATE INDEX "practice_attachment_tenant_id_ocr_status_idx" ON "practice_attachment"("tenant_id", "ocr_status");

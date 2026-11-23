-- Files attached to an entry of a sector register (a licence certificate, an invoice, ...).
-- Only additions. Rollback: prisma/rollback/20261123140000_sector_record_attachments.down.sql

-- CreateTable
CREATE TABLE "sector_record_attachment" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "storage_path" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "uploaded_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sector_record_attachment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sector_record_attachment_mime_known" CHECK ("mime_type" IN ('application/pdf','image/jpeg','image/png','image/webp')),
    CONSTRAINT "sector_record_attachment_size_positive" CHECK ("file_size" > 0),
    CONSTRAINT "sector_record_attachment_name_length" CHECK (char_length("file_name") BETWEEN 1 AND 255)
);

-- CreateIndex
CREATE INDEX "sector_record_attachment_record_id_idx" ON "sector_record_attachment"("record_id");

-- CreateIndex
CREATE INDEX "sector_record_attachment_org_id_idx" ON "sector_record_attachment"("org_id");

-- AddForeignKey
ALTER TABLE "sector_record_attachment" ADD CONSTRAINT "sector_record_attachment_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sector_record_attachment" ADD CONSTRAINT "sector_record_attachment_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "sector_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sector_record_attachment" ADD CONSTRAINT "sector_record_attachment_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

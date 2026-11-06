-- AGX-01 (safe document intake): the SHA-256 of each attachment, to flag a file already sent, and
-- the file a chat user still has to place, so a restart does not lose it. Only additions: existing
-- attachments keep a NULL hash. Rollback: prisma/rollback/20261108090000_agx01_safe_document_intake.down.sql

-- AlterTable
ALTER TABLE "practice_attachment" ADD COLUMN     "content_hash" TEXT;

-- AlterTable
ALTER TABLE "conversation_state" ADD COLUMN     "pending_file" JSONB;

-- CreateIndex
CREATE INDEX "practice_attachment_tenant_id_content_hash_idx" ON "practice_attachment"("tenant_id", "content_hash");

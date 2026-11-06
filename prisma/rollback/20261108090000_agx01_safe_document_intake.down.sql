-- Rollback of 20261108090000_agx01_safe_document_intake: hashes and files waiting in chat are
-- dropped (a waiting file is asked again by sending it once more).
DROP INDEX IF EXISTS "practice_attachment_tenant_id_content_hash_idx";
ALTER TABLE "practice_attachment" DROP COLUMN IF EXISTS "content_hash";
ALTER TABLE "conversation_state" DROP COLUMN IF EXISTS "pending_file";

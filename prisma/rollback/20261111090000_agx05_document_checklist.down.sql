-- Rollback of AGX-05 (20261111090000_agx05_document_checklist).
DROP INDEX IF EXISTS "practice_attachment_practice_id_expected_key_idx";
ALTER TABLE "practice_attachment" DROP COLUMN IF EXISTS "rejection_reason";
ALTER TABLE "practice_attachment" DROP COLUMN IF EXISTS "rejected_by";
ALTER TABLE "practice_attachment" DROP COLUMN IF EXISTS "rejected_at";
ALTER TABLE "practice_attachment" DROP COLUMN IF EXISTS "expected_key";

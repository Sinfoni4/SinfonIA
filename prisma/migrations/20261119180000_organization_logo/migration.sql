-- The logo of an organization, uploaded from the platform console and shown in the Telegram
-- Mini App: the file lives in the attachment storage (and so in the encrypted backups), the
-- table keeps only where it is, its type and when it changed. Additive only.
ALTER TABLE "tenant" ADD COLUMN "logo_path" TEXT;
ALTER TABLE "tenant" ADD COLUMN "logo_type" TEXT;
ALTER TABLE "tenant" ADD COLUMN "logo_updated_at" TIMESTAMPTZ;

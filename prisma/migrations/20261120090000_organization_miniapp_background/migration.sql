-- The background color of the Telegram Mini App, chosen by the administrator of the organization
-- (#rrggbb, dark enough for white text and icons); null keeps the default dark grey. Additive only.
ALTER TABLE "tenant" ADD COLUMN "miniapp_background" TEXT;

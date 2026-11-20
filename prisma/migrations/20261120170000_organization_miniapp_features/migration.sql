-- Functions of a sector shown in the Telegram Mini App, chosen apart from the dashboard
-- (enabled_features). Those already on stay on in both places.
ALTER TABLE "tenant" ADD COLUMN "miniapp_features" TEXT[] NOT NULL DEFAULT '{}';
UPDATE "tenant" SET "miniapp_features" = "enabled_features";
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_miniapp_features_known" CHECK (
  "miniapp_features" <@ ARRAY['risk_assessment', 'field_book', 'cap_file', 'farm_fuel', 'organic_certification', 'training_safety', 'trade_licenses', 'grants', 'business_startup', 'waste_records']::TEXT[]
);

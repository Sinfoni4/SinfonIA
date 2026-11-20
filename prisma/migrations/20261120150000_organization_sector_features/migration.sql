-- Functions of a sector (src/modules/sector-features.ts) turned on for the organization: off
-- unless listed, so existing organizations get none. Only known names, like disabled_features.
ALTER TABLE "tenant" ADD COLUMN "enabled_features" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_enabled_features_known" CHECK (
  "enabled_features" <@ ARRAY['risk_assessment', 'field_book', 'cap_file', 'farm_fuel', 'organic_certification', 'training_safety', 'trade_licenses', 'grants', 'business_startup', 'waste_records']::TEXT[]
);

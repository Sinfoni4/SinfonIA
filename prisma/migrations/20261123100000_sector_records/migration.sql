-- Registers of the functions of a sector (Quaderno di campagna, Abilitazioni e patentini, ...):
-- one row per entry, with the fields declared by the function (src/modules/sector-records.ts).
-- Only additions. Rollback: prisma/rollback/20261123100000_sector_records.down.sql

-- CreateTable
CREATE TABLE "sector_record" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "feature" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "occurred_on" DATE,
    "due_date" DATE,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sector_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sector_record_feature_known" CHECK ("feature" IN ('risk_assessment','field_book','cap_file','farm_fuel','organic_certification','training_safety','trade_licenses','grants','business_startup','waste_records')),
    CONSTRAINT "sector_record_kind_length" CHECK (char_length("kind") BETWEEN 1 AND 40),
    CONSTRAINT "sector_record_title_length" CHECK (char_length("title") BETWEEN 1 AND 300),
    CONSTRAINT "sector_record_data_object" CHECK (jsonb_typeof("data") = 'object')
);

-- CreateIndex
CREATE INDEX "sector_record_org_id_feature_occurred_on_idx" ON "sector_record"("org_id", "feature", "occurred_on");

-- CreateIndex
CREATE INDEX "sector_record_org_id_feature_created_by_idx" ON "sector_record"("org_id", "feature", "created_by");

-- AddForeignKey
ALTER TABLE "sector_record" ADD CONSTRAINT "sector_record_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sector_record" ADD CONSTRAINT "sector_record_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An entry with an expiry keeps one deadline of the organization in step (reminders included).
-- AlterTable
ALTER TABLE "compliance_deadline" ADD COLUMN "sector_record_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "compliance_deadline_sector_record_id_key" ON "compliance_deadline"("sector_record_id");

-- AddForeignKey
ALTER TABLE "compliance_deadline" ADD CONSTRAINT "compliance_deadline_sector_record_id_fkey" FOREIGN KEY ("sector_record_id") REFERENCES "sector_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

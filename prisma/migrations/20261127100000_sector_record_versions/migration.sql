-- History of the entries of the sector registers (Fase 1A): every entry keeps its versions, a
-- change is a correction with a reason, and an entry is voided instead of deleted.
-- Only additions. Rollback: prisma/rollback/20261127100000_sector_record_versions.down.sql

-- CreateEnum
CREATE TYPE "SectorRecordAction" AS ENUM ('CREATED', 'CORRECTED', 'VOIDED');

-- AlterTable
ALTER TABLE "sector_record" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "void_reason" TEXT,
ADD COLUMN     "voided_at" TIMESTAMP(3),
ADD COLUMN     "voided_by" UUID,
ADD CONSTRAINT "sector_record_version_positive" CHECK ("version" > 0),
ADD CONSTRAINT "sector_record_void_complete" CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL));

-- CreateTable
CREATE TABLE "sector_record_version" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "action" "SectorRecordAction" NOT NULL,
    "title" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "occurred_on" DATE,
    "due_date" DATE,
    "reason" TEXT,
    "channel" TEXT,
    "changed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sector_record_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sector_record_version_number_positive" CHECK ("version" > 0),
    CONSTRAINT "sector_record_version_reason_length" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
    CONSTRAINT "sector_record_version_change_has_reason" CHECK ("action" = 'CREATED' OR "reason" IS NOT NULL),
    CONSTRAINT "sector_record_version_channel_known" CHECK ("channel" IS NULL OR "channel" IN ('dashboard', 'miniapp'))
);

-- CreateIndex
CREATE INDEX "sector_record_version_org_id_idx" ON "sector_record_version"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "sector_record_version_record_id_version_key" ON "sector_record_version"("record_id", "version");

-- AddForeignKey
ALTER TABLE "sector_record_version" ADD CONSTRAINT "sector_record_version_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "sector_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sector_record_version" ADD CONSTRAINT "sector_record_version_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sector_record_version" ADD CONSTRAINT "sector_record_version_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A version is never changed. The only update allowed is the one the foreign key makes when the
-- author's account is deleted (changed_by set to NULL, nothing else). Deletions only follow the
-- entry or the organization (ON DELETE CASCADE); the application role cannot delete (roles.ts).
CREATE OR REPLACE FUNCTION sector_record_version_deny_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.changed_by IS NULL
     AND (to_jsonb(NEW) - 'changed_by') = (to_jsonb(OLD) - 'changed_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sector_record_version: updates are not allowed (history of the entries)';
END;
$$;

CREATE TRIGGER sector_record_version_immutable
  BEFORE UPDATE ON "sector_record_version"
  FOR EACH ROW
  EXECUTE PROCEDURE sector_record_version_deny_update();

-- The default privileges just gave the application role every right on the new table: it keeps
-- only SELECT and INSERT (as scripts/db/roles.ts does at its next run).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'sector_record_version'
              AND privilege_type IN ('UPDATE', 'DELETE')
              AND grantee NOT IN (current_user, 'PUBLIC')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON public.sector_record_version FROM %I', r.grantee);
  END LOOP;
END $$;

-- The entries already written get their first version: their content when the history starts.
INSERT INTO "sector_record_version"
  ("id", "record_id", "org_id", "version", "action", "title", "data", "occurred_on", "due_date",
   "reason", "channel", "changed_by", "created_at")
SELECT gen_random_uuid(), r."id", r."org_id", 1, 'CREATED', r."title", r."data", r."occurred_on",
       r."due_date", NULL, NULL, r."created_by", r."created_at"
  FROM "sector_record" r;

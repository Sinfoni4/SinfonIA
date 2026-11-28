-- Company profile (Fase 1C): versions of the activities of a company and their checks by a
-- delegate. Only additions; both tables are written once and never changed.
-- Rollback: prisma/rollback/20261129100000_company_profile.down.sql

-- CreateEnum
CREATE TYPE "ProfileSource" AS ENUM ('ORGANIZATION', 'DELEGATE');

-- CreateEnum
CREATE TYPE "ProfileReviewOutcome" AS ENUM ('VERIFIED', 'NEEDS_INFO');

-- CreateTable
CREATE TABLE "company_profile_version" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "activities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "data" JSONB NOT NULL DEFAULT '{}',
    "source" "ProfileSource" NOT NULL,
    "grant_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_profile_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_profile_review" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "outcome" "ProfileReviewOutcome" NOT NULL,
    "note" TEXT,
    "grant_id" UUID,
    "reviewed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_profile_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_profile_version_org_id_version_key" ON "company_profile_version"("org_id", "version");

-- CreateIndex
CREATE INDEX "company_profile_review_org_id_created_at_idx" ON "company_profile_review"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "company_profile_review_version_id_idx" ON "company_profile_review"("version_id");

-- AddForeignKey
ALTER TABLE "company_profile_version" ADD CONSTRAINT "company_profile_version_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile_version" ADD CONSTRAINT "company_profile_version_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile_review" ADD CONSTRAINT "company_profile_review_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile_review" ADD CONSTRAINT "company_profile_review_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "company_profile_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_profile_review" ADD CONSTRAINT "company_profile_review_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Checks
ALTER TABLE "company_profile_version"
  ADD CONSTRAINT "company_profile_version_number_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "company_profile_version_delegate_has_grant" CHECK ("source" = 'ORGANIZATION' OR "grant_id" IS NOT NULL);
ALTER TABLE "company_profile_review"
  ADD CONSTRAINT "company_profile_review_note_length" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500),
  ADD CONSTRAINT "company_profile_review_needs_info_has_note" CHECK ("outcome" = 'VERIFIED' OR "note" IS NOT NULL);

-- Never changed: the only update allowed is the one the foreign key makes when the author's
-- account is deleted (author set to NULL, nothing else).
CREATE OR REPLACE FUNCTION company_profile_deny_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  author text := TG_ARGV[0];
BEGIN
  IF (to_jsonb(NEW) ->> author) IS NULL
     AND (to_jsonb(NEW) - author) = (to_jsonb(OLD) - author) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%: updates are not allowed (company profile history)', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER company_profile_version_immutable
  BEFORE UPDATE ON "company_profile_version"
  FOR EACH ROW
  EXECUTE PROCEDURE company_profile_deny_update('created_by');

CREATE TRIGGER company_profile_review_immutable
  BEFORE UPDATE ON "company_profile_review"
  FOR EACH ROW
  EXECUTE PROCEDURE company_profile_deny_update('reviewed_by');

-- The default privileges just gave the application role every right on the new tables: it keeps
-- only SELECT and INSERT (as scripts/db/roles.ts does at its next run).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT grantee, table_name FROM information_schema.role_table_grants
            WHERE table_schema = 'public'
              AND table_name IN ('company_profile_version', 'company_profile_review')
              AND privilege_type IN ('UPDATE', 'DELETE')
              AND grantee NOT IN (current_user, 'PUBLIC')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON public.%I FROM %I', r.table_name, r.grantee);
  END LOOP;
END $$;

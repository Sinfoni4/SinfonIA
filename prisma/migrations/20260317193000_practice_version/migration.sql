-- Add optimistic locking version field to practice.
ALTER TABLE "practice"
ADD COLUMN "version" integer NOT NULL DEFAULT 1;

CREATE INDEX "practice_tenant_id_id_version_idx" ON "practice" ("tenant_id", "id", "version");


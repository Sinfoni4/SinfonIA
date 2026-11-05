-- B2 (H6, docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §4.5): roles defined by an organization, as a
-- subset of the permissions of a base role. Only additions: existing memberships keep their role
-- (custom_role_id NULL). Rollback: prisma/rollback/20261107090000_b2_custom_roles.down.sql

-- AlterTable
ALTER TABLE "membership" ADD COLUMN     "custom_role_id" UUID;

-- CreateTable
CREATE TABLE "org_role" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "base_role" "UserRole" NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_role_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "org_role_name_length" CHECK (char_length("name") BETWEEN 2 AND 60)
);

-- CreateIndex
CREATE UNIQUE INDEX "org_role_org_id_name_key" ON "org_role"("org_id", "name");

-- CreateIndex
CREATE INDEX "membership_custom_role_id_idx" ON "membership"("custom_role_id");

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_custom_role_id_fkey" FOREIGN KEY ("custom_role_id") REFERENCES "org_role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_role" ADD CONSTRAINT "org_role_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A membership can only get a role of its own organization, built on its own base role
-- (defence in depth: the application checks the same).
CREATE OR REPLACE FUNCTION enforce_membership_custom_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."custom_role_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "org_role" r
     WHERE r."id" = NEW."custom_role_id"
       AND r."org_id" = NEW."org_id"
       AND r."base_role" = NEW."role"
  ) THEN
    RAISE EXCEPTION 'custom role % does not belong to organization % with base role %',
      NEW."custom_role_id", NEW."org_id", NEW."role"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER membership_custom_role_match
  BEFORE INSERT OR UPDATE OF "custom_role_id", "role", "org_id" ON "membership"
  FOR EACH ROW EXECUTE FUNCTION enforce_membership_custom_role();

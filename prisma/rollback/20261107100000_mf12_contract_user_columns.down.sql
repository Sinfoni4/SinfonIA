-- Rollback of 20261107100000_mf12_contract_user_columns. The columns come back filled from the
-- new model: the first membership of each person (its organization and role) and the active
-- Telegram link. A person with no membership at all cannot get a tenant_id back: the rollback
-- stops and names them, so nothing is guessed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user" u WHERE NOT EXISTS (SELECT 1 FROM "membership" m WHERE m."user_id" = u."id")) THEN
    RAISE EXCEPTION 'people without any membership: assign one before rolling back';
  END IF;
END;
$$;

ALTER TABLE "user"
  ADD COLUMN "tenant_id" uuid,
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
  ADD COLUMN "telegram_id" text;

UPDATE "user" u
   SET "tenant_id" = first."org_id", "role" = first."role"
  FROM (SELECT DISTINCT ON ("user_id") "user_id", "org_id", "role"
          FROM "membership" ORDER BY "user_id", "created_at") first
 WHERE first."user_id" = u."id";

UPDATE "user" u
   SET "telegram_id" = c."external_id"
  FROM "channel_identity" c
 WHERE c."user_id" = u."id" AND c."channel" = 'TELEGRAM' AND c."revoked_at" IS NULL;

ALTER TABLE "user" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "user_tenant_id_idx" ON "user" ("tenant_id");
CREATE INDEX "user_tenant_id_id_idx" ON "user" ("tenant_id", "id");
CREATE UNIQUE INDEX "user_tenant_id_telegram_id_key" ON "user"("tenant_id", "telegram_id");

-- The mirror trigger of MF3, as it was.
CREATE OR REPLACE FUNCTION mf3_sync_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "membership" ("id", "user_id", "org_id", "role", "status")
  VALUES (gen_random_uuid(), NEW."id", NEW."tenant_id", NEW."role", 'ACTIVE')
  ON CONFLICT ("user_id", "org_id")
  DO UPDATE SET "role" = EXCLUDED."role", "updated_at" = now();

  IF TG_OP = 'UPDATE' AND OLD."tenant_id" <> NEW."tenant_id" THEN
    UPDATE "membership"
       SET "status" = 'REVOKED', "revoked_at" = now(), "updated_at" = now(),
           "revocation_reason" = 'legacy tenant change'
     WHERE "user_id" = NEW."id" AND "org_id" = OLD."tenant_id" AND "status" <> 'REVOKED';
  END IF;

  IF NEW."telegram_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."telegram_id" IS DISTINCT FROM OLD."telegram_id") THEN
    PERFORM mf3_link_channel(NEW."id", 'TELEGRAM', NEW."telegram_id");
  ELSIF NEW."telegram_id" IS NULL AND TG_OP = 'UPDATE' AND OLD."telegram_id" IS NOT NULL THEN
    UPDATE "channel_identity" SET "revoked_at" = now()
     WHERE "revoked_at" IS NULL AND "channel" = 'TELEGRAM' AND "user_id" = NEW."id";
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER mf3_sync_user
  AFTER INSERT OR UPDATE OF "tenant_id", "role", "telegram_id" ON "user"
  FOR EACH ROW EXECUTE FUNCTION mf3_sync_user();


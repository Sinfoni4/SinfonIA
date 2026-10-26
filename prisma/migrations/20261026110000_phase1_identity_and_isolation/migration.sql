-- Phase 1: DB-backed tenant configuration and Telegram identity mapping.

ALTER TABLE "tenant"
  ADD COLUMN "module" TEXT NOT NULL DEFAULT 'music',
  ADD COLUMN "integration_type" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "scheduler_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "scheduler_frequency" TEXT,
  ADD COLUMN "scheduler_tasks" JSONB;

ALTER TABLE "user"
  ADD COLUMN "telegram_id" TEXT;

CREATE UNIQUE INDEX "user_tenant_id_telegram_id_key"
  ON "user"("tenant_id", "telegram_id");

-- Defense in depth: a user referenced by a practice or audit row must belong
-- to the same tenant, even if an application check is accidentally bypassed.
CREATE OR REPLACE FUNCTION enforce_user_tenant_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "user"
  WHERE id = NEW.user_id
    AND tenant_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user % does not belong to tenant %', NEW.user_id, NEW.tenant_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS practice_user_tenant_match ON "practice";
CREATE TRIGGER practice_user_tenant_match
  BEFORE INSERT OR UPDATE OF tenant_id, user_id ON "practice"
  FOR EACH ROW EXECUTE FUNCTION enforce_user_tenant_match();

DROP TRIGGER IF EXISTS audit_log_user_tenant_match ON "audit_log";
CREATE TRIGGER audit_log_user_tenant_match
  BEFORE INSERT OR UPDATE OF tenant_id, user_id ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION enforce_user_tenant_match();

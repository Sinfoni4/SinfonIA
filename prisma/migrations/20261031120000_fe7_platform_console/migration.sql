-- FE7 (docs/PROGETTO_FRONTEND_V2.md §5-§6, B18, B19; decisions G2, G6):
-- the platform audit log, the cooperative type, and the confirmation code of critical actions.
-- Additive only: no existing row or column changes.

-- G6: a cooperative behaves like a company until it gets functions of its own.
ALTER TYPE "OrganizationType" ADD VALUE IF NOT EXISTS 'COOPERATIVE';

-- G2: a fresh code confirms critical actions of the platform console.
ALTER TYPE "AuthChallengePurpose" ADD VALUE IF NOT EXISTS 'STEP_UP';

-- B18: every action of a platform administrator. No foreign keys: the log outlives the people and
-- organizations it names, and is never updated or deleted.
CREATE TABLE "platform_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "org_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_audit_log_created_at_idx" ON "platform_audit_log"("created_at");
CREATE INDEX "platform_audit_log_org_id_created_at_idx" ON "platform_audit_log"("org_id", "created_at");

CREATE OR REPLACE FUNCTION platform_audit_log_deny_update_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log: % is not allowed (immutable log)', TG_OP;
END;
$$;

CREATE TRIGGER platform_audit_log_immutable
  BEFORE UPDATE OR DELETE ON "platform_audit_log"
  FOR EACH ROW
  EXECUTE PROCEDURE platform_audit_log_deny_update_delete();

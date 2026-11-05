-- MF8 (docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §2.4): a person who works on the data of an
-- organization through a delegation is recorded in the log of that organization as the author,
-- without being a member of it. Only the audit log accepts them: practices, deadlines and the
-- other tables keep the membership check of enforce_user_tenant_match().
-- Rollback: prisma/rollback/20261105160000_mf8_audit_delegate_actor.down.sql
CREATE OR REPLACE FUNCTION enforce_audit_actor_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A member, whatever the status of the membership.
  PERFORM 1
  FROM "membership"
  WHERE user_id = NEW.user_id
    AND org_id = NEW.tenant_id;
  IF FOUND THEN
    RETURN NEW;
  END IF;

  -- Or a person linked to a delegation given by this organization: the delegate person, or a
  -- named beneficiary of a delegation to another organization.
  PERFORM 1
  FROM "access_grant" g
  WHERE g.grantor_org_id = NEW.tenant_id
    AND (
      g.grantee_user_id = NEW.user_id
      OR EXISTS (
        SELECT 1 FROM "access_grant_beneficiary" b
        WHERE b.grant_id = g.id AND b.user_id = NEW.user_id
      )
    );
  IF FOUND THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'user % does not belong to tenant %', NEW.user_id, NEW.tenant_id
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_user_tenant_match ON "audit_log";
CREATE TRIGGER audit_log_user_tenant_match
  BEFORE INSERT OR UPDATE OF tenant_id, user_id ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION enforce_audit_actor_match();

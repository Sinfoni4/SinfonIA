-- MF4 (switch step, M2): a user belongs to a tenant when they have a membership there, not when
-- user.tenant_id says so (a person can now belong to several organizations).
-- The trigger checks that a membership exists, whatever its status: rows written for a member
-- who is later revoked stay valid. The application itself requires an ACTIVE membership.
-- Rollback: prisma/rollback/20261030110000_mf4_membership_checks.down.sql
CREATE OR REPLACE FUNCTION enforce_user_tenant_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "membership"
  WHERE user_id = NEW.user_id
    AND org_id = NEW.tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user % does not belong to tenant %', NEW.user_id, NEW.tenant_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

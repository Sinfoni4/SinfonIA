-- Rollback of MF4 (switch step, M2): the membership check goes back to user.tenant_id.
-- Run as the schema owner before reverting the MF4 code:
--   psql -v ON_ERROR_STOP=1 --single-transaction -f prisma/rollback/20261030110000_mf4_membership_checks.down.sql
-- Only possible while every row still matches user.tenant_id: people added to a second
-- organization after MF4 must be removed from it first (scripts/db/mf3-verify.ts reports them).
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

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030110000_mf4_membership_checks';

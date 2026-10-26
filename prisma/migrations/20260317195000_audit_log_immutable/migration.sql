-- Audit log is append-only: block UPDATE and DELETE at DB level.
CREATE OR REPLACE FUNCTION audit_log_deny_update_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log: updates are not allowed (immutable log)';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_log: deletes are not allowed (immutable log)';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER audit_log_immutable_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE PROCEDURE audit_log_deny_update_delete();

CREATE TRIGGER audit_log_immutable_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE PROCEDURE audit_log_deny_update_delete();

-- Rollback of 20261105160000_mf8_audit_delegate_actor: the audit log goes back to the membership
-- check shared with the other tables. Rows already written by delegates stay as they are.
DROP TRIGGER IF EXISTS audit_log_user_tenant_match ON "audit_log";
CREATE TRIGGER audit_log_user_tenant_match
  BEFORE INSERT OR UPDATE OF tenant_id, user_id ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION enforce_user_tenant_match();
DROP FUNCTION IF EXISTS enforce_audit_actor_match();

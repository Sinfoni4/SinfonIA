-- AGX-03: the holder of a practice, the person it was opened for (a farmer whose practice is
-- opened by the organization's staff). Null = the creator is the holder, as before. When that
-- person is deleted the practice goes back to its creator. Additive only.
ALTER TABLE "practice" ADD COLUMN "holder_user_id" UUID;

CREATE INDEX "practice_tenant_id_holder_user_id_idx" ON "practice"("tenant_id", "holder_user_id");

ALTER TABLE "practice" ADD CONSTRAINT "practice_holder_user_id_fkey"
  FOREIGN KEY ("holder_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

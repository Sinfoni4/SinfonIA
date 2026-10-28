-- Step 6: compliance deadlines (DURC, safety training, organic certification, medical checks,
-- licences) and their reminders.
CREATE TYPE "ComplianceCategory" AS ENUM (
  'DURC', 'SICUREZZA_LAVORO', 'CERTIFICAZIONE_BIO', 'VISITA_MEDICA', 'PATENTINO', 'ALTRO'
);
CREATE TYPE "ComplianceDeadlineStatus" AS ENUM ('OPEN', 'CLOSED');

CREATE TABLE "compliance_deadline" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  -- Member the deadline refers to (e.g. whose medical check expires); NULL = the cooperative.
  "user_id" uuid,
  "created_by" uuid,
  "category" "ComplianceCategory" NOT NULL,
  "title" text NOT NULL,
  "due_date" date NOT NULL,
  "notes" text,
  "status" "ComplianceDeadlineStatus" NOT NULL DEFAULT 'OPEN',
  "closed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "compliance_deadline_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "compliance_deadline_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "compliance_deadline_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "compliance_deadline_tenant_id_status_due_date_idx" ON "compliance_deadline"("tenant_id", "status", "due_date");
CREATE INDEX "compliance_deadline_status_due_date_idx" ON "compliance_deadline"("status", "due_date");

-- The referenced member must belong to the same tenant (same rule as practice and audit_log).
CREATE TRIGGER compliance_deadline_user_tenant_match
  BEFORE INSERT OR UPDATE ON "compliance_deadline"
  FOR EACH ROW EXECUTE FUNCTION enforce_user_tenant_match();

-- One row per deadline and threshold (days before due date): the unique key makes reminders
-- exactly-once even with repeated ticks and several workers.
CREATE TABLE "compliance_reminder" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "deadline_id" uuid NOT NULL,
  "threshold_days" integer NOT NULL,
  "outbox_message_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "compliance_reminder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "compliance_reminder_deadline_id_threshold_days_key" UNIQUE ("deadline_id", "threshold_days"),
  CONSTRAINT "compliance_reminder_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "compliance_reminder_deadline_id_fkey" FOREIGN KEY ("deadline_id") REFERENCES "compliance_deadline"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "compliance_reminder_tenant_id_idx" ON "compliance_reminder"("tenant_id");

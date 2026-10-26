-- Phase 2C: Durable Scheduler and Outbox Tables
CREATE TYPE "SchedulerRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- 1. Scheduler Job Table
CREATE TABLE "scheduler_job" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "task_type" text NOT NULL,
  "frequency" text NOT NULL DEFAULT 'monthly',
  "enabled" boolean NOT NULL DEFAULT true,
  "payload" jsonb,
  "last_run_at" timestamptz,
  "next_run_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "scheduler_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scheduler_job_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "scheduler_job_tenant_id_idx" ON "scheduler_job"("tenant_id");
CREATE INDEX "scheduler_job_enabled_next_run_at_idx" ON "scheduler_job"("enabled", "next_run_at");

-- 2. Scheduler Run Table (with Unique Idempotency Key)
CREATE TABLE "scheduler_run" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "job_id" uuid,
  "tenant_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" "SchedulerRunStatus" NOT NULL DEFAULT 'RUNNING',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "error" text,
  "result" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "scheduler_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "scheduler_run_idempotency_key_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "scheduler_run_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "scheduler_job"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "scheduler_run_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "scheduler_run_tenant_id_idx" ON "scheduler_run"("tenant_id");
CREATE INDEX "scheduler_run_job_id_idx" ON "scheduler_run"("job_id");
CREATE INDEX "scheduler_run_status_idx" ON "scheduler_run"("status");

-- 3. Outbox Table for Asynchronous Event/Export Dispatch
CREATE TABLE "outbox_message" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "error" text,
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbox_message_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "outbox_message_tenant_id_idx" ON "outbox_message"("tenant_id");
CREATE INDEX "outbox_message_status_created_at_idx" ON "outbox_message"("status", "created_at");

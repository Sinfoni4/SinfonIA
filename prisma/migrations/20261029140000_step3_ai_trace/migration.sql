-- Step 3: persistent AI traces (who, when, which model, outcome, latency, tokens). No prompt or
-- completion text is stored. Rows older than AI_TRACE_RETENTION_DAYS are deleted by a worker.
CREATE TABLE "ai_trace" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid,
  "request_id" text NOT NULL,
  "model" text NOT NULL,
  "provider" text NOT NULL,
  "outcome" text NOT NULL,
  "action" text,
  "latency_ms" integer NOT NULL,
  "prompt_tokens" integer,
  "completion_tokens" integer,
  "total_tokens" integer,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_trace_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_trace_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ai_trace_tenant_id_created_at_idx" ON "ai_trace"("tenant_id", "created_at");
CREATE INDEX "ai_trace_tenant_id_outcome_created_at_idx" ON "ai_trace"("tenant_id", "outcome", "created_at");
CREATE INDEX "ai_trace_created_at_idx" ON "ai_trace"("created_at");

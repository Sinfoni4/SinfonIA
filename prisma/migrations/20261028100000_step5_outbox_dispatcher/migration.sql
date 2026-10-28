-- Step 5: outbox dispatcher (retry with backoff, lease-based claiming, dead letter)
-- and per-tenant webhook endpoint.
ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "OutboxStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTER';

-- Existing PENDING/FAILED messages get next_attempt_at = now() and are delivered on the first dispatch.
ALTER TABLE "outbox_message"
  ADD COLUMN "attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN "locked_until" timestamptz,
  ADD COLUMN "delivered_targets" text[] NOT NULL DEFAULT '{}';

CREATE INDEX "outbox_message_status_next_attempt_at_idx"
  ON "outbox_message"("status", "next_attempt_at");

ALTER TABLE "tenant" ADD COLUMN "webhook_url" text;

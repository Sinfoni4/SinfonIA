-- Fencing token for outbox claims: it changes on every claim, so updates from a worker whose
-- claim was taken over are ignored even after attempts is reset by a dead-letter requeue.
ALTER TABLE "outbox_message" ADD COLUMN "claim_token" uuid;

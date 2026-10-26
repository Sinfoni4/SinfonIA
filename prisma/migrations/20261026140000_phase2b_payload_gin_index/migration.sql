-- Phase 2B: GIN index on practice payload for fast structured queries and search
CREATE INDEX IF NOT EXISTS "practice_payload_idx" ON "practice" USING gin ("payload");

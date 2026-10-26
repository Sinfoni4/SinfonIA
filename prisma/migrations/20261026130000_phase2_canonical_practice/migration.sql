-- Phase 2A: one canonical practice model.
--
-- Practices created before the canonical payload contract are wrapped without
-- losing their original JSON. New writes always use a typed payload.
UPDATE "practice"
SET "payload" = jsonb_build_object(
  'type', 'legacy_practice',
  'name', COALESCE(
    NULLIF("payload"->>'name', ''),
    NULLIF("payload"->>'artistName', ''),
    'Pratica ' || left("id"::text, 8)
  ),
  'legacy', "payload"
)
WHERE "payload" IS NULL OR "payload"->>'type' IS NULL;

-- Legacy `music_practice` rows have no tenant/user and cannot be mapped to the
-- canonical tenant-scoped model. Preserve them in an archive table if present,
-- then remove the obsolete table.
DO $$
BEGIN
  IF to_regclass('public.music_practice') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.music_practice) THEN
      IF to_regclass('public.music_practice_legacy') IS NULL THEN
        EXECUTE 'CREATE TABLE public.music_practice_legacy AS TABLE public.music_practice';
      ELSE
        INSERT INTO public.music_practice_legacy SELECT * FROM public.music_practice;
      END IF;
      RAISE NOTICE 'music_practice legacy rows archived in music_practice_legacy';
    END IF;

    DROP TABLE public.music_practice;
  END IF;
END $$;

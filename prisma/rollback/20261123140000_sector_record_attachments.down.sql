-- Rollback of 20261123140000_sector_record_attachments: removes the list of the files attached to
-- the entries of the sector registers. The files stay in the storage (orphans): take an encrypted
-- backup first.
DROP TABLE IF EXISTS "sector_record_attachment";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123140000_sector_record_attachments';

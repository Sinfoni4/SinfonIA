import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma v7 config: keep connection URLs OUT of schema.prisma.
// This prevents accidental commits of environment-specific values and enables clean CI.

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Prisma CLI requires a URL even for `generate`.
    // We keep a safe local default so CI can build without provisioning a DB.
    // Migrations run as the schema owner (MF1): MIGRATION_DATABASE_URL when the application
    // connects with its least-privilege role, DATABASE_URL otherwise.
    url:
      process.env.MIGRATION_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://sinfonia_user:sinfonia_pass@localhost:5432/sinfonia_db?schema=public',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});

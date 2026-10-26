import { Client } from 'pg';

import { describeError } from './exec.js';

export async function pgDriverCheck(): Promise<boolean> {
  console.log('🧪 PG DRIVER CONNECT');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('🔴 PG QUERY FAIL');
    console.error('DATABASE_URL missing');
    return false;
  }

  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    const res = await client.query('SELECT NOW();');
    if (res?.rows?.[0]) {
      console.log('🟢 PG QUERY OK');
      return true;
    }
    console.log('🔴 PG QUERY FAIL');
    return false;
  } catch (err: unknown) {
    console.log('🔴 PG QUERY FAIL');
    const details = describeError(err);
    console.error('PG ERROR:', { code: details.code, message: details.message });
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

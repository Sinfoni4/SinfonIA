export function validateDatabaseConfig() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.error('❌ DATABASE_URL missing');
    return {
      valid: false,
      reason: 'DATABASE_URL_UNDEFINED',
    };
  }

  console.log('✅ DATABASE_URL detected');
  return { valid: true, reason: null as string | null };
}

import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

// Tests must not depend on shell state. Load the dedicated test env first,
// then fall back to the regular local env if no test file exists.
dotenv.config({ path: '.env.test' });
dotenv.config();

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

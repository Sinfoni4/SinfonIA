/** `npm run test:db:clean` empties only a test database on this PC, never staging. */
import { describe, expect, it } from 'vitest';

import { checkTestDatabase } from '../scripts/test-db-clean.js';

describe('cleaning of the test database', () => {
  it('accepts only a local database whose name ends in _test', () => {
    expect(checkTestDatabase('postgresql://u:p@localhost:5433/sinfonia_test')).toEqual({
      name: 'sinfonia_test',
    });
    expect(() => checkTestDatabase('postgresql://u:p@localhost:5433/sinfonia_staging')).toThrow(
      /_test/,
    );
    expect(() => checkTestDatabase('postgresql://u:p@db.example.com:5432/sinfonia_test')).toThrow(
      /this PC/,
    );
    expect(() => checkTestDatabase(undefined)).toThrow(/DATABASE_URL/);
  });
});

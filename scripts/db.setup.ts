import 'dotenv/config';

import { autoProvisionDatabase } from '../src/devtools/db/db.autoProvision.js';

void autoProvisionDatabase().catch((error: unknown) => {
  console.error('Database setup failed:', error);
  process.exitCode = 1;
});

import 'dotenv/config';

import { z } from 'zod';

import { loadConfig } from '../src/config/config.js';
import { AuthService } from '../src/interface/http/auth/auth.service.js';
import { AuthRoleSchema } from '../src/interface/http/auth/auth.types.js';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

const UuidSchema = z.string().uuid();

const tenantId = UuidSchema.safeParse(readArg('tenant'));
const userId = UuidSchema.safeParse(readArg('user'));
const role = AuthRoleSchema.safeParse(readArg('role') ?? 'MEMBER');
const ttlRaw = readArg('ttl');
const ttl = ttlRaw ? Number(ttlRaw) : undefined;

if (
  !tenantId.success ||
  !userId.success ||
  !role.success ||
  (ttl !== undefined && !Number.isFinite(ttl))
) {
  console.error(
    'Usage: npm run auth:token -- --tenant <uuid> --user <uuid> [--role ADMIN|OPERATOR|MEMBER] [--ttl 3600]',
  );
  process.exit(1);
}

const config = loadConfig();
const auth = new AuthService({
  secret: config.AUTH_SECRET,
  issuer: config.AUTH_ISSUER,
  audience: config.AUTH_AUDIENCE,
  defaultTtlSeconds: config.AUTH_TTL_SECONDS,
});

console.log(
  auth.issue({
    tenantId: tenantId.data,
    userId: userId.data,
    role: role.data,
    ttlSeconds: ttl,
  }),
);

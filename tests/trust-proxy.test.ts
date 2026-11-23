/**
 * Behind nginx the connection always comes from 127.0.0.1: without trusted proxies every visitor
 * shares one address, and one rate limit. X-Forwarded-For is believed only from a configured proxy,
 * so a visitor cannot pick their own address.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { loadConfig, trustedProxies } from '../src/config/config.js';

import { TEST_AUTH_ENV } from './helpers/auth.js';

const BASE = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', ...TEST_AUTH_ENV };

async function clientIp(trustProxy: string | undefined, remoteAddress: string, xff?: string) {
  const app = Fastify({
    trustProxy: trustedProxies(loadConfig({ ...BASE, TRUST_PROXY: trustProxy })),
  });
  app.get('/ip', (req) => ({ ip: req.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress,
    headers: xff ? { 'x-forwarded-for': xff } : {},
  });
  await app.close();
  return res.json<{ ip: string }>().ip;
}

describe('TRUST_PROXY', () => {
  it('is off by default: the address of the connection counts', async () => {
    expect(trustedProxies(loadConfig(BASE))).toBe(false);
    expect(await clientIp(undefined, '127.0.0.1', '203.0.113.5')).toBe('127.0.0.1');
  });

  it('takes the client address that nginx adds, not one the client wrote', async () => {
    // nginx appends the real address to whatever the client sent.
    expect(await clientIp('127.0.0.1', '127.0.0.1', '6.6.6.6, 203.0.113.5')).toBe('203.0.113.5');
    expect(await clientIp('loopback', '127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For from a connection that is not a trusted proxy', async () => {
    expect(await clientIp('127.0.0.1', '198.51.100.9', '203.0.113.5')).toBe('198.51.100.9');
  });

  it('accepts addresses, ranges and names, and refuses anything else', () => {
    expect(
      trustedProxies(loadConfig({ ...BASE, TRUST_PROXY: '127.0.0.1, 10.0.0.0/8, ::1' })),
    ).toEqual(['127.0.0.1', '10.0.0.0/8', '::1']);
    for (const wrong of ['true', '*', '300.1.1.1', '10.0.0.0/40', 'nginx'])
      expect(() => loadConfig({ ...BASE, TRUST_PROXY: wrong })).toThrow(/TRUST_PROXY/);
  });
});

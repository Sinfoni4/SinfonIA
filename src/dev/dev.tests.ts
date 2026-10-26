/**
 * Non-invasive runtime test guide for development.
 * Call printRuntimeTestGuide() once at startup (after health checks succeed).
 * Has no effect on production logic.
 */
export function printRuntimeTestGuide() {
  console.log(`
================ SINfONIA RUNTIME TEST GUIDE ================

TEST A — Startup DB protection
1. Stop database
2. Run npm run dev
Expected:
- health check fails
- process exits immediately

TEST B — Runtime DB failure
1. Start DB
2. Start app
3. Send Telegram message (works)
4. Stop DB
5. Send message again
Expected:
User receives fallback message.

TEST C — Dev reset
Send:
/devreset
Then:
/start
Expected:
Onboarding shown again.

==============================================================
`);
}

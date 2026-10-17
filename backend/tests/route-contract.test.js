'use strict';

// Guards the frontend<->backend path agreement for the developer dashboard.
// Two production bugs shipped because nothing checked this:
//   1) /auth/signup rejected accountType 'regular' while the form posts it.
//   2) server.js mounted the apiAccount router at /api/account while every
//      frontend call (and the router's own comments) said /api/account/api/*,
//      so overview/keys/plans/... all 404'd for logged-in developers.
// This test statically checks the mount and every call site.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ── helpers ─────────────────────────────────────────────────────────

// '/keys/${b.dataset.revoke}' -> '/keys/' ; '/overview' -> '/overview'
function staticPrefix(callPath) {
  return callPath.replace(/\$\{[^}]*\}/g, '').replace(/\/+$/, '');
}

// Does a frontend call path match a router path like '/keys/:keyId'?
function routeMatches(callPath, routePath) {
  const a = staticPrefix(callPath).split('/').filter(Boolean);
  const b = routePath.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => b[i].startsWith(':') || seg === b[i]);
}

// ── fixtures from the real source files ─────────────────────────────

const serverSrc = read('server.js');
const apiDashSrc = read('routes/apiAccount.js');
const authSrc = read('routes/auth.js');
const frontendSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'api-dashboard.js'),
  'utf8'
);

// The mount server.js uses for the apiAccount router.
const mountMatch = serverSrc.match(/app\.use\('([^']+)',\s*apiAccountRoutes\)/);
assert.ok(mountMatch, 'server.js must mount apiAccountRoutes');

// API_BASE on the frontend; its pathname prefixes every api() call.
const apiBaseMatch = frontendSrc.match(/const API_BASE = '([^']+)'/);
assert.ok(apiBaseMatch, 'api-dashboard.js must define API_BASE');
const apiBasePath = new URL(apiBaseMatch[1]).pathname.replace(/\/+$/, '');

// Every api('...') call in the developer dashboard.
const calls = [...frontendSrc.matchAll(/\bapi\((?:'|`)(\/account\/api\/[^'"`$]*)/g)]
  .map((m) => m[1]);
assert.ok(calls.length >= 10, `expected >=10 dashboard api() calls, found ${calls.length}`);

// Every route the apiAccount router defines.
const routes = [...apiDashSrc.matchAll(/router\.(?:get|post|put|delete)\('([^']+)'/g)]
  .map((m) => m[1]);
assert.ok(routes.length >= 10, `expected >=10 router paths, found ${routes.length}`);

// ── tests ───────────────────────────────────────────────────────────

test('contract: apiAccount router is mounted at the path the frontend calls', () => {
  // Frontend: API_BASE + '/account/api/...' == mount + router path.
  assert.equal(
    mountMatch[1],
    `${apiBasePath}/account/api`,
    'mount path must equal API_BASE pathname + /account/api'
  );
});

test('contract: every dashboard api() call resolves to a defined route', () => {
  const missing = calls.filter((c) => {
    // Call path relative to the mount: strip '/account/api' from the call.
    const rel = c.replace(/^\/account\/api/, '');
    return !routes.some((r) => routeMatches(rel, r));
  });
  assert.deepEqual(missing, [], `unrouted dashboard calls: ${missing.join(', ')}`);
});

test('contract: developer signup accepts the accountType the form posts', () => {
  // The signup gate must allow 'regular' — the developer flow's account type.
  assert.ok(
    /\[\s*'regular'\s*,\s*'job_owner'\s*\]\.includes\(accountType\)/.test(authSrc),
    'auth signup must accept accountType regular (developers) and job_owner'
  );
  // And the developer form really does post 'regular'.
  assert.ok(
    /fd\.append\('accountType',\s*'regular'\)/.test(frontendSrc),
    "developer signup form must post accountType 'regular'"
  );
});

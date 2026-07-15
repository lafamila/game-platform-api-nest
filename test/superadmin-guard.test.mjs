import assert from 'node:assert/strict';
import test from 'node:test';

import { SuperadminGuard } from '../dist/auth/superadmin.guard.js';

function context(authAccount) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ authAccount }) }),
  };
}
function account(permission) {
  return { accountId: 'a', subject: 'a', serviceKey: 'game-platform', permission, claims: {} };
}

test('superadmin passes the guard', () => {
  assert.equal(new SuperadminGuard().canActivate(context(account('superadmin'))), true);
  assert.equal(new SuperadminGuard().canActivate(context(account('SUPERADMIN'))), true); // case-insensitive
});

test('a non-superadmin (player/premium/visitor) is rejected with 403 code FORBIDDEN', () => {
  for (const permission of ['player', 'premium', 'visitor']) {
    try {
      new SuperadminGuard().canActivate(context(account(permission)));
      assert.fail('expected a ForbiddenException for ' + permission);
    } catch (error) {
      assert.equal(error.getStatus(), 403);
      assert.equal(error.getResponse().code, 'FORBIDDEN');
    }
  }
});

test('a request with no authenticated account is rejected as 401 AUTH_REQUIRED', () => {
  try {
    new SuperadminGuard().canActivate(context(undefined));
    assert.fail('expected an UnauthorizedException');
  } catch (error) {
    assert.equal(error.getStatus(), 401);
    assert.equal(error.getResponse().code, 'AUTH_REQUIRED');
  }
});

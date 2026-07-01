const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');

async function loadArgon2() {
  try {
    return require('argon2');
  } catch {
    return require('../../auth-api-nest/node_modules/argon2');
  }
}

async function main() {
  const argon2 = await loadArgon2();
  const pool = new Pool({
    connectionString: process.env.AUTH_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/teddy_auth',
  });
  const oidcSecret = process.env.GAME_PLATFORM_OIDC_CLIENT_SECRET || 'game-platform-local-oidc-secret';
  const serviceSecret = process.env.AUTH_SERVICE_SECRET || 'game-platform-local-service-secret';
  const serviceKeyId = process.env.AUTH_SERVICE_KEY_ID || 'game-platform-local-service-key';
  const redirectUris = resolveRedirectUris();

  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    const service = await upsertService(pool);
    await upsertPermissions(pool, service.id);
    await upsertOidcClient(pool, argon2, service.id, oidcSecret, redirectUris);
    await upsertServiceCredential(pool, argon2, service.id, serviceKeyId, serviceSecret);
    await upsertLocalPlayer(pool, argon2, service.id, {
      loginId: 'game-local-player',
      name: 'Game Local Player',
      email: 'game-local-player@lafamila.local',
      password: 'GameLocal!234',
    });
    await upsertLocalPlayer(pool, argon2, service.id, {
      loginId: 'game-local-opponent',
      name: 'Game Local Opponent',
      email: 'game-local-opponent@lafamila.local',
      password: 'GameOpponent!234',
    });
    await grantLafamila(pool, service.id);
    console.log(
      JSON.stringify(
        {
          serviceKey: 'game-platform',
          oidcClientId: 'game-platform-api',
          oidcClientSecret: oidcSecret,
          redirectUris,
          authServiceKeyId: serviceKeyId,
          authServiceSecret: serviceSecret,
          testLoginId: 'game-local-player',
          testPassword: 'GameLocal!234',
          opponentLoginId: 'game-local-opponent',
          opponentPassword: 'GameOpponent!234',
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

async function upsertLocalPlayer(pool, argon2, serviceId, input) {
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  const accountResult = await pool.query(
    `INSERT INTO accounts
     (id, login_id, name, email, password_hash, status, is_super_admin, password_reset_required, email_verified_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5,
       'active', false, false, now(), now(), now())
     ON CONFLICT (login_id)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active',
       password_reset_required = false, email_verified_at = now(), updated_at = now()
     RETURNING id`,
    [randomUUID(), input.loginId, input.name, input.email, passwordHash],
  );
  const permission = await pool.query(
    "SELECT id FROM service_permission_definitions WHERE service_id = $1 AND key = 'player'",
    [serviceId],
  );
  await pool.query(
    `INSERT INTO account_service_permissions
     (id, account_id, service_id, permission_definition_id, status, granted_by_account_id, granted_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $2, now(), now(), now())
     ON CONFLICT (account_id, service_id)
     DO UPDATE SET permission_definition_id = EXCLUDED.permission_definition_id, status = 'active',
       granted_by_account_id = EXCLUDED.granted_by_account_id, granted_at = now(), revoked_at = null, updated_at = now()`,
    [randomUUID(), accountResult.rows[0].id, serviceId, permission.rows[0].id],
  );
}

async function upsertService(pool) {
  const existing = await pool.query('SELECT * FROM services WHERE service_key = $1', ['game-platform']);
  if (existing.rows[0]) {
    const result = await pool.query(
      `UPDATE services
       SET name = 'Game Platform', description = 'Auth-backed casual game platform', status = 'active', updated_at = now()
       WHERE service_key = 'game-platform'
       RETURNING *`,
    );
    return result.rows[0];
  }
  const result = await pool.query(
    `INSERT INTO services (id, service_key, name, description, status, permission_schema_version, created_at, updated_at)
     VALUES ($1, 'game-platform', 'Game Platform', 'Auth-backed casual game platform', 'active', 1, now(), now())
     RETURNING *`,
    [randomUUID()],
  );
  return result.rows[0];
}

async function upsertPermissions(pool, serviceId) {
  const permissions = [
    ['superadmin', 'Super Admin', 'Auth superadmin account with full service access', -2000],
    ['visitor', '방문자', 'Default no-access visitor state', -1000],
    ['player', 'Player', 'Can play enabled game-platform games', 0],
    ['premium', 'Premium', 'Can use premium game-platform features', 5],
  ];
  for (const [key, label, description, sortOrder] of permissions) {
    await pool.query(
      `INSERT INTO service_permission_definitions
       (id, service_id, key, label, description, status, sort_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, now(), now())
       ON CONFLICT (service_id, key)
       DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, status = 'active', sort_order = EXCLUDED.sort_order, updated_at = now()`,
      [randomUUID(), serviceId, key, label, description, sortOrder],
    );
  }
}

function resolveRedirectUris() {
  const configured =
    process.env.GAME_PLATFORM_OIDC_REDIRECT_URIS ||
    process.env.GAME_PLATFORM_OIDC_REDIRECT_URI ||
    'http://localhost:3035/api/session/oidc/callback';
  return [...new Set(configured.split(',').map((value) => value.trim()).filter(Boolean))];
}

async function upsertOidcClient(pool, argon2, serviceId, secret, redirectUris) {
  const hash = await argon2.hash(secret, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO oidc_clients
     (id, service_id, client_id, client_secret_hash, client_type, redirect_uris, post_logout_redirect_uris,
      allowed_grant_types, allowed_scopes, require_pkce, status, created_at, updated_at)
     VALUES ($1, $2, 'game-platform-api', $3, 'confidential', $4::text[], '{}'::text[],
       ARRAY['authorization_code','refresh_token']::text[], ARRAY['openid','profile','email','service.permission']::text[],
       true, 'active', now(), now())
     ON CONFLICT (client_id)
     DO UPDATE SET service_id = EXCLUDED.service_id, client_secret_hash = EXCLUDED.client_secret_hash,
       client_type = EXCLUDED.client_type, redirect_uris = EXCLUDED.redirect_uris,
       allowed_grant_types = EXCLUDED.allowed_grant_types, allowed_scopes = EXCLUDED.allowed_scopes,
       require_pkce = true, status = 'active', updated_at = now()`,
    [randomUUID(), serviceId, hash, redirectUris],
  );
}

async function upsertServiceCredential(pool, argon2, serviceId, keyId, secret) {
  const hash = await argon2.hash(secret, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO service_credentials
     (id, service_id, key_id, secret_hash, name, description, scopes, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Local game-platform API', 'Local account search credential',
       ARRAY['account.search']::text[], 'active', now(), now())
     ON CONFLICT (key_id)
     DO UPDATE SET service_id = EXCLUDED.service_id, secret_hash = EXCLUDED.secret_hash,
       scopes = EXCLUDED.scopes, status = 'active', updated_at = now(), disabled_at = null`,
    [randomUUID(), serviceId, keyId, hash],
  );
}

async function grantLafamila(pool, serviceId) {
  const account = await pool.query("SELECT id FROM accounts WHERE login_id = 'lafamila' AND status = 'active'");
  if (!account.rows[0]) {
    return;
  }
  const permission = await pool.query(
    "SELECT id FROM service_permission_definitions WHERE service_id = $1 AND key = 'superadmin'",
    [serviceId],
  );
  if (!permission.rows[0]) {
    return;
  }
  await pool.query(
    `INSERT INTO account_service_permissions
     (id, account_id, service_id, permission_definition_id, status, granted_by_account_id, granted_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $2, now(), now(), now())
     ON CONFLICT (account_id, service_id)
     DO UPDATE SET permission_definition_id = EXCLUDED.permission_definition_id, status = 'active',
       granted_by_account_id = EXCLUDED.granted_by_account_id, granted_at = now(), revoked_at = null, updated_at = now()`,
    [randomUUID(), account.rows[0].id, serviceId, permission.rows[0].id],
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

# game-platform-api-nest

NestJS API for an auth-backed multi-game platform.

Current playable scope:

- 1-player Sudoku with server-side unique-solution generator by difficulty.
- 2-player Gomoku with server-authoritative turn and win validation.
- 2-player Alkkagi with a simple server-side 2D shot simulation.
- Auth-backed account search, friend requests, match requests, custom emotes, and SSE realtime events.

## Run

Start `auth-api-nest` on `http://localhost:3032`, then seed the local game-platform auth records:

```bash
npm install
npm run seed
```

Start the API with PostgreSQL and auth enabled on the current LAN IP:

```bash
npm run start:current-network
```

The API listens on `http://localhost:3035/api` by default and stores sessions/games/social data in PostgreSQL.
For a physical iPhone, use the LAN URL printed by `scripts/current-network.sh url`.

## Auth

This service is designed to be registered in `auth-api-nest` as:

- `serviceKey`: `game-platform`
- `audience`: `service:game-platform`
- service-local permissions: `player`, `premium`
- auth-managed permissions: `visitor`, `superadmin`
- OIDC client: `game-platform-api`, confidential, PKCE required

`visitor` sessions can play local games only. Matching and custom emote sending require `player` or above; `premium` uses a 16x16 custom-emote grid instead of 8x8.

Flutter/native clients must not store auth client secrets. The API owns OIDC exchange and issues a service-local session for clients.

Flutter/native clients call:

1. `POST /api/session/oidc/start`
2. open the returned `authorizeUrl`
3. after auth callback, call `POST /api/session/oidc/complete`
4. send `X-Game-Platform-Session` on protected API and realtime requests

### Permission webhook

Auth onboarding should include the game API callback (replace the host for production):

```json
{
  "permissionWebhook": {
    "url": "http://localhost:3035/api/auth/webhooks",
    "signingSecretSource": "generated",
    "eventTypes": ["permission.updated", "service_application.rejected"]
  }
}
```

Set the one-time generated secret as `AUTH_WEBHOOK_SECRET`. The receiver verifies
`x-auth-webhook-id`, Unix-seconds `x-auth-webhook-timestamp`, and
`x-auth-webhook-signature: v1=<HMAC-SHA256(timestamp + "." + rawBody)>`. Processing is
durably deduplicated. `permission.updated` forces every active account session to rotate
after any in-flight refresh and emits a token-free `permission.updated` realtime event.
Auth-confirmed revocation emits `session.revoked` and disconnects the affected socket/SSE
subscriptions.

### Shared chat bridge

Set `CHAT_API_URL` to enable `POST /api/chat/session`. The route accepts only an opaque
game-platform session, exchanges the server-held auth access token with chat, and returns
chat's public `{ token, sessionId, expiresAt, serviceKey, account }` shape. Auth access and
refresh tokens are never returned. Logout and auth-confirmed session rejection attempt
`DELETE /api/session/current` with the linked opaque chat token. If chat is unavailable,
cleanup is best-effort and remote presence can remain only until that short chat session
expires. Existing game friends, invitations, and game data remain unchanged.

## Smoke

```bash
curl -sS http://localhost:3035/api/health
npm run smoke:local-flow
```

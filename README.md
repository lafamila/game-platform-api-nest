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

1. Generate a 32-byte random base64url `loginProof` in memory; send it with
   `returnUri` to `POST /api/session/oidc/start`.
2. open the returned `authorizeUrl`
3. After a matching auth callback (success or failure), call
   `POST /api/session/oidc/complete` with `loginTransactionId` and the same
   `loginProof`. Never trust callback error text to log out a session directly.
4. send `X-Game-Platform-Session` on protected API and realtime requests

Auth must register the intended service category. Signed `service_category=game`
and current `authentication_method=kakao` are denied; linked Kakao accounts using
local/Google login remain allowed, as do explicit non-game categories. Unknown or
legacy provenance refreshes once where possible, otherwise requires a new login.
HTTP 401 `SESSION_AUTH_METHOD_DENIED` preserves Auth's `bodyCode` and exact
`message`. Protected-request denials discard the affected opaque session/bearer.
A failed new login does not replace the current session: `/oidc/complete` also
returns `sessionInvalidated`. If false, display the attempt error and drop only
the pending login proof/transaction, preserving an existing permitted session.
Only the previous session's own policy rejection can make that flag true.
Browser login uses an HttpOnly initiating-state cookie instead of native proof.
The server adds two nullable `login_transactions` binding columns at startup;
no new env values or dependency installation is needed. Deploy the API/native
proof contract together; old pending native logins must restart. Realtime checks
reuse the 25-second presence tick, but later Auth policy changes are not learned
before token refresh. See `CLAUDE.md` for timing and offline-message limits.

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

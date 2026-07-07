# game-platform-api-nest

NestJS API server for Teddy's auth-backed casual game platform.

> 이 파일이 본 레포의 canonical 가이드입니다. `AGENTS.md` 는 Codex CLI 호환용 stub 입니다.

## Workspace Principles

This repo follows `../CLAUDE.md`, especially central auth, env handling, local-first implementation testing, root-compose-is-infra-only, no agent co-author trailers, and cross-repo impact reporting.

## Project Decisions

- Product/service: `game-platform`
- Lifecycle: `DEPLOY`
- Stack: NestJS API
- Dev port: `3035`
- API prefix: `/api`
- Auth: `auth-api-nest` OIDC integration
- Auth service key: `game-platform`
- JWT audience: `service:game-platform`
- Service-local permissions: `player`, `premium`
- Auth-managed baseline permissions: `visitor`, `superadmin`
- Access rule: `visitor` can log in and play local games only. Friend matching and custom emotes require `player` or above; `premium` enables 16x16 custom emote editing. Auth `superadmin` is highest privilege.
- Client model: `game-platform-api-nest` owns the confidential OIDC client. Flutter/native clients must store only a game-platform session token, not OIDC client secrets, refresh tokens, or auth service credentials.
- Storage: PostgreSQL via `DATABASE_URL`.
- Game model: server-authoritative rules and result validation.
- Game registry: public game metadata is centralized in `GameRegistry`/`GAME_DESCRIPTORS`; new server-backed games should register a `GameEngine` and then wire only the remaining service orchestration gaps.
- Current games: `sudoku`, `gomoku`, `alkkagi`, `othello`, `sokoban`, `splendor`, `fortress`, `crazy_arcade`, `mighty`, `seotda`, `chaser`.
- Start UX contract: every newly started game session, including Crazy Arcade and room-started sessions, must support the client countdown flow. Resuming an already-active session is not a new start.

## Auth Onboarding Request Shape

- `serviceKey`: `game-platform`
- OIDC client: `game-platform-api`
- Client type: `confidential`
- PKCE: required
- Redirect URI:
  - local: `http://localhost:3035/api/session/oidc/callback`
  - production: decide before deploy
- Scopes: `openid profile email service.permission`
- Optional backend credential scopes: `account.search` for friend search.

## Session Policy (Phase 1 — session stabilization)

The Flutter/native client holds only the opaque `x-game-platform-session` id. This BFF owns the OIDC access/refresh tokens in `app_sessions` and refreshes them for the client. Phase 1 hardens that so a transient auth outage never logs a player out mid-game.

- **Lifetime — sliding idle + absolute cap.** On each authenticated request `requireSession` extends `expires_at = LEAST(created_at + ABSOLUTE, now + IDLE)`, throttled to at most once per 5 minutes to avoid write amplification. Env: `GAME_PLATFORM_SESSION_IDLE_SECONDS` (default 30d) and `GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS` (default 180d). The legacy `GAME_PLATFORM_SESSION_MAX_AGE_SECONDS` still drives the browser cookie max-age and is the absolute-cap fallback when the ABSOLUTE key is unset.
- **Preemptive refresh.** The access token is refreshed when it is within 5 minutes of expiry (was 30s), so a refresh that fails transiently can soft-fail on the still-valid token for the remaining window.
- **Refresh failure 3-classification** (only the first case logs a player out):
  - `AuthRejectedError` — auth returned 400/401/403 → refresh token is permanently invalid → session row is DELETEd → `401 SESSION_EXPIRED`.
  - `AuthUnavailableError` — 5xx, network failure, or JWKS not loaded → transient → retry once after 0.5s; if it still fails, soft-fail on the still-valid access token, or if that has already expired return `503 AUTH_UPSTREAM_UNAVAILABLE` **without deleting the session**.
- **Keepalive job.** A background job (`GAME_PLATFORM_SESSION_KEEPALIVE_INTERVAL_SECONDS`, default 3600s; 0 disables) rotates the refresh token of sessions still inside the idle window when it is within 24h of `GAME_PLATFORM_REFRESH_TOKEN_TTL_SECONDS` (default 7d, mirrors auth's current hardcoded TTL). This keeps the chain alive for apps left closed for days, and is the interim mechanism until auth ships a per-client 30d refresh TTL (see cross-repo dependency below). Tracked via the `app_sessions.refresh_token_issued_at` column.

### Auth-failure `code` contract (client-facing)

Every 401/503 from the session guard/service carries a stable `code` alongside the existing (unchanged) `message`. Clients branch on `code`: only `SESSION_*` should trigger a logout/relogin flow; `AUTH_UPSTREAM_UNAVAILABLE` and network/timeout errors should show a retry affordance and keep the session.

| HTTP | `code` | When |
|------|--------|------|
| 401 | `AUTH_REQUIRED` | No session id / bearer presented; login transaction not usable |
| 401 | `SESSION_INVALID` | Malformed Authorization header, invalid bearer/token response, non-refreshable session |
| 401 | `SESSION_EXPIRED` | Session row expired, or auth permanently rejected the refresh (400/401/403) |
| 503 | `AUTH_UPSTREAM_UNAVAILABLE` | Auth temporarily unreachable and local access token already expired |

Response body shape (additive — `code` added, other fields preserved): `{ "statusCode": 401, "code": "SESSION_EXPIRED", "message": "…", "error": "Unauthorized" }`.

Note: `auth.service.ts` (bearer verification for non-session consumers) and `social.service.ts` defensive post-guard checks still throw code-less 401s; the Flutter client uses the session-id path, which is fully covered.

### Disconnect-cause instrumentation

Session deletion / refresh-failure reasons are logged server-side as `session <event> reason=<code> session=<id>` (reasons: `session_expired`, `session_missing`, `refresh_rejected`, `auth_unavailable`, `auth_unavailable_softfail`, `auth_unavailable_expired`, `refresh_error`). Client-observed SSE reconnect / refresh failures are posted to `POST /api/client-errors` and stored in `client_error_reports`. Cause-attribution query over the client side:

```sql
SELECT status_code,
       context_json->>'reason' AS reason,
       count(*)
FROM client_error_reports
WHERE created_at > now() - interval '7 days'
GROUP BY status_code, reason
ORDER BY count DESC;
```

### Cross-repo dependency

Sliding idle of 30d only truly holds once `auth-api-nest` applies a per-client refresh TTL (≥ idle window) for the `game-platform-api` OIDC client. Until then the keepalive job maintains the 7d chain. When auth ships per-client TTL, submit a service-onboarding **update request** (workspace principle 3) to raise `game-platform-api`'s refresh TTL to 30d.

## Realtime & Reconnection (Phase 2)

Phase 2 hardens live play against reconnects. New env: `GAME_PLATFORM_DISCONNECT_GRACE_SECONDS` (default 60) and `GAME_PLATFORM_SESSION_ABANDON_DAYS` (default 7).

### Event channels

- **socket.io** at path `/api/socket.io` is the push channel. The handshake is authenticated with the game-platform session id via the `x-game-platform-session` header or handshake `auth.sessionId` (same session the guard validates); the socket joins a per-account room. `emitToAccounts` publishes to the SSE `Subject` and socket.io simultaneously.
- **SSE** `GET /api/realtime/events` is kept during the transition and will be removed only after the Flutter client has moved to socket.io (separate instruction).

### `rev` and optimistic locking

Every game session's `state_json` carries a monotonically increasing `rev`. Writes are conditional (`WHERE (state_json->>'rev')::int = expected`); a lost race throws `409 { code: 'STATE_CONFLICT' }`. Every session/action event payload includes the session (which carries `rev`; shot events carry it under `session.rev`). Client sequence: track the last `rev` per session; on a socket reconnect, or when an incoming `rev` is not `lastRev + 1` (gap), re-fetch `GET /{game}/sessions/:id` to resync. No event replay is needed for consistency.

### Disconnect grace and the D7 choice

When a player disconnects on their turn in a turn-based match, the server starts a grace window (`GAME_PLATFORM_DISCONNECT_GRACE_SECONDS`) and emits `game.opponent_left` to the remaining player. Instead of auto-forfeiting, the remaining player chooses:

- `POST /api/games/:gameKey/sessions/:id/claim-win` — if the opponent is still offline, awards the win; if the opponent has reconnected, the match resumes, `game.opponent_returned` is emitted, and the call returns `409 { code: 'OPPONENT_RECONNECTED' }`.
- `POST /api/games/:gameKey/sessions/:id/wait` — keeps the session open to wait; a win can still be claimed later.

Abandoned sessions (no update for `GAME_PLATFORM_SESSION_ABANDON_DAYS`) are finished by a periodic GC job with `finishReason: 'abandoned'`.

### Resume entry point

`GET /api/sessions/active` returns the caller's unfinished (`status = playing`) sessions with `{ sessionId, gameKey, mode, status, rev, opponentAccountIds, currentTurnAccountId, myTurn, createdAt, updatedAt }` — the entry point for reconnect/resume after app restart.

### Idempotent submission (`clientMoveId`)

Every action POST accepts an optional `clientMoveId` (uuid). The server keeps the last 20 accepted ids per account in `state_json` and, on a repeat, re-responds with the current session in that route's normal shape instead of re-applying — so a timeout retry cannot double-move. The check runs after the participant/status/pause guards and before turn/input validation, so a retry stays idempotent even after the turn has advanced (it returns current state rather than a "not your turn"/"cell occupied" error). Wired routes include the generic `POST /api/games/:gameKey/sessions/:id/actions` path and the legacy game-specific wrappers. Shot routes return an empty animation on a duplicate (`alkkagi: { frameMs: 16, frames: [] }`; `fortress`: no-op animation with the current terrain/tanks). Sudoku cell writes are naturally idempotent; Crazy Arcade input is idempotent when sent through the common action route with `clientMoveId`.

## Platform Game APIs (Phase 3–6)

- `GET /api/games` exposes registry metadata including room bounds, save support, timers, and hidden-information flags.
- `POST /api/games/:gameKey/sessions` and `GET /api/games/:gameKey/sessions/:id` are the preferred common create/get routes. Legacy game-specific create/get routes remain for compatibility.
- `POST /api/games/:gameKey/sessions/:id/actions` is the preferred common action route. Game-specific action routes should delegate to the same engine/service path.
- `POST /api/games/:gameKey/sessions/:id/pause|resume|save|emotes|claim-win|wait` are common session adjunct routes where the game supports the concept.
- Room APIs create N-player sessions from room membership. Sudoku/Sokoban race rooms support up to 6 seats; Splendor supports 2–4; Crazy Arcade supports 2–4; Mighty is exactly 5 seats.
- Server save/continue stores an account-owned long-term snapshot. Continuing a finished friend match forks according to game type: solo-capable puzzle games resume solo, while competitive games use `local_ai` continuation. Crazy Arcade server save is included and forks the server-authoritative snapshot to `local_ai`.
- Mighty (`mighty`) is a hidden-information 5-player trick game. Its engine must hide non-viewer hands/kitty/deck data, expose only viewer-legal actions, and support local AI seats plus 5-player room start.
- Seotda (`seotda`) is a hidden-information 2-5 player hwatu betting game. One session runs continuous hands with a shared, evenly-distributed balance (default 10,000, configurable via create `config.startingBalance`). The session ends the moment a player leaves (`opponent_left`) or a settlement leaves someone at 0 balance (`bankrupt`); the richest player then wins (ties break to the last hand's winner) and `gameWinner` records `reason` + `finalBalances`. Actions on the common route: `bet` (`payload.move` = `die|check|call|bbing|ddadang|half|allin`), `next_hand`, `forfeit`. Betting rounds cap raises at the minimum active balance (no side pots). `viewFor` exposes only the viewer's hand and reveals survivor hands (`revealedHands`) at settlement; deck/seed stay hidden. Local AI create accepts `config.aiOpponents` (1-4, default 1), `config.ante`, `config.baseUnit`, `config.startingBalance`. Room start supports 2-5 seats with mixed AI seats. Adopted standard rules with variants (멍구사 등 미구현) documented in the seotda engine header.
- Chaser (`chaser`) is a 2-5 player, full-information 5-dice Yahtzee-family score game (룬의 아이들 '추격자'). No betting — pure score. Each player takes 12 turns; on their turn they roll 5 dice, keep any subset, and reroll up to 2 more times (max 3 rolls/turn, server seeded RNG; `rngSeed` stays hidden from `viewFor`), then record one of the 12 unused categories (a non-qualifying category scores 0). When every active seat has filled all 12 categories the highest total wins. Categories: `aces/twoBeans/threeBeans/fourBeans/fiveBeans/sixBeans` (sum of that face, no upper bonus), `choice` (two distinct pairs → sum of all 5), `fourDice` (4+ of a kind, incl. 5-of-a-kind → sum of all 5), `fullHouse` (distinct 3+2 → sum of all 5; 5-of-a-kind does not qualify), `evenStraight` ({2,3,4,5,6} → 30), `straight` ({1,2,3,4,5} → 40), `chaseOff` (5-of-a-kind → 50). Ties break by highest score in `chaseOff→straight→evenStraight→fourDice→fullHouse`, then lowest seat; `gameWinner.tie=true` marks a shared top total. Leaving zeroes the leaver's remaining categories and continues; when one active seat remains it wins immediately (`opponent_left`). friend_match human turns have a 60s turn timer covering rerolls+scoring; on timeout the server auto-processes (forces one roll if none yet, then records the best-scoring open category). Actions on the common route: `roll` (`payload.keep?: boolean[5]`; first roll ignores keep; needs `canRoll` = `rollsUsed<3`), `score` (`payload.category`; needs `canScore` = `rollsUsed>=1`), `forfeit`. `viewFor` is full-information (`phase: 'rolling'|'finished'`, `canRoll`, `canScore`, `dice` (null before the turn's first roll), `kept`, `scorecards`, `totals`, `scorePreview`, `lastTurnResult`) and only hides `rngSeed`. Local AI create accepts `config.aiOpponents` (1-4, default 1); room start supports 2-5 mixed seats. Events: `chaser.action.played`, `game.session.finished`, plus the common session events. Not implemented (documented options): gambling/stake variant, upper-section bonus.

## Local Dev

```bash
npm install
npm run seed:local-auth
npm run build
npm run test
npm run smoke:local-flow
```

Normal local development uses `auth-api-nest` on `http://localhost:3032`, PostgreSQL `game_platform`, and the service credential/client seeded by `npm run seed:local-auth`. There is no local auth bypass route in this repo.

## API Surface

- `GET /api/health`
- `GET /api/games`
- `GET /api/sessions/active`
- `POST /api/games/:gameKey/sessions`
- `GET /api/games/:gameKey/sessions/:id`
- `POST /api/games/:gameKey/sessions/:id/actions`
- `POST /api/games/:gameKey/sessions/:id/pause`
- `POST /api/games/:gameKey/sessions/:id/resume`
- `POST /api/games/:gameKey/sessions/:id/save`
- `POST /api/games/:gameKey/sessions/:id/emotes`
- `POST /api/games/:gameKey/sessions/:id/claim-win`
- `POST /api/games/:gameKey/sessions/:id/wait`
- `GET /api/saves`
- `POST /api/saves/:id/continue`
- `GET /api/rooms`
- `POST /api/rooms`
- `GET /api/rooms/:id`
- `POST /api/rooms/:id/invite`
- `POST /api/rooms/:id/ready`
- `POST /api/rooms/:id/start`
- `POST /api/sudoku/sessions`
- `GET /api/sudoku/sessions/:id`
- `PATCH /api/sudoku/sessions/:id/cells`
- `POST /api/sudoku/sessions/:id/submit`
- `POST /api/gomoku/sessions`
- `GET /api/gomoku/sessions/:id`
- `POST /api/gomoku/sessions/:id/moves`
- `POST /api/gomoku/sessions/:id/emotes`
- `POST /api/alkkagi/sessions`
- `GET /api/alkkagi/sessions/:id`
- `POST /api/alkkagi/sessions/:id/shots`
- `POST /api/alkkagi/sessions/:id/emotes`
- `GET /api/emotes`
- `PUT /api/emotes/:slot`
- `GET /api/session/oidc/readiness`
- `POST /api/session/oidc/start`
- `GET /api/session/oidc/callback`
- `POST /api/session/oidc/complete`
- `GET /api/session/me`
- `POST /api/session/refresh`
- `POST /api/session/logout`
- `POST /api/client-errors`
- `GET /api/accounts/search`
- `GET /api/friends/requests`
- `POST /api/friends/requests`
- `POST /api/friends/requests/:id/accept`
- `GET /api/matches`
- `POST /api/matches`
- `POST /api/matches/:id/accept`
- `POST /api/matches/:id/reject`
- `POST /api/permission-upgrade-requests`
- `GET /api/realtime/events` (SSE, kept during the socket.io transition)
- socket.io `/api/socket.io` (event push channel; auth via `x-game-platform-session` header or handshake `auth.sessionId`)

## Review Criteria

- `npm run build` passes.
- `npm run test` passes.
- `npm audit --audit-level=moderate` reports zero vulnerabilities.
- `npm run smoke:local-flow` passes with local `auth-api-nest` and PostgreSQL.

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
- Current games: `sudoku`, `gomoku`, `alkkagi`, `othello`, `sokoban`, `splendor`, `fortress`, `crazy_arcade`, `mighty`, `seotda`, `chaser`, `gostop`, `four_ball`, `fighting`.
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
- Room APIs create N-player sessions from room membership. Sudoku/Sokoban race rooms support up to 6 seats; Splendor supports 2–4; Crazy Arcade supports 2–4; Mighty is exactly 5 seats; Gostop supports 2–3 seats; Four Ball is exactly 2 seats.
- Server save/continue stores an account-owned long-term snapshot. Continuing a finished friend match forks according to game type: solo-capable puzzle games resume solo, while competitive games use `local_ai` continuation. Crazy Arcade server save is included and forks the server-authoritative snapshot to `local_ai`.
- Mighty (`mighty`) is a hidden-information 5-player trick game. Its engine must hide non-viewer hands/kitty/deck data, expose only viewer-legal actions, and support local AI seats plus 5-player room start.
- Seotda (`seotda`) is a hidden-information 2-5 player hwatu betting game. One session runs continuous hands with a shared, evenly-distributed balance (default 10,000, configurable via create `config.startingBalance`). The session ends the moment a player leaves (`opponent_left`) or a settlement leaves someone at 0 balance (`bankrupt`); the richest player then wins (ties break to the last hand's winner) and `gameWinner` records `reason` + `finalBalances`. Actions on the common route: `bet` (`payload.move` = `die|check|call|bbing|ddadang|half|allin`), `next_hand`, `forfeit`. Betting rounds cap raises at the minimum active balance (no side pots). `viewFor` exposes only the viewer's hand and reveals survivor hands (`revealedHands`) at settlement; deck/seed stay hidden. Local AI create accepts `config.aiOpponents` (1-4, default 1), `config.ante`, `config.baseUnit`, `config.startingBalance`. Room start supports 2-5 seats with mixed AI seats. Adopted standard rules with variants (멍구사 등 미구현) documented in the seotda engine header.
- Chaser (`chaser`) is a 2-5 player, full-information 5-dice Yahtzee-family score game (룬의 아이들 '추격자'). No betting — pure score. Each player takes 12 turns; on their turn they roll 5 dice, keep any subset, and reroll up to 2 more times (max 3 rolls/turn, server seeded RNG; `rngSeed` stays hidden from `viewFor`), then record one of the 12 unused categories (a non-qualifying category scores 0). When every active seat has filled all 12 categories the highest total wins. Categories: `aces/twoBeans/threeBeans/fourBeans/fiveBeans/sixBeans` (sum of that face, no upper bonus), `choice` (two distinct pairs → sum of all 5), `fourDice` (4+ of a kind, incl. 5-of-a-kind → sum of all 5), `fullHouse` (distinct 3+2 → sum of all 5; 5-of-a-kind does not qualify), `evenStraight` ({2,3,4,5,6} → 30), `straight` ({1,2,3,4,5} → 40), `chaseOff` (5-of-a-kind → 50). Ties break by highest score in `chaseOff→straight→evenStraight→fourDice→fullHouse`, then lowest seat; `gameWinner.tie=true` marks a shared top total. Leaving zeroes the leaver's remaining categories and continues; when one active seat remains it wins immediately (`opponent_left`). friend_match human turns have a 60s turn timer covering rerolls+scoring; on timeout the server auto-processes (forces one roll if none yet, then records the best-scoring open category). Actions on the common route: `roll` (`payload.keep?: boolean[5]`; first roll ignores keep; needs `canRoll` = `rollsUsed<3`), `score` (`payload.category`; needs `canScore` = `rollsUsed>=1`), `forfeit`. `viewFor` is full-information (`phase: 'rolling'|'finished'`, `canRoll`, `canScore`, `dice` (null before the turn's first roll), `kept`, `scorecards`, `totals`, `scorePreview`, `lastTurnResult`) and only hides `rngSeed`. Local AI create accepts `config.aiOpponents` (1-4, default 1); room start supports 2-5 mixed seats. Events: `chaser.action.played`, `game.session.finished`, plus the common session events. Not implemented (documented options): gambling/stake variant, upper-section bonus.
- Gostop (`gostop`) is a hidden-information 2인(맞고)/3인 화투 score+stakes game. Like seotda, one session runs continuous rounds over a shared, evenly-distributed balance (default 10,000, `config.startingBalance`); each round the loser(s) pay the winner `score × multipliers × config.pointValue` (default `pointValue` 100). Continuous rounds: the next dealer (선) is the previous round's winner. The session ends when a settlement leaves someone at ≤0 balance (`bankrupt`) or a player leaves (`opponent_left`); the richest player then wins (ties break to the last round's winner) and `gameWinner` records `reason` + `finalBalances`.
  - **Deck**: 48 cards, id `hwatu_{month}_{1..4}` from an explicit mapping table (no derived rules). `kind`: `gwang|yeol|tti|pi|ssangpi`. 1–10월 follow seotda (1=광 for 1·3·8월 else 열끗; 2=띠 except 8월=열끗) plus new 3·4=피; 11월(오동) 1=광 2=쌍피 3·4=피; 12월(비) 1=비광 2=열끗 3=비띠 4=쌍피. 단 groups: 홍단(1·2·3)/청단(6·9·10)/초단(4·5·7); 비띠 has no group. 고도리 = 2·4·8월 열끗.
  - **Deal (seeded, hidden)**: 맞고 hand 10/floor 8, 3인 hand 7/floor 6, rest = deck. A floor with 4-of-a-month triggers a redeal. A hand with 4-of-a-month (총통) wins the round immediately for 10 points (no multiplier). `rngSeed` is never exposed by `viewFor`.
  - **Turn**: play one hand card → match same-month floor stack → flip one deck card → match → capture. Specials: `ppeok`(뻑), `first_ppeok`(첫뻑 = steal 1 pi on the round's first turn), `jjok`(쪽), `ttadak`(따닥), `sseulssak`(싹쓸이, skipped on the last turn), `shake`(흔들기: declare 3 same-month in hand → 2× for the round), `bomb`(폭탄: 3 hand + 1 floor of a month → capture 4, 2×, steal 1 pi), `ppeok_eaten`(eating a ppeok pile steals 1 pi). Steal order in 3인 is next-seat-first, single pi before ssangpi.
  - **Scoring** (real-time over captures): 광 3광 3점(비광 포함 3광 2점)/4광 4점/5광 15점; 열끗 5장=1점 +1/장, 고도리 +5; 단 each complete group +3, 띠 5장=1점 +1/장; 피 쌍피=2환산, 10장=1점 +1/장.
  - **Go/Stop**: at ≥ threshold (맞고 7점, 3인 3점) the scorer enters `go_stop`. `go`: +goCount, keep playing; `stop`: settle. Go bonus: 1고 +1, 2고 +2, ≥3고 = base × 2^(go−2). 박(per loser): 피박(winner has pi points & loser converted-pi 1–5 → ×2), 광박(winner has gwang points & loser 0 gwang → ×2), 고박(a losing go-declarer pays the whole amount; other losers exempt in 3인). Multipliers combine multiplicatively (shake × bomb × go × bak). `나가리`(draw): cards exhausted with no stop → no payment, dealer preserved.
  - **Actions** on the common route (all `clientMoveId`-idempotent): `play_card` (`payload.cardId`, optional `matchChoice: cardId` when the played card matches two floor cards, `shake: bool`, `bomb: bool`), `flip_choice` (`payload.cardId`, when a `pendingChoice` awaits a floor pick — type `match_pick` or `flip_pick`), `go {}`, `stop {}`, `next_round {}`, `forfeit {}`.
  - **viewFor** (hides other hands + deck): `phase: 'playing'|'flip_choice'|'go_stop'|'settled'|'finished'`, `roundNumber`, `dealer`, `currentSeat`/`currentTurn`/`mySeat`, `myHand:[cardId]`, `handCounts{seatN}`, `floorStacks: [[cardId,...]]` (same-month groups incl. ppeok piles), `deckCount`, `captures:{seatN:{gwang,yeol,tti,pi}}` (ssangpi bucketed under pi; all public), `scores{seatN}`, `goCount{seatN}`, `multipliers{seatN:{shake,bomb}}`, `balances{seatN}`, `pendingChoice`, `lastPlay:{seat,played,flipped,captured,events}`, `goStopSeat`, `lastRoundResult:{winnerSeat,basePoints,goCount,multiplierDetail:{go,shake,bomb,pibak,gwangbak,gobak},amountPerLoser,nagari?,chongtong?,balancesAfter}`, `gameWinner`, `turnDeadlineAt`, `rev`. `rngSeed` is never exposed.
  - **AI** (easy/medium/hard): rule-based — evaluates immediate capture value per hand card (광/열끗/단 weighted), medium/hard take bombs when available and hard occasionally shakes; go/stop is a risk heuristic (easy always stops; hard weighs score gap + remaining cards). Legality is always guaranteed. Local AI create accepts `config.aiOpponents` (1–2, default 1), `config.startingBalance`, `config.pointValue`; room start supports 2–3 mixed AI seats. friend_match human turns have a 40s timer; on timeout the server auto-plays the first hand card (no shake/bomb), auto-resolves any pending choice with the first option, and auto-`stop`s a `go_stop`.
  - **Events**: `gostop.action.played` (metadata; clients re-fetch the per-seat view), `game.session.finished`, plus the common session events.
  - **Not implemented (documented options)**: regional variants (지방룰), 국진(9월 열끗) ssangpi toggle, 멍박/멍텅구리, 광팔기(3인), 나가리 배수 2배 이월, 흔들기/폭탄 turn-count compensation. The `applyGoBonus` reading (≥3고 multiplies base without the +1/+2 additive) is an adopted interpretation.
- Four Ball (`four_ball`) is a 2-player, full-information carom (사구) game on a server-authoritative deterministic physics engine. Single game (no continuous rounds, no stakes). Modes: `local_ai` (1 AI) and `friend_match` (2-seat match/room). Turn timer 60s.
  - **Physics** (`src/games/billiards-physics.ts`, reusable by future 삼구): fixed 8ms timestep 2D sim on a `1000×500` table, ball radius `15`, 4-wall cushions. Constants are exported: `MAX_SPEED=1400 u/s` (`speed = power × MAX_SPEED`), `CUSHION_RESTITUTION=0.85` (normal), `CUSHION_TANGENT_KEEP=0.85` + `CUSHION_SIDE_TRANSFER=0.55` (tangential + english transfer, `CUSHION_SIDE_CONSUME=0.5`), two-phase deceleration `SLIDING_DECEL=900`→`ROLLING_DECEL=180` after `SLIDE_TIME=0.15s`, `FOLLOW_TRANSFER=520` (follow/draw applied on the cue's first ball contact along its travel dir), `SPIN_DECAY_PER_SEC=1.1`, `MAX_SIM_TIME=12s`. `shoot(angle, power 0..1, tipX -1..1, tipY -1..1)`: `tipY>0`=follow, `tipY<0`=draw, `tipX`=side (english) that alters cushion reflection and is consumed. Miscue: `d=hypot(tipX,tipY)` clamped 0..1; probability 0 for `d≤0.3`, linear to `0.25` at `d=1` (seeded RNG, reproducible); on miscue `power×0.25`, angle jitter `±12°`. Output = frame array (`frameMs:16`, all 4 ball coords) + time-ordered contact events `[{t,type:'cushion'|'ball',ball,other?,cushion?}]`.
  - **Rules** (`src/games/carom-rules.ts`, reusable by 삼구): reduce the cue's contact events to `{ballsHit, redsHit, cushionsBeforeSecondObject, hitOpponentCue, threeCushion}`. Four-ball success = both reds hit & opponent cue not touched; foul = opponent cue touched; three-cushion = ≥3 cushions before the 2nd red.
  - **Flow**: `phase 'selecting'` — each seat picks a target score from `[3,5,8,10,15,20]` (client ×10). Once both selected → `playing`, first seat seeded-random. Success = remaining −1 **+ continued turn**; miss (0–1 reds) = pass; foul (opponent cue) = remaining +1 + pass. On reaching remaining 0 the next shot must be a **three-cushion finish** (`needsThreeCushionFinish`) to win — a failed finish costs nothing but passes the turn. Turn cap 200 shots (fewer-remaining wins, tie→first seat) prevents infinite AI games. Forfeit/leave = other seat wins (`opponent_left`).
  - **Actions** (common route + `four-ball/*` wrappers): `select_target {target}`, `shoot {angle(rad),power,tipX,tipY}` (+`clientMoveId`; idempotent, duplicate → empty animation), `aim {angle,power?,tipX?,tipY?}` (relay only, not persisted), `forfeit {}`.
  - **viewFor** (all public, `rngSeed` never exposed): `phase`, absolute ball keys `balls:{cue0,cue1,red1,red2}` + `cueBallOf:{seat0:'cue0',seat1:'cue1'}`, `table:{width:1000,height:500,ballRadius:15}`, `targetOptions`, `targets/remaining/needsThreeCushionFinish` (per `seatN`), `currentSeat`/`currentTurn`(=`cue{seat}`)/`mySeat`/`firstSeat`, `lastShot:{seat,params,miscue,outcome:{scored,foul,threeCushion,cushions,ballsHit,continueTurn},events,animation:{frameMs:16,frames:[{cue0,cue1,red1,red2}]}}`, `lastAim`, `turnDeadlineAt`, `gameWinner:{seat,accountId,reason:'completed'|'opponent_left',finalRemaining}`, `rev`.
  - **AI** (easy/medium/hard): candidate shots (angle×power×tip aimed at each red) simulated server-side and scored by carom success, second-red proximity and foul avoidance (three-cushion when finishing); hard uses more candidates + english/follow tips and picks greedily, easy/medium add noise. Always legal; time-budgeted (`FOUR_BALL_AI_BUDGET_MS`).
  - **Events**: `four_ball.action.played` (shoot payload `{session, shot}`), `four_ball.aim.updated`, `game.session.finished`, plus common session events. Shoot response = `{session, animation}` (alkkagi pattern).
  - **삼구 reuse**: the physics engine and `carom-rules` (`threeCushion`, `cushionsBeforeSecondObject`) are game-agnostic; a future 삼구 engine reuses both, changing only the success condition (both reds + `threeCushion`) and scoring. Initial layout, target options and physics tuning constants are exported for that reuse.
  - **Not implemented (documented options)**: 삼구/four-ball variants beyond standard (e.g. 큐 miscue depth model, cushion 세리 nuances, pocket/scratch rules — carom has none), balance/stake integration, spectator-hidden data (game is full-information by design).
- Fighting (`fighting`) is a 1:1 real-time fighter (KOF/철권류), **local_ai only**. Execution model differs from every other game: the 60fps frame-precise simulation (framedata hurt/hitboxes, hitstop, knockback, best-of-3 rounds, 60s round timer) runs **client-side** — the server's coarse persistence tick cannot host fighting-grade judgement — and the server owns the session plus **authoritative round-result validation** (the same "local judgement + server result validation" shape adopted for the planned rhythm game).
  - **Server validates**: sequential round numbers (1,2,3…) and rejection after match end; `reason`/hp consistency (`ko` → loser hp exactly 0 and winner hp > 0; `timeout` → winner hp ≥ loser hp and duration ≥ round timer); hp within `0..100`; `durationMs` within `1s .. 60s+30s slack`; best-of-3 finish with `gameWinner {winner: 'player'|'ai', reason: 'completed'|'forfeit', wins}`.
  - **Actions** on the common route (clientMoveId-idempotent): `round_result {round, winner: 'player'|'ai', reason: 'ko'|'timeout', playerHp, aiHp, durationMs}`, `forfeit {}` (forfeit → AI wins the match).
  - **Session shape**: single human seat (`players.seat0` only — the AI opponent is client-local, no AI seat row); `characters {player: martial_hero, ai: martial_hero_2}`; `rounds[]`, `wins {player, ai}`. `viewFor` hides only the idempotency store. Rooms, friend_match, and server saves are unsupported (`supportsMatchSave: false`); **online versus over the socket.io input channel is an explicit follow-up**, not implemented.
  - **Limits (documented)**: the server cannot verify actual gameplay of a client-simulated fighter — validation is plausibility-level (bounds/sequence/consistency), which is acceptable for a local-vs-AI mode with no stakes or rankings. Revisit before any ranked/online mode.
  - **Events**: `fighting.round.recorded`, `game.session.finished`, plus common session events.

## Hard AI — Othello & Gomoku (engine/AI split + worker)

The `hard` difficulty for `othello` and `gomoku` uses dedicated search engines, separate from the game engines so the engine files stay lean and the search can run inside a worker thread. `easy`/`medium` are unchanged — they keep using the old greedy/`gomokuMinimax`/`chooseOthelloAiMove` paths at their original (short) budgets.

- **Search engines** (pure modules, no NestJS deps so a worker can load them cheaply): `src/games/othello-ai.ts` (`searchOthelloMove`) uses reusable per-ply typed move/flip buffers, incremental disc/empty counts, dual-`Uint32` Zobrist TTs, mobility ordering, and a 3-phase evaluation. Endgames keep heuristic and exact TTs separate: a short iterative-deepening phase first secures a legal fallback, then a reserved exact phase uses odd-region parity plus fastest-first ordering through 18 empties (≤14 is the conservative exact tier). `src/games/gomoku-ai.ts` (`searchGomokuMove`) uses an `Int8Array` position with affected-line incremental evaluation, fixed generation-aged dual-`Uint32` typed-array TTs, PVS with aspiration re-search, killer/history ordering, and adaptive candidates (all immediate wins, blocks, fours, open threes, and crossing threats survive while quiet width contracts from 28 at root to 10 deep). VCF remains the fast direct-four path; a separate proof/disproof threat-space search with its own TT covers longer VCT lines and root refutations. Pattern semantics distinguish open/closed/broken threats, deduplicate winning points, and never score a white overline as exact five. Both return the best move from the last **completed** depth, and all speculative moves restore board/hash state through `finally` even when a deadline interrupts recursion.
- **Time management**: `GOMOKU_AI_BUDGET_MS` and `OTHELLO_AI_BUDGET_MS` are late-game maxima. Gomoku uses phase caps (0–4 stones: 3s, 5–8: 8s, later: configured maximum); Othello caps positions with ≥50 empties at 3s. Both measure recent completed-depth growth and do not begin a depth predicted to exceed the remaining deadline. Othello also observes the worker request's absolute deadline and leaves a small response margin. Optional node caps are deterministic regression/benchmark controls only; production remains time-budgeted.
- **Shared util**: `src/games/engine/zobrist.ts` provides deterministic dual 32-bit keys; the primary half indexes each TT and the verifier half rejects collisions. `src/games/engine/fixed-transposition-table.ts` provides fixed-capacity generation/depth replacement without hot-path entry objects. Protocol and diagnostics types are in `src/games/engine/ai-worker-protocol.ts`. `npm run benchmark:othello-hard -- 10000` and `npm run benchmark:gomoku-hard -- 50000` report depth, nodes, NPS, elapsed time, and exit reason without gating CI. Gomoku's runtime opening lookup uses a symmetry-canonical 12-ply analyzed line; `npm run book:gomoku-hard -- [output.json]` regenerates reviewable entries offline with configurable `GOMOKU_BOOK_NODES`, `GOMOKU_BOOK_BUDGET_MS`, and `GOMOKU_BOOK_PLIES`.
- **Worker model**: `src/games/engine/ai-worker.ts` runs hard search off the main event loop. `src/games/engine/ai-worker-pool.ts` caps concurrency (`GAME_AI_WORKER_POOL_SIZE`, default 2) with FIFO waiting; the request's absolute deadline begins at submission, so queue time reduces the remaining think time instead of adding another full budget. Both engines publish a legal depth-zero interim before deeper work, and a deadline kill returns the latest interim. Queue expiry or worker failure uses a deterministic legal fallback rather than a board-wide random move. The service routes `hard` to the worker only when the budget ≥400ms; smaller test budgets run synchronously.
- **Decision telemetry and loss corpus**: hard Gomoku and Othello write best-effort rows to `ai_decisions` before applying the AI move: session/ply, board hash, engine version, move, phase budget/elapsed time, completed depth, search/VCF/VCT/evaluation/forbidden/candidate counts, score, PV, exit reason, decision source, and fallback reason. Worker-final, worker-interim timeout, queue timeout, worker error, and deterministic fallback paths share this contract; telemetry failure is logged but never aborts a game. With `DATABASE_URL` set, `npm run corpus:gomoku-hard-losses -- [output.json]` and `npm run corpus:othello-hard-losses -- [output.json]` extract recorded AI decisions from completed hard local-AI losses, reconstructing the board before each ply from `moveHistory` (including Othello flips and pass records) for regression fixtures.

## Gomoku renju rules & error-string contract (do NOT change)

`src/games/gomoku-rules.ts` implements renju-style rules used by both the move validator and the AI. Black forbidden moves (착수 거부): double-three, double-four (incl. two fours on one line), overline (6+). Five-precedence: a move completing an exact five is never forbidden. White has no forbidden moves and may play an overline, which is **not** a win. Win detection for both colours is **exact five** (`isExactFive`), not `>=5`. `applyGomokuMove` rejects a black forbidden move with a `BadRequestException` whose message is a **client contract** (the Flutter app substring-matches `forbidden move for black`) — never change these strings:

- `forbidden move for black: double-three (삼삼)`
- `forbidden move for black: double-four (사사)`
- `forbidden move for black: overline (장목)`

## Black/white colour selection (local_ai)

`POST /api/gomoku/sessions` and `POST /api/othello/sessions` accept an optional `color: "black" | "white"` (default `"black"`, backward compatible). In `local_ai`, choosing `"white"` puts the AI on black and the AI's first move is scheduled immediately on creation. `friend_match` is unchanged (creator is black). No new persisted state — the colour rides the existing `players` map (`stateVersion` unchanged). The AI respects black's forbidden moves when it plays black, in both its own move generation and when simulating black replies.

**Renju colour imbalance (measured):** because black is forbidden 3-3/4-4/overline while white is free (and white's overline is not a win), black is structurally disadvantaged — between equal engines white wins essentially every game (medium-vs-medium ≈ 30-0 for white). So a colour-alternating self-play win rate cannot reach 80% for any engine as black; the `test/gomoku-ai.test.mjs` self-play test instead asserts hard is clearly stronger than medium (wins well above the ~50% equal-strength baseline and strictly more than medium). Othello is colour-symmetric, so its self-play test keeps the ≥80% bar.

## Replay (Gomoku & Othello — superadmin only)

Server-authoritative replay of **finished** gomoku/othello games for superadmins. This is the repo's **first web surface**.

- **Move logging (`state_json.moveHistory[]`).** A new **optional** array on gomoku/othello sessions accumulates every ply: `{ n, type: 'move'|'pass', seat (0=black,1=white), color, x (col), y (row), at (ISO UTC) }`. `x`/`y` are omitted for a pass. It is recorded inside the engine's exported `applyGomokuMove`/`applyOthelloMove` (see `src/games/move-history.ts`), so **all** sources — human, local-AI, and timer auto-moves — are captured at one choke point. Othello's forced pass (the opponent has no legal move, so the turn stays with the mover) is recorded as `type: 'pass'`. `stateVersion` is unchanged and **no migration** is needed. `moveHistory` rides in `state_json` alongside the existing `moves` array (full-information games; not stripped from `viewFor`).
- **No retroactive replay.** Games finished before logging shipped have no `moveHistory` and are **not** replayable: excluded from the list and `404` on detail.
- **Auth (D1) — superadmin only.** All replay APIs use `GamePlatformSessionGuard` + `SuperadminGuard` (`src/auth/superadmin.guard.ts`, permission `superadmin` via `hasSuperadminAccess`). Not logged in → `401` (`code: AUTH_REQUIRED`, existing session contract); logged in but not superadmin → `403` (`code: FORBIDDEN`). Browser auth reuses the existing OIDC **cookie** session (`game_platform_session`, set by `GET /api/session/oidc/callback`; the guard reads it via `extractSessionId`) — no new auth scheme.
- **APIs** (under `/api`, all superadmin-guarded):
  - `GET /api/replays?game=gomoku|othello&accountId=&page=&pageSize=` — finished gomoku/othello with a non-empty `moveHistory`, `created_at DESC`, paginated (`pageSize` default 20, max 100). Row: `{ sessionId, gameKey, mode, players:[{seat,color,accountId,displayName,isAi}], aiDifficulty?, startedAt, winner (accountId|'ai'|'draw'|null), finishReason, moveCount }`. Includes all finish reasons (D6). Display name = name → loginId → accountId (D2, from the `social_accounts` cache).
  - `GET /api/replays/:sessionId` — the row plus `boardSize`, `moves:[{…, delayMs}]` (`delayMs` = gap to the previous ply, **clamped to 30000ms**, first ply 0 — D4), and `snapshots:[board,…]` reconstructed server-side (othello flips recomputed with the engine's `othelloFlips`; a pass repeats the previous board), aligned 1:1 with `moves`.
  - `GET /api/replays/accounts/search?q=` — reuses `SocialService.searchAccounts` (the `account.search` service credential) for the user filter.
- **`/replay` web view.** Single self-contained vanilla HTML+JS+CSS page (no framework/build pipeline), stored as a TS template string in `src/replay/replay-view.page.ts` and served **outside** the global `/api` prefix (`main.ts` `setGlobalPrefix('api', { exclude: [{ path: 'replay', method: GET }] })`). The page is served without a guard; its JS routes `401`→login-start (`POST /api/session/oidc/start`, `returnUri` back to `/replay`) and `403`→"권한 없음", and on success renders the list + a canvas player that plays snapshots at the `delayMs` tempo with **pause/resume only** (resume continues from the remaining interval — D7). Times shown in Asia/Seoul.
- **App-faithful board rendering.** The replay canvas mirrors the Flutter app's **programmatic** painters (no board image asset exists — `game-platform-app-flutter/assets/images/textures/table_wood.png` is not used by these games), replicated from `GomokuPainter` (`main.dart:9412`), `OthelloBoard` (`main.dart:15602`) and `GamePalette` (`main.dart:1157`): gomoku = amber `#ffe08a→#d89544` panel + ink (`#2b1b10`) border, 15 gridlines through cell centres, radial-gradient stones (black `#5b4535→#2b1b10`, white `#fff→#ffe8a8`) with shadow/highlight/rim; othello = `leafDeep #356d1f` panel, `#2f8f4e`/`#267441` checkerboard, discs black `#16181d` / white `#f6f0df` with ink border + hard shadow. Last move = golden `#ffd166` ring — the app's gomoku idiom, reused for othello (which has no in-app last-move marker; documented choice). No cross-repo assets were copied (painting only).
- **기보 PDF export.** A "기보 PDF" button in the player generates a game-record PDF **client-side** (self-contained: no CDN, no build pipeline, no native deps). It reuses the same canvas painter to raster each move's board (after move *n*, newest move highlighted with the golden ring + a move-number badge + a caption `"n수 · 흑/백 (x,y)"`); othello passes render as a labelled `PASS` placeholder tile so the sequence stays readable. Layout: 3 tiles/row flowing top-to-bottom, multi-page, with a page-1 header (game type, players / AI difficulty, start time KST, winner, finishReason). Filename `gibo-{gameKey}-{sessionId}.pdf`. The PDF assembler + layout + captions live in `src/replay/gibo-pdf.ts` (pure, unit-tested — JPEG/DCTDecode image XObjects, no fonts so Korean rides in the rastered images); the `/replay` page inlines a browser port of those functions (kept in sync, noted in both files, because that static page has no build step). Superadmin-only (same guard); no new env keys.

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
- `POST /api/four-ball/sessions`
- `GET /api/four-ball/sessions/:id`
- `POST /api/four-ball/sessions/:id/select-target`
- `POST /api/four-ball/sessions/:id/aim`
- `POST /api/four-ball/sessions/:id/shots`
- `POST /api/four-ball/sessions/:id/emotes`
- `POST /api/four-ball/sessions/:id/forfeit`
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
- `GET /api/replays` (superadmin — finished gomoku/othello list)
- `GET /api/replays/accounts/search` (superadmin — user filter search)
- `GET /api/replays/:sessionId` (superadmin — moves + delays + snapshots)
- `GET /replay` (superadmin replay web view; served **outside** the `/api` prefix)

## Review Criteria

- `npm run build` passes.
- `npm run test` passes.
- `npm audit --audit-level=moderate` reports zero vulnerabilities.
- `npm run smoke:local-flow` passes with local `auth-api-nest` and PostgreSQL.

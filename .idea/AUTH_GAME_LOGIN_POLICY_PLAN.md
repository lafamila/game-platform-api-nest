---
status: IN_PROGRESS
summary: "Game Platform current-login policy, scoped session cleanup and verified login handoff"
---

# Game Platform Auth Policy

Canonical root plan: /Users/lafamila/work/teddy/.idea/AUTH_SOCIAL_PRODUCTION_READINESS_PLAN.md.
Workspace authority: /Users/lafamila/work/teddy/CLAUDE.md (not /private/tmp/CLAUDE.md).

## Scope

- Isolated API branch codex/auth-game-policy-api-20261118 based on 8989cde;
  companion Flutter branch codex/auth-game-policy-app-20261118 based on c6175ba.
- Enforce signed service_category=game plus authentication_method=kakao only.
  Explicit other categories and local/google/naver login remain allowed regardless
  of linked accounts. Missing/legacy provenance refreshes once when possible;
  otherwise require reauthentication without the Kakao denial message.
- Preserve Auth policy codes/descriptions in terminal 401
  SESSION_AUTH_METHOD_DENIED; delete/revoke only the affected RP session and chat
  link, clear browser cookie, notify/disconnect its socket/SSE connections.
- A failed new Kakao switch never invalidates an existing permitted local/Google
  RP session. Reconcile the previous session by its own claims/refresh after
  state/proof validation; `/oidc/complete` reports `sessionInvalidated:false`
  when the old session is permitted. Clients then discard only pending login.
- Bind browser callbacks to an HttpOnly state cookie. Native starts supply a
  random loginProof (TLS BFF requests only), hashed server-side; completion must
  verify it before failed-login cleanup. Never put this proof in redirects.
- Reuse realtime presence timers and validate socket actions; refresh Auth only
  for missing provenance or the existing token-expiry threshold.
- No game engine changes, dependencies, live DB, services, active build output,
  commits or pushes. Main owns integration/publication.

## Verification

1. Add focused failing tests for signed claims, structured refresh errors,
   session-scoped cleanup, callback bindings/proof and cookie/realtime behavior.
2. Compile only the isolated worktree using the existing TypeScript installation;
   run focused Node tests plus existing auth/session/realtime regression tests.
3. Companion lane runs focused Flutter tests and analysis without an app build.
4. Check diff whitespace and original checkout statuses; record limits and tests.

## Timing Limit

Cached allowed JWTs only learn later Auth category/method changes at refresh.
Realtime checks reuse the 25-second presence tick, plus per-action checks. No
instant cross-instance/global revocation is claimed. Offline clients may receive
generic expiry after a prior background deletion; no durable denial tombstone is
introduced in this bounded change.

## Progress

- Focused tests first: 9/9 failed against baseline, then policy implementation.
- Focused plus existing session/webhook/realtime/chat regression set: 55/55
  passing, including signed JWT/tampering, exact-string provenance, cookie
  isolation/proof/timer cases and replay error presentation.
- Isolated TypeScript emit and `--noEmit --incremental false` pass using the
  original repo's installed TypeScript. `node --check scripts/smoke-local-flow.js`
  and `git diff --check` pass. No lint script exists in this API package.
- Reproduction (isolated worktree only):
  `node node_modules/typescript/bin/tsc -p tsconfig.build.json --incremental false`;
  `node --test test/auth-game-policy.test.mjs test/session-refresh.test.mjs test/login-callback.test.mjs test/auth-webhook.test.mjs test/realtime-bridge.test.mjs test/chat-bridge.test.mjs`.
- No original checkout, engine, dependency, live DB or service changes.
- Integration/publication and live Auth/browser verification remain main-owned.
- Clarification regression: a failed new Kakao switch preserves an existing
  permitted local/Google session and cookie. Final serial targeted API slice
  (`--test-concurrency=1`, signed claims/refresh/callback/preservation/replay)
  passes 10/10 after this refinement, including a known permitted session near
  token expiry (failed switching must not refresh or remove it). A targeted
  auth/session/replay typecheck also passes. Only the changed TS modules were transpiled
  into isolated `dist`; final full typecheck is held for main's verification lane
  under the host resource-coordination override.

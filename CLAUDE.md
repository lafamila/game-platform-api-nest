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
- `POST /api/session/oidc/start`
- `GET /api/session/oidc/callback`
- `POST /api/session/oidc/complete`
- `GET /api/session/me`
- `POST /api/session/logout`
- `GET /api/accounts/search`
- `GET /api/friends/requests`
- `POST /api/friends/requests`
- `POST /api/friends/requests/:id/accept`
- `GET /api/matches`
- `POST /api/matches`
- `POST /api/matches/:id/accept`
- `POST /api/matches/:id/reject`
- `POST /api/permission-upgrade-requests`
- `GET /api/realtime/events`

## Review Criteria

- `npm run build` passes.
- `npm run test` passes.
- `npm audit --audit-level=moderate` reports zero vulnerabilities.
- `npm run smoke:local-flow` passes with local `auth-api-nest` and PostgreSQL.

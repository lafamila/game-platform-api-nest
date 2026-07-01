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

## Smoke

```bash
curl -sS http://localhost:3035/api/health
npm run smoke:local-flow
```

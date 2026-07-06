---
status: IN_PROGRESS
summary: "게임 플랫폼 서버 Phase 1–6 — 세션 sliding/refresh 3분류/에러 code 계약, rev·멱등·socket.io·grace 공통화, GameEngine 레지스트리, participants/rooms N인, 세이브 이어하기(대전→AI/솔로 복원), 신규 게임 엔진(뱀사다리→고스톱→마이티→리듬→격투)과 기존 게임 보강"
---

# GAME_PLATFORM_ENHANCEMENT — game-platform-api-nest execution plan

Canonical orchestration plan: **workspace root** `.idea/GAME_PLATFORM_ENHANCEMENT_IDEA.md` (이 파일 기준 `../../.idea/GAME_PLATFORM_ENHANCEMENT_IDEA.md`). 설계 상세는 root §1.3(세션), §2(N인), §3(세이브), §4(재연결), §5(엔진), §6(보강), §7(신규 게임), §9.1/§12(확정 결정)를 따른다. 라인 참조는 crazy_arcade 커밋(6614f72) 기준.

## Repo Responsibility

게임 플랫폼 서버의 전 Phase 구현. 세션이 일시 장애로 죽지 않게 하고(P1), 재연결 프로토콜과 socket.io 채널을 만들고(P2), 게임 추가가 "엔진 파일 1개 + 등록 1줄"이 되도록 플랫폼화하고(P3), N인 룸(P4)·세이브 이어하기(P5)·신규 게임 5종과 기존 게임 보강(P6)을 제공한다.

## Inputs / Dependencies

- Phase 1 은 auth plan 과 병행 가능. 단 **sliding idle 30일(D1)이 실효하려면 auth 의 per-client refresh TTL(30일) 적용이 필요** — auth 기능 배포 후 이 레포가 service onboarding **update request 를 제출**한다(원칙 8). 그 전까지는 Work Item 1.4 keepalive job 이 7일 refresh 체인을 유지한다.
- auth 에러 계약: 400/401/403 = 영구 거절, 5xx/네트워크 = 일시 장애 (D2 보류 전제).
- 클라이언트(flutter)는 guard `code` 필드(1.5)와 이벤트 `rev`(2.1), socket.io 채널(2.2)에 의존 — 계약 변경 시 flutter plan 과 동기화하고 orchestrator 에 보고.

## Work Items

### Phase 1 — 세션 안정화 (root §1.3, §1.5)

1. **계측(이전 Phase 0 항목)**: SSE 재연결/refresh 실패/세션 삭제 사유를 `client_error_reports` 및 서버 로그에 원인 코드로 태깅 — 이후 끊김 원인 배분 확인용 쿼리 1개 문서화.
2. **refresh 실패 3분류**: `session.service.ts` `requestToken`(:339-350)이 status 로 `AuthRejectedError`(400/401/403) vs `AuthUnavailableError`(5xx·fetch 실패·JWKS 미로딩)를 던지도록 분리. `refreshSessionLocked`(:429-445)는 Rejected 만 세션 DELETE, Unavailable 은 0.5s 재시도 1회 → 실패 시 **기존 access token 이 아직 유효하면 세션 그대로 반환(soft-fail)**, 만료 상태면 503 `AUTH_UPSTREAM_UNAVAILABLE`.
3. **선제 refresh**: 트리거를 만료 30초 전(:239)에서 5분 전으로 확대.
4. **sliding + absolute + keepalive**: `requireSession` 성공 시(직전 연장 후 5분 경과 시에만) `expires_at = LEAST(created_at + ABSOLUTE, now() + IDLE)` UPDATE. 신규 env `GAME_PLATFORM_SESSION_IDLE_SECONDS=2592000`, `GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS=15552000`(기존 `GAME_PLATFORM_SESSION_MAX_AGE_SECONDS` 는 absolute 로 fallback 매핑). keepalive job: `last_seen_at` 이 idle 창 내인 세션의 refresh token 을 만료 24h 전 rotation(앱을 안 열어도 체인 유지).
5. **에러 code 계약**: 인증 실패 응답에 `code` 필드 도입 — 401 `SESSION_EXPIRED|SESSION_INVALID|AUTH_REQUIRED`, 503 `AUTH_UPSTREAM_UNAVAILABLE` (`session.guard.ts`, `session.service.ts` 전 UnauthorizedException). 메시지 문자열은 유지(하위호환).
6. **테스트 갱신**: `test/session-refresh.test.mjs` 의 "deletes the game session when auth rejects the refresh token" 을 3분류 기준으로 재작성 + (a) 5xx 시 세션 보존/soft-fail, (b) 선제 refresh, (c) sliding/absolute, (d) code 필드 spec 추가.
7. `.env.example` 갱신(신규 2키 + 미문서 키 `GENERATE_MAP`, `NODE_ENV` 반영), 레포 `CLAUDE.md` 세션 정책 갱신, **auth 로 TTL update request 제출**(auth 기능 배포 후).

### Phase 2 — 재연결 프로토콜 + socket.io (root §4.2, D7·D8)

1. **rev + 낙관적 잠금**: 모든 게임 상태 변경 시 `state_json.rev` 단조 증가, `updateGame`(games.service.ts:1597-1609)을 `WHERE (state_json->>'rev')::int = $expected` 조건부 UPDATE 로. 모든 세션 이벤트 payload 에 `{sessionId, rev}` 포함.
2. **socket.io 게이트웨이(D8)**: `@nestjs/platform-socket.io` 도입, path `/api/socket.io`, handshake 에서 `x-game-platform-session` 검증(guard 재사용), 계정별 room join, 기존 `emitToAccounts` 를 SSE Subject + socket.io 동시 발행으로 브리지. SSE `/realtime/events` 는 전환기 유지(제거는 flutter 전환 완료 보고 후).
3. **grace 공통화**: `DISCONNECT_GRACE_MS`(:82) → env `GAME_PLATFORM_DISCONNECT_GRACE_SECONDS=60`. 대상을 gomoku/alkkagi 한정(:2439-2492)에서 턴제 매치 전 게임으로 확대(엔진 메타 이전까지는 게임별 상수 테이블로). 연결 판정은 in-memory 카운트(realtime.service.ts:62-67) 대신 **Redis presence 일원화**.
4. **grace 초과 처리(D7)**: 즉시 몰수 대신 남은 유저에게 `game.opponent_left` 이벤트 + 선택 엔드포인트(`POST /games/:gameKey/sessions/:id/claim-win` / `wait`) 제공.
5. **active 세션 목록**: `GET /api/sessions/active` — 내 참가 중(status=playing) 세션의 gameKey/sessionId/상대/updatedAt.
6. **유기 세션 GC**: `updated_at` 이 `GAME_PLATFORM_SESSION_ABANDON_DAYS=7` 경과한 playing 세션을 `finished(finishReason:'abandoned')` 처리하는 주기 job.
7. **멱등 제출**: 모든 수/샷/행동 POST 에 optional `clientMoveId`(uuid) — state_json 에 seat 별 최근 20개 보관, 중복이면 현재 상태 재응답.
8. 테스트: rev 충돌, grace 확대, claim-win/wait, active 목록, GC, clientMoveId 중복 무해성. 검증 시나리오는 root §4.4.

### Phase 3 — GameEngine 플랫폼화 (root §5.1)

1. `src/games/engine/` 신설: `GameDescriptor`(key/label/min·maxPlayers/turnType/hiddenInfo/supportsAi/supportsMatchSave/turnTimerSeconds/graceSeconds) + `GameEngine<S>`(createState/applyAction/viewFor/finishInfo/aiAction/stateVersion/migrate) + `GameRegistry`.
2. 공통 오케스트레이션 서비스: 조회 → applyAction → rev/멱등 → 저장 → emit → 타이머/AI 스케줄. `listGames`(:148-159)·`createSessionFromMatch`(:1542)·pause/resume(:1400-1539)·restore(:1168-1398)의 게임별 if-else 를 레지스트리 디스패치로 치환.
3. 공통 라우트 신설: `POST /api/games/:gameKey/sessions`, `GET .../:id`, `POST .../:id/actions {type, payload, clientMoveId}`. **기존 게임별 라우트는 thin wrapper 로 존치**(클라 호환).
4. 8게임 엔진 이식(순서: othello → gomoku → sokoban → sudoku → alkkagi → splendor → fortress → crazy_arcade). splendor/fortress 는 기존 엔진 파일을 인터페이스에 맞춰 어댑트. sudoku 의 계정별 뷰 필터(:3119-3149)를 `viewFor` 로 일반화(카드 게임 대비).
5. `main.ts` 에 ValidationPipe(whitelist/transform) + DTO 도입, 서버 RNG 유틸(시드 기록) 추가.
6. games.service.ts(4,286줄)를 `engines/{game}.engine.ts` + 세션 오케스트레이션으로 분할. social 의 gameKey 하드코딩(social.service.ts:351, stats :210-249)을 레지스트리 참조로.
7. **완료 리트머스(root §5.4)**: 이식 후 `npm run test`(local-ai 14 시나리오 포함)·smoke 통과 + 기존 클라 무변경 동작.

### Phase 4 — N인 participants/rooms (root §2, D4)

1. DDL 추가(root §2.3): `game_session_players`(seat/kind/ai_difficulty/status/result), `game_rooms`, `game_room_members`. 기동 backfill: 기존 행 → seat0=owner, seat1=opponent. 기존 컬럼은 읽기 호환 유지.
2. rooms API: `POST /api/rooms`, `GET /api/rooms/:id`, `invite`(친구·온라인 검증 재사용)/`join {roomCode}`/`ready`/`start`(host, min 충족 시). 이벤트 `room.member_joined/ready/left`, `room.started {sessionId}`. **기존 1:1 매치 초대 = 2인 룸 자동 시작 shortcut 으로 재정의**(match_requests 유지).
3. 턴 일반화: `currentSeat` + `turnOrder[]`, left/forfeited 스킵. 2인 게임은 seat0/1 ↔ 기존 색 매핑으로 무변경.
4. **splendor 2–4인(D4)**: 은행 토큰 2인 4·3인 5·4인 7(splendor-engine.ts:106 파라미터화), 귀족 타일 = 인원+1, 이진 턴 토글(:795-809) → 로테이션. **2인은 기존과 완전 동일 동작 보장**. sudoku 배틀/sokoban 레이스 2–6인(side Record → seat 배열).
5. friendStats(social.service.ts:198-249)를 participants 조인 기준으로 재작성.

### Phase 5 — 세이브 슬롯 → 매칭 종료 후 이어하기 (root §3, D5·D6·D9)

1. `game_saves` DDL(root §3.2 — 계정×게임×슬롯 1..3, full state + my_seat + players_json + state_version, created_at 은 Asia/Seoul 표기 원칙 준수).
2. API: `POST /api/games/:gameKey/sessions/:id/save {slot, label?}`(참가자 전원, **friend_match 포함**, 언제든 — D5), `GET /api/saves?gameKey=`, `POST /api/saves/:id/continue {difficulty}`, `DELETE /api/saves/:id`.
   - `source_mode='friend_match'` 이고 원본 세션이 아직 종료되지 않았으면 `continueAvailable=false` + continue 400.
   - 원본 match 종료 후 대전 전용 게임(gomoku/othello/alkkagi/splendor/fortress/crazy_arcade)은 새 `local_ai` 세션으로 fork 한다. 저장자 seat 유지, 나머지 seat AI, 턴/데드라인 재설정, 원본 세이브·원본 세션 불변.
   - sudoku/sokoban 은 AI 와 이어서 하는 것이 아니라 저장자가 혼자 같은 퍼즐/맵을 계속 푸는 `solo` 세션으로 복원한다.
3. 조회/목록은 항상 `viewFor(seat)` 필터 경유 — 세이브로 상대 정보(sudoku solution 등) 훔쳐보기 구조적 차단.
4. sudoku/sokoban 세이브 복원은 `solo` 전용이다. 이 두 게임은 세이브 이어하기를 위한 별도 AI 구현 대상이 아니다. crazy_arcade 는 server-authoritative snapshot 을 저장하고, 이어하기는 다른 대전 게임과 동일하게 `local_ai` 세션으로 fork 한다.
5. **로컬 AI 전적 서버 반영(D9)**: `POST /api/local-ai-results/batch` 로 클라의 `local-ai-results.json` 배치를 수신하고 `local_ai_results` 에 계정×게임×세션 기준 idempotent 저장.
6. 기존 `local-save-restore`(:1168-1398)는 존치하되, 로컬 save slot 을 서버 슬롯으로 이관해 제거하지 않는다. 로컬 슬롯은 게임별 최근 플레이 임시 복구 지점이고, 서버 슬롯과 충돌하면 클라가 최신 로컬 기록/서버 저장 기준 중 선택하게 한다.

### Phase 6 — 신규 게임 + 기존 게임 보강 (root §6, §7, D12·§12.1)

1. **뱀과 사다리류**(§12.1 확정, 2–6인, 서버 주사위 RNG) — 신규 엔진 구조의 리트머스. 룰 상세(보드 크기/사다리·뱀 배치/정확 도착 규칙)는 착수 시 orchestrator 경유 확정.
2. **고스톱**(맞고 2인 → 3인): 서버 셔플/패 분배(RNG 시드 기록), per-seat viewFor(손패 은닉), 점수 계산 순수 함수 + 전수 단위 테스트(피박/광박/고 배수), 고/스톱 선택 액션. 지방룰 범위는 착수 시 확정.
3. **마이티**(5인 고정): 비딩/기루다/프렌드/키티, 트릭테이킹 진행, 룰베이스 AI 4석. N인 구조 최종 스트레스 테스트.
4. **리듬**: 차트 메타 + 점수 제출 API + 리더보드(솔로/비동기 경쟁). 판정은 클라 로컬 — 서버는 기록/무결성(리플레이 해시) 최소 검증.
5. **격투(로컬 우선)**: 서버는 세션/결과 기록만. 온라인전은 Non-goal(후속, §12.2).
6. 신규 게임 에셋은 workspace `.assets/game-platform/`(MANIFEST.md)에서 flutter 레포가 반입 — 이 레포는 무관(사운드/이미지 서빙 없음).
7. **기존 게임 보강(root §6)**: crazy_arcade 서버 sanity check(스냅샷 범위/승패 정합/rate limit — :1078-1116)와 host 이탈 처리, othello 턴 타이머 추가, 전 게임 타이머 확대(엔진 메타), sokoban 판정 enum 화, gomoku 무승부 처리 확인. (오목 금수는 옵션 룰 — D10)

## Acceptance Criteria

- Phase 별 완료 기준은 root §1.5 / §4.4 / §5.4 / §2.6 / §3.4 / 게임별 테스트(§6.3, §7.1).
- 공통: `npm run build`, `npm run test`, `npm run smoke:local-flow`(로컬 auth+PG) 통과, `npm audit --audit-level=moderate` 0건.
- 계약 변경(에러 code, rev, socket.io, rooms/saves API)마다 flutter plan 과의 정합 확인을 완료 조건에 포함.
- 신규/변경 env 키가 `.env.example` 에 먼저 반영되고 완료 보고에 나열됨: `GAME_PLATFORM_SESSION_IDLE_SECONDS`, `GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS`, `GAME_PLATFORM_DISCONNECT_GRACE_SECONDS`, `GAME_PLATFORM_SESSION_ABANDON_DAYS` (+구현 중 추가분).
- 기능 단위 커밋(Conventional Commits), Phase 내 항목별 계획→구현→검토.

## Progress Log

- 2026-07-06: Phase 4 room/session 1차 구현 — `game_session_players`, `game_rooms`, `game_room_members` DDL/backfill, rooms create/get/join/invite/ready/start API, 2인 room → 기존 match shortcut, 3인 이상 room → participant seat 기반 session skeleton, active sessions participant 기반 조회를 추가. 검증: `npm run test` 43/43 통과.
- 2026-07-06: Phase 4 Splendor N인 진척 — `createSplendorStateForPlayers` 추가, room 3–4인 Splendor 시작 시 실제 Splendor state(`seat0..seatN`, turnOrder, 인원별 bank token 4/5/7, noble 인원+1)를 생성하도록 변경. Splendor participant 검증/turn advance/final-round/winner 판정을 N인 turnOrder 기반으로 일반화하고, `friendStats` 를 `game_session_players` self-join 기준으로 전환. 검증: `npm run test` 44/44 통과. 잔여: Splendor 3–4인 클라 상세 UI, Crazy Arcade server-authoritative 전환.
- 2026-07-06: Phase 5 save/continue 1차 구현 — `game_saves`, save/list/continue/delete API, source friend_match 종료 전 continue 차단, 대전 게임 local_ai fork, sudoku/sokoban solo 복원, save view 필터, local AI result batch 업로드를 추가. 검증: `npm run test` 43/43 통과. 잔여: 공통 GameEngine `viewFor/migrate` 로 저장/복원 경로 일원화, crazy_arcade server-authoritative 전환 이후 save 정책 확정.
- 2026-07-06: Phase 5 save origin 보강 — `POST /saves/:id/continue` 응답에 `{sourceSave:{id,slot,label,updatedAt}}` 를 추가해 클라가 서버 save 에서 재개한 세션의 원본 슬롯을 기본 저장 슬롯으로 제안할 수 있게 함. 검증: `npm run test` 44/44 통과.
- 2026-07-06: Phase 4 Sudoku/Sokoban 6인 race state/action 보강 — 3인 이상 room start 시 skeleton 대신 실제 Sudoku puzzle/solution/side별 board·battle·progress, Sokoban map/side별 state 를 생성하도록 변경. `SudokuSide`/`SokobanSide` 를 `seatN` 가능한 side 로 일반화하고 participant 검증·유저별 view·cell update·sokoban state 조회를 players map 기반으로 확장. Sudoku N인 damage 대상은 진행률 기준 가장 가까운 앞선 상대 1명. 검증: `npm run test` 44/44 통과. 잔여: Flutter race 진행률/결과 UI, Crazy Arcade server-authoritative 전환, 공통 GameEngine 오케스트레이터 이식.
- 2026-07-06: Phase 4 N인 emote sender 보강 — `game.emote.sent` payload 에 `senderSide` 를 추가해 3인 이상 room 에서 감정표현 발신자를 클라가 side 기준으로 표시할 수 있게 함. `custom_emotes` FakeDb/realtime capture 테스트를 추가. 검증: `npm run test` 45/45 통과.
- 2026-07-06: Phase 3 disconnect grace 1차 확장 — Fortress `friend_match` 타이머가 오프라인 턴 플레이어를 감지하면 `networkGrace*` + `game.turn.network_waiting` 으로 전환하고, grace 만료 후 `claim-win`/`wait` 선택 플로우를 Gomoku/Alkkagi 와 동일하게 지원하도록 확장. `GameDescriptor.graceSeconds` 를 Gomoku/Alkkagi/Fortress 에 명시. 검증: `npm run test` 46/46 통과. 잔여: Crazy Arcade server-authoritative 전환을 GameEngine 공통 orchestrator 로 흡수.
- 2026-07-06: Phase 3 Crazy Arcade server-authoritative 1차 전환 — `crazy-arcade-engine.ts` 를 추가해 서버가 map/player/bomb/flame/item snapshot 을 생성·전진하고, `friend_match` 의 `/input` 이 서버 tick 을 수행해 `crazy_arcade.state.synced` 를 브로드캐스트하도록 변경. `/sync` 는 더 이상 host snapshot 으로 matched state 를 덮어쓰지 않고 서버 snapshot 전진만 수행. opponent 응답은 `player`/`opponent` snapshot 을 viewer 기준으로 swap. 검증: `npm run test` 47/47 통과. 잔여: socket.io input queue + 주기 server tick + GameEngine `realtimeServer` 훅으로 이식.
- 2026-07-06: Phase 3 GameRegistry 런타임 메타 1차 — `GameRegistry` 클래스를 추가해 `listGames`, room 생성/start bounds, save validation 의 게임 메타를 단일 `GAME_DESCRIPTORS` 기준으로 조회하도록 전환. descriptor 반환은 defensive clone 으로 보호하고 Sudoku/Sokoban 6인, Splendor/Crazy Arcade 4인 계약을 테스트로 고정. 검증: `npm run test` 48/48 통과. 잔여: `GameEngine.applyAction/viewFor/migrate` 공통 오케스트레이터로 각 게임 handler 이식.
- 2026-07-06: Phase 3 공통 action route 1차 — `POST /api/games/:gameKey/sessions/:id/actions {type,payload,clientMoveId}` 를 추가하고 기존 게임별 gameplay 메서드로 위임하는 thin wrapper 를 구현. sudoku `set_cell/submit`, gomoku/othello/sokoban `move`, alkkagi `shoot`, splendor `take_tokens/reserve_card/buy_card`, fortress `select_tank/move/aim/shoot`, crazy_arcade `input` 을 지원하며, 권한/턴/멱등 검사는 기존 메서드 경로를 그대로 사용한다. Gomoku/Othello/Splendor/Alkkagi/Crazy Arcade dispatch 회귀 테스트를 추가. 검증: `npm run test` 49/49 통과. 잔여: 레거시 게임별 라우트는 클라 호환과 emote/preview/drag/forfeit 보조 route 정리 전까지 유지.
- 2026-07-06: Phase 3 Crazy Arcade 주기 server tick 1차 — 2인 `friend_match` Crazy Arcade 세션에 서버 주도 `setInterval` tick 을 추가해 `/input`/`GET` 요청이 없어도 snapshot 이 전진하고 `crazy_arcade.state.synced` 가 브로드캐스트되도록 변경. 생성/조회/입력/부팅 복구 시 tick 을 보장하고 pause/finish/forfeit/destroy 시 timer 를 정리한다. N인 room skeleton 은 snapshot 구조가 확정되기 전까지 tick 대상에서 제외. 검증: `npm run test` 50/50 통과. 잔여: socket.io input queue 정밀화와 N인 Crazy Arcade state 모델 확정.
- 2026-07-06: Phase 3 Crazy Arcade disconnect grace 보강 — 서버 tick 이 `friend_match` 참가자 presence 를 검사해 오프라인 감지 시 `networkGrace*` 상태와 `game.turn.network_waiting` 이벤트를 만들고, grace 만료 후 `game.opponent_left` + 기존 `claim-win`/`wait` 선택 흐름으로 연결되도록 확장. `crazy_arcade` 도 `GameDescriptor.graceSeconds=60` 을 노출하며 실제 기본 `GAME_PLATFORM_DISCONNECT_GRACE_SECONDS=60` 과 맞춘다. 검증: `npm run test` 51/51 통과. 잔여: Crazy Arcade N인 state 모델과 socket.io input queue 정밀화.
- 2026-07-06: Phase 3 Othello turn timer 보강 — `OthelloSession` 에 `turnStartedAt/turnDeadlineAt/networkGrace*` 를 추가하고 20초 `friend_match` 턴 제한을 적용. 타임아웃 시 온라인이면 랜덤 합법수, 둘 수 없으면 패스/종료 규칙을 수행하고, 오프라인이면 60초 disconnect grace 후 `claim-win`/`wait` 흐름으로 연결한다. `GameDescriptor.turnTimerSeconds=20`, `graceSeconds=60` 을 노출하고 회귀 테스트를 추가. 검증: `npm run test` 52/52 통과. Splendor 는 시간 초과 자동 행동 정책(구매/예약/토큰/버릴 토큰) 확정 전까지 제한시간 없이 유지.
- 2026-07-06: Phase 3 Crazy Arcade N인 room state 보강 — 3~4인 `crazy_arcade` room start 가 generic skeleton 대신 `seat0..seat3` 기반 server-authoritative snapshot/input map 을 생성하도록 수정. `CrazyArcadeSession.players/inputs` 를 동적 side record 로 일반화하고, viewer 별 `player/opponent/others` snapshot 을 제공한다. 4인 room start, participant seat 보존, `seat2` viewer swap, input update 회귀를 기존 rooms 테스트에 추가. 추가로 snapshot 파서가 `seatN` winner 를 보존하도록 수정해 N인 승자 판정 유실을 막았다. 검증: `npm run test` 53/53 통과.
- 2026-07-06: Phase 4 friend stats winner 일반화 — 전적 계산이 `winnerAccountId` 우선, 없으면 `winnerSide` 또는 legacy `winner` 를 `players` map 으로 역참조하도록 수정. 동적 `seatN` 승자만 남은 Crazy Arcade/N인 state 도 승패에 반영된다. 검증: `npm run test` 53/53 통과.
- 2026-07-06: Phase 3 Crazy Arcade input 멱등 보강 — `updateCrazyArcadeInput` 에 `clientMoveId` 소비를 추가해 공통 action route 재시도가 중복 입력으로 재적용되지 않도록 수정. 레거시 `/crazy-arcade/sessions/:id/input` 는 body 의 `clientMoveId` 를 payload 와 분리해 같은 서비스 경로로 전달한다. 검증: `npm run test` 53/53 통과.
- 2026-07-06: Phase 3 Othello GameEngine 이식 1차 — Othello 규칙/AI/점수 계산을 `src/games/othello-engine.ts` 로 분리하고 `OTHELLO_ENGINE` 이 `GameEngine` 계약(`descriptor/createState/applyAction/viewFor/finishInfo/aiAction`)을 구현하도록 추가. `GameRegistry` 의 Othello 메타는 엔진 descriptor 를 직접 사용하고, `engine('othello')` lookup 도 테스트로 고정했다. 기존 service route 는 새 엔진 함수들을 import 해 사용하므로 API 호환은 유지된다. 검증: `npm run test` 54/54 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 Gomoku GameEngine 이식 1차 — Gomoku 보드 생성/수 적용/승패 판정/AI 후보 탐색을 `src/games/gomoku-engine.ts` 로 분리하고 `GOMOKU_ENGINE` 이 `GameEngine` 계약을 구현하도록 추가. `GameRegistry` 의 Gomoku 메타는 엔진 descriptor 를 직접 사용하고, `engine('gomoku')` lookup 과 엔진 applyAction 계약을 테스트로 고정했다. 기존 service wrapper 는 타이머·disconnect grace·이벤트 흐름을 유지한다. 검증: `npm run test` 55/55 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 Sokoban GameEngine 이식 1차 — Sokoban player state 생성, side/view helper, move 적용, solved/deadlock 판정, solvability search 를 `src/games/sokoban-engine.ts` 로 분리하고 `SOKOBAN_ENGINE` 을 registry 에 등록했다. 기존 service 는 DB 저장·participant auth·emit 흐름을 유지하며 엔진 helper 를 재사용한다. `engine('sokoban')` lookup 과 solo move 완료 계약을 테스트로 고정했다. 검증: `npm run test` 56/56 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 Sudoku GameEngine 이식 1차 — Sudoku state/view helper, solution hiding, side별 board/progress, battle damage, cell update/submit 판정을 `src/games/sudoku-engine.ts` 로 분리하고 `SUDOKU_ENGINE` 을 registry 에 등록했다. 기존 service 는 생성·저장·participant auth·emit 흐름을 유지하며 엔진 helper 를 재사용한다. `engine('sudoku')` lookup, solution 은닉, solo set/submit 계약을 테스트로 고정했다. 검증: `npm run test` 57/57 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 Alkkagi GameEngine 이식 1차 — 알까기 초기 장기말 배치, 샷 적용, 물리 시뮬레이션, AI 후보 탐색/평가를 `src/games/alkkagi-engine.ts` 로 분리하고 `ALKKAGI_ENGINE` 을 registry 에 등록했다. 기존 service wrapper 는 타이머·disconnect grace·저장·이벤트 흐름을 유지하며 엔진의 `applyAlkkagiShotToSession` 을 사용한다. `engine('alkkagi')` lookup 과 엔진 shot 계약을 테스트로 고정했다. 검증: `npm run test` 58/58 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 Splendor GameEngine 이식 1차 — 기존 순수 Splendor rule/AI 함수를 `SPLENDOR_ENGINE` 계약(`descriptor/createState/applyAction/viewFor/finishInfo/aiAction`)으로 감싸고 registry 에 등록했다. `descriptor.turnTimerSeconds` 는 의도적으로 비워 제한시간 없이 유지하며, `viewFor` 는 deck 순서를 숨기고 deckCounts/mySide 만 노출한다. 2인/4인 side 평가가 깨지지 않도록 AI opponent scoring 도 N인 turnOrder 기반으로 보강했다. 검증: `npm run test` 59/59 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 Fortress GameEngine 이식 1차 — Fortress state 생성, 탱크 선택, 이동, 조준, 발사, 포기, client view, finishInfo 를 `FORTRESS_ENGINE` 계약으로 감싸고 registry 에 등록했다. 기존 service 의 타이머·AI 스케줄·shot animation 이벤트 경로는 유지하며, 엔진 descriptor 는 20초 턴 제한과 60초 grace 를 노출한다. 검증: `npm run test` 60/60 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 Crazy Arcade GameEngine 이식 1차 — Crazy Arcade server snapshot/input/tick 함수를 `CRAZY_ARCADE_ENGINE` 계약(`turnType='realtimeServer'`)으로 감싸고 registry 에 등록했다. 2~4인 dynamic seat snapshot 생성, input action, tick action, viewer별 snapshot 변환, finishInfo 를 테스트로 고정했다. 검증: `npm run test` 61/61 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 Crazy Arcade socket.io input queue 보강 — `RealtimeGateway` 가 `crazy_arcade.input` socket event 를 받아 handshake 로 인증된 `AuthAccount` 를 재사용하고, `GamesService.enqueueCrazyArcadeSocketInput` 이 session 별 Promise queue 로 입력을 직렬화한 뒤 기존 `updateCrazyArcadeInput` server-authoritative 경로를 호출하도록 추가했다. socket gateway routing 테스트와 실제 service queue idempotency 테스트를 추가했다. 검증: `npm run test` 63/63 통과, `git diff --check` 통과.
- 2026-07-06: Phase 5 save preview 엔진 view 보강 — `saveRowView` 가 `GAME_REGISTRY.engine(gameKey).viewFor(...)` 를 우선 사용해 save/list preview 를 생성하도록 변경했다. Splendor save preview 가 deck 원본을 숨기고 `deckCounts/mySide` 만 노출하는 회귀 테스트를 추가했으며, 엔진 view 실패 시 기존 게임별 필터 fallback 은 유지한다. 검증: `npm run test` 64/64 통과, `git diff --check` 통과.
- 2026-07-06: Phase 5 continue 응답 엔진 view 보강 — `visibleSessionForRow` 가 continue 로 생성된 세션 payload 에도 `GAME_REGISTRY.engine(gameKey).viewFor(...)` 를 우선 적용하도록 변경했다. Splendor continue 응답이 deck 원본을 숨기고 `deckCounts/mySide` 만 노출하는 회귀 테스트를 추가했으며, 엔진 view 실패 시 기존 legacy fallback 을 유지한다. 검증: `npm run test` 65/65 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 8게임 공통 오케스트레이터 이관 1차 — 공통 action route 의 `sudoku/set_cell`, `sudoku/submit`, `gomoku/move`, `alkkagi/shoot`, `othello/move`, `sokoban/move`, `splendor/take_tokens|reserve_card|buy_card`, `fortress/select_tank|move|aim|shoot`, `crazy_arcade/input` 처리가 레거시 gameplay wrapper 를 다시 호출하지 않고 `GAME_REGISTRY.engine(gameKey).applyAction(...)` 를 직접 호출하도록 변경했다. 레거시 route 는 같은 공통 엔진 경로를 호출하므로 기존 타이머/AI/이벤트/멱등/solution 은닉/deck 은닉 동작을 한곳에서 공유한다. Alkkagi/Fortress 엔진은 animation 을 이벤트 payload 로 반환해 기존 클라 연출을 유지한다. Sokoban 은 기존처럼 실제 이동이 없는 입력은 저장/emit 하지 않고, Sudoku submit 의 solo board payload 적용도 유지한다. Crazy Arcade 는 friend_match/online 입력을 `CRAZY_ARCADE_ENGINE.applyAction` 으로 처리하되, 로컬/AI 입력 저장 경로는 앱 로컬 루프 보존을 위해 기존 의미를 유지한다. generic action/매칭 입력 테스트가 엔진 호출을 직접 검증하도록 보강했다. 검증: `npm run test` 65/65 통과, `git diff --check` 통과.
- 2026-07-06: Phase 3 공통 create/get route 보강 — `POST /api/games/:gameKey/sessions`, `GET /api/games/:gameKey/sessions/:id` 를 추가해 8게임 세션 생성/조회가 공통 URL 로도 가능하게 했다. 기존 게임별 route 는 클라 호환을 위해 유지하며, 공통 route 는 기존 생성/조회 메서드로 dispatch 한다. 회귀 테스트가 8게임 모두 공통 create/get 으로 세션을 만들고 조회하는지 검증한다. 검증: `npm run test` 66/66 통과, `git diff --check` 통과.
- 2026-07-06: Phase 5 Crazy Arcade 서버 save 지원 — `CRAZY_ARCADE_ENGINE.descriptor.supportsMatchSave=true` 로 전환하고, 저장된 server-authoritative snapshot 을 원본 match 종료 후 `local_ai` 세션으로 fork 하도록 확정했다. fork 시 저장자를 제외한 플레이어는 `__game_platform_local_ai__` 로 치환하고 `inputs` 는 동적 side 기준으로 초기화한다. 회귀 테스트가 진행 중 continue 400, 종료 후 continue local_ai, preview side 은닉/표시, 슬롯 metadata 를 검증한다. 검증: `npm run test` 66/66 통과, `git diff --check` 통과.

## Report Back To Orchestrator

- guard `code` 계약/이벤트 rev/socket.io 채널의 확정 스펙(flutter 착수 신호).
- auth 로 제출할 TTL update request 내용과 승인 결과.
- rooms/participants 도입 시 기존 클라 호환성 확인 결과(2인 shortcut).
- 신규 게임별 착수 시 확정이 필요한 룰 옵션 목록(뱀사다리 보드 규칙, 고스톱 지방룰, 마이티 공약 표기).
- 남은 위험: 다중 인스턴스 확장(타이머/락/입력 queue 메모리 상주) — 단일 인스턴스 전제 유지 여부.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.

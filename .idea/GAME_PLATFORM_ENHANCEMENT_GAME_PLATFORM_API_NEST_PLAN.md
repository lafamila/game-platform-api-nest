---
status: PREPARED
summary: "게임 플랫폼 서버 Phase 1–6 — 세션 sliding/refresh 3분류/에러 code 계약, rev·멱등·socket.io·grace 공통화, GameEngine 레지스트리, participants/rooms N인, 세이브→AI fork, 신규 게임 엔진(뱀사다리→고스톱→마이티→리듬→격투)과 기존 게임 보강"
---

# GAME_PLATFORM_ENHANCEMENT — game-platform-api-nest execution plan

Canonical orchestration plan: **workspace root** `.idea/GAME_PLATFORM_ENHANCEMENT_IDEA.md` (이 파일 기준 `../../.idea/GAME_PLATFORM_ENHANCEMENT_IDEA.md`). 설계 상세는 root §1.3(세션), §2(N인), §3(세이브), §4(재연결), §5(엔진), §6(보강), §7(신규 게임), §9.1/§12(확정 결정)를 따른다. 라인 참조는 crazy_arcade 커밋(6614f72) 기준.

## Repo Responsibility

게임 플랫폼 서버의 전 Phase 구현. 세션이 일시 장애로 죽지 않게 하고(P1), 재연결 프로토콜과 socket.io 채널을 만들고(P2), 게임 추가가 "엔진 파일 1개 + 등록 1줄"이 되도록 플랫폼화하고(P3), N인 룸(P4)·세이브→AI fork(P5)·신규 게임 5종과 기존 게임 보강(P6)을 제공한다.

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
4. **splendor 2–4인(D4)**: 은행 토큰 2인 4·3인 5·4인 7(splendor-engine.ts:106 파라미터화), 귀족 타일 = 인원+1, 이진 턴 토글(:795-809) → 로테이션. **2인은 기존과 완전 동일 동작 보장**. sudoku 배틀/sokoban 레이스 2–4인(side Record → seat 배열).
5. friendStats(social.service.ts:198-249)를 participants 조인 기준으로 재작성.

### Phase 5 — 세이브 슬롯 → AI fork (root §3, D5·D6·D9)

1. `game_saves` DDL(root §3.2 — 계정×게임×슬롯 1..3, full state + my_seat + players_json + state_version, created_at 은 Asia/Seoul 표기 원칙 준수).
2. API: `POST /api/games/:gameKey/sessions/:id/save {slot, label?}`(참가자 전원, **friend_match 포함**, 언제든 — D5), `GET /api/saves?gameKey=`, `POST /api/saves/:id/continue {difficulty}`(**fork**: 새 local_ai 세션 — 저장자 seat 유지, 나머지 seat AI, 턴/데드라인 재설정, 원본 세이브·원본 세션 불변), `DELETE /api/saves/:id`.
3. 조회/목록은 항상 `viewFor(seat)` 필터 경유 — 세이브로 상대 정보(sudoku solution 등) 훔쳐보기 구조적 차단.
4. **레이스형 AI 신규**: sudoku(난이도별 셀 채움 속도/오답률), sokoban(기존 BFS 해 경로를 난이도별 속도로 재생). crazy_arcade 는 서버 권위 확립 전 보류(§12.2 아님 — Phase 6.7 과 연동).
5. **로컬 AI 전적 서버 반영(D9)**: 결과 업로드 엔드포인트 + 저장(클라의 `local-ai-results.json` 이관 수신).
6. 기존 `local-save-restore`(:1168-1398)는 존치하되 서버 세이브로의 수렴을 문서화(D6 이관은 클라 주도).

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

## Report Back To Orchestrator

- guard `code` 계약/이벤트 rev/socket.io 채널의 확정 스펙(flutter 착수 신호).
- auth 로 제출할 TTL update request 내용과 승인 결과.
- rooms/participants 도입 시 기존 클라 호환성 확인 결과(2인 shortcut).
- 신규 게임별 착수 시 확정이 필요한 룰 옵션 목록(뱀사다리 보드 규칙, 고스톱 지방룰, 마이티 공약 표기).
- 남은 위험: crazy_arcade 서버 권위 수준, 다중 인스턴스 확장(타이머/락 메모리 상주) — 단일 인스턴스 전제 유지 여부.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.

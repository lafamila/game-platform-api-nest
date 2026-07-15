---
status: COMPLETED
completed_at: 2026-07-15
completion_reason: "Work Items 0–6 전부 구현·검증 완료 — 커밋 88efcdc(moveHistory 로깅)·e537447(superadmin 리플레이 API+/replay 뷰)·a4a4c0a(docs), 325/325 테스트, 라이브 SQL·가드 검증(합성 데이터, 정리됨). 조사 결과: 쿠키 세션(game_platform_session) 기존 경로 재사용 성공, 엔진의 기존 moves[]는 pass 미기록이라 별도 moveHistory 신설. 잔여 수동 게이트: 브라우저 OIDC 왕복 + 재생 UI 체감 (재현 절차 계획서 기록)"
summary: "오목·오델로 리플레이 전체 구현 — moveHistory 로깅(pass 포함), superadmin 전용 리플레이 API(목록/수순+스냅샷/유저 검색), 브라우저 쿠키 세션 확인·보강, /replay vanilla 웹 뷰(원본 템포 재생+30초 클램프+일시정지/재개)"
---

# GAME_PLATFORM_REPLAY — game-platform-api-nest execution plan

Canonical orchestration plan: `../../.idea/GAME_PLATFORM_REPLAY_PLAN.md` (설계 §5, 확정 결정 D1~D7, 완료 기준 §6 은 root 기준)

## Repo Responsibility

이 레포가 리플레이 기능 **전부**의 구현 주체다 — move 로깅, 리플레이 API + superadmin 가드, 브라우저 인증 확인·보강, `/replay` 웹 뷰(레포 최초 웹 서피스), 테스트, 문서. 신규 repo·신규 포트·cross-repo 계약 없음 (Flutter 진입점은 사용자 확정 후속 — 이 레포 범위 아님).

## Inputs / Dependencies

- 확정 결정 (root §3): **D1** superadmin 전용(전 유저 열람+유저 검색) / D2 표시명 우선 / D3 `state_json.moveHistory` + 소급 불가 수용 / D4 스냅샷+`delayMs`(30초 클램프) 서버 제공 / D6 완료 게임 전체(종료 사유 표시) / D7 일시정지·재개만.
- 기존 자산 재사용: OIDC 브라우저 쿠키 경로(레거시 쿠키 max-age 존재 — 실동작 확인 필수), `GET /api/accounts/search`(account.search credential), superadmin 권한 모델(원칙 4), 렌주 룰·`color` 선택(직전 사이클), node:test dist 관례.
- **조사 1순위 (Work Item 0)**: 현행 오목/오델로 state 에 수순 이력이 이미 있는지, 쿠키 세션의 설정 시점·이름·만료 실동작 — 결과에 따라 로깅/인증 보강 폭 조정 (있으면 재사용, 새 인증 체계는 만들지 않는다).

## Work Items

0. **현행 조사**: gomoku/othello state 구조에서 수순 이력 유무 확인, 브라우저 쿠키 세션 경로 실동작 확인 (OIDC callback 이 쿠키를 어떻게 설정하는지, `/replay` 접근에 재사용 가능한지).
1. **Move 로깅** (root §5.1): 서비스 레이어의 수 적용 성공 직후 `state_json.moveHistory[]` append — `{ n, type: 'move'|'pass', seat, color, x, y, at }` (ISO UTC). 인간/AI/타이머 자동 수 모두, 오델로 강제 pass 포함. stateVersion 불변(optional 필드). 게임 `viewFor` 페이로드에서의 제외 여부는 구현 판단.
2. **리플레이 API** (root §5.2, 전부 superadmin 가드):
   - `GET /api/replays?game=&accountId=&page=&pageSize=` — finished 오목·오델로(모든 finishReason), 시작시간 desc, moveHistory 없는(소급 불가) 세션은 목록 제외 권장. 행 shape 은 root §5.2.
   - `GET /api/replays/:sessionId` — 메타 + `moves[]`(`delayMs` = 직전 수 간격, **30000ms 클램프**, 첫 수 0) + `snapshots[]`(수 적용 후 보드, pass 는 동일 보드 — 오델로 뒤집기는 서버 재구성으로 정확 보장).
   - `GET /api/replays/accounts/search?q=` — 기존 account search 재사용, 표시명+id 반환.
   - 가드: 세션 permission=superadmin 외 403 (기존 에러 code 계약 스타일과 정합).
3. **브라우저 인증** (root §5.3): `/replay` 미로그인 → 로그인 시작 유도(기존 `/api/session/oidc/start` 브라우저 플로우) → 복귀; 비superadmin → "권한 없음" 화면. 쿠키 경로 부족분만 최소 보강.
4. **`/replay` 웹 뷰** (root §5.4): global prefix 밖 정적 서빙, vanilla HTML+JS+CSS 1벌 — 목록(게임 필터·유저 검색·페이지네이션·모드별 행 포맷·Asia/Seoul 시간) + 재생(오목 15×15/오델로 8×8 보드, `delayMs` 템포, **일시정지/재개** — 재개 시 남은 간격부터, 수 번호/착수자(색+표시명 또는 AI 난이도)/승자/종료 사유 표시).
5. **테스트** (root §5.5): moveHistory 축적(오목·오델로·pass·타이머·AI 수), delayMs 클램프, 스냅샷의 오델로 뒤집기 정확성(엔진 대조), 목록 필터/페이지네이션/포맷, superadmin 가드 403. 기존 스위트 무회귀.
6. **문서**: repo CLAUDE.md — 리플레이 섹션(라우트·가드·`/replay` 뷰·moveHistory 계약·소급 불가), API Surface 목록 갱신.

## Acceptance Criteria (root §6 완료 기준)

- `npm run build && npm run test` 클린 (기존 전체 스위트 포함).
- 로깅 이후 플레이한 게임이 목록에 지정 포맷으로 표시, 재생 템포 원본 일치 + >30초 간격은 정확히 30초.
- 일시정지/재개 즉시 반응, 재개는 남은 간격부터.
- 오델로 뒤집기·pass, 오목 렌주 종료 사유 정확 표현.
- 미로그인/비superadmin 은 뷰·API 모두 차단(403/로그인 유도).
- 신규 env 키 없음 예상 — 발생 시 보고(원칙 7).

## Report Back To Orchestrator

- changed files / 검증 명령·결과 / 수동 확인 증적(스크린샷) / Work Item 0 조사 결과(가정과 달랐던 점) / 남은 위험 / cross-repo 영향(예상 없음 — 발생 시 명시) / 새 사용자 결정 필요사항.
- 커밋 금지(orchestrator 가 feature-unit 커밋), Co-authored-by 금지, 시작한 프로세스 정리(원칙 18).

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.

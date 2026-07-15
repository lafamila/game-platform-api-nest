---
status: IN_PROGRESS
summary: "오델로·오목 hard AI 대폭 강화(워커 25초 반복 심화+TT+위협 평가) + 오목 렌주형 금수(흑 3-3/4-4/장목, 백 자유·장목 비승리, 승리=정확히 5) + 오목·오델로 흑/백 선택(AI 흑 선공) — root GAME_PLATFORM_OTHELLO_GOMOKU_AI_PLAN 의 API 실행 계획"
---

# GAME_PLATFORM_OTHELLO_GOMOKU_AI — game-platform-api-nest 실행 계획

- **Root canonical plan**: `../../.idea/GAME_PLATFORM_OTHELLO_GOMOKU_AI_PLAN.md` — 규칙 스펙(§5.1)·AI 설계(§3·§4)·워커 모델(§4-B)·확정 결정(§7) 전부 root 기준.
- **주의**: root 계획의 file:line 은 2026-07-13 정찰 기준 — 이후 fighting 엔진 추가(2026-07-10 커밋들)로 위치가 이동했을 수 있음. **수정 전 반드시 현재 코드에서 재확인.**
- **확정 결정 (root §7)**: ① 흑만 금수(삼삼·사사·장목, 5우선 예외) + 백 장목 비승리 + 승리=정확히 5 ② **worker_threads (25초 예산)** ③ 클라 사전표시 없음 ④ 구 gomokuMinimax 는 easy/medium 전용으로 무수정 보존 ⑤ 오목·오델로 local_ai 색 선택(기본 흑)

## Repo Responsibility
- 이 레포가 룰·엔진·워커·API 계약·테스트·env 전부의 구현 주체. Flutter 는 별도 subagent (에러 문구·color 파라미터가 계약).
- 루트 파일·root `.idea/` 는 orchestrator 소유.

## Work Items

**ROUND 1 — 룰 + 색 선택 (AI 강화의 전제)**
1. `src/games/gomoku-rules.ts` 신설 (순수 함수, **픽스처 테스트 먼저 작성 — TDD**): `isExactFive`, `makesOverline`, `countOpenThrees`(띈3 포함, 양끝 개방 판정), `countFours`(같은 라인 이중 4 포함), `getForbiddenReason(board,r,c): "double-three"|"double-four"|"overline"|null` — 흑 전용, 타 라인 exact-5 완성 시 null(5 우선).
2. 오목 승리 판정 `hasFive(>=5)` → **exact-five** 교체 (양색 공통, 백 6+ 착수는 유효·비승리·게임 계속).
3. `applyGomokuMove` 흑 차례 금수 검증. 에러 문구 계약(변경 금지): `"forbidden move for black: double-three (삼삼)"` / `double-four (사사)` / `overline (장목)`. 기존 오델로 문구 절대 불변.
4. **색 선택**: 오목·오델로 생성 body `color?: "black"|"white"`(기본 black, 하위호환) — local_ai 에서 인간=white 면 AI=black + **생성 직후 AI 첫 수 스케줄** (기존 schedule 함수 재사용). friend_match 무변화.
5. **구 AI 금수 준수**: 기존 `chooseGomokuAiMove`(easy/medium + R1 시점의 hard)가 흑일 때 금수 후보를 필터하게 최소 수정 (색 선택과 안전 공존 — 이것 없으면 AI 흑이 금수를 시도해 착수 실패).
6. `test/gomoku-engine.test.mjs` 신설: 룰 픽스처 ≥20 (root §6 목록 — 삼삼 변형/사사 변형/장목/5우선/exact-5/백 비적용·비승리/경계) + 색 선택 케이스. `test/othello-engine.test.mjs` 신설: 규칙 회귀 + 색 선택 케이스. → **중간 보고 + 일시정지**

**ROUND 2 — AI 엔진 + 워커 (orchestrator go 후)**
7. `src/games/engine/zobrist.ts` (오델로·오목 공용 TT 유틸).
8. **AI 워커 (§4-B)**: `src/games/engine/ai-worker.ts` (dist 로드), 프로토콜 `{game,board,turn,aiColor,difficulty,budgetMs}` → interim best per depth → final. 전역 풀 2 + FIFO, budget+2s terminate → 마지막 interim 사용, 스폰 실패 시 동기 구 엔진 폴백 + 경고. **예산 env 는 호출 시점 판독** (테스트가 소예산으로 오버라이드 — 기존 local-ai 타이밍 테스트 보호).
9. `src/games/othello-ai.ts` (root §3): 반복 심화 네가맥스+알파베타+TT, 국면 3단계 평가(모빌리티/프런티어/안정석/X·C 페널티), 빈칸 ≤14 정확 종반 해결(예산 가드), 내부 비트보드. hard 만 신 엔진.
10. `src/games/gomoku-ai.ts` (root §4): 패턴 평가(열린/닫힌 3·4, 띈3), 위협 우선 후보(≤16/노드 전 깊이 동일), 반복 심화 6+ 깊이, VCF 확장, **흑 차례 금수 배제(자신·상대 시뮬 모두) + 백 장목 비승리 인지**. hard 만 신 엔진, 구 함수 무수정.
11. env: `OTHELLO_AI_BUDGET_MS`/`GOMOKU_AI_BUDGET_MS` 기본 25000, (선택) `GAME_AI_WORKER_POOL_SIZE` 기본 2 — `.env.example` 갱신.
12. 테스트 확장: 전술 픽스처(X칸 거부·종반 정확해 / VCF·이중위협 차단·금수 배제) + hard vs medium 셀프플레이 20판 ≥80%(소예산) + **워커 격리 검증**(AI 연산 중 동시 요청 응답성) + `smoke:local-flow`·기존 `local-ai.test.mjs` 통과 유지.
13. repo CLAUDE.md 갱신: AI 구조(엔진/AI 분리·워커·예산 env)·오목 룰 확정판·에러 문구 계약("변경 금지" 명시)·색 선택 API.

## Acceptance Criteria (root §6 리뷰 기준)
`npm run test` 전체 + `npm run build` 클린 / 예산 ≤25s+2s 가드 + **AI 탐색 중 동시 HTTP <200ms**(워커 격리) / easy·medium 동작 diff 없음 / 오델로 기존 에러 문구 불변 / 색 선택 하위호환(기존 클라 body 무변경 동작) / 저장→이어하기 색·난이도 유지.

## Report Back To Orchestrator
- ROUND 1 후 중간 보고(변경 파일·테스트 결과·계약 확정치) → 정지. ROUND 2 후 최종 보고(+ 25초 실측 로그, 워커 격리 증거, 남은 위험, Flutter 에 넘길 계약 요약).
- 커밋 금지 (orchestrator 가 feature-unit 커밋), Co-authored-by 금지, 시작한 프로세스 정리(원칙 18).

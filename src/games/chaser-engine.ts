import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { createSeededRng } from './engine/rng';
import { Difficulty, GameMode } from './games.types';

/**
 * 체이서(chaser) 엔진 — 2~5인 5주사위 야찌 계열 점수 게임(룬의 아이들 '추격자').
 *
 * 사용자 확정 룰(변경 불가):
 * - 2~5인(room 좌석 + AI 좌석 혼성 가능, local_ai 는 AI 1~4명 상대). 판돈 없음 — 순수 점수 게임.
 * - 각 플레이어 12턴. 자기 턴: 주사위 5개 굴림 → keep 후 리롤 최대 2회(턴당 최대 3굴림, 서버 시드 RNG) →
 *   미사용 12칸 중 1칸 선택해 점수 확정(불성립 칸 선택 = 0점). 확정 후 변경 불가. 전원 12칸 완료 시 총점 최고가 승리.
 * - 12칸/점수:
 *   숫자칸 6(aces/twoBeans/threeBeans/fourBeans/fiveBeans/sixBeans) = 해당 눈의 합. 상단 보너스 없음.
 *   choice: 투 페어(서로 다른 눈 페어 2개) 성립 시 5개 합, 아니면 0.
 *   fourDice: 동일 눈 4개 이상 → 5개 합(5개 동일도 이 칸 선택 가능).
 *   fullHouse: 서로 다른 눈 3개+2개 → 5개 합(5개 동일은 불성립).
 *   evenStraight: {2,3,4,5,6} → 30 고정. straight: {1,2,3,4,5} → 40 고정. chaseOff: 5개 동일 → 50 고정.
 * - 동점: chaseOff→straight→evenStraight→fourDice→fullHouse 순으로 획득 점수가 높은 쪽 승,
 *   그래도 동일하면 낮은 seat 승(gameWinner.tie=true).
 * - 이탈: 이탈 좌석의 잔여 칸 전부 0점 확정 후 게임 계속. 활성 1명만 남으면 즉시 승리(reason opponent_left).
 * - 턴 타이머 60초(리롤+칸 선택 포함). 타임아웃 시 서버가 자동 처리(남은 굴림 포기 + 현재 주사위로 최고 점수 칸 자동 기록).
 * - AI(easy/medium/hard): 룰베이스 keep/리롤/칸 선택. medium 이상은 카테고리 기대값 휴리스틱, easy 는 단순. 합법 보장 우선.
 */

export type ChaserCategory =
  | 'aces'
  | 'twoBeans'
  | 'threeBeans'
  | 'fourBeans'
  | 'fiveBeans'
  | 'sixBeans'
  | 'choice'
  | 'fourDice'
  | 'fullHouse'
  | 'evenStraight'
  | 'straight'
  | 'chaseOff';

export const CHASER_CATEGORIES: ChaserCategory[] = [
  'aces',
  'twoBeans',
  'threeBeans',
  'fourBeans',
  'fiveBeans',
  'sixBeans',
  'choice',
  'fourDice',
  'fullHouse',
  'evenStraight',
  'straight',
  'chaseOff',
];

/** 숫자칸 → 해당 눈 값. */
const NUMBER_FACE: Partial<Record<ChaserCategory, number>> = {
  aces: 1,
  twoBeans: 2,
  threeBeans: 3,
  fourBeans: 4,
  fiveBeans: 5,
  sixBeans: 6,
};

export type ChaserPhase = 'rolling' | 'finished';
export type ChaserSeatStatus = 'active' | 'left' | 'forfeited';

export type ChaserScorecard = Record<ChaserCategory, number | null>;

export interface ChaserLastTurnResult {
  seat: number;
  category: ChaserCategory;
  score: number;
  dice: number[];
}

export interface ChaserGameWinner {
  seat: number;
  accountId?: string;
  reason: 'complete' | 'opponent_left';
  tie: boolean;
  totals: Record<string, number>;
}

export interface ChaserSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: string;
  /** 굴림 재현용 base seed(감사 전용). viewFor 에 노출 금지. */
  rngSeed?: string;
  players: Record<string, string>; // seat0.. → accountId
  seatCount: number;
  seatStatus: Record<string, ChaserSeatStatus>;
  phase: ChaserPhase;
  status: 'playing' | 'finished';

  turnNumber: number; // 전역 턴 카운터(1부터). 각 좌석의 개별 턴마다 +1.
  currentSeat: number;
  currentTurn: string; // `seat${currentSeat}` — DB current_turn 컬럼용

  rollsUsed: number; // 이번 턴 사용한 굴림 수(0~3).
  dice: number[] | null; // 현재 턴 좌석의 주사위(굴리기 전 null).
  kept: boolean[]; // 마지막 keep 상태(길이 5).

  scorecards: Record<string, ChaserScorecard>;

  lastTurnResult?: ChaserLastTurnResult;
  gameWinner?: ChaserGameWinner;
  winnerSide?: string;
  winnerAccountId?: string;
  finishReason?: string;

  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  networkGraceAccountId?: string;
  opponentLeftAt?: string;
  pause?: {
    active: boolean;
    requestedByAccountId?: string;
    startedAt?: string;
    resumableAt?: string;
    counts?: Record<string, number>;
  };
  roomId?: string;
  roomCode?: string;
  roomMode?: 'multi_player';
  roomPlayers?: Array<{ seat: number; accountId: string; kind: 'account' | 'ai'; status: string; aiDifficulty?: Difficulty }>;
  recentClientMoves?: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

export const CHASER_MIN_PLAYERS = 2;
export const CHASER_MAX_PLAYERS = 5;
export const CHASER_TURNS_PER_PLAYER = 12;
export const CHASER_MAX_ROLLS = 3;
export const CHASER_DICE_COUNT = 5;
export const CHASER_STATE_VERSION = 1;
export const CHASER_TURN_TIMER_SECONDS = 60;

/** 동점 시 비교 순서(높은 점수 우선). */
const TIE_BREAK_ORDER: ChaserCategory[] = ['chaseOff', 'straight', 'evenStraight', 'fourDice', 'fullHouse'];

/** 0점을 떠넘길 때 희생 우선순위(가치가 낮은 칸부터). */
const DUMP_PRIORITY: ChaserCategory[] = [
  'aces',
  'twoBeans',
  'threeBeans',
  'choice',
  'fourBeans',
  'fiveBeans',
  'sixBeans',
  'fullHouse',
  'fourDice',
  'evenStraight',
  'straight',
  'chaseOff',
];

// ---------------------------------------------------------------------------
// 주사위/점수 순수 함수
// ---------------------------------------------------------------------------

function sideForSeat(seat: number): string {
  return `seat${seat}`;
}

function emptyScorecard(): ChaserScorecard {
  const card = {} as ChaserScorecard;
  for (const category of CHASER_CATEGORIES) {
    card[category] = null;
  }
  return card;
}

function faceCounts(dice: number[]): number[] {
  // index 1..6 사용.
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const die of dice) {
    if (die >= 1 && die <= 6) {
      counts[die] += 1;
    }
  }
  return counts;
}

function diceSum(dice: number[]): number {
  return dice.reduce((sum, die) => sum + die, 0);
}

export function isChaserCategory(value: unknown): value is ChaserCategory {
  return typeof value === 'string' && (CHASER_CATEGORIES as string[]).includes(value);
}

/**
 * 주어진 주사위 5개로 특정 칸의 점수를 계산한다. 불성립이면 0.
 */
export function scoreChaserCategory(dice: number[], category: ChaserCategory): number {
  if (dice.length !== CHASER_DICE_COUNT) {
    throw new BadRequestException('chaser requires exactly 5 dice');
  }
  const counts = faceCounts(dice);
  const total = diceSum(dice);
  const numberFace = NUMBER_FACE[category];
  if (numberFace !== undefined) {
    return counts[numberFace] * numberFace;
  }
  switch (category) {
    case 'choice': {
      // 투 페어: 서로 다른 눈으로 count>=2 인 눈이 2종 이상.
      const pairFaces = counts.filter((count) => count >= 2).length;
      return pairFaces >= 2 ? total : 0;
    }
    case 'fourDice': {
      // 동일 눈 4개 이상(5개 동일 포함) → 합.
      return counts.some((count) => count >= 4) ? total : 0;
    }
    case 'fullHouse': {
      // 서로 다른 눈 3개 + 2개. 5개 동일은 불성립.
      const hasTriple = counts.some((count) => count === 3);
      const hasPair = counts.some((count) => count === 2);
      return hasTriple && hasPair ? total : 0;
    }
    case 'evenStraight':
      return isExactSet(counts, [2, 3, 4, 5, 6]) ? 30 : 0;
    case 'straight':
      return isExactSet(counts, [1, 2, 3, 4, 5]) ? 40 : 0;
    case 'chaseOff':
      return counts.some((count) => count === 5) ? 50 : 0;
    default:
      return 0;
  }
}

function isExactSet(counts: number[], faces: number[]): boolean {
  const target = new Set(faces);
  for (let face = 1; face <= 6; face += 1) {
    const expected = target.has(face) ? 1 : 0;
    if (counts[face] !== expected) {
      return false;
    }
  }
  return true;
}

/** 현재 주사위로 아직 채우지 않은 칸별 점수 미리보기. */
export function chaserScorePreview(dice: number[] | null, scorecard: ChaserScorecard): Record<string, number> {
  const preview: Record<string, number> = {};
  if (!dice || dice.length !== CHASER_DICE_COUNT) {
    return preview;
  }
  for (const category of CHASER_CATEGORIES) {
    if (scorecard[category] === null) {
      preview[category] = scoreChaserCategory(dice, category);
    }
  }
  return preview;
}

function scorecardTotal(scorecard: ChaserScorecard): number {
  let total = 0;
  for (const category of CHASER_CATEGORIES) {
    const value = scorecard[category];
    if (typeof value === 'number') {
      total += value;
    }
  }
  return total;
}

/** 좌석별 총점 맵. */
export function chaserTotals(state: ChaserSession): Record<string, number> {
  const totals: Record<string, number> = {};
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    const side = sideForSeat(seat);
    totals[side] = scorecardTotal(state.scorecards[side] ?? emptyScorecard());
  }
  return totals;
}

// ---------------------------------------------------------------------------
// 상태 생성 / 턴 진행
// ---------------------------------------------------------------------------

function resolveMode(value: unknown): GameMode {
  return value === 'friend_match' || value === 'local_ai' || value === 'solo' ? value : 'local_ai';
}

export function createChaserState(
  seats: Array<{ accountId: string }>,
  mode: GameMode,
  options: { aiDifficulty?: string; seed?: string } = {},
): ChaserSession {
  if (seats.length < CHASER_MIN_PLAYERS || seats.length > CHASER_MAX_PLAYERS) {
    throw new BadRequestException(`chaser requires ${CHASER_MIN_PLAYERS}-${CHASER_MAX_PLAYERS} players`);
  }
  const seatCount = seats.length;
  const rng = createSeededRng(options.seed);
  const players: Record<string, string> = {};
  const seatStatus: Record<string, ChaserSeatStatus> = {};
  const scorecards: Record<string, ChaserScorecard> = {};
  seats.forEach((seat, index) => {
    const side = sideForSeat(index);
    players[side] = seat.accountId;
    seatStatus[side] = 'active';
    scorecards[side] = emptyScorecard();
  });
  const state: ChaserSession = {
    id: '',
    mode,
    aiDifficulty: options.aiDifficulty,
    rngSeed: rng.seed,
    players,
    seatCount,
    seatStatus,
    phase: 'rolling',
    status: 'playing',
    turnNumber: 1,
    currentSeat: 0,
    currentTurn: sideForSeat(0),
    rollsUsed: 0,
    dice: null,
    kept: Array.from({ length: CHASER_DICE_COUNT }, () => false),
    scorecards,
    createdAt: '',
    updatedAt: '',
  };
  return state;
}

function touch(state: ChaserSession): void {
  state.updatedAt = new Date().toISOString();
}

function rollRngFor(state: ChaserSession, rollIndex: number): ReturnType<typeof createSeededRng> {
  return createSeededRng(`${state.rngSeed ?? ''}#t${state.turnNumber}s${state.currentSeat}r${rollIndex}`);
}

function isSeatActive(state: ChaserSession, seat: number): boolean {
  return state.seatStatus[sideForSeat(seat)] === 'active';
}

function seatHasOpenCategory(state: ChaserSession, seat: number): boolean {
  const card = state.scorecards[sideForSeat(seat)];
  return CHASER_CATEGORIES.some((category) => card[category] === null);
}

function activeSeats(state: ChaserSession): number[] {
  const seats: number[] = [];
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    if (isSeatActive(state, seat)) {
      seats.push(seat);
    }
  }
  return seats;
}

/** currentSeat 이후로 아직 칸이 남은 활성 좌석을 찾는다. 없으면 -1. */
function nextPlayableSeat(state: ChaserSession, fromSeat: number): number {
  for (let step = 1; step <= state.seatCount; step += 1) {
    const candidate = (fromSeat + step) % state.seatCount;
    if (isSeatActive(state, candidate) && seatHasOpenCategory(state, candidate)) {
      return candidate;
    }
  }
  return -1;
}

/** 새 턴의 굴림 상태를 초기화한다. */
function beginChaserTurn(state: ChaserSession, seat: number): void {
  state.currentSeat = seat;
  state.currentTurn = sideForSeat(seat);
  state.rollsUsed = 0;
  state.dice = null;
  state.kept = Array.from({ length: CHASER_DICE_COUNT }, () => false);
  state.phase = 'rolling';
  touch(state);
}

export function chaserCanRoll(state: ChaserSession): boolean {
  return state.status === 'playing' && state.phase === 'rolling' && state.rollsUsed < CHASER_MAX_ROLLS;
}

export function chaserCanScore(state: ChaserSession): boolean {
  return state.status === 'playing' && state.phase === 'rolling' && state.rollsUsed >= 1;
}

/** roll 액션: 첫 굴림은 keep 무시(전체 굴림), 이후는 keep 되지 않은 주사위만 리롤. */
function applyChaserRoll(state: ChaserSession, seat: number, keep?: boolean[]): void {
  if (seat !== state.currentSeat) {
    throw new BadRequestException('not your turn');
  }
  if (!chaserCanRoll(state)) {
    throw new BadRequestException('no rolls remaining');
  }
  const rollIndex = state.rollsUsed + 1;
  const rng = rollRngFor(state, rollIndex);
  if (state.dice === null || state.rollsUsed === 0) {
    // 첫 굴림: 전체 굴림, keep 무시.
    state.dice = Array.from({ length: CHASER_DICE_COUNT }, () => rng.int(6) + 1);
    state.kept = Array.from({ length: CHASER_DICE_COUNT }, () => false);
  } else {
    const mask = normalizeKeep(keep);
    const next = [...state.dice];
    for (let i = 0; i < CHASER_DICE_COUNT; i += 1) {
      if (!mask[i]) {
        next[i] = rng.int(6) + 1;
      }
    }
    state.dice = next;
    state.kept = mask;
  }
  state.rollsUsed = rollIndex;
  touch(state);
}

function normalizeKeep(keep?: boolean[]): boolean[] {
  const mask = Array.from({ length: CHASER_DICE_COUNT }, () => false);
  if (Array.isArray(keep)) {
    for (let i = 0; i < CHASER_DICE_COUNT; i += 1) {
      mask[i] = keep[i] === true;
    }
  }
  return mask;
}

/** score 액션: 미사용 칸 하나를 골라 현재 주사위로 확정(불성립=0). 이후 턴 진행. */
function applyChaserScore(state: ChaserSession, seat: number, category: ChaserCategory): void {
  if (seat !== state.currentSeat) {
    throw new BadRequestException('not your turn');
  }
  if (!chaserCanScore(state) || state.dice === null) {
    throw new BadRequestException('must roll before scoring');
  }
  const card = state.scorecards[sideForSeat(seat)];
  if (card[category] !== null) {
    throw new BadRequestException('category already scored');
  }
  const score = scoreChaserCategory(state.dice, category);
  card[category] = score;
  state.lastTurnResult = { seat, category, score, dice: [...state.dice] };
  advanceChaserTurn(state, seat);
}

/** 다음 활성/미완료 좌석으로 턴을 넘기거나, 없으면 게임을 종료한다. */
function advanceChaserTurn(state: ChaserSession, fromSeat: number): void {
  const next = nextPlayableSeat(state, fromSeat);
  if (next === -1) {
    finishChaserByCompletion(state);
    return;
  }
  state.turnNumber += 1;
  beginChaserTurn(state, next);
}

// ---------------------------------------------------------------------------
// 종료 / 승자 판정
// ---------------------------------------------------------------------------

/**
 * 후보 좌석 중 승자를 정한다. 총점 최고가 승. 총점이 동률인 좌석이 둘 이상이면 tie=true 로 표기하고,
 * chaseOff→straight→evenStraight→fourDice→fullHouse 순 획득 점수가 높은 쪽, 그래도 같으면 낮은 seat 이 승.
 */
function pickChaserWinner(state: ChaserSession, candidates: number[]): { seat: number; tie: boolean } {
  const totals = chaserTotals(state);
  const maxTotal = Math.max(...candidates.map((seat) => totals[sideForSeat(seat)] ?? 0));
  const topSeats = candidates.filter((seat) => (totals[sideForSeat(seat)] ?? 0) === maxTotal);
  const tie = topSeats.length > 1;
  let best = topSeats[0];
  for (const seat of topSeats.slice(1)) {
    const cmp = compareChaserTieBreak(state, seat, best);
    if (cmp > 0 || (cmp === 0 && seat < best)) {
      best = seat;
    }
  }
  return { seat: best, tie };
}

/** 총점이 같은 두 좌석의 tie-break 비교. a 우위면 >0, 열위면 <0, 완전 동일이면 0. */
function compareChaserTieBreak(state: ChaserSession, a: number, b: number): number {
  const cardA = state.scorecards[sideForSeat(a)];
  const cardB = state.scorecards[sideForSeat(b)];
  for (const category of TIE_BREAK_ORDER) {
    const scoreA = typeof cardA[category] === 'number' ? (cardA[category] as number) : 0;
    const scoreB = typeof cardB[category] === 'number' ? (cardB[category] as number) : 0;
    if (scoreA !== scoreB) {
      return scoreA - scoreB;
    }
  }
  return 0;
}

function finishChaserByCompletion(state: ChaserSession): void {
  const candidates = activeSeats(state);
  const pool = candidates.length > 0 ? candidates : [...Array(state.seatCount).keys()];
  const { seat, tie } = pickChaserWinner(state, pool);
  finalizeChaser(state, seat, 'complete', tie);
}

function finalizeChaser(
  state: ChaserSession,
  winnerSeat: number,
  reason: 'complete' | 'opponent_left',
  tie: boolean,
): void {
  state.status = 'finished';
  state.phase = 'finished';
  state.finishReason = reason;
  state.dice = state.dice ?? null;
  state.gameWinner = {
    seat: winnerSeat,
    accountId: state.players[sideForSeat(winnerSeat)],
    reason,
    tie,
    totals: chaserTotals(state),
  };
  state.winnerSide = sideForSeat(winnerSeat);
  state.winnerAccountId = state.players[sideForSeat(winnerSeat)];
  state.currentTurn = '';
  clearChaserTurnClock(state);
  touch(state);
}

function clearChaserTurnClock(state: ChaserSession): void {
  state.turnStartedAt = undefined;
  state.turnDeadlineAt = undefined;
  state.networkGraceStartedAt = undefined;
  state.networkGraceDeadlineAt = undefined;
  state.networkGraceAccountId = undefined;
  state.opponentLeftAt = undefined;
}

/**
 * 이탈/포기: 잔여 칸 전부 0점 확정 → 활성 1명이면 즉시 그 사람 승리(opponent_left),
 * 아니면 게임 계속(현재 좌석이 이탈했으면 다음 좌석으로 진행).
 */
export function applyChaserForfeit(state: ChaserSession, seat: number): void {
  if (state.status === 'finished') {
    return;
  }
  if (!isSeatActive(state, seat)) {
    return;
  }
  state.seatStatus[sideForSeat(seat)] = 'left';
  const card = state.scorecards[sideForSeat(seat)];
  for (const category of CHASER_CATEGORIES) {
    if (card[category] === null) {
      card[category] = 0;
    }
  }
  const remaining = activeSeats(state);
  if (remaining.length <= 1) {
    const winner = remaining[0] ?? seat;
    finalizeChaser(state, winner, 'opponent_left', false);
    return;
  }
  if (state.currentSeat === seat) {
    // 이탈자의 턴이었다면 다음 활성/미완료 좌석으로.
    const next = nextPlayableSeat(state, seat);
    if (next === -1) {
      finishChaserByCompletion(state);
      return;
    }
    state.turnNumber += 1;
    beginChaserTurn(state, next);
    return;
  }
  touch(state);
}

/**
 * 타임아웃 자동 처리: 아직 한 번도 안 굴렸으면 강제로 한 번 굴린 뒤(남은 리롤 포기),
 * 현재 주사위로 가장 점수가 높은 미사용 칸을 자동 기록한다.
 */
export function applyChaserTimeout(state: ChaserSession, seat: number): void {
  if (state.status !== 'playing' || seat !== state.currentSeat) {
    return;
  }
  if (state.dice === null || state.rollsUsed === 0) {
    applyChaserRoll(state, seat, undefined);
  }
  const open = openCategories(state, seat);
  const category = chooseChaserCategory(state.dice ?? [], open);
  applyChaserScore(state, seat, category);
}

// ---------------------------------------------------------------------------
// viewFor — 전 정보 공개(단 rngSeed 만 비노출)
// ---------------------------------------------------------------------------

export function chaserViewFor(state: ChaserSession, seat: number | 'spectator'): unknown {
  const viewerSeat = typeof seat === 'number' ? seat : -1;
  const currentCard = state.scorecards[sideForSeat(state.currentSeat)] ?? emptyScorecard();
  const view: Record<string, unknown> = {
    id: state.id,
    rev: state.rev,
    gameKey: 'chaser',
    mode: state.mode,
    aiDifficulty: state.aiDifficulty,
    players: state.players,
    seatStatus: state.seatStatus,
    seatCount: state.seatCount,
    mySeat: viewerSeat >= 0 ? viewerSeat : undefined,
    phase: state.phase,
    status: state.status,
    turnNumber: state.turnNumber,
    currentSeat: state.currentSeat,
    currentTurn: state.currentTurn,
    rollsUsed: state.rollsUsed,
    dice: state.dice,
    kept: state.kept,
    canRoll: chaserCanRoll(state),
    canScore: chaserCanScore(state),
    scorecards: state.scorecards,
    totals: chaserTotals(state),
    scorePreview: chaserScorePreview(state.dice, currentCard),
    lastTurnResult: state.lastTurnResult,
    turnStartedAt: state.turnStartedAt,
    turnDeadlineAt: state.turnDeadlineAt,
    pause: state.pause,
    finishReason: state.finishReason,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
  if (state.status === 'finished') {
    view.gameWinner = state.gameWinner;
    view.winnerSide = state.winnerSide;
    view.winnerAccountId = state.winnerAccountId;
  }
  return view;
}

// ---------------------------------------------------------------------------
// AI (룰베이스, 합법 보장 우선)
// ---------------------------------------------------------------------------

function openCategories(state: ChaserSession, seat: number): ChaserCategory[] {
  const card = state.scorecards[sideForSeat(seat)];
  return CHASER_CATEGORIES.filter((category) => card[category] === null);
}

/** 미사용 칸 중 채울 칸을 고른다: 최고 점수 우선, 0점뿐이면 가치 낮은 칸부터 희생. */
function chooseChaserCategory(dice: number[], open: ChaserCategory[]): ChaserCategory {
  if (open.length === 0) {
    throw new BadRequestException('no open chaser category');
  }
  if (dice.length !== CHASER_DICE_COUNT) {
    return dumpChoice(open);
  }
  const scored = open.map((category) => ({ category, score: scoreChaserCategory(dice, category) }));
  const maxScore = Math.max(...scored.map((entry) => entry.score));
  if (maxScore <= 0) {
    return dumpChoice(open);
  }
  const top = scored.filter((entry) => entry.score === maxScore).map((entry) => entry.category);
  if (top.length === 1) {
    return top[0];
  }
  // 동점 점수: 가치가 낮은 칸(희생 우선순위 앞쪽)을 먼저 채워 고득점 칸을 남긴다.
  return dumpChoice(top);
}

function dumpChoice(open: ChaserCategory[]): ChaserCategory {
  for (const category of DUMP_PRIORITY) {
    if (open.includes(category)) {
      return category;
    }
  }
  return open[0];
}

/** 리롤 keep 마스크: 짝/트리플 유지, 없으면 스트레이트 지향. */
function chaserKeepMask(dice: number[], difficulty: Difficulty): boolean[] {
  const counts = faceCounts(dice);
  const modalCount = Math.max(...counts);
  if (modalCount >= 2) {
    if (difficulty === 'easy') {
      // easy: 최빈 눈만 유지.
      const modalFace = counts.indexOf(modalCount);
      return dice.map((die) => die === modalFace);
    }
    // medium/hard: count>=2 인 모든 눈 유지(풀하우스/포다이스/투페어 지향).
    return dice.map((die) => counts[die] >= 2);
  }
  // 전부 다른 눈 → 스트레이트 지향. {1-5} vs {2-6} 중 더 많이 겹치는 쪽 유지.
  const low = new Set([1, 2, 3, 4, 5]);
  const high = new Set([2, 3, 4, 5, 6]);
  const lowMatches = dice.filter((die) => low.has(die)).length;
  const highMatches = dice.filter((die) => high.has(die)).length;
  const target = lowMatches >= highMatches ? low : high;
  const keptFaces = new Set<number>();
  return dice.map((die) => {
    if (target.has(die) && !keptFaces.has(die)) {
      keptFaces.add(die);
      return true;
    }
    return false;
  });
}

/** 굴림을 멈추고 지금 점수화할지 판단(medium/hard). easy 는 강제 굴림 소진까지 계속. */
function shouldChaserStop(state: ChaserSession, seat: number, difficulty: Difficulty): boolean {
  if (difficulty === 'easy') {
    return false;
  }
  const dice = state.dice;
  if (!dice) {
    return false;
  }
  const open = openCategories(state, seat);
  const isOpen = (category: ChaserCategory) => open.includes(category);
  // 고정 특수 족보가 열려 있고 성립하면 멈춘다.
  for (const category of ['chaseOff', 'straight', 'evenStraight'] as ChaserCategory[]) {
    if (isOpen(category) && scoreChaserCategory(dice, category) > 0) {
      return true;
    }
  }
  if (isOpen('fourDice') && scoreChaserCategory(dice, 'fourDice') > 0) {
    return true;
  }
  if (isOpen('fullHouse') && scoreChaserCategory(dice, 'fullHouse') > 0) {
    return true;
  }
  if (difficulty === 'hard') {
    // hard: 높은 숫자 칸(fourBeans 이상)이 열려 있고 해당 눈 4개 이상이면 멈춘다.
    const counts = faceCounts(dice);
    for (const face of [6, 5, 4]) {
      const category = numberCategoryForFace(face);
      if (category && isOpen(category) && counts[face] >= 4) {
        return true;
      }
    }
  }
  return false;
}

function numberCategoryForFace(face: number): ChaserCategory | undefined {
  for (const [category, value] of Object.entries(NUMBER_FACE)) {
    if (value === face) {
      return category as ChaserCategory;
    }
  }
  return undefined;
}

function chooseChaserAiAction(state: ChaserSession, seat: number, difficulty: Difficulty): GameAction {
  if (state.dice === null || state.rollsUsed === 0) {
    return { type: 'roll', payload: { keep: Array.from({ length: CHASER_DICE_COUNT }, () => false) } };
  }
  const open = openCategories(state, seat);
  if (!chaserCanRoll(state) || shouldChaserStop(state, seat, difficulty)) {
    return { type: 'score', payload: { category: chooseChaserCategory(state.dice, open) } };
  }
  return { type: 'roll', payload: { keep: chaserKeepMask(state.dice, difficulty) } };
}

// ---------------------------------------------------------------------------
// 엔진 계약
// ---------------------------------------------------------------------------

export const CHASER_ENGINE: GameEngine<ChaserSession> = {
  descriptor: {
    key: 'chaser',
    title: 'Chaser',
    minPlayers: CHASER_MIN_PLAYERS,
    maxPlayers: CHASER_MAX_PLAYERS,
    modes: ['local_ai', 'friend_match'],
    turnType: 'turnBased',
    hiddenInfo: false,
    supportsAi: true,
    supportsMatchSave: true,
    turnTimerSeconds: CHASER_TURN_TIMER_SECONDS,
    status: 'playable',
  },
  stateVersion: CHASER_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): ChaserSession {
    const seats = players.map((player, index) => ({
      accountId: player.accountId ?? `__game_platform_local_ai__#${index}`,
    }));
    const state = createChaserState(seats, resolveMode(config.mode), {
      aiDifficulty: typeof config.aiDifficulty === 'string' ? config.aiDifficulty : undefined,
      seed: typeof config.seed === 'string' ? config.seed : undefined,
    });
    state.id = typeof config.id === 'string' ? config.id : '';
    return state;
  },
  applyAction(state: ChaserSession, seat: number, action: GameAction) {
    if (state.status === 'finished') {
      throw new BadRequestException('chaser session is finished');
    }
    const payload = action.payload ?? {};
    switch (action.type) {
      case 'roll': {
        const keep = Array.isArray(payload.keep) ? (payload.keep as boolean[]) : undefined;
        applyChaserRoll(state, seat, keep);
        break;
      }
      case 'score': {
        const category = payload.category;
        if (!isChaserCategory(category)) {
          throw new BadRequestException('invalid chaser category');
        }
        applyChaserScore(state, seat, category);
        break;
      }
      case 'timeout':
        applyChaserTimeout(state, seat);
        break;
      case 'forfeit':
        applyChaserForfeit(state, seat);
        break;
      default:
        throw new BadRequestException(`unsupported chaser action: ${action.type}`);
    }
    return { state };
  },
  viewFor(state: ChaserSession, seat: number | 'spectator') {
    return chaserViewFor(state, seat);
  },
  finishInfo(state: ChaserSession) {
    if (state.status !== 'finished') {
      return null;
    }
    return {
      status: 'finished' as const,
      winnerSeat: state.gameWinner?.seat,
      reason: state.finishReason,
    };
  },
  aiAction(state: ChaserSession, seat: number, difficulty: Difficulty): GameAction {
    return chooseChaserAiAction(state, seat, difficulty);
  },
  migrate(oldState: unknown): ChaserSession {
    return oldState as ChaserSession;
  },
};

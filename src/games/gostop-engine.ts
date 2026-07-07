import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { createSeededRng, SeededRng } from './engine/rng';
import { Difficulty, GameMode } from './games.types';

/**
 * 고스톱(gostop) 엔진 — 2인(맞고)·3인 화투 점수/재화 게임.
 *
 * 세션 재화 루프는 섯다(seotda-engine.ts)와 동일한 구조다:
 * - 세션 시작 시 공통 재화를 전원에게 동일 분배(기본 10,000, config).
 * - 연속 판(round) 진행. 선(先) = 직전 판 승자.
 * - 판마다 점수 × 배수 × 점당금액(pointValue, 기본 100)을 패자가 승자에게 지불.
 *   3인은 패자 각자 지불하며, 박 배수는 패자별로 적용된다.
 * - 잔액 0 이하 발생 또는 이탈 시 세션 종료 → 잔액 최다 보유자 승리(reason bankrupt|opponent_left).
 *
 * 이 파일의 첫 계층(카드 매핑·점수 계산)은 순수 함수로, 상태머신과 분리해 전수 테스트한다.
 *
 * 채택한 표준 룰 기본값(지방룰 변형 옵션은 서비스 보고서 참조):
 * - 덱 48장. 카드 id 'hwatu_{month}_{1..4}'. 파생 규칙 없이 명시 매핑 테이블만 사용.
 * - kind: gwang | yeol | tti | pi | ssangpi.
 * - 띠 단 그룹: 홍단(1·2·3월) / 청단(6·9·10월) / 초단(4·5·7월). 비띠(12월)는 단 그룹 없음.
 * - 고도리: 2·4·8월 열끗 3장.
 */

export type GostopCardKind = 'gwang' | 'yeol' | 'tti' | 'pi' | 'ssangpi';
export type GostopTtiGroup = 'hongdan' | 'cheongdan' | 'chodan';
export type GostopCardIndex = 1 | 2 | 3 | 4;

export interface GostopCard {
  id: string; // 'hwatu_{month}_{index}'
  month: number; // 1..12
  index: GostopCardIndex;
  kind: GostopCardKind;
  /** 단(띠) 그룹. 비띠(12월 띠)는 그룹이 없다. */
  ttiGroup?: GostopTtiGroup;
  /** 고도리 새(2·4·8월 열끗). */
  godori?: boolean;
  /** 비광(12월 광). 3광 계산 시 2점 판정에 쓰인다. */
  biGwang?: boolean;
}

interface CardSpec {
  kind: GostopCardKind;
  ttiGroup?: GostopTtiGroup;
  godori?: boolean;
  biGwang?: boolean;
}

/**
 * 48장 명시 매핑 테이블. 이 테이블이 카드 정의의 유일한 소스다(파생 규칙 금지).
 * 1~10월: 1=광(1·3·8월)/열끗(그 외), 2=띠(8월만 열끗), 3·4=피.
 * 11월(오동): 1=광, 2=쌍피, 3=피, 4=피.
 * 12월(비): 1=비광, 2=열끗, 3=비띠, 4=쌍피.
 */
const CARD_TABLE: Record<number, Record<GostopCardIndex, CardSpec>> = {
  1: { 1: { kind: 'gwang' }, 2: { kind: 'tti', ttiGroup: 'hongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  2: { 1: { kind: 'yeol', godori: true }, 2: { kind: 'tti', ttiGroup: 'hongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  3: { 1: { kind: 'gwang' }, 2: { kind: 'tti', ttiGroup: 'hongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  4: { 1: { kind: 'yeol', godori: true }, 2: { kind: 'tti', ttiGroup: 'chodan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  5: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'chodan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  6: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'cheongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  7: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'chodan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  8: { 1: { kind: 'gwang' }, 2: { kind: 'yeol', godori: true }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  9: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'cheongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  10: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'cheongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  11: { 1: { kind: 'gwang' }, 2: { kind: 'ssangpi' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  12: { 1: { kind: 'gwang', biGwang: true }, 2: { kind: 'yeol' }, 3: { kind: 'tti' }, 4: { kind: 'ssangpi' } },
};

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const INDICES: GostopCardIndex[] = [1, 2, 3, 4];

export function gostopCardId(month: number, index: GostopCardIndex): string {
  return `hwatu_${month}_${index}`;
}

function makeCard(month: number, index: GostopCardIndex): GostopCard {
  const spec = CARD_TABLE[month]?.[index];
  if (!spec) {
    throw new BadRequestException(`invalid gostop card: ${month}/${index}`);
  }
  return {
    id: gostopCardId(month, index),
    month,
    index,
    kind: spec.kind,
    ttiGroup: spec.ttiGroup,
    godori: spec.godori,
    biGwang: spec.biGwang,
  };
}

export function parseGostopCardId(id: string): GostopCard {
  const match = /^hwatu_(\d{1,2})_(1|2|3|4)$/.exec(id);
  if (!match) {
    throw new BadRequestException(`invalid gostop card id: ${id}`);
  }
  const month = Number(match[1]);
  const index = Number(match[2]) as GostopCardIndex;
  if (!MONTHS.includes(month)) {
    throw new BadRequestException(`invalid gostop card month: ${id}`);
  }
  return makeCard(month, index);
}

export function createGostopDeck(): GostopCard[] {
  const deck: GostopCard[] = [];
  for (const month of MONTHS) {
    for (const index of INDICES) {
      deck.push(makeCard(month, index));
    }
  }
  return deck;
}

// ---------------------------------------------------------------------------
// 점수 계산 (획득 패 실시간 계산 — 순수 함수)
// ---------------------------------------------------------------------------

export interface GostopScoreBreakdown {
  gwang: number;
  yeol: number;
  tti: number;
  pi: number;
  total: number;
  /** 고도리 성립 여부(2·4·8월 열끗 3장). */
  godori: boolean;
  /** 완성된 단 그룹. */
  danGroups: GostopTtiGroup[];
  /** 환산 피 장수(쌍피=2). */
  piCount: number;
  /** 광 장수. */
  gwangCount: number;
  /** 비광 포함 여부. */
  hasBiGwang: boolean;
}

/** 획득한 카드 배열로 실시간 점수를 계산한다. */
export function scoreGostopCaptures(cards: GostopCard[]): GostopScoreBreakdown {
  // 광.
  const gwangCards = cards.filter((card) => card.kind === 'gwang');
  const gwangCount = gwangCards.length;
  const hasBiGwang = gwangCards.some((card) => card.biGwang);
  let gwang = 0;
  if (gwangCount >= 5) {
    gwang = 15;
  } else if (gwangCount === 4) {
    gwang = 4;
  } else if (gwangCount === 3) {
    gwang = hasBiGwang ? 2 : 3;
  }

  // 열끗 + 고도리.
  const yeolCards = cards.filter((card) => card.kind === 'yeol');
  const yeolCount = yeolCards.length;
  let yeol = yeolCount >= 5 ? yeolCount - 4 : 0;
  const godoriCount = cards.filter((card) => card.godori).length;
  const godori = godoriCount >= 3;
  if (godori) {
    yeol += 5;
  }

  // 단(띠).
  const ttiCards = cards.filter((card) => card.kind === 'tti');
  const ttiCount = ttiCards.length;
  let tti = ttiCount >= 5 ? ttiCount - 4 : 0;
  const danGroups: GostopTtiGroup[] = [];
  for (const group of ['hongdan', 'cheongdan', 'chodan'] as GostopTtiGroup[]) {
    if (ttiCards.filter((card) => card.ttiGroup === group).length >= 3) {
      danGroups.push(group);
      tti += 3;
    }
  }

  // 피(쌍피=2 환산).
  let piCount = 0;
  for (const card of cards) {
    if (card.kind === 'pi') {
      piCount += 1;
    } else if (card.kind === 'ssangpi') {
      piCount += 2;
    }
  }
  const pi = piCount >= 10 ? piCount - 9 : 0;

  return {
    gwang,
    yeol,
    tti,
    pi,
    total: gwang + yeol + tti + pi,
    godori,
    danGroups,
    piCount,
    gwangCount,
    hasBiGwang,
  };
}

// ---------------------------------------------------------------------------
// 세션 상태
// ---------------------------------------------------------------------------

export type GostopPhase = 'playing' | 'flip_choice' | 'go_stop' | 'settled' | 'finished';
export type GostopSeatStatus = 'active' | 'left' | 'forfeited';

export interface GostopConfig {
  startingBalance: number;
  pointValue: number;
}

/** 바닥 겹침 그룹. cards 는 모두 같은 월. ppeok=true 면 뻑더미(먹으면 상대 피 1장). */
export interface GostopFloorStack {
  cards: GostopCard[];
  ppeok?: boolean;
}

export type GostopEvent =
  | 'ppeok'
  | 'first_ppeok'
  | 'jjok'
  | 'ttadak'
  | 'sseulssak'
  | 'bomb'
  | 'shake'
  | 'ppeok_eaten'
  | 'steal';

export interface GostopLastPlay {
  seat: number;
  played?: string;
  flipped?: string;
  captured: string[];
  events: GostopEvent[];
}

export interface GostopMultiplierDetail {
  go: number;
  shake: number;
  bomb: number;
  pibak: Record<string, number>;
  gwangbak: Record<string, number>;
  gobak: number | null;
}

export interface GostopLastRoundResult {
  winnerSeat: number; // 나가리면 -1
  basePoints: number;
  goCount: number;
  multiplierDetail: GostopMultiplierDetail;
  amountPerLoser: Record<string, number>;
  nagari?: boolean;
  chongtong?: boolean;
  balancesAfter: number[];
}

export interface GostopGameWinner {
  seat: number;
  accountId?: string;
  reason: 'opponent_left' | 'bankrupt';
  finalBalances: number[];
}

export interface GostopSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: string;
  /** 딜 재현용 base seed(감사 전용). viewFor 에 노출 금지. */
  rngSeed?: string;
  players: Record<string, string>; // seatN → accountId
  seatCount: number;
  config: GostopConfig;
  balances: number[];
  seatStatus: Record<string, GostopSeatStatus>;
  dealer: number; // 선(先) 좌석
  roundNumber: number;
  phase: GostopPhase;
  currentSeat: number;
  currentTurn: string; // `seat${currentSeat}`

  // 현재 판 상태(히든 포함)
  deck: GostopCard[]; // 남은 더미(히든). viewFor 에 노출 금지.
  hands: GostopCard[][]; // 좌석별 손패(히든). 자기 것만 노출.
  floor: GostopFloorStack[]; // 바닥 겹침 그룹(공개).
  captures: GostopCard[][]; // 좌석별 획득 패(공개).
  scores: number[]; // 좌석별 실시간 총점.
  goCount: number[];
  goScore: number[]; // 마지막 고 시점 점수(초기 -1).
  shakeCount: number[];
  bombCount: number[];
  firstTurnPlayed: boolean; // 판의 첫 턴 완료 여부(첫뻑 판정).

  pendingChoice?: { type: 'match_pick' | 'flip_pick'; options: string[] };
  /** flip_choice 대기 중 중간 상태(턴 재개용). */
  pending?: GostopPendingTurn;
  lastPlay?: GostopLastPlay;
  goStopSeat?: number;

  lastRoundResult?: GostopLastRoundResult;
  gameWinner?: GostopGameWinner;
  winnerSide?: string;
  winnerAccountId?: string;
  status: 'playing' | 'finished';
  finishReason?: string;

  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  networkGraceAccountId?: string;
  opponentLeftAt?: string;
  pause?: { active: boolean; requestedByAccountId?: string; startedAt?: string; resumableAt?: string; counts?: Record<string, number> };
  roomId?: string;
  roomCode?: string;
  roomMode?: 'multi_player';
  roomPlayers?: Array<{ seat: number; accountId: string; kind: 'account' | 'ai'; status: string; aiDifficulty?: Difficulty }>;
  recentClientMoves?: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

/** flip_choice 대기 중 턴을 재개하기 위한 중간 상태. C3 턴 머신에서 사용. */
export interface GostopPendingTurn {
  seat: number;
  playedId?: string;
  flippedId?: string;
  captured: string[];
  events: GostopEvent[];
  /** 뒤집기 대기 시 후보 바닥 카드 월. */
  pendingMonth?: number;
  /** true 면 뒤집기 카드가 더미에서 이미 나온 상태(flip_pick). false 면 손패 매칭 대기(match_pick). */
  fromFlip: boolean;
}

export const GOSTOP_MIN_PLAYERS = 2;
export const GOSTOP_MAX_PLAYERS = 3;
export const GOSTOP_DEFAULT_STARTING_BALANCE = 10_000;
export const GOSTOP_DEFAULT_POINT_VALUE = 100;
export const GOSTOP_STATE_VERSION = 1;
export const GOSTOP_TURN_TIMER_SECONDS = 40;
export const GOSTOP_CHONGTONG_POINTS = 10;

function sideForSeat(seat: number): string {
  return `seat${seat}`;
}

function touch(state: GostopSession): void {
  state.updatedAt = new Date().toISOString();
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? Math.trunc(value) : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, num));
}

function resolveConfig(options: { startingBalance?: unknown; pointValue?: unknown }): GostopConfig {
  const startingBalance = clampInt(options.startingBalance, GOSTOP_DEFAULT_STARTING_BALANCE, 100, 1_000_000_000);
  const pointValue = clampInt(options.pointValue, GOSTOP_DEFAULT_POINT_VALUE, 1, startingBalance);
  return { startingBalance, pointValue };
}

/** 고 보너스: 1고 +1점, 2고 +2점, 3고 이상 최종점수 2^(고수-2) 배. */
export function applyGoBonus(base: number, go: number): number {
  if (go <= 0) {
    return base;
  }
  if (go === 1) {
    return base + 1;
  }
  if (go === 2) {
    return base + 2;
  }
  return base * 2 ** (go - 2);
}

export function gostopThreshold(seatCount: number): number {
  return seatCount === 2 ? 7 : 3;
}

// ---------------------------------------------------------------------------
// 딜 / 판 시작
// ---------------------------------------------------------------------------

interface DealShape {
  handCount: number;
  floorCount: number;
}

function dealShape(seatCount: number): DealShape {
  return seatCount === 2 ? { handCount: 10, floorCount: 8 } : { handCount: 7, floorCount: 6 };
}

function handRngFor(state: GostopSession, salt: string): SeededRng {
  return createSeededRng(`${state.rngSeed ?? ''}#${salt}`);
}

/** 같은 월 카드를 하나의 바닥 스택으로 묶는다(딜 직후 바닥 구성). */
function groupFloor(cards: GostopCard[]): GostopFloorStack[] {
  const byMonth = new Map<number, GostopCard[]>();
  for (const card of cards) {
    const list = byMonth.get(card.month) ?? [];
    list.push(card);
    byMonth.set(card.month, list);
  }
  return [...byMonth.values()].map((stack) => ({ cards: stack }));
}

function hasFourSameMonth(cards: GostopCard[]): number | null {
  const counts = new Map<number, number>();
  for (const card of cards) {
    const next = (counts.get(card.month) ?? 0) + 1;
    counts.set(card.month, next);
    if (next >= 4) {
      return card.month;
    }
  }
  return null;
}

export function createGostopState(
  seats: Array<{ accountId: string }>,
  mode: GameMode,
  options: {
    aiDifficulty?: string;
    seed?: string;
    firstDealer?: number;
    startingBalance?: unknown;
    pointValue?: unknown;
  } = {},
): GostopSession {
  if (seats.length < GOSTOP_MIN_PLAYERS || seats.length > GOSTOP_MAX_PLAYERS) {
    throw new BadRequestException(`gostop requires ${GOSTOP_MIN_PLAYERS}-${GOSTOP_MAX_PLAYERS} players`);
  }
  const seatCount = seats.length;
  const rng = createSeededRng(options.seed);
  const config = resolveConfig(options);
  const players: Record<string, string> = {};
  const seatStatus: Record<string, GostopSeatStatus> = {};
  seats.forEach((seat, index) => {
    players[sideForSeat(index)] = seat.accountId;
    seatStatus[sideForSeat(index)] = 'active';
  });
  const dealer = ((Math.trunc(options.firstDealer ?? 0) % seatCount) + seatCount) % seatCount;
  const state: GostopSession = {
    id: '',
    mode,
    aiDifficulty: options.aiDifficulty,
    rngSeed: rng.seed,
    players,
    seatCount,
    config,
    balances: Array.from({ length: seatCount }, () => config.startingBalance),
    seatStatus,
    dealer,
    roundNumber: 0,
    phase: 'playing',
    currentSeat: dealer,
    currentTurn: sideForSeat(dealer),
    deck: [],
    hands: Array.from({ length: seatCount }, () => []),
    floor: [],
    captures: Array.from({ length: seatCount }, () => []),
    scores: Array.from({ length: seatCount }, () => 0),
    goCount: Array.from({ length: seatCount }, () => 0),
    goScore: Array.from({ length: seatCount }, () => -1),
    shakeCount: Array.from({ length: seatCount }, () => 0),
    bombCount: Array.from({ length: seatCount }, () => 0),
    firstTurnPlayed: false,
    status: 'playing',
    createdAt: '',
    updatedAt: '',
  };
  startGostopRound(state, dealer);
  return state;
}

/** 새 판을 시작한다. 바닥 동월 4장이면 재딜, 손패 동월 4장(총통)이면 즉시 승리. */
export function startGostopRound(state: GostopSession, dealer: number): void {
  state.roundNumber += 1;
  state.dealer = ((dealer % state.seatCount) + state.seatCount) % state.seatCount;
  const shape = dealShape(state.seatCount);

  let attempt = 0;
  let dealt: { hands: GostopCard[][]; floor: GostopCard[]; deck: GostopCard[] } | null = null;
  // 바닥 4장 동월이면 재딜 반복(시드 파생으로 재현성 유지).
  for (attempt = 0; attempt < 50; attempt += 1) {
    const rng = handRngFor(state, `round${state.roundNumber}deal${attempt}`);
    const deck = rng.shuffle(createGostopDeck());
    const floor = deck.slice(0, shape.floorCount);
    const hands: GostopCard[][] = [];
    let cursor = shape.floorCount;
    for (let seat = 0; seat < state.seatCount; seat += 1) {
      hands.push(deck.slice(cursor, cursor + shape.handCount));
      cursor += shape.handCount;
    }
    const rest = deck.slice(cursor);
    if (hasFourSameMonth(floor) !== null) {
      continue; // 바닥 4장 동월 → 재딜
    }
    dealt = { hands, floor, deck: rest };
    break;
  }
  if (!dealt) {
    // 극단적으로 재딜이 반복되면 마지막 시도를 그대로 사용(방어적).
    const rng = handRngFor(state, `round${state.roundNumber}dealfinal`);
    const deck = rng.shuffle(createGostopDeck());
    const floor = deck.slice(0, shape.floorCount);
    const hands: GostopCard[][] = [];
    let cursor = shape.floorCount;
    for (let seat = 0; seat < state.seatCount; seat += 1) {
      hands.push(deck.slice(cursor, cursor + shape.handCount));
      cursor += shape.handCount;
    }
    dealt = { hands, floor, deck: deck.slice(cursor) };
  }

  state.hands = dealt.hands;
  state.floor = groupFloor(dealt.floor);
  state.deck = dealt.deck;
  state.captures = Array.from({ length: state.seatCount }, () => []);
  state.scores = Array.from({ length: state.seatCount }, () => 0);
  state.goCount = Array.from({ length: state.seatCount }, () => 0);
  state.goScore = Array.from({ length: state.seatCount }, () => -1);
  state.shakeCount = Array.from({ length: state.seatCount }, () => 0);
  state.bombCount = Array.from({ length: state.seatCount }, () => 0);
  state.firstTurnPlayed = false;
  state.pendingChoice = undefined;
  state.pending = undefined;
  state.lastPlay = undefined;
  state.goStopSeat = undefined;
  state.phase = 'playing';
  state.currentSeat = state.dealer;
  state.currentTurn = sideForSeat(state.dealer);

  // 총통: 손패 동월 4장 보유 좌석은 즉시 그 판 승리(10점, 배수 없음).
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    if (hasFourSameMonth(state.hands[seat]) !== null) {
      settleGostopChongtong(state, seat);
      return;
    }
  }
  touch(state);
}

// ---------------------------------------------------------------------------
// 실시간 점수
// ---------------------------------------------------------------------------

export function recomputeGostopScores(state: GostopSession): void {
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    state.scores[seat] = scoreGostopCaptures(state.captures[seat]).total;
  }
}

// ---------------------------------------------------------------------------
// 정산
// ---------------------------------------------------------------------------

function activeLosers(state: GostopSession, winnerSeat: number): number[] {
  const losers: number[] = [];
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    if (seat !== winnerSeat && state.seatStatus[sideForSeat(seat)] === 'active') {
      losers.push(seat);
    }
  }
  return losers;
}

/** 총통 즉시 정산(10점, 배수 없음). */
function settleGostopChongtong(state: GostopSession, winnerSeat: number): void {
  const losers = activeLosers(state, winnerSeat);
  const amount = GOSTOP_CHONGTONG_POINTS * state.config.pointValue;
  const amountPerLoser: Record<string, number> = {};
  for (const loser of losers) {
    state.balances[loser] -= amount;
    state.balances[winnerSeat] += amount;
    amountPerLoser[sideForSeat(loser)] = amount;
  }
  state.lastRoundResult = {
    winnerSeat,
    basePoints: GOSTOP_CHONGTONG_POINTS,
    goCount: 0,
    multiplierDetail: { go: 0, shake: 0, bomb: 0, pibak: {}, gwangbak: {}, gobak: null },
    amountPerLoser,
    chongtong: true,
    balancesAfter: [...state.balances],
  };
  finalizeAfterSettle(state, winnerSeat);
}

/** 스톱/승리 시 판 정산: 점수 × 배수(고·흔들기·폭탄·박) × 점당금액을 패자가 지불. */
export function settleGostopRound(state: GostopSession, winnerSeat: number): void {
  const losers = activeLosers(state, winnerSeat);
  const winnerBreakdown = scoreGostopCaptures(state.captures[winnerSeat]);
  const base = applyGoBonus(winnerBreakdown.total, state.goCount[winnerSeat]);
  const shakeMult = 2 ** state.shakeCount[winnerSeat];
  const bombMult = 2 ** state.bombCount[winnerSeat];

  const pibak: Record<string, number> = {};
  const gwangbak: Record<string, number> = {};
  const perLoserBase: Record<number, number> = {};
  for (const loser of losers) {
    const loserBreakdown = scoreGostopCaptures(state.captures[loser]);
    let mult = shakeMult * bombMult;
    if (winnerBreakdown.pi >= 1 && loserBreakdown.piCount >= 1 && loserBreakdown.piCount <= 5) {
      mult *= 2;
      pibak[sideForSeat(loser)] = 2;
    }
    if (winnerBreakdown.gwang >= 1 && loserBreakdown.gwangCount === 0) {
      mult *= 2;
      gwangbak[sideForSeat(loser)] = 2;
    }
    perLoserBase[loser] = base * mult * state.config.pointValue;
  }

  // 고박(독박): 승자가 아닌 좌석 중 고를 부른 사람이 있으면 그가 전액 부담, 다른 패자 면제.
  let gobakSeat: number | null = null;
  for (const loser of losers) {
    if (state.goCount[loser] > 0) {
      gobakSeat = loser;
      break;
    }
  }

  const amountPerLoser: Record<string, number> = {};
  if (gobakSeat !== null) {
    const total = losers.reduce((sum, loser) => sum + perLoserBase[loser], 0);
    for (const loser of losers) {
      const pay = loser === gobakSeat ? total : 0;
      state.balances[loser] -= pay;
      amountPerLoser[sideForSeat(loser)] = pay;
    }
    state.balances[winnerSeat] += total;
  } else {
    for (const loser of losers) {
      const pay = perLoserBase[loser];
      state.balances[loser] -= pay;
      state.balances[winnerSeat] += pay;
      amountPerLoser[sideForSeat(loser)] = pay;
    }
  }

  state.lastRoundResult = {
    winnerSeat,
    basePoints: winnerBreakdown.total,
    goCount: state.goCount[winnerSeat],
    multiplierDetail: {
      go: state.goCount[winnerSeat],
      shake: state.shakeCount[winnerSeat],
      bomb: state.bombCount[winnerSeat],
      pibak,
      gwangbak,
      gobak: gobakSeat,
    },
    amountPerLoser,
    balancesAfter: [...state.balances],
  };
  finalizeAfterSettle(state, winnerSeat);
}

/** 나가리(무승부): 판돈 없음, 선 유지. */
export function settleGostopNagari(state: GostopSession): void {
  state.lastRoundResult = {
    winnerSeat: -1,
    basePoints: 0,
    goCount: 0,
    multiplierDetail: { go: 0, shake: 0, bomb: 0, pibak: {}, gwangbak: {}, gobak: null },
    amountPerLoser: {},
    nagari: true,
    balancesAfter: [...state.balances],
  };
  // 나가리는 승자가 없어 파산 판정 없이 다음 판 대기(선 유지).
  state.phase = 'settled';
  state.goStopSeat = undefined;
  state.pendingChoice = undefined;
  state.pending = undefined;
  state.currentSeat = state.dealer;
  state.currentTurn = sideForSeat(state.dealer);
  touch(state);
}

/** 정산 후 파산 판정 → 세션 종료 또는 settled(다음 판 대기, 선=승자). */
function finalizeAfterSettle(state: GostopSession, winnerSeat: number): void {
  state.pendingChoice = undefined;
  state.pending = undefined;
  state.goStopSeat = undefined;
  const bankrupt = state.balances.some((balance) => balance <= 0);
  if (bankrupt) {
    finishGostopSession(state, 'bankrupt', winnerSeat);
    return;
  }
  state.phase = 'settled';
  state.dealer = winnerSeat;
  state.currentSeat = winnerSeat;
  state.currentTurn = sideForSeat(winnerSeat);
  touch(state);
}

/** 세션 종료: 잔액 최다 보유자가 승자(동률이면 마지막 판 승자 우선). */
export function finishGostopSession(
  state: GostopSession,
  reason: 'opponent_left' | 'bankrupt',
  lastRoundWinner: number,
  excludeSeats: number[] = [],
): void {
  const candidates: number[] = [];
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    if (!excludeSeats.includes(seat)) {
      candidates.push(seat);
    }
  }
  const pool = candidates.length > 0 ? candidates : [...Array(state.seatCount).keys()];
  let winner = pool[0];
  for (const seat of pool.slice(1)) {
    if (state.balances[seat] > state.balances[winner]) {
      winner = seat;
    } else if (state.balances[seat] === state.balances[winner] && seat === lastRoundWinner) {
      winner = seat;
    }
  }
  state.status = 'finished';
  state.phase = 'finished';
  state.finishReason = reason;
  state.gameWinner = {
    seat: winner,
    accountId: state.players[sideForSeat(winner)],
    reason,
    finalBalances: [...state.balances],
  };
  state.winnerSide = sideForSeat(winner);
  state.winnerAccountId = state.players[sideForSeat(winner)];
  state.currentTurn = '';
  touch(state);
}

// ---------------------------------------------------------------------------
// 고/스톱 전이 · 다음 판
// ---------------------------------------------------------------------------

/** 현재 좌석의 턴 종료 후, 임계 점수 이상이며 점수가 증가했으면 go_stop 대기로 전환. */
export function maybeGostopGoStop(state: GostopSession, seat: number): boolean {
  const threshold = gostopThreshold(state.seatCount);
  if (state.scores[seat] >= threshold && state.scores[seat] > state.goScore[seat]) {
    state.phase = 'go_stop';
    state.goStopSeat = seat;
    state.currentSeat = seat;
    state.currentTurn = sideForSeat(seat);
    touch(state);
    return true;
  }
  return false;
}

/** 고 선언: 카운트 증가, 이번 점수 기록, 계속 진행(턴은 다음 좌석으로). */
export function applyGostopGo(state: GostopSession, seat: number): void {
  if (state.phase !== 'go_stop' || state.goStopSeat !== seat) {
    throw new BadRequestException('not eligible to declare go');
  }
  state.goCount[seat] += 1;
  state.goScore[seat] = state.scores[seat];
  state.phase = 'playing';
  state.goStopSeat = undefined;
  passGostopTurn(state, seat);
  touch(state);
}

/** 스톱 선언: 즉시 정산(승자 = 선언자). */
export function applyGostopStop(state: GostopSession, seat: number): void {
  if (state.phase !== 'go_stop' || state.goStopSeat !== seat) {
    throw new BadRequestException('not eligible to declare stop');
  }
  settleGostopRound(state, seat);
}

/** 다음 활성 좌석으로 턴 이동(좌석 순). */
export function passGostopTurn(state: GostopSession, fromSeat: number): void {
  for (let step = 1; step <= state.seatCount; step += 1) {
    const candidate = (fromSeat + step) % state.seatCount;
    if (state.seatStatus[sideForSeat(candidate)] === 'active') {
      state.currentSeat = candidate;
      state.currentTurn = sideForSeat(candidate);
      return;
    }
  }
  state.currentSeat = fromSeat;
  state.currentTurn = sideForSeat(fromSeat);
}

/** 다음 판 진행(phase settled 에서만). */
export function applyGostopNextRound(state: GostopSession): void {
  if (state.phase !== 'settled') {
    throw new BadRequestException('not ready for the next round');
  }
  startGostopRound(state, state.dealer);
  touch(state);
}

/** 이탈/포기 → 세션 즉시 정산·종료(reason opponent_left). 잔액 최다 보유자 승자. */
export function applyGostopForfeit(state: GostopSession, seat: number): void {
  if (state.status === 'finished') {
    return;
  }
  state.seatStatus[sideForSeat(seat)] = 'left';
  const lastWinner = state.lastRoundResult?.winnerSeat ?? state.dealer;
  finishGostopSession(state, 'opponent_left', lastWinner, [seat]);
}

// ---------------------------------------------------------------------------
// viewFor — 히든 정보 필터(손패·더미 은닉)
// ---------------------------------------------------------------------------

interface CaptureView {
  gwang: string[];
  yeol: string[];
  tti: string[];
  pi: string[];
}

function capturesView(cards: GostopCard[]): CaptureView {
  const view: CaptureView = { gwang: [], yeol: [], tti: [], pi: [] };
  for (const card of cards) {
    if (card.kind === 'gwang') {
      view.gwang.push(card.id);
    } else if (card.kind === 'yeol') {
      view.yeol.push(card.id);
    } else if (card.kind === 'tti') {
      view.tti.push(card.id);
    } else {
      view.pi.push(card.id); // pi + ssangpi
    }
  }
  return view;
}

function recordOf<T>(count: number, valueFor: (seat: number) => T): Record<string, T> {
  const record: Record<string, T> = {};
  for (let seat = 0; seat < count; seat += 1) {
    record[sideForSeat(seat)] = valueFor(seat);
  }
  return record;
}

export function gostopViewFor(state: GostopSession, seat: number | 'spectator'): unknown {
  const viewerSeat = typeof seat === 'number' ? seat : -1;
  const view: Record<string, unknown> = {
    id: state.id,
    rev: state.rev,
    gameKey: 'gostop',
    mode: state.mode,
    aiDifficulty: state.aiDifficulty,
    players: state.players,
    seatStatus: state.seatStatus,
    seatCount: state.seatCount,
    config: state.config,
    balances: recordOf(state.seatCount, (s) => state.balances[s]),
    phase: state.phase,
    status: state.status,
    roundNumber: state.roundNumber,
    dealer: state.dealer,
    currentSeat: state.currentSeat,
    currentTurn: state.currentTurn,
    mySeat: viewerSeat >= 0 ? viewerSeat : undefined,
    myHand: viewerSeat >= 0 && state.hands[viewerSeat] ? state.hands[viewerSeat].map((card) => card.id) : [],
    handCounts: recordOf(state.seatCount, (s) => state.hands[s].length),
    floorStacks: state.floor.map((stack) => stack.cards.map((card) => card.id)),
    deckCount: state.deck.length,
    captures: recordOf(state.seatCount, (s) => capturesView(state.captures[s])),
    scores: recordOf(state.seatCount, (s) => state.scores[s]),
    goCount: recordOf(state.seatCount, (s) => state.goCount[s]),
    multipliers: recordOf(state.seatCount, (s) => ({ shake: state.shakeCount[s], bomb: state.bombCount[s] })),
    pendingChoice: state.pendingChoice,
    lastPlay: state.lastPlay,
    goStopSeat: state.goStopSeat,
    lastRoundResult: state.lastRoundResult,
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
// 엔진 계약
// ---------------------------------------------------------------------------

function gostopModeFromConfig(value: unknown): GameMode {
  return value === 'friend_match' || value === 'local_ai' || value === 'solo' ? value : 'local_ai';
}

export const GOSTOP_ENGINE: GameEngine<GostopSession> = {
  descriptor: {
    key: 'gostop',
    title: 'Go-Stop',
    minPlayers: GOSTOP_MIN_PLAYERS,
    maxPlayers: GOSTOP_MAX_PLAYERS,
    modes: ['local_ai', 'friend_match'],
    turnType: 'turnBased',
    hiddenInfo: true,
    supportsAi: true,
    supportsMatchSave: true,
    turnTimerSeconds: GOSTOP_TURN_TIMER_SECONDS,
    status: 'playable',
  },
  stateVersion: GOSTOP_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): GostopSession {
    const seats = players.map((player, index) => ({
      accountId: player.accountId ?? `__game_platform_local_ai__#${index}`,
    }));
    const state = createGostopState(seats, gostopModeFromConfig(config.mode), {
      aiDifficulty: typeof config.aiDifficulty === 'string' ? config.aiDifficulty : undefined,
      seed: typeof config.seed === 'string' ? config.seed : undefined,
      firstDealer: typeof config.firstDealer === 'number' ? config.firstDealer : undefined,
      startingBalance: config.startingBalance,
      pointValue: config.pointValue,
    });
    state.id = typeof config.id === 'string' ? config.id : '';
    return state;
  },
  applyAction(state: GostopSession, seat: number, action: GameAction) {
    if (state.status === 'finished') {
      throw new BadRequestException('gostop session is finished');
    }
    const payload = action.payload ?? {};
    switch (action.type) {
      case 'go':
        applyGostopGo(state, seat);
        break;
      case 'stop':
        applyGostopStop(state, seat);
        break;
      case 'next_round':
        applyGostopNextRound(state);
        break;
      case 'forfeit':
        applyGostopForfeit(state, seat);
        break;
      case 'play_card':
      case 'flip_choice':
        // 턴 상태머신은 C3 에서 구현한다.
        throw new BadRequestException(`gostop action not implemented yet: ${action.type}`);
      default:
        throw new BadRequestException(`unsupported gostop action: ${action.type}`);
    }
    void payload;
    return { state };
  },
  viewFor(state: GostopSession, seat: number | 'spectator') {
    return gostopViewFor(state, seat);
  },
  finishInfo(state: GostopSession) {
    if (state.status !== 'finished') {
      return null;
    }
    return {
      status: 'finished' as const,
      winnerSeat: state.gameWinner?.seat,
      reason: state.finishReason,
    };
  },
  migrate(oldState: unknown): GostopSession {
    return oldState as GostopSession;
  },
};

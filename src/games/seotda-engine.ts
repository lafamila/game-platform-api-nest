import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { createSeededRng, SeededRng } from './engine/rng';
import { Difficulty, GameMode } from './games.types';

/**
 * 섯다(seotda) 엔진 — 2~5인 화투 베팅 게임.
 *
 * 사용자 확정 룰(변경 불가):
 * - 2~5인(room 좌석 + AI 좌석 혼성 가능, local_ai 는 AI 1~4명 상대).
 * - 세션 시작 시 공통 재화를 전원에게 동일 분배(기본 10,000, config 조정 가능).
 * - 연속 판(hand) 진행. 종료 조건 = ① 이탈(forfeit/leave) 또는 ② 핸드 정산 시점 잔액 0 인 플레이어 발생.
 *   → 즉시 잔액 최다 보유자가 세션 승자(동률이면 마지막 핸드 승자 우선). gameWinner 에 reason 과 finalBalances 기록.
 * - 이탈 감지 시 세션을 즉시 정산·종료(reason 'opponent_left').
 *
 * 채택한 표준 룰 기본값(변형 옵션은 서비스 보고서 참조):
 * - 덱 20장(1~10월 × 2). 카드 id 'hwatu_{month}_{1|2}'. index 1 = 광 또는 열끗(8월은 1=광·2=열끗), index 2 = 띠.
 * - 2장 섯다: ante(삥, 기본 100) 전원 → 1장 딜 → 베팅 라운드1 → 1장 딜 → 베팅 라운드2 → 쇼다운.
 * - 베팅 액션: die/check/call/bbing/ddadang/half/allin. 사이드팟 없이 단순화(레이즈 상한 = 활성 플레이어 최소 잔액).
 * - 족보: 광땡 > 땡 > 알리/독사/구삥/장삥/장사/세륙 > 끗수 > 망통. 특수: 암행어사/땡잡이/구사.
 */

export type SeotdaCardKind = 'gwang' | 'yeol' | 'tti';

export interface SeotdaCard {
  id: string; // 'hwatu_{month}_{1|2}'
  month: number; // 1..10
  index: 1 | 2;
  kind: SeotdaCardKind;
}

export type SeotdaCategory =
  | 'gwangttaeng'
  | 'ttaeng'
  | 'special_kkut'
  | 'ansa'
  | 'ttaengjabi'
  | 'gusa'
  | 'kkut'
  | 'mangtong';

export interface SeotdaHandRank {
  category: SeotdaCategory;
  /** 일반(무조건부) 족보 간 선형 비교 점수. 암행어사/땡잡이/구사는 특수 처리. */
  score: number;
  /** 끗수(0~9). 땡잡이 fallback / tie-break 참고용. */
  kkut: number;
  /** 한국어 족보명. */
  label: string;
}

export type SeotdaMove = 'die' | 'check' | 'call' | 'bbing' | 'ddadang' | 'half' | 'allin';
export type SeotdaPhase = 'betting_1' | 'betting_2' | 'showdown' | 'settled' | 'finished';
export type SeotdaSeatStatus = 'active' | 'left' | 'forfeited';

export interface SeotdaConfig {
  startingBalance: number;
  ante: number;
  baseUnit: number;
}

export interface SeotdaLastHandResult {
  handNumber: number;
  winnerSeat: number;
  rankLabel: string;
  potWon: number;
  /** 쇼다운/폴드승 구분. */
  reason: 'showdown' | 'fold_win' | 'gusa_redeal';
  /** 생존자(비폴드) 손패 공개. seat → 카드 id 배열. */
  revealedHands: Record<string, string[]>;
  balances: number[];
}

export interface SeotdaGameWinner {
  seat: number;
  accountId?: string;
  reason: 'opponent_left' | 'bankrupt';
  finalBalances: number[];
}

export interface SeotdaSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: string;
  /** 딜 재현용 base seed(감사 전용). viewFor 에 노출 금지. */
  rngSeed?: string;
  players: Record<string, string>; // seat0.. → accountId
  seatCount: number;
  config: SeotdaConfig;
  balances: number[];
  seatStatus: Record<string, SeotdaSeatStatus>;
  sun: number; // 현재 판의 선(先) 좌석
  handNumber: number;
  phase: SeotdaPhase;
  currentSeat: number;
  currentTurn: string; // `seat${currentSeat}` — DB current_turn 컬럼용

  // 현재 핸드 상태(히든 카드 포함)
  deck: SeotdaCard[]; // 남은 덱(히든). viewFor 에 노출 금지.
  hands: SeotdaCard[][]; // 좌석별 손패(히든). viewFor 로 자기 것만/정산 시 생존자 공개.
  pot: number; // 현재 팟(구사 재경기 시 이월).
  round: 1 | 2;
  currentBet: number; // 이번 라운드 매칭 목표액.
  roundContribution: number[]; // 이번 라운드 좌석별 납입.
  contributions: number[]; // 이번 핸드 좌석별 총 납입(표시용).
  folded: boolean[];
  allin: boolean[];
  needsToAct: boolean[];
  gusaRedealCount: number; // 감사용.

  lastHandResult?: SeotdaLastHandResult;
  gameWinner?: SeotdaGameWinner;
  winnerSide?: string; // 세션 승자 seat side(row winner 컬럼).
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

export const SEOTDA_MIN_PLAYERS = 2;
export const SEOTDA_MAX_PLAYERS = 5;
export const SEOTDA_DEFAULT_STARTING_BALANCE = 10_000;
export const SEOTDA_DEFAULT_ANTE = 100;
export const SEOTDA_STATE_VERSION = 1;
export const SEOTDA_TURN_TIMER_SECONDS = 30;

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// 광 카드가 index 1 에 오는 달(1·3·8). 그 외 달의 index 1 은 열끗.
const GWANG_MONTHS = new Set([1, 3, 8]);

// ---------------------------------------------------------------------------
// 카드 유틸
// ---------------------------------------------------------------------------

function cardKind(month: number, index: 1 | 2): SeotdaCardKind {
  if (index === 1) {
    return GWANG_MONTHS.has(month) ? 'gwang' : 'yeol';
  }
  // index 2: 8월은 열끗, 그 외는 띠.
  return month === 8 ? 'yeol' : 'tti';
}

export function seotdaCardId(month: number, index: 1 | 2): string {
  return `hwatu_${month}_${index}`;
}

function makeCard(month: number, index: 1 | 2): SeotdaCard {
  return { id: seotdaCardId(month, index), month, index, kind: cardKind(month, index) };
}

export function parseSeotdaCardId(id: string): SeotdaCard {
  const match = /^hwatu_(\d{1,2})_(1|2)$/.exec(id);
  if (!match) {
    throw new BadRequestException(`invalid seotda card id: ${id}`);
  }
  const month = Number(match[1]);
  const index = Number(match[2]) as 1 | 2;
  if (!MONTHS.includes(month)) {
    throw new BadRequestException(`invalid seotda card month: ${id}`);
  }
  return makeCard(month, index);
}

export function createSeotdaDeck(): SeotdaCard[] {
  const deck: SeotdaCard[] = [];
  for (const month of MONTHS) {
    deck.push(makeCard(month, 1));
    deck.push(makeCard(month, 2));
  }
  return deck;
}

function sideForSeat(seat: number): string {
  return `seat${seat}`;
}

function hasCard(hand: SeotdaCard[], month: number, index: 1 | 2): boolean {
  return hand.some((card) => card.month === month && card.index === index);
}

// ---------------------------------------------------------------------------
// 족보 평가
// ---------------------------------------------------------------------------

const SPECIAL_KKUT_LABELS: Record<string, { label: string; score: number }> = {
  '1-2': { label: '알리', score: 460 }, // 1·2
  '1-4': { label: '독사', score: 450 }, // 1·4
  '1-9': { label: '구삥', score: 440 }, // 1·9
  '1-10': { label: '장삥', score: 430 }, // 1·10
  '4-10': { label: '장사', score: 420 }, // 4·10
  '4-6': { label: '세륙', score: 410 }, // 4·6
};

function ttaengLabel(month: number): string {
  return month === 10 ? '장땡' : `${month}땡`;
}

function kkutLabel(kkut: number): string {
  if (kkut === 0) {
    return '망통';
  }
  return kkut === 9 ? '갑오' : `${kkut}끗`;
}

/** 두 장의 카드로 섯다 족보를 평가한다. */
export function evaluateSeotdaHand(cards: SeotdaCard[]): SeotdaHandRank {
  if (cards.length !== 2) {
    throw new BadRequestException('seotda hand requires exactly 2 cards');
  }
  const [a, b] = cards;
  const months = [a.month, b.month].sort((x, y) => x - y);
  const kkut = (a.month + b.month) % 10;

  // 구사(4·9): 재경기 특수.
  if (months[0] === 4 && months[1] === 9) {
    return { category: 'gusa', score: 0, kkut, label: '구사' };
  }

  // 암행어사(4월 열끗 + 7월 열끗): 광땡에만 승리, 그 외 최하위.
  if (hasCard(cards, 4, 1) && hasCard(cards, 7, 1)) {
    return { category: 'ansa', score: 0, kkut, label: '암행어사' };
  }

  // 땡잡이(3월 광 + 7월 열끗): 장땡 이하 땡에 승리, 광땡에 패배, 그 외 끗수(0끗)로.
  if (hasCard(cards, 3, 1) && hasCard(cards, 7, 1)) {
    return { category: 'ttaengjabi', score: 0, kkut, label: '땡잡이' };
  }

  // 광땡: 1·3·8 광 카드 조합.
  if (a.kind === 'gwang' && b.kind === 'gwang') {
    const key = `${months[0]}${months[1]}`;
    if (key === '38') {
      return { category: 'gwangttaeng', score: 630, kkut, label: '38광땡' };
    }
    if (key === '18') {
      return { category: 'gwangttaeng', score: 620, kkut, label: '18광땡' };
    }
    if (key === '13') {
      return { category: 'gwangttaeng', score: 610, kkut, label: '13광땡' };
    }
  }

  // 땡: 같은 달 두 장.
  if (a.month === b.month) {
    return { category: 'ttaeng', score: 500 + a.month, kkut, label: ttaengLabel(a.month) };
  }

  // 특수 끗(알리/독사/구삥/장삥/장사/세륙).
  const specialKey = `${months[0]}-${months[1]}`;
  const special = SPECIAL_KKUT_LABELS[specialKey];
  if (special) {
    return { category: 'special_kkut', score: special.score, kkut, label: special.label };
  }

  // 일반 끗수 / 망통.
  if (kkut === 0) {
    return { category: 'mangtong', score: 300, kkut, label: '망통' };
  }
  return { category: 'kkut', score: 300 + kkut, kkut, label: kkutLabel(kkut) };
}

interface ShowdownEntry {
  seat: number;
  rank: SeotdaHandRank;
}

/**
 * 생존자(비폴드) 중 승자를 결정한다.
 * - 구사 보유자가 있으면 재경기(isGusa=true).
 * - 암행어사 존재 시 광땡을 제거(체포)하고, 암행어사는 최하위로 남는다.
 * - 땡잡이 존재 시 땡을 제거하고, 땡잡이는 망통(0끗)으로 취급한다.
 * - 동점(끗수)은 선(先) 우선.
 */
export function resolveSeotdaShowdown(
  entries: ShowdownEntry[],
  sun: number,
  seatCount: number,
): { winnerSeat: number; isGusa: boolean } {
  if (entries.length === 0) {
    return { winnerSeat: -1, isGusa: false };
  }
  if (entries.some((entry) => entry.rank.category === 'gusa')) {
    return { winnerSeat: -1, isGusa: true };
  }
  const hasAnsa = entries.some((entry) => entry.rank.category === 'ansa');
  const hasTtaengjabi = entries.some((entry) => entry.rank.category === 'ttaengjabi');

  const contenders = entries
    .filter((entry) => {
      if (hasAnsa && entry.rank.category === 'gwangttaeng') {
        return false; // 암행어사가 광땡을 체포.
      }
      if (hasTtaengjabi && entry.rank.category === 'ttaeng') {
        return false; // 땡잡이가 땡을 잡음.
      }
      return true;
    })
    .map((entry) => ({ seat: entry.seat, eff: effectiveShowdownScore(entry.rank) }));

  const orderIndex = (seat: number): number => ((seat - sun) % seatCount + seatCount) % seatCount;
  let best = contenders[0];
  for (const contender of contenders.slice(1)) {
    if (
      contender.eff > best.eff ||
      (contender.eff === best.eff && orderIndex(contender.seat) < orderIndex(best.seat))
    ) {
      best = contender;
    }
  }
  return { winnerSeat: best.seat, isGusa: false };
}

function effectiveShowdownScore(rank: SeotdaHandRank): number {
  if (rank.category === 'ansa') {
    return -1; // 광땡이 제거된 뒤에는 최하위. 단독 생존이면 유일 후보로 승리.
  }
  if (rank.category === 'ttaengjabi') {
    return 300; // 망통(0끗) 수준.
  }
  return rank.score;
}

// ---------------------------------------------------------------------------
// 상태 생성 / 딜
// ---------------------------------------------------------------------------

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? Math.trunc(value) : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, num));
}

function resolveConfig(options: {
  startingBalance?: unknown;
  ante?: unknown;
  baseUnit?: unknown;
}): SeotdaConfig {
  const startingBalance = clampInt(options.startingBalance, SEOTDA_DEFAULT_STARTING_BALANCE, 100, 1_000_000_000);
  const ante = clampInt(options.ante, SEOTDA_DEFAULT_ANTE, 1, startingBalance);
  const baseUnit = clampInt(options.baseUnit, ante, 1, startingBalance);
  return { startingBalance, ante, baseUnit };
}

export function createSeotdaState(
  seats: Array<{ accountId: string }>,
  mode: GameMode,
  options: {
    aiDifficulty?: string;
    seed?: string;
    firstSun?: number;
    startingBalance?: unknown;
    ante?: unknown;
    baseUnit?: unknown;
  } = {},
): SeotdaSession {
  if (seats.length < SEOTDA_MIN_PLAYERS || seats.length > SEOTDA_MAX_PLAYERS) {
    throw new BadRequestException(`seotda requires ${SEOTDA_MIN_PLAYERS}-${SEOTDA_MAX_PLAYERS} players`);
  }
  const seatCount = seats.length;
  const rng = createSeededRng(options.seed);
  const config = resolveConfig(options);
  const players: Record<string, string> = {};
  const seatStatus: Record<string, SeotdaSeatStatus> = {};
  seats.forEach((seat, index) => {
    players[sideForSeat(index)] = seat.accountId;
    seatStatus[sideForSeat(index)] = 'active';
  });
  const sun = ((Math.trunc(options.firstSun ?? 0) % seatCount) + seatCount) % seatCount;
  const state: SeotdaSession = {
    id: '',
    mode,
    aiDifficulty: options.aiDifficulty,
    rngSeed: rng.seed,
    players,
    seatCount,
    config,
    balances: Array.from({ length: seatCount }, () => config.startingBalance),
    seatStatus,
    sun,
    handNumber: 0,
    phase: 'betting_1',
    currentSeat: sun,
    currentTurn: sideForSeat(sun),
    deck: [],
    hands: Array.from({ length: seatCount }, () => []),
    pot: 0,
    round: 1,
    currentBet: 0,
    roundContribution: Array.from({ length: seatCount }, () => 0),
    contributions: Array.from({ length: seatCount }, () => 0),
    folded: Array.from({ length: seatCount }, () => false),
    allin: Array.from({ length: seatCount }, () => false),
    needsToAct: Array.from({ length: seatCount }, () => false),
    gusaRedealCount: 0,
    status: 'playing',
    createdAt: '',
    updatedAt: '',
  };
  startSeotdaHand(state, sun);
  return state;
}

function handRngFor(state: SeotdaSession, salt: string): SeededRng {
  return createSeededRng(`${state.rngSeed ?? ''}#${salt}`);
}

/** 새 핸드를 시작한다: ante 납입 → 1장 딜 → betting_1. pot 은 인자로 이월분을 유지한다. */
function startSeotdaHand(state: SeotdaSession, sun: number, carryPot = 0): void {
  state.handNumber += 1;
  state.sun = ((sun % state.seatCount) + state.seatCount) % state.seatCount;
  const rng = handRngFor(state, `hand${state.handNumber}`);
  state.deck = rng.shuffle(createSeotdaDeck());
  state.hands = Array.from({ length: state.seatCount }, () => []);
  state.pot = carryPot;
  state.round = 1;
  state.currentBet = 0;
  state.roundContribution = Array.from({ length: state.seatCount }, () => 0);
  state.contributions = Array.from({ length: state.seatCount }, () => 0);
  state.folded = Array.from({ length: state.seatCount }, () => false);
  state.allin = Array.from({ length: state.seatCount }, () => false);
  state.needsToAct = Array.from({ length: state.seatCount }, () => false);

  // ante(삥) 전원 납입. 잔액 부족 시 있는 만큼(allin).
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    const pay = Math.min(state.config.ante, state.balances[seat]);
    state.balances[seat] -= pay;
    state.contributions[seat] += pay;
    state.pot += pay;
    if (state.balances[seat] <= 0) {
      state.allin[seat] = true;
    }
  }

  // 1장 딜.
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    state.hands[seat].push(state.deck.pop()!);
  }

  beginSeotdaBettingRound(state, 1);
}

function beginSeotdaBettingRound(state: SeotdaSession, round: 1 | 2): void {
  state.round = round;
  state.phase = round === 1 ? 'betting_1' : 'betting_2';
  state.currentBet = 0;
  state.roundContribution = Array.from({ length: state.seatCount }, () => 0);
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    state.needsToAct[seat] = !state.folded[seat] && !state.allin[seat];
  }
  const first = nextBettingSeat(state, state.sun - 1);
  if (first === -1) {
    // 베팅 가능한 좌석이 없음(전원 allin/폴드) → 즉시 라운드 종료 처리.
    completeSeotdaRound(state);
    return;
  }
  state.currentSeat = first;
  state.currentTurn = sideForSeat(first);
  touch(state);
}

function nextBettingSeat(state: SeotdaSession, fromSeat: number): number {
  for (let step = 1; step <= state.seatCount; step += 1) {
    const candidate = ((fromSeat + step) % state.seatCount + state.seatCount) % state.seatCount;
    if (!state.folded[candidate] && !state.allin[candidate] && state.needsToAct[candidate]) {
      return candidate;
    }
  }
  return -1;
}

function activeSeats(state: SeotdaSession): number[] {
  const seats: number[] = [];
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    if (!state.folded[seat]) {
      seats.push(seat);
    }
  }
  return seats;
}

/** 레이즈 상한: 비폴드 좌석의 (이번 라운드 납입 + 잔액) 최소값. 전원 콜 가능 보장(사이드팟 없음). */
function raiseCap(state: SeotdaSession): number {
  let cap = Infinity;
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    if (state.folded[seat]) {
      continue;
    }
    cap = Math.min(cap, state.roundContribution[seat] + state.balances[seat]);
  }
  return Number.isFinite(cap) ? cap : 0;
}

function touch(state: SeotdaSession): void {
  state.updatedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 베팅
// ---------------------------------------------------------------------------

/** 이번 라운드에서 seat 가 낼 수 있는 합법 액션 목록. */
export function seotdaLegalMoves(state: SeotdaSession, seat: number): SeotdaMove[] {
  if (state.phase !== 'betting_1' && state.phase !== 'betting_2') {
    return [];
  }
  if (seat !== state.currentSeat || state.folded[seat] || state.allin[seat]) {
    return [];
  }
  const moves: SeotdaMove[] = [];
  const toCall = state.currentBet - state.roundContribution[seat];
  if (toCall <= 0) {
    moves.push('check');
  } else {
    moves.push('call');
  }
  moves.push('die');
  const cap = raiseCap(state);
  for (const move of ['bbing', 'ddadang', 'half', 'allin'] as SeotdaMove[]) {
    const target = raiseTargetFor(state, seat, move, cap);
    if (target > state.currentBet && target - state.roundContribution[seat] <= state.balances[seat]) {
      moves.push(move);
    }
  }
  return moves;
}

function raiseTargetFor(state: SeotdaSession, seat: number, move: SeotdaMove, cap: number): number {
  const base = state.config.baseUnit;
  let raw: number;
  switch (move) {
    case 'bbing':
      raw = state.currentBet === 0 ? base : state.currentBet + base;
      break;
    case 'ddadang':
      raw = state.currentBet === 0 ? base * 2 : state.currentBet * 2;
      break;
    case 'half':
      raw = state.currentBet + Math.max(base, Math.floor(state.pot / 2));
      break;
    case 'allin':
      raw = state.roundContribution[seat] + state.balances[seat];
      break;
    default:
      raw = 0;
  }
  return Math.min(raw, cap);
}

function applySeotdaBet(state: SeotdaSession, seat: number, move: SeotdaMove): void {
  if (state.phase !== 'betting_1' && state.phase !== 'betting_2') {
    throw new BadRequestException('not in a betting phase');
  }
  if (seat !== state.currentSeat) {
    throw new BadRequestException('not your turn to bet');
  }
  if (state.folded[seat] || state.allin[seat]) {
    throw new BadRequestException('seat cannot act');
  }
  const toCall = state.currentBet - state.roundContribution[seat];

  if (move === 'die') {
    state.folded[seat] = true;
    state.needsToAct[seat] = false;
    afterSeotdaBet(state, seat);
    return;
  }

  if (move === 'check') {
    if (toCall > 0) {
      throw new BadRequestException('cannot check facing a bet');
    }
    state.needsToAct[seat] = false;
    afterSeotdaBet(state, seat);
    return;
  }

  if (move === 'call') {
    if (toCall <= 0) {
      throw new BadRequestException('nothing to call');
    }
    const pay = Math.min(toCall, state.balances[seat]);
    commit(state, seat, pay);
    if (state.balances[seat] <= 0) {
      state.allin[seat] = true; // 잔액 부족 콜 = 올인 콜.
    }
    state.needsToAct[seat] = false;
    afterSeotdaBet(state, seat);
    return;
  }

  // 레이즈 계열(bbing/ddadang/half/allin).
  const cap = raiseCap(state);
  const target = raiseTargetFor(state, seat, move, cap);
  if (target <= state.currentBet) {
    throw new BadRequestException(`illegal raise: ${move}`);
  }
  const pay = target - state.roundContribution[seat];
  if (pay > state.balances[seat]) {
    throw new BadRequestException(`illegal raise: insufficient balance for ${move}`);
  }
  commit(state, seat, pay);
  state.currentBet = target;
  if (state.balances[seat] <= 0) {
    state.allin[seat] = true;
  }
  // 레이즈 → 나머지 베팅 가능 좌석은 다시 액션해야 함.
  for (let other = 0; other < state.seatCount; other += 1) {
    state.needsToAct[other] = other !== seat && !state.folded[other] && !state.allin[other];
  }
  afterSeotdaBet(state, seat);
}

function commit(state: SeotdaSession, seat: number, amount: number): void {
  const pay = Math.max(0, Math.min(amount, state.balances[seat]));
  state.balances[seat] -= pay;
  state.roundContribution[seat] += pay;
  state.contributions[seat] += pay;
  state.pot += pay;
}

function afterSeotdaBet(state: SeotdaSession, seat: number): void {
  // 폴드로 1명만 남으면 즉시 팟 획득.
  const survivors = activeSeats(state);
  if (survivors.length <= 1) {
    settleSeotdaHand(state, survivors[0] ?? seat, 'fold_win');
    return;
  }
  // 라운드 종료 판단: 베팅 가능 좌석 중 액션 필요한 좌석이 없으면 종료.
  const pending = nextBettingSeat(state, seat);
  if (pending === -1) {
    completeSeotdaRound(state);
    return;
  }
  state.currentSeat = pending;
  state.currentTurn = sideForSeat(pending);
  touch(state);
}

function completeSeotdaRound(state: SeotdaSession): void {
  if (state.round === 1) {
    // 2장째 딜 후 라운드2.
    for (let seat = 0; seat < state.seatCount; seat += 1) {
      if (!state.folded[seat]) {
        state.hands[seat].push(state.deck.pop()!);
      }
    }
    beginSeotdaBettingRound(state, 2);
    return;
  }
  // 라운드2 종료 → 쇼다운.
  seotdaShowdown(state);
}

// ---------------------------------------------------------------------------
// 쇼다운 / 정산
// ---------------------------------------------------------------------------

function seotdaShowdown(state: SeotdaSession): void {
  state.phase = 'showdown';
  const survivors = activeSeats(state);
  if (survivors.length <= 1) {
    settleSeotdaHand(state, survivors[0] ?? state.sun, 'fold_win');
    return;
  }
  const entries: ShowdownEntry[] = survivors.map((seat) => ({
    seat,
    rank: evaluateSeotdaHand(state.hands[seat]),
  }));
  const result = resolveSeotdaShowdown(entries, state.sun, state.seatCount);
  if (result.isGusa) {
    // 구사: 남은 참가자 전원 재경기, 팟 이월.
    redealSeotdaForGusa(state);
    return;
  }
  settleSeotdaHand(state, result.winnerSeat, 'showdown');
}

function redealSeotdaForGusa(state: SeotdaSession): void {
  state.gusaRedealCount += 1;
  const carry = state.pot;
  const survivorHands: Record<string, string[]> = {};
  for (const seat of activeSeats(state)) {
    survivorHands[sideForSeat(seat)] = state.hands[seat].map((card) => card.id);
  }
  state.lastHandResult = {
    handNumber: state.handNumber,
    winnerSeat: -1,
    rankLabel: '구사',
    potWon: 0,
    reason: 'gusa_redeal',
    revealedHands: survivorHands,
    balances: [...state.balances],
  };
  // seed 파생으로 재현성 유지.
  const rng = handRngFor(state, `hand${state.handNumber}gusa${state.gusaRedealCount}`);
  state.deck = rng.shuffle(createSeotdaDeck());
  state.hands = Array.from({ length: state.seatCount }, () => []);
  state.round = 1;
  state.currentBet = 0;
  state.roundContribution = Array.from({ length: state.seatCount }, () => 0);
  state.contributions = Array.from({ length: state.seatCount }, () => 0);
  state.folded = Array.from({ length: state.seatCount }, () => false);
  state.allin = Array.from({ length: state.seatCount }, () => false);
  state.needsToAct = Array.from({ length: state.seatCount }, () => false);
  // 재경기 ante 재납입(팟은 이월된 상태에서 추가).
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    const pay = Math.min(state.config.ante, state.balances[seat]);
    state.balances[seat] -= pay;
    state.contributions[seat] += pay;
    state.pot += pay;
    if (state.balances[seat] <= 0) {
      state.allin[seat] = true;
    }
  }
  state.pot = Math.max(state.pot, carry); // 방어적: 이월 보존.
  for (let seat = 0; seat < state.seatCount; seat += 1) {
    state.hands[seat].push(state.deck.pop()!);
  }
  beginSeotdaBettingRound(state, 1);
}

function settleSeotdaHand(state: SeotdaSession, winnerSeat: number, reason: 'showdown' | 'fold_win'): void {
  const survivors = activeSeats(state);
  const potWon = state.pot;
  state.balances[winnerSeat] += potWon;
  state.pot = 0;

  const revealedHands: Record<string, string[]> = {};
  if (reason === 'showdown') {
    for (const seat of survivors) {
      revealedHands[sideForSeat(seat)] = state.hands[seat].map((card) => card.id);
    }
  } else {
    // 폴드승: 승자 손패만 공개.
    revealedHands[sideForSeat(winnerSeat)] = state.hands[winnerSeat].map((card) => card.id);
  }
  const rankLabel = reason === 'showdown'
    ? evaluateSeotdaHand(state.hands[winnerSeat]).label
    : '몰수승';
  state.lastHandResult = {
    handNumber: state.handNumber,
    winnerSeat,
    rankLabel,
    potWon,
    reason,
    revealedHands,
    balances: [...state.balances],
  };

  // 파산 판정: 정산 시점에 잔액 0 인 플레이어 발생 → 세션 종료.
  const bankrupt = state.balances.some((balance) => balance <= 0);
  if (bankrupt) {
    finishSeotdaSession(state, 'bankrupt', winnerSeat);
    return;
  }
  state.phase = 'settled';
  // 다음 판 선 = 직전 승자.
  state.sun = winnerSeat;
  state.currentSeat = winnerSeat;
  state.currentTurn = sideForSeat(winnerSeat);
  touch(state);
}

/** 세션 종료: 잔액 최다 보유자가 승자(동률이면 마지막 핸드 승자 우선). */
function finishSeotdaSession(
  state: SeotdaSession,
  reason: 'opponent_left' | 'bankrupt',
  lastHandWinner: number,
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
    } else if (state.balances[seat] === state.balances[winner]) {
      // 동률 → 마지막 핸드 승자 우선.
      if (seat === lastHandWinner) {
        winner = seat;
      }
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

/** 다음 판으로 진행(phase settled 에서만). */
function applySeotdaNextHand(state: SeotdaSession): void {
  if (state.phase !== 'settled') {
    throw new BadRequestException('not ready for the next hand');
  }
  startSeotdaHand(state, state.sun, 0);
  touch(state);
}

/**
 * 이탈/포기 → 세션 즉시 정산·종료(reason opponent_left). 잔액 최다 보유자 승자.
 * 이탈 좌석은 승자 후보에서 제외한다.
 */
export function applySeotdaForfeit(state: SeotdaSession, seat: number): void {
  if (state.status === 'finished') {
    return;
  }
  state.seatStatus[sideForSeat(seat)] = 'left';
  const lastWinner = state.lastHandResult?.winnerSeat ?? state.sun;
  finishSeotdaSession(state, 'opponent_left', lastWinner, [seat]);
}

// ---------------------------------------------------------------------------
// viewFor — 히든 정보 필터
// ---------------------------------------------------------------------------

export function seotdaViewFor(state: SeotdaSession, seat: number | 'spectator'): unknown {
  const viewerSeat = typeof seat === 'number' ? seat : -1;
  const revealed = revealedHandsForView(state);
  const view: Record<string, unknown> = {
    id: state.id,
    rev: state.rev,
    gameKey: 'seotda',
    mode: state.mode,
    aiDifficulty: state.aiDifficulty,
    players: state.players,
    seatStatus: state.seatStatus,
    seatCount: state.seatCount,
    config: state.config,
    balances: state.balances,
    pot: state.pot,
    phase: state.phase,
    status: state.status,
    handNumber: state.handNumber,
    sun: state.sun,
    round: state.round,
    currentSeat: state.currentSeat,
    currentTurn: state.currentTurn,
    currentBet: state.currentBet,
    roundContribution: state.roundContribution,
    contributions: state.contributions,
    folded: state.folded,
    allin: state.allin,
    handCounts: state.hands.map((hand) => hand.length),
    mySeat: viewerSeat >= 0 ? viewerSeat : undefined,
    myHand: viewerSeat >= 0 && state.hands[viewerSeat] ? state.hands[viewerSeat].map((card) => card.id) : [],
    revealedHands: revealed,
    lastHandResult: state.lastHandResult,
    turnStartedAt: state.turnStartedAt,
    turnDeadlineAt: state.turnDeadlineAt,
    pause: state.pause,
    finishReason: state.finishReason,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
  if ((state.phase === 'betting_1' || state.phase === 'betting_2') && viewerSeat === state.currentSeat) {
    view.legalMoves = seotdaLegalMoves(state, viewerSeat);
  }
  if (state.status === 'finished') {
    view.gameWinner = state.gameWinner;
    view.winnerSide = state.winnerSide;
    view.winnerAccountId = state.winnerAccountId;
  }
  return view;
}

/** 정산/쇼다운 시 생존자 손패를 공개한다. 진행 중에는 lastHandResult 의 공개분만 노출. */
function revealedHandsForView(state: SeotdaSession): Record<string, string[]> {
  if ((state.phase === 'settled' || state.phase === 'finished') && state.lastHandResult) {
    return state.lastHandResult.revealedHands;
  }
  return {};
}

// ---------------------------------------------------------------------------
// AI (룰베이스, 합법 액션 보장 우선)
// ---------------------------------------------------------------------------

/** 손패 강도 추정치(0~1). 1장만 있을 때는 카드 잠재력으로 근사한다. */
function estimateSeotdaStrength(cards: SeotdaCard[]): number {
  if (cards.length >= 2) {
    const rank = evaluateSeotdaHand(cards);
    return normalizedRankStrength(rank);
  }
  if (cards.length === 1) {
    return singleCardPotential(cards[0]);
  }
  return 0.1;
}

function normalizedRankStrength(rank: SeotdaHandRank): number {
  switch (rank.category) {
    case 'gwangttaeng':
      return 1;
    case 'ansa':
      return 0.55; // 광땡이 있을 때만 강함 — 중간값.
    case 'ttaengjabi':
      return 0.6;
    case 'ttaeng':
      return Math.min(0.97, 0.78 + (rank.score - 500) * 0.02);
    case 'special_kkut':
      return 0.55 + (rank.score - 410) * 0.0006;
    case 'kkut':
      return 0.2 + rank.kkut * 0.035;
    case 'mangtong':
      return 0.05;
    case 'gusa':
      return 0.4;
    default:
      return 0.2;
  }
}

function singleCardPotential(card: SeotdaCard): number {
  // 광/열끗이 조금 더 잠재력이 높다고 근사.
  let base = 0.35 + card.month * 0.015;
  if (card.kind === 'gwang') {
    base += 0.12;
  } else if (card.kind === 'yeol') {
    base += 0.05;
  }
  return Math.max(0.2, Math.min(0.7, base));
}

function seotdaAiNoise(state: SeotdaSession, seat: number, salt: string): number {
  const source = [
    state.rngSeed ?? state.id,
    seat,
    salt,
    state.handNumber,
    state.round,
    state.phase,
    state.currentBet,
    state.pot,
  ].join('|');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function chooseSeotdaAiMove(state: SeotdaSession, seat: number, difficulty: Difficulty): GameAction {
  if (state.phase === 'settled') {
    return { type: 'next_hand' };
  }
  const legal = seotdaLegalMoves(state, seat);
  if (legal.length === 0) {
    throw new BadRequestException('seotda has no legal AI move');
  }
  const strength = estimateSeotdaStrength(state.hands[seat]);
  const noise = seotdaAiNoise(state, seat, 'move');
  const toCall = state.currentBet - state.roundContribution[seat];

  // 위협(콜 필요액)이 팟 대비 얼마나 큰지.
  const pressure = toCall <= 0 ? 0 : Math.min(1, toCall / Math.max(state.config.baseUnit, state.pot));

  const foldThreshold =
    difficulty === 'hard' ? 0.22 : difficulty === 'medium' ? 0.3 : 0.42;
  const raiseThreshold =
    difficulty === 'hard' ? 0.62 : difficulty === 'medium' ? 0.72 : 0.85;

  // 약한 손 + 콜 압박 → die (체크 가능하면 체크).
  const effectiveStrength = strength - pressure * 0.35;
  if (toCall > 0 && effectiveStrength < foldThreshold && noise > 0.15) {
    return legal.includes('die') ? { type: 'bet', payload: { move: 'die' } } : { type: 'bet', payload: { move: legal[0] } };
  }
  if (toCall <= 0 && effectiveStrength < foldThreshold * 0.6 && legal.includes('check')) {
    return { type: 'bet', payload: { move: 'check' } };
  }

  // 강한 손 → 레이즈.
  const bluff = difficulty === 'hard' && noise < 0.14; // hard 는 가끔 블러핑.
  if ((effectiveStrength >= raiseThreshold || bluff)) {
    const raise = preferredRaise(legal, state, difficulty, noise);
    if (raise) {
      return { type: 'bet', payload: { move: raise } };
    }
  }

  // 기본: 콜 또는 체크.
  if (toCall <= 0 && legal.includes('check')) {
    return { type: 'bet', payload: { move: 'check' } };
  }
  if (legal.includes('call')) {
    return { type: 'bet', payload: { move: 'call' } };
  }
  return { type: 'bet', payload: { move: legal.includes('check') ? 'check' : legal[0] } };
}

function preferredRaise(
  legal: SeotdaMove[],
  state: SeotdaSession,
  difficulty: Difficulty,
  noise: number,
): SeotdaMove | undefined {
  const order: SeotdaMove[] =
    difficulty === 'hard'
      ? noise < 0.3
        ? ['half', 'ddadang', 'bbing']
        : ['ddadang', 'half', 'bbing']
      : difficulty === 'medium'
        ? ['bbing', 'ddadang', 'half']
        : ['bbing'];
  for (const move of order) {
    if (legal.includes(move)) {
      return move;
    }
  }
  return legal.includes('allin') && difficulty === 'hard' && noise < 0.05 ? 'allin' : undefined;
}

// ---------------------------------------------------------------------------
// 엔진 계약
// ---------------------------------------------------------------------------

function seotdaModeFromConfig(value: unknown): GameMode {
  return value === 'friend_match' || value === 'local_ai' || value === 'solo' ? value : 'local_ai';
}

export const SEOTDA_ENGINE: GameEngine<SeotdaSession> = {
  descriptor: {
    key: 'seotda',
    title: 'Seotda',
    minPlayers: SEOTDA_MIN_PLAYERS,
    maxPlayers: SEOTDA_MAX_PLAYERS,
    modes: ['local_ai', 'friend_match'],
    turnType: 'turnBased',
    hiddenInfo: true,
    supportsAi: true,
    supportsMatchSave: true,
    turnTimerSeconds: SEOTDA_TURN_TIMER_SECONDS,
    status: 'playable',
  },
  stateVersion: SEOTDA_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): SeotdaSession {
    const seats = players.map((player, index) => ({
      accountId: player.accountId ?? `__game_platform_local_ai__#${index}`,
    }));
    const state = createSeotdaState(seats, seotdaModeFromConfig(config.mode), {
      aiDifficulty: typeof config.aiDifficulty === 'string' ? config.aiDifficulty : undefined,
      seed: typeof config.seed === 'string' ? config.seed : undefined,
      firstSun: typeof config.firstSun === 'number' ? config.firstSun : undefined,
      startingBalance: config.startingBalance,
      ante: config.ante,
      baseUnit: config.baseUnit,
    });
    state.id = typeof config.id === 'string' ? config.id : '';
    return state;
  },
  applyAction(state: SeotdaSession, seat: number, action: GameAction) {
    if (state.status === 'finished') {
      throw new BadRequestException('seotda session is finished');
    }
    const payload = action.payload ?? {};
    switch (action.type) {
      case 'bet': {
        const move = payload.move;
        if (!isSeotdaMove(move)) {
          throw new BadRequestException('invalid seotda move');
        }
        applySeotdaBet(state, seat, move);
        break;
      }
      case 'next_hand':
        applySeotdaNextHand(state);
        break;
      case 'forfeit':
        applySeotdaForfeit(state, seat);
        break;
      default:
        throw new BadRequestException(`unsupported seotda action: ${action.type}`);
    }
    return { state };
  },
  viewFor(state: SeotdaSession, seat: number | 'spectator') {
    return seotdaViewFor(state, seat);
  },
  finishInfo(state: SeotdaSession) {
    if (state.status !== 'finished') {
      return null;
    }
    return {
      status: 'finished' as const,
      winnerSeat: state.gameWinner?.seat,
      reason: state.finishReason,
    };
  },
  aiAction(state: SeotdaSession, seat: number, difficulty: Difficulty): GameAction {
    return chooseSeotdaAiMove(state, seat, difficulty);
  },
  migrate(oldState: unknown): SeotdaSession {
    return oldState as SeotdaSession;
  },
};

function isSeotdaMove(value: unknown): value is SeotdaMove {
  return (
    value === 'die' ||
    value === 'check' ||
    value === 'call' ||
    value === 'bbing' ||
    value === 'ddadang' ||
    value === 'half' ||
    value === 'allin'
  );
}

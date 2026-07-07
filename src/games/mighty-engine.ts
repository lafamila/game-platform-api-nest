import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { createSeededRng } from './engine/rng';
import { Difficulty, GameMode } from './games.types';

/**
 * 표준 5인 마이티(Mighty) 엔진.
 *
 * 채택한 표준 룰(지방룰 변형은 서비스 보고서의 옵션 목록 참조 — root plan D17):
 * - 53장(트럼프 52 + 조커 1). 10장×5 배분 + 키티 3장.
 * - 마이티: 기본 스페이드 A. 기루다가 스페이드면 다이아몬드 A.
 * - 조커콜: 기본 클로버 3. 기루다가 클로버면 스페이드 3. 초구/막장(첫/마지막 트릭)에는 효력 없음.
 * - 조커: 마이티 다음으로 강함. 첫 트릭/마지막 트릭에는 효력 없음. 조커콜로 리드되면 조커는 강제 소환되고 효력을 잃는다.
 * - 비딩: 무늬 최저 13, 노기루다 최저 12. 같은 수면 노기루다가 우선. 전원 무공약이면 재딜(유찰).
 * - 점수카드: 각 무늬의 A/K/Q/J/10 = 20장(각 1점). 조커/2~9 는 점수 아님.
 * - 키티에 버린 점수카드는 주공 팀 점수로 인정한다(옵션).
 * - 마이티/조커는 무늬 따르기(팔로우) 면제.
 */

export type MightySuit = 'S' | 'D' | 'H' | 'C';
export type MightyTrump = MightySuit | 'notrump';
export type MightyPhase = 'bidding' | 'kitty' | 'friend' | 'playing' | 'finished';

export interface MightyCard {
  suit: MightySuit | 'JOKER';
  rank: number; // 2~14 (11=J,12=Q,13=K,14=A). 조커는 0.
}

export interface MightyBid {
  seat: number;
  count: number;
  trump: MightyTrump;
}

export interface MightyTrickPlay {
  seat: number;
  card: MightyCard;
}

export interface MightyTrick {
  leadSeat: number;
  plays: MightyTrickPlay[];
  winnerSeat: number;
  points: number;
}

export interface MightyFriend {
  type: 'card' | 'first_trick' | 'none';
  card?: MightyCard;
  seat?: number; // 내부 진실원본(프렌드 카드 보유 좌석). 공개 전까지 viewFor 에 노출 금지.
  revealed: boolean;
}

export type MightySeatStatus = 'active' | 'left' | 'forfeited';

export interface MightySession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: string;
  /** 딜 재현용 시드(감사 전용). viewFor 에 노출 금지. */
  rngSeed?: string;
  players: Record<string, string>; // seat0..seat4 → accountId
  seatCount: number;
  currentTurn: string; // `seat${currentSeat}` — DB current_turn 컬럼/조회용
  currentSeat: number;
  phase: MightyPhase;
  hands: MightyCard[][]; // 좌석별 손패(히든). viewFor 로 자기 것만 노출.
  kitty: MightyCard[]; // 키티(히든). 교환 단계의 주공만 열람.
  buriedCards: MightyCard[]; // 주공이 버린 3장(히든). 종료 시 공개.
  dealCount: number; // 재딜 횟수(감사)
  // 비딩
  bids: MightyBid[]; // 비딩 히스토리(공개)
  highestBid?: MightyBid;
  passedSeats: number[];
  firstBidder: number;
  // 확정
  declarerSeat?: number;
  trump?: MightyTrump;
  bidCount?: number;
  friend?: MightyFriend;
  // 플레이
  totalTricks: number;
  tricks: MightyTrick[];
  currentTrick: { leadSeat: number; plays: MightyTrickPlay[] };
  capturedPoints: number[]; // 좌석별 획득 점수카드 수
  // 결과
  declarerTeamPoints?: number;
  success?: boolean;
  scores?: number[]; // 좌석별 게임 점수 증감(제로섬)
  winnerTeam?: 'declarer' | 'defenders';
  winnerSeats?: number[];
  winnerSide?: string;
  winnerAccountId?: string;
  seatStatus?: Record<string, MightySeatStatus>;
  status: 'playing' | 'finished';
  finishReason?: string;
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  pause?: { active: boolean; requestedByAccountId?: string; startedAt?: string; resumableAt?: string; counts?: Record<string, number> };
  roomId?: string;
  roomCode?: string;
  roomMode?: 'multi_player';
  roomPlayers?: Array<{ seat: number; accountId: string; kind: 'account' | 'ai'; status: string; aiDifficulty?: Difficulty }>;
  recentClientMoves?: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

export const MIGHTY_SEAT_COUNT = 5;
export const MIGHTY_HAND_SIZE = 10;
export const MIGHTY_KITTY_SIZE = 3;
export const MIGHTY_TOTAL_TRICKS = 10;
export const MIGHTY_TOTAL_POINT_CARDS = 20;
export const MIGHTY_MIN_SUIT_BID = 13;
export const MIGHTY_MIN_NOTRUMP_BID = 12;
export const MIGHTY_MAX_BID = 20;
export const MIGHTY_STATE_VERSION = 1;

const SUITS: MightySuit[] = ['S', 'D', 'H', 'C'];
const POINT_RANKS = new Set([10, 11, 12, 13, 14]);

// ---------------------------------------------------------------------------
// 카드 유틸
// ---------------------------------------------------------------------------

export function mightyCardId(card: MightyCard): string {
  return card.suit === 'JOKER' ? 'JOKER' : `${card.suit}${card.rank}`;
}

export function parseMightyCardId(id: string): MightyCard {
  if (id === 'JOKER') {
    return { suit: 'JOKER', rank: 0 };
  }
  const suit = id[0] as MightySuit;
  const rank = Number(id.slice(1));
  if (!SUITS.includes(suit) || !Number.isInteger(rank) || rank < 2 || rank > 14) {
    throw new BadRequestException(`invalid card id: ${id}`);
  }
  return { suit, rank };
}

function isJoker(card: MightyCard): boolean {
  return card.suit === 'JOKER';
}

function sameCard(a: MightyCard, b: MightyCard): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

export function isMightyPointCard(card: MightyCard): boolean {
  return card.suit !== 'JOKER' && POINT_RANKS.has(card.rank);
}

export function mightyCardFor(trump: MightyTrump | undefined): MightyCard {
  // 마이티는 스페이드 A. 기루다가 스페이드면 다이아몬드 A.
  return trump === 'S' ? { suit: 'D', rank: 14 } : { suit: 'S', rank: 14 };
}

export function jokerCallCardFor(trump: MightyTrump | undefined): MightyCard {
  // 조커콜은 클로버 3. 기루다가 클로버면 스페이드 3.
  return trump === 'C' ? { suit: 'S', rank: 3 } : { suit: 'C', rank: 3 };
}

function createDeck(): MightyCard[] {
  const deck: MightyCard[] = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank += 1) {
      deck.push({ suit, rank });
    }
  }
  deck.push({ suit: 'JOKER', rank: 0 });
  return deck;
}

function sideForSeat(seat: number): string {
  return `seat${seat}`;
}

// ---------------------------------------------------------------------------
// 상태 생성 / 딜
// ---------------------------------------------------------------------------

export function createMightyState(
  seats: Array<{ accountId: string }>,
  mode: GameMode,
  options: { aiDifficulty?: string; seed?: string; firstBidder?: number } = {},
): MightySession {
  if (seats.length !== MIGHTY_SEAT_COUNT) {
    throw new BadRequestException('mighty requires exactly 5 players');
  }
  const rng = createSeededRng(options.seed);
  const players: Record<string, string> = {};
  const seatStatus: Record<string, MightySeatStatus> = {};
  seats.forEach((seat, index) => {
    players[sideForSeat(index)] = seat.accountId;
    seatStatus[sideForSeat(index)] = 'active';
  });
  const firstBidder = clampSeat(options.firstBidder ?? 0);
  const state: MightySession = {
    id: '',
    mode,
    aiDifficulty: options.aiDifficulty,
    rngSeed: rng.seed,
    players,
    seatCount: MIGHTY_SEAT_COUNT,
    currentTurn: sideForSeat(firstBidder),
    currentSeat: firstBidder,
    phase: 'bidding',
    hands: [],
    kitty: [],
    buriedCards: [],
    dealCount: 0,
    bids: [],
    passedSeats: [],
    firstBidder,
    totalTricks: MIGHTY_TOTAL_TRICKS,
    tricks: [],
    currentTrick: { leadSeat: firstBidder, plays: [] },
    capturedPoints: [0, 0, 0, 0, 0],
    seatStatus,
    status: 'playing',
    createdAt: '',
    updatedAt: '',
  };
  dealMightyHands(state, rng);
  return state;
}

function dealMightyHands(state: MightySession, rng: ReturnType<typeof createSeededRng>): void {
  const deck = rng.shuffle(createDeck());
  const hands: MightyCard[][] = [[], [], [], [], []];
  for (let i = 0; i < MIGHTY_HAND_SIZE * MIGHTY_SEAT_COUNT; i += 1) {
    hands[i % MIGHTY_SEAT_COUNT].push(deck[i]);
  }
  state.hands = hands.map((hand) => sortMightyHand(hand));
  state.kitty = deck.slice(MIGHTY_HAND_SIZE * MIGHTY_SEAT_COUNT);
}

function redealMighty(state: MightySession): void {
  // 유찰 → 같은 좌석 구성으로 재딜. 시드는 파생시켜 재현성을 유지한다.
  const rng = createSeededRng(`${state.rngSeed ?? ''}#redeal${state.dealCount + 1}`);
  state.rngSeed = rng.seed;
  state.dealCount += 1;
  state.bids = [];
  state.highestBid = undefined;
  state.passedSeats = [];
  state.currentSeat = state.firstBidder;
  state.currentTurn = sideForSeat(state.firstBidder);
  state.phase = 'bidding';
  dealMightyHands(state, rng);
  touch(state);
}

function sortMightyHand(hand: MightyCard[]): MightyCard[] {
  const suitOrder: Record<string, number> = { S: 0, D: 1, H: 2, C: 3, JOKER: 4 };
  return [...hand].sort((a, b) => {
    if (a.suit !== b.suit) {
      return suitOrder[a.suit] - suitOrder[b.suit];
    }
    return b.rank - a.rank;
  });
}

function clampSeat(seat: number): number {
  const value = Math.trunc(seat);
  return Number.isFinite(value) ? ((value % MIGHTY_SEAT_COUNT) + MIGHTY_SEAT_COUNT) % MIGHTY_SEAT_COUNT : 0;
}

function touch(state: MightySession): void {
  state.updatedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 비딩
// ---------------------------------------------------------------------------

function isValidTrump(value: unknown): value is MightyTrump {
  return value === 'notrump' || (typeof value === 'string' && (SUITS as string[]).includes(value));
}

function minBidForTrump(trump: MightyTrump): number {
  return trump === 'notrump' ? MIGHTY_MIN_NOTRUMP_BID : MIGHTY_MIN_SUIT_BID;
}

export function mightyBidBeats(next: { count: number; trump: MightyTrump }, current?: MightyBid): boolean {
  if (!current) {
    return true;
  }
  if (next.count > current.count) {
    return true;
  }
  if (next.count === current.count) {
    return next.trump === 'notrump' && current.trump !== 'notrump';
  }
  return false;
}

function nextBidderSeat(state: MightySession, fromSeat: number): number {
  for (let step = 1; step <= MIGHTY_SEAT_COUNT; step += 1) {
    const candidate = (fromSeat + step) % MIGHTY_SEAT_COUNT;
    if (!state.passedSeats.includes(candidate)) {
      return candidate;
    }
  }
  return fromSeat;
}

function applyMightyBid(
  state: MightySession,
  seat: number,
  input: { pass?: boolean; count?: number; trump?: MightyTrump },
): void {
  if (state.phase !== 'bidding') {
    throw new BadRequestException('not in bidding phase');
  }
  if (seat !== state.currentSeat) {
    throw new BadRequestException('not your turn to bid');
  }
  if (input.pass) {
    if (!state.passedSeats.includes(seat)) {
      state.passedSeats.push(seat);
    }
    state.bids.push({ seat, count: 0, trump: 'notrump' });
  } else {
    const trump = input.trump;
    const count = Math.trunc(Number(input.count));
    if (!isValidTrump(trump)) {
      throw new BadRequestException('invalid trump');
    }
    if (!Number.isInteger(count) || count < minBidForTrump(trump) || count > MIGHTY_MAX_BID) {
      throw new BadRequestException(`bid must be between ${minBidForTrump(trump)} and ${MIGHTY_MAX_BID}`);
    }
    if (!mightyBidBeats({ count, trump }, state.highestBid)) {
      throw new BadRequestException('bid must beat the current highest bid');
    }
    const bid: MightyBid = { seat, count, trump };
    state.highestBid = bid;
    state.bids.push(bid);
  }

  const activeBidders = allSeats().filter((s) => !state.passedSeats.includes(s));
  if (!state.highestBid) {
    // 아직 아무 공약 없음. 전원 패스면 유찰 → 재딜.
    if (state.passedSeats.length >= MIGHTY_SEAT_COUNT) {
      redealMighty(state);
      return;
    }
    state.currentSeat = nextBidderSeat(state, seat);
    state.currentTurn = sideForSeat(state.currentSeat);
    touch(state);
    return;
  }
  if (activeBidders.length <= 1) {
    // 최고 공약자만 남음 → 주공 확정, 키티 단계로.
    beginMightyKitty(state);
    return;
  }
  state.currentSeat = nextBidderSeat(state, seat);
  state.currentTurn = sideForSeat(state.currentSeat);
  touch(state);
}

function beginMightyKitty(state: MightySession): void {
  const declarer = state.highestBid!.seat;
  state.declarerSeat = declarer;
  state.trump = state.highestBid!.trump;
  state.bidCount = state.highestBid!.count;
  state.phase = 'kitty';
  state.currentSeat = declarer;
  state.currentTurn = sideForSeat(declarer);
  // 주공이 키티 3장을 손패로 가져온다(13장).
  state.hands[declarer] = sortMightyHand([...state.hands[declarer], ...state.kitty]);
  touch(state);
}

// ---------------------------------------------------------------------------
// 키티 교환 + 기루다 확정
// ---------------------------------------------------------------------------

function applyMightyKitty(
  state: MightySession,
  seat: number,
  input: { trump?: MightyTrump; count?: number; discard?: string[] },
): void {
  if (state.phase !== 'kitty') {
    throw new BadRequestException('not in kitty phase');
  }
  if (seat !== state.declarerSeat) {
    throw new BadRequestException('only the declarer can exchange the kitty');
  }
  const trump = input.trump ?? state.trump;
  if (!isValidTrump(trump)) {
    throw new BadRequestException('invalid trump');
  }
  const count = input.count === undefined ? state.bidCount! : Math.trunc(Number(input.count));
  if (!Number.isInteger(count) || count < Math.max(minBidForTrump(trump), state.bidCount!) || count > MIGHTY_MAX_BID) {
    throw new BadRequestException('final bid cannot be lower than the winning bid');
  }
  const discardIds = Array.isArray(input.discard) ? input.discard : [];
  if (discardIds.length !== MIGHTY_KITTY_SIZE) {
    throw new BadRequestException('discard exactly 3 cards');
  }
  const hand = state.hands[seat];
  const discard: MightyCard[] = [];
  const remaining = [...hand];
  for (const id of discardIds) {
    const card = parseMightyCardId(id);
    const index = remaining.findIndex((c) => sameCard(c, card));
    if (index < 0) {
      throw new BadRequestException(`cannot discard a card you do not hold: ${id}`);
    }
    discard.push(remaining.splice(index, 1)[0]);
  }
  state.hands[seat] = sortMightyHand(remaining);
  state.buriedCards = discard;
  state.kitty = [];
  state.trump = trump;
  state.bidCount = count;
  state.phase = 'friend';
  state.currentSeat = seat;
  state.currentTurn = sideForSeat(seat);
  touch(state);
}

// ---------------------------------------------------------------------------
// 프렌드 지정
// ---------------------------------------------------------------------------

function applyMightyFriend(
  state: MightySession,
  seat: number,
  input: { friendType?: string; card?: string },
): void {
  if (state.phase !== 'friend') {
    throw new BadRequestException('not in friend phase');
  }
  if (seat !== state.declarerSeat) {
    throw new BadRequestException('only the declarer can declare a friend');
  }
  const type = input.friendType;
  if (type === 'none') {
    state.friend = { type: 'none', revealed: true };
  } else if (type === 'first_trick') {
    state.friend = { type: 'first_trick', revealed: false };
  } else if (type === 'card') {
    if (!input.card) {
      throw new BadRequestException('card friend requires a card');
    }
    const card = parseMightyCardId(input.card);
    // 프렌드 카드는 공개(모두가 어떤 카드인지 안다). 보유 좌석은 그 카드가 플레이될 때까지 히든.
    const holder = findCardHolder(state, card);
    state.friend = { type: 'card', card, seat: holder, revealed: false };
  } else {
    throw new BadRequestException('friendType must be card, first_trick, or none');
  }
  state.phase = 'playing';
  state.currentSeat = state.declarerSeat;
  state.currentTurn = sideForSeat(state.declarerSeat);
  state.currentTrick = { leadSeat: state.declarerSeat, plays: [] };
  touch(state);
}

function findCardHolder(state: MightySession, card: MightyCard): number | undefined {
  for (let seat = 0; seat < MIGHTY_SEAT_COUNT; seat += 1) {
    if (state.hands[seat].some((c) => sameCard(c, card))) {
      return seat;
    }
  }
  return undefined; // 키티에 묻혔거나 존재하지 않음 → 사실상 노프렌드
}

// ---------------------------------------------------------------------------
// 플레이(트릭)
// ---------------------------------------------------------------------------

function effectiveLedSuit(plays: MightyTrickPlay[]): MightySuit | undefined {
  for (const play of plays) {
    if (play.card.suit !== 'JOKER') {
      return play.card.suit;
    }
  }
  return undefined;
}

export function mightyLegalPlays(state: MightySession, seat: number): MightyCard[] {
  if (state.phase !== 'playing') {
    return [];
  }
  const hand = state.hands[seat];
  const plays = state.currentTrick.plays;
  if (plays.length === 0) {
    return [...hand]; // 리드는 자유
  }
  const trickIndex = state.tricks.length;
  const isFirst = trickIndex === 0;
  const isLast = trickIndex === state.totalTricks - 1;
  const jokerCall = jokerCallCardFor(state.trump);
  const leadCard = plays[0].card;
  const jokerCallLed = sameCard(leadCard, jokerCall) && !isFirst && !isLast;
  const joker = hand.find(isJoker);
  if (jokerCallLed && joker) {
    return [joker]; // 조커콜 리드 시 조커 강제 소환
  }
  const effLed = effectiveLedSuit(plays);
  if (!effLed) {
    return [...hand]; // 조커만 리드된 상태 → 자유
  }
  const followers = hand.filter((c) => c.suit === effLed);
  if (followers.length === 0) {
    return [...hand]; // 해당 무늬 없음 → 자유
  }
  // 무늬를 따라야 하지만 마이티/조커는 면제(대신 낼 수 있음).
  const legal = [...followers];
  const mighty = mightyCardFor(state.trump);
  const myMighty = hand.find((c) => sameCard(c, mighty));
  if (myMighty && !legal.some((c) => sameCard(c, myMighty))) {
    legal.push(myMighty);
  }
  if (joker && !legal.some(isJoker)) {
    legal.push(joker);
  }
  return legal;
}

export function determineMightyTrickWinner(
  plays: MightyTrickPlay[],
  ctx: { trump: MightyTrump; trickIndex: number; totalTricks: number },
): number {
  const mighty = mightyCardFor(ctx.trump);
  const mightyPlay = plays.find((p) => sameCard(p.card, mighty));
  if (mightyPlay) {
    return mightyPlay.seat;
  }
  const jokerCall = jokerCallCardFor(ctx.trump);
  const leadCard = plays[0].card;
  const jokerCallLed = sameCard(leadCard, jokerCall);
  const jokerHasPower =
    ctx.trickIndex > 0 && ctx.trickIndex < ctx.totalTricks - 1 && !jokerCallLed;
  const jokerPlay = plays.find((p) => isJoker(p.card));
  if (jokerPlay && jokerHasPower) {
    return jokerPlay.seat;
  }
  const ledSuit = effectiveLedSuit(plays);
  let best: { play: MightyTrickPlay; isTrump: boolean } | null = null;
  for (const play of plays) {
    if (isJoker(play.card)) {
      continue; // 효력 없는 조커는 승자 후보 아님
    }
    const isTrump = ctx.trump !== 'notrump' && play.card.suit === ctx.trump;
    const isLed = play.card.suit === ledSuit;
    if (!isTrump && !isLed) {
      continue;
    }
    if (!best) {
      best = { play, isTrump };
      continue;
    }
    if (isTrump && !best.isTrump) {
      best = { play, isTrump };
      continue;
    }
    if (!isTrump && best.isTrump) {
      continue;
    }
    if (play.card.rank > best.play.card.rank) {
      best = { play, isTrump };
    }
  }
  return best ? best.play.seat : plays[0].seat;
}

function applyMightyPlay(state: MightySession, seat: number, input: { card?: string }): void {
  if (state.phase !== 'playing') {
    throw new BadRequestException('not in playing phase');
  }
  if (seat !== state.currentSeat) {
    throw new BadRequestException('not your turn to play');
  }
  if (!input.card) {
    throw new BadRequestException('card is required');
  }
  const card = parseMightyCardId(input.card);
  const legal = mightyLegalPlays(state, seat);
  if (!legal.some((c) => sameCard(c, card))) {
    throw new BadRequestException('illegal play');
  }
  // 손패에서 제거
  const hand = state.hands[seat];
  const handIndex = hand.findIndex((c) => sameCard(c, card));
  hand.splice(handIndex, 1);
  state.currentTrick.plays.push({ seat, card });

  // 카드 프렌드 공개: 지정된 프렌드 카드가 나오면 그 좌석이 프렌드로 공개된다.
  if (state.friend?.type === 'card' && !state.friend.revealed && state.friend.card && sameCard(card, state.friend.card)) {
    state.friend.seat = seat;
    state.friend.revealed = true;
  }

  if (state.currentTrick.plays.length < MIGHTY_SEAT_COUNT) {
    state.currentSeat = (seat + 1) % MIGHTY_SEAT_COUNT;
    state.currentTurn = sideForSeat(state.currentSeat);
    touch(state);
    return;
  }

  // 트릭 완료
  const trickIndex = state.tricks.length;
  const winnerSeat = determineMightyTrickWinner(state.currentTrick.plays, {
    trump: state.trump!,
    trickIndex,
    totalTricks: state.totalTricks,
  });
  const points = state.currentTrick.plays.filter((p) => isMightyPointCard(p.card)).length;
  state.capturedPoints[winnerSeat] += points;
  state.tricks.push({
    leadSeat: state.currentTrick.leadSeat,
    plays: state.currentTrick.plays,
    winnerSeat,
    points,
  });

  // 초구 프렌드: 첫 트릭 승자가 프렌드.
  if (trickIndex === 0 && state.friend?.type === 'first_trick' && !state.friend.revealed) {
    state.friend.seat = winnerSeat;
    state.friend.revealed = true;
  }

  if (state.tricks.length >= state.totalTricks) {
    finishMighty(state);
    return;
  }

  state.currentTrick = { leadSeat: winnerSeat, plays: [] };
  state.currentSeat = winnerSeat;
  state.currentTurn = sideForSeat(winnerSeat);
  touch(state);
}

// ---------------------------------------------------------------------------
// 점수 계산
// ---------------------------------------------------------------------------

function declarerTeamSeats(state: MightySession): number[] {
  const declarer = state.declarerSeat!;
  const team = [declarer];
  const friendSeat = state.friend?.seat;
  if (
    state.friend &&
    state.friend.type !== 'none' &&
    friendSeat !== undefined &&
    friendSeat !== declarer
  ) {
    team.push(friendSeat);
  }
  return team;
}

/**
 * 마이티 게임 점수 증감(제로섬) 계산 — 채택한 표준 규칙.
 *
 * unit = max(1, (공약 - 12) + |획득 - 공약|). 런(20점 전획)·노프렌드는 각각 x2.
 * 성공: 야당 각 -unit, 주공 +2unit·프렌드 +unit (노프렌드면 주공이 전부 획득). 실패는 부호 반전.
 * 항상 합이 0 이 되도록 분배한다. (노기루다 x2·백런 등은 옵션 — 서비스 보고서 참조)
 */
export function mightyScoreDeltas(params: {
  declarerSeat: number;
  friendSeat?: number;
  teamPoints: number;
  bid: number;
}): number[] {
  const declarer = params.declarerSeat;
  const hasFriend = params.friendSeat !== undefined && params.friendSeat !== declarer;
  const friendSeat = hasFriend ? params.friendSeat : undefined;
  const team = friendSeat === undefined ? [declarer] : [declarer, friendSeat];
  const defenders = allSeats().filter((seat) => !team.includes(seat));
  const success = params.teamPoints >= params.bid;
  const diff = success ? params.teamPoints - params.bid : params.bid - params.teamPoints;
  const soloRun = success && params.teamPoints === MIGHTY_TOTAL_POINT_CARDS;
  const noFriend = friendSeat === undefined;
  let unit = Math.max(1, params.bid - 12 + diff);
  if (soloRun) {
    unit *= 2;
  }
  if (noFriend) {
    unit *= 2;
  }
  const scores = [0, 0, 0, 0, 0];
  const sign = success ? 1 : -1;
  for (const seat of defenders) {
    scores[seat] = -sign * unit;
  }
  if (friendSeat === undefined) {
    scores[declarer] = sign * unit * defenders.length;
  } else {
    scores[declarer] = sign * unit * 2;
    scores[friendSeat] = sign * unit;
  }
  return scores;
}

function finishMighty(state: MightySession): void {
  const team = declarerTeamSeats(state);
  const buriedPoints = state.buriedCards.filter((c) => isMightyPointCard(c)).length;
  const teamPoints = team.reduce((sum, seat) => sum + state.capturedPoints[seat], 0) + buriedPoints;
  const bid = state.bidCount!;
  const success = teamPoints >= bid;
  const declarer = state.declarerSeat!;
  const friendSeat = team.find((seat) => seat !== declarer);
  const defenders = allSeats().filter((seat) => !team.includes(seat));
  const scores = mightyScoreDeltas({ declarerSeat: declarer, friendSeat, teamPoints, bid });

  state.phase = 'finished';
  state.status = 'finished';
  state.declarerTeamPoints = teamPoints;
  state.success = success;
  state.scores = scores;
  state.winnerTeam = success ? 'declarer' : 'defenders';
  state.winnerSeats = success ? team : defenders;
  state.winnerSide = success ? sideForSeat(declarer) : undefined;
  state.winnerAccountId = success ? state.players[sideForSeat(declarer)] : undefined;
  state.finishReason = success ? 'bid_success' : 'bid_failed';
  if (state.friend && !state.friend.revealed) {
    state.friend.revealed = true; // 종료 시 전원 공개
  }
  state.currentTurn = '';
  touch(state);
}

/** friend_match 이탈 좌석을 AI 대행으로 전환하기 위한 헬퍼(서비스가 호출). 게임은 계속된다. */
export function markMightySeatLeft(state: MightySession, seat: number, status: MightySeatStatus = 'left'): void {
  if (!state.seatStatus) {
    state.seatStatus = {};
  }
  state.seatStatus[sideForSeat(seat)] = status;
  touch(state);
}

function allSeats(): number[] {
  return [0, 1, 2, 3, 4];
}

// ---------------------------------------------------------------------------
// viewFor — 히든 정보 필터
// ---------------------------------------------------------------------------

export function mightyViewFor(state: MightySession, seat: number | 'spectator'): unknown {
  const viewerSeat = typeof seat === 'number' ? seat : -1;
  const friendView = state.friend
    ? {
        type: state.friend.type,
        card: state.friend.card ? mightyCardId(state.friend.card) : undefined,
        revealed: state.friend.revealed,
        seat: state.friend.revealed ? state.friend.seat : undefined,
      }
    : undefined;
  const view: Record<string, unknown> = {
    id: state.id,
    rev: state.rev,
    gameKey: 'mighty',
    mode: state.mode,
    aiDifficulty: state.aiDifficulty,
    players: state.players,
    seatStatus: state.seatStatus,
    seatCount: state.seatCount,
    phase: state.phase,
    status: state.status,
    currentSeat: state.currentSeat,
    currentTurn: state.currentTurn,
    firstBidder: state.firstBidder,
    dealCount: state.dealCount,
    bids: state.bids,
    highestBid: state.highestBid,
    passedSeats: state.passedSeats,
    declarerSeat: state.declarerSeat,
    trump: state.trump,
    bidCount: state.bidCount,
    friend: friendView,
    totalTricks: state.totalTricks,
    tricks: state.tricks.map(serializeTrick),
    currentTrick: {
      leadSeat: state.currentTrick.leadSeat,
      plays: state.currentTrick.plays.map((p) => ({ seat: p.seat, card: mightyCardId(p.card) })),
    },
    handCounts: state.hands.map((hand) => hand.length),
    capturedPoints: state.capturedPoints,
    mySeat: viewerSeat >= 0 ? viewerSeat : undefined,
    myHand: viewerSeat >= 0 ? state.hands[viewerSeat].map(mightyCardId) : [],
    pause: state.pause,
    finishReason: state.finishReason,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
  // 키티는 교환 단계의 주공에게만 노출.
  if (state.phase === 'kitty' && viewerSeat === state.declarerSeat) {
    view.kitty = state.kitty.map(mightyCardId);
  }
  // 내 턴의 합법 수를 실어 클라/AI 편의를 돕는다(히든 정보 아님).
  if (state.phase === 'playing' && viewerSeat === state.currentSeat) {
    view.legalPlays = mightyLegalPlays(state, viewerSeat).map(mightyCardId);
  }
  // 종료 시 전체 결과 공개.
  if (state.phase === 'finished') {
    view.declarerTeamPoints = state.declarerTeamPoints;
    view.success = state.success;
    view.scores = state.scores;
    view.winnerTeam = state.winnerTeam;
    view.winnerSeats = state.winnerSeats;
    view.winnerSide = state.winnerSide;
    view.winnerAccountId = state.winnerAccountId;
    view.buriedCards = state.buriedCards.map(mightyCardId);
  }
  return view;
}

function serializeTrick(trick: MightyTrick): Record<string, unknown> {
  return {
    leadSeat: trick.leadSeat,
    winnerSeat: trick.winnerSeat,
    points: trick.points,
    plays: trick.plays.map((p) => ({ seat: p.seat, card: mightyCardId(p.card) })),
  };
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

interface MightyBidPlan {
  trump: MightyTrump;
  strength: number;
  target: number;
}

interface MightyPublicMemory {
  playedCards: MightyCard[];
  visibleKnownCards: MightyCard[];
  unseenCards: MightyCard[];
  voidSuits: Map<number, Set<MightySuit>>;
  playedPointCards: number;
  mightySeen: boolean;
  jokerSeen: boolean;
}

function chooseMightyAiAction(state: MightySession, seat: number, difficulty: Difficulty): GameAction {
  if (state.phase === 'bidding') {
    return chooseMightyAiBid(state, seat, difficulty);
  }
  if (state.phase === 'kitty') {
    return chooseMightyAiKitty(state, seat, difficulty);
  }
  if (state.phase === 'friend') {
    return chooseMightyAiFriend(state, seat, difficulty);
  }
  if (state.phase === 'playing') {
    return chooseMightyAiPlay(state, seat, difficulty);
  }
  throw new BadRequestException('mighty is finished');
}

function chooseMightyAiBid(state: MightySession, seat: number, difficulty: Difficulty): GameAction {
  const plan = evaluateMightyBidPlan(state.hands[seat], difficulty);
  const minToBeat = minimumBidToBeat(plan.trump, state.highestBid);
  const noise = mightyAiNoise(state, seat, 'bid');
  const easyHesitates = difficulty === 'easy' && noise < 0.28;
  const willing = !easyHesitates && plan.strength >= aiBidThreshold(difficulty) && minToBeat <= plan.target;
  if (!willing || minToBeat > MIGHTY_MAX_BID) {
    return { type: 'bid', payload: { pass: true } };
  }
  const count = difficulty === 'hard'
    ? Math.min(plan.target, state.highestBid ? minToBeat + 2 : plan.target)
    : difficulty === 'medium'
      ? Math.min(plan.target, state.highestBid ? minToBeat + 1 : Math.max(minToBeat, plan.target - 1))
      : minToBeat;
  return { type: 'bid', payload: { pass: false, count, trump: plan.trump } };
}

function chooseMightyAiKitty(state: MightySession, seat: number, difficulty: Difficulty): GameAction {
  const hand = state.hands[seat];
  const finalPlan = chooseMightyKittyPlan(hand, state.trump!, state.bidCount!, difficulty);
  const discard = chooseMightyDiscards(state, seat, finalPlan.trump, difficulty).map(mightyCardId);
  return { type: 'kitty', payload: { trump: finalPlan.trump, count: state.bidCount, discard } };
}

function chooseMightyAiFriend(state: MightySession, seat: number, difficulty: Difficulty): GameAction {
  const hand = state.hands[seat];
  const mighty = mightyCardFor(state.trump);
  const plan = evaluateMightyBidPlan(hand, difficulty);
  if (!hand.some((c) => sameCard(c, mighty))) {
    return { type: 'friend', payload: { friendType: 'card', card: mightyCardId(mighty) } };
  }
  if (!hand.some(isJoker)) {
    return { type: 'friend', payload: { friendType: 'card', card: 'JOKER' } };
  }
  if (difficulty === 'hard') {
    const missingPower = bestMissingFriendCard(hand, state.trump!);
    if (missingPower) {
      return { type: 'friend', payload: { friendType: 'card', card: mightyCardId(missingPower) } };
    }
    if (plan.target >= 19 && plan.strength >= 20) {
      return { type: 'friend', payload: { friendType: 'none' } };
    }
  }
  return { type: 'friend', payload: { friendType: 'first_trick' } };
}

function chooseMightyAiPlay(state: MightySession, seat: number, difficulty: Difficulty): GameAction {
  const legal = mightyLegalPlays(state, seat);
  if (legal.length === 0) {
    throw new BadRequestException('mighty has no legal AI play');
  }
  const memory = buildMightyPublicMemory(state, seat);
  if (difficulty === 'easy' && mightyAiNoise(state, seat, 'play') < 0.25) {
    return { type: 'play', payload: { card: mightyCardId(pickDeterministicRandomCard(legal, state, seat, 'mistake')) } };
  }
  const scored = legal
    .map((card) => ({ card, score: scoreMightyAiPlay(state, seat, card, difficulty, memory) }))
    .sort((a, b) => b.score - a.score || cardCost(a.card, state.trump!) - cardCost(b.card, state.trump!));
  return { type: 'play', payload: { card: mightyCardId(scored[0].card) } };
}

function evaluateMightyBidPlan(hand: MightyCard[], difficulty: Difficulty): MightyBidPlan {
  const candidates: MightyTrump[] = [...SUITS, 'notrump'];
  const plans = candidates
    .map((trump) => evaluateMightyBidPlanForTrump(hand, trump, difficulty))
    .sort((a, b) => {
      if (b.target !== a.target) {
        return b.target - a.target;
      }
      if (b.strength !== a.strength) {
        return b.strength - a.strength;
      }
      if (a.trump === 'notrump') {
        return -1;
      }
      if (b.trump === 'notrump') {
        return 1;
      }
      return SUITS.indexOf(a.trump as MightySuit) - SUITS.indexOf(b.trump as MightySuit);
    });
  return plans[0];
}

function evaluateMightyBidPlanForTrump(hand: MightyCard[], trump: MightyTrump, difficulty: Difficulty): MightyBidPlan {
  const trumpCards = trump === 'notrump' ? [] : hand.filter((c) => c.suit === trump);
  const highCards = hand.filter((c) => c.suit !== 'JOKER' && c.rank >= 12);
  const aces = hand.filter((c) => c.suit !== 'JOKER' && c.rank === 14).length;
  const kings = hand.filter((c) => c.suit !== 'JOKER' && c.rank === 13).length;
  const queens = hand.filter((c) => c.suit !== 'JOKER' && c.rank === 12).length;
  const jacks = hand.filter((c) => c.suit !== 'JOKER' && c.rank === 11).length;
  const tens = hand.filter((c) => c.suit !== 'JOKER' && c.rank === 10).length;
  const hasMighty = hand.some((c) => sameCard(c, mightyCardFor(trump)));
  const hasJoker = hand.some(isJoker);
  const trumpHigh = trumpCards.filter((c) => c.rank >= 11).length;
  const trumpPointCards = trumpCards.filter(isMightyPointCard).length;
  const longTrumpBonus = Math.max(0, trumpCards.length - 3);
  let strength =
    aces * 2.3 +
    kings * 1.4 +
    queens * 0.8 +
    jacks * 0.45 +
    tens * 0.2 +
    highCards.length * 0.15 +
    (hasMighty ? 4.2 : 0) +
    (hasJoker ? 3.7 : 0);

  if (trump === 'notrump') {
    strength += aces >= 3 ? 2.2 : -2.2;
    strength += hasMighty && hasJoker ? 2.2 : 0;
  } else {
    strength += trumpCards.length * 0.95 + trumpHigh * 1.05 + trumpPointCards * 0.3 + longTrumpBonus * 1.35;
  }

  const threshold = aiBidThreshold(difficulty);
  const minBid = minBidForTrump(trump);
  const rawTarget = minBid + Math.floor((strength - threshold) / aiBidStep(difficulty));
  const difficultyCap = difficulty === 'easy' ? 17 : difficulty === 'medium' ? 19 : MIGHTY_MAX_BID;
  const target = Math.max(minBid, Math.min(difficultyCap, rawTarget));
  return { trump, strength, target };
}

function aiBidThreshold(difficulty: Difficulty): number {
  if (difficulty === 'easy') {
    return 11.5;
  }
  if (difficulty === 'hard') {
    return 7.5;
  }
  return 9.3;
}

function aiBidStep(difficulty: Difficulty): number {
  if (difficulty === 'easy') {
    return 3.1;
  }
  if (difficulty === 'hard') {
    return 1.85;
  }
  return 2.35;
}

function minimumBidToBeat(trump: MightyTrump, current?: MightyBid): number {
  if (!current) {
    return minBidForTrump(trump);
  }
  if (mightyBidBeats({ count: current.count, trump }, current)) {
    return current.count;
  }
  return current.count + 1;
}

function chooseMightyKittyPlan(
  hand: MightyCard[],
  currentTrump: MightyTrump,
  currentCount: number,
  difficulty: Difficulty,
): MightyBidPlan {
  if (difficulty === 'easy') {
    return evaluateMightyBidPlanForTrump(hand, currentTrump, difficulty);
  }
  const best = evaluateMightyBidPlan(hand, difficulty);
  if (best.target >= Math.max(currentCount, minBidForTrump(best.trump)) && best.strength > evaluateMightyBidPlanForTrump(hand, currentTrump, difficulty).strength + 1.5) {
    return best;
  }
  return evaluateMightyBidPlanForTrump(hand, currentTrump, difficulty);
}

function chooseMightyDiscards(
  state: MightySession,
  seat: number,
  trump: MightyTrump,
  difficulty: Difficulty,
): MightyCard[] {
  const hand = state.hands[seat];
  return [...hand]
    .sort((a, b) =>
      discardScore(a, hand, trump, difficulty, state, seat) - discardScore(b, hand, trump, difficulty, state, seat)
    )
    .slice(0, MIGHTY_KITTY_SIZE);
}

function discardScore(
  card: MightyCard,
  hand: MightyCard[],
  trump: MightyTrump,
  difficulty: Difficulty,
  state: MightySession,
  seat: number,
): number {
  const mighty = mightyCardFor(trump);
  const suitCount = card.suit === 'JOKER' ? 0 : hand.filter((c) => c.suit === card.suit).length;
  let score = card.rank * 0.12;
  if (sameCard(card, mighty)) {
    score += 100;
  }
  if (isJoker(card)) {
    score += difficulty === 'easy' ? 24 : 100;
  }
  if (trump !== 'notrump' && card.suit === trump) {
    score += difficulty === 'easy' ? 2.5 : difficulty === 'medium' ? 5 : 7;
  }
  if (isMightyPointCard(card)) {
    score += difficulty === 'easy' ? 1.6 : difficulty === 'medium' ? 5.2 : 7.4;
  }
  if (difficulty === 'hard' && card.suit !== 'JOKER' && card.suit !== trump) {
    if (suitCount === 1 && !isMightyPointCard(card)) {
      score -= 2.1; // 단패를 털어 void 를 만들면 후속 트릭 운영이 쉬워진다.
    }
    if (suitCount >= 4 && card.rank <= 7) {
      score -= 0.8;
    }
  }
  if (difficulty === 'easy') {
    score += mightyAiNoise(state, seat, `discard:${mightyCardId(card)}`) * 3.3;
  }
  return score;
}

function bestMissingFriendCard(hand: MightyCard[], trump: MightyTrump): MightyCard | undefined {
  const candidates: MightyCard[] = [
    ...powerCardsForTrump(trump),
    ...SUITS.flatMap((suit) => [14, 13, 12].map((rank) => ({ suit, rank } as MightyCard))),
  ];
  return candidates.find((card) => !hand.some((owned) => sameCard(owned, card)));
}

function powerCardsForTrump(trump: MightyTrump): MightyCard[] {
  const cards: MightyCard[] = [mightyCardFor(trump), { suit: 'JOKER', rank: 0 }];
  if (trump !== 'notrump') {
    cards.push({ suit: trump, rank: 14 }, { suit: trump, rank: 13 });
  }
  return cards;
}

function scoreMightyAiPlay(
  state: MightySession,
  seat: number,
  card: MightyCard,
  difficulty: Difficulty,
  memory: MightyPublicMemory,
): number {
  const trump = state.trump!;
  const plays = state.currentTrick.plays;
  const cost = cardCost(card, trump);
  if (plays.length === 0) {
    return scoreMightyLead(state, seat, card, difficulty, memory) - cost * (difficulty === 'hard' ? 0.42 : 0.35);
  }

  const hypothetical = [...plays, { seat, card }];
  const winnerSeat = determineMightyTrickWinner(hypothetical, {
    trump,
    trickIndex: state.tricks.length,
    totalTricks: state.totalTricks,
  });
  const trickPoints = hypothetical.filter((p) => isMightyPointCard(p.card)).length;
  const relation = aiSeatRelation(state, seat, winnerSeat);
  const winsNow = winnerSeat === seat;
  const partnerWins = relation === 'ally';
  const opponentWins = relation === 'opponent';
  const late = state.tricks.length >= state.totalTricks - 3;
  let score = 0;

  if (winsNow) {
    score += trickPoints * (difficulty === 'hard' ? 8.5 : 6.4);
    score += late ? 1.5 : 0;
    score -= cost * (trickPoints > 0 ? 0.22 : 0.72);
    if (difficulty === 'hard') {
      score -= futureOvertakeRisk(state, seat, card, memory) * 0.55;
    }
  } else if (partnerWins) {
    score += trickPoints * (difficulty === 'hard' ? 4.4 : 2.7);
    score -= cost * 0.25;
    if (isMightyPointCard(card) && difficulty !== 'easy') {
      score += futureOpponentSeats(state, seat).length === 0 ? 4.5 : 1.2;
    }
  } else if (opponentWins) {
    score -= trickPoints * (difficulty === 'hard' ? 5.2 : 3.2);
    score -= isMightyPointCard(card) ? 7 : 0;
    score -= cost * 0.12;
  } else {
    score -= trickPoints * 1.3;
    score -= cost * 0.18;
  }

  if (difficulty === 'hard') {
    score += hardMightyTempoBonus(state, seat, card, memory);
  }
  if (difficulty === 'easy') {
    score += mightyAiNoise(state, seat, `play:${mightyCardId(card)}`) * 5.5;
  }
  return score;
}

function scoreMightyLead(
  state: MightySession,
  seat: number,
  card: MightyCard,
  difficulty: Difficulty,
  memory: MightyPublicMemory,
): number {
  const trump = state.trump!;
  const declarerTeam = aiKnowsSeatIsDeclarerTeam(state, seat, seat);
  let score = 0;
  if (!isMightyPointCard(card)) {
    score += difficulty === 'easy' ? 2.2 : 4.4;
  }
  if (card.suit !== 'JOKER' && trump !== 'notrump' && card.suit !== trump) {
    const ownSuitCount = state.hands[seat].filter((c) => c.suit === card.suit).length;
    score += Math.max(0, 4 - ownSuitCount) * 0.65;
    if (difficulty === 'hard') {
      score += seatsVoidInSuit(memory, card.suit, opponentSeatsForPerspective(state, seat)).length * (declarerTeam ? -0.9 : 1.1);
    }
  }
  if (sameCard(card, mightyCardFor(trump)) || isJoker(card)) {
    score -= difficulty === 'easy' ? 7 : 18;
  }
  if (trump !== 'notrump' && card.suit === trump) {
    score -= difficulty === 'hard' && declarerTeam && teamPointsNeeded(state, seat) <= 5 ? 0.5 : 4.6;
  }
  if (difficulty === 'hard' && declarerTeam && teamPointsNeeded(state, seat) > 0 && safeLeadThreatCount(state, seat, card, memory) === 0) {
    score += isMightyPointCard(card) ? 2.8 : 1.4;
  }
  if (difficulty === 'easy') {
    score += mightyAiNoise(state, seat, `lead:${mightyCardId(card)}`) * 4.2;
  }
  return score;
}

function buildMightyPublicMemory(state: MightySession, seat: number): MightyPublicMemory {
  const playedCards = [
    ...state.tricks.flatMap((trick) => trick.plays.map((play) => play.card)),
    ...state.currentTrick.plays.map((play) => play.card),
  ];
  const visibleKnownCards = [...playedCards, ...state.hands[seat]];
  if (seat === state.declarerSeat) {
    visibleKnownCards.push(...state.buriedCards);
  }
  const unseenCards = createDeck().filter((card) => !visibleKnownCards.some((known) => sameCard(known, card)));
  const voidSuits = new Map<number, Set<MightySuit>>();
  const addVoid = (voidSeat: number, suit: MightySuit) => {
    const set = voidSuits.get(voidSeat) ?? new Set<MightySuit>();
    set.add(suit);
    voidSuits.set(voidSeat, set);
  };
  for (const trick of state.tricks) {
    const led = effectiveLedSuit(trick.plays);
    if (!led) {
      continue;
    }
    for (const play of trick.plays.slice(1)) {
      if (play.card.suit !== led && !isJoker(play.card) && !sameCard(play.card, mightyCardFor(state.trump))) {
        addVoid(play.seat, led);
      }
    }
  }
  return {
    playedCards,
    visibleKnownCards,
    unseenCards,
    voidSuits,
    playedPointCards: playedCards.filter(isMightyPointCard).length,
    mightySeen: playedCards.some((card) => sameCard(card, mightyCardFor(state.trump))),
    jokerSeen: playedCards.some(isJoker),
  };
}

function aiSeatRelation(
  state: MightySession,
  perspectiveSeat: number,
  targetSeat: number,
): 'self' | 'ally' | 'opponent' | 'unknown' {
  if (perspectiveSeat === targetSeat) {
    return 'self';
  }
  const perspectiveDeclarerTeam = aiKnowsSeatIsDeclarerTeam(state, perspectiveSeat, perspectiveSeat);
  const targetDeclarerTeam = aiKnowsSeatIsDeclarerTeam(state, perspectiveSeat, targetSeat);
  if (targetDeclarerTeam === undefined) {
    if (targetSeat === state.declarerSeat) {
      return perspectiveDeclarerTeam ? 'ally' : 'opponent';
    }
    return 'unknown';
  }
  return perspectiveDeclarerTeam === targetDeclarerTeam ? 'ally' : 'opponent';
}

function aiKnowsSeatIsDeclarerTeam(
  state: MightySession,
  perspectiveSeat: number,
  targetSeat: number,
): boolean | undefined {
  const declarer = state.declarerSeat;
  if (declarer === undefined) {
    return undefined;
  }
  if (targetSeat === declarer) {
    return true;
  }
  if (state.friend?.type === 'none') {
    return false;
  }
  if (state.friend?.revealed) {
    return targetSeat === state.friend.seat;
  }
  if (targetSeat === perspectiveSeat && state.friend?.seat === perspectiveSeat) {
    return true; // 프렌드 본인은 자신이 프렌드임을 안다.
  }
  if (perspectiveSeat === state.friend?.seat && targetSeat !== declarer) {
    return false;
  }
  return undefined;
}

function opponentSeatsForPerspective(state: MightySession, perspectiveSeat: number): number[] {
  return allSeats().filter((seat) => aiSeatRelation(state, perspectiveSeat, seat) === 'opponent');
}

function futureOpponentSeats(state: MightySession, seat: number): number[] {
  const future: number[] = [];
  for (let current = (seat + 1) % MIGHTY_SEAT_COUNT; future.length + state.currentTrick.plays.length + 1 < MIGHTY_SEAT_COUNT; current = (current + 1) % MIGHTY_SEAT_COUNT) {
    future.push(current);
  }
  return future.filter((futureSeat) => aiSeatRelation(state, seat, futureSeat) !== 'ally');
}

function seatsVoidInSuit(memory: MightyPublicMemory, suit: MightySuit, seats: number[]): number[] {
  return seats.filter((seat) => memory.voidSuits.get(seat)?.has(suit));
}

function teamPointsNeeded(state: MightySession, seat: number): number {
  const bid = state.bidCount ?? MIGHTY_MIN_SUIT_BID;
  const declarer = state.declarerSeat;
  if (declarer === undefined) {
    return bid;
  }
  const knownTeam = allSeats().filter((candidate) => aiKnowsSeatIsDeclarerTeam(state, seat, candidate) === true);
  const points = knownTeam.reduce((sum, candidate) => sum + state.capturedPoints[candidate], 0);
  return Math.max(0, bid - points);
}

function hardMightyTempoBonus(
  state: MightySession,
  seat: number,
  card: MightyCard,
  memory: MightyPublicMemory,
): number {
  let bonus = 0;
  const trump = state.trump!;
  const late = state.tricks.length >= state.totalTricks - 3;
  if (isJoker(card) && (state.tricks.length === 0 || state.tricks.length === state.totalTricks - 1)) {
    bonus -= 18; // 초구/막장 조커는 힘이 없다.
  }
  if (!memory.mightySeen && sameCard(card, mightyCardFor(trump)) && !late) {
    bonus -= 5;
  }
  if (!memory.jokerSeen && isJoker(card) && !late) {
    bonus -= 4;
  }
  if (isMightyPointCard(card) && aiKnowsSeatIsDeclarerTeam(state, seat, seat) === false && teamPointsNeeded(state, state.declarerSeat ?? seat) <= 3) {
    bonus -= 2.5;
  }
  return bonus;
}

function futureOvertakeRisk(
  state: MightySession,
  seat: number,
  card: MightyCard,
  memory: MightyPublicMemory,
): number {
  const futureOpponents = futureOpponentSeats(state, seat);
  if (futureOpponents.length === 0) {
    return 0;
  }
  const hypothetical = [...state.currentTrick.plays, { seat, card }];
  return memory.unseenCards.filter((unseen) => {
    const winner = determineMightyTrickWinner([...hypothetical, { seat: -1, card: unseen }], {
      trump: state.trump!,
      trickIndex: state.tricks.length,
      totalTricks: state.totalTricks,
    });
    return winner === -1;
  }).length;
}

function safeLeadThreatCount(
  state: MightySession,
  seat: number,
  card: MightyCard,
  memory: MightyPublicMemory,
): number {
  const hypothetical = [{ seat, card }];
  return memory.unseenCards.filter((unseen) => {
    const winner = determineMightyTrickWinner([...hypothetical, { seat: -1, card: unseen }], {
      trump: state.trump!,
      trickIndex: state.tricks.length,
      totalTricks: state.totalTricks,
    });
    return winner === -1;
  }).length;
}

function cardCost(card: MightyCard, trump: MightyTrump): number {
  let cost = cardStrength(card, trump) / 10;
  if (isMightyPointCard(card)) {
    cost += 2.7;
  }
  if (isJoker(card)) {
    cost += 8;
  }
  if (sameCard(card, mightyCardFor(trump))) {
    cost += 12;
  }
  return cost;
}

function pickDeterministicRandomCard(
  cards: MightyCard[],
  state: MightySession,
  seat: number,
  salt: string,
): MightyCard {
  const index = Math.floor(mightyAiNoise(state, seat, salt) * cards.length) % cards.length;
  return cards[index];
}

function mightyAiNoise(state: MightySession, seat: number, salt: string): number {
  const source = [
    state.rngSeed ?? state.id,
    seat,
    salt,
    state.phase,
    state.bids.length,
    state.tricks.length,
    state.currentTrick.plays.length,
    state.dealCount,
  ].join('|');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function cardStrength(card: MightyCard, trump: MightyTrump): number {
  if (isJoker(card)) {
    return 100;
  }
  if (sameCard(card, mightyCardFor(trump))) {
    return 200;
  }
  const trumpBonus = trump !== 'notrump' && card.suit === trump ? 50 : 0;
  return trumpBonus + card.rank;
}

function beatsMightyCard(card: MightyCard, target: MightyCard, plays: MightyTrickPlay[], state: MightySession): boolean {
  const hypothetical = [...plays, { seat: -1, card }];
  const winner = determineMightyTrickWinner(hypothetical, {
    trump: state.trump!,
    trickIndex: state.tricks.length,
    totalTricks: state.totalTricks,
  });
  return winner === -1;
}

// ---------------------------------------------------------------------------
// 엔진 계약
// ---------------------------------------------------------------------------

export const MIGHTY_ENGINE: GameEngine<MightySession> = {
  descriptor: {
    key: 'mighty',
    title: 'Mighty',
    minPlayers: MIGHTY_SEAT_COUNT,
    maxPlayers: MIGHTY_SEAT_COUNT,
    modes: ['local_ai', 'friend_match'],
    turnType: 'turnBased',
    hiddenInfo: true,
    supportsAi: true,
    supportsMatchSave: true,
    status: 'playable',
  },
  stateVersion: MIGHTY_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): MightySession {
    const seats = players.map((player, index) => ({
      accountId: player.accountId ?? `__game_platform_local_ai__#${index}`,
    }));
    const state = createMightyState(seats, mightyModeFromConfig(config.mode), {
      aiDifficulty: typeof config.aiDifficulty === 'string' ? config.aiDifficulty : undefined,
      seed: typeof config.seed === 'string' ? config.seed : undefined,
      firstBidder: typeof config.firstBidder === 'number' ? config.firstBidder : undefined,
    });
    state.id = typeof config.id === 'string' ? config.id : '';
    return state;
  },
  applyAction(state: MightySession, seat: number, action: GameAction) {
    const payload = action.payload ?? {};
    switch (action.type) {
      case 'bid':
        applyMightyBid(state, seat, {
          pass: payload.pass === true,
          count: typeof payload.count === 'number' ? payload.count : undefined,
          trump: payload.trump as MightyTrump | undefined,
        });
        break;
      case 'kitty':
        applyMightyKitty(state, seat, {
          trump: payload.trump as MightyTrump | undefined,
          count: typeof payload.count === 'number' ? payload.count : undefined,
          discard: Array.isArray(payload.discard) ? (payload.discard as string[]) : undefined,
        });
        break;
      case 'friend':
        applyMightyFriend(state, seat, {
          friendType: typeof payload.friendType === 'string' ? payload.friendType : undefined,
          card: typeof payload.card === 'string' ? payload.card : undefined,
        });
        break;
      case 'play':
        applyMightyPlay(state, seat, {
          card: typeof payload.card === 'string' ? payload.card : undefined,
        });
        break;
      default:
        throw new BadRequestException(`unsupported mighty action: ${action.type}`);
    }
    return { state };
  },
  viewFor(state: MightySession, seat: number | 'spectator') {
    return mightyViewFor(state, seat);
  },
  finishInfo(state: MightySession) {
    if (state.phase !== 'finished') {
      return null;
    }
    return {
      status: 'finished' as const,
      winnerSeat: state.success ? state.declarerSeat : undefined,
      reason: state.finishReason,
    };
  },
  aiAction(state: MightySession, seat: number, difficulty: Difficulty): GameAction {
    return chooseMightyAiAction(state, seat, difficulty);
  },
  migrate(oldState: unknown): MightySession {
    return oldState as MightySession;
  },
};

function mightyModeFromConfig(value: unknown): GameMode {
  return value === 'friend_match' || value === 'local_ai' || value === 'solo' ? value : 'local_ai';
}

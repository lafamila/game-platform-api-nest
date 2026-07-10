import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { createSeededRng } from './engine/rng';
import { Difficulty, GameMode } from './games.types';

export type SplendorGem = 'white' | 'blue' | 'green' | 'red' | 'black';
export type SplendorToken = SplendorGem | 'gold';
export type SplendorSide = string;
export type SplendorTier = '1' | '2' | '3';

export type SplendorTokenMap = Record<SplendorToken, number>;
export type SplendorGemCost = Record<SplendorGem, number>;

export interface SplendorCard {
  id: string;
  tier: SplendorTier;
  color: SplendorGem;
  points: number;
  cost: SplendorGemCost;
  art: string;
}

export interface SplendorNoble {
  id: string;
  points: number;
  cost: SplendorGemCost;
  art: string;
}

export interface SplendorPlayerState {
  tokens: SplendorTokenMap;
  bonuses: SplendorGemCost;
  reserved: SplendorCard[];
  purchased: SplendorCard[];
  nobles: SplendorNoble[];
  score: number;
}

export interface SplendorSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: string;
  /** 딜/셔플 재현용 시드 (감사 전용). viewFor/클라 응답에는 절대 노출하지 않는다. */
  rngSeed?: string;
  players: Record<SplendorSide, string>;
  currentTurn: SplendorSide;
  turnOrder?: SplendorSide[];
  /** 좌석별 참가 상태 (없으면 active 로 간주). left/forfeited 좌석은 턴 로테이션에서 제외된다. */
  seatStatus?: Record<SplendorSide, SplendorSeatStatus>;
  winnerSide?: SplendorSide;
  winnerAccountId?: string;
  status: 'playing' | 'finished';
  bank: SplendorTokenMap;
  market: Record<SplendorTier, SplendorCard[]>;
  decks: Record<SplendorTier, SplendorCard[]>;
  nobles: SplendorNoble[];
  playerStates: Record<SplendorSide, SplendorPlayerState>;
  moves: Array<{
    action: 'take_tokens' | 'reserve' | 'buy' | 'forfeit';
    side: SplendorSide;
    accountId: string;
    createdAt: string;
    detail?: unknown;
    source?: 'manual' | 'ai';
  }>;
  finalRoundStartedBy?: SplendorSide;
  pause?: { active: boolean; requestedByAccountId?: string; startedAt?: string; resumableAt?: string; counts?: Record<string, number> };
  roomId?: string;
  roomCode?: string;
  roomMode?: string;
  roomPlayers?: Array<{ seat: number; accountId: string; kind: 'account' | 'ai'; status: string; aiDifficulty?: Difficulty }>;
  finishReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SplendorClientSession extends Omit<SplendorSession, 'decks' | 'rngSeed'> {
  deckCounts: Record<SplendorTier, number>;
  mySide?: SplendorSide;
}

export type SplendorSeatStatus = 'active' | 'left' | 'forfeited';

type SplendorAiDifficulty = 'easy' | 'medium' | 'hard';
type SplendorAiAction =
  | { kind: 'buy'; card: SplendorCard; score: number }
  | { kind: 'reserve'; card: SplendorCard; discardTokens: SplendorTokenMap; score: number }
  | { kind: 'take'; tokens: SplendorTokenMap; discardTokens: SplendorTokenMap; score: number }
  | { kind: 'pass'; score: number };

export const SPLENDOR_GEMS: SplendorGem[] = ['white', 'blue', 'green', 'red', 'black'];
export const SPLENDOR_TOKENS: SplendorToken[] = ['white', 'blue', 'green', 'red', 'black', 'gold'];
export const SPLENDOR_TIERS: SplendorTier[] = ['1', '2', '3'];
export const SPLENDOR_STATE_VERSION = 1;

const ZERO_GEMS: SplendorGemCost = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
const ZERO_TOKENS: SplendorTokenMap = { white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 };

export const SPLENDOR_ENGINE: GameEngine<SplendorSession> = {
  descriptor: {
    key: 'splendor',
    title: 'Splendor',
    minPlayers: 2,
    maxPlayers: 4,
    modes: ['local_ai', 'friend_match'],
    turnType: 'turnBased',
    hiddenInfo: true,
    supportsAi: true,
    supportsMatchSave: true,
    status: 'playable',
  },
  stateVersion: SPLENDOR_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): SplendorSession {
    const mode = splendorModeFromConfig(config.mode);
    const seats = players.map((player, index) => ({
      side: splendorSideForSeat(index, players.length),
      accountId: player.accountId ?? `__game_platform_local_ai__#${index}`,
    }));
    const state = createSplendorStateForPlayers(
      seats,
      mode,
      splendorDifficultyFromConfig(config.aiDifficulty),
      typeof config.seed === 'string' ? config.seed : undefined,
    );
    state.id = typeof config.id === 'string' ? config.id : '';
    return state;
  },
  applyAction(state: SplendorSession, seat: number, action: GameAction) {
    const side = splendorTurnOrder(state)[seat];
    if (!side) {
      throw new BadRequestException('splendor player is missing');
    }
    const accountId = state.players[side];
    if (!accountId) {
      throw new BadRequestException('splendor account is missing');
    }
    const payload = action.payload ?? {};
    if (action.type === 'take_tokens') {
      applySplendorTakeTokens(
        state,
        side,
        accountId,
        splendorTokenPayload(payload.tokens),
        splendorTokenPayload(payload.discardTokens),
      );
      return { state };
    }
    if (action.type === 'reserve_card' || action.type === 'reserve') {
      applySplendorReserve(state, side, accountId, {
        cardId: typeof payload.cardId === 'string' ? payload.cardId : undefined,
        tier: typeof payload.tier === 'string' ? payload.tier : undefined,
        discardTokens: splendorTokenPayload(payload.discardTokens),
      });
      return { state };
    }
    if (action.type === 'buy_card' || action.type === 'buy') {
      applySplendorBuy(state, side, accountId, typeof payload.cardId === 'string' ? payload.cardId : '');
      return { state };
    }
    if (action.type === 'forfeit') {
      applySplendorForfeit(state, side, accountId);
      return { state };
    }
    if (action.type === 'pass') {
      advanceSplendorTurn(state, side);
      return { state };
    }
    throw new BadRequestException('unsupported splendor action');
  },
  viewFor(state: SplendorSession, seat: number | 'spectator') {
    const side = typeof seat === 'number' ? splendorTurnOrder(state)[seat] : undefined;
    return splendorClientSession(state, side ? state.players[side] : undefined);
  },
  finishInfo(state: SplendorSession) {
    if (state.status !== 'finished') {
      return null;
    }
    const winnerSeat = state.winnerSide ? splendorTurnOrder(state).indexOf(state.winnerSide) : -1;
    return {
      status: 'finished',
      winnerSeat: winnerSeat >= 0 ? winnerSeat : undefined,
      reason: state.finishReason,
    };
  },
  aiAction(state: SplendorSession, seat: number, difficulty: Difficulty) {
    const side = splendorTurnOrder(state)[seat];
    if (!side) {
      return { type: 'pass' };
    }
    state.aiDifficulty = difficulty;
    const action = chooseSplendorAiAction(state, side);
    if (action.kind === 'buy') {
      return { type: 'buy_card', payload: { cardId: action.card.id } };
    }
    if (action.kind === 'reserve') {
      return {
        type: 'reserve_card',
        payload: { cardId: action.card.id, discardTokens: action.discardTokens },
      };
    }
    if (action.kind === 'take') {
      return {
        type: 'take_tokens',
        payload: { tokens: action.tokens, discardTokens: action.discardTokens },
      };
    }
    return { type: 'pass' };
  },
};

function splendorModeFromConfig(value: unknown): GameMode {
  return value === 'friend_match' ? 'friend_match' : 'local_ai';
}

function splendorDifficultyFromConfig(value: unknown): Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
}

function splendorSideForSeat(seat: number, playerCount: number): SplendorSide {
  if (playerCount <= 2) {
    return seat === 0 ? 'challenger' : 'opponent';
  }
  return `seat${seat}`;
}

function splendorTokenPayload(value: unknown): Partial<Record<SplendorToken, number>> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const source = value as Record<string, unknown>;
  const tokens: Partial<Record<SplendorToken, number>> = {};
  for (const token of SPLENDOR_TOKENS) {
    if (source[token] !== undefined) {
      tokens[token] = Number(source[token]);
    }
  }
  return tokens;
}

export function createSplendorState(ownerAccountId: string, opponentAccountId: string, mode: GameMode, aiDifficulty?: string): SplendorSession {
  return createSplendorStateForPlayers(
    [
      { side: 'challenger', accountId: ownerAccountId },
      { side: 'opponent', accountId: opponentAccountId },
    ],
    mode,
    aiDifficulty,
  );
}

export function createSplendorStateForPlayers(
  seats: Array<{ side: SplendorSide; accountId: string }>,
  mode: GameMode,
  aiDifficulty?: string,
  seed?: string,
): SplendorSession {
  if (seats.length < 2 || seats.length > 4) {
    throw new BadRequestException('splendor supports 2 to 4 players');
  }
  const rng = createSeededRng(seed);
  const decks = createSplendorDecks();
  for (const tier of SPLENDOR_TIERS) {
    rng.shuffle(decks[tier]);
  }
  const market = {
    '1': drawCards(decks['1'], 4),
    '2': drawCards(decks['2'], 4),
    '3': drawCards(decks['3'], 4),
  };
  const players = Object.fromEntries(seats.map((seat) => [seat.side, seat.accountId]));
  const turnOrder = seats.map((seat) => seat.side);
  const playerStates = Object.fromEntries(seats.map((seat) => [seat.side, createPlayerState()]));
  const seatStatus = Object.fromEntries(seats.map((seat) => [seat.side, 'active' as SplendorSeatStatus]));
  const bankCount = seats.length <= 2 ? 4 : seats.length === 3 ? 5 : 7;
  const nobles = rng.shuffle(createSplendorNobles()).slice(0, seats.length + 1);
  return {
    id: '',
    mode,
    aiDifficulty,
    rngSeed: rng.seed,
    players,
    currentTurn: turnOrder[0],
    turnOrder,
    seatStatus,
    status: 'playing',
    bank: { white: bankCount, blue: bankCount, green: bankCount, red: bankCount, black: bankCount, gold: 5 },
    market,
    decks,
    nobles,
    playerStates,
    moves: [],
    createdAt: '',
    updatedAt: '',
  };
}

export function splendorClientSession(session: SplendorSession, accountId?: string): SplendorClientSession {
  const mySide = accountId ? splendorSideForAccount(session, accountId) : undefined;
  const { decks: _decks, rngSeed: _rngSeed, ...rest } = session;
  return {
    ...rest,
    deckCounts: {
      '1': session.decks['1'].length,
      '2': session.decks['2'].length,
      '3': session.decks['3'].length,
    },
    mySide,
  };
}

export function splendorSideForAccount(session: SplendorSession, accountId: string): SplendorSide | undefined {
  for (const [side, playerAccountId] of Object.entries(session.players)) {
    if (playerAccountId === accountId) {
      return side;
    }
  }
  return undefined;
}

export function applySplendorTakeTokens(
  session: SplendorSession,
  side: SplendorSide,
  accountId: string,
  input: Partial<Record<SplendorToken, number>>,
  discardInput: Partial<Record<SplendorToken, number>> = {},
  source: 'manual' | 'ai' = 'manual',
): void {
  assertSplendorPlayingTurn(session, side);
  const tokens = sanitizeTokenInput(input, false);
  const total = tokenTotal(tokens);
  if (total < 1 || total > 3) {
    throw new BadRequestException('take 1 to 3 tokens');
  }
  if (tokens.gold > 0) {
    throw new BadRequestException('gold cannot be taken directly');
  }
  const positiveColors = SPLENDOR_GEMS.filter((color) => tokens[color] > 0);
  const isTwoSame = positiveColors.length === 1 && tokens[positiveColors[0]] === 2 && total === 2;
  const isDistinct = positiveColors.length === total && positiveColors.every((color) => tokens[color] === 1);
  if (!isTwoSame && !isDistinct) {
    throw new BadRequestException('take either two same tokens or up to three different tokens');
  }
  for (const color of SPLENDOR_GEMS) {
    if (tokens[color] > session.bank[color]) {
      throw new BadRequestException(`${color} token bank is empty`);
    }
  }
  if (isTwoSame && session.bank[positiveColors[0]] < 4) {
    throw new BadRequestException('two same tokens require at least four in bank');
  }
  const player = session.playerStates[side];
  const discardTokens = sanitizeTokenInput(discardInput, true);
  applySplendorTokenGain(session, player, tokens, discardTokens);
  pushSplendorMove(session, { action: 'take_tokens', side, accountId, detail: { tokens, discardTokens }, source });
  advanceSplendorTurn(session, side);
}

export function applySplendorReserve(
  session: SplendorSession,
  side: SplendorSide,
  accountId: string,
  input: { cardId?: string; tier?: string; discardTokens?: Partial<Record<SplendorToken, number>> },
  source: 'manual' | 'ai' = 'manual',
): void {
  assertSplendorPlayingTurn(session, side);
  const player = session.playerStates[side];
  if (player.reserved.length >= 3) {
    throw new BadRequestException('reserved card limit is 3');
  }
  const goldGain = cloneTokens(ZERO_TOKENS);
  const discardTokens = sanitizeTokenInput(input.discardTokens ?? {}, true);
  if (session.bank.gold > 0) {
    goldGain.gold = 1;
    validateSplendorTokenGain(session, player, goldGain, discardTokens);
  } else if (tokenTotal(discardTokens) > 0) {
    throw new BadRequestException('discard is only allowed when token limit is exceeded');
  }
  let card: SplendorCard | undefined;
  if (input.cardId) {
    card = removeMarketCard(session, input.cardId);
  } else {
    const tier = validateTier(input.tier);
    card = session.decks[tier].shift();
  }
  if (!card) {
    throw new BadRequestException('card is not available');
  }
  player.reserved.push(card);
  if (session.bank.gold > 0) {
    applySplendorTokenGain(session, player, goldGain, discardTokens);
  }
  pushSplendorMove(session, { action: 'reserve', side, accountId, detail: { cardId: card.id, discardTokens }, source });
  advanceSplendorTurn(session, side);
}

export function applySplendorBuy(
  session: SplendorSession,
  side: SplendorSide,
  accountId: string,
  cardId: string,
  source: 'manual' | 'ai' = 'manual',
): void {
  assertSplendorPlayingTurn(session, side);
  const player = session.playerStates[side];
  const reservedIndex = player.reserved.findIndex((item) => item.id === cardId);
  const marketLocation = findMarketCard(session, cardId);
  const card = reservedIndex >= 0 ? player.reserved[reservedIndex] : marketLocation?.card;
  if (!card) {
    throw new BadRequestException('card is not available');
  }
  const payment = splendorPaymentFor(player, card);
  if (!payment) {
    throw new BadRequestException('not enough tokens to buy card');
  }
  for (const token of SPLENDOR_TOKENS) {
    player.tokens[token] -= payment[token];
    session.bank[token] += payment[token];
  }
  if (reservedIndex >= 0) {
    player.reserved.splice(reservedIndex, 1);
  } else if (marketLocation) {
    refillMarketSlot(session, marketLocation.tier, marketLocation.index);
  }
  player.purchased.push(card);
  player.bonuses[card.color] += 1;
  player.score += card.points;
  awardSplendorNoble(session, player);
  pushSplendorMove(session, { action: 'buy', side, accountId, detail: { cardId: card.id, payment }, source });
  advanceSplendorTurn(session, side);
}

export function applySplendorForfeit(session: SplendorSession, side: SplendorSide, accountId: string): void {
  if (session.status !== 'playing') {
    return;
  }
  if (!splendorSeatIsActive(session, side)) {
    // 이미 이탈한 좌석의 중복 forfeit 은 무시한다.
    return;
  }
  const seatStatus = ensureSplendorSeatStatus(session);
  seatStatus[side] = 'forfeited';
  pushSplendorMove(session, { action: 'forfeit', side, accountId });
  const remaining = activeSplendorSides(session);
  if (remaining.length <= 1) {
    // 활성 좌석이 1명 이하가 되면 게임 종료: 남은 1명이 승리(0명이면 무승부).
    const winnerSide = remaining.length === 1 ? remaining[0] : undefined;
    session.status = 'finished';
    session.winnerSide = winnerSide;
    session.winnerAccountId = winnerSide ? session.players[winnerSide] : undefined;
    session.finishReason = 'forfeit';
    session.updatedAt = new Date().toISOString();
    return;
  }
  // 활성 좌석이 2명 이상 남으면 게임을 계속한다. 이탈한 좌석이 현재 턴이었다면 다음 활성 좌석으로 넘긴다.
  if (session.currentTurn === side) {
    advanceSplendorTurn(session, side);
  }
  session.updatedAt = new Date().toISOString();
}

export function applySplendorAiTurn(session: SplendorSession): void {
  if (session.status !== 'playing' || session.currentTurn !== 'opponent' || session.mode !== 'local_ai') {
    return;
  }
  applySplendorAiTurnForSide(session, 'opponent');
}

export function applySplendorAiTurnForSide(
  session: SplendorSession,
  side: SplendorSide,
  difficulty?: Difficulty,
): void {
  if (session.status !== 'playing' || session.currentTurn !== side) {
    return;
  }
  const accountId = session.players[side];
  if (!accountId) {
    return;
  }
  const previousDifficulty = session.aiDifficulty;
  if (difficulty) {
    session.aiDifficulty = difficulty;
  }
  const action = chooseSplendorAiAction(session, side);
  try {
    if (action.kind === 'buy') {
      applySplendorBuy(session, side, accountId, action.card.id, 'ai');
      return;
    }
    if (action.kind === 'reserve') {
      applySplendorReserve(session, side, accountId, { cardId: action.card.id, discardTokens: action.discardTokens }, 'ai');
      return;
    }
    if (action.kind === 'take') {
      applySplendorTakeTokens(session, side, accountId, action.tokens, action.discardTokens, 'ai');
      return;
    }
    advanceSplendorTurn(session, side);
  } finally {
    session.aiDifficulty = previousDifficulty;
  }
}

export function splendorAffordableCards(session: SplendorSession, side: SplendorSide): SplendorCard[] {
  const player = session.playerStates[side];
  const cards = [
    ...session.market['1'],
    ...session.market['2'],
    ...session.market['3'],
    ...player.reserved,
  ];
  return cards.filter((card) => splendorPaymentFor(player, card) !== null);
}

function chooseSplendorAiAction(session: SplendorSession, side: SplendorSide): SplendorAiAction {
  const difficulty = normalizeSplendorAiDifficulty(session.aiDifficulty);
  const actions = splendorAiActions(session, side, difficulty)
    .map((action) => scoreSplendorAiAction(session, side, action, difficulty))
    .sort((a, b) => b.score - a.score);
  if (actions.length === 0) {
    return { kind: 'pass', score: Number.NEGATIVE_INFINITY };
  }
  if (difficulty === 'easy') {
    const immediateWin = actions.find((action) => action.kind === 'buy' && projectedSplendorScoreAfterBuy(session, side, action.card).score >= 15);
    if (immediateWin) {
      return immediateWin;
    }
    const buyActions = actions.filter((action) => action.kind === 'buy');
    if (buyActions.length > 0 && Math.random() < 0.72) {
      return randomFromTop(buyActions, 3);
    }
    const nonPass = actions.filter((action) => action.kind !== 'pass');
    return randomFromTop(nonPass.length > 0 ? nonPass : actions, 4);
  }
  if (difficulty === 'medium' && actions.length > 1 && Math.random() < 0.16) {
    return randomFromTop(actions, Math.min(3, actions.length));
  }
  return actions[0];
}

function splendorAiActions(session: SplendorSession, side: SplendorSide, difficulty: SplendorAiDifficulty): SplendorAiAction[] {
  const actions: SplendorAiAction[] = [];
  const player = session.playerStates[side];
  for (const cardItem of splendorAffordableCards(session, side)) {
    actions.push({ kind: 'buy', card: cardItem, score: 0 });
  }
  if (canReserveSplendorCard(session, side)) {
    const reserveCandidates = visibleSplendorCards(session)
      .filter((cardItem) => difficulty !== 'easy' || cardItem.points > 0)
      .sort((a, b) => splendorCardStrategicValue(session, side, b, difficulty) - splendorCardStrategicValue(session, side, a, difficulty));
    const limit = difficulty === 'hard' ? 12 : difficulty === 'medium' ? 8 : 4;
    for (const cardItem of reserveCandidates.slice(0, limit)) {
      const goldGain = cloneTokens(ZERO_TOKENS);
      if (session.bank.gold > 0) {
        goldGain.gold = 1;
      }
      const discardTokens = splendorAutoDiscardTokens(session, side, goldGain, difficulty);
      if (discardTokens) {
        actions.push({ kind: 'reserve', card: cardItem, discardTokens, score: 0 });
      }
    }
  }
  for (const tokens of splendorTokenTakeCandidates(session, player, difficulty)) {
    const discardTokens = splendorAutoDiscardTokens(session, side, tokens, difficulty);
    if (discardTokens) {
      actions.push({ kind: 'take', tokens, discardTokens, score: 0 });
    }
  }
  actions.push({ kind: 'pass', score: -1000 });
  return actions;
}

function scoreSplendorAiAction(
  session: SplendorSession,
  side: SplendorSide,
  action: SplendorAiAction,
  difficulty: SplendorAiDifficulty,
): SplendorAiAction {
  if (action.kind === 'pass') {
    return action;
  }
  if (action.kind === 'buy') {
    return { ...action, score: scoreSplendorBuyAction(session, side, action.card, difficulty) };
  }
  if (action.kind === 'reserve') {
    return { ...action, score: scoreSplendorReserveAction(session, side, action.card, difficulty) };
  }
  return { ...action, score: scoreSplendorTakeAction(session, side, action.tokens, action.discardTokens, difficulty) };
}

function scoreSplendorBuyAction(
  session: SplendorSession,
  side: SplendorSide,
  cardItem: SplendorCard,
  difficulty: SplendorAiDifficulty,
): number {
  const player = session.playerStates[side];
  const payment = splendorPaymentFor(player, cardItem);
  if (!payment) {
    return Number.NEGATIVE_INFINITY;
  }
  const projection = projectedSplendorScoreAfterBuy(session, side, cardItem);
  const paymentTotal = tokenTotal(payment);
  const targetProgress = splendorTargetProgressScore(session, side, player, { purchasedCard: cardItem }) -
    splendorTargetProgressScore(session, side, player);
  const opponentBlock = cardOpponentDenyValue(session, primarySplendorOpponentSide(session, side), cardItem, difficulty);
  const bonusDemand = splendorColorDemand(session, side, cardItem.color, difficulty);
  const reservedBonus = player.reserved.some((reserved) => reserved.id === cardItem.id) ? 55 : 0;
  const efficiency = cardItem.points > 0 ? (cardItem.points * 180) / Math.max(1, paymentTotal) : 0;
  let score =
    projection.score >= 15 ? 100000 : 0;
  score += projection.gainedPoints * (difficulty === 'easy' ? 520 : difficulty === 'medium' ? 760 : 920);
  score += projection.noblePoints * (difficulty === 'easy' ? 140 : difficulty === 'medium' ? 620 : 820);
  score += bonusDemand * (difficulty === 'easy' ? 20 : difficulty === 'medium' ? 120 : 190);
  score += efficiency;
  score += targetProgress * (difficulty === 'hard' ? 110 : 60);
  score += opponentBlock;
  score += reservedBonus;
  score -= paymentTotal * (difficulty === 'hard' ? 36 : 54);
  score += Number(cardItem.tier) * 18;
  if (difficulty === 'easy') {
    score += Math.random() * 220;
  }
  return score;
}

function scoreSplendorReserveAction(
  session: SplendorSession,
  side: SplendorSide,
  cardItem: SplendorCard,
  difficulty: SplendorAiDifficulty,
): number {
  const player = session.playerStates[side];
  const turns = estimatedSplendorTurnsToBuy(player, cardItem);
  const goldValue = session.bank.gold > 0 ? 180 : 0;
  const opponentDeny = cardOpponentDenyValue(session, primarySplendorOpponentSide(session, side), cardItem, difficulty);
  const targetValue = splendorCardStrategicValue(session, side, cardItem, difficulty);
  const slotPressure = player.reserved.length * (difficulty === 'hard' ? 180 : 120);
  let score = targetValue * (difficulty === 'hard' ? 0.72 : 0.42);
  score += goldValue;
  score += opponentDeny * (difficulty === 'easy' ? 0.2 : difficulty === 'medium' ? 0.75 : 1.1);
  score -= turns * (difficulty === 'hard' ? 70 : 95);
  score -= slotPressure;
  if (difficulty === 'easy') {
    score += Math.random() * 160 - 80;
  }
  return score;
}

function scoreSplendorTakeAction(
  session: SplendorSession,
  side: SplendorSide,
  tokens: SplendorTokenMap,
  discardTokens: SplendorTokenMap,
  difficulty: SplendorAiDifficulty,
): number {
  const player = session.playerStates[side];
  const before = splendorTargetProgressScore(session, side, player);
  const afterPlayer: SplendorPlayerState = {
    ...player,
    tokens: subtractSplendorTokens(addSplendorTokens(player.tokens, tokens), discardTokens),
  };
  const after = splendorTargetProgressScore(session, side, afterPlayer);
  const taken = tokenTotal(tokens);
  let score = (after - before) * (difficulty === 'hard' ? 280 : difficulty === 'medium' ? 210 : 120);
  score += taken * 24;
  for (const color of SPLENDOR_GEMS) {
    if (tokens[color] > 0) {
      score += splendorColorDemand(session, side, color, difficulty) * tokens[color] * (difficulty === 'hard' ? 56 : 32);
    }
  }
  score -= tokenTotal(discardTokens) * (difficulty === 'hard' ? 18 : 8);
  score -= Math.max(0, tokenTotal(afterPlayer.tokens) - 8) * (difficulty === 'hard' ? 28 : 12);
  if (difficulty === 'easy') {
    score += Math.random() * 130;
  }
  return score;
}

function splendorTokenTakeCandidates(
  session: SplendorSession,
  player: SplendorPlayerState,
  difficulty: SplendorAiDifficulty,
): SplendorTokenMap[] {
  const candidates: SplendorTokenMap[] = [];
  const maxDistinct = 3;
  const colors = SPLENDOR_GEMS.filter((color) => session.bank[color] > 0);
  for (let size = 1; size <= maxDistinct; size += 1) {
    for (const combo of combinations(colors, size)) {
      const tokens = cloneTokens(ZERO_TOKENS);
      for (const color of combo) {
        tokens[color] = 1;
      }
      candidates.push(tokens);
    }
  }
  for (const color of SPLENDOR_GEMS) {
    if (session.bank[color] >= 4) {
      const tokens = cloneTokens(ZERO_TOKENS);
      tokens[color] = 2;
      candidates.push(tokens);
    }
  }
  const limit = difficulty === 'hard' ? 48 : difficulty === 'medium' ? 24 : 8;
  return candidates.slice(0, limit);
}

function splendorTargetProgressScore(
  session: SplendorSession,
  side: SplendorSide,
  player: SplendorPlayerState,
  options: { purchasedCard?: SplendorCard } = {},
): number {
  const projectedPlayer = options.purchasedCard
    ? projectedPlayerAfterCard(player, options.purchasedCard)
    : player;
  const candidates = [
    ...visibleSplendorCards(session),
    ...projectedPlayer.reserved,
  ];
  const topCards = candidates
    .map((cardItem) => {
      const turns = estimatedSplendorTurnsToBuy(projectedPlayer, cardItem);
      return splendorCardStrategicValue(session, side, cardItem, 'hard') / (turns + 1);
    })
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((total, value) => total + value, 0);
  const nobleProgress = session.nobles
    .map((nobleItem) => {
      const missing = SPLENDOR_GEMS.reduce((total, color) => total + Math.max(0, nobleItem.cost[color] - projectedPlayer.bonuses[color]), 0);
      return missing === 0 ? nobleItem.points * 180 : nobleItem.points * 80 / (missing + 1);
    })
    .reduce((total, value) => total + value, 0);
  return topCards + nobleProgress;
}

function splendorCardStrategicValue(
  session: SplendorSession,
  side: SplendorSide,
  cardItem: SplendorCard,
  difficulty: SplendorAiDifficulty,
): number {
  const player = session.playerStates[side];
  const turns = estimatedSplendorTurnsToBuy(player, cardItem);
  const bonusDemand = splendorColorDemand(session, side, cardItem.color, difficulty);
  const nobleFit = splendorNobleFit(session, player, cardItem.color);
  const pointWeight = difficulty === 'hard' ? 560 : difficulty === 'medium' ? 430 : 280;
  return cardItem.points * pointWeight +
    Number(cardItem.tier) * 80 +
    bonusDemand * 150 +
    nobleFit * 190 -
    turns * (difficulty === 'hard' ? 170 : 230);
}

function cardOpponentDenyValue(
  session: SplendorSession,
  opponentSide: SplendorSide,
  cardItem: SplendorCard,
  difficulty: SplendorAiDifficulty,
): number {
  if (difficulty === 'easy') {
    return 0;
  }
  const opponent = session.playerStates[opponentSide];
  if (!opponent) {
    return 0;
  }
  const opponentPayment = splendorPaymentFor(opponent, cardItem);
  const opponentProjection = projectedSplendorScoreAfterBuy(session, opponentSide, cardItem);
  if (opponentPayment && opponentProjection.score >= 15) {
    return 50000;
  }
  const turns = estimatedSplendorTurnsToBuy(opponent, cardItem);
  if (turns > (difficulty === 'hard' ? 2 : 1)) {
    return 0;
  }
  return cardItem.points * (difficulty === 'hard' ? 420 : 220) +
    opponentProjection.noblePoints * 260 +
    Math.max(0, 3 - turns) * 90;
}

function projectedSplendorScoreAfterBuy(
  session: SplendorSession,
  side: SplendorSide,
  cardItem: SplendorCard,
): { score: number; gainedPoints: number; noblePoints: number } {
  const player = session.playerStates[side];
  const bonuses = cloneGems(player.bonuses);
  bonuses[cardItem.color] += 1;
  const noble = session.nobles.find((nobleItem) => SPLENDOR_GEMS.every((color) => bonuses[color] >= nobleItem.cost[color]));
  const noblePoints = noble?.points ?? 0;
  const gainedPoints = cardItem.points + noblePoints;
  return { score: player.score + gainedPoints, gainedPoints, noblePoints };
}

function projectedPlayerAfterCard(player: SplendorPlayerState, cardItem: SplendorCard): SplendorPlayerState {
  const bonuses = cloneGems(player.bonuses);
  bonuses[cardItem.color] += 1;
  return {
    ...player,
    bonuses,
    score: player.score + cardItem.points,
  };
}

function estimatedSplendorTurnsToBuy(player: SplendorPlayerState, cardItem: SplendorCard): number {
  let missing = 0;
  for (const color of SPLENDOR_GEMS) {
    const due = Math.max(0, cardItem.cost[color] - player.bonuses[color]);
    missing += Math.max(0, due - player.tokens[color]);
  }
  missing = Math.max(0, missing - player.tokens.gold);
  return Math.ceil(missing / 3);
}

function splendorColorDemand(
  session: SplendorSession,
  side: SplendorSide,
  color: SplendorGem,
  difficulty: SplendorAiDifficulty,
): number {
  const player = session.playerStates[side];
  const visibleDemand = visibleSplendorCards(session)
    .filter((cardItem) => cardItem.cost[color] > player.bonuses[color])
    .map((cardItem) => (cardItem.cost[color] - player.bonuses[color]) * (cardItem.points + Number(cardItem.tier)))
    .reduce((total, value) => total + value, 0);
  const nobleDemand = session.nobles
    .filter((nobleItem) => nobleItem.cost[color] > player.bonuses[color])
    .map((nobleItem) => nobleItem.cost[color] - player.bonuses[color])
    .reduce((total, value) => total + value, 0);
  return visibleDemand * (difficulty === 'hard' ? 1.1 : 0.7) + nobleDemand * 5;
}

function splendorNobleFit(session: SplendorSession, player: SplendorPlayerState, color: SplendorGem): number {
  return session.nobles
    .map((nobleItem) => {
      const before = SPLENDOR_GEMS.reduce((total, gem) => total + Math.max(0, nobleItem.cost[gem] - player.bonuses[gem]), 0);
      const after = Math.max(0, before - (nobleItem.cost[color] > player.bonuses[color] ? 1 : 0));
      return before - after;
    })
    .reduce((total, value) => total + value, 0);
}

function canReserveSplendorCard(session: SplendorSession, side: SplendorSide): boolean {
  const player = session.playerStates[side];
  if (player.reserved.length >= 3) {
    return false;
  }
  if (session.bank.gold <= 0) {
    return true;
  }
  const goldGain = cloneTokens(ZERO_TOKENS);
  goldGain.gold = 1;
  return splendorAutoDiscardTokens(session, side, goldGain, 'hard') !== null;
}

function visibleSplendorCards(session: SplendorSession): SplendorCard[] {
  return [...session.market['1'], ...session.market['2'], ...session.market['3']];
}

function addSplendorTokens(left: SplendorTokenMap, right: SplendorTokenMap): SplendorTokenMap {
  const result = cloneTokens(ZERO_TOKENS);
  for (const token of SPLENDOR_TOKENS) {
    result[token] = left[token] + right[token];
  }
  return result;
}

function subtractSplendorTokens(left: SplendorTokenMap, right: SplendorTokenMap): SplendorTokenMap {
  const result = cloneTokens(ZERO_TOKENS);
  for (const token of SPLENDOR_TOKENS) {
    result[token] = left[token] - right[token];
  }
  return result;
}

function applySplendorTokenGain(
  session: SplendorSession,
  player: SplendorPlayerState,
  gainTokens: SplendorTokenMap,
  discardTokens: SplendorTokenMap,
): void {
  validateSplendorTokenGain(session, player, gainTokens, discardTokens);
  for (const token of SPLENDOR_TOKENS) {
    session.bank[token] -= gainTokens[token];
    player.tokens[token] += gainTokens[token];
    player.tokens[token] -= discardTokens[token];
    session.bank[token] += discardTokens[token];
  }
}

function validateSplendorTokenGain(
  session: SplendorSession,
  player: SplendorPlayerState,
  gainTokens: SplendorTokenMap,
  discardTokens: SplendorTokenMap,
): void {
  for (const token of SPLENDOR_TOKENS) {
    if (gainTokens[token] > session.bank[token]) {
      throw new BadRequestException(`${token} token bank is empty`);
    }
  }
  const grossTotal = tokenTotal(player.tokens) + tokenTotal(gainTokens);
  const discardTotal = tokenTotal(discardTokens);
  const overflow = Math.max(0, grossTotal - 10);
  if (overflow === 0 && discardTotal > 0) {
    throw new BadRequestException('discard is only allowed when token limit is exceeded');
  }
  if (discardTotal !== overflow) {
    throw new BadRequestException(`discard ${overflow} token(s)`);
  }
  for (const token of SPLENDOR_TOKENS) {
    if (discardTokens[token] > player.tokens[token] + gainTokens[token]) {
      throw new BadRequestException(`cannot discard unavailable ${token} token`);
    }
  }
}

function splendorAutoDiscardTokens(
  session: SplendorSession,
  side: SplendorSide,
  gainTokens: SplendorTokenMap,
  difficulty: SplendorAiDifficulty,
): SplendorTokenMap | null {
  const player = session.playerStates[side];
  const grossTotal = tokenTotal(player.tokens) + tokenTotal(gainTokens);
  const overflow = Math.max(0, grossTotal - 10);
  const discardTokens = cloneTokens(ZERO_TOKENS);
  if (overflow === 0) {
    return discardTokens;
  }
  const projectedTokens = addSplendorTokens(player.tokens, gainTokens);
  const tokenValues = SPLENDOR_TOKENS
    .filter((token) => projectedTokens[token] > 0)
    .map((token) => ({
      token,
      value: token === 'gold'
        ? (difficulty === 'hard' ? 130 : 90)
        : splendorColorDemand(session, side, token, difficulty) + (gainTokens[token] > 0 ? 18 : 0),
    }))
    .sort((a, b) => a.value - b.value);
  let remaining = overflow;
  for (const item of tokenValues) {
    if (remaining <= 0) {
      break;
    }
    const count = Math.min(projectedTokens[item.token], remaining);
    discardTokens[item.token] = count;
    remaining -= count;
  }
  return remaining === 0 ? discardTokens : null;
}

function oppositeSplendorSide(side: SplendorSide): SplendorSide {
  return side === 'challenger' ? 'opponent' : 'challenger';
}

function primarySplendorOpponentSide(session: SplendorSession, side: SplendorSide): SplendorSide {
  const directOpponent = oppositeSplendorSide(side);
  if (session.playerStates[directOpponent]) {
    return directOpponent;
  }
  const opponents = splendorTurnOrder(session).filter((candidate) => candidate !== side && Boolean(session.playerStates[candidate]));
  return opponents.sort((left, right) => session.playerStates[right].score - session.playerStates[left].score)[0] ?? side;
}

function normalizeSplendorAiDifficulty(value: unknown): SplendorAiDifficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [[]];
  }
  if (items.length < size) {
    return [];
  }
  const result: T[][] = [];
  for (let index = 0; index <= items.length - size; index += 1) {
    for (const tail of combinations(items.slice(index + 1), size - 1)) {
      result.push([items[index], ...tail]);
    }
  }
  return result;
}

function randomFromTop<T>(items: T[], count: number): T {
  const capped = Math.max(1, Math.min(items.length, count));
  return items[Math.floor(Math.random() * capped)];
}

function assertSplendorPlayingTurn(session: SplendorSession, side: SplendorSide): void {
  if (session.status !== 'playing') {
    throw new BadRequestException('game is finished');
  }
  if (session.pause?.active) {
    throw new BadRequestException('game is paused');
  }
  if (session.currentTurn !== side) {
    throw new BadRequestException('not your turn');
  }
}

function pushSplendorMove(
  session: SplendorSession,
  move: {
    action: 'take_tokens' | 'reserve' | 'buy' | 'forfeit';
    side: SplendorSide;
    accountId: string;
    detail?: unknown;
    source?: 'manual' | 'ai';
  },
): void {
  session.moves.push({ ...move, createdAt: new Date().toISOString() });
  session.updatedAt = new Date().toISOString();
}

function advanceSplendorTurn(session: SplendorSession, side: SplendorSide): void {
  const score = session.playerStates[side].score;
  if (score >= 15 && !session.finalRoundStartedBy) {
    session.finalRoundStartedBy = side;
  }
  const nextSide = nextSplendorSide(session, side);
  // 마지막 라운드는 활성 좌석 기준 첫 좌석으로 순번이 돌아오면 종료된다(이탈 좌석은 스킵되므로).
  const firstSide = activeSplendorSides(session)[0];
  if (session.finalRoundStartedBy && nextSide === firstSide) {
    finishSplendor(session);
    return;
  }
  session.currentTurn = nextSide;
}

function finishSplendor(session: SplendorSession): void {
  session.status = 'finished';
  let winner: SplendorSide | undefined;
  let tied = false;
  // 자연 종료 시 승자는 활성 좌석 중에서만 가린다(이탈/포기 좌석은 승자 후보에서 제외).
  for (const side of activeSplendorSides(session)) {
    const candidate = session.playerStates[side];
    if (!candidate) {
      continue;
    }
    if (!winner) {
      winner = side;
      tied = false;
      continue;
    }
    const current = session.playerStates[winner];
    if (
      candidate.score > current.score ||
      (candidate.score === current.score &&
        candidate.purchased.length < current.purchased.length)
    ) {
      winner = side;
      tied = false;
    } else if (
      candidate.score === current.score &&
      candidate.purchased.length === current.purchased.length
    ) {
      tied = true;
    }
  }
  if (tied) {
    winner = undefined;
  }
  session.winnerSide = winner;
  session.winnerAccountId = winner ? session.players[winner] : undefined;
  session.finishReason = winner ? 'score' : 'draw';
  session.updatedAt = new Date().toISOString();
}

function splendorTurnOrder(session: SplendorSession): SplendorSide[] {
  const explicit = session.turnOrder?.filter((side) => Boolean(session.players[side]));
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  return Object.keys(session.players);
}

function nextSplendorSide(session: SplendorSession, side: SplendorSide): SplendorSide {
  // 좌석 인덱스는 전체 turnOrder 기준으로 유지하되, 다음 턴은 활성 좌석만 받는다(M4 — left/forfeited 스킵).
  const turnOrder = splendorTurnOrder(session);
  const start = turnOrder.indexOf(side);
  if (start < 0) {
    return activeSplendorSides(session)[0] ?? turnOrder[0] ?? side;
  }
  for (let step = 1; step <= turnOrder.length; step += 1) {
    const candidate = turnOrder[(start + step) % turnOrder.length];
    if (splendorSeatIsActive(session, candidate)) {
      return candidate;
    }
  }
  return side;
}

function ensureSplendorSeatStatus(session: SplendorSession): Record<SplendorSide, SplendorSeatStatus> {
  if (!session.seatStatus) {
    session.seatStatus = Object.fromEntries(
      splendorTurnOrder(session).map((side) => [side, 'active' as SplendorSeatStatus]),
    );
  }
  return session.seatStatus;
}

function splendorSeatIsActive(session: SplendorSession, side: SplendorSide): boolean {
  // seatStatus 가 없는 기존 세션은 전부 active 로 간주한다(하위호환).
  const status = session.seatStatus?.[side];
  return status === undefined || status === 'active';
}

function activeSplendorSides(session: SplendorSession): SplendorSide[] {
  return splendorTurnOrder(session).filter((side) => splendorSeatIsActive(session, side));
}

function splendorPaymentFor(player: SplendorPlayerState, card: SplendorCard): SplendorTokenMap | null {
  const payment = cloneTokens(ZERO_TOKENS);
  let goldNeeded = 0;
  for (const color of SPLENDOR_GEMS) {
    const due = Math.max(0, card.cost[color] - player.bonuses[color]);
    const paidColor = Math.min(player.tokens[color], due);
    payment[color] = paidColor;
    goldNeeded += due - paidColor;
  }
  if (goldNeeded > player.tokens.gold) {
    return null;
  }
  payment.gold = goldNeeded;
  return payment;
}

function awardSplendorNoble(session: SplendorSession, player: SplendorPlayerState): void {
  const index = session.nobles.findIndex((noble) => SPLENDOR_GEMS.every((color) => player.bonuses[color] >= noble.cost[color]));
  if (index < 0) {
    return;
  }
  const [noble] = session.nobles.splice(index, 1);
  player.nobles.push(noble);
  player.score += noble.points;
}

function findMarketCard(session: SplendorSession, cardId: string): { tier: SplendorTier; index: number; card: SplendorCard } | undefined {
  for (const tier of SPLENDOR_TIERS) {
    const index = session.market[tier].findIndex((item) => item.id === cardId);
    if (index >= 0) {
      return { tier, index, card: session.market[tier][index] };
    }
  }
  return undefined;
}

function removeMarketCard(session: SplendorSession, cardId: string): SplendorCard | undefined {
  const location = findMarketCard(session, cardId);
  if (!location) {
    return undefined;
  }
  const [card] = session.market[location.tier].splice(location.index, 1);
  refillMarket(session, location.tier);
  return card;
}

function refillMarket(session: SplendorSession, tier: SplendorTier): void {
  const next = session.decks[tier].shift();
  if (next) {
    session.market[tier].push(next);
  }
}

function refillMarketSlot(session: SplendorSession, tier: SplendorTier, index: number): void {
  const next = session.decks[tier].shift();
  if (next) {
    session.market[tier].splice(index, 1, next);
    return;
  }
  session.market[tier].splice(index, 1);
}

function drawCards(deck: SplendorCard[], count: number): SplendorCard[] {
  const cards: SplendorCard[] = [];
  while (cards.length < count && deck.length > 0) {
    const card = deck.shift();
    if (card) {
      cards.push(card);
    }
  }
  return cards;
}

function sanitizeTokenInput(input: Partial<Record<SplendorToken, number>>, allowGold: boolean): SplendorTokenMap {
  const tokens = cloneTokens(ZERO_TOKENS);
  for (const token of SPLENDOR_TOKENS) {
    const value = Math.trunc(Number(input[token] ?? 0));
    if (value < 0) {
      throw new BadRequestException('token count cannot be negative');
    }
    if (token === 'gold' && value > 0 && !allowGold) {
      throw new BadRequestException('gold is not allowed for this action');
    }
    tokens[token] = value;
  }
  return tokens;
}

function validateTier(value: unknown): SplendorTier {
  if (value === '1' || value === 1) {
    return '1';
  }
  if (value === '2' || value === 2) {
    return '2';
  }
  if (value === '3' || value === 3) {
    return '3';
  }
  throw new BadRequestException('tier must be 1, 2, or 3');
}

function tokenTotal(tokens: SplendorTokenMap): number {
  return SPLENDOR_TOKENS.reduce((total, token) => total + tokens[token], 0);
}

function cloneTokens(tokens: SplendorTokenMap): SplendorTokenMap {
  return { white: tokens.white, blue: tokens.blue, green: tokens.green, red: tokens.red, black: tokens.black, gold: tokens.gold };
}

function cloneGems(gems: SplendorGemCost): SplendorGemCost {
  return { white: gems.white, blue: gems.blue, green: gems.green, red: gems.red, black: gems.black };
}

function createPlayerState(): SplendorPlayerState {
  return {
    tokens: cloneTokens(ZERO_TOKENS),
    bonuses: cloneGems(ZERO_GEMS),
    reserved: [],
    purchased: [],
    nobles: [],
    score: 0,
  };
}

function cost(values: Partial<Record<SplendorGem, number>>): SplendorGemCost {
  return { ...ZERO_GEMS, ...values };
}

export function createSplendorDecks(): Record<SplendorTier, SplendorCard[]> {
  return {
    '1': [
      card('splendor-00', '1', 'white', 0, { blue: 2, green: 1 }, 'ring'),
      card('splendor-01', '1', 'white', 0, { black: 3, white: 1, red: 1 }, 'ship'),
      card('splendor-02', '1', 'white', 0, { black: 1, white: 1, blue: 1, green: 1 }, 'emerald'),
      card('splendor-03', '1', 'white', 0, { white: 2, red: 2 }, 'ruby'),
      card('splendor-04', '1', 'white', 0, { black: 1, white: 2, blue: 1, green: 1 }, 'sword'),
      card('splendor-05', '1', 'white', 0, { black: 2, white: 2, green: 1 }, 'pearl'),
      card('splendor-06', '1', 'white', 0, { white: 3 }, 'tower'),
      card('splendor-07', '1', 'white', 0, { white: 4 }, 'forest'),
      card('splendor-08', '1', 'green', 0, { red: 2, blue: 2 }, 'chest'),
      card('splendor-09', '1', 'green', 0, { red: 3 }, 'dagger'),
      card('splendor-10', '1', 'green', 0, { black: 2, red: 2, blue: 1 }, 'crown'),
      card('splendor-11', '1', 'green', 0, { black: 1, white: 1, red: 1, blue: 1 }, 'scope'),
      card('splendor-12', '1', 'green', 0, { black: 2, white: 1, red: 1, blue: 1 }, 'ring'),
      card('splendor-13', '1', 'green', 0, { white: 1, blue: 3, green: 1 }, 'ship'),
      card('splendor-14', '1', 'green', 0, { white: 2, blue: 1 }, 'emerald'),
      card('splendor-15', '1', 'green', 1, { black: 4 }, 'ruby'),
      card('splendor-16', '1', 'black', 0, { black: 1, red: 3, green: 1 }, 'sword'),
      card('splendor-17', '1', 'black', 0, { red: 1, green: 2 }, 'pearl'),
      card('splendor-18', '1', 'black', 0, { green: 3 }, 'tower'),
      card('splendor-19', '1', 'black', 0, { white: 1, red: 1, blue: 1, green: 1 }, 'forest'),
      card('splendor-20', '1', 'black', 0, { white: 1, red: 1, blue: 2, green: 1 }, 'chest'),
      card('splendor-21', '1', 'black', 0, { white: 2, red: 1, blue: 2 }, 'dagger'),
      card('splendor-22', '1', 'black', 0, { white: 2, green: 2 }, 'crown'),
      card('splendor-23', '1', 'black', 1, { blue: 4 }, 'scope'),
      card('splendor-24', '1', 'red', 0, { blue: 2, green: 1 }, 'ring'),
      card('splendor-25', '1', 'red', 0, { black: 3, white: 1, red: 1 }, 'ship'),
      card('splendor-26', '1', 'red', 0, { black: 1, white: 1, blue: 1, green: 1 }, 'emerald'),
      card('splendor-27', '1', 'red', 0, { white: 2, red: 2 }, 'ruby'),
      card('splendor-28', '1', 'red', 0, { black: 1, white: 2, blue: 1, green: 1 }, 'sword'),
      card('splendor-29', '1', 'red', 0, { black: 2, white: 2, green: 1 }, 'pearl'),
      card('splendor-30', '1', 'red', 0, { white: 3 }, 'tower'),
      card('splendor-31', '1', 'red', 1, { white: 4 }, 'forest'),
      card('splendor-32', '1', 'blue', 0, { black: 3 }, 'chest'),
      card('splendor-33', '1', 'blue', 0, { black: 2, green: 2 }, 'dagger'),
      card('splendor-34', '1', 'blue', 0, { red: 1, blue: 1, green: 3 }, 'crown'),
      card('splendor-35', '1', 'blue', 0, { black: 2, white: 1 }, 'scope'),
      card('splendor-36', '1', 'blue', 0, { black: 1, white: 1, red: 1, green: 1 }, 'ring'),
      card('splendor-37', '1', 'blue', 0, { black: 1, white: 1, red: 2, green: 1 }, 'ship'),
      card('splendor-38', '1', 'blue', 0, { white: 1, red: 2, green: 2 }, 'emerald'),
      card('splendor-39', '1', 'blue', 1, { red: 4 }, 'ruby'),
    ],
    '2': [
      card('splendor-40', '2', 'white', 0, { black: 3, red: 2, blue: 3 }, 'sword'),
      card('splendor-41', '2', 'white', 0, { black: 3, white: 2, red: 2 }, 'pearl'),
      card('splendor-42', '2', 'white', 2, { black: 5 }, 'tower'),
      card('splendor-43', '2', 'white', 2, { white: 1, blue: 4, green: 2 }, 'forest'),
      card('splendor-44', '2', 'white', 2, { black: 5, white: 3 }, 'chest'),
      card('splendor-45', '2', 'white', 3, { red: 6 }, 'dagger'),
      card('splendor-46', '2', 'green', 1, { black: 1, white: 2, blue: 3 }, 'crown'),
      card('splendor-47', '2', 'green', 1, { black: 1, white: 3, red: 3, green: 2 }, 'scope'),
      card('splendor-48', '2', 'green', 2, { blue: 5, green: 3 }, 'ring'),
      card('splendor-49', '2', 'green', 2, { green: 5 }, 'ship'),
      card('splendor-50', '2', 'green', 2, { black: 1, white: 4, blue: 2 }, 'emerald'),
      card('splendor-51', '2', 'green', 3, { green: 6 }, 'ruby'),
      card('splendor-52', '2', 'black', 1, { white: 3, blue: 2, green: 2 }, 'sword'),
      card('splendor-53', '2', 'black', 1, { black: 2, white: 3, green: 3 }, 'pearl'),
      card('splendor-54', '2', 'black', 2, { red: 2, blue: 1, green: 4 }, 'tower'),
      card('splendor-55', '2', 'black', 2, { red: 3, green: 5 }, 'forest'),
      card('splendor-56', '2', 'black', 2, { white: 5 }, 'chest'),
      card('splendor-57', '2', 'black', 3, { black: 6 }, 'dagger'),
      card('splendor-58', '2', 'red', 1, { black: 3, red: 2, blue: 3 }, 'crown'),
      card('splendor-59', '2', 'red', 1, { black: 3, white: 2, red: 2 }, 'scope'),
      card('splendor-60', '2', 'red', 2, { black: 5 }, 'ring'),
      card('splendor-61', '2', 'red', 2, { white: 1, blue: 4, green: 2 }, 'ship'),
      card('splendor-62', '2', 'red', 2, { black: 5, white: 3 }, 'emerald'),
      card('splendor-63', '2', 'red', 3, { red: 6 }, 'ruby'),
      card('splendor-64', '2', 'blue', 1, { red: 3, blue: 2, green: 2 }, 'sword'),
      card('splendor-65', '2', 'blue', 1, { black: 3, blue: 2, green: 3 }, 'pearl'),
      card('splendor-66', '2', 'blue', 2, { blue: 5 }, 'tower'),
      card('splendor-67', '2', 'blue', 2, { black: 4, white: 2, red: 1 }, 'forest'),
      card('splendor-68', '2', 'blue', 2, { white: 5, blue: 3 }, 'chest'),
      card('splendor-69', '2', 'blue', 3, { blue: 6 }, 'dagger'),
    ],
    '3': [
      card('splendor-70', '3', 'white', 3, { black: 3, white: 3, blue: 5, green: 3 }, 'crown'),
      card('splendor-71', '3', 'white', 4, { red: 3, blue: 3, green: 6 }, 'scope'),
      card('splendor-72', '3', 'white', 4, { green: 7 }, 'ring'),
      card('splendor-73', '3', 'white', 5, { red: 3, green: 7 }, 'ship'),
      card('splendor-74', '3', 'green', 3, { black: 3, white: 5, red: 3, blue: 3 }, 'emerald'),
      card('splendor-75', '3', 'green', 4, { blue: 7 }, 'ruby'),
      card('splendor-76', '3', 'green', 4, { white: 3, blue: 6, green: 3 }, 'sword'),
      card('splendor-77', '3', 'green', 5, { blue: 7 }, 'pearl'),
      card('splendor-78', '3', 'black', 3, { white: 3, red: 3, blue: 3, green: 5 }, 'tower'),
      card('splendor-79', '3', 'black', 4, { red: 7 }, 'forest'),
      card('splendor-80', '3', 'black', 4, { black: 3, red: 6, green: 3 }, 'chest'),
      card('splendor-81', '3', 'black', 5, { black: 3, red: 7 }, 'dagger'),
      card('splendor-82', '3', 'red', 3, { black: 3, white: 3, blue: 5, green: 3 }, 'crown'),
      card('splendor-83', '3', 'red', 4, { red: 3, blue: 3, green: 6 }, 'scope'),
      card('splendor-84', '3', 'red', 4, { green: 7 }, 'ring'),
      card('splendor-85', '3', 'red', 5, { red: 3, green: 7 }, 'ship'),
      card('splendor-86', '3', 'blue', 3, { black: 5, white: 3, red: 3, green: 3 }, 'emerald'),
      card('splendor-87', '3', 'blue', 4, { black: 3, white: 6, blue: 3 }, 'ruby'),
      card('splendor-88', '3', 'blue', 4, { white: 7 }, 'sword'),
      card('splendor-89', '3', 'blue', 5, { white: 7, blue: 3 }, 'pearl'),
    ],
  };
}

function createSplendorNobles(): SplendorNoble[] {
  return [
    noble('noble-magellan', { white: 3, red: 3, black: 3 }, 'magellan'),
    noble('noble-teresa', { blue: 3, green: 3, red: 3 }, 'teresa'),
    noble('noble-victoria', { green: 4, red: 4 }, 'victoria'),
    noble('noble-peter', { red: 4, black: 4 }, 'peter'),
    noble('noble-isabella', { white: 3, blue: 3, green: 3 }, 'isabella'),
    noble('noble-korina', { white: 3, blue: 3, black: 3 }, 'korina'),
    noble('noble-pastor', { white: 4, blue: 4 }, 'pastor'),
    noble('noble-legaspi', { green: 3, red: 3, black: 3 }, 'legaspi'),
    noble('noble-joan', { white: 4, black: 4 }, 'joan'),
    noble('noble-sultan', { blue: 4, green: 4 }, 'sultan'),
  ];
}

function card(id: string, tier: SplendorTier, color: SplendorGem, points: number, costValues: Partial<Record<SplendorGem, number>>, art: string): SplendorCard {
  return { id, tier, color, points, cost: cost(costValues), art };
}

function noble(id: string, costValues: Partial<Record<SplendorGem, number>>, art: string): SplendorNoble {
  return { id, points: 3, cost: cost(costValues), art };
}

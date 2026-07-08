import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { createSeededRng, cryptoSeed } from './engine/rng';
import {
  BilliardsBallInput,
  ContactEvent,
  DeterministicRng,
  simulateBilliards,
  BALL_RADIUS,
  TABLE_HEIGHT,
  TABLE_WIDTH,
} from './billiards-physics';
import { evaluateFourBall } from './carom-rules';
import { Difficulty, GameMode, MatchPauseState } from './games.types';

// ---------------------------------------------------------------------------
// 상수 / 초기 배치
// ---------------------------------------------------------------------------

export const FOUR_BALL_STATE_VERSION = 1;
/** 목표 점수 옵션(내부 단위). 클라 표기는 ×10. */
export const FOUR_BALL_TARGET_OPTIONS = [3, 5, 8, 10, 15, 20] as const;
/** 무한 게임 방지용 최대 샷 수. 도달 시 잔여가 적은 쪽 승. */
export const FOUR_BALL_MAX_TURNS = 200;
/** AI 후보 샷 평가 시간 예산(ms). */
export const FOUR_BALL_AI_BUDGET_MS = 1_200;

/** 미스큐 없는 평가용 RNG(후보 시뮬은 재현/공정성 무관). */
const NO_MISCUE_RNG: DeterministicRng = { next: () => 0.999999 };

export type FourBallBallKey = 'cue0' | 'cue1' | 'red1' | 'red2';
const FOUR_BALL_BALL_KEYS: FourBallBallKey[] = ['cue0', 'cue1', 'red1', 'red2'];
const FOUR_BALL_RED_KEYS: FourBallBallKey[] = ['red1', 'red2'];

export interface FourBallVec {
  x: number;
  y: number;
}

/** 표준 사구 초구 배치(가로 중앙선상): 빨강 2개 상단/중앙, 수구 2개 하단 대칭. */
export function initialFourBallBalls(): Record<FourBallBallKey, FourBallVec> {
  return {
    red1: { x: 500, y: 130 },
    red2: { x: 500, y: 250 },
    cue0: { x: 400, y: 370 },
    cue1: { x: 600, y: 370 },
  };
}

export interface FourBallShotParams {
  angle: number;
  power: number;
  tipX: number;
  tipY: number;
}

export interface FourBallShotOutcome {
  scored: boolean;
  foul: boolean;
  threeCushion: boolean;
  cushions: number;
  ballsHit: string[];
  continueTurn: boolean;
}

export interface FourBallShotRecord {
  seat: number;
  params: FourBallShotParams;
  miscue: boolean;
  outcome: FourBallShotOutcome;
  events: ContactEvent[];
  animation: { frameMs: number; frames: Array<Record<FourBallBallKey, FourBallVec>> };
  source?: 'manual' | 'ai' | 'timeout';
}

export interface FourBallSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: Difficulty;
  status: 'selecting' | 'playing' | 'finished';
  players: Record<'cue0' | 'cue1', string>;
  balls: Record<FourBallBallKey, FourBallVec>;
  currentSeat: number;
  firstSeat?: number;
  targets: Record<string, number>;
  remaining: Record<string, number>;
  needsThreeCushionFinish: Record<string, boolean>;
  turnCount: number;
  /** 시드 RNG (삑사리 재현용). viewFor 에는 절대 노출하지 않는다. */
  rngSeed: string;
  lastShot?: FourBallShotRecord;
  lastAim?: { seat: number; angle: number; power?: number; tipX?: number; tipY?: number; updatedAt: string };
  winnerSeat?: number;
  winnerAccountId?: string;
  gameWinner?: { seat: number; accountId: string; reason: 'completed' | 'opponent_left' };
  finishReason?: string;
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  networkGraceAccountId?: string;
  opponentLeftAt?: string;
  pause?: MatchPauseState;
  roomId?: string;
  roomCode?: string;
  roomMode?: string;
  roomPlayers?: Array<Record<string, unknown>>;
  seatStatus?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 엔진
// ---------------------------------------------------------------------------

export const FOUR_BALL_ENGINE: GameEngine<FourBallSession> = {
  descriptor: {
    key: 'four_ball',
    title: 'Four Ball',
    minPlayers: 2,
    maxPlayers: 2,
    modes: ['local_ai', 'friend_match'],
    turnType: 'turnBased',
    hiddenInfo: false,
    supportsAi: true,
    supportsMatchSave: true,
    turnTimerSeconds: 60,
    graceSeconds: 60,
    status: 'playable',
  },
  stateVersion: FOUR_BALL_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): FourBallSession {
    return createFourBallState(
      players[0]?.accountId ?? '',
      players[1]?.accountId ?? '',
      fourBallModeFromConfig(config.mode),
      fourBallDifficultyFromConfig(config.aiDifficulty),
      typeof config.rngSeed === 'string' ? config.rngSeed : undefined,
      typeof config.id === 'string' ? config.id : '',
    );
  },
  applyAction(state: FourBallSession, seat: number, action: GameAction) {
    const payload = action.payload ?? {};
    if (action.type === 'select_target') {
      selectFourBallTarget(state, seat, Number(payload.target));
      return { state, events: [{ type: 'four_ball.action.played', payload: { phase: state.status } }] };
    }
    if (action.type === 'aim') {
      updateFourBallAim(state, seat, payload);
      return { state, events: [{ type: 'four_ball.aim.updated', payload: state.lastAim }] };
    }
    if (action.type === 'shoot') {
      const record = applyFourBallShot(state, seat, {
        angle: Number(payload.angle),
        power: Number(payload.power),
        tipX: Number(payload.tipX),
        tipY: Number(payload.tipY),
      }, 'manual');
      return { state, events: [{ type: 'four_ball.action.played', payload: { shot: record } }] };
    }
    if (action.type === 'forfeit') {
      applyFourBallForfeit(state, seat);
      return { state, events: [{ type: 'four_ball.action.played', payload: { phase: state.status } }] };
    }
    throw new BadRequestException('unsupported four_ball action');
  },
  viewFor(state: FourBallSession, seat: number | 'spectator') {
    return fourBallViewFor(state, typeof seat === 'number' ? seat : undefined);
  },
  finishInfo(state: FourBallSession) {
    if (state.status !== 'finished') {
      return null;
    }
    return { status: 'finished', winnerSeat: state.winnerSeat, reason: state.finishReason };
  },
  aiAction(state: FourBallSession, seat: number, difficulty: Difficulty): GameAction {
    if (state.status === 'selecting') {
      return { type: 'select_target', payload: { target: aiTargetForDifficulty(difficulty) } };
    }
    const shot = chooseFourBallAiShot(state, seat, difficulty) ?? randomFourBallShot(state, seat);
    return { type: 'shoot', payload: { ...shot } };
  },
};

// ---------------------------------------------------------------------------
// 생성 / 셀렉팅
// ---------------------------------------------------------------------------

export function createFourBallState(
  cue0AccountId: string,
  cue1AccountId: string,
  mode: GameMode,
  difficulty: Difficulty = 'medium',
  rngSeed?: string,
  id = '',
): FourBallSession {
  const now = new Date().toISOString();
  return {
    id,
    mode,
    aiDifficulty: mode === 'local_ai' ? difficulty : undefined,
    status: 'selecting',
    players: { cue0: cue0AccountId, cue1: cue1AccountId },
    balls: initialFourBallBalls(),
    currentSeat: 0,
    targets: {},
    remaining: {},
    needsThreeCushionFinish: { seat0: false, seat1: false },
    turnCount: 0,
    rngSeed: rngSeed && rngSeed.length > 0 ? rngSeed : cryptoSeed(),
    createdAt: now,
    updatedAt: now,
  };
}

export function selectFourBallTarget(session: FourBallSession, seat: number, target: number): void {
  if (session.status !== 'selecting') {
    throw new BadRequestException('target selection is closed');
  }
  if (!FOUR_BALL_TARGET_OPTIONS.includes(target as (typeof FOUR_BALL_TARGET_OPTIONS)[number])) {
    throw new BadRequestException('target must be one of the offered options');
  }
  const seatKey = seatKeyFor(seat);
  session.targets[seatKey] = target;
  if (session.targets.seat0 !== undefined && session.targets.seat1 !== undefined) {
    startFourBallPlay(session);
  }
  session.updatedAt = new Date().toISOString();
}

function startFourBallPlay(session: FourBallSession): void {
  const rng = createSeededRng(`${session.rngSeed}:first`);
  const first = rng.next() < 0.5 ? 0 : 1;
  session.firstSeat = first;
  session.currentSeat = first;
  session.remaining = {
    seat0: session.targets.seat0,
    seat1: session.targets.seat1,
  };
  session.needsThreeCushionFinish = { seat0: false, seat1: false };
  session.status = 'playing';
}

// ---------------------------------------------------------------------------
// 조준 중계
// ---------------------------------------------------------------------------

export function updateFourBallAim(session: FourBallSession, seat: number, payload: Record<string, unknown>): void {
  if (session.status !== 'playing') {
    throw new BadRequestException('game is not playing');
  }
  if (session.currentSeat !== seat) {
    throw new BadRequestException('not your turn');
  }
  session.lastAim = {
    seat,
    angle: Number(payload.angle),
    power: payload.power === undefined ? undefined : clamp(Number(payload.power), 0, 1),
    tipX: payload.tipX === undefined ? undefined : clamp(Number(payload.tipX), -1, 1),
    tipY: payload.tipY === undefined ? undefined : clamp(Number(payload.tipY), -1, 1),
    updatedAt: new Date().toISOString(),
  };
  session.updatedAt = session.lastAim.updatedAt;
}

// ---------------------------------------------------------------------------
// 샷 / 판정 / 턴
// ---------------------------------------------------------------------------

export function applyFourBallShot(
  session: FourBallSession,
  seat: number,
  params: FourBallShotParams,
  source: 'manual' | 'ai' | 'timeout',
): FourBallShotRecord {
  if (session.status !== 'playing') {
    throw new BadRequestException('game is not playing');
  }
  if (session.currentSeat !== seat) {
    throw new BadRequestException('not your turn');
  }
  const angle = finiteNumber(params.angle, 0);
  const power = clamp(finiteNumber(params.power, 0), 0, 1);
  const tipX = clamp(finiteNumber(params.tipX, 0), -1, 1);
  const tipY = clamp(finiteNumber(params.tipY, 0), -1, 1);

  const cueId = cueKeyFor(seat);
  const opponentCueId = cueKeyFor(1 - seat);
  const rng = createSeededRng(`${session.rngSeed}:${session.turnCount}`);
  session.turnCount += 1;

  const inputBalls: BilliardsBallInput[] = FOUR_BALL_BALL_KEYS.map((key) => ({
    id: key,
    x: session.balls[key].x,
    y: session.balls[key].y,
  }));
  const sim = simulateBilliards(inputBalls, { ballId: cueId, angle, power, tipX, tipY }, rng);
  for (const key of FOUR_BALL_BALL_KEYS) {
    session.balls[key] = sim.finalPositions[key];
  }

  const carom = evaluateFourBall(sim.events, {
    cueBallId: cueId,
    opponentCueId,
    redBallIds: FOUR_BALL_RED_KEYS,
  });

  const seatKey = seatKeyFor(seat);
  const finishing = session.needsThreeCushionFinish[seatKey] === true;
  let continueTurn = false;
  let scored = false;
  let foul = false;

  if (finishing) {
    // 마무리 샷: 빨강 2개 + 쿠션 3회 성공 시에만 승리, 실패해도 감점 없음.
    if (carom.scored && carom.threeCushion) {
      scored = true;
      finishFourBall(session, seat, 'completed');
    } else {
      switchFourBallTurn(session, seat);
    }
  } else if (carom.foul) {
    // 파울(상대 수구 접촉): 자기 잔여 +1, 턴 교대.
    foul = true;
    session.remaining[seatKey] += 1;
    switchFourBallTurn(session, seat);
  } else if (carom.scored) {
    // 성공: 잔여 -1 + 연속 턴. 잔여 0 도달 시 마무리 쓰리쿠션 필요.
    scored = true;
    session.remaining[seatKey] = Math.max(0, session.remaining[seatKey] - 1);
    if (session.remaining[seatKey] === 0) {
      session.needsThreeCushionFinish[seatKey] = true;
    }
    continueTurn = true;
  } else {
    // 실패(빨강 0~1개): 턴 교대.
    switchFourBallTurn(session, seat);
  }

  // 무한 게임 방지 캡.
  if (session.status === 'playing' && session.turnCount >= FOUR_BALL_MAX_TURNS) {
    finishFourBallByRemaining(session);
  }

  const outcome: FourBallShotOutcome = {
    scored,
    foul,
    threeCushion: carom.threeCushion,
    cushions: carom.cushions,
    ballsHit: carom.ballsHit,
    continueTurn,
  };
  const record: FourBallShotRecord = {
    seat,
    params: { angle, power, tipX, tipY },
    miscue: sim.miscue,
    outcome,
    events: sim.events,
    animation: { frameMs: sim.frameMs, frames: sim.frames as Array<Record<FourBallBallKey, FourBallVec>> },
    source,
  };
  session.lastShot = record;
  delete session.lastAim;
  session.updatedAt = new Date().toISOString();
  return record;
}

export function applyFourBallForfeit(session: FourBallSession, seat: number): void {
  if (session.status === 'finished') {
    return;
  }
  finishFourBall(session, 1 - seat, 'forfeit');
}

function switchFourBallTurn(session: FourBallSession, seat: number): void {
  session.currentSeat = 1 - seat;
}

function finishFourBall(session: FourBallSession, winnerSeat: number, reason: string): void {
  session.status = 'finished';
  session.winnerSeat = winnerSeat;
  const cueKey = cueKeyFor(winnerSeat);
  session.winnerAccountId = session.players[cueKey];
  session.finishReason = reason;
  session.gameWinner = {
    seat: winnerSeat,
    accountId: session.players[cueKey],
    reason: reason === 'opponent_left' || reason === 'forfeit' || reason === 'disconnect' ? 'opponent_left' : 'completed',
  };
  session.updatedAt = new Date().toISOString();
}

function finishFourBallByRemaining(session: FourBallSession): void {
  const remaining0 = session.remaining.seat0 ?? Number.POSITIVE_INFINITY;
  const remaining1 = session.remaining.seat1 ?? Number.POSITIVE_INFINITY;
  const winnerSeat = remaining0 === remaining1 ? (session.firstSeat ?? 0) : remaining0 < remaining1 ? 0 : 1;
  finishFourBall(session, winnerSeat, 'turn_cap');
}

// ---------------------------------------------------------------------------
// viewFor (전부 공개, rngSeed 만 숨김)
// ---------------------------------------------------------------------------

export function fourBallViewFor(session: FourBallSession, seat?: number): Record<string, unknown> {
  return {
    id: session.id,
    rev: session.rev,
    mode: session.mode,
    status: session.status,
    phase: session.status,
    players: session.players,
    balls: session.balls,
    cueBallOf: { seat0: 'cue0', seat1: 'cue1' },
    table: { width: TABLE_WIDTH, height: TABLE_HEIGHT, ballRadius: BALL_RADIUS },
    targetOptions: [...FOUR_BALL_TARGET_OPTIONS],
    targets: session.targets,
    remaining: session.remaining,
    needsThreeCushionFinish: session.needsThreeCushionFinish,
    currentSeat: session.currentSeat,
    currentTurn: cueKeyFor(session.currentSeat),
    firstSeat: session.firstSeat,
    mySeat: seat,
    lastShot: session.lastShot,
    lastAim: session.lastAim,
    turnStartedAt: session.turnStartedAt,
    turnDeadlineAt: session.turnDeadlineAt,
    opponentLeftAt: session.opponentLeftAt,
    pause: session.pause,
    winnerSeat: session.winnerSeat,
    winnerAccountId: session.winnerAccountId,
    gameWinner: session.gameWinner
      ? { ...session.gameWinner, finalRemaining: { ...session.remaining } }
      : undefined,
    finishReason: session.finishReason,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function fourBallSeatForAccount(session: FourBallSession, accountId: string): number | undefined {
  if (session.players.cue0 === accountId) {
    return 0;
  }
  if (session.players.cue1 === accountId) {
    return 1;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// AI (S3: 합법 보장 랜덤 — S5 에서 후보 평가로 고도화)
// ---------------------------------------------------------------------------

export function randomFourBallShot(session: FourBallSession, seat: number): FourBallShotParams {
  const cue = session.balls[cueKeyFor(seat)];
  const target = nearestRed(session, cue);
  const baseAngle = Math.atan2(target.y - cue.y, target.x - cue.x);
  return {
    angle: baseAngle + (Math.random() - 0.5) * 0.3,
    power: 0.35 + Math.random() * 0.4,
    tipX: 0,
    tipY: 0,
  };
}

/**
 * 후보 샷(각도 × 파워 × 당점)을 서버 물리로 시뮬레이션해 판정 결과로 점수화한 뒤 고른다(alkkagi/fortress 패턴).
 * 항상 합법 샷을 반환하며, 난이도가 높을수록 후보 수와 당점 활용이 늘고 최적 후보를 고른다.
 */
export function chooseFourBallAiShot(
  session: FourBallSession,
  seat: number,
  difficulty: Difficulty,
  deadlineMs = Date.now() + FOUR_BALL_AI_BUDGET_MS,
): FourBallShotParams | undefined {
  if (session.status !== 'playing' || session.currentSeat !== seat) {
    return undefined;
  }
  const cueKey = cueKeyFor(seat);
  const opponentCueKey = cueKeyFor(1 - seat);
  const finishing = session.needsThreeCushionFinish[seatKeyFor(seat)] === true;

  const candidates = generateFourBallCandidates(session, seat, difficulty);
  const baseBalls: BilliardsBallInput[] = FOUR_BALL_BALL_KEYS.map((key) => ({
    id: key,
    x: session.balls[key].x,
    y: session.balls[key].y,
  }));

  const scored: Array<{ shot: FourBallShotParams; score: number }> = [];
  for (const shot of candidates) {
    if (Date.now() >= deadlineMs && scored.length > 0) {
      break;
    }
    const sim = simulateBilliards(baseBalls, { ballId: cueKey, ...shot }, NO_MISCUE_RNG);
    const outcome = evaluateFourBall(sim.events, {
      cueBallId: cueKey,
      opponentCueId: opponentCueKey,
      redBallIds: FOUR_BALL_RED_KEYS,
    });
    const cueFinal = sim.finalPositions[cueKey];
    const redsHit = new Set(outcome.ballsHit.filter((id) => id === 'red1' || id === 'red2')).size;
    let score: number;
    if (finishing) {
      if (outcome.scored && outcome.threeCushion) {
        score = 100_000;
      } else {
        score = redsHit * 600 + outcome.cushions * 250 - (outcome.foul ? 200 : 0);
      }
    } else if (outcome.foul) {
      score = -5_000 + redsHit * 100;
    } else if (outcome.scored) {
      score = 100_000;
    } else if (redsHit === 1) {
      // 첫 빨강은 맞혔으니 수구가 두 번째 빨강에 얼마나 가까운지로 평가.
      const otherRed = outcome.ballsHit.includes('red1') ? session.balls.red2 : session.balls.red1;
      score = 5_000 - distance(cueFinal, otherRed);
    } else {
      // 아무 빨강도 못 맞힘 → 가장 가까운 빨강에 근접할수록 좋음.
      score = -Math.min(distance(cueFinal, session.balls.red1), distance(cueFinal, session.balls.red2));
    }
    const noise = difficulty === 'easy' ? 3_000 : difficulty === 'medium' ? 600 : 40;
    scored.push({ shot, score: score + (Math.random() - 0.5) * noise });
  }
  if (scored.length === 0) {
    return undefined;
  }
  scored.sort((a, b) => b.score - a.score);
  if (difficulty === 'easy') {
    const pool = scored.slice(0, Math.max(1, Math.ceil(scored.length * 0.5)));
    return pool[Math.floor(Math.random() * pool.length)].shot;
  }
  if (difficulty === 'medium') {
    const pool = scored.slice(0, Math.min(4, scored.length));
    return pool[Math.floor(Math.random() * pool.length)].shot;
  }
  return scored[0].shot;
}

function generateFourBallCandidates(session: FourBallSession, seat: number, difficulty: Difficulty): FourBallShotParams[] {
  const cue = session.balls[cueKeyFor(seat)];
  const offsets = difficulty === 'easy'
    ? [-0.2, 0, 0.2]
    : difficulty === 'medium'
      ? [-0.35, -0.18, 0, 0.18, 0.35]
      : [-0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45];
  const powers = difficulty === 'easy' ? [0.5] : difficulty === 'medium' ? [0.4, 0.65] : [0.35, 0.55, 0.8];
  const tips: Array<{ tipX: number; tipY: number }> = difficulty === 'hard'
    ? [{ tipX: 0, tipY: 0 }, { tipX: 0, tipY: 0.28 }, { tipX: 0, tipY: -0.28 }, { tipX: 0.28, tipY: 0 }, { tipX: -0.28, tipY: 0 }]
    : [{ tipX: 0, tipY: 0 }];
  const candidates: FourBallShotParams[] = [];
  for (const red of [session.balls.red1, session.balls.red2]) {
    const base = Math.atan2(red.y - cue.y, red.x - cue.x);
    for (const offset of offsets) {
      for (const power of powers) {
        for (const tip of tips) {
          candidates.push({ angle: base + offset, power, tipX: tip.tipX, tipY: tip.tipY });
        }
      }
    }
  }
  return candidates;
}

function nearestRed(session: FourBallSession, from: FourBallVec): FourBallVec {
  const red1 = session.balls.red1;
  const red2 = session.balls.red2;
  return distance(from, red1) <= distance(from, red2) ? red1 : red2;
}

function aiTargetForDifficulty(difficulty: Difficulty): number {
  return difficulty === 'easy' ? 3 : difficulty === 'hard' ? 8 : 5;
}

// ---------------------------------------------------------------------------
// 소소한 헬퍼
// ---------------------------------------------------------------------------

function fourBallModeFromConfig(value: unknown): GameMode {
  return value === 'friend_match' ? 'friend_match' : 'local_ai';
}

function fourBallDifficultyFromConfig(value: unknown): Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
}

function seatKeyFor(seat: number): string {
  return `seat${seat}`;
}

function cueKeyFor(seat: number): 'cue0' | 'cue1' {
  return seat === 1 ? 'cue1' : 'cue0';
}

function distance(a: FourBallVec, b: FourBallVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue);
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

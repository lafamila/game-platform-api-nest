import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { AlkkagiPiece, AlkkagiSession, Difficulty, GameMode, PieceTeam } from './games.types';

export const ALKKAGI_BOARD_SIZE = 1000;
export const ALKKAGI_AI_BUDGET_MS = 1_400;
export const ALKKAGI_STATE_VERSION = 1;

const ALKKAGI_HINGES = [
  { x1: 220, y1: 500, x2: 400, y2: 500, radius: 10 },
  { x1: 600, y1: 500, x2: 780, y2: 500, radius: 10 },
] as const;

export interface AlkkagiAiShot {
  pieceId: string;
  vx: number;
  vy: number;
}

interface AlkkagiSimulationOptions {
  ignoreHinges?: boolean;
}

export const ALKKAGI_ENGINE: GameEngine<AlkkagiSession> = {
  descriptor: {
    key: 'alkkagi',
    title: 'Alkkagi',
    minPlayers: 2,
    maxPlayers: 2,
    modes: ['local_ai', 'friend_match'],
    turnType: 'turnBased',
    hiddenInfo: false,
    supportsAi: true,
    supportsMatchSave: true,
    turnTimerSeconds: 10,
    graceSeconds: 60,
    status: 'playable',
  },
  stateVersion: ALKKAGI_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): AlkkagiSession {
    const now = new Date().toISOString();
    const mode = alkkagiModeFromConfig(config.mode);
    return {
      id: typeof config.id === 'string' ? config.id : '',
      mode,
      aiDifficulty: mode === 'local_ai' ? alkkagiDifficultyFromConfig(config.aiDifficulty) : undefined,
      currentTurn: 'red',
      status: 'playing',
      players: {
        red: players[0]?.accountId ?? '',
        blue: players[1]?.accountId ?? '',
      },
      pieces: initialAlkkagiPieces(),
      shots: [],
      createdAt: now,
      updatedAt: now,
    };
  },
  applyAction(state: AlkkagiSession, seat: number, action: GameAction) {
    if (action.type !== 'shoot') {
      throw new BadRequestException('unsupported alkkagi action');
    }
    const team: PieceTeam = seat === 0 ? 'red' : 'blue';
    if (state.currentTurn !== team) {
      throw new BadRequestException('not your turn');
    }
    const payload = action.payload ?? {};
    const accountId = state.players[team];
    const animation = applyAlkkagiShotToSession(
      state,
      accountId,
      String(payload.pieceId ?? ''),
      clamp(Number(payload.vx), -40, 40),
      clamp(Number(payload.vy), -40, 40),
      'manual',
    );
    return { state, events: [{ type: 'alkkagi.shot.played', payload: { animation } }] };
  },
  viewFor(state: AlkkagiSession) {
    return state;
  },
  finishInfo(state: AlkkagiSession) {
    if (state.status !== 'finished') {
      return null;
    }
    const winnerSeat = state.winner === 'red' ? 0 : state.winner === 'blue' ? 1 : undefined;
    return { status: 'finished', winnerSeat, reason: state.finishReason };
  },
  aiAction(state: AlkkagiSession) {
    const shot = chooseAlkkagiAiShot(state, state.aiDifficulty ?? 'medium') ?? randomAlkkagiShot(state);
    return { type: 'shoot', payload: shot ?? {} };
  },
};

function alkkagiModeFromConfig(value: unknown): GameMode {
  return value === 'friend_match' ? 'friend_match' : 'local_ai';
}

function alkkagiDifficultyFromConfig(value: unknown): Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
}

export function applyAlkkagiShotToSession(
  session: AlkkagiSession,
  accountId: string,
  pieceId: string,
  vx: number,
  vy: number,
  source: 'manual' | 'timeout' | 'ai',
): { frameMs: number; frames: AlkkagiPiece[][] } {
  const team = session.currentTurn;
  const pieceItem = session.pieces.find((item) => item.id === pieceId);
  if (!pieceItem || !pieceItem.active) {
    throw new BadRequestException('active piece not found');
  }
  if (pieceItem.team !== team) {
    throw new BadRequestException('piece does not belong to current turn');
  }
  delete session.lastAim;
  pieceItem.vx = vx;
  pieceItem.vy = vy;
  const animation = simulateAlkkagi(session.pieces);
  session.shots.push({ pieceId, team, vx, vy, accountId, createdAt: new Date().toISOString(), source });

  const activeRed = session.pieces.some((item) => item.team === 'red' && item.active);
  const activeBlue = session.pieces.some((item) => item.team === 'blue' && item.active);
  if (!activeRed || !activeBlue) {
    session.status = 'finished';
    session.winner = activeRed ? 'red' : 'blue';
    session.finishReason = source === 'timeout' ? 'timeout_random_win' : undefined;
  } else {
    session.currentTurn = oppositeAlkkagiTeam(session.currentTurn);
  }
  session.updatedAt = new Date().toISOString();
  return animation;
}

export function initialAlkkagiPieces(): AlkkagiPiece[] {
  const left = 110;
  const top = 70;
  const col = (index: number) => left + index * 97.5;
  const row = (index: number) => top + index * 95.5;
  return [
    piece('blue-chariot-1', 'blue', 'chariot', col(0), row(0), 38, 1.8),
    piece('blue-horse-1', 'blue', 'horse', col(1), row(0), 36, 1.45),
    piece('blue-elephant-1', 'blue', 'elephant', col(2), row(0), 36, 1.5),
    piece('blue-guard-1', 'blue', 'guard', col(3), row(0), 35, 1.25),
    piece('blue-guard-2', 'blue', 'guard', col(5), row(0), 35, 1.25),
    piece('blue-elephant-2', 'blue', 'elephant', col(6), row(0), 36, 1.5),
    piece('blue-horse-2', 'blue', 'horse', col(7), row(0), 36, 1.45),
    piece('blue-chariot-2', 'blue', 'chariot', col(8), row(0), 38, 1.8),
    piece('blue-general', 'blue', 'general', col(4), row(1), 43, 2.35),
    piece('blue-cannon-1', 'blue', 'cannon', col(1), row(2), 38, 1.65),
    piece('blue-cannon-2', 'blue', 'cannon', col(7), row(2), 38, 1.65),
    piece('blue-soldier-1', 'blue', 'soldier', col(0), row(3), 31, 0.95),
    piece('blue-soldier-2', 'blue', 'soldier', col(2), row(3), 31, 0.95),
    piece('blue-soldier-3', 'blue', 'soldier', col(4), row(3), 31, 0.95),
    piece('blue-soldier-4', 'blue', 'soldier', col(6), row(3), 31, 0.95),
    piece('blue-soldier-5', 'blue', 'soldier', col(8), row(3), 31, 0.95),
    piece('red-soldier-1', 'red', 'soldier', col(0), row(6), 31, 0.95),
    piece('red-soldier-2', 'red', 'soldier', col(2), row(6), 31, 0.95),
    piece('red-soldier-3', 'red', 'soldier', col(4), row(6), 31, 0.95),
    piece('red-soldier-4', 'red', 'soldier', col(6), row(6), 31, 0.95),
    piece('red-soldier-5', 'red', 'soldier', col(8), row(6), 31, 0.95),
    piece('red-cannon-1', 'red', 'cannon', col(1), row(7), 38, 1.65),
    piece('red-cannon-2', 'red', 'cannon', col(7), row(7), 38, 1.65),
    piece('red-general', 'red', 'general', col(4), row(8), 43, 2.35),
    piece('red-chariot-1', 'red', 'chariot', col(0), row(9), 38, 1.8),
    piece('red-horse-1', 'red', 'horse', col(1), row(9), 36, 1.45),
    piece('red-elephant-1', 'red', 'elephant', col(2), row(9), 36, 1.5),
    piece('red-guard-1', 'red', 'guard', col(3), row(9), 35, 1.25),
    piece('red-guard-2', 'red', 'guard', col(5), row(9), 35, 1.25),
    piece('red-elephant-2', 'red', 'elephant', col(6), row(9), 36, 1.5),
    piece('red-horse-2', 'red', 'horse', col(7), row(9), 36, 1.45),
    piece('red-chariot-2', 'red', 'chariot', col(8), row(9), 38, 1.8),
  ];
}

function piece(id: string, team: PieceTeam, rank: string, x: number, y: number, radius: number, mass: number): AlkkagiPiece {
  return { id, team, rank, x, y, radius, mass, vx: 0, vy: 0, active: true };
}

export function chooseAlkkagiAiShot(
  session: AlkkagiSession,
  difficulty: Difficulty,
  deadlineMs = Date.now() + ALKKAGI_AI_BUDGET_MS,
): AlkkagiAiShot | undefined {
  const team = session.currentTurn;
  const candidates = generateAlkkagiShotCandidates(session, difficulty);
  if (candidates.length === 0) return undefined;
  const ignoreHingesInEvaluation = difficulty === 'easy' && Math.random() < 0.3;
  const scored: Array<AlkkagiAiShot & { score: number }> = [];
  for (const candidate of candidates) {
    if (Date.now() >= deadlineMs) break;
    const real = evaluateAlkkagiShot(session.pieces, team, candidate, {});
    if (real.selfLostWeight > 0.01 && real.enemyLostWeight <= 0.01) {
      continue;
    }
    const evaluated = ignoreHingesInEvaluation
      ? evaluateAlkkagiShot(session.pieces, team, candidate, { ignoreHinges: true })
      : real;
    let score = evaluated.score;
    if (difficulty === 'hard') {
      score -= Math.max(0, bestAlkkagiResponseScore(evaluated.pieces, oppositeAlkkagiTeam(team), deadlineMs)) * 0.52;
    }
    const noise = difficulty === 'easy' ? 240 : difficulty === 'medium' ? 40 : 5;
    scored.push({ ...candidate, score: score + (Math.random() - 0.5) * noise });
  }
  const fallback = scored.length > 0 ? scored : candidates.map((candidate) => ({ ...candidate, score: Math.random() * 100 }));
  fallback.sort((left, right) => right.score - left.score);
  if (difficulty === 'easy') {
    const pool = fallback.slice(0, Math.max(1, Math.ceil(fallback.length * 0.55)));
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (difficulty === 'medium') {
    const pool = fallback.slice(0, Math.min(5, fallback.length));
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return fallback[0];
}

export function randomAlkkagiShot(session: AlkkagiSession): AlkkagiAiShot | undefined {
  const pieces = session.pieces.filter((item) => item.active && item.team === session.currentTurn);
  if (pieces.length === 0) return undefined;
  const pieceItem = pieces[Math.floor(Math.random() * pieces.length)];
  const angle = Math.random() * Math.PI * 2;
  const speed = 12 + Math.random() * 24;
  return {
    pieceId: pieceItem.id,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  };
}

function generateAlkkagiShotCandidates(session: AlkkagiSession, difficulty: Difficulty): AlkkagiAiShot[] {
  const team = session.currentTurn;
  const own = session.pieces.filter((item) => item.active && item.team === team);
  const enemies = session.pieces.filter((item) => item.active && item.team !== team);
  if (own.length === 0) return [];
  const limit = difficulty === 'easy' ? 22 : difficulty === 'medium' ? 72 : 170;
  const candidates: AlkkagiAiShot[] = [];
  for (const pieceItem of shuffle([...own])) {
    for (const enemy of shuffle([...enemies]).slice(0, difficulty === 'hard' ? enemies.length : 5)) {
      const dx = enemy.x - pieceItem.x;
      const dy = enemy.y - pieceItem.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const nx = dx / distance;
      const ny = dy / distance;
      const baseSpeed = clamp(distance / 23, 10, difficulty === 'easy' ? 30 : 38);
      const spread = difficulty === 'easy' ? 0.42 : difficulty === 'medium' ? 0.22 : 0.1;
      for (const multiplier of difficulty === 'easy' ? [0.75, 1.05] : [0.72, 0.94, 1.15]) {
        const angle = (Math.random() - 0.5) * spread;
        const cosValue = Math.cos(angle);
        const sinValue = Math.sin(angle);
        candidates.push({
          pieceId: pieceItem.id,
          vx: clamp((nx * cosValue - ny * sinValue) * baseSpeed * multiplier, -40, 40),
          vy: clamp((nx * sinValue + ny * cosValue) * baseSpeed * multiplier, -40, 40),
        });
      }
    }
  }
  while (candidates.length < limit) {
    const pieceItem = own[Math.floor(Math.random() * own.length)];
    const angle = Math.random() * Math.PI * 2;
    const speed = difficulty === 'easy' ? 10 + Math.random() * 20 : 12 + Math.random() * 27;
    candidates.push({
      pieceId: pieceItem.id,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    });
  }
  return shuffle(candidates).slice(0, limit);
}

function evaluateAlkkagiShot(
  sourcePieces: AlkkagiPiece[],
  team: PieceTeam,
  shot: AlkkagiAiShot,
  options: AlkkagiSimulationOptions,
): { score: number; selfLostWeight: number; enemyLostWeight: number; pieces: AlkkagiPiece[] } {
  const pieces = clonePieces(sourcePieces);
  const pieceItem = pieces.find((item) => item.id === shot.pieceId && item.active && item.team === team);
  if (!pieceItem) {
    return { score: Number.NEGATIVE_INFINITY, selfLostWeight: 0, enemyLostWeight: 0, pieces };
  }
  const beforeOwn = alkkagiMaterial(sourcePieces, team);
  const beforeEnemy = alkkagiMaterial(sourcePieces, oppositeAlkkagiTeam(team));
  pieceItem.vx = shot.vx;
  pieceItem.vy = shot.vy;
  simulateAlkkagi(pieces, options);
  const afterOwn = alkkagiMaterial(pieces, team);
  const afterEnemy = alkkagiMaterial(pieces, oppositeAlkkagiTeam(team));
  const selfLostWeight = beforeOwn - afterOwn;
  const enemyLostWeight = beforeEnemy - afterEnemy;
  const score =
    enemyLostWeight * 140 -
    selfLostWeight * 170 +
    alkkagiPositionScore(pieces, team) -
    alkkagiPositionScore(pieces, oppositeAlkkagiTeam(team)) * 0.35;
  return { score, selfLostWeight, enemyLostWeight, pieces };
}

function bestAlkkagiResponseScore(pieces: AlkkagiPiece[], responseTeam: PieceTeam, deadlineMs: number): number {
  const pseudoSession: AlkkagiSession = {
    id: 'ai-response',
    mode: 'local_ai',
    currentTurn: responseTeam,
    status: 'playing',
    players: { red: '', blue: '' },
    pieces: clonePieces(pieces),
    shots: [],
    createdAt: '',
    updatedAt: '',
  };
  let best = 0;
  for (const candidate of generateAlkkagiShotCandidates(pseudoSession, 'medium').slice(0, 34)) {
    if (Date.now() >= deadlineMs) break;
    const evaluated = evaluateAlkkagiShot(pieces, responseTeam, candidate, {});
    best = Math.max(best, evaluated.score);
  }
  return best;
}

function alkkagiMaterial(pieces: AlkkagiPiece[], team: PieceTeam): number {
  return pieces
    .filter((item) => item.active && item.team === team)
    .reduce((total, item) => total + alkkagiPieceValue(item), 0);
}

function alkkagiPieceValue(pieceItem: AlkkagiPiece): number {
  const rankValue = {
    general: 5,
    chariot: 3.2,
    cannon: 2.8,
    horse: 2.4,
    elephant: 2.4,
    guard: 1.8,
    soldier: 1,
  }[pieceItem.rank ?? 'soldier'] ?? 1;
  return rankValue * pieceMass(pieceItem);
}

function alkkagiPositionScore(pieces: AlkkagiPiece[], team: PieceTeam): number {
  return pieces
    .filter((item) => item.active && item.team === team)
    .reduce((total, item) => {
      const edgeDistance = Math.min(item.x, item.y, ALKKAGI_BOARD_SIZE - item.x, ALKKAGI_BOARD_SIZE - item.y);
      const centerDistance = Math.hypot(item.x - 500, item.y - 500);
      return total + clamp(edgeDistance / 40, 0, 7) - centerDistance / 900;
    }, 0);
}

export function oppositeAlkkagiTeam(team: PieceTeam): PieceTeam {
  return team === 'red' ? 'blue' : 'red';
}

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [items[index], items[target]] = [items[target], items[index]];
  }
  return items;
}

export function simulateAlkkagi(pieces: AlkkagiPiece[], options: AlkkagiSimulationOptions = {}): { frameMs: number; frames: AlkkagiPiece[][] } {
  const frames: AlkkagiPiece[][] = [clonePieces(pieces)];
  for (let tick = 0; tick < 260; tick += 1) {
    for (const item of pieces.filter((pieceItem) => pieceItem.active)) {
      item.x += item.vx;
      item.y += item.vy;
      item.vx *= 0.965;
      item.vy *= 0.965;
      if (Math.abs(item.vx) < 0.02) item.vx = 0;
      if (Math.abs(item.vy) < 0.02) item.vy = 0;
      if (item.x < 0 || item.x > ALKKAGI_BOARD_SIZE || item.y < 0 || item.y > ALKKAGI_BOARD_SIZE) {
        item.active = false;
        item.vx = 0;
        item.vy = 0;
      }
    }
    const activePieces = pieces.filter((item) => item.active);
    if (!options.ignoreHinges) {
      resolveHingeCollisions(activePieces);
    }
    resolveCollisions(activePieces);
    if (tick % 4 === 0) {
      frames.push(clonePieces(pieces));
    }
    if (pieces.every((item) => !item.active || (Math.abs(item.vx) < 0.02 && Math.abs(item.vy) < 0.02))) {
      break;
    }
  }
  for (const item of pieces) {
    item.vx = 0;
    item.vy = 0;
    item.x = Number(item.x.toFixed(2));
    item.y = Number(item.y.toFixed(2));
  }
  frames.push(clonePieces(pieces));
  return { frameMs: 16, frames };
}

function resolveHingeCollisions(pieces: AlkkagiPiece[]): void {
  for (const item of pieces) {
    for (const hinge of ALKKAGI_HINGES) {
      const segmentX = hinge.x2 - hinge.x1;
      const segmentY = hinge.y2 - hinge.y1;
      const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
      const t = segmentLengthSquared === 0
        ? 0
        : clamp(((item.x - hinge.x1) * segmentX + (item.y - hinge.y1) * segmentY) / segmentLengthSquared, 0, 1);
      const closestX = hinge.x1 + segmentX * t;
      const closestY = hinge.y1 + segmentY * t;
      const dx = item.x - closestX;
      const dy = item.y - closestY;
      const distance = Math.hypot(dx, dy);
      const minDistance = pieceRadius(item) + hinge.radius;
      if (distance <= 0 || distance >= minDistance) continue;
      const nx = dx / distance;
      const ny = dy / distance;
      const overlap = minDistance - distance;
      item.x += nx * overlap;
      item.y += ny * overlap;
      const speedAlongNormal = item.vx * nx + item.vy * ny;
      if (speedAlongNormal < 0) {
        item.vx -= 1.72 * speedAlongNormal * nx;
        item.vy -= 1.72 * speedAlongNormal * ny;
      }
    }
  }
}

function resolveCollisions(pieces: AlkkagiPiece[]): void {
  for (let leftIndex = 0; leftIndex < pieces.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < pieces.length; rightIndex += 1) {
      const left = pieces[leftIndex];
      const right = pieces[rightIndex];
      const dx = right.x - left.x;
      const dy = right.y - left.y;
      const distance = Math.hypot(dx, dy);
      const minDistance = pieceRadius(left) + pieceRadius(right);
      if (distance <= 0 || distance >= minDistance) continue;
      const nx = dx / distance;
      const ny = dy / distance;
      const overlap = minDistance - distance;
      const leftMass = pieceMass(left);
      const rightMass = pieceMass(right);
      const totalMass = leftMass + rightMass;
      left.x -= nx * overlap * (rightMass / totalMass);
      left.y -= ny * overlap * (rightMass / totalMass);
      right.x += nx * overlap * (leftMass / totalMass);
      right.y += ny * overlap * (leftMass / totalMass);

      const relativeVelocityX = right.vx - left.vx;
      const relativeVelocityY = right.vy - left.vy;
      const speed = relativeVelocityX * nx + relativeVelocityY * ny;
      if (speed > 0) continue;
      const impulse = -(1 + 0.82) * speed / (1 / leftMass + 1 / rightMass);
      left.vx -= impulse * nx / leftMass;
      left.vy -= impulse * ny / leftMass;
      right.vx += impulse * nx / rightMass;
      right.vy += impulse * ny / rightMass;
    }
  }
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue);
}

function pieceRadius(pieceItem: AlkkagiPiece): number {
  return pieceItem.radius ?? 38;
}

function pieceMass(pieceItem: AlkkagiPiece): number {
  return pieceItem.mass ?? Math.max(0.8, Math.pow(pieceRadius(pieceItem) / 38, 2));
}

function clonePieces(pieces: AlkkagiPiece[]): AlkkagiPiece[] {
  return pieces.map((pieceItem) => ({
    ...pieceItem,
    x: Number(pieceItem.x.toFixed(2)),
    y: Number(pieceItem.y.toFixed(2)),
    vx: Number(pieceItem.vx.toFixed(3)),
    vy: Number(pieceItem.vy.toFixed(3)),
  }));
}

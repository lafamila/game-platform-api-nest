import { BadRequestException } from '@nestjs/common';
import { Difficulty, GameMode, MatchPauseState } from './games.types';

export type FortressSide = 'challenger' | 'opponent';
export type FortressTankKey = 'balance' | 'heavy' | 'scout' | 'bomber';
export type FortressItemKey = 'doubleShot' | 'airStrike';

export interface FortressTankDefinition {
  key: FortressTankKey;
  name: string;
  hp: number;
  movement: number;
  damage: number;
  projectileMass: number;
  windScale: number;
  explosionRadius: number;
  terrainDamage: number;
  hitWidth: number;
  hitHeight: number;
  hitCenterYOffset: number;
}

export interface FortressTankState {
  side: FortressSide;
  accountId: string;
  tankKey?: FortressTankKey;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
}

export interface FortressPosition {
  x: number;
  y: number;
}

export interface FortressAimState {
  angle: number;
  power: number;
  charging: boolean;
  facing: -1 | 1;
  lastPower?: number;
  updatedAt?: string;
}

export interface FortressItemState {
  doubleShot: boolean;
  airStrike: boolean;
}

export interface FortressFloatingPlatform {
  id: string;
  x1: number;
  x2: number;
  y: number;
  thickness: number;
}

export interface FortressShot {
  side: FortressSide;
  accountId: string;
  angle: number;
  power: number;
  item?: FortressItemKey;
  createdAt: string;
  source?: 'manual' | 'ai' | 'timeout';
  tankKey?: FortressTankKey;
  hit?: 'terrain' | 'tank' | 'out';
  damage?: number;
}

export interface FortressSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: Difficulty;
  currentTurn: FortressSide;
  movementRemaining: Record<FortressSide, number>;
  turnStartPositions?: Record<FortressSide, FortressPosition>;
  aim?: Record<FortressSide, FortressAimState>;
  itemsUsed?: Record<FortressSide, FortressItemState>;
  winnerSide?: FortressSide;
  winnerAccountId?: string;
  status: 'selecting' | 'playing' | 'finished';
  players: Record<FortressSide, string>;
  terrain: number[];
  floatingPlatforms?: FortressFloatingPlatform[];
  wind: number;
  tanks: Record<FortressSide, FortressTankState>;
  shots: FortressShot[];
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  pause?: MatchPauseState;
  finishReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FortressShotResult {
  session: FortressSession;
  animation: {
    frameMs: number;
    projectile: Array<{ x: number; y: number }>;
    sequences?: FortressShotAnimationSequence[];
    terrainBefore: number[];
    terrainAfter: number[];
    tanksBefore: Record<FortressSide, FortressTankState>;
    tanksAfter: Record<FortressSide, FortressTankState>;
    impact?: { x: number; y: number; radius: number };
  };
}

interface FortressShotAnimationSequence {
  kind: 'shot' | 'airStrike';
  projectile: Array<{ x: number; y: number }>;
  terrainBefore: number[];
  terrainAfter: number[];
  impact?: { x: number; y: number; radius: number };
}

const WORLD_WIDTH = 1800;
const WORLD_HEIGHT = 620;
const TERRAIN_SAMPLES = 181;
const GRAVITY = 0.34;
const TURN_WIND_LIMIT = 0.12;
const TANK_WIDTH = 28;
const MIN_PLATFORM_WIDTH = 56;
const FALL_DAMAGE_THRESHOLD = 58;
const FORTRESS_POWER_MIN = 16;
const FORTRESS_POWER_MAX = 78;
const FORTRESS_DEFAULT_POWER = 46;
const FORTRESS_PROJECTILE_POWER_SCALE = 0.3;
const FORTRESS_UI_POWER_MIN = 0;
const FORTRESS_UI_POWER_MAX = 100;
const FORTRESS_ANGLE_MIN = -20;
const FORTRESS_ANGLE_MAX = 85;
const FORTRESS_DEFAULT_ANGLE = 45;

export const FORTRESS_TANKS: Record<FortressTankKey, FortressTankDefinition> = {
  balance: {
    key: 'balance',
    name: '밸런스',
    hp: 100,
    movement: 72,
    damage: 34,
    projectileMass: 1,
    windScale: 1,
    explosionRadius: 52,
    terrainDamage: 1,
    hitWidth: 61,
    hitHeight: 34,
    hitCenterYOffset: 17.5,
  },
  heavy: {
    key: 'heavy',
    name: '헤비',
    hp: 130,
    movement: 48,
    damage: 46,
    projectileMass: 1.35,
    windScale: 0.68,
    explosionRadius: 48,
    terrainDamage: 1.08,
    hitWidth: 71,
    hitHeight: 36.5,
    hitCenterYOffset: 18.75,
  },
  scout: {
    key: 'scout',
    name: '스카웃',
    hp: 80,
    movement: 102,
    damage: 27,
    projectileMass: 0.78,
    windScale: 1.38,
    explosionRadius: 36,
    terrainDamage: 0.74,
    hitWidth: 53,
    hitHeight: 32.5,
    hitCenterYOffset: 16.75,
  },
  bomber: {
    key: 'bomber',
    name: '봄버',
    hp: 95,
    movement: 58,
    damage: 30,
    projectileMass: 1.05,
    windScale: 0.9,
    explosionRadius: 72,
    terrainDamage: 1.35,
    hitWidth: 65,
    hitHeight: 35,
    hitCenterYOffset: 18,
  },
};

export function createFortressState(
  challengerAccountId: string,
  opponentAccountId: string,
  mode: GameMode,
  difficulty: Difficulty = 'medium',
): FortressSession {
  const map = createFortressMap();
  const terrain = map.terrain;
  const challengerX = 240;
  const opponentX = WORLD_WIDTH - 240;
  const challengerY = fortressSurfaceHeightAt(terrain, map.floatingPlatforms, challengerX);
  const opponentY = fortressSurfaceHeightAt(terrain, map.floatingPlatforms, opponentX);
  return {
    id: '',
    mode,
    aiDifficulty: difficulty,
    currentTurn: 'challenger',
    movementRemaining: {
      challenger: 0,
      opponent: 0,
    },
    aim: {
      challenger: defaultFortressAim('challenger'),
      opponent: defaultFortressAim('opponent'),
    },
    itemsUsed: {
      challenger: defaultFortressItems(),
      opponent: defaultFortressItems(),
    },
    turnStartPositions: {
      challenger: {
        x: challengerX,
        y: challengerY,
      },
      opponent: {
        x: opponentX,
        y: opponentY,
      },
    },
    status: 'selecting',
    players: {
      challenger: challengerAccountId,
      opponent: opponentAccountId,
    },
    terrain,
    floatingPlatforms: map.floatingPlatforms,
    wind: nextFortressWind(),
    tanks: {
      challenger: {
        side: 'challenger',
        accountId: challengerAccountId,
        x: challengerX,
        y: challengerY,
        hp: 0,
        alive: true,
      },
      opponent: {
        side: 'opponent',
        accountId: opponentAccountId,
        x: opponentX,
        y: opponentY,
        hp: 0,
        alive: true,
      },
    },
    shots: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function fortressSideForAccount(
  session: FortressSession,
  accountId: string,
): FortressSide | undefined {
  if (session.players.challenger === accountId) {
    return 'challenger';
  }
  if (session.players.opponent === accountId) {
    return 'opponent';
  }
  return undefined;
}

export function fortressClientSession(
  session: FortressSession,
  accountId?: string,
): FortressSession & {
  mySide?: FortressSide;
  tankDefinitions: FortressTankDefinition[];
  world: { width: number; height: number };
} {
  ensureFortressRuntimeState(session);
  return {
    ...session,
    mySide: accountId ? fortressSideForAccount(session, accountId) : undefined,
    tankDefinitions: Object.values(FORTRESS_TANKS),
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
  };
}

export function ensureFortressRuntimeState(session: FortressSession): FortressSession {
  session.movementRemaining ??= { challenger: 0, opponent: 0 };
  session.turnStartPositions ??= currentFortressPositions(session);
  session.floatingPlatforms ??= [];
  session.aim ??= {
    challenger: defaultFortressAim('challenger'),
    opponent: defaultFortressAim('opponent'),
  };
  session.aim.challenger = normalizeFortressAim(session.aim.challenger, 'challenger');
  session.aim.opponent = normalizeFortressAim(session.aim.opponent, 'opponent');
  session.itemsUsed ??= {
    challenger: defaultFortressItems(),
    opponent: defaultFortressItems(),
  };
  session.itemsUsed.challenger = normalizeFortressItems(session.itemsUsed.challenger);
  session.itemsUsed.opponent = normalizeFortressItems(session.itemsUsed.opponent);
  return session;
}

export function selectFortressTank(
  session: FortressSession,
  side: FortressSide,
  tankKey: string,
): void {
  ensureFortressRuntimeState(session);
  if (session.status !== 'selecting') {
    throw new BadRequestException('tank selection is closed');
  }
  const definition = fortressTank(tankKey);
  const tank = session.tanks[side];
  tank.tankKey = definition.key;
  tank.hp = definition.hp;
  tank.alive = true;
  tank.y = fortressSurfaceHeightAt(session.terrain, session.floatingPlatforms, tank.x);
  if (session.tanks.challenger.tankKey && session.tanks.opponent.tankKey) {
    session.status = 'playing';
    beginFortressTurn(session, 'challenger');
  }
  session.updatedAt = new Date().toISOString();
}

export function updateFortressAim(
  session: FortressSession,
  side: FortressSide,
  angle: number,
  power: number,
  charging: boolean,
): FortressSession {
  assertFortressTurn(session, side);
  ensureFortressRuntimeState(session);
  const current = session.aim![side];
  session.aim![side] = {
    angle: sanitizeFortressAngle(angle),
    power: sanitizeFortressUiPower(power),
    charging,
    facing: current.facing,
    lastPower: current.lastPower,
    updatedAt: new Date().toISOString(),
  };
  session.updatedAt = new Date().toISOString();
  return session;
}

export function applyFortressMove(
  session: FortressSession,
  side: FortressSide,
  distance: number,
): FortressSession {
  ensureFortressRuntimeState(session);
  assertFortressTurn(session, side);
  const tank = session.tanks[side];
  ensureFortressMovementBudget(session, side);
  const remaining = Math.max(0, session.movementRemaining[side] ?? 0);
  if (remaining <= 0) {
    return session;
  }
  const requested = finiteNumber(distance, 0);
  const clamped = Math.sign(requested) * Math.min(Math.abs(requested), remaining);
  const previousY = tank.y;
  const worldDelta = side === 'opponent' ? -clamped : clamped;
  tank.x = Math.max(60, Math.min(WORLD_WIDTH - 60, tank.x + worldDelta));
  if (Math.abs(worldDelta) > 0.01) {
    session.aim![side] = {
      ...session.aim![side],
      facing: worldDelta >= 0 ? 1 : -1,
      updatedAt: new Date().toISOString(),
    };
  }
  session.movementRemaining[side] = Math.max(0, remaining - Math.abs(clamped));
  tank.y = fortressSurfaceHeightAt(session.terrain, session.floatingPlatforms, tank.x);
  applyFortressFallDamage(tank, tank.y - previousY);
  if (tank.y >= WORLD_HEIGHT - 1) {
    finishFortress(session, otherFortressSide(side), 'fall');
    return session;
  }
  if (tank.hp <= 0) {
    finishFortress(session, otherFortressSide(side), 'fall-damage');
    return session;
  }
  session.updatedAt = new Date().toISOString();
  return session;
}

export function applyFortressShot(
  session: FortressSession,
  side: FortressSide,
  accountId: string,
  angle: number,
  power: number,
  source: 'manual' | 'ai' | 'timeout' = 'manual',
  item?: FortressItemKey,
): FortressShotResult {
  ensureFortressRuntimeState(session);
  assertFortressTurn(session, side);
  const terrainBefore = [...session.terrain];
  const tanksBefore = cloneFortressTanks(session.tanks);
  const shooter = session.tanks[side];
  const definition = fortressTank(shooter.tankKey);
  const sanitizedAngle = sanitizeFortressAngle(angle);
  const sanitizedPower = sanitizeFortressUiPower(power);
  const projectilePower = fortressUiPowerToProjectilePower(sanitizedPower);
  const itemKey = normalizeFortressItemKey(item);
  if (itemKey) {
    const items = session.itemsUsed![side];
    if (items[itemKey]) {
      throw new BadRequestException('fortress item is already used');
    }
    items[itemKey] = true;
  }
  session.aim![side] = {
    ...session.aim![side],
    angle: sanitizedAngle,
    power: FORTRESS_UI_POWER_MIN,
    charging: false,
    lastPower: sanitizedPower,
    updatedAt: new Date().toISOString(),
  };
  const sequences: FortressShotAnimationSequence[] = [];
  const first = applyFortressShotSequence(session, side, sanitizedAngle, projectilePower, definition, 'shot');
  sequences.push(first.sequence);
  let damage = first.damage;
  let hit = first.hit;
  let last = first.projectile[first.projectile.length - 1] ?? { x: shooter.x, y: shooter.y - 24 };
  if (!settleAndFinishFortressIfNeeded(session)) {
    if (itemKey === 'doubleShot') {
      const second = applyFortressShotSequence(session, side, sanitizedAngle, projectilePower, definition, 'shot');
      sequences.push(second.sequence);
      damage = Math.max(damage, second.damage);
      hit = second.hit;
      last = second.projectile[second.projectile.length - 1] ?? last;
      settleAndFinishFortressIfNeeded(session);
    } else if (itemKey === 'airStrike' && hit.kind !== 'out') {
      const strike = applyFortressAirStrikeSequence(session, side, hit.x, definition);
      sequences.push(strike.sequence);
      damage = Math.max(damage, strike.damage);
      hit = strike.hit;
      last = strike.projectile[strike.projectile.length - 1] ?? last;
      settleAndFinishFortressIfNeeded(session);
    }
  }
  if (session.status !== 'finished') {
    advanceFortressTurn(session, side);
  }
  session.shots.push({
    side,
    accountId,
    angle: sanitizedAngle,
    power: sanitizedPower,
    item: itemKey,
    createdAt: new Date().toISOString(),
    source,
    tankKey: definition.key,
    hit: hit.kind,
    damage,
  });
  session.updatedAt = new Date().toISOString();
  return {
    session,
    animation: {
      frameMs: 24,
      projectile: first.projectile,
      sequences,
      terrainBefore,
      terrainAfter: [...session.terrain],
      tanksBefore,
      tanksAfter: cloneFortressTanks(session.tanks),
      impact: hit.kind === 'out'
        ? { x: last.x, y: last.y, radius: 0 }
        : { x: hit.x, y: hit.y, radius: itemKey === 'airStrike' ? definition.explosionRadius * 1.5 : definition.explosionRadius },
    },
  };
}

export function applyFortressAiTurn(session: FortressSession): FortressShotResult | undefined {
  if (session.mode !== 'local_ai' || session.status === 'finished') {
    return undefined;
  }
  if (session.status === 'selecting') {
    selectFortressTank(session, 'opponent', aiTankForDifficulty(session.aiDifficulty ?? 'medium'));
    return undefined;
  }
  if (session.currentTurn !== 'opponent') {
    return undefined;
  }
  const moveDistance = chooseFortressAiMove(session, session.aiDifficulty ?? 'medium');
  if (Math.abs(moveDistance) > 0.1) {
    applyFortressMove(session, 'opponent', moveDistance);
    if (session.winnerSide) {
      return undefined;
    }
  }
  const choice = chooseFortressAiShot(session, session.aiDifficulty ?? 'medium');
  return applyFortressShot(session, 'opponent', session.players.opponent, choice.angle, fortressProjectilePowerToUiPower(choice.power), 'ai');
}

export function applyFortressForfeit(session: FortressSession, side: FortressSide): void {
  if (session.status === 'finished') {
    return;
  }
  finishFortress(session, otherFortressSide(side), 'forfeit');
}

function assertFortressTurn(session: FortressSession, side: FortressSide): void {
  if (session.status !== 'playing') {
    throw new BadRequestException('game is not playing');
  }
  if (session.currentTurn !== side) {
    throw new BadRequestException('not your turn');
  }
  if (!session.tanks[side].tankKey) {
    throw new BadRequestException('tank is not selected');
  }
}

function createFortressMap(): { terrain: number[]; floatingPlatforms: FortressFloatingPlatform[] } {
  const variant = randomInt(0, 4);
  let terrain = createFortressTerrain(variant);
  terrain = smoothFortressSpawnAreas(terrain, variant);
  const floatingPlatforms = createFortressFloatingPlatforms(terrain, variant);
  return { terrain, floatingPlatforms };
}

function createFortressTerrain(variant: number): number[] {
  const phaseA = randomBetween(0, Math.PI * 2);
  const phaseB = randomBetween(0, Math.PI * 2);
  const base = randomBetween(398, 430);
  const primaryFrequency = randomBetween(2.5, 3.8);
  const secondaryFrequency = randomBetween(6.8, 9.4);
  const primaryAmplitude = randomBetween(22, 42);
  const secondaryAmplitude = randomBetween(8, 20);
  const centerMountain = randomBetween(125, 170);
  const centerGorge = randomBetween(105, 150);
  const randomLeft = randomBetween(-72, 72);
  const randomCenter = randomBetween(-118, 118);
  const randomRight = randomBetween(-72, 72);
  let terrain = Array.from({ length: TERRAIN_SAMPLES }, (_, index) => {
    const x = index / (TERRAIN_SAMPLES - 1);
    const ridge = base
      + Math.sin(x * Math.PI * primaryFrequency + phaseA) * primaryAmplitude
      + Math.sin(x * Math.PI * secondaryFrequency + phaseB) * secondaryAmplitude;
    let y = ridge;
    if (variant === 0) {
      const leftHigh = Math.random() > 0.5;
      y += gaussian(x, 0.16, 0.14) * (leftHigh ? -82 : 62);
      y += gaussian(x, 0.84, 0.14) * (leftHigh ? 62 : -82);
      y -= gaussian(x, 0.5, 0.2) * 30;
    } else if (variant === 1) {
      y -= gaussian(x, 0.5, 0.16) * centerMountain;
      y += gaussian(x, 0.33, 0.08) * 28 + gaussian(x, 0.67, 0.08) * 28;
    } else if (variant === 2) {
      y -= gaussian(x, 0.16, 0.12) * 62;
      y -= gaussian(x, 0.84, 0.12) * 62;
      y += gaussian(x, 0.5, 0.15) * centerGorge;
    } else if (variant === 3) {
      y -= gaussian(x, 0.28, 0.12) * 82;
      y += gaussian(x, 0.52, 0.1) * 88;
      y -= gaussian(x, 0.74, 0.12) * 74;
    } else {
      y += gaussian(x, 0.18, 0.09) * randomLeft;
      y += gaussian(x, 0.5, 0.13) * randomCenter;
      y += gaussian(x, 0.82, 0.09) * randomRight;
    }
    return clampFortressTerrainY(y);
  });
  for (let pass = 0; pass < 2; pass += 1) {
    terrain = smoothFortressTerrain(terrain);
  }
  return terrain;
}

function smoothFortressSpawnAreas(terrain: number[], variant: number): number[] {
  const next = [...terrain];
  for (const spawnX of [240, WORLD_WIDTH - 240]) {
    const centerIndex = Math.round(spawnX / WORLD_WIDTH * (TERRAIN_SAMPLES - 1));
    const target = terrainHeightAt(terrain, spawnX);
    for (let offset = -3; offset <= 3; offset += 1) {
      const index = centerIndex + offset;
      if (index < 0 || index >= next.length) {
        continue;
      }
      const blend = 1 - Math.abs(offset) / 4;
      next[index] = clampFortressTerrainY(next[index] * (1 - blend * 0.74) + target * blend * 0.74);
    }
  }
  if (variant === 2) {
    return next.map((value, index) => {
      const x = index / (TERRAIN_SAMPLES - 1);
      return clampFortressTerrainY(value - gaussian(x, 0.16, 0.08) * 18 - gaussian(x, 0.84, 0.08) * 18);
    });
  }
  return next;
}

function createFortressFloatingPlatforms(terrain: number[], variant: number): FortressFloatingPlatform[] {
  const platforms: FortressFloatingPlatform[] = [];
  const maybeStartIsland = Math.random() < 0.34;
  if (maybeStartIsland) {
    const sideX = Math.random() < 0.5 ? 240 : WORLD_WIDTH - 240;
    const groundY = terrainHeightAt(terrain, sideX);
    platforms.push({
      id: `spawn-${platforms.length}`,
      x1: sideX - randomBetween(78, 104),
      x2: sideX + randomBetween(92, 126),
      y: Math.max(205, groundY - randomBetween(86, 138)),
      thickness: randomBetween(20, 30),
    });
  }
  const middleChance = variant === 1 || variant === 2 ? 0.72 : 0.48;
  if (Math.random() < middleChance) {
    const center = randomBetween(680, 1120);
    const width = randomBetween(170, 280);
    platforms.push({
      id: `mid-${platforms.length}`,
      x1: center - width / 2,
      x2: center + width / 2,
      y: randomBetween(225, 340),
      thickness: randomBetween(18, 28),
    });
  }
  if (Math.random() < 0.18) {
    const center = randomBetween(420, 1380);
    const width = randomBetween(120, 210);
    platforms.push({
      id: `extra-${platforms.length}`,
      x1: center - width / 2,
      x2: center + width / 2,
      y: randomBetween(180, 285),
      thickness: randomBetween(16, 24),
    });
  }
  return platforms.map((platform, index) => ({
    ...platform,
    id: platform.id || `platform-${index}`,
    x1: Math.max(70, Math.min(WORLD_WIDTH - 80, platform.x1)),
    x2: Math.max(90, Math.min(WORLD_WIDTH - 60, platform.x2)),
  })).filter((platform) => platform.x2 - platform.x1 >= MIN_PLATFORM_WIDTH);
}

function smoothFortressTerrain(terrain: number[]): number[] {
  return terrain.map((value, index) => {
    if (index === 0 || index === terrain.length - 1) {
      return value;
    }
    return terrain[index - 1] * 0.22 + value * 0.56 + terrain[index + 1] * 0.22;
  });
}

function clampFortressTerrainY(value: number): number {
  return Math.max(255, Math.min(560, value));
}

function gaussian(x: number, center: number, width: number): number {
  return Math.exp(-Math.pow((x - center) / width, 2));
}

function randomInt(minValue: number, maxValue: number): number {
  return minValue + Math.floor(Math.random() * (maxValue - minValue + 1));
}

function simulateProjectile(
  session: FortressSession,
  side: FortressSide,
  angle: number,
  power: number,
  definition: FortressTankDefinition,
): Array<{ x: number; y: number }> {
  ensureFortressRuntimeState(session);
  const shooter = session.tanks[side];
  const direction = session.aim![side].facing;
  const radians = angle / 180 * Math.PI;
  const slope = fortressSurfaceSlopeAt(session, shooter.x);
  const muzzle = tankMuzzlePoint(session, shooter, direction, angle);
  const velocity = rotateScreenVector(
    {
      x: Math.cos(radians) * direction,
      y: -Math.sin(radians),
    },
    slope,
  );
  let x = muzzle.x;
  let y = muzzle.y;
  let vx = velocity.x * power * FORTRESS_PROJECTILE_POWER_SCALE / definition.projectileMass;
  let vy = velocity.y * power * FORTRESS_PROJECTILE_POWER_SCALE / definition.projectileMass;
  const frames: Array<{ x: number; y: number }> = [];
  let previous = { x, y };
  for (let step = 0; step < 220; step++) {
    x += vx;
    y += vy;
    vx += session.wind * definition.windScale;
    vy += GRAVITY * definition.projectileMass;
    frames.push({ x, y });
    if (x < -40 || x > WORLD_WIDTH + 40 || y > WORLD_HEIGHT + 80) {
      break;
    }
    const nearShooter = step < 3 && Math.hypot(x - shooter.x, y - (shooter.y - 18)) < TANK_WIDTH + 34;
    if (!nearShooter) {
      const surfaceHit = projectileSurfaceHit(session, previous, { x, y });
      if (surfaceHit) {
        frames[frames.length - 1] = { x: surfaceHit.x, y: surfaceHit.y };
        break;
      }
    }
    const hitTank = tankHitAt(session, { x, y }, side, step);
    if (hitTank) {
      break;
    }
    previous = { x, y };
  }
  return frames;
}

function applyFortressShotSequence(
  session: FortressSession,
  side: FortressSide,
  angle: number,
  projectilePower: number,
  definition: FortressTankDefinition,
  kind: FortressShotAnimationSequence['kind'],
): {
  projectile: Array<{ x: number; y: number }>;
  sequence: FortressShotAnimationSequence;
  hit: { kind: 'terrain' | 'tank' | 'out'; x: number; y: number; tankSide?: FortressSide };
  damage: number;
} {
  const terrainBefore = [...session.terrain];
  const projectile = simulateProjectile(session, side, angle, projectilePower, definition);
  const hit = projectileHit(session, projectile, side);
  let damage = 0;
  if (hit.kind !== 'out') {
    damage = applyFortressExplosion(session, hit.x, hit.y, definition);
  }
  const last = projectile[projectile.length - 1] ?? { x: session.tanks[side].x, y: session.tanks[side].y - 24 };
  return {
    projectile,
    hit,
    damage,
    sequence: {
      kind,
      projectile,
      terrainBefore,
      terrainAfter: [...session.terrain],
      impact: hit.kind === 'out' ? { x: last.x, y: last.y, radius: 0 } : { x: hit.x, y: hit.y, radius: definition.explosionRadius },
    },
  };
}

function applyFortressAirStrikeSequence(
  session: FortressSession,
  side: FortressSide,
  x: number,
  definition: FortressTankDefinition,
): {
  projectile: Array<{ x: number; y: number }>;
  sequence: FortressShotAnimationSequence;
  hit: { kind: 'terrain' | 'tank' | 'out'; x: number; y: number; tankSide?: FortressSide };
  damage: number;
} {
  const terrainBefore = [...session.terrain];
  const projectile = simulateAirStrike(session, x);
  const hit = projectileHit(session, projectile, side);
  let damage = 0;
  const radiusScale = 1.5;
  if (hit.kind !== 'out') {
    damage = applyFortressExplosion(session, hit.x, hit.y, definition, radiusScale);
  }
  const last = projectile[projectile.length - 1] ?? { x, y: 0 };
  return {
    projectile,
    hit,
    damage,
    sequence: {
      kind: 'airStrike',
      projectile,
      terrainBefore,
      terrainAfter: [...session.terrain],
      impact: hit.kind === 'out'
        ? { x: last.x, y: last.y, radius: 0 }
        : { x: hit.x, y: hit.y, radius: definition.explosionRadius * radiusScale },
    },
  };
}

function simulateAirStrike(session: FortressSession, x: number): Array<{ x: number; y: number }> {
  const clampedX = Math.max(0, Math.min(WORLD_WIDTH, x));
  const frames: Array<{ x: number; y: number }> = [];
  let previous = { x: clampedX, y: -88 };
  for (let y = -70; y <= WORLD_HEIGHT + 80; y += 20) {
    const point = { x: clampedX, y };
    frames.push(point);
    const surfaceHit = projectileSurfaceHit(session, previous, point);
    if (surfaceHit) {
      frames[frames.length - 1] = { x: surfaceHit.x, y: surfaceHit.y };
      break;
    }
    const hitTank = tankHitAt(session, point, 'challenger', 999);
    if (hitTank) {
      break;
    }
    previous = point;
  }
  return frames;
}

function projectileHit(
  session: FortressSession,
  projectile: Array<{ x: number; y: number }>,
  shooterSide: FortressSide,
): { kind: 'terrain' | 'tank' | 'out'; x: number; y: number; tankSide?: FortressSide } {
  for (let index = 0; index < projectile.length; index++) {
    const point = projectile[index];
    if (point.x < 0 || point.x > WORLD_WIDTH || point.y > WORLD_HEIGHT) {
      return { kind: 'out', x: point.x, y: point.y };
    }
    const hitTank = tankHitAt(session, point, shooterSide, index);
    if (hitTank) {
      return { kind: 'tank', x: point.x, y: point.y, tankSide: hitTank };
    }
    const shooter = session.tanks[shooterSide];
    const nearShooter = index < 3 && Math.hypot(point.x - shooter.x, point.y - (shooter.y - 18)) < TANK_WIDTH + 34;
    if (!nearShooter) {
      const previous = index > 0 ? projectile[index - 1] : undefined;
      const surfaceHit = projectileSurfaceHit(session, previous, point);
      if (surfaceHit) {
        return { kind: 'terrain', x: surfaceHit.x, y: surfaceHit.y };
      }
    }
  }
  const last = projectile[projectile.length - 1] ?? { x: 0, y: 0 };
  return { kind: 'out', x: last.x, y: last.y };
}

function applyFortressExplosion(
  session: FortressSession,
  x: number,
  y: number,
  definition: FortressTankDefinition,
  radiusScale = 1,
): number {
  const radius = definition.explosionRadius * radiusScale;
  for (let index = 0; index < session.terrain.length; index++) {
    const terrainX = indexToWorldX(index);
    const dx = Math.abs(terrainX - x);
    if (dx > radius) {
      continue;
    }
    const carve = Math.sqrt(radius * radius - dx * dx) * 0.74 * definition.terrainDamage;
    session.terrain[index] = Math.min(WORLD_HEIGHT, Math.max(session.terrain[index], y + carve));
  }
  session.floatingPlatforms = carveFortressPlatforms(session.floatingPlatforms, x, y, radius, definition.terrainDamage);
  let maxDamage = 0;
  for (const tank of Object.values(session.tanks)) {
    const distance = Math.hypot(tank.x - x, (tank.y - 18) - y);
    const ratio = Math.max(0, 1 - distance / radius);
    if (ratio <= 0 && distance >= radius + TANK_WIDTH) {
      continue;
    }
    const damage = Math.round(definition.damage * (0.28 + ratio * 0.92));
    tank.hp = Math.max(0, tank.hp - damage);
    maxDamage = Math.max(maxDamage, damage);
  }
  return maxDamage;
}

function settleFortressTank(session: FortressSession, tank: FortressTankState): void {
  const previousY = tank.y;
  tank.y = fortressSurfaceHeightAt(session.terrain, session.floatingPlatforms, tank.x);
  applyFortressFallDamage(tank, tank.y - previousY);
  if (tank.y >= WORLD_HEIGHT - 1) {
    tank.alive = false;
  }
}

function settleAndFinishFortressIfNeeded(session: FortressSession): boolean {
  settleFortressTank(session, session.tanks.challenger);
  settleFortressTank(session, session.tanks.opponent);
  if (!session.tanks.challenger.alive || session.tanks.challenger.y >= WORLD_HEIGHT - 1) {
    finishFortress(session, 'opponent', 'fall');
  } else if (!session.tanks.opponent.alive || session.tanks.opponent.y >= WORLD_HEIGHT - 1) {
    finishFortress(session, 'challenger', 'fall');
  } else if (session.tanks.challenger.hp <= 0) {
    finishFortress(session, 'opponent', 'hp');
  } else if (session.tanks.opponent.hp <= 0) {
    finishFortress(session, 'challenger', 'hp');
  }
  return session.status === 'finished';
}

function advanceFortressTurn(session: FortressSession, side: FortressSide): void {
  beginFortressTurn(session, otherFortressSide(side));
  session.wind = nextFortressWind(session.wind);
  session.updatedAt = new Date().toISOString();
}

function beginFortressTurn(session: FortressSession, side: FortressSide): void {
  ensureFortressRuntimeState(session);
  session.currentTurn = side;
  session.movementRemaining ??= { challenger: 0, opponent: 0 };
  session.movementRemaining[side] = fortressTank(session.tanks[side].tankKey).movement;
  session.movementRemaining[otherFortressSide(side)] = 0;
  session.turnStartPositions ??= currentFortressPositions(session);
  session.turnStartPositions[side] = {
    x: session.tanks[side].x,
    y: session.tanks[side].y,
  };
  session.aim![side] = {
    ...session.aim![side],
    power: FORTRESS_UI_POWER_MIN,
    charging: false,
    updatedAt: new Date().toISOString(),
  };
}

function ensureFortressMovementBudget(session: FortressSession, side: FortressSide): void {
  session.movementRemaining ??= { challenger: 0, opponent: 0 };
  if (!Number.isFinite(session.movementRemaining[side])) {
    session.movementRemaining[side] = fortressTank(session.tanks[side].tankKey).movement;
  }
}

function finishFortress(session: FortressSession, winnerSide: FortressSide, reason: string): void {
  session.status = 'finished';
  session.winnerSide = winnerSide;
  session.winnerAccountId = session.players[winnerSide];
  session.finishReason = reason;
  session.updatedAt = new Date().toISOString();
}

function chooseFortressAiMove(session: FortressSession, difficulty: Difficulty): number {
  ensureFortressRuntimeState(session);
  const remaining = Math.max(0, session.movementRemaining.opponent ?? 0);
  if (remaining <= 1) {
    return 0;
  }
  if (difficulty === 'easy' && Math.random() < 0.55) {
    return randomBetween(-remaining * 0.34, remaining * 0.34);
  }
  const shooter = session.tanks.opponent;
  const target = session.tanks.challenger;
  const currentDistance = Math.abs(target.x - shooter.x);
  const desiredDistance = difficulty === 'hard'
    ? randomBetween(580, 760)
    : difficulty === 'medium'
      ? randomBetween(650, 850)
      : randomBetween(560, 920);
  const tolerance = difficulty === 'hard' ? 55 : difficulty === 'medium' ? 90 : 145;
  let worldDelta = 0;
  const towardTarget = target.x > shooter.x ? 1 : -1;
  if (currentDistance > desiredDistance + tolerance) {
    worldDelta = towardTarget * Math.min(remaining, (currentDistance - desiredDistance) * 0.42);
  } else if (currentDistance < desiredDistance - tolerance) {
    worldDelta = -towardTarget * Math.min(remaining, (desiredDistance - currentDistance) * 0.36);
  } else {
    const wiggle = difficulty === 'hard' ? 0.18 : difficulty === 'medium' ? 0.28 : 0.42;
    worldDelta = randomBetween(-remaining * wiggle, remaining * wiggle);
  }
  worldDelta += randomBetween(-remaining * 0.08, remaining * 0.08);
  const clampedWorldDelta = Math.max(-remaining, Math.min(remaining, worldDelta));
  return -clampedWorldDelta;
}

function chooseFortressAiShot(session: FortressSession, difficulty: Difficulty): { angle: number; power: number } {
  const shooter = session.tanks.opponent;
  const targetPoint = fortressAiTargetPoint(session, difficulty);
  const dx = Math.abs(shooter.x - targetPoint.x);
  const dy = shooter.y - (targetPoint.y + 18);
  const baseAngle = 48;
  const distancePower = Math.sqrt(Math.max(120, dx) * GRAVITY) / FORTRESS_PROJECTILE_POWER_SCALE + dy * 0.025;
  const fallback = {
    angle: Math.max(18, Math.min(78, baseAngle + randomBetween(-18, 18))),
    power: Math.max(FORTRESS_POWER_MIN + 4, Math.min(FORTRESS_POWER_MAX - 2, distancePower + randomBetween(-12, 12))),
  };
  if (difficulty === 'easy') {
    return fallback;
  }
  const deadlineMs = Date.now() + (difficulty === 'hard' ? 36 : 24);
  const definition = fortressTank(shooter.tankKey);
  const angleStep = difficulty === 'hard' ? 2 : 4;
  const powerStep = difficulty === 'hard' ? 3 : 5;
  const angleMin = difficulty === 'hard' ? FORTRESS_ANGLE_MIN : -8;
  const angleMax = difficulty === 'hard' ? 82 : 78;
  const powerMin = difficulty === 'hard' ? FORTRESS_POWER_MIN : FORTRESS_POWER_MIN + 4;
  const powerMax = FORTRESS_POWER_MAX;
  let best = { ...fallback, score: Number.NEGATIVE_INFINITY };
  for (let angle = angleMin; angle <= angleMax; angle += angleStep) {
    for (let power = powerMin; power <= powerMax; power += powerStep) {
      if (Date.now() > deadlineMs) {
        return perturbFortressAiShot(best, difficulty);
      }
      const projectile = simulateProjectile(session, 'opponent', angle, power, definition);
      const hit = projectileHit(session, projectile, 'opponent');
      const score = scoreFortressAiShot(session, hit, definition, difficulty);
      if (score > best.score) {
        best = { angle, power, score };
      }
    }
  }
  return perturbFortressAiShot(best, difficulty);
}

function scoreFortressAiShot(
  session: FortressSession,
  hit: { kind: 'terrain' | 'tank' | 'out'; x: number; y: number; tankSide?: FortressSide },
  definition: FortressTankDefinition,
  difficulty: Difficulty,
): number {
  const shooter = session.tanks.opponent;
  const targetPoint = fortressAiTargetPoint(session, difficulty);
  const distanceToTarget = Math.hypot(hit.x - targetPoint.x, hit.y - targetPoint.y);
  const distanceToSelf = Math.hypot(hit.x - shooter.x, hit.y - (shooter.y - 18));
  const targetBlastRatio = Math.max(0, 1 - distanceToTarget / definition.explosionRadius);
  const selfBlastRatio = Math.max(0, 1 - distanceToSelf / definition.explosionRadius);
  let score = -distanceToTarget * 2.4 + targetBlastRatio * 4_500;
  if (hit.kind === 'tank' && hit.tankSide === 'challenger') {
    score += 24_000;
  } else if (hit.kind === 'tank' && hit.tankSide === 'opponent') {
    score -= 24_000;
  } else if (hit.kind === 'terrain') {
    score += targetBlastRatio * 2_200;
    if (distanceToTarget < definition.explosionRadius + TANK_WIDTH) {
      score += 900;
    }
  } else {
    score -= 1_600;
  }
  score -= selfBlastRatio * 8_000;
  if (distanceToSelf < definition.explosionRadius + TANK_WIDTH) {
    score -= 2_200;
  }
  score += difficulty === 'hard' ? randomBetween(-2, 2) : randomBetween(-8, 8);
  return score;
}

function fortressAiTargetPoint(session: FortressSession, difficulty: Difficulty): FortressPosition {
  const target = session.tanks.challenger;
  const current = {
    x: target.x,
    y: target.y - 18,
  };
  if (difficulty !== 'medium') {
    return current;
  }
  const started = session.turnStartPositions?.challenger;
  if (!started) {
    return current;
  }
  return {
    x: (started.x + current.x) / 2,
    y: ((started.y - 18) + current.y) / 2,
  };
}

function perturbFortressAiShot(
  shot: { angle: number; power: number },
  difficulty: Difficulty,
): { angle: number; power: number } {
  const angleJitter = difficulty === 'hard' ? 0.7 : 2.2;
  const powerJitter = difficulty === 'hard' ? 1.4 : 4;
  return {
    angle: Math.max(FORTRESS_ANGLE_MIN, Math.min(84, shot.angle + randomBetween(-angleJitter, angleJitter))),
    power: Math.max(FORTRESS_POWER_MIN, Math.min(FORTRESS_POWER_MAX, shot.power + randomBetween(-powerJitter, powerJitter))),
  };
}

function aiTankForDifficulty(difficulty: Difficulty): FortressTankKey {
  if (difficulty === 'easy') {
    return 'balance';
  }
  if (difficulty === 'hard') {
    return Math.random() > 0.5 ? 'heavy' : 'bomber';
  }
  return Math.random() > 0.5 ? 'balance' : 'scout';
}

function fortressTank(tankKey: string | undefined): FortressTankDefinition {
  const definition = tankKey ? FORTRESS_TANKS[tankKey as FortressTankKey] : undefined;
  if (!definition) {
    throw new BadRequestException('tankKey must be balance, heavy, scout, or bomber');
  }
  return definition;
}

function otherFortressSide(side: FortressSide): FortressSide {
  return side === 'challenger' ? 'opponent' : 'challenger';
}

function terrainHeightAt(terrain: number[], x: number): number {
  const clamped = Math.max(0, Math.min(WORLD_WIDTH, x));
  const sample = clamped / WORLD_WIDTH * (terrain.length - 1);
  const left = Math.floor(sample);
  const right = Math.min(terrain.length - 1, left + 1);
  const t = sample - left;
  return terrain[left] * (1 - t) + terrain[right] * t;
}

function terrainSlopeAt(terrain: number[], x: number): number {
  const sampleDistance = WORLD_WIDTH / (TERRAIN_SAMPLES - 1) * 2.4;
  const left = terrainHeightAt(terrain, x - sampleDistance);
  const right = terrainHeightAt(terrain, x + sampleDistance);
  return Math.atan2(right - left, sampleDistance * 2);
}

function fortressSurfaceHeightAt(
  terrain: number[],
  platforms: FortressFloatingPlatform[] | undefined,
  x: number,
): number {
  let surface = terrainHeightAt(terrain, x);
  for (const platform of platforms ?? []) {
    if (x >= platform.x1 && x <= platform.x2) {
      surface = Math.min(surface, platform.y);
    }
  }
  return surface;
}

function fortressSurfaceSlopeAt(session: FortressSession, x: number): number {
  const platform = (session.floatingPlatforms ?? []).find((item) => x >= item.x1 && x <= item.x2);
  if (platform && platform.y <= terrainHeightAt(session.terrain, x) - 8) {
    return 0;
  }
  return terrainSlopeAt(session.terrain, x);
}

function projectileSurfaceHit(
  session: FortressSession,
  previous: { x: number; y: number } | undefined,
  point: { x: number; y: number },
): { x: number; y: number } | undefined {
  for (const platform of session.floatingPlatforms ?? []) {
    if (point.x < platform.x1 || point.x > platform.x2) {
      continue;
    }
    const top = platform.y;
    const bottom = platform.y + platform.thickness;
    const crossedTop = previous ? previous.y <= top && point.y >= top : point.y >= top;
    const insidePlatform = point.y >= top && point.y <= bottom;
    if (crossedTop || insidePlatform) {
      return { x: point.x, y: top };
    }
  }
  const terrainY = terrainHeightAt(session.terrain, point.x);
  if (point.y >= terrainY) {
    return { x: point.x, y: terrainY };
  }
  return undefined;
}

function rotateScreenVector(vector: { x: number; y: number }, radians: number): { x: number; y: number } {
  return {
    x: vector.x * Math.cos(radians) - vector.y * Math.sin(radians),
    y: vector.x * Math.sin(radians) + vector.y * Math.cos(radians),
  };
}

function tankMuzzlePoint(
  session: FortressSession,
  tank: FortressTankState,
  direction: -1 | 1,
  angle: number,
): { x: number; y: number } {
  const slope = fortressSurfaceSlopeAt(session, tank.x);
  const radians = angle / 180 * Math.PI;
  const geometry = fortressTankVisualGeometry(tank.tankKey);
  const turret = rotateScreenVector({ x: 0, y: -geometry.bodyHeight - 4 }, slope);
  const barrel = rotateScreenVector(
    {
      x: Math.cos(radians) * geometry.barrelLength * direction,
      y: -Math.sin(radians) * geometry.barrelLength,
    },
    slope,
  );
  return {
    x: tank.x + turret.x + barrel.x,
    y: tank.y + turret.y + barrel.y,
  };
}

function fortressTankVisualGeometry(tankKey: FortressTankKey | undefined): { bodyHeight: number; barrelLength: number } {
  if (tankKey === 'heavy') {
    return { bodyHeight: 30, barrelLength: 45 };
  }
  if (tankKey === 'scout') {
    return { bodyHeight: 24, barrelLength: 36 };
  }
  if (tankKey === 'bomber') {
    return { bodyHeight: 28, barrelLength: 50 };
  }
  return { bodyHeight: 26, barrelLength: 40 };
}

function carveFortressPlatforms(
  platforms: FortressFloatingPlatform[] | undefined,
  x: number,
  y: number,
  radius: number,
  terrainDamage: number,
): FortressFloatingPlatform[] {
  const next: FortressFloatingPlatform[] = [];
  for (const platform of platforms ?? []) {
    const nearestY = Math.max(platform.y, Math.min(platform.y + platform.thickness, y));
    const verticalDistance = Math.abs(y - nearestY);
    if (verticalDistance >= radius) {
      next.push(platform);
      continue;
    }
    const cutRadius = Math.sqrt(radius * radius - verticalDistance * verticalDistance) * terrainDamage;
    const cutStart = x - cutRadius;
    const cutEnd = x + cutRadius;
    if (cutEnd <= platform.x1 || cutStart >= platform.x2) {
      next.push(platform);
      continue;
    }
    const leftWidth = cutStart - platform.x1;
    const rightWidth = platform.x2 - cutEnd;
    if (leftWidth >= MIN_PLATFORM_WIDTH) {
      next.push({ ...platform, id: `${platform.id}-l`, x2: cutStart });
    }
    if (rightWidth >= MIN_PLATFORM_WIDTH) {
      next.push({ ...platform, id: `${platform.id}-r`, x1: cutEnd });
    }
  }
  return next;
}

function applyFortressFallDamage(tank: FortressTankState, dropDistance: number): void {
  if (dropDistance <= FALL_DAMAGE_THRESHOLD || tank.hp <= 0) {
    return;
  }
  const damage = Math.min(28, Math.round((dropDistance - FALL_DAMAGE_THRESHOLD) * 0.18));
  tank.hp = Math.max(0, tank.hp - damage);
}

function tankHitAt(
  session: FortressSession,
  point: { x: number; y: number },
  shooterSide: FortressSide,
  frameIndex: number,
): FortressSide | undefined {
  for (const side of ['challenger', 'opponent'] as const) {
    const tank = session.tanks[side];
    if (!tank.alive) {
      continue;
    }
    if (side === shooterSide && frameIndex < 3) {
      continue;
    }
    const definition = tank.tankKey ? fortressTank(tank.tankKey) : undefined;
    if (definition && rotatedTankBodyHit(session, tank, definition, point)) {
      return side;
    }
  }
  return undefined;
}

function rotatedTankBodyHit(
  session: FortressSession,
  tank: FortressTankState,
  definition: FortressTankDefinition,
  point: { x: number; y: number },
): boolean {
  const slope = fortressSurfaceSlopeAt(session, tank.x);
  const centerOffset = rotateScreenVector({ x: 0, y: -definition.hitCenterYOffset }, slope);
  const center = {
    x: tank.x + centerOffset.x,
    y: tank.y + centerOffset.y,
  };
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const localX = dx * Math.cos(-slope) - dy * Math.sin(-slope);
  const localY = dx * Math.sin(-slope) + dy * Math.cos(-slope);
  return Math.abs(localX) <= definition.hitWidth / 2 && Math.abs(localY) <= definition.hitHeight / 2;
}

function indexToWorldX(index: number): number {
  return index / (TERRAIN_SAMPLES - 1) * WORLD_WIDTH;
}

function defaultFortressAim(side: FortressSide): FortressAimState {
  return {
    angle: FORTRESS_DEFAULT_ANGLE,
    power: FORTRESS_UI_POWER_MIN,
    charging: false,
    facing: side === 'challenger' ? 1 : -1,
  };
}

function defaultFortressItems(): FortressItemState {
  return {
    doubleShot: false,
    airStrike: false,
  };
}

function normalizeFortressAim(value: FortressAimState | undefined, side: FortressSide): FortressAimState {
  const fallback = defaultFortressAim(side);
  return {
    angle: sanitizeFortressAngle(value?.angle ?? fallback.angle),
    power: sanitizeFortressUiPower(value?.power ?? fallback.power),
    charging: value?.charging === true,
    facing: value?.facing === -1 || value?.facing === 1 ? value.facing : fallback.facing,
    lastPower: value?.lastPower === undefined ? undefined : sanitizeFortressUiPower(value.lastPower),
    updatedAt: value?.updatedAt,
  };
}

function normalizeFortressItems(value: FortressItemState | undefined): FortressItemState {
  return {
    doubleShot: value?.doubleShot === true,
    airStrike: value?.airStrike === true,
  };
}

function normalizeFortressItemKey(value: FortressItemKey | undefined): FortressItemKey | undefined {
  return value === 'doubleShot' || value === 'airStrike' ? value : undefined;
}

function sanitizeFortressAngle(value: number): number {
  return Math.max(FORTRESS_ANGLE_MIN, Math.min(FORTRESS_ANGLE_MAX, finiteNumber(value, FORTRESS_DEFAULT_ANGLE)));
}

function sanitizeFortressUiPower(value: number): number {
  return Math.max(FORTRESS_UI_POWER_MIN, Math.min(FORTRESS_UI_POWER_MAX, finiteNumber(value, FORTRESS_UI_POWER_MIN)));
}

function fortressUiPowerToProjectilePower(value: number): number {
  const ratio = sanitizeFortressUiPower(value) / FORTRESS_UI_POWER_MAX;
  return FORTRESS_POWER_MIN + ratio * (FORTRESS_POWER_MAX - FORTRESS_POWER_MIN);
}

function fortressProjectilePowerToUiPower(value: number): number {
  const ratio = (Math.max(FORTRESS_POWER_MIN, Math.min(FORTRESS_POWER_MAX, finiteNumber(value, FORTRESS_DEFAULT_POWER))) - FORTRESS_POWER_MIN)
    / (FORTRESS_POWER_MAX - FORTRESS_POWER_MIN);
  return Math.max(FORTRESS_UI_POWER_MIN, Math.min(FORTRESS_UI_POWER_MAX, ratio * FORTRESS_UI_POWER_MAX));
}

function nextFortressWind(previous?: number): number {
  if (!Number.isFinite(previous)) {
    return randomBetween(-TURN_WIND_LIMIT * 0.55, TURN_WIND_LIMIT * 0.55);
  }
  const drift = randomBetween(-0.026, 0.026);
  const gust = Math.random() < 0.12 ? randomBetween(-0.045, 0.045) : 0;
  let next = Math.max(-TURN_WIND_LIMIT, Math.min(TURN_WIND_LIMIT, (previous ?? 0) + drift + gust));
  if (Math.random() < 0.055) {
    next *= -0.55;
  }
  return Math.abs(next) < 0.006 ? randomBetween(-0.018, 0.018) : next;
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function cloneFortressTanks(
  tanks: Record<FortressSide, FortressTankState>,
): Record<FortressSide, FortressTankState> {
  return {
    challenger: { ...tanks.challenger },
    opponent: { ...tanks.opponent },
  };
}

function currentFortressPositions(session: FortressSession): Record<FortressSide, FortressPosition> {
  return {
    challenger: {
      x: session.tanks.challenger.x,
      y: session.tanks.challenger.y,
    },
    opponent: {
      x: session.tanks.opponent.x,
      y: session.tanks.opponent.y,
    },
  };
}

import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { CrazyArcadeSession, CrazyArcadeSide, Difficulty, GameMode } from './games.types';

const ROWS = 11;
const COLS = 13;
const BOMB_FUSE_SECONDS = 2.1;
const FLAME_SECONDS = 0.58;
const TRAP_SECONDS = 3.2;
const BOMB_SLIDE_CELL_SECONDS = 0.085;
const PLAYER_RADIUS = 0.39;
const BOMB_BLOCK_RADIUS = 0.36;
const MOVE_ASSIST_DISTANCE = 0.12;
const CORRIDOR_SNAP_TOLERANCE = 0.25;
export const CRAZY_ARCADE_STATE_VERSION = 1;

type Tile = 0 | 1 | 2; // floor, wall, crate
type Direction = 'up' | 'down' | 'left' | 'right';
type ItemType = 'range' | 'bomb' | 'speed' | 'kick' | 'glove';

interface Position {
  row: number;
  col: number;
}

interface Vector {
  dx: number;
  dy: number;
}

interface PlayerState {
  center: Vector;
  velocity: Vector;
  facing: Direction;
  bombCapacity: number;
  activeBombs: number;
  range: number;
  speedLevel: number;
  trapTimer: number;
  eliminated: boolean;
  canKickBomb: boolean;
  canCarryBomb: boolean;
  carriedBombId?: string | null;
  trappedFlameKeys: string[];
  passThroughBombIds: string[];
}

interface BombState {
  id: string;
  ownerId: string;
  position: Position;
  range: number;
  fuse: number;
  carriedBy?: string | null;
  slidePath: Position[];
  slideTimer: number;
  visualFrom?: Position | null;
  visualTo?: Position | null;
}

interface FlameState {
  position: Position;
  ttl: number;
  waveId: string;
}

interface ItemState {
  type: ItemType;
  position: Position;
}

interface CrazySnapshot {
  difficulty: Difficulty;
  tiles: Tile[][];
  playerSide: string;
  opponentSide: string;
  player: PlayerState;
  opponent: PlayerState;
  others: Record<string, PlayerState>;
  bombs: BombState[];
  flames: FlameState[];
  items: ItemState[];
  gameFinished: boolean;
  playerWon: boolean;
  winnerSide?: CrazyArcadeSide | null;
  statusText: string;
  bombSequence: number;
  flameSequence: number;
  aiThink: number;
  serverTickAt: string;
}

export const CRAZY_ARCADE_ENGINE: GameEngine<CrazyArcadeSession> = {
  descriptor: {
    key: 'crazy_arcade',
    title: 'Crazy Arcade',
    minPlayers: 2,
    maxPlayers: 4,
    modes: ['local_ai', 'friend_match'],
    turnType: 'realtimeServer',
    hiddenInfo: false,
    supportsAi: true,
    supportsMatchSave: true,
    graceSeconds: 60,
    status: 'playable',
  },
  stateVersion: CRAZY_ARCADE_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): CrazyArcadeSession {
    const difficulty = crazyDifficultyFromConfig(config.difficulty ?? config.aiDifficulty);
    const mode = crazyModeFromConfig(config.mode);
    const normalizedPlayers = players.length >= 2
      ? players.slice(0, 4)
      : [
        ...players,
        { seat: 1, kind: 'ai', accountId: '__game_platform_local_ai__#1' } as SeatInfo,
      ];
    const sides = normalizedPlayers.map((player, index) => crazyArcadeSideForSeat(index, normalizedPlayers.length));
    const now = new Date().toISOString();
    const playerEntriesForState = sides.map((side, index) => [
      side,
      normalizedPlayers[index]?.accountId ?? `__game_platform_local_ai__#${index}`,
    ]);
    return {
      id: typeof config.id === 'string' ? config.id : '',
      mode,
      ownerAccountId: playerEntriesForState[0]?.[1] ?? '',
      difficulty,
      aiDifficulty: mode === 'local_ai' ? difficulty : undefined,
      players: Object.fromEntries(playerEntriesForState),
      status: 'playing',
      snapshot: createCrazyArcadeSnapshotForSides(sides, crazySeedFromConfig(config.seed), difficulty),
      inputs: Object.fromEntries(sides.map((side) => [side, {}])),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
  },
  applyAction(state: CrazyArcadeSession, seat: number, action: GameAction) {
    if (action.type === 'input') {
      const side = crazyArcadeSideForSessionSeat(state, seat);
      if (!side) {
        throw new Error('crazy arcade player is missing');
      }
      return { state: applyCrazyArcadeServerInput(state, side, action.payload ?? {}) };
    }
    if (action.type === 'tick') {
      return { state: advanceCrazyArcadeServer(state) };
    }
    if (action.type === 'forfeit') {
      const side = crazyArcadeSideForSessionSeat(state, seat);
      const winnerSide = Object.keys(state.players).find((candidate) => candidate !== side) as CrazyArcadeSide | undefined;
      state.status = 'finished';
      state.winnerSide = winnerSide;
      state.winnerAccountId = winnerSide ? state.players[winnerSide] : undefined;
      state.finishReason = 'forfeit';
      state.updatedAt = new Date().toISOString();
      return { state };
    }
    throw new Error('unsupported crazy arcade action');
  },
  viewFor(state: CrazyArcadeSession, seat: number | 'spectator') {
    const side = typeof seat === 'number' ? crazyArcadeSideForSessionSeat(state, seat) : undefined;
    return crazyArcadeClientSession(state, side ? state.players[side] : undefined);
  },
  finishInfo(state: CrazyArcadeSession) {
    if (state.status !== 'finished') {
      return null;
    }
    const sides = Object.keys(state.players);
    const winnerSeat = state.winnerSide ? sides.indexOf(state.winnerSide) : -1;
    return {
      status: 'finished',
      winnerSeat: winnerSeat >= 0 ? winnerSeat : undefined,
      reason: state.finishReason,
    };
  },
  aiAction() {
    return { type: 'input', payload: {} };
  },
};

export function crazyArcadeClientSession(session: CrazyArcadeSession, accountId?: string): CrazyArcadeSession {
  const mySide = accountId
    ? Object.entries(session.players).find(([, candidate]) => candidate === accountId)?.[0]
    : undefined;
  return {
    ...session,
    mySide: mySide as CrazyArcadeSide | undefined,
    snapshot: mySide && isRecord(session.snapshot)
      ? crazyArcadeSnapshotForSide(session.snapshot, mySide)
      : session.snapshot,
  };
}

function crazyModeFromConfig(value: unknown): GameMode {
  return value === 'friend_match' ? 'friend_match' : 'local_ai';
}

function crazyDifficultyFromConfig(value: unknown): Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
}

function crazySeedFromConfig(value: unknown): number {
  const seed = Math.trunc(Number(value));
  return Number.isFinite(seed) ? seed : Math.floor(Math.random() * 0x7fffffff);
}

function crazyArcadeSideForSeat(seat: number, playerCount: number): CrazyArcadeSide {
  if (playerCount <= 2) {
    return seat === 0 ? 'challenger' : 'opponent';
  }
  return `seat${seat}`;
}

function crazyArcadeSideForSessionSeat(session: CrazyArcadeSession, seat: number): CrazyArcadeSide | undefined {
  return Object.keys(session.players)[seat] as CrazyArcadeSide | undefined;
}

function crazyArcadeSnapshotForSide(
  snapshot: Record<string, unknown>,
  mySide: string,
): Record<string, unknown> {
  const playerSide = typeof snapshot.playerSide === 'string' ? snapshot.playerSide : 'challenger';
  const opponentSide = typeof snapshot.opponentSide === 'string' ? snapshot.opponentSide : 'opponent';
  const others = isRecord(snapshot.others) ? snapshot.others : {};
  const bySide: Record<string, unknown> = {
    [playerSide]: snapshot.player,
    [opponentSide]: snapshot.opponent,
    ...others,
  };
  const myPlayer = bySide[mySide] ?? snapshot.player;
  const opponentEntry = Object.entries(bySide).find(([side]) => side !== mySide);
  const opponentSideForView = opponentEntry?.[0] ?? opponentSide;
  const opponentPlayer = opponentEntry?.[1] ?? snapshot.opponent;
  return {
    ...snapshot,
    playerSide: mySide,
    opponentSide: opponentSideForView,
    player: myPlayer,
    opponent: opponentPlayer,
    others: Object.fromEntries(
      Object.entries(bySide).filter(([side]) => side !== mySide && side !== opponentSideForView),
    ),
    playerWon: snapshot.winnerSide === mySide,
  };
}

export function createCrazyArcadeSnapshot(seed: number, difficulty: Difficulty): Record<string, unknown> {
  return createCrazyArcadeSnapshotForSides(['challenger', 'opponent'], seed, difficulty);
}

export function createCrazyArcadeSnapshotForSides(
  sides: string[],
  seed: number,
  difficulty: Difficulty,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const uniqueSides = [...new Set(sides.length > 0 ? sides : ['challenger', 'opponent'])].slice(0, 4);
  const fallbackSides = uniqueSides.length === 1 ? [...uniqueSides, 'opponent'] : uniqueSides;
  const players = Object.fromEntries(
    fallbackSides.map((side, index) => [side, createPlayer(startPositionForIndex(index), startFacingForIndex(index))]),
  );
  const firstSide = fallbackSides[0];
  const secondSide = fallbackSides[1] ?? 'opponent';
  const others = Object.fromEntries(
    Object.entries(players).filter(([side]) => side !== firstSide && side !== secondSide),
  );
  return serializeSnapshot({
    difficulty,
    tiles: generateMap(seed),
    playerSide: firstSide,
    opponentSide: secondSide,
    player: players[firstSide],
    opponent: players[secondSide],
    others,
    bombs: [],
    flames: [],
    items: [],
    gameFinished: false,
    playerWon: false,
    winnerSide: null,
    statusText: '물풍선을 설치하세요',
    bombSequence: 0,
    flameSequence: 0,
    aiThink: 0.35,
    serverTickAt: now,
  });
}

export function applyCrazyArcadeServerInput(
  session: CrazyArcadeSession,
  side: CrazyArcadeSide,
  input: Record<string, unknown>,
  now = new Date(),
): CrazyArcadeSession {
  if (session.status !== 'playing') {
    return session;
  }
  session.inputs[side] = {
    ...session.inputs[side],
    ...input,
    side,
    updatedAt: now.toISOString(),
  };
  return advanceCrazyArcadeServer(session, now);
}

export function advanceCrazyArcadeServer(
  session: CrazyArcadeSession,
  now = new Date(),
): CrazyArcadeSession {
  if (session.mode !== 'friend_match' || session.status !== 'playing') {
    return session;
  }
  const snapshot = snapshotFromUnknown(session.snapshot, session.difficulty);
  const previousTick = Date.parse(snapshot.serverTickAt);
  const rawDt = Number.isFinite(previousTick)
    ? (now.getTime() - previousTick) / 1000
    : 1 / 60;
  const dt = clamp(rawDt, 1 / 120, 0.25);
  snapshot.serverTickAt = now.toISOString();

  for (const entry of playerEntries(snapshot)) {
    updateTrap(entry.player, dt);
  }
  for (const side of Object.keys(session.players)) {
    applyPlayerInput(snapshot, side as CrazyArcadeSide, dt, session.inputs[side] ?? {});
  }
  updateBombs(snapshot, dt);
  updateFlames(snapshot, dt);
  checkFlameHits(snapshot);
  for (const entry of playerEntries(snapshot)) {
    collectItems(snapshot, entry.player);
  }

  session.snapshot = serializeSnapshot(snapshot);
  if (snapshot.gameFinished && snapshot.winnerSide) {
    session.status = 'finished';
    session.winnerSide = snapshot.winnerSide;
    session.winnerAccountId = session.players[snapshot.winnerSide];
    session.finishReason = 'elimination';
  }
  session.version += 1;
  session.updatedAt = now.toISOString();
  return session;
}

function applyPlayerInput(
  snapshot: CrazySnapshot,
  side: CrazyArcadeSide,
  dt: number,
  input: Record<string, unknown>,
): void {
  const subject = playerForSide(snapshot, side);
  if (!subject) {
    return;
  }
  if (!canAct(subject)) {
    subject.velocity = vector(0, 0);
    return;
  }
  const carry = input.carry === true;
  if (carry && !subject.carriedBombId) {
    startCarryBomb(snapshot, subject);
  } else if (!carry && subject.carriedBombId) {
    stopCarryBomb(snapshot, subject);
  }
  if (input.bomb === true) {
    placeBomb(snapshot, subject);
    input.bomb = false;
  }
  const direction = directionFromUnknown(input.direction);
  if (direction) {
    movePlayerContinuous(snapshot, subject, direction, dt, true);
  } else if (hasInertia(subject) && vectorDistance(subject.velocity) > 0.05) {
    subject.velocity = scale(subject.velocity, Math.max(0, 1 - dt * 5.4));
    if (!movePlayerContinuous(snapshot, subject, undefined, dt, false)) {
      subject.velocity = vector(0, 0);
    }
  } else {
    subject.velocity = vector(0, 0);
  }
}

function updateTrap(subject: PlayerState, dt: number): void {
  if (subject.trapTimer <= 0) return;
  subject.velocity = vector(0, 0);
  subject.trapTimer = Math.max(0, subject.trapTimer - dt);
  if (subject.trapTimer === 0 && !subject.eliminated) {
    subject.trappedFlameKeys = [];
  }
}

function updateBombs(snapshot: CrazySnapshot, dt: number): void {
  const expired: BombState[] = [];
  for (const bomb of snapshot.bombs) {
    updateSlidingBomb(snapshot, bomb, dt);
    const carrier = bomb.carriedBy ? playerForSide(snapshot, bomb.carriedBy as CrazyArcadeSide) : undefined;
    if (carrier) {
      bomb.position = positionFromPoint(carrier.center);
    }
    bomb.fuse -= dt;
    if (bomb.fuse <= 0) expired.push(bomb);
  }
  for (const bomb of expired) {
    explodeBomb(snapshot, bomb);
  }
}

function updateSlidingBomb(snapshot: CrazySnapshot, bomb: BombState, dt: number): void {
  if (bomb.carriedBy || !bomb.visualTo) return;
  bomb.slideTimer += dt;
  if (bomb.slideTimer < BOMB_SLIDE_CELL_SECONDS) return;
  bomb.slideTimer = 0;
  bomb.visualFrom = bomb.visualTo;
  if (bomb.slidePath.length === 0) {
    bomb.visualTo = null;
    bomb.visualFrom = null;
    return;
  }
  bomb.position = bomb.slidePath.shift()!;
  bomb.visualTo = bomb.position;
  if (flamesAt(snapshot, bomb.position)) {
    explodeBomb(snapshot, bomb);
  }
}

function updateFlames(snapshot: CrazySnapshot, dt: number): void {
  for (const flame of snapshot.flames) {
    flame.ttl -= dt;
  }
  snapshot.flames = snapshot.flames.filter((flame) => flame.ttl > 0);
}

function movePlayerContinuous(
  snapshot: CrazySnapshot,
  subject: PlayerState,
  direction: Direction | undefined,
  dt: number,
  fromInput: boolean,
): boolean {
  if (!canAct(subject)) return false;
  if (direction) {
    subject.facing = direction;
    subject.velocity = scale(directionVector(direction), moveSpeed(subject));
  }
  const delta = scale(subject.velocity, dt);
  if (vectorDistance(delta) < 0.0001) return false;
  const target = resolvedMoveTarget(snapshot, subject, direction, delta);
  if (target) {
    subject.center = target;
    syncCarriedBomb(snapshot, subject);
    return true;
  }
  const rawTarget = add(subject.center, delta);
  const blockingBomb = blockingBombAt(snapshot, subject, rawTarget);
  if (fromInput && direction && blockingBomb && subject.canKickBomb && kickBomb(snapshot, subject, blockingBomb, direction)) {
    return false;
  }
  return false;
}

function resolvedMoveTarget(
  snapshot: CrazySnapshot,
  subject: PlayerState,
  direction: Direction | undefined,
  delta: Vector,
): Vector | undefined {
  const rawTarget = add(subject.center, delta);
  const direct = applyCorridorLock(snapshot, subject, rawTarget);
  if (canOccupy(snapshot, subject, direct)) {
    return direct;
  }
  if (!direction) return undefined;
  const assisted = assistedTarget(snapshot, subject, direction, delta);
  if (assisted && canOccupy(snapshot, subject, assisted)) {
    return assisted;
  }
  const horizontal = vector(subject.center.dx + delta.dx, subject.center.dy);
  if (canOccupy(snapshot, subject, horizontal)) {
    return horizontal;
  }
  const vertical = vector(subject.center.dx, subject.center.dy + delta.dy);
  if (canOccupy(snapshot, subject, vertical)) {
    return vertical;
  }
  return undefined;
}

function assistedTarget(
  snapshot: CrazySnapshot,
  subject: PlayerState,
  direction: Direction,
  delta: Vector,
): Vector | undefined {
  const currentCell = positionFromPoint(subject.center);
  const next = movePosition(currentCell, direction);
  if (!inside(next) || blocksPlayerCell(snapshot, next)) {
    return undefined;
  }
  const centerX = currentCell.col + 0.5;
  const centerY = currentCell.row + 0.5;
  const assist = Math.min(MOVE_ASSIST_DISTANCE, vectorDistance(delta) * 1.6);
  if ((direction === 'up' || direction === 'down') && Math.abs(subject.center.dx - centerX) <= CORRIDOR_SNAP_TOLERANCE) {
    return vector(
      subject.center.dx + Math.sign(centerX - subject.center.dx) * assist,
      subject.center.dy + delta.dy,
    );
  }
  if ((direction === 'left' || direction === 'right') && Math.abs(subject.center.dy - centerY) <= CORRIDOR_SNAP_TOLERANCE) {
    return vector(
      subject.center.dx + delta.dx,
      subject.center.dy + Math.sign(centerY - subject.center.dy) * assist,
    );
  }
  return undefined;
}

function applyCorridorLock(snapshot: CrazySnapshot, subject: PlayerState, target: Vector): Vector {
  const position = positionFromPoint(subject.center);
  if (verticalCorridorLocked(snapshot, position)) {
    return vector(position.col + 0.5, target.dy);
  }
  if (horizontalCorridorLocked(snapshot, position)) {
    return vector(target.dx, position.row + 0.5);
  }
  return target;
}

function canOccupy(snapshot: CrazySnapshot, subject: PlayerState, center: Vector): boolean {
  const minRow = Math.floor(center.dy - PLAYER_RADIUS);
  const maxRow = Math.floor(center.dy + PLAYER_RADIUS);
  const minCol = Math.floor(center.dx - PLAYER_RADIUS);
  const maxCol = Math.floor(center.dx + PLAYER_RADIUS);
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      if (row < 0 || col < 0 || row >= ROWS || col >= COLS) return false;
      if (snapshot.tiles[row][col] !== 0) return false;
    }
  }
  return !blockingBombAt(snapshot, subject, center);
}

function blockingBombAt(snapshot: CrazySnapshot, subject: PlayerState, center: Vector): BombState | undefined {
  for (const bomb of snapshot.bombs) {
    if (bomb.carriedBy) continue;
    if (subject.passThroughBombIds.includes(bomb.id)) {
      if (bombOverlapsCenter(bomb, subject.center)) continue;
      subject.passThroughBombIds = subject.passThroughBombIds.filter((id) => id !== bomb.id);
    }
    if (bomb.position.row === positionFromPoint(subject.center).row &&
        bomb.position.col === positionFromPoint(subject.center).col &&
        bombOverlapsCenter(bomb, subject.center)) {
      continue;
    }
    if (bombOverlapsCenter(bomb, center)) return bomb;
  }
  return undefined;
}

function bombOverlapsCenter(bomb: BombState, center: Vector): boolean {
  const bombCenter = vector(bomb.position.col + 0.5, bomb.position.row + 0.5);
  return vectorDistance(subtract(bombCenter, center)) < PLAYER_RADIUS + BOMB_BLOCK_RADIUS;
}

function placeBomb(snapshot: CrazySnapshot, owner: PlayerState): void {
  const ownerId = sideForPlayer(snapshot, owner);
  if (!ownerId) return;
  owner.activeBombs = snapshot.bombs.filter((bomb) => bomb.ownerId === ownerId).length;
  const ownerPosition = positionFromPoint(owner.center);
  if (!canAct(owner) || owner.carriedBombId || owner.activeBombs >= owner.bombCapacity || bombAt(snapshot, ownerPosition)) {
    return;
  }
  const id = `${ownerId}-${snapshot.bombSequence++}`;
  snapshot.bombs.push({
    id,
    ownerId,
    position: ownerPosition,
    range: owner.range,
    fuse: BOMB_FUSE_SECONDS,
    carriedBy: null,
    slidePath: [],
    slideTimer: 0,
    visualFrom: null,
    visualTo: null,
  });
  owner.passThroughBombIds.push(id);
  owner.activeBombs += 1;
}

function kickBomb(snapshot: CrazySnapshot, subject: PlayerState, bomb: BombState, direction: Direction): boolean {
  if (bomb.carriedBy || bomb.visualTo) return false;
  const path: Position[] = [];
  let cursor = bomb.position;
  while (true) {
    const next = movePosition(cursor, direction);
    if (!inside(next) || snapshot.tiles[next.row][next.col] !== 0 || bombAt(snapshot, next)) break;
    path.push(next);
    cursor = next;
  }
  if (path.length === 0) return false;
  const original = bomb.position;
  bomb.position = path.shift()!;
  for (const entry of playerEntries(snapshot)) {
    entry.player.passThroughBombIds = entry.player.passThroughBombIds.filter((id) => id !== bomb.id);
  }
  bomb.slidePath = path;
  bomb.slideTimer = 0;
  bomb.visualFrom = original;
  bomb.visualTo = bomb.position;
  return true;
}

function startCarryBomb(snapshot: CrazySnapshot, subject: PlayerState): void {
  if (!canAct(subject) || !subject.canCarryBomb || subject.carriedBombId) return;
  const front = positionFromPoint(add(subject.center, scale(directionVector(subject.facing), 0.74)));
  const bomb = bombAt(snapshot, front);
  if (!bomb || bomb.visualTo) return;
  const side = sideForPlayer(snapshot, subject);
  if (!side) return;
  bomb.carriedBy = side;
  bomb.position = positionFromPoint(subject.center);
  bomb.visualFrom = null;
  bomb.visualTo = null;
  bomb.slidePath = [];
  subject.carriedBombId = bomb.id;
}

function stopCarryBomb(snapshot: CrazySnapshot, subject: PlayerState): void {
  const carriedId = subject.carriedBombId;
  if (!carriedId) return;
  const bomb = snapshot.bombs.find((item) => item.id === carriedId);
  if (bomb) {
    bomb.carriedBy = null;
    bomb.position = positionFromPoint(subject.center);
    bomb.visualFrom = null;
    bomb.visualTo = null;
    bomb.slidePath = [];
    subject.passThroughBombIds.push(bomb.id);
  }
  subject.carriedBombId = null;
}

function syncCarriedBomb(snapshot: CrazySnapshot, subject: PlayerState): void {
  if (!subject.carriedBombId) return;
  const bomb = snapshot.bombs.find((item) => item.id === subject.carriedBombId);
  if (!bomb) {
    subject.carriedBombId = null;
    return;
  }
  bomb.position = positionFromPoint(subject.center);
}

function explodeBomb(snapshot: CrazySnapshot, bomb: BombState): void {
  const index = snapshot.bombs.findIndex((item) => item.id === bomb.id);
  if (index < 0) return;
  snapshot.bombs.splice(index, 1);
  for (const entry of playerEntries(snapshot)) {
    if (entry.player.carriedBombId === bomb.id) entry.player.carriedBombId = null;
    entry.player.passThroughBombIds = entry.player.passThroughBombIds.filter((id) => id !== bomb.id);
  }
  const owner = playerForSide(snapshot, bomb.ownerId as CrazyArcadeSide);
  if (owner) {
    owner.activeBombs = snapshot.bombs.filter((activeBomb) => activeBomb.ownerId === bomb.ownerId).length;
  }
  const affected = new Map<string, Position>([[positionKey(bomb.position), bomb.position]]);
  for (const direction of DIRECTIONS) {
    let cursor = bomb.position;
    for (let step = 0; step < bomb.range; step += 1) {
      cursor = movePosition(cursor, direction);
      if (!inside(cursor)) break;
      const tile = snapshot.tiles[cursor.row][cursor.col];
      if (tile === 1) break;
      affected.set(positionKey(cursor), cursor);
      if (tile === 2) {
        snapshot.tiles[cursor.row][cursor.col] = 0;
        maybeDropItem(snapshot, cursor);
        break;
      }
    }
  }
  for (const affectedPosition of affected.values()) {
    snapshot.flames = snapshot.flames.filter((flame) => !samePosition(flame.position, affectedPosition));
    snapshot.flames.push({
      position: affectedPosition,
      ttl: FLAME_SECONDS,
      waveId: `wave-${snapshot.flameSequence++}-${bomb.id}`,
    });
  }
  const chained = snapshot.bombs.filter((next) => affected.has(positionKey(next.position)));
  for (const next of chained) {
    explodeBomb(snapshot, next);
  }
}

function maybeDropItem(snapshot: CrazySnapshot, itemPosition: Position): void {
  const roll = Math.random();
  if (roll > 0.34 || itemAt(snapshot, itemPosition)) return;
  snapshot.items.push({ type: randomItem(), position: itemPosition });
}

function randomItem(): ItemType {
  const roll = Math.random();
  if (roll < 0.27) return 'range';
  if (roll < 0.48) return 'bomb';
  if (roll < 0.72) return 'speed';
  if (roll < 0.88) return 'kick';
  return 'glove';
}

function checkFlameHits(snapshot: CrazySnapshot): void {
  for (const { player: subject } of playerEntries(snapshot)) {
    if (subject.eliminated) continue;
    const hitKeys = snapshot.flames
      .filter((flame) => flameHitsSubject(flame, subject))
      .map((flame) => flameHitKey(flame));
    if (hitKeys.length === 0) continue;
    if (isTrapped(subject)) {
      const newHit = hitKeys.some((hitKey) => !subject.trappedFlameKeys.includes(hitKey));
      if (!newHit) continue;
      subject.eliminated = true;
      subject.trapTimer = 0;
      subject.trappedFlameKeys = [];
    } else {
      subject.trapTimer = TRAP_SECONDS;
      subject.trappedFlameKeys = hitKeys;
    }
  }
  const active = playerEntries(snapshot).filter(({ player }) => !player.eliminated);
  if (snapshot.gameFinished || active.length > 1) {
    return;
  }
  snapshot.gameFinished = true;
  snapshot.winnerSide = active[0]?.side as CrazyArcadeSide | undefined ?? null;
  snapshot.playerWon = snapshot.winnerSide === snapshot.playerSide;
  snapshot.statusText = 'finished';
}

function flameHitsSubject(flame: FlameState, subject: PlayerState): boolean {
  const flameCenter = vector(flame.position.col + 0.5, flame.position.row + 0.5);
  const dx = Math.abs(subject.center.dx - flameCenter.dx);
  const dy = Math.abs(subject.center.dy - flameCenter.dy);
  return dx <= 0.5 + PLAYER_RADIUS * 0.35 && dy <= 0.5 + PLAYER_RADIUS * 0.35;
}

function collectItems(snapshot: CrazySnapshot, subject: PlayerState): void {
  if (!canAct(subject)) return;
  const item = itemTouching(snapshot, subject);
  if (!item) return;
  snapshot.items = snapshot.items.filter((candidate) => candidate !== item);
  if (item.type === 'range') {
    subject.range = Math.min(5, subject.range + 1);
  } else if (item.type === 'bomb') {
    subject.bombCapacity = Math.min(4, subject.bombCapacity + 1);
  } else if (item.type === 'speed') {
    subject.speedLevel = Math.min(5, subject.speedLevel + 1);
  } else if (item.type === 'kick') {
    subject.canKickBomb = true;
  } else {
    subject.canCarryBomb = true;
  }
}

function itemTouching(snapshot: CrazySnapshot, subject: PlayerState): ItemState | undefined {
  return snapshot.items.find((item) => {
    const center = vector(item.position.col + 0.5, item.position.row + 0.5);
    return vectorDistance(subtract(subject.center, center)) <= 0.45;
  });
}

function snapshotFromUnknown(value: unknown, difficulty: Difficulty): CrazySnapshot {
  const source = isRecord(value) ? value : {};
  if (!Array.isArray(source.tiles)) {
    return createSnapshotFromSeed(Number(source.seed) || Math.floor(Math.random() * 0x7fffffff), difficulty);
  }
  const playerSide = typeof source.playerSide === 'string' ? source.playerSide : 'challenger';
  const opponentSide = typeof source.opponentSide === 'string' ? source.opponentSide : 'opponent';
  const winnerSide = typeof source.winnerSide === 'string' ? source.winnerSide as CrazyArcadeSide : null;
  return {
    difficulty,
    tiles: parseTiles(source.tiles),
    playerSide,
    opponentSide,
    player: parsePlayer(source.player, createPlayer(position(1, 1), 'down')),
    opponent: parsePlayer(source.opponent, createPlayer(position(ROWS - 2, COLS - 2), 'up')),
    others: parseOtherPlayers(source.others),
    bombs: parseBombs(source.bombs),
    flames: parseFlames(source.flames),
    items: parseItems(source.items),
    gameFinished: source.gameFinished === true,
    playerWon: winnerSide ? winnerSide === playerSide : source.playerWon === true,
    winnerSide,
    statusText: typeof source.statusText === 'string' ? source.statusText : 'playing',
    bombSequence: intValue(source.bombSequence),
    flameSequence: intValue(source.flameSequence),
    aiThink: numberValue(source.aiThink, 0.35),
    serverTickAt: typeof source.serverTickAt === 'string' ? source.serverTickAt : new Date().toISOString(),
  };
}

function createSnapshotFromSeed(seed: number, difficulty: Difficulty): CrazySnapshot {
  return snapshotFromUnknown(createCrazyArcadeSnapshot(seed, difficulty), difficulty);
}

function serializeSnapshot(snapshot: CrazySnapshot): Record<string, unknown> {
  return {
    difficulty: snapshot.difficulty,
    tiles: snapshot.tiles,
    playerSide: snapshot.playerSide,
    opponentSide: snapshot.opponentSide,
    player: snapshot.player,
    opponent: snapshot.opponent,
    others: snapshot.others,
    bombs: snapshot.bombs,
    flames: snapshot.flames,
    items: snapshot.items,
    gameFinished: snapshot.gameFinished,
    playerWon: snapshot.playerWon,
    winnerSide: snapshot.winnerSide ?? null,
    statusText: snapshot.statusText,
    bombSequence: snapshot.bombSequence,
    flameSequence: snapshot.flameSequence,
    aiThink: snapshot.aiThink,
    serverTickAt: snapshot.serverTickAt,
  };
}

function generateMap(seed: number): Tile[][] {
  const random = seededRandom(seed);
  const map: Tile[][] = Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: COLS }, (_, col): Tile => {
      if (row === 0 || col === 0 || row === ROWS - 1 || col === COLS - 1) return 1;
      if (row % 2 === 0 && col % 2 === 0) return 1;
      return 0;
    }),
  );
  const safe = new Set([
    '1:1',
    '1:2',
    '2:1',
    `1:${COLS - 2}`,
    `1:${COLS - 3}`,
    `2:${COLS - 2}`,
    `${ROWS - 2}:1`,
    `${ROWS - 2}:2`,
    `${ROWS - 3}:1`,
    `${ROWS - 2}:${COLS - 2}`,
    `${ROWS - 2}:${COLS - 3}`,
    `${ROWS - 3}:${COLS - 2}`,
  ]);
  for (let row = 1; row < ROWS - 1; row += 1) {
    for (let col = 1; col < COLS - 1; col += 1) {
      if (map[row][col] !== 0 || safe.has(`${row}:${col}`)) continue;
      if (random() < 0.55) map[row][col] = 2;
    }
  }
  return map;
}

function createPlayer(playerPosition: Position, facing: Direction): PlayerState {
  return {
    center: vector(playerPosition.col + 0.5, playerPosition.row + 0.5),
    velocity: vector(0, 0),
    facing,
    bombCapacity: 1,
    activeBombs: 0,
    range: 2,
    speedLevel: 1,
    trapTimer: 0,
    eliminated: false,
    canKickBomb: false,
    canCarryBomb: false,
    carriedBombId: null,
    trappedFlameKeys: [],
    passThroughBombIds: [],
  };
}

function startPositionForIndex(index: number): Position {
  const starts = [
    position(1, 1),
    position(ROWS - 2, COLS - 2),
    position(1, COLS - 2),
    position(ROWS - 2, 1),
  ];
  return starts[index % starts.length];
}

function startFacingForIndex(index: number): Direction {
  return index === 0 || index === 2 ? 'down' : 'up';
}

function parseTiles(value: unknown): Tile[][] {
  if (!Array.isArray(value)) return generateMap(Math.floor(Math.random() * 0x7fffffff));
  return Array.from({ length: ROWS }, (_, row) => {
    const sourceRow = Array.isArray(value[row]) ? value[row] : [];
    return Array.from({ length: COLS }, (_, col): Tile => {
      const number = Number(sourceRow[col]);
      return number === 1 || number === 2 ? number : 0;
    });
  });
}

function parsePlayer(value: unknown, fallback: PlayerState): PlayerState {
  const source = isRecord(value) ? value : {};
  return {
    center: parseVector(source.center, fallback.center),
    velocity: parseVector(source.velocity, fallback.velocity),
    facing: directionFromUnknown(source.facing) ?? fallback.facing,
    bombCapacity: intValue(source.bombCapacity, fallback.bombCapacity),
    activeBombs: intValue(source.activeBombs, fallback.activeBombs),
    range: intValue(source.range, fallback.range),
    speedLevel: intValue(source.speedLevel, fallback.speedLevel),
    trapTimer: numberValue(source.trapTimer, fallback.trapTimer),
    eliminated: source.eliminated === true,
    canKickBomb: source.canKickBomb === true,
    canCarryBomb: source.canCarryBomb === true,
    carriedBombId: typeof source.carriedBombId === 'string' ? source.carriedBombId : null,
    trappedFlameKeys: stringList(source.trappedFlameKeys),
    passThroughBombIds: stringList(source.passThroughBombIds),
  };
}

function parseOtherPlayers(value: unknown): Record<string, PlayerState> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([side]) => side.length > 0)
      .map(([side, player]) => [side, parsePlayer(player, createPlayer(startPositionForIndex(2), 'down'))]),
  );
}

function parseBombs(value: unknown): BombState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): BombState[] => {
    if (!isRecord(item)) return [];
    const ownerId = typeof item.ownerId === 'string' && item.ownerId.length > 0
      ? legacyCrazyOwnerId(item.ownerId)
      : 'challenger';
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : `${ownerId}-legacy`,
      ownerId,
      position: parsePosition(item.position),
      range: intValue(item.range, 2),
      fuse: numberValue(item.fuse, BOMB_FUSE_SECONDS),
      carriedBy: typeof item.carriedBy === 'string' && item.carriedBy.length > 0
        ? legacyCrazyOwnerId(item.carriedBy)
        : null,
      slidePath: Array.isArray(item.slidePath) ? item.slidePath.map(parsePosition) : [],
      slideTimer: numberValue(item.slideTimer),
      visualFrom: isRecord(item.visualFrom) ? parsePosition(item.visualFrom) : null,
      visualTo: isRecord(item.visualTo) ? parsePosition(item.visualTo) : null,
    }];
  });
}

function parseFlames(value: unknown): FlameState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): FlameState[] => isRecord(item)
    ? [{
      position: parsePosition(item.position),
      ttl: numberValue(item.ttl, FLAME_SECONDS),
      waveId: typeof item.waveId === 'string' ? item.waveId : 'wave-legacy',
    }]
    : []);
}

function parseItems(value: unknown): ItemState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ItemState[] => {
    if (!isRecord(item)) return [];
    const type = item.type === 'bomb' || item.type === 'speed' || item.type === 'kick' || item.type === 'glove'
      ? item.type
      : 'range';
    return [{ type, position: parsePosition(item.position) }];
  });
}

function parsePosition(value: unknown): Position {
  const source = isRecord(value) ? value : {};
  return position(
    clamp(intValue(source.row), 0, ROWS - 1),
    clamp(intValue(source.col), 0, COLS - 1),
  );
}

function parseVector(value: unknown, fallback: Vector): Vector {
  const source = isRecord(value) ? value : {};
  return vector(numberValue(source.dx, fallback.dx), numberValue(source.dy, fallback.dy));
}

function playerForSide(snapshot: CrazySnapshot, side: CrazyArcadeSide): PlayerState | undefined {
  const normalized = legacyCrazyOwnerId(side);
  if (normalized === snapshot.playerSide || normalized === 'challenger') {
    return snapshot.player;
  }
  if (normalized === snapshot.opponentSide || normalized === 'opponent') {
    return snapshot.opponent;
  }
  return snapshot.others[normalized];
}

function playerEntries(snapshot: CrazySnapshot): Array<{ side: string; player: PlayerState }> {
  return [
    { side: snapshot.playerSide, player: snapshot.player },
    { side: snapshot.opponentSide, player: snapshot.opponent },
    ...Object.entries(snapshot.others).map(([side, player]) => ({ side, player })),
  ].filter((entry, index, entries) => entries.findIndex((candidate) => candidate.side === entry.side) === index);
}

function sideForPlayer(snapshot: CrazySnapshot, player: PlayerState): string | undefined {
  return playerEntries(snapshot).find((entry) => entry.player === player)?.side;
}

function legacyCrazyOwnerId(value: string): string {
  if (value === 'player') return 'challenger';
  if (value === 'opponent') return 'opponent';
  return value;
}

function canAct(subject: PlayerState): boolean {
  return !isTrapped(subject) && !subject.eliminated;
}

function isTrapped(subject: PlayerState): boolean {
  return subject.trapTimer > 0 && !subject.eliminated;
}

function hasInertia(subject: PlayerState): boolean {
  return subject.speedLevel > 1;
}

function moveSpeed(subject: PlayerState): number {
  return 3.9 + (subject.speedLevel - 1) * 0.85;
}

function bombAt(snapshot: CrazySnapshot, itemPosition: Position): BombState | undefined {
  return snapshot.bombs.find((bomb) => !bomb.carriedBy && samePosition(bomb.position, itemPosition));
}

function itemAt(snapshot: CrazySnapshot, itemPosition: Position): ItemState | undefined {
  return snapshot.items.find((item) => samePosition(item.position, itemPosition));
}

function flamesAt(snapshot: CrazySnapshot, itemPosition: Position): boolean {
  return snapshot.flames.some((flame) => samePosition(flame.position, itemPosition));
}

function blocksPlayerCell(snapshot: CrazySnapshot, itemPosition: Position): boolean {
  return !inside(itemPosition) || snapshot.tiles[itemPosition.row][itemPosition.col] !== 0;
}

function verticalCorridorLocked(snapshot: CrazySnapshot, itemPosition: Position): boolean {
  return blocksPlayerCell(snapshot, movePosition(itemPosition, 'up')) &&
    blocksPlayerCell(snapshot, movePosition(itemPosition, 'down'));
}

function horizontalCorridorLocked(snapshot: CrazySnapshot, itemPosition: Position): boolean {
  return blocksPlayerCell(snapshot, movePosition(itemPosition, 'left')) &&
    blocksPlayerCell(snapshot, movePosition(itemPosition, 'right'));
}

function directionVector(direction: Direction): Vector {
  if (direction === 'up') return vector(0, -1);
  if (direction === 'down') return vector(0, 1);
  if (direction === 'left') return vector(-1, 0);
  return vector(1, 0);
}

function movePosition(itemPosition: Position, direction: Direction): Position {
  if (direction === 'up') return position(itemPosition.row - 1, itemPosition.col);
  if (direction === 'down') return position(itemPosition.row + 1, itemPosition.col);
  if (direction === 'left') return position(itemPosition.row, itemPosition.col - 1);
  return position(itemPosition.row, itemPosition.col + 1);
}

function positionFromPoint(point: Vector): Position {
  return position(clamp(Math.floor(point.dy), 0, ROWS - 1), clamp(Math.floor(point.dx), 0, COLS - 1));
}

function inside(itemPosition: Position): boolean {
  return itemPosition.row >= 0 && itemPosition.col >= 0 && itemPosition.row < ROWS && itemPosition.col < COLS;
}

function samePosition(left: Position, right: Position): boolean {
  return left.row === right.row && left.col === right.col;
}

function positionKey(itemPosition: Position): string {
  return `${itemPosition.row}:${itemPosition.col}`;
}

function flameHitKey(flame: FlameState): string {
  return `${flame.waveId}:${positionKey(flame.position)}`;
}

function position(row: number, col: number): Position {
  return { row, col };
}

function vector(dx: number, dy: number): Vector {
  return { dx, dy };
}

function add(left: Vector, right: Vector): Vector {
  return vector(left.dx + right.dx, left.dy + right.dy);
}

function subtract(left: Vector, right: Vector): Vector {
  return vector(left.dx - right.dx, left.dy - right.dy);
}

function scale(source: Vector, amount: number): Vector {
  return vector(source.dx * amount, source.dy * amount);
}

function vectorDistance(source: Vector): number {
  return Math.hypot(source.dx, source.dy);
}

function directionFromUnknown(value: unknown): Direction | undefined {
  return value === 'up' || value === 'down' || value === 'left' || value === 'right' ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function intValue(value: unknown, fallback = 0): number {
  return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];

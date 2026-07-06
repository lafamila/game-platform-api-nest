import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import {
  Difficulty,
  GameMode,
  SokobanPlayerState,
  SokobanPosition,
  SokobanSession,
  SokobanSide,
} from './games.types';

export const SOKOBAN_STATE_VERSION = 1;

interface SokobanMapConfig {
  key: string;
  walls: SokobanPosition[];
  goals: SokobanPosition[];
  player: SokobanPosition;
  boxes: SokobanPosition[];
}

export const SOKOBAN_ENGINE: GameEngine<SokobanSession> = {
  descriptor: {
    key: 'sokoban',
    title: 'Sokoban',
    minPlayers: 1,
    maxPlayers: 6,
    modes: ['solo', 'friend_match'],
    turnType: 'simultaneous',
    hiddenInfo: false,
    supportsAi: true,
    supportsMatchSave: true,
    status: 'playable',
  },
  stateVersion: SOKOBAN_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): SokobanSession {
    const map = sokobanMapFromConfig(config.map);
    return createSokobanSessionState({
      id: typeof config.id === 'string' ? config.id : '',
      mode: sokobanModeFromConfig(config.mode, players.length),
      difficulty: sokobanDifficultyFromConfig(config.difficulty),
      ownerAccountId: players[0]?.accountId ?? '',
      map,
      players: players.length > 1 ? sokobanPlayersFromSeats(players) : undefined,
    });
  },
  applyAction(state: SokobanSession, seat: number, action: GameAction) {
    if (action.type !== 'move') {
      throw new BadRequestException('unsupported sokoban action');
    }
    const side = state.players ? sokobanSides(state)[seat] : undefined;
    const playerState = side && state.players ? ensureSokobanPlayerState(state, side) : state.state;
    const moveResult = applySokobanMove(state, playerState, String(action.payload?.direction ?? ''));
    if (moveResult.moved) {
      finishSokobanAfterMove(state, playerState, side, moveResult.pushedBox);
      state.updatedAt = new Date().toISOString();
    }
    return { state };
  },
  viewFor(state: SokobanSession, seat: number | 'spectator') {
    if (seat === 'spectator' || !state.players) {
      return state;
    }
    const side = sokobanSides(state)[seat];
    return side ? sessionForSokobanSide(state, side) : state;
  },
  finishInfo(state: SokobanSession) {
    if (state.status !== 'finished') {
      return null;
    }
    const side = state.winnerSide;
    const winnerSeat = side ? sokobanSides(state).indexOf(side) : undefined;
    return {
      status: state.finishReason === 'solo_clear' ? 'cleared' : 'finished',
      winnerSeat: winnerSeat === -1 ? undefined : winnerSeat,
      reason: state.finishReason,
    };
  },
};

function sokobanModeFromConfig(value: unknown, playerCount: number): GameMode {
  if (value === 'friend_match' || playerCount > 1) return 'friend_match';
  return 'solo';
}

function sokobanDifficultyFromConfig(value: unknown): Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
}

function sokobanMapFromConfig(value: unknown): SokobanMapConfig {
  if (!value || typeof value !== 'object') {
    throw new BadRequestException('sokoban map is required');
  }
  const map = value as Partial<SokobanMapConfig>;
  if (!map.key || !Array.isArray(map.walls) || !Array.isArray(map.goals) || !map.player || !Array.isArray(map.boxes)) {
    throw new BadRequestException('invalid sokoban map');
  }
  return {
    key: map.key,
    walls: map.walls.map(clonePosition),
    goals: map.goals.map(clonePosition),
    player: clonePosition(map.player),
    boxes: map.boxes.map(clonePosition),
  };
}

function sokobanPlayersFromSeats(players: SeatInfo[]): Record<SokobanSide, string> {
  return Object.fromEntries(
    players.map((player, index) => [
      index === 0 ? 'challenger' : index === 1 ? 'opponent' : `seat${index}`,
      player.accountId ?? '',
    ]),
  );
}

export function createSokobanSessionState(input: {
  id: string;
  mode: GameMode;
  difficulty: Difficulty;
  ownerAccountId: string;
  map: SokobanMapConfig;
  players?: Record<SokobanSide, string>;
}): SokobanSession {
  const now = new Date().toISOString();
  const session: SokobanSession = {
    id: input.id,
    mode: input.mode,
    ownerAccountId: input.ownerAccountId,
    difficulty: input.difficulty,
    mapKey: input.map.key,
    walls: input.map.walls.map(clonePosition),
    goals: input.map.goals.map(clonePosition),
    initialPlayer: clonePosition(input.map.player),
    initialBoxes: input.map.boxes.map(clonePosition),
    state: createSokobanPlayerState(input.map),
    status: 'playing',
    createdAt: now,
    updatedAt: now,
  };
  if (input.players) {
    session.players = { ...input.players };
    session.states = Object.fromEntries(
      Object.keys(input.players).map((side) => [side, createSokobanPlayerState(input.map)]),
    ) as Record<SokobanSide, SokobanPlayerState>;
  }
  return session;
}

export function createSokobanPlayerState(input: { player: SokobanPosition; boxes: SokobanPosition[] }): SokobanPlayerState {
  return {
    player: { ...input.player },
    boxes: input.boxes.map((box) => ({ ...box })),
    moves: 0,
    solved: false,
  };
}

export function ensureSokobanPlayerState(session: SokobanSession, side: SokobanSide): SokobanPlayerState {
  session.states ??= {};
  for (const playerSide of sokobanSides(session)) {
    session.states[playerSide] ??= createSokobanPlayerState({ player: session.initialPlayer, boxes: session.initialBoxes });
  }
  session.states[side] ??= createSokobanPlayerState({ player: session.initialPlayer, boxes: session.initialBoxes });
  return session.states[side];
}

export function sessionForSokobanSide(session: SokobanSession, side: SokobanSide): SokobanSession {
  return {
    ...session,
    mySide: side,
    state: ensureSokobanPlayerState(session, side),
  };
}

export function sokobanSides(session: SokobanSession): SokobanSide[] {
  const sides = Object.keys(session.players ?? {});
  return sides.length > 0 ? sides : ['challenger', 'opponent'];
}

export function sokobanSideForAccount(session: SokobanSession, accountId: string): SokobanSide | undefined {
  for (const [side, playerAccountId] of Object.entries(session.players ?? {})) {
    if (playerAccountId === accountId) return side;
  }
  return undefined;
}

export function firstOtherSokobanSide(session: SokobanSession, side: SokobanSide): SokobanSide | undefined {
  return sokobanSides(session).find((candidate) => candidate !== side);
}

export function finishSokobanAfterMove(
  session: SokobanSession,
  playerState: SokobanPlayerState,
  side: SokobanSide | undefined,
  pushedBox?: SokobanPosition,
): void {
  if (playerState.solved) {
    session.status = 'finished';
    session.solvedAt = new Date().toISOString();
    session.winnerSide = side ?? 'challenger';
    session.winnerAccountId = side ? session.players?.[side] : session.ownerAccountId;
    session.finishReason = side ? 'first_clear' : 'solo_clear';
  } else if (
    pushedBox &&
    isSokobanBoxTouchingWall(session, pushedBox) &&
    !isSokobanStateSolvable(session, playerState)
  ) {
    session.status = 'finished';
    session.finishReason = 'deadlock';
    if (side && session.players) {
      const winner = firstOtherSokobanSide(session, side);
      session.winnerSide = winner;
      session.winnerAccountId = winner ? session.players[winner] : undefined;
    }
  }
}

export function applySokobanMove(
  session: SokobanSession,
  state: SokobanPlayerState,
  direction: string,
): { moved: boolean; pushedBox?: SokobanPosition } {
  const delta = sokobanDelta(direction);
  const next = { row: state.player.row + delta.row, col: state.player.col + delta.col };
  if (!isSokobanFloor(session, next) || hasPosition(session.walls, next)) {
    return { moved: false };
  }
  const boxIndex = state.boxes.findIndex((box) => samePosition(box, next));
  let pushedBox: SokobanPosition | undefined;
  if (boxIndex >= 0) {
    const pushed = { row: next.row + delta.row, col: next.col + delta.col };
    if (!isSokobanFloor(session, pushed) || hasPosition(session.walls, pushed) || state.boxes.some((box, index) => index !== boxIndex && samePosition(box, pushed))) {
      return { moved: false };
    }
    state.boxes[boxIndex] = pushed;
    pushedBox = pushed;
  }
  state.player = next;
  state.moves += 1;
  state.solved = state.boxes.every((box) => hasPosition(session.goals, box));
  return { moved: true, pushedBox };
}

export function isSokobanBoxTouchingWall(session: SokobanSession, box: SokobanPosition): boolean {
  return SOKOBAN_DELTAS.some((delta) => hasPosition(session.walls, { row: box.row + delta.row, col: box.col + delta.col }));
}

export function isSokobanStateSolvable(session: SokobanSession, state: SokobanPlayerState): boolean {
  if (state.boxes.every((box) => hasPosition(session.goals, box))) {
    return true;
  }
  const queue: Array<{ player: SokobanPosition; boxes: SokobanPosition[] }> = [
    { player: { ...state.player }, boxes: state.boxes.map((box) => ({ ...box })) },
  ];
  const seen = new Set<string>([sokobanSearchKey(queue[0].player, queue[0].boxes)]);
  let index = 0;
  while (index < queue.length) {
    const current = queue[index++];
    const reachable = reachableSokobanPositions(session, current.player, current.boxes);
    for (let boxIndex = 0; boxIndex < current.boxes.length; boxIndex += 1) {
      const box = current.boxes[boxIndex];
      for (const delta of SOKOBAN_DELTAS) {
        const pushFrom = { row: box.row - delta.row, col: box.col - delta.col };
        const pushed = { row: box.row + delta.row, col: box.col + delta.col };
        if (!reachable.has(positionKey(pushFrom)) || !isSokobanFree(session, pushed, current.boxes)) {
          continue;
        }
        const nextBoxes = current.boxes.map((item, itemIndex) =>
          itemIndex === boxIndex ? pushed : { ...item },
        );
        if (nextBoxes.every((item) => hasPosition(session.goals, item))) {
          return true;
        }
        const nextPlayer = { ...box };
        const key = sokobanSearchKey(nextPlayer, nextBoxes);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        queue.push({ player: nextPlayer, boxes: nextBoxes });
        if (seen.size > 100000) {
          // Avoid false losses if a future map is much larger than the current set.
          return true;
        }
      }
    }
  }
  return false;
}

const SOKOBAN_DELTAS: SokobanPosition[] = [
  { row: -1, col: 0 },
  { row: 1, col: 0 },
  { row: 0, col: -1 },
  { row: 0, col: 1 },
];

function reachableSokobanPositions(session: SokobanSession, player: SokobanPosition, boxes: SokobanPosition[]): Set<string> {
  const queue = [{ ...player }];
  const seen = new Set<string>([positionKey(player)]);
  let index = 0;
  while (index < queue.length) {
    const current = queue[index++];
    for (const delta of SOKOBAN_DELTAS) {
      const next = { row: current.row + delta.row, col: current.col + delta.col };
      const key = positionKey(next);
      if (seen.has(key) || !isSokobanFree(session, next, boxes)) {
        continue;
      }
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}

function isSokobanFree(session: SokobanSession, position: SokobanPosition, boxes: SokobanPosition[]): boolean {
  return isSokobanFloor(session, position) && !hasPosition(session.walls, position) && !hasPosition(boxes, position);
}

function isSokobanFloor(session: SokobanSession, position: SokobanPosition): boolean {
  const bounds = sokobanBounds(session);
  return position.row >= bounds.minRow && position.row <= bounds.maxRow && position.col >= bounds.minCol && position.col <= bounds.maxCol;
}

function sokobanBounds(session: SokobanSession): { minRow: number; maxRow: number; minCol: number; maxCol: number } {
  const positions = [...session.walls, ...session.goals, session.initialPlayer, ...session.initialBoxes];
  return positions.reduce(
    (bounds, position) => ({
      minRow: Math.min(bounds.minRow, position.row),
      maxRow: Math.max(bounds.maxRow, position.row),
      minCol: Math.min(bounds.minCol, position.col),
      maxCol: Math.max(bounds.maxCol, position.col),
    }),
    { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 },
  );
}

function sokobanSearchKey(player: SokobanPosition, boxes: SokobanPosition[]): string {
  return `${positionKey(player)}|${boxes.map(positionKey).sort().join(';')}`;
}

function positionKey(position: SokobanPosition): string {
  return `${position.row},${position.col}`;
}

function sokobanDelta(direction: string): SokobanPosition {
  if (direction === 'up') return { row: -1, col: 0 };
  if (direction === 'down') return { row: 1, col: 0 };
  if (direction === 'left') return { row: 0, col: -1 };
  if (direction === 'right') return { row: 0, col: 1 };
  throw new BadRequestException('direction must be up, down, left, or right');
}

function clonePosition(position: SokobanPosition): SokobanPosition {
  return { row: position.row, col: position.col };
}

export function samePosition(left: SokobanPosition, right: SokobanPosition): boolean {
  return left.row === right.row && left.col === right.col;
}

export function hasPosition(items: SokobanPosition[], target: SokobanPosition): boolean {
  return items.some((item) => samePosition(item, target));
}

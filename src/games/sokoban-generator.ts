import { Difficulty, SokobanPosition } from './games.types';

export interface GeneratedSokobanMap {
  key: string;
  walls: SokobanPosition[];
  goals: SokobanPosition[];
  player: SokobanPosition;
  boxes: SokobanPosition[];
  metrics: {
    pushes: number;
    boxLines: number;
    boxChanges: number;
  };
}

interface SokobanDifficultyConfig {
  minRows: number;
  maxRows: number;
  minCols: number;
  maxCols: number;
  boxes: number;
  innerWallRate: number;
  attempts: number;
  searchLimit: number;
  minPushes: number;
  targetPushes: number;
  minBoxLines: number;
  targetBoxLines: number;
  maxBoxLines: number;
}

interface SokobanRoom {
  rows: number;
  cols: number;
  walls: Set<string>;
  floors: SokobanPosition[];
}

interface ReverseMove {
  boxIndex: number;
  direction: SokobanPosition;
}

interface ReverseState {
  player: SokobanPosition;
  boxes: SokobanPosition[];
  path: ReverseMove[];
}

interface Candidate {
  room: SokobanRoom;
  goals: SokobanPosition[];
  state: ReverseState;
  metrics: GeneratedSokobanMap['metrics'];
  score: number;
}

const SOKOBAN_GENERATOR_CONFIG: Record<Difficulty, SokobanDifficultyConfig> = {
  easy: {
    minRows: 6,
    maxRows: 7,
    minCols: 7,
    maxCols: 8,
    boxes: 1,
    innerWallRate: 0.03,
    attempts: 20,
    searchLimit: 600,
    minPushes: 2,
    targetPushes: 5,
    minBoxLines: 1,
    targetBoxLines: 2,
    maxBoxLines: 4,
  },
  medium: {
    minRows: 7,
    maxRows: 8,
    minCols: 8,
    maxCols: 9,
    boxes: 2,
    innerWallRate: 0.08,
    attempts: 30,
    searchLimit: 1200,
    minPushes: 7,
    targetPushes: 13,
    minBoxLines: 3,
    targetBoxLines: 5,
    maxBoxLines: 9,
  },
  hard: {
    minRows: 8,
    maxRows: 9,
    minCols: 9,
    maxCols: 10,
    boxes: 3,
    innerWallRate: 0.1,
    attempts: 25,
    searchLimit: 1200,
    minPushes: 10,
    targetPushes: 18,
    minBoxLines: 5,
    targetBoxLines: 7,
    maxBoxLines: 13,
  },
};

const SOKOBAN_THOROUGH_GENERATOR_CONFIG: Record<Difficulty, SokobanDifficultyConfig> = {
  easy: {
    minRows: 6,
    maxRows: 7,
    minCols: 7,
    maxCols: 8,
    boxes: 1,
    innerWallRate: 0.03,
    attempts: 70,
    searchLimit: 900,
    minPushes: 2,
    targetPushes: 5,
    minBoxLines: 1,
    targetBoxLines: 2,
    maxBoxLines: 4,
  },
  medium: {
    minRows: 7,
    maxRows: 8,
    minCols: 8,
    maxCols: 9,
    boxes: 2,
    innerWallRate: 0.08,
    attempts: 90,
    searchLimit: 2400,
    minPushes: 7,
    targetPushes: 13,
    minBoxLines: 3,
    targetBoxLines: 5,
    maxBoxLines: 9,
  },
  hard: {
    minRows: 8,
    maxRows: 9,
    minCols: 9,
    maxCols: 10,
    boxes: 3,
    innerWallRate: 0.12,
    attempts: 120,
    searchLimit: 5600,
    minPushes: 12,
    targetPushes: 24,
    minBoxLines: 6,
    targetBoxLines: 9,
    maxBoxLines: 16,
  },
};

const SOKOBAN_DIRECTIONS: SokobanPosition[] = [
  { row: -1, col: 0 },
  { row: 1, col: 0 },
  { row: 0, col: -1 },
  { row: 0, col: 1 },
];

export function createSokobanMap(difficulty: Difficulty): GeneratedSokobanMap {
  return createSokobanMapWithStrategy(difficulty, false);
}

export function createVerifiedSokobanMap(difficulty: Difficulty): GeneratedSokobanMap {
  return createSokobanMapWithStrategy(difficulty, true);
}

function createSokobanMapWithStrategy(difficulty: Difficulty, thorough: boolean): GeneratedSokobanMap {
  const config = thorough
    ? SOKOBAN_THOROUGH_GENERATOR_CONFIG[difficulty]
    : SOKOBAN_GENERATOR_CONFIG[difficulty];
  const attempts = config.attempts;
  const openFallbackAttempts = thorough ? 60 : 30;
  let best: Candidate | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const room = createSokobanRoom(config, false);
    const goals = chooseSokobanGoals(room, config.boxes);
    if (goals.length !== config.boxes) {
      continue;
    }
    const candidate = thorough
      ? reverseSearchSokobanThorough(room, goals, config)
      : reverseSearchSokobanFast(room, goals, config);
    if (!candidate) {
      continue;
    }
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
    if (
      candidate.metrics.pushes >= config.targetPushes &&
      candidate.metrics.boxLines >= config.targetBoxLines &&
      candidate.metrics.boxLines <= config.maxBoxLines
    ) {
      return mapFromCandidate(difficulty, candidate);
    }
  }

  for (let attempt = 0; attempt < openFallbackAttempts; attempt += 1) {
    const room = createSokobanRoom(config, true);
    const goals = chooseSokobanGoals(room, config.boxes);
    if (goals.length !== config.boxes) {
      continue;
    }
    const candidate = thorough
      ? reverseSearchSokobanThorough(room, goals, config)
      : reverseSearchSokobanFast(room, goals, config);
    if (candidate && (!best || candidate.score > best.score)) {
      best = candidate;
    }
  }

  if (!best) {
    throw new Error(`failed to generate ${difficulty} sokoban map`);
  }
  return mapFromCandidate(difficulty, best);
}

function createSokobanRoom(config: SokobanDifficultyConfig, openFallback: boolean): SokobanRoom {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const rows = randomInt(config.minRows, config.maxRows);
    const cols = randomInt(config.minCols, config.maxCols);
    const walls = new Set<string>();
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const border = row === 0 || col === 0 || row === rows - 1 || col === cols - 1;
        if (border || (!openFallback && Math.random() < config.innerWallRate)) {
          walls.add(positionKey({ row, col }));
        }
      }
    }
    const room = buildRoom(rows, cols, walls);
    if (isUsableSokobanRoom(room, config.boxes)) {
      return room;
    }
  }
  return buildRoom(config.maxRows, config.maxCols, outerWallSet(config.maxRows, config.maxCols));
}

function buildRoom(rows: number, cols: number, walls: Set<string>): SokobanRoom {
  const floors: SokobanPosition[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const position = { row, col };
      if (!walls.has(positionKey(position))) {
        floors.push(position);
      }
    }
  }
  return { rows, cols, walls, floors };
}

function outerWallSet(rows: number, cols: number): Set<string> {
  const walls = new Set<string>();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (row === 0 || col === 0 || row === rows - 1 || col === cols - 1) {
        walls.add(positionKey({ row, col }));
      }
    }
  }
  return walls;
}

function isUsableSokobanRoom(room: SokobanRoom, boxes: number): boolean {
  if (room.floors.length < boxes * 8) {
    return false;
  }
  if (!allFloorsConnected(room)) {
    return false;
  }
  return !room.floors.some((floor) => blockedNeighborCount(room, floor) >= 3);
}

function allFloorsConnected(room: SokobanRoom): boolean {
  const start = room.floors[0];
  if (!start) {
    return false;
  }
  const queue = [start];
  const seen = new Set<string>([positionKey(start)]);
  let index = 0;
  while (index < queue.length) {
    const current = queue[index++];
    for (const direction of SOKOBAN_DIRECTIONS) {
      const next = addPosition(current, direction);
      const key = positionKey(next);
      if (!seen.has(key) && isRoomFloor(room, next)) {
        seen.add(key);
        queue.push(next);
      }
    }
  }
  return seen.size === room.floors.length;
}

function blockedNeighborCount(room: SokobanRoom, position: SokobanPosition): number {
  return SOKOBAN_DIRECTIONS.filter((direction) => !isRoomFloor(room, addPosition(position, direction))).length;
}

function chooseSokobanGoals(room: SokobanRoom, count: number): SokobanPosition[] {
  const candidates = shuffle(room.floors.filter((position) => hasPullSpace(room, position)));
  for (let attempt = 0; attempt < 140; attempt += 1) {
    const goals: SokobanPosition[] = [];
    for (const candidate of shuffle(candidates)) {
      if (goals.every((goal) => manhattan(goal, candidate) >= 2)) {
        goals.push(candidate);
      }
      if (goals.length === count) {
        return goals.map(clonePosition);
      }
    }
  }
  return candidates.slice(0, count).map(clonePosition);
}

function hasPullSpace(room: SokobanRoom, position: SokobanPosition): boolean {
  return SOKOBAN_DIRECTIONS.some((direction) => {
    const boxFrom = subtractPosition(position, direction);
    const playerFrom = subtractPosition(boxFrom, direction);
    return isRoomFloor(room, boxFrom) && isRoomFloor(room, playerFrom);
  });
}

function reverseSearchSokobanFast(
  room: SokobanRoom,
  goals: SokobanPosition[],
  config: SokobanDifficultyConfig,
): Candidate | undefined {
  const startPlayers = shuffle(room.floors.filter((floor) => !hasPosition(goals, floor))).slice(0, 4);
  const walksPerStart = Math.max(8, Math.floor(config.searchLimit / 100));
  const maxDepth = config.targetPushes + config.targetBoxLines + config.boxes * 2;
  let best: Candidate | undefined;

  for (const startPlayer of startPlayers) {
    for (let walk = 0; walk < walksPerStart; walk += 1) {
      let current: ReverseState = {
        player: clonePosition(startPlayer),
        boxes: goals.map(clonePosition),
        path: [],
      };
      const seen = new Set<string>([stateKey(current)]);

      for (let depth = 0; depth < maxDepth; depth += 1) {
        const options = reverseNextStates(room, current).filter((state) => !seen.has(stateKey(state)));
        if (options.length === 0) {
          break;
        }
        options.sort((left, right) => {
          return reverseStateScore(right, config) - reverseStateScore(left, config);
        });
        const next = options[Math.floor(Math.random() * Math.min(options.length, 3))];
        current = next;
        seen.add(stateKey(current));
        const metrics = scoreReversePath(next.path);
        if (metrics.pushes < config.minPushes || metrics.boxLines < config.minBoxLines) {
          continue;
        }
        const score = sokobanCandidateScore(metrics, config);
        if (!best || score > best.score) {
          best = {
            room,
            goals: goals.map(clonePosition),
            state: next,
            metrics,
            score,
          };
        }
        if (
          metrics.pushes >= config.targetPushes &&
          metrics.boxLines >= config.targetBoxLines &&
          metrics.boxLines <= config.maxBoxLines
        ) {
          return best;
        }
      }
    }
  }
  return best;
}

function reverseSearchSokobanThorough(
  room: SokobanRoom,
  goals: SokobanPosition[],
  config: SokobanDifficultyConfig,
): Candidate | undefined {
  const startPlayers = shuffle(room.floors.filter((floor) => !hasPosition(goals, floor))).slice(0, 8);
  let best: Candidate | undefined;

  for (const startPlayer of startPlayers) {
    const initial: ReverseState = {
      player: clonePosition(startPlayer),
      boxes: goals.map(clonePosition),
      path: [],
    };
    const queue: ReverseState[] = [initial];
    const seen = new Set<string>([stateKey(initial)]);
    let index = 0;

    while (index < queue.length && seen.size < config.searchLimit) {
      const current = queue[index++];
      for (const next of shuffle(reverseNextStates(room, current))) {
        const key = stateKey(next);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        queue.push(next);
        const metrics = scoreReversePath(next.path);
        if (metrics.pushes < config.minPushes || metrics.boxLines < config.minBoxLines) {
          continue;
        }
        const score = sokobanCandidateScore(metrics, config);
        if (!best || score > best.score) {
          best = {
            room,
            goals: goals.map(clonePosition),
            state: next,
            metrics,
            score,
          };
        }
      }
    }
  }
  return best;
}

function reverseStateScore(state: ReverseState, config: SokobanDifficultyConfig): number {
  return sokobanCandidateScore(scoreReversePath(state.path), config) + Math.random() * 8;
}

function reverseNextStates(room: SokobanRoom, state: ReverseState): ReverseState[] {
  const reachable = reachableRoomPositions(room, state.player, state.boxes);
  const nextStates: ReverseState[] = [];
  for (let boxIndex = 0; boxIndex < state.boxes.length; boxIndex += 1) {
    const currentBox = state.boxes[boxIndex];
    for (const direction of SOKOBAN_DIRECTIONS) {
      const previousBox = subtractPosition(currentBox, direction);
      const previousPlayer = subtractPosition(previousBox, direction);
      if (
        !reachable.has(positionKey(previousBox)) ||
        !isRoomFree(room, previousBox, state.boxes) ||
        !isRoomFree(room, previousPlayer, state.boxes)
      ) {
        continue;
      }
      const boxes = state.boxes.map((box, index) => (index === boxIndex ? previousBox : clonePosition(box)));
      nextStates.push({
        player: previousPlayer,
        boxes,
        path: [...state.path, { boxIndex, direction }],
      });
    }
  }
  return nextStates;
}

function reachableRoomPositions(room: SokobanRoom, player: SokobanPosition, boxes: SokobanPosition[]): Set<string> {
  const queue = [clonePosition(player)];
  const seen = new Set<string>([positionKey(player)]);
  let index = 0;
  while (index < queue.length) {
    const current = queue[index++];
    for (const direction of SOKOBAN_DIRECTIONS) {
      const next = addPosition(current, direction);
      const key = positionKey(next);
      if (seen.has(key) || !isRoomFree(room, next, boxes)) {
        continue;
      }
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}

function scoreReversePath(path: ReverseMove[]): GeneratedSokobanMap['metrics'] {
  const forward = [...path].reverse();
  let boxLines = 0;
  let boxChanges = 0;
  let previous: ReverseMove | undefined;
  for (const move of forward) {
    if (!previous || previous.boxIndex !== move.boxIndex || !samePosition(previous.direction, move.direction)) {
      boxLines += 1;
    }
    if (previous && previous.boxIndex !== move.boxIndex) {
      boxChanges += 1;
    }
    previous = move;
  }
  return { pushes: path.length, boxLines, boxChanges };
}

function sokobanCandidateScore(metrics: GeneratedSokobanMap['metrics'], config: SokobanDifficultyConfig): number {
  const pushDelta = Math.abs(metrics.pushes - config.targetPushes);
  const lineDelta = Math.abs(metrics.boxLines - config.targetBoxLines);
  const lineOverflow = Math.max(0, metrics.boxLines - config.maxBoxLines);
  return metrics.pushes * 2 + metrics.boxLines * 18 + metrics.boxChanges * 6 - pushDelta * 3 - lineDelta * 12 - lineOverflow * 16;
}

function mapFromCandidate(difficulty: Difficulty, candidate: Candidate): GeneratedSokobanMap {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    key: [
      difficulty,
      `${candidate.room.rows}x${candidate.room.cols}`,
      `b${candidate.state.boxes.length}`,
      `p${candidate.metrics.pushes}`,
      `l${candidate.metrics.boxLines}`,
      suffix,
    ].join('-'),
    walls: [...candidate.room.walls].map(positionFromKey).sort(comparePosition),
    goals: candidate.goals.map(clonePosition).sort(comparePosition),
    player: clonePosition(candidate.state.player),
    boxes: candidate.state.boxes.map(clonePosition).sort(comparePosition),
    metrics: candidate.metrics,
  };
}

function isRoomFloor(room: SokobanRoom, position: SokobanPosition): boolean {
  return (
    position.row >= 0 &&
    position.row < room.rows &&
    position.col >= 0 &&
    position.col < room.cols &&
    !room.walls.has(positionKey(position))
  );
}

function isRoomFree(room: SokobanRoom, position: SokobanPosition, boxes: SokobanPosition[]): boolean {
  return isRoomFloor(room, position) && !hasPosition(boxes, position);
}

function stateKey(state: ReverseState): string {
  return `${positionKey(state.player)}|${state.boxes.map(positionKey).sort().join(';')}`;
}

function positionKey(position: SokobanPosition): string {
  return `${position.row},${position.col}`;
}

function positionFromKey(key: string): SokobanPosition {
  const [row, col] = key.split(',').map(Number);
  return { row: row ?? 0, col: col ?? 0 };
}

function addPosition(position: SokobanPosition, delta: SokobanPosition): SokobanPosition {
  return { row: position.row + delta.row, col: position.col + delta.col };
}

function subtractPosition(position: SokobanPosition, delta: SokobanPosition): SokobanPosition {
  return { row: position.row - delta.row, col: position.col - delta.col };
}

function clonePosition(position: SokobanPosition): SokobanPosition {
  return { row: position.row, col: position.col };
}

function samePosition(left: SokobanPosition, right: SokobanPosition): boolean {
  return left.row === right.row && left.col === right.col;
}

function hasPosition(items: SokobanPosition[], target: SokobanPosition): boolean {
  return items.some((item) => samePosition(item, target));
}

function comparePosition(left: SokobanPosition, right: SokobanPosition): number {
  return left.row === right.row ? left.col - right.col : left.row - right.row;
}

function manhattan(left: SokobanPosition, right: SokobanPosition): number {
  return Math.abs(left.row - right.row) + Math.abs(left.col - right.col);
}

function randomInt(minValue: number, maxValue: number): number {
  return minValue + Math.floor(Math.random() * (maxValue - minValue + 1));
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

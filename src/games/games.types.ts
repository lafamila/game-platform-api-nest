export type Difficulty = 'easy' | 'medium' | 'hard';
export type PlayerColor = 'black' | 'white';
export type OthelloColor = 'black' | 'white';
export type PieceTeam = 'red' | 'blue';
export type SudokuSide = 'challenger' | 'opponent';
export type SokobanSide = 'challenger' | 'opponent';
export type CrazyArcadeSide = 'challenger' | 'opponent';
export type GameMode = 'solo' | 'local_ai' | 'friend_match';

export interface MatchPauseState {
  active: boolean;
  requestedByAccountId?: string;
  startedAt?: string;
  resumableAt?: string;
  counts?: Record<string, number>;
}

export interface TimedTurnState {
  mode?: GameMode;
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  networkGraceAccountId?: string;
  opponentLeftAt?: string;
  pause?: MatchPauseState;
  finishReason?: string;
}

export interface SudokuSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  ownerAccountId: string;
  difficulty: Difficulty;
  puzzle: number[][];
  board: number[][];
  solution: number[][];
  players?: Record<SudokuSide, string>;
  boards?: Record<SudokuSide, number[][]>;
  progress?: Record<SudokuSide, SudokuProgress>;
  battle?: Record<SudokuSide, SudokuBattleState>;
  winnerAccountId?: string;
  winnerSide?: SudokuSide;
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  pause?: MatchPauseState;
  finishReason?: string;
  status: 'playing' | 'cleared' | 'failed' | 'finished';
  createdAt: string;
  updatedAt: string;
  clearedAt?: string;
}

export interface SudokuProgress {
  filled: number;
  total: number;
  percent: number;
}

export interface SudokuBattleState {
  combo: number;
  pendingDamage: number;
  completedUnits: string[];
  obscuredCells: Array<{ row: number; col: number; until: string }>;
}

export interface GomokuSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: Difficulty;
  board: (PlayerColor | null)[][];
  currentTurn: PlayerColor;
  winner?: PlayerColor;
  status: 'playing' | 'finished';
  players: Record<PlayerColor, string>;
  moves: Array<{ row: number; col: number; color: PlayerColor; accountId: string; createdAt: string; source?: 'manual' | 'timeout' | 'ai' }>;
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  networkGraceAccountId?: string;
  opponentLeftAt?: string;
  pause?: MatchPauseState;
  finishReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AlkkagiPiece {
  id: string;
  team: PieceTeam;
  rank?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius?: number;
  mass?: number;
  active: boolean;
}

export interface AlkkagiSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: Difficulty;
  currentTurn: PieceTeam;
  winner?: PieceTeam;
  status: 'playing' | 'finished';
  players: Record<PieceTeam, string>;
  pieces: AlkkagiPiece[];
  shots: Array<{ pieceId: string; team: PieceTeam; vx: number; vy: number; accountId: string; createdAt: string; source?: 'manual' | 'timeout' | 'ai' }>;
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  networkGraceAccountId?: string;
  opponentLeftAt?: string;
  pause?: MatchPauseState;
  lastAim?: {
    accountId: string;
    pieceId: string;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    updatedAt: string;
  };
  finishReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AlkkagiShotResult {
  session: AlkkagiSession;
  animation: {
    frameMs: number;
    frames: AlkkagiPiece[][];
  };
}

export interface OthelloSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  aiDifficulty?: Difficulty;
  board: (OthelloColor | null)[][];
  currentTurn: OthelloColor;
  winner?: OthelloColor;
  status: 'playing' | 'finished';
  players: Record<OthelloColor, string>;
  moves: Array<{ row: number; col: number; color: OthelloColor; accountId: string; flipped: number; createdAt: string; source?: 'manual' | 'ai' }>;
  pause?: MatchPauseState;
  finishReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SokobanPosition {
  row: number;
  col: number;
}

export interface SokobanPlayerState {
  player: SokobanPosition;
  boxes: SokobanPosition[];
  moves: number;
  solved: boolean;
}

export interface SokobanSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  ownerAccountId: string;
  difficulty: Difficulty;
  mapKey: string;
  walls: SokobanPosition[];
  goals: SokobanPosition[];
  initialPlayer: SokobanPosition;
  initialBoxes: SokobanPosition[];
  state: SokobanPlayerState;
  players?: Record<SokobanSide, string>;
  states?: Record<SokobanSide, SokobanPlayerState>;
  winnerAccountId?: string;
  winnerSide?: SokobanSide;
  mySide?: SokobanSide;
  pause?: MatchPauseState;
  status: 'playing' | 'finished';
  finishReason?: string;
  createdAt: string;
  updatedAt: string;
  solvedAt?: string;
}

export interface CrazyArcadeSession {
  id: string;
  rev?: number;
  mode?: GameMode;
  ownerAccountId: string;
  difficulty: Difficulty;
  aiDifficulty?: Difficulty;
  players: Record<CrazyArcadeSide, string>;
  mySide?: CrazyArcadeSide;
  status: 'playing' | 'finished';
  winnerSide?: CrazyArcadeSide;
  winnerAccountId?: string;
  finishReason?: string;
  pause?: MatchPauseState;
  snapshot: Record<string, unknown>;
  inputs: Record<CrazyArcadeSide, Record<string, unknown>>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveGameSessionSummary {
  sessionId: string;
  gameKey: string;
  mode: string;
  status: string;
  rev: number;
  opponentAccountIds: string[];
  currentTurnAccountId?: string;
  myTurn?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomEmote {
  slot: number;
  gridSize: 8 | 16;
  cells: Array<string | null>;
  updatedAt: string;
}

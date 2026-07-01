export type Difficulty = 'easy' | 'medium' | 'hard';
export type PlayerColor = 'black' | 'white';
export type PieceTeam = 'red' | 'blue';
export type GameMode = 'solo' | 'local_two_player' | 'friend_match';

export interface TimedTurnState {
  mode?: GameMode;
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  networkGraceAccountId?: string;
  finishReason?: string;
}

export interface SudokuSession {
  id: string;
  ownerAccountId: string;
  difficulty: Difficulty;
  puzzle: number[][];
  board: number[][];
  solution: number[][];
  status: 'playing' | 'cleared' | 'failed';
  createdAt: string;
  updatedAt: string;
  clearedAt?: string;
}

export interface GomokuSession {
  id: string;
  mode?: GameMode;
  board: (PlayerColor | null)[][];
  currentTurn: PlayerColor;
  winner?: PlayerColor;
  status: 'playing' | 'finished';
  players: Record<PlayerColor, string>;
  moves: Array<{ row: number; col: number; color: PlayerColor; accountId: string; createdAt: string; source?: 'manual' | 'timeout' }>;
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  networkGraceAccountId?: string;
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
  mode?: GameMode;
  currentTurn: PieceTeam;
  winner?: PieceTeam;
  status: 'playing' | 'finished';
  players: Record<PieceTeam, string>;
  pieces: AlkkagiPiece[];
  shots: Array<{ pieceId: string; team: PieceTeam; vx: number; vy: number; accountId: string; createdAt: string; source?: 'manual' | 'timeout' }>;
  turnStartedAt?: string;
  turnDeadlineAt?: string;
  networkGraceStartedAt?: string;
  networkGraceDeadlineAt?: string;
  networkGraceAccountId?: string;
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

export interface CustomEmote {
  slot: number;
  gridSize: 8 | 16;
  cells: Array<string | null>;
  updatedAt: string;
}

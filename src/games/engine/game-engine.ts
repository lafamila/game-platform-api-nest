import { Difficulty } from '../games.types';

export type GameTurnType = 'turnBased' | 'simultaneous' | 'realtimeServer';

export interface GameDescriptor {
  key: string;
  title: string;
  minPlayers: number;
  maxPlayers: number;
  modes: Array<'solo' | 'local_ai' | 'friend_match'>;
  turnType: GameTurnType;
  hiddenInfo: boolean;
  supportsAi: boolean;
  supportsMatchSave: boolean;
  turnTimerSeconds?: number;
  graceSeconds?: number;
  status: 'playable' | 'disabled';
}

export interface SeatInfo {
  seat: number;
  accountId?: string;
  kind: 'account' | 'ai';
  aiDifficulty?: Difficulty;
  status?: 'active' | 'left' | 'forfeited';
}

export interface GameAction {
  type: string;
  payload?: Record<string, unknown>;
  clientMoveId?: string;
}

export interface EngineResult<S> {
  state: S;
  events?: Array<{ type: string; payload?: unknown }>;
}

export interface FinishInfo {
  status: 'playing' | 'finished' | 'cleared' | 'failed';
  winnerSeat?: number;
  reason?: string;
}

export interface GameEngine<S> {
  descriptor: GameDescriptor;
  createState(players: SeatInfo[], config: Record<string, unknown>): S;
  applyAction(state: S, seat: number, action: GameAction): EngineResult<S>;
  viewFor(state: S, seat: number | 'spectator'): unknown;
  finishInfo(state: S): FinishInfo | null;
  aiAction?(state: S, seat: number, difficulty: Difficulty): GameAction;
  stateVersion: number;
  migrate?(oldState: unknown, fromVersion: number): S;
}

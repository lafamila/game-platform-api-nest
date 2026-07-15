import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  Board,
  ReplayGameKey,
  ReplayMove,
  computeReplayMoves,
  isLocalAiSentinel,
  isReplayGameKey,
  normalizeMoveHistory,
  reconstructSnapshots,
  resolveReplayWinner,
} from './replay-builder';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const REPLAY_GAME_KEYS: ReplayGameKey[] = ['gomoku', 'othello'];
const BOARD_SIZE: Record<ReplayGameKey, number> = { gomoku: 15, othello: 8 };
// black=0 / white=1 (createState players 순서와 일치).
const SEAT_COLORS: Array<'black' | 'white'> = ['black', 'white'];

export interface ReplayListFilter {
  game?: string;
  accountId?: string;
  page?: number;
  pageSize?: number;
}

export interface ReplayPlayer {
  seat: number;
  color: 'black' | 'white';
  accountId: string;
  displayName: string;
  isAi: boolean;
}

export interface ReplayListItem {
  sessionId: string;
  gameKey: ReplayGameKey;
  mode: string;
  players: ReplayPlayer[];
  aiDifficulty?: string;
  startedAt: string;
  winner: string | null;
  finishReason?: string;
  moveCount: number;
}

export interface ReplayListResult {
  items: ReplayListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ReplayDetail extends ReplayListItem {
  boardSize: number;
  moves: ReplayMove[];
  snapshots: Board[];
}

interface GameSessionRow {
  id: string;
  game_key: string;
  mode: string;
  winner: string | null;
  state_json: Record<string, unknown>;
  created_at: Date;
}

interface SocialAccountNameRow {
  account_id: string;
  login_id: string;
  name: string;
}

@Injectable()
export class ReplayService {
  constructor(private readonly db: DatabaseService) {}

  async listReplays(filter: ReplayListFilter): Promise<ReplayListResult> {
    const games = this.resolveGameFilter(filter.game);
    const page = Math.max(1, Math.trunc(filter.page ?? 1) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(filter.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * pageSize;

    const params: unknown[] = [games];
    let where =
      `game_key = ANY($1::text[]) AND status = 'finished' ` +
      `AND jsonb_array_length(COALESCE(state_json->'moveHistory', '[]'::jsonb)) > 0`;
    if (filter.accountId) {
      params.push(filter.accountId);
      where += ` AND (owner_account_id = $${params.length} OR opponent_account_id = $${params.length})`;
    }

    const countRow = await this.db.one<{ total: number }>(
      `SELECT count(*)::int AS total FROM game_sessions WHERE ${where}`,
      params,
    );
    const total = countRow?.total ?? 0;

    params.push(pageSize);
    const limitIndex = params.length;
    params.push(offset);
    const offsetIndex = params.length;
    const result = await this.db.query<GameSessionRow>(
      `SELECT id, game_key, mode, winner, state_json, created_at
       FROM game_sessions
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );

    const names = await this.resolveNames(result.rows.flatMap((row) => this.humanAccountIds(row.state_json)));
    const items = result.rows.map((row) => this.toListItem(row, names));
    return { items, page, pageSize, total };
  }

  async getReplay(sessionId: string): Promise<ReplayDetail> {
    const row = await this.db.one<GameSessionRow>(
      `SELECT id, game_key, mode, winner, state_json, created_at FROM game_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!row || !isReplayGameKey(row.game_key)) {
      throw new NotFoundException('Replay not found');
    }
    const moveHistory = normalizeMoveHistory(row.state_json?.moveHistory);
    if (moveHistory.length === 0) {
      // 소급 불가(D3): 로깅 이전 게임은 수순이 없어 리플레이 대상이 아니다.
      throw new NotFoundException('Replay not found');
    }
    const names = await this.resolveNames(this.humanAccountIds(row.state_json));
    const base = this.toListItem(row, names);
    return {
      ...base,
      boardSize: BOARD_SIZE[base.gameKey],
      moves: computeReplayMoves(moveHistory),
      snapshots: reconstructSnapshots(base.gameKey, moveHistory),
    };
  }

  private resolveGameFilter(game: string | undefined): ReplayGameKey[] {
    if (!game) {
      return REPLAY_GAME_KEYS;
    }
    if (!isReplayGameKey(game)) {
      throw new BadRequestException('game must be gomoku or othello');
    }
    return [game];
  }

  private humanAccountIds(state: Record<string, unknown> | undefined): string[] {
    const players = state?.players && typeof state.players === 'object' ? (state.players as Record<string, unknown>) : {};
    return Object.values(players).filter(
      (value): value is string => typeof value === 'string' && Boolean(value) && !isLocalAiSentinel(value),
    );
  }

  private async resolveNames(accountIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(accountIds.filter(Boolean))];
    const map = new Map<string, string>();
    if (unique.length === 0) {
      return map;
    }
    const result = await this.db.query<SocialAccountNameRow>(
      `SELECT account_id, login_id, name FROM social_accounts WHERE account_id = ANY($1::text[])`,
      [unique],
    );
    for (const row of result.rows) {
      // D2: 표시명(name) 우선, 없으면 login_id, 그래도 없으면 account id 폴백.
      map.set(row.account_id, row.name?.trim() || row.login_id?.trim() || row.account_id);
    }
    return map;
  }

  private toListItem(row: GameSessionRow, names: Map<string, string>): ReplayListItem {
    const state = (row.state_json ?? {}) as Record<string, unknown>;
    const gameKey = row.game_key as ReplayGameKey;
    const players = this.buildPlayers(state, names);
    const aiDifficulty = typeof state.aiDifficulty === 'string' ? state.aiDifficulty : undefined;
    const moveHistory = normalizeMoveHistory(state.moveHistory);
    return {
      sessionId: row.id,
      gameKey,
      mode: row.mode,
      players,
      aiDifficulty: row.mode === 'local_ai' ? aiDifficulty : undefined,
      startedAt: row.created_at.toISOString(),
      winner: resolveReplayWinner(state),
      finishReason: typeof state.finishReason === 'string' ? state.finishReason : undefined,
      moveCount: moveHistory.length,
    };
  }

  private buildPlayers(state: Record<string, unknown>, names: Map<string, string>): ReplayPlayer[] {
    const players = state.players && typeof state.players === 'object' ? (state.players as Record<string, unknown>) : {};
    return SEAT_COLORS.map((color, seat) => {
      const accountId = typeof players[color] === 'string' ? (players[color] as string) : '';
      const isAi = isLocalAiSentinel(accountId);
      return {
        seat,
        color,
        accountId,
        displayName: isAi ? 'AI' : names.get(accountId) ?? accountId,
        isAi,
      };
    });
  }
}

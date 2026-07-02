import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthAccount } from '../auth/auth.types';
import { emoteGridSizeFor, hasPlayerAccess } from '../auth/roles';
import { RealtimeService } from '../realtime/realtime.service';
import { createSudoku, isSolvedSudoku } from './sudoku-generator';
import {
  AlkkagiPiece,
  AlkkagiShotResult,
  AlkkagiSession,
  CustomEmote,
  Difficulty,
  GomokuSession,
  MatchPauseState,
  PieceTeam,
  PlayerColor,
  SudokuBattleState,
  SudokuProgress,
  SudokuSession,
  SudokuSide,
} from './games.types';

const GOMOKU_SIZE = 15;
const ALKKAGI_BOARD_SIZE = 1000;
const MATCH_READY_DELAY_MS = 4_000;
const GOMOKU_TURN_LIMIT_MS = 15_000;
const ALKKAGI_TURN_LIMIT_MS = 10_000;
const GOMOKU_AI_BUDGET_MS = 900;
const ALKKAGI_AI_BUDGET_MS = 1_400;
const LOCAL_AI_RESPONSE_DELAY_MS = 180;
const DISCONNECT_GRACE_MS = 10_000;
const EMOTE_COOLDOWN_MS = 3_000;
const MATCH_PAUSE_LIMIT = 3;
const MATCH_PAUSE_RESUME_LOCK_MS = 3_000;
const SUDOKU_OBSCURE_MS = 5_000;
const EMOTE_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'black', 'white']);
const LOCAL_AI_ACCOUNT_ID = '__game_platform_local_ai__';
const ALKKAGI_HINGES = [
  { x1: 220, y1: 500, x2: 400, y2: 500, radius: 10 },
  { x1: 600, y1: 500, x2: 780, y2: 500, radius: 10 },
] as const;

interface GameRow {
  id: string;
  game_key: string;
  mode: string;
  status: string;
  current_turn: string | null;
  winner: string | null;
  owner_account_id: string;
  opponent_account_id: string | null;
  state_json: unknown;
  created_at: Date;
  updated_at: Date;
}

interface CustomEmoteRow {
  account_id: string;
  slot: number;
  grid_size: number;
  cells_json: unknown;
  updated_at: Date;
}

@Injectable()
export class GamesService implements OnModuleInit, OnModuleDestroy {
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly emoteCooldowns = new Map<string, number>();

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    setTimeout(() => {
      void this.restoreActiveTurnTimers().catch((error) => console.error(error));
    }, 0);
  }

  onModuleDestroy(): void {
    for (const timer of this.turnTimers.values()) {
      clearTimeout(timer);
    }
    this.turnTimers.clear();
  }

  listGames() {
    return [
      { key: 'sudoku', title: 'Sudoku', modes: ['solo', 'friend_match'], status: 'playable' },
      { key: 'gomoku', title: 'Gomoku', modes: ['local_ai', 'friend_match'], status: 'playable' },
      { key: 'alkkagi', title: 'Alkkagi', modes: ['local_ai', 'friend_match'], status: 'playable' },
    ];
  }

  async listEmotes(user: AuthAccount): Promise<{ gridSize: 8 | 16; emotes: CustomEmote[] }> {
    if (!hasPlayerAccess(user)) {
      return { gridSize: emoteGridSizeFor(user), emotes: [] };
    }
    const result = await this.db.query<CustomEmoteRow>(
      `SELECT account_id, slot, grid_size, cells_json, updated_at
       FROM custom_emotes
       WHERE account_id = $1
       ORDER BY slot ASC`,
      [user.accountId],
    );
    return {
      gridSize: emoteGridSizeFor(user),
      emotes: result.rows.map(emoteFromRow),
    };
  }

  async saveEmote(
    user: AuthAccount,
    slot: number,
    input: { gridSize?: number; cells?: Array<string | null> },
  ): Promise<CustomEmote> {
    if (!hasPlayerAccess(user)) {
      throw new ForbiddenException('player permission is required for custom emotes');
    }
    validateEmoteSlot(slot);
    const gridSize = emoteGridSizeFor(user);
    if (input.gridSize !== gridSize) {
      throw new BadRequestException(`gridSize must be ${gridSize}`);
    }
    const cells = validateEmoteCells(input.cells, gridSize);
    const result = await this.db.query<CustomEmoteRow>(
      `INSERT INTO custom_emotes (account_id, slot, grid_size, cells_json)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (account_id, slot)
       DO UPDATE SET grid_size = EXCLUDED.grid_size, cells_json = EXCLUDED.cells_json, updated_at = now()
       RETURNING account_id, slot, grid_size, cells_json, updated_at`,
      [user.accountId, slot, gridSize, JSON.stringify(cells)],
    );
    return emoteFromRow(result.rows[0]);
  }

  async createSudokuSession(
    user: AuthAccount,
    difficulty: Difficulty,
    opponentAccountId?: string,
  ): Promise<Omit<SudokuSession, 'solution'>> {
    this.assertDifficulty(difficulty);
    const { puzzle, solution } = createSudoku(difficulty);
    const resolvedMode = opponentAccountId ? 'friend_match' : 'solo';
    const board = puzzle.map((row) => [...row]);
    const state: SudokuSession = {
      id: '',
      mode: resolvedMode,
      ownerAccountId: user.accountId,
      difficulty,
      puzzle,
      board,
      solution,
      status: 'playing',
      createdAt: '',
      updatedAt: '',
    };
    if (opponentAccountId) {
      state.players = {
        challenger: user.accountId,
        opponent: opponentAccountId,
      };
      state.boards = {
        challenger: cloneSudokuGrid(board),
        opponent: cloneSudokuGrid(board),
      };
      state.progress = createSudokuProgressMap(state);
      state.battle = {
        challenger: createSudokuBattleState(state.boards.challenger, state.solution),
        opponent: createSudokuBattleState(state.boards.opponent, state.solution),
      };
      state.pause = {
        active: false,
        counts: {
          [user.accountId]: 0,
          [opponentAccountId]: 0,
        },
      };
    }
    const row = await this.insertGame('sudoku', resolvedMode, user.accountId, opponentAccountId ?? null, state.status, null, null, state);
    const session = this.sudokuFromRow(row);
    this.emitSudokuEvent(session, 'game.session.created');
    return hideSudokuSolution(session, user);
  }

  async getSudokuSession(id: string, user: AuthAccount): Promise<Omit<SudokuSession, 'solution'>> {
    const session = this.sudokuFromRow(await this.requireGameRow(id, 'sudoku'));
    this.assertSudokuParticipant(user, session);
    return hideSudokuSolution(session, user);
  }

  async updateSudokuCell(
    id: string,
    user: AuthAccount,
    row: number,
    col: number,
    value: number,
  ): Promise<Omit<SudokuSession, 'solution'>> {
    validateSudokuIndex(row, 'row');
    validateSudokuIndex(col, 'col');
    if (!Number.isInteger(value) || value < 0 || value > 9) {
      throw new BadRequestException('value must be an integer from 0 to 9');
    }
    const current = this.sudokuFromRow(await this.requireGameRow(id, 'sudoku'));
    this.assertSudokuParticipant(user, current);
    this.assertNotPaused(current);
    if (current.puzzle[row][col] !== 0) {
      throw new BadRequestException('given cells cannot be changed');
    }
    const side = this.sudokuSideForUser(current, user);
    const board = side ? ensureSudokuPlayerBoard(current, side) : current.board;
    board[row][col] = value;
    if (side) {
      current.boards![side] = board;
      applySudokuBattleMove(current, side);
      current.progress = createSudokuProgressMap(current);
      current.board = board;
    } else {
      current.board = board;
    }
    current.updatedAt = new Date().toISOString();
    const saved = this.sudokuFromRow(await this.updateGame(id, current.status, null, null, current));
    this.emitSudokuEvent(saved, 'sudoku.cell.updated');
    return hideSudokuSolution(saved, user);
  }

  async submitSudoku(
    id: string,
    user: AuthAccount,
    board?: number[][],
  ): Promise<{ solved: boolean; session: Omit<SudokuSession, 'solution'> }> {
    const current = this.sudokuFromRow(await this.requireGameRow(id, 'sudoku'));
    this.assertSudokuParticipant(user, current);
    this.assertNotPaused(current);
    const side = this.sudokuSideForUser(current, user);
    if (board !== undefined && !side) {
      validateSudokuBoard(board);
      current.board = board;
    }
    const currentBoard = side ? ensureSudokuPlayerBoard(current, side) : current.board;
    const solved = isSolvedSudoku(currentBoard, current.solution);
    if (side) {
      if (solved) {
        current.status = 'finished';
        current.winnerSide = side;
        current.winnerAccountId = current.players?.[side];
        current.finishReason = 'sudoku_first_clear';
        current.clearedAt = new Date().toISOString();
      }
    } else {
      current.status = solved ? 'cleared' : 'failed';
      if (solved) {
        current.clearedAt = new Date().toISOString();
      }
    }
    current.updatedAt = new Date().toISOString();
    const saved = this.sudokuFromRow(await this.updateGame(id, current.status, null, solved ? (side ?? 'cleared') : null, current));
    this.emitSudokuEvent(saved, solved && side ? 'game.session.finished' : 'sudoku.submitted');
    return { solved, session: hideSudokuSolution(saved, user) };
  }

  async sendSudokuEmote(id: string, user: AuthAccount, slot: number): Promise<unknown> {
    const session = this.sudokuFromRow(await this.requireGameRow(id, 'sudoku'));
    this.assertSudokuParticipant(user, session);
    return this.sendSessionEmote('sudoku', session, user, slot);
  }

  async createGomokuSession(
    user: AuthAccount,
    opponentAccountId?: string,
    mode?: 'local_ai' | 'friend_match',
    difficulty: Difficulty = 'easy',
  ): Promise<GomokuSession> {
    this.assertDifficulty(difficulty);
    const resolvedMode = opponentAccountId ? 'friend_match' : mode ?? 'local_ai';
    const state: GomokuSession = {
      id: '',
      mode: resolvedMode,
      aiDifficulty: resolvedMode === 'local_ai' ? difficulty : undefined,
      board: Array.from({ length: GOMOKU_SIZE }, () => Array.from({ length: GOMOKU_SIZE }, () => null)),
      currentTurn: 'black',
      status: 'playing',
      players: {
        black: user.accountId,
        white: opponentAccountId || LOCAL_AI_ACCOUNT_ID,
      },
      moves: [],
      createdAt: '',
      updatedAt: '',
    };
    if (resolvedMode === 'friend_match') {
      this.startTimedTurn(state, 'gomoku', MATCH_READY_DELAY_MS);
    }
    const row = await this.insertGame('gomoku', resolvedMode, user.accountId, opponentAccountId ?? null, 'playing', 'black', null, state);
    const session = this.gomokuFromRow(row);
    this.scheduleTurnTimer(session, 'gomoku');
    this.emitSessionEvent(session, 'game.session.created', session);
    return session;
  }

  async getGomokuSession(id: string, user: AuthAccount): Promise<GomokuSession> {
    const session = this.gomokuFromRow(await this.requireGameRow(id, 'gomoku'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    return session;
  }

  async playGomokuMove(id: string, user: AuthAccount, row: number, col: number): Promise<GomokuSession> {
    validateGomokuIndex(row, 'row');
    validateGomokuIndex(col, 'col');
    const session = this.gomokuFromRow(await this.requireGameRow(id, 'gomoku'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    if (session.status !== 'playing') {
      throw new BadRequestException('game is already finished');
    }
    this.assertNotPaused(session);
    const color = session.currentTurn;
    if (isLocalAiAccount(session.players[color])) {
      throw new ForbiddenException('not your turn');
    }
    if (!this.canActAs(user, session.players[color])) {
      throw new ForbiddenException('not your turn');
    }
    if (session.board[row][col] !== null) {
      throw new BadRequestException('cell is already occupied');
    }
    this.applyGomokuMove(session, user.accountId, row, col, 'manual');
    const saved = this.gomokuFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session));
    this.scheduleTurnTimer(saved, 'gomoku');
    this.emitSessionEvent(saved, 'gomoku.move.played', saved);
    if (saved.mode === 'local_ai' && saved.status === 'playing' && isLocalAiAccount(saved.players[saved.currentTurn])) {
      this.scheduleLocalGomokuAiTurn(saved.id);
    }
    return saved;
  }

  async sendGomokuEmote(id: string, user: AuthAccount, slot: number): Promise<unknown> {
    const session = this.gomokuFromRow(await this.requireGameRow(id, 'gomoku'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    return this.sendSessionEmote('gomoku', session, user, slot);
  }

  async forfeitGomoku(id: string, user: AuthAccount): Promise<GomokuSession> {
    const session = this.gomokuFromRow(await this.requireGameRow(id, 'gomoku'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    if (session.status !== 'playing') {
      return session;
    }
    const loser = this.participantSide(session.players, user.accountId, session.currentTurn);
    session.status = 'finished';
    session.winner = loser === 'black' ? 'white' : 'black';
    session.finishReason = 'forfeit';
    session.updatedAt = new Date().toISOString();
    this.clearTurnTimer(id);
    const saved = this.gomokuFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner, session));
    this.emitSessionEvent(saved, 'gomoku.move.played', saved);
    this.emitSessionEvent(saved, 'game.session.finished', saved);
    return saved;
  }

  async createAlkkagiSession(
    user: AuthAccount,
    opponentAccountId?: string,
    mode?: 'local_ai' | 'friend_match',
    difficulty: Difficulty = 'easy',
  ): Promise<AlkkagiSession> {
    this.assertDifficulty(difficulty);
    const resolvedMode = opponentAccountId ? 'friend_match' : mode ?? 'local_ai';
    const state: AlkkagiSession = {
      id: '',
      mode: resolvedMode,
      aiDifficulty: resolvedMode === 'local_ai' ? difficulty : undefined,
      currentTurn: 'red',
      status: 'playing',
      players: {
        red: user.accountId,
        blue: opponentAccountId || LOCAL_AI_ACCOUNT_ID,
      },
      pieces: initialAlkkagiPieces(),
      shots: [],
      createdAt: '',
      updatedAt: '',
    };
    if (resolvedMode === 'friend_match') {
      this.startTimedTurn(state, 'alkkagi', MATCH_READY_DELAY_MS);
    }
    const row = await this.insertGame('alkkagi', resolvedMode, user.accountId, opponentAccountId ?? null, 'playing', 'red', null, state);
    const session = this.alkkagiFromRow(row);
    this.scheduleTurnTimer(session, 'alkkagi');
    this.emitSessionEvent(session, 'game.session.created', session);
    return session;
  }

  async getAlkkagiSession(id: string, user: AuthAccount): Promise<AlkkagiSession> {
    const session = this.alkkagiFromRow(await this.requireGameRow(id, 'alkkagi'));
    this.assertGameParticipant(user, session.players.red, session.players.blue);
    return session;
  }

  async shootAlkkagi(
    id: string,
    user: AuthAccount,
    pieceId: string,
    vx: number,
    vy: number,
  ): Promise<AlkkagiShotResult> {
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
      throw new BadRequestException('vx and vy must be numbers');
    }
    const session = this.alkkagiFromRow(await this.requireGameRow(id, 'alkkagi'));
    this.assertGameParticipant(user, session.players.red, session.players.blue);
    if (session.status !== 'playing') {
      throw new BadRequestException('game is already finished');
    }
    this.assertNotPaused(session);
    const team = session.currentTurn;
    if (isLocalAiAccount(session.players[team])) {
      throw new ForbiddenException('not your turn');
    }
    if (!this.canActAs(user, session.players[team])) {
      throw new ForbiddenException('not your turn');
    }
    const piece = session.pieces.find((item) => item.id === pieceId);
    if (!piece || !piece.active) {
      throw new BadRequestException('active piece not found');
    }
    if (piece.team !== team) {
      throw new BadRequestException('piece does not belong to current turn');
    }
    const cappedVx = Math.max(-40, Math.min(40, vx));
    const cappedVy = Math.max(-40, Math.min(40, vy));
    const animation = this.applyAlkkagiShot(session, user.accountId, pieceId, cappedVx, cappedVy, 'manual');
    const saved = this.alkkagiFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session));
    this.scheduleTurnTimer(saved, 'alkkagi');
    const result = { session: saved, animation };
    this.emitSessionEvent(saved, 'alkkagi.shot.played', result);
    if (saved.mode === 'local_ai' && saved.status === 'playing' && isLocalAiAccount(saved.players[saved.currentTurn])) {
      this.scheduleLocalAlkkagiAiTurn(saved.id);
    }
    return result;
  }

  async sendAlkkagiEmote(id: string, user: AuthAccount, slot: number): Promise<unknown> {
    const session = this.alkkagiFromRow(await this.requireGameRow(id, 'alkkagi'));
    this.assertGameParticipant(user, session.players.red, session.players.blue);
    return this.sendSessionEmote('alkkagi', session, user, slot);
  }

  async updateAlkkagiDrag(
    id: string,
    user: AuthAccount,
    input: { pieceId: string; startX: number; startY: number; currentX: number; currentY: number; phase?: string },
  ): Promise<{ ok: true }> {
    const session = this.alkkagiFromRow(await this.requireGameRow(id, 'alkkagi'));
    this.assertGameParticipant(user, session.players.red, session.players.blue);
    if (session.status !== 'playing') {
      throw new BadRequestException('game is already finished');
    }
    this.assertNotPaused(session);
    const team = session.currentTurn;
    if (isLocalAiAccount(session.players[team])) {
      throw new ForbiddenException('not your turn');
    }
    if (!this.canActAs(user, session.players[team])) {
      throw new ForbiddenException('not your turn');
    }
    const piece = session.pieces.find((item) => item.id === input.pieceId && item.active);
    if (!piece || piece.team !== team) {
      throw new BadRequestException('piece does not belong to current turn');
    }
    const phase = input.phase === 'end' ? 'end' : input.phase === 'start' ? 'start' : 'update';
    const dragEvent = {
      sessionId: id,
      accountId: user.accountId,
      team,
      pieceId: input.pieceId,
      startX: clamp(input.startX, 0, ALKKAGI_BOARD_SIZE),
      startY: clamp(input.startY, 0, ALKKAGI_BOARD_SIZE),
      currentX: clamp(input.currentX, 0, ALKKAGI_BOARD_SIZE),
      currentY: clamp(input.currentY, 0, ALKKAGI_BOARD_SIZE),
      phase,
      at: new Date().toISOString(),
    };
    if (phase === 'end') {
      this.emitSessionEvent(session, 'alkkagi.drag.updated', dragEvent);
      return { ok: true };
    }
    session.lastAim = {
      accountId: user.accountId,
      pieceId: input.pieceId,
      startX: dragEvent.startX,
      startY: dragEvent.startY,
      currentX: dragEvent.currentX,
      currentY: dragEvent.currentY,
      updatedAt: new Date().toISOString(),
    };
    await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session);
    this.emitSessionEvent(session, 'alkkagi.drag.updated', dragEvent);
    return { ok: true };
  }

  async forfeitAlkkagi(id: string, user: AuthAccount): Promise<AlkkagiSession> {
    const session = this.alkkagiFromRow(await this.requireGameRow(id, 'alkkagi'));
    this.assertGameParticipant(user, session.players.red, session.players.blue);
    if (session.status !== 'playing') {
      return session;
    }
    const loser = this.participantSide(session.players, user.accountId, session.currentTurn);
    session.status = 'finished';
    session.winner = loser === 'red' ? 'blue' : 'red';
    session.finishReason = 'forfeit';
    session.updatedAt = new Date().toISOString();
    this.clearTurnTimer(id);
    const saved = this.alkkagiFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner, session));
    this.emitSessionEvent(saved, 'alkkagi.shot.played', { session: saved, animation: { frameMs: 16, frames: [] } });
    this.emitSessionEvent(saved, 'game.session.finished', saved);
    return saved;
  }

  async pauseMatchedGame(gameKey: string, id: string, user: AuthAccount): Promise<unknown> {
    if (gameKey === 'sudoku') {
      const session = this.sudokuFromRow(await this.requireGameRow(id, 'sudoku'));
      this.assertSudokuParticipant(user, session);
      this.applyPause(session, user);
      const saved = this.sudokuFromRow(await this.updateGame(id, session.status, null, null, session));
      this.emitSudokuEvent(saved, 'game.session.paused');
      return hideSudokuSolution(saved, user);
    }
    if (gameKey === 'gomoku') {
      const session = this.gomokuFromRow(await this.requireGameRow(id, 'gomoku'));
      this.assertGameParticipant(user, session.players.black, session.players.white);
      this.applyPause(session, user);
      this.clearTurnTimer(id);
      const saved = this.gomokuFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session));
      this.emitSessionEvent(saved, 'game.session.paused', saved);
      return saved;
    }
    if (gameKey === 'alkkagi') {
      const session = this.alkkagiFromRow(await this.requireGameRow(id, 'alkkagi'));
      this.assertGameParticipant(user, session.players.red, session.players.blue);
      this.applyPause(session, user);
      this.clearTurnTimer(id);
      const saved = this.alkkagiFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session));
      this.emitSessionEvent(saved, 'game.session.paused', saved);
      return saved;
    }
    throw new BadRequestException('gameKey must be sudoku, gomoku, or alkkagi');
  }

  async resumeMatchedGame(gameKey: string, id: string, user: AuthAccount): Promise<unknown> {
    if (gameKey === 'sudoku') {
      const session = this.sudokuFromRow(await this.requireGameRow(id, 'sudoku'));
      this.assertSudokuParticipant(user, session);
      this.applyResume(session);
      const saved = this.sudokuFromRow(await this.updateGame(id, session.status, null, null, session));
      this.emitSudokuEvent(saved, 'game.session.resumed');
      return hideSudokuSolution(saved, user);
    }
    if (gameKey === 'gomoku') {
      const session = this.gomokuFromRow(await this.requireGameRow(id, 'gomoku'));
      this.assertGameParticipant(user, session.players.black, session.players.white);
      this.applyResume(session);
      const saved = this.gomokuFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session));
      this.scheduleTurnTimer(saved, 'gomoku');
      this.emitSessionEvent(saved, 'game.session.resumed', saved);
      return saved;
    }
    if (gameKey === 'alkkagi') {
      const session = this.alkkagiFromRow(await this.requireGameRow(id, 'alkkagi'));
      this.assertGameParticipant(user, session.players.red, session.players.blue);
      this.applyResume(session);
      const saved = this.alkkagiFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session));
      this.scheduleTurnTimer(saved, 'alkkagi');
      this.emitSessionEvent(saved, 'game.session.resumed', saved);
      return saved;
    }
    throw new BadRequestException('gameKey must be sudoku, gomoku, or alkkagi');
  }

  async createSessionFromMatch(gameKey: string, requesterAccountId: string, opponentAccountId: string): Promise<string> {
    const fakeUser: AuthAccount = {
      accountId: requesterAccountId,
      subject: requesterAccountId,
      serviceKey: 'game-platform',
      permission: 'player',
      claims: {},
    };
    if (gameKey === 'sudoku') {
      return (await this.createSudokuSession(fakeUser, 'medium', opponentAccountId)).id;
    }
    if (gameKey === 'gomoku') {
      return (await this.createGomokuSession(fakeUser, opponentAccountId, 'friend_match')).id;
    }
    if (gameKey === 'alkkagi') {
      return (await this.createAlkkagiSession(fakeUser, opponentAccountId, 'friend_match')).id;
    }
    throw new BadRequestException('match requests support sudoku, gomoku, or alkkagi');
  }

  private async insertGame(
    gameKey: string,
    mode: string,
    ownerAccountId: string,
    opponentAccountId: string | null,
    status: string,
    currentTurn: string | null,
    winner: string | null,
    state: unknown,
  ): Promise<GameRow> {
    const result = await this.db.query<GameRow>(
      `INSERT INTO game_sessions
       (game_key, mode, status, current_turn, winner, owner_account_id, opponent_account_id, state_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [gameKey, mode, status, currentTurn, winner, ownerAccountId, opponentAccountId, JSON.stringify(state)],
    );
    return result.rows[0];
  }

  private async updateGame(id: string, status: string, currentTurn: string | null, winner: string | null, state: unknown): Promise<GameRow> {
    const result = await this.db.query<GameRow>(
      `UPDATE game_sessions
       SET status = $2, current_turn = $3, winner = $4, state_json = $5::jsonb, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, status, currentTurn, winner, JSON.stringify(state)],
    );
    if (!result.rows[0]) {
      throw new NotFoundException('Game session not found');
    }
    return result.rows[0];
  }

  private async requireGameRow(id: string, gameKey: string): Promise<GameRow> {
    const row = await this.db.one<GameRow>(`SELECT * FROM game_sessions WHERE id = $1 AND game_key = $2`, [id, gameKey]);
    if (!row) {
      throw new NotFoundException('Game session not found');
    }
    return row;
  }

  private sudokuFromRow(row: GameRow): SudokuSession {
    return withRowDates(row.state_json as SudokuSession, row);
  }

  private gomokuFromRow(row: GameRow): GomokuSession {
    return withRowDates(row.state_json as GomokuSession, row);
  }

  private alkkagiFromRow(row: GameRow): AlkkagiSession {
    return withRowDates(row.state_json as AlkkagiSession, row);
  }

  private assertDifficulty(difficulty: Difficulty): void {
    if (!['easy', 'medium', 'hard'].includes(difficulty)) {
      throw new BadRequestException('difficulty must be easy, medium, or hard');
    }
  }

  private assertParticipant(user: AuthAccount, accountId: string): void {
    if (!this.canActAs(user, accountId)) {
      throw new ForbiddenException('not a participant');
    }
  }

  private assertGameParticipant(user: AuthAccount, a: string, b: string): void {
    if (!this.canActAs(user, a) && !this.canActAs(user, b)) {
      throw new ForbiddenException('not a participant');
    }
  }

  private assertSudokuParticipant(user: AuthAccount, session: SudokuSession): void {
    if (session.players) {
      this.assertGameParticipant(user, session.players.challenger, session.players.opponent);
      return;
    }
    this.assertParticipant(user, session.ownerAccountId);
  }

  private sudokuSideForUser(session: SudokuSession, user: AuthAccount): SudokuSide | undefined {
    if (!session.players) {
      return undefined;
    }
    if (this.canActAs(user, session.players.challenger)) {
      return 'challenger';
    }
    if (this.canActAs(user, session.players.opponent)) {
      return 'opponent';
    }
    return undefined;
  }

  private assertNotPaused(session: SudokuSession | GomokuSession | AlkkagiSession): void {
    if (session.pause?.active) {
      throw new BadRequestException('game is paused');
    }
  }

  private applyPause(session: SudokuSession | GomokuSession | AlkkagiSession, user: AuthAccount): void {
    if (session.mode !== 'friend_match' || session.status !== 'playing') {
      throw new BadRequestException('pause is only available during matched games');
    }
    const counts = { ...(session.pause?.counts ?? {}) };
    const used = counts[user.accountId] ?? 0;
    if (used >= MATCH_PAUSE_LIMIT) {
      throw new BadRequestException('pause request limit reached');
    }
    if (session.pause?.active) {
      return;
    }
    const now = Date.now();
    counts[user.accountId] = used + 1;
    session.pause = {
      active: true,
      requestedByAccountId: user.accountId,
      startedAt: new Date(now).toISOString(),
      resumableAt: new Date(now + MATCH_PAUSE_RESUME_LOCK_MS).toISOString(),
      counts,
    };
    session.updatedAt = new Date(now).toISOString();
  }

  private applyResume(session: SudokuSession | GomokuSession | AlkkagiSession): void {
    const pause = session.pause;
    if (session.mode !== 'friend_match' || session.status !== 'playing') {
      throw new BadRequestException('resume is only available during matched games');
    }
    if (!pause?.active) {
      return;
    }
    if (pause.resumableAt && Date.parse(pause.resumableAt) > Date.now()) {
      throw new BadRequestException('pause cannot be resumed yet');
    }
    const pausedMs = pause.startedAt ? Math.max(0, Date.now() - Date.parse(pause.startedAt)) : 0;
    shiftDeadline(session, 'turnStartedAt', pausedMs);
    shiftDeadline(session, 'turnDeadlineAt', pausedMs);
    shiftDeadline(session, 'networkGraceStartedAt', pausedMs);
    shiftDeadline(session, 'networkGraceDeadlineAt', pausedMs);
    session.pause = {
      active: false,
      counts: { ...(pause.counts ?? {}) },
    };
    session.updatedAt = new Date().toISOString();
  }

  private canActAs(user: AuthAccount, accountId: string): boolean {
    return user.accountId === accountId || user.permission === 'superadmin';
  }

  private async sendSessionEmote(
    gameKey: 'sudoku' | 'gomoku' | 'alkkagi',
    session: SudokuSession | GomokuSession | AlkkagiSession,
    user: AuthAccount,
    slot: number,
  ): Promise<unknown> {
    if (!hasPlayerAccess(user)) {
      throw new ForbiddenException('player permission is required for custom emotes');
    }
    if (session.mode !== 'friend_match' || session.status !== 'playing') {
      throw new BadRequestException('custom emotes are only available during matched games');
    }
    validateEmoteSlot(slot);
    const cooldownKey = `${gameKey}:${session.id}:${user.accountId}`;
    const cooldownUntil = this.emoteCooldowns.get(cooldownKey) ?? 0;
    if (cooldownUntil > Date.now()) {
      throw new BadRequestException('emote cooldown active');
    }
    const row = await this.db.one<CustomEmoteRow>(
      `SELECT account_id, slot, grid_size, cells_json, updated_at
       FROM custom_emotes
       WHERE account_id = $1 AND slot = $2`,
      [user.accountId, slot],
    );
    if (!row) {
      throw new BadRequestException('custom emote slot is empty');
    }
    const emote = emoteFromRow(row);
    const event = {
      gameKey,
      sessionId: session.id,
      senderAccountId: user.accountId,
      slot: emote.slot,
      gridSize: emote.gridSize,
      cells: emote.cells,
      sentAt: new Date().toISOString(),
    };
    this.emoteCooldowns.set(cooldownKey, Date.now() + EMOTE_COOLDOWN_MS);
    this.emitSessionEvent(session, 'game.emote.sent', event);
    return event;
  }

  private applyGomokuMove(
    session: GomokuSession,
    accountId: string,
    row: number,
    col: number,
    source: 'manual' | 'timeout' | 'ai',
  ): void {
    const color = session.currentTurn;
    session.board[row][col] = color;
    session.moves.push({ row, col, color, accountId, createdAt: new Date().toISOString(), source });
    this.clearNetworkGrace(session);
    if (hasFive(session.board, row, col, color)) {
      session.status = 'finished';
      session.winner = color;
      session.finishReason = source === 'timeout' ? 'timeout_random_win' : undefined;
    } else if (session.board.every((boardRow) => boardRow.every((cell) => cell !== null))) {
      session.status = 'finished';
      session.finishReason = 'draw';
    } else {
      session.currentTurn = color === 'black' ? 'white' : 'black';
      this.startTimedTurn(session, 'gomoku');
    }
    session.updatedAt = new Date().toISOString();
  }

  private applyGomokuAiMove(session: GomokuSession): void {
    const move = chooseGomokuAiMove(session, session.aiDifficulty ?? 'easy', Date.now() + GOMOKU_AI_BUDGET_MS);
    if (!move) {
      session.status = 'finished';
      session.finishReason = 'draw';
      session.updatedAt = new Date().toISOString();
      return;
    }
    this.applyGomokuMove(session, LOCAL_AI_ACCOUNT_ID, move.row, move.col, 'ai');
  }

  private scheduleLocalGomokuAiTurn(id: string): void {
    setTimeout(() => {
      void this.runLocalGomokuAiTurn(id).catch((error) => {
        // Local AI failures should not crash the API process.
        console.error(error);
      });
    }, LOCAL_AI_RESPONSE_DELAY_MS);
  }

  private async runLocalGomokuAiTurn(id: string): Promise<void> {
    const session = this.gomokuFromRow(await this.requireGameRow(id, 'gomoku'));
    if (session.mode !== 'local_ai' || session.status !== 'playing' || !isLocalAiAccount(session.players[session.currentTurn])) {
      return;
    }
    const deadline = Date.now() + GOMOKU_AI_BUDGET_MS;
    const move = chooseGomokuAiMove(session, session.aiDifficulty ?? 'easy', deadline) ?? randomGomokuMove(session.board);
    if (!move) {
      session.status = 'finished';
      session.finishReason = 'draw';
      session.updatedAt = new Date().toISOString();
    } else {
      this.applyGomokuMove(session, LOCAL_AI_ACCOUNT_ID, move.row, move.col, 'ai');
    }
    const saved = this.gomokuFromRow(await this.updateGame(session.id, session.status, session.currentTurn, session.winner ?? null, session));
    this.emitSessionEvent(saved, 'gomoku.move.played', saved);
    if (saved.status === 'finished') {
      this.emitSessionEvent(saved, 'game.session.finished', saved);
    }
  }

  private applyAlkkagiShot(
    session: AlkkagiSession,
    accountId: string,
    pieceId: string,
    vx: number,
    vy: number,
    source: 'manual' | 'timeout' | 'ai',
  ): AlkkagiShotResult['animation'] {
    const team = session.currentTurn;
    const piece = session.pieces.find((item) => item.id === pieceId);
    if (!piece) {
      throw new BadRequestException('active piece not found');
    }
    delete session.lastAim;
    piece.vx = vx;
    piece.vy = vy;
    const animation = simulateAlkkagi(session.pieces);
    session.shots.push({ pieceId, team, vx, vy, accountId, createdAt: new Date().toISOString(), source });
    this.clearNetworkGrace(session);

    const activeRed = session.pieces.some((item) => item.team === 'red' && item.active);
    const activeBlue = session.pieces.some((item) => item.team === 'blue' && item.active);
    if (!activeRed || !activeBlue) {
      session.status = 'finished';
      session.winner = activeRed ? 'red' : 'blue';
      session.finishReason = source === 'timeout' ? 'timeout_random_win' : undefined;
    } else {
      session.currentTurn = session.currentTurn === 'red' ? 'blue' : 'red';
      this.startTimedTurn(session, 'alkkagi');
    }
    session.updatedAt = new Date().toISOString();
    return animation;
  }

  private scheduleLocalAlkkagiAiTurn(id: string): void {
    setTimeout(() => {
      void this.runLocalAlkkagiAiTurn(id).catch((error) => {
        // Local AI failures should not crash the API process.
        console.error(error);
      });
    }, LOCAL_AI_RESPONSE_DELAY_MS);
  }

  private async runLocalAlkkagiAiTurn(id: string): Promise<void> {
    const session = this.alkkagiFromRow(await this.requireGameRow(id, 'alkkagi'));
    if (session.mode !== 'local_ai' || session.status !== 'playing' || !isLocalAiAccount(session.players[session.currentTurn])) {
      return;
    }
    const deadline = Date.now() + ALKKAGI_AI_BUDGET_MS;
    const shot = chooseAlkkagiAiShot(session, session.aiDifficulty ?? 'easy', deadline) ?? randomAlkkagiShot(session);
    if (!shot) {
      session.status = 'finished';
      session.winner = session.currentTurn === 'red' ? 'blue' : 'red';
      session.finishReason = 'no_active_piece';
      session.updatedAt = new Date().toISOString();
      const saved = this.alkkagiFromRow(await this.updateGame(session.id, session.status, session.currentTurn, session.winner, session));
      this.emitSessionEvent(saved, 'alkkagi.shot.played', { session: saved, animation: { frameMs: 16, frames: [] } });
      this.emitSessionEvent(saved, 'game.session.finished', saved);
      return;
    }
    const animation = this.applyAlkkagiShot(session, LOCAL_AI_ACCOUNT_ID, shot.pieceId, shot.vx, shot.vy, 'ai');
    const saved = this.alkkagiFromRow(await this.updateGame(session.id, session.status, session.currentTurn, session.winner ?? null, session));
    this.emitSessionEvent(saved, 'alkkagi.shot.played', { session: saved, animation });
    if (saved.status === 'finished') {
      this.emitSessionEvent(saved, 'game.session.finished', saved);
    }
  }

  private startTimedTurn(session: GomokuSession | AlkkagiSession, gameKey: 'gomoku' | 'alkkagi', delayMs = 0): void {
    if (session.mode !== 'friend_match' || session.status !== 'playing' || session.pause?.active) {
      return;
    }
    const now = Date.now();
    const limitMs = gameKey === 'gomoku' ? GOMOKU_TURN_LIMIT_MS : ALKKAGI_TURN_LIMIT_MS;
    session.turnStartedAt = new Date(now + delayMs).toISOString();
    session.turnDeadlineAt = new Date(now + delayMs + limitMs).toISOString();
    this.clearNetworkGrace(session);
  }

  private clearNetworkGrace(session: GomokuSession | AlkkagiSession): void {
    delete session.networkGraceStartedAt;
    delete session.networkGraceDeadlineAt;
    delete session.networkGraceAccountId;
  }

  private scheduleTurnTimer(session: GomokuSession | AlkkagiSession, gameKey: 'gomoku' | 'alkkagi'): void {
    this.clearTurnTimer(session.id);
    if (session.mode !== 'friend_match' || session.status !== 'playing') {
      return;
    }
    const deadline = session.networkGraceDeadlineAt ?? session.turnDeadlineAt;
    if (!deadline) {
      return;
    }
    const delay = Math.max(100, Date.parse(deadline) - Date.now());
    this.turnTimers.set(session.id, setTimeout(() => {
      void this.handleTurnTimer(session.id, gameKey).catch((error) => {
        // Timer failures should not crash the API process.
        console.error(error);
      });
    }, delay));
  }

  private clearTurnTimer(sessionId: string): void {
    const timer = this.turnTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(sessionId);
    }
  }

  private async handleTurnTimer(id: string, gameKey: 'gomoku' | 'alkkagi'): Promise<void> {
    const row = await this.requireGameRow(id, gameKey);
    if (row.mode !== 'friend_match' || row.status !== 'playing') {
      this.clearTurnTimer(id);
      return;
    }
    const state = row.state_json as { pause?: MatchPauseState };
    if (state.pause?.active) {
      this.clearTurnTimer(id);
      return;
    }
    if (gameKey === 'gomoku') {
      await this.handleGomokuTimer(row);
      return;
    }
    await this.handleAlkkagiTimer(row);
  }

  private async restoreActiveTurnTimers(): Promise<void> {
    const result = await this.db.query<GameRow>(
      `SELECT * FROM game_sessions
       WHERE mode = 'friend_match'
         AND status = 'playing'
         AND game_key IN ('gomoku', 'alkkagi')`,
    );
    for (const row of result.rows) {
      if (row.game_key === 'gomoku') {
        this.scheduleTurnTimer(this.gomokuFromRow(row), 'gomoku');
      } else if (row.game_key === 'alkkagi') {
        this.scheduleTurnTimer(this.alkkagiFromRow(row), 'alkkagi');
      }
    }
  }

  private async handleGomokuTimer(row: GameRow): Promise<void> {
    const session = this.gomokuFromRow(row);
    if (this.shouldRescheduleBeforeDeadline(session, 'gomoku')) {
      this.scheduleTurnTimer(session, 'gomoku');
      return;
    }
    if (await this.resolveDisconnectGrace(session, 'gomoku')) {
      return;
    }
    const currentAccountId = session.players[session.currentTurn];
    if (!this.realtime.isAccountConnected(currentAccountId)) {
      await this.startDisconnectGrace(session, 'gomoku', currentAccountId);
      return;
    }
    const empty = availableGomokuCells(session.board);
    if (empty.length === 0) {
      session.status = 'finished';
      session.finishReason = 'draw';
      session.updatedAt = new Date().toISOString();
      this.clearTurnTimer(session.id);
      const saved = this.gomokuFromRow(await this.updateGame(session.id, session.status, session.currentTurn, session.winner ?? null, session));
      this.emitSessionEvent(saved, 'gomoku.move.played', saved);
      return;
    }
    const [rowIndex, colIndex] = empty[Math.floor(Math.random() * empty.length)];
    this.applyGomokuMove(session, currentAccountId, rowIndex, colIndex, 'timeout');
    const saved = this.gomokuFromRow(await this.updateGame(session.id, session.status, session.currentTurn, session.winner ?? null, session));
    this.scheduleTurnTimer(saved, 'gomoku');
    this.emitSessionEvent(saved, 'gomoku.move.played', saved);
  }

  private async handleAlkkagiTimer(row: GameRow): Promise<void> {
    const session = this.alkkagiFromRow(row);
    if (this.shouldRescheduleBeforeDeadline(session, 'alkkagi')) {
      this.scheduleTurnTimer(session, 'alkkagi');
      return;
    }
    if (await this.resolveDisconnectGrace(session, 'alkkagi')) {
      return;
    }
    const currentAccountId = session.players[session.currentTurn];
    if (!this.realtime.isAccountConnected(currentAccountId)) {
      await this.startDisconnectGrace(session, 'alkkagi', currentAccountId);
      return;
    }
    const candidates = session.pieces.filter((item) => item.active && item.team === session.currentTurn);
    if (candidates.length === 0) {
      session.status = 'finished';
      session.winner = session.currentTurn === 'red' ? 'blue' : 'red';
      session.finishReason = 'no_active_piece';
      session.updatedAt = new Date().toISOString();
      this.clearTurnTimer(session.id);
      const saved = this.alkkagiFromRow(await this.updateGame(session.id, session.status, session.currentTurn, session.winner, session));
      this.emitSessionEvent(saved, 'alkkagi.shot.played', { session: saved, animation: { frameMs: 16, frames: [] } });
      return;
    }
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const aimedShot = this.timeoutAlkkagiAim(session, currentAccountId, candidates);
    const angle = Math.random() * Math.PI * 2;
    const speed = 16 + Math.random() * 16;
    const animation = aimedShot
      ? this.applyAlkkagiShot(session, currentAccountId, aimedShot.pieceId, aimedShot.vx, aimedShot.vy, 'timeout')
      : this.applyAlkkagiShot(session, currentAccountId, target.id, Math.cos(angle) * speed, Math.sin(angle) * speed, 'timeout');
    const saved = this.alkkagiFromRow(await this.updateGame(session.id, session.status, session.currentTurn, session.winner ?? null, session));
    this.scheduleTurnTimer(saved, 'alkkagi');
    this.emitSessionEvent(saved, 'alkkagi.shot.played', { session: saved, animation });
  }

  private timeoutAlkkagiAim(
    session: AlkkagiSession,
    accountId: string,
    candidates: AlkkagiPiece[],
  ): { pieceId: string; vx: number; vy: number } | undefined {
    const aim = session.lastAim;
    if (!aim || aim.accountId !== accountId) {
      return undefined;
    }
    const piece = candidates.find((item) => item.id === aim.pieceId);
    if (!piece) {
      return undefined;
    }
    const dx = aim.startX - aim.currentX;
    const dy = aim.startY - aim.currentY;
    if (Math.hypot(dx, dy) < 12) {
      return undefined;
    }
    return {
      pieceId: piece.id,
      vx: clamp(dx / ALKKAGI_BOARD_SIZE * 90, -40, 40),
      vy: clamp(dy / ALKKAGI_BOARD_SIZE * 90, -40, 40),
    };
  }

  private shouldRescheduleBeforeDeadline(session: GomokuSession | AlkkagiSession, gameKey: 'gomoku' | 'alkkagi'): boolean {
    const deadline = session.networkGraceDeadlineAt ?? session.turnDeadlineAt;
    if (!deadline) {
      this.startTimedTurn(session, gameKey);
      return false;
    }
    return Date.parse(deadline) > Date.now() + 50;
  }

  private async resolveDisconnectGrace(session: GomokuSession | AlkkagiSession, gameKey: 'gomoku' | 'alkkagi'): Promise<boolean> {
    if (!session.networkGraceDeadlineAt || !session.networkGraceAccountId) {
      return false;
    }
    if (Date.parse(session.networkGraceDeadlineAt) > Date.now() + 50) {
      this.scheduleTurnTimer(session, gameKey);
      return true;
    }
    if (this.realtime.isAccountConnected(session.networkGraceAccountId)) {
      this.clearNetworkGrace(session);
      return false;
    }
    if (gameKey === 'gomoku') {
      const gomoku = session as GomokuSession;
      const loser = this.participantSide(gomoku.players, session.networkGraceAccountId, gomoku.currentTurn);
      gomoku.status = 'finished';
      gomoku.winner = loser === 'black' ? 'white' : 'black';
      gomoku.finishReason = 'disconnect';
      gomoku.updatedAt = new Date().toISOString();
      this.clearTurnTimer(gomoku.id);
      const saved = this.gomokuFromRow(await this.updateGame(gomoku.id, gomoku.status, gomoku.currentTurn, gomoku.winner, gomoku));
      this.emitSessionEvent(saved, 'gomoku.move.played', saved);
      this.emitSessionEvent(saved, 'game.session.finished', saved);
      return true;
    }
    const alkkagi = session as AlkkagiSession;
    const loser = this.participantSide(alkkagi.players, session.networkGraceAccountId, alkkagi.currentTurn);
    alkkagi.status = 'finished';
    alkkagi.winner = loser === 'red' ? 'blue' : 'red';
    alkkagi.finishReason = 'disconnect';
    alkkagi.updatedAt = new Date().toISOString();
    this.clearTurnTimer(alkkagi.id);
    const saved = this.alkkagiFromRow(await this.updateGame(alkkagi.id, alkkagi.status, alkkagi.currentTurn, alkkagi.winner, alkkagi));
    this.emitSessionEvent(saved, 'alkkagi.shot.played', { session: saved, animation: { frameMs: 16, frames: [] } });
    this.emitSessionEvent(saved, 'game.session.finished', saved);
    return true;
  }

  private async startDisconnectGrace(
    session: GomokuSession | AlkkagiSession,
    gameKey: 'gomoku' | 'alkkagi',
    accountId: string,
  ): Promise<void> {
    const now = Date.now();
    session.networkGraceStartedAt = new Date(now).toISOString();
    session.networkGraceDeadlineAt = new Date(now + DISCONNECT_GRACE_MS).toISOString();
    session.networkGraceAccountId = accountId;
    session.updatedAt = new Date(now).toISOString();
    const saved = gameKey === 'gomoku'
      ? this.gomokuFromRow(await this.updateGame(session.id, session.status, (session as GomokuSession).currentTurn, session.winner ?? null, session))
      : this.alkkagiFromRow(await this.updateGame(session.id, session.status, (session as AlkkagiSession).currentTurn, session.winner ?? null, session));
    this.scheduleTurnTimer(saved, gameKey);
    this.emitSessionEvent(saved, 'game.turn.network_waiting', saved);
  }

  private participantSide<T extends string>(players: Record<T, string>, accountId: string, fallback: T): T {
    for (const [side, playerAccountId] of Object.entries(players) as Array<[T, string]>) {
      if (playerAccountId === accountId) {
        return side;
      }
    }
    return fallback;
  }

  private emitSessionEvent(session: SudokuSession | GomokuSession | AlkkagiSession, event: string, payload: unknown): void {
    this.realtime.emitToAccounts(sessionAccountIds(session), event, payload);
  }

  private emitSudokuEvent(session: SudokuSession, event: string): void {
    for (const accountId of sessionAccountIds(session)) {
      this.realtime.emitToAccounts([accountId], event, hideSudokuSolutionForAccount(session, accountId));
    }
  }
}

function withRowDates<T extends { id: string; createdAt: string; updatedAt: string; status: string }>(state: T, row: GameRow): T {
  return {
    ...state,
    id: row.id,
    mode: row.mode,
    status: row.status as T['status'],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function hideSudokuSolution(session: SudokuSession, user?: AuthAccount): Omit<SudokuSession, 'solution'> {
  return hideSudokuSolutionForAccount(session, user?.accountId);
}

function hideSudokuSolutionForAccount(session: SudokuSession, accountId?: string): Omit<SudokuSession, 'solution'> {
  const { solution: _solution, ...visible } = session;
  if (!session.players || !accountId) {
    return visible;
  }
  const side = sudokuSideForAccount(session, accountId) ?? 'challenger';
  const opponent = side === 'challenger' ? 'opponent' : 'challenger';
  return {
    ...visible,
    board: cloneSudokuGrid(ensureSudokuPlayerBoard(session, side)),
    boards: undefined,
    battle: undefined,
    progress: {
      [side]: sudokuProgress(session, side),
      [opponent]: sudokuProgress(session, opponent),
    } as Record<SudokuSide, SudokuProgress>,
    obscuredCells: activeObscuredCells(session, side),
    pendingDamage: session.battle?.[side]?.pendingDamage ?? 0,
    combo: session.battle?.[side]?.combo ?? 0,
    mySide: side,
  } as Omit<SudokuSession, 'solution'> & {
    obscuredCells: Array<{ row: number; col: number; until: string }>;
    pendingDamage: number;
    combo: number;
    mySide: SudokuSide;
  };
}

function cloneSudokuGrid(grid: number[][]): number[][] {
  return grid.map((row) => [...row]);
}

function ensureSudokuPlayerBoard(session: SudokuSession, side: SudokuSide): number[][] {
  session.boards ??= {
    challenger: cloneSudokuGrid(session.board),
    opponent: cloneSudokuGrid(session.board),
  };
  session.boards[side] ??= cloneSudokuGrid(session.board);
  return session.boards[side];
}

function sudokuSideForAccount(session: SudokuSession, accountId: string): SudokuSide | undefined {
  if (session.players?.challenger === accountId) return 'challenger';
  if (session.players?.opponent === accountId) return 'opponent';
  return undefined;
}

function createSudokuProgressMap(session: SudokuSession): Record<SudokuSide, SudokuProgress> {
  return {
    challenger: sudokuProgress(session, 'challenger'),
    opponent: sudokuProgress(session, 'opponent'),
  };
}

function sudokuProgress(session: SudokuSession, side: SudokuSide): SudokuProgress {
  const board = ensureSudokuPlayerBoard(session, side);
  let total = 0;
  let filled = 0;
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      if (session.puzzle[row][col] === 0) {
        total += 1;
        if (board[row][col] !== 0) filled += 1;
      }
    }
  }
  return {
    filled,
    total,
    percent: total === 0 ? 100 : Math.round((filled / total) * 1000) / 10,
  };
}

function createSudokuBattleState(board: number[][], solution: number[][]): SudokuBattleState {
  return {
    combo: 0,
    pendingDamage: 0,
    completedUnits: completedSudokuUnits(board, solution),
    obscuredCells: [],
  };
}

function applySudokuBattleMove(session: SudokuSession, side: SudokuSide): void {
  if (!session.players) return;
  const opponent = side === 'challenger' ? 'opponent' : 'challenger';
  session.battle ??= {
    challenger: createSudokuBattleState(ensureSudokuPlayerBoard(session, 'challenger'), session.solution),
    opponent: createSudokuBattleState(ensureSudokuPlayerBoard(session, 'opponent'), session.solution),
  };
  const self = session.battle[side];
  const rival = session.battle[opponent];
  self.obscuredCells = activeObscuredCells(session, side);
  rival.obscuredCells = activeObscuredCells(session, opponent);

  const board = ensureSudokuPlayerBoard(session, side);
  const previousUnits = new Set(self.completedUnits);
  const nextUnits = completedSudokuUnits(board, session.solution);
  const completedThisMove = nextUnits.some((unit) => !previousUnits.has(unit));
  self.completedUnits = nextUnits;

  if (self.pendingDamage > 0) {
    if (completedThisMove) {
      self.pendingDamage = 0;
    } else {
      self.obscuredCells = applySudokuObscure(session, side, self.pendingDamage);
      self.pendingDamage = 0;
    }
  }

  if (!completedThisMove) {
    self.combo = 0;
    return;
  }
  self.combo += 1;
  rival.pendingDamage += sudokuDamageForCombo(self.combo);
}

function completedSudokuUnits(board: number[][], solution: number[][]): string[] {
  const units: string[] = [];
  for (let row = 0; row < 9; row += 1) {
    if (Array.from({ length: 9 }, (_, col) => board[row][col] === solution[row][col]).every(Boolean)) {
      units.push(`r${row}`);
    }
  }
  for (let col = 0; col < 9; col += 1) {
    if (Array.from({ length: 9 }, (_, row) => board[row][col] === solution[row][col]).every(Boolean)) {
      units.push(`c${col}`);
    }
  }
  for (let boxRow = 0; boxRow < 3; boxRow += 1) {
    for (let boxCol = 0; boxCol < 3; boxCol += 1) {
      const complete = Array.from({ length: 9 }, (_, index) => {
        const row = boxRow * 3 + Math.floor(index / 3);
        const col = boxCol * 3 + (index % 3);
        return board[row][col] === solution[row][col];
      }).every(Boolean);
      if (complete) units.push(`b${boxRow}${boxCol}`);
    }
  }
  return units;
}

function sudokuDamageForCombo(combo: number): number {
  if (combo <= 0) return 0;
  if (combo === 1) return 1;
  if (combo === 2) return 2;
  return 5 + (combo - 3) * 3;
}

function activeObscuredCells(session: SudokuSession, side: SudokuSide): Array<{ row: number; col: number; until: string }> {
  const now = Date.now();
  return (session.battle?.[side]?.obscuredCells ?? []).filter((cell) => Date.parse(cell.until) > now);
}

function applySudokuObscure(session: SudokuSession, side: SudokuSide, amount: number): Array<{ row: number; col: number; until: string }> {
  const existing = activeObscuredCells(session, side);
  const existingKeys = new Set(existing.map((cell) => `${cell.row}:${cell.col}`));
  const candidates: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      if (session.puzzle[row][col] !== 0 && !existingKeys.has(`${row}:${col}`)) {
        candidates.push({ row, col });
      }
    }
  }
  const seed = Math.abs(hashText(`${session.id}:${side}:${Date.now()}`));
  const selected: Array<{ row: number; col: number; until: string }> = [];
  for (let index = 0; index < Math.min(amount, candidates.length); index += 1) {
    const pick = (seed + index * 17) % candidates.length;
    const [candidate] = candidates.splice(pick, 1);
    selected.push({
      ...candidate,
      until: new Date(Date.now() + SUDOKU_OBSCURE_MS).toISOString(),
    });
  }
  return [...existing, ...selected];
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function sessionAccountIds(session: SudokuSession | GomokuSession | AlkkagiSession): string[] {
  if ('players' in session && session.players) {
    return [...new Set(Object.values(session.players).filter((accountId) => !isLocalAiAccount(accountId)))];
  }
  if ('ownerAccountId' in session) {
    return [session.ownerAccountId].filter(Boolean);
  }
  return [];
}

function isLocalAiAccount(accountId: string): boolean {
  return accountId === LOCAL_AI_ACCOUNT_ID;
}

function shiftDeadline(session: SudokuSession | GomokuSession | AlkkagiSession, key: 'turnStartedAt' | 'turnDeadlineAt' | 'networkGraceStartedAt' | 'networkGraceDeadlineAt', deltaMs: number): void {
  const value = session[key];
  if (!value || deltaMs <= 0) return;
  session[key] = new Date(Date.parse(value) + deltaMs).toISOString();
}

function validateEmoteSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > 3) {
    throw new BadRequestException('slot must be 1, 2, or 3');
  }
}

function validateEmoteCells(cells: Array<string | null> | undefined, gridSize: 8 | 16): Array<string | null> {
  if (!Array.isArray(cells) || cells.length !== gridSize * gridSize) {
    throw new BadRequestException(`cells must have ${gridSize * gridSize} entries`);
  }
  return cells.map((cell) => {
    if (cell === null) {
      return null;
    }
    if (typeof cell !== 'string' || !EMOTE_COLORS.has(cell)) {
      throw new BadRequestException('cells contain an unsupported color');
    }
    return cell;
  });
}

function emoteFromRow(row: CustomEmoteRow): CustomEmote {
  const gridSize = row.grid_size === 16 ? 16 : 8;
  const cells = Array.isArray(row.cells_json)
    ? row.cells_json.map((cell) => typeof cell === 'string' ? cell : null)
    : Array.from({ length: gridSize * gridSize }, () => null);
  return {
    slot: row.slot,
    gridSize,
    cells,
    updatedAt: row.updated_at.toISOString(),
  };
}

function validateSudokuBoard(board: number[][]): void {
  if (board.length !== 9 || board.some((row) => row.length !== 9)) {
    throw new BadRequestException('board must be 9x9');
  }
  for (const row of board) {
    for (const value of row) {
      if (!Number.isInteger(value) || value < 0 || value > 9) {
        throw new BadRequestException('board values must be integers from 0 to 9');
      }
    }
  }
}

function validateSudokuIndex(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 8) {
    throw new BadRequestException(`${name} must be an integer from 0 to 8`);
  }
}

function validateGomokuIndex(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= GOMOKU_SIZE) {
    throw new BadRequestException(`${name} must be an integer from 0 to ${GOMOKU_SIZE - 1}`);
  }
}

function hasFive(board: (PlayerColor | null)[][], row: number, col: number, color: PlayerColor): boolean {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  return directions.some(([dr, dc]) => 1 + count(board, row, col, dr, dc, color) + count(board, row, col, -dr, -dc, color) >= 5);
}

function count(board: (PlayerColor | null)[][], row: number, col: number, dr: number, dc: number, color: PlayerColor): number {
  let total = 0;
  let currentRow = row + dr;
  let currentCol = col + dc;
  while (
    currentRow >= 0 &&
    currentRow < GOMOKU_SIZE &&
    currentCol >= 0 &&
    currentCol < GOMOKU_SIZE &&
    board[currentRow][currentCol] === color
  ) {
    total += 1;
    currentRow += dr;
    currentCol += dc;
  }
  return total;
}

interface GomokuAiMove {
  row: number;
  col: number;
}

function chooseGomokuAiMove(session: GomokuSession, difficulty: Difficulty, deadlineMs = Date.now() + GOMOKU_AI_BUDGET_MS): GomokuAiMove | undefined {
  const ai = session.currentTurn;
  const opponent = oppositeGomokuColor(ai);
  const winNow = findImmediateGomokuMove(session.board, ai);
  if (winNow) return winNow;
  if (Date.now() >= deadlineMs) return randomGomokuMove(session.board);
  const blockNow = findImmediateGomokuMove(session.board, opponent);
  if (blockNow && (difficulty !== 'easy' || Math.random() < 0.7)) return blockNow;
  if (Date.now() >= deadlineMs) return randomGomokuMove(session.board);

  const ranked = rankedGomokuCandidates(session.board, ai, difficulty);
  if (ranked.length === 0) return undefined;
  if (difficulty === 'easy') {
    const loosePool = ranked.slice(0, Math.min(ranked.length, 10));
    return loosePool[Math.floor(Math.random() * loosePool.length)];
  }

  const depth = difficulty === 'hard' ? 3 : 2;
  const limit = difficulty === 'hard' ? 18 : 12;
  let bestScore = Number.NEGATIVE_INFINITY;
  const best: GomokuAiMove[] = [];
  for (const move of ranked.slice(0, limit)) {
    if (Date.now() >= deadlineMs) break;
    session.board[move.row][move.col] = ai;
    const score = hasFive(session.board, move.row, move.col, ai)
      ? 10_000_000
      : gomokuMinimax(session.board, opponent, ai, depth - 1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, deadlineMs);
    session.board[move.row][move.col] = null;
    if (score > bestScore) {
      bestScore = score;
      best.length = 0;
      best.push(move);
    } else if (score === bestScore) {
      best.push(move);
    }
  }
  if (best.length === 0) {
    return ranked[0] ?? randomGomokuMove(session.board);
  }
  const pool = difficulty === 'medium' ? best.slice(0, 3) : best;
  return pool[Math.floor(Math.random() * pool.length)];
}

function gomokuMinimax(
  board: (PlayerColor | null)[][],
  current: PlayerColor,
  ai: PlayerColor,
  depth: number,
  alpha: number,
  beta: number,
  deadlineMs: number,
): number {
  if (depth <= 0 || Date.now() >= deadlineMs) {
    return evaluateGomokuBoard(board, ai);
  }
  const candidates = rankedGomokuCandidates(board, current, 'medium').slice(0, 14);
  if (candidates.length === 0) {
    return evaluateGomokuBoard(board, ai);
  }
  const maximizing = current === ai;
  let best = maximizing ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const next = oppositeGomokuColor(current);
  for (const move of candidates) {
    if (Date.now() >= deadlineMs) break;
    board[move.row][move.col] = current;
    const score = hasFive(board, move.row, move.col, current)
      ? (maximizing ? 10_000_000 + depth : -10_000_000 - depth)
      : gomokuMinimax(board, next, ai, depth - 1, alpha, beta, deadlineMs);
    board[move.row][move.col] = null;
    if (maximizing) {
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }
  return best;
}

function randomGomokuMove(board: (PlayerColor | null)[][]): GomokuAiMove | undefined {
  const empty = availableGomokuCells(board);
  if (empty.length === 0) return undefined;
  const [row, col] = empty[Math.floor(Math.random() * empty.length)];
  return { row, col };
}

function rankedGomokuCandidates(board: (PlayerColor | null)[][], color: PlayerColor, difficulty: Difficulty): GomokuAiMove[] {
  const candidates = gomokuCandidateCells(board, difficulty === 'hard' ? 2 : 1);
  const opponent = oppositeGomokuColor(color);
  return candidates
    .map((move) => {
      board[move.row][move.col] = color;
      const attack = hasFive(board, move.row, move.col, color) ? 9_000_000 : evaluateGomokuBoard(board, color);
      board[move.row][move.col] = opponent;
      const defense = hasFive(board, move.row, move.col, opponent) ? 8_000_000 : evaluateGomokuBoard(board, opponent) * 0.82;
      board[move.row][move.col] = null;
      const center = 7 - Math.abs(move.row - 7) - Math.abs(move.col - 7) * 0.08;
      return { ...move, score: attack + defense + center + Math.random() * (difficulty === 'easy' ? 900 : 4) };
    })
    .sort((left, right) => right.score - left.score)
    .map(({ row, col }) => ({ row, col }));
}

function gomokuCandidateCells(board: (PlayerColor | null)[][], radius: number): GomokuAiMove[] {
  const occupied: GomokuAiMove[] = [];
  for (let row = 0; row < GOMOKU_SIZE; row += 1) {
    for (let col = 0; col < GOMOKU_SIZE; col += 1) {
      if (board[row][col] !== null) occupied.push({ row, col });
    }
  }
  if (occupied.length === 0) {
    return [{ row: 7, col: 7 }];
  }
  const seen = new Set<string>();
  const cells: GomokuAiMove[] = [];
  for (const stone of occupied) {
    for (let row = Math.max(0, stone.row - radius); row <= Math.min(GOMOKU_SIZE - 1, stone.row + radius); row += 1) {
      for (let col = Math.max(0, stone.col - radius); col <= Math.min(GOMOKU_SIZE - 1, stone.col + radius); col += 1) {
        const key = `${row}:${col}`;
        if (board[row][col] === null && !seen.has(key)) {
          seen.add(key);
          cells.push({ row, col });
        }
      }
    }
  }
  return cells.length === 0 ? availableGomokuCells(board).map(([row, col]) => ({ row, col })) : cells;
}

function findImmediateGomokuMove(board: (PlayerColor | null)[][], color: PlayerColor): GomokuAiMove | undefined {
  for (const move of gomokuCandidateCells(board, 1)) {
    board[move.row][move.col] = color;
    const wins = hasFive(board, move.row, move.col, color);
    board[move.row][move.col] = null;
    if (wins) return move;
  }
  return undefined;
}

function evaluateGomokuBoard(board: (PlayerColor | null)[][], ai: PlayerColor): number {
  let score = 0;
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (let row = 0; row < GOMOKU_SIZE; row += 1) {
    for (let col = 0; col < GOMOKU_SIZE; col += 1) {
      for (const [dr, dc] of directions) {
        const endRow = row + dr * 4;
        const endCol = col + dc * 4;
        if (endRow < 0 || endRow >= GOMOKU_SIZE || endCol < 0 || endCol >= GOMOKU_SIZE) continue;
        let own = 0;
        let enemy = 0;
        for (let step = 0; step < 5; step += 1) {
          const cell = board[row + dr * step][col + dc * step];
          if (cell === ai) own += 1;
          else if (cell !== null) enemy += 1;
        }
        score += gomokuWindowScore(own, enemy);
      }
    }
  }
  return score;
}

function gomokuWindowScore(own: number, enemy: number): number {
  if (own > 0 && enemy > 0) return 0;
  if (own === 5) return 10_000_000;
  if (enemy === 5) return -10_000_000;
  const values = [0, 12, 120, 1_400, 75_000, 10_000_000];
  if (own > 0) return values[own];
  if (enemy > 0) return -values[enemy] * 1.08;
  return 0;
}

function oppositeGomokuColor(color: PlayerColor): PlayerColor {
  return color === 'black' ? 'white' : 'black';
}

function initialAlkkagiPieces(): AlkkagiPiece[] {
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

interface AlkkagiAiShot {
  pieceId: string;
  vx: number;
  vy: number;
}

interface AlkkagiSimulationOptions {
  ignoreHinges?: boolean;
}

function chooseAlkkagiAiShot(session: AlkkagiSession, difficulty: Difficulty, deadlineMs = Date.now() + ALKKAGI_AI_BUDGET_MS): AlkkagiAiShot | undefined {
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

function randomAlkkagiShot(session: AlkkagiSession): AlkkagiAiShot | undefined {
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

function oppositeAlkkagiTeam(team: PieceTeam): PieceTeam {
  return team === 'red' ? 'blue' : 'red';
}

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [items[index], items[target]] = [items[target], items[index]];
  }
  return items;
}

function simulateAlkkagi(pieces: AlkkagiPiece[], options: AlkkagiSimulationOptions = {}): { frameMs: number; frames: AlkkagiPiece[][] } {
  const frames: AlkkagiPiece[][] = [clonePieces(pieces)];
  for (let tick = 0; tick < 260; tick += 1) {
    for (const item of pieces.filter((pieceItem) => pieceItem.active)) {
      item.x += item.vx;
      item.y += item.vy;
      item.vx *= 0.965;
      item.vy *= 0.965;
      if (Math.abs(item.vx) < 0.02) item.vx = 0;
      if (Math.abs(item.vy) < 0.02) item.vy = 0;
      const radius = pieceRadius(item);
      if (item.x < -radius || item.x > ALKKAGI_BOARD_SIZE + radius || item.y < -radius || item.y > ALKKAGI_BOARD_SIZE + radius) {
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

function availableGomokuCells(board: (PlayerColor | null)[][]): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      if (board[row][col] === null) {
        cells.push([row, col]);
      }
    }
  }
  return cells;
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

import { BadRequestException, ForbiddenException, Injectable, ConflictException, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthAccount } from '../auth/auth.types';
import { emoteGridSizeFor, hasPlayerAccess } from '../auth/roles';
import { RealtimeService } from '../realtime/realtime.service';
import { createSudoku, isSolvedSudoku } from './sudoku-generator';
import { createSokobanMap, createVerifiedSokobanMap, GeneratedSokobanMap } from './sokoban-generator';
import {
  applySplendorAiTurn,
  applySplendorBuy,
  applySplendorForfeit,
  applySplendorReserve,
  applySplendorTakeTokens,
  createSplendorDecks,
  createSplendorState,
  splendorClientSession,
  SplendorCard,
  SplendorClientSession,
  SplendorNoble,
  SplendorPlayerState,
  SplendorSession,
  SplendorSide,
  SPLENDOR_TIERS,
  splendorSideForAccount,
  SplendorToken,
} from './splendor-engine';
import {
  applyFortressAiTurn,
  applyFortressForfeit,
  applyFortressMove,
  applyFortressShot,
  createFortressState,
  ensureFortressRuntimeState,
  fortressClientSession,
  FortressFloatingPlatform,
  FortressItemKey,
  FortressPosition,
  FortressSession,
  FortressShotResult,
  FortressSide,
  fortressSideForAccount,
  selectFortressTank,
  updateFortressAim,
} from './fortress-engine';
import {
  AlkkagiPiece,
  AlkkagiShotResult,
  AlkkagiSession,
  CrazyArcadeSession,
  CrazyArcadeSide,
  CustomEmote,
  Difficulty,
  GameMode,
  GomokuSession,
  MatchPauseState,
  OthelloColor,
  OthelloSession,
  PieceTeam,
  PlayerColor,
  SudokuBattleState,
  SudokuProgress,
  SudokuSession,
  SudokuSide,
  SokobanPlayerState,
  SokobanPosition,
  SokobanSession,
  SokobanSide,
} from './games.types';

const GOMOKU_SIZE = 15;
const OTHELLO_SIZE = 8;
const ALKKAGI_BOARD_SIZE = 1000;
const MATCH_READY_DELAY_MS = 4_000;
const GOMOKU_TURN_LIMIT_MS = 15_000;
const ALKKAGI_TURN_LIMIT_MS = 10_000;
const FORTRESS_TURN_LIMIT_MS = 20_000;
const GOMOKU_AI_BUDGET_MS = 900;
const ALKKAGI_AI_BUDGET_MS = 1_400;
const LOCAL_AI_RESPONSE_DELAY_MS = 180;
const FORTRESS_AI_RESPONSE_DELAY_MS = 1_000;
const FORTRESS_SHOT_ANIMATION_MS = 2_800;
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

interface SokobanMapRow {
  id: string;
  difficulty: Difficulty;
  map_key: string;
  map_json: unknown;
  metrics_json: unknown;
  created_at: Date;
}

@Injectable()
export class GamesService implements OnModuleInit, OnModuleDestroy {
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly emoteCooldowns = new Map<string, number>();

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.db.ready();
    await this.prepareSokobanMapPool();
    await this.restoreActiveTurnTimers();
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
      { key: 'othello', title: 'Othello', modes: ['local_ai', 'friend_match'], status: 'playable' },
      { key: 'sokoban', title: 'Sokoban', modes: ['solo', 'friend_match'], status: 'playable' },
      { key: 'splendor', title: 'Splendor', modes: ['local_ai', 'friend_match'], status: 'playable' },
      { key: 'fortress', title: 'Fortress', modes: ['local_ai', 'friend_match'], status: 'playable' },
      { key: 'crazy_arcade', title: 'Crazy Arcade', modes: ['local_ai', 'friend_match'], status: 'playable' },
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
    difficulty: Difficulty = 'medium',
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
    difficulty: Difficulty = 'medium',
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

  async createOthelloSession(
    user: AuthAccount,
    opponentAccountId?: string,
    mode?: 'local_ai' | 'friend_match',
    difficulty: Difficulty = 'medium',
  ): Promise<OthelloSession> {
    this.assertDifficulty(difficulty);
    const resolvedMode = opponentAccountId ? 'friend_match' : mode ?? 'local_ai';
    const state: OthelloSession = {
      id: '',
      mode: resolvedMode,
      aiDifficulty: resolvedMode === 'local_ai' ? difficulty : undefined,
      board: initialOthelloBoard(),
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
      state.pause = { active: false, counts: { [user.accountId]: 0, [opponentAccountId!]: 0 } } as MatchPauseState;
    }
    const row = await this.insertGame('othello', resolvedMode, user.accountId, opponentAccountId ?? null, 'playing', 'black', null, state);
    const session = this.othelloFromRow(row);
    this.emitSessionEvent(session, 'game.session.created', session);
    return session;
  }

  async getOthelloSession(id: string, user: AuthAccount): Promise<OthelloSession> {
    const session = this.othelloFromRow(await this.requireGameRow(id, 'othello'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    return session;
  }

  async playOthelloMove(id: string, user: AuthAccount, row: number, col: number): Promise<OthelloSession> {
    validateOthelloIndex(row, 'row');
    validateOthelloIndex(col, 'col');
    const session = this.othelloFromRow(await this.requireGameRow(id, 'othello'));
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
    applyOthelloMove(session, user.accountId, row, col, 'manual');
    const saved = this.othelloFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session));
    this.emitSessionEvent(saved, 'othello.move.played', saved);
    if (saved.mode === 'local_ai' && saved.status === 'playing' && isLocalAiAccount(saved.players[saved.currentTurn])) {
      this.scheduleLocalOthelloAiTurn(saved.id);
    }
    return saved;
  }

  async sendOthelloEmote(id: string, user: AuthAccount, slot: number): Promise<unknown> {
    const session = this.othelloFromRow(await this.requireGameRow(id, 'othello'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    return this.sendSessionEmote('othello', session, user, slot);
  }

  async forfeitOthello(id: string, user: AuthAccount): Promise<OthelloSession> {
    const session = this.othelloFromRow(await this.requireGameRow(id, 'othello'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    if (session.status !== 'playing') {
      return session;
    }
    const loser = this.participantSide(session.players, user.accountId, session.currentTurn);
    session.status = 'finished';
    session.winner = loser === 'black' ? 'white' : 'black';
    session.finishReason = 'forfeit';
    session.updatedAt = new Date().toISOString();
    const saved = this.othelloFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner, session));
    this.emitSessionEvent(saved, 'othello.move.played', saved);
    this.emitSessionEvent(saved, 'game.session.finished', saved);
    return saved;
  }

  async createSokobanSession(
    user: AuthAccount,
    difficulty: Difficulty,
    opponentAccountId?: string,
  ): Promise<SokobanSession> {
    this.assertDifficulty(difficulty);
    const initial = await this.selectSokobanMap(difficulty);
    const resolvedMode = opponentAccountId ? 'friend_match' : 'solo';
    const state: SokobanSession = {
      id: '',
      mode: resolvedMode,
      ownerAccountId: user.accountId,
      difficulty,
      mapKey: initial.key,
      walls: initial.walls,
      goals: initial.goals,
      initialPlayer: initial.player,
      initialBoxes: initial.boxes,
      state: createSokobanPlayerState(initial),
      status: 'playing',
      createdAt: '',
      updatedAt: '',
    };
    if (opponentAccountId) {
      state.players = { challenger: user.accountId, opponent: opponentAccountId };
      state.states = {
        challenger: createSokobanPlayerState(initial),
        opponent: createSokobanPlayerState(initial),
      };
      state.pause = { active: false, counts: { [user.accountId]: 0, [opponentAccountId]: 0 } } as MatchPauseState;
    }
    const row = await this.insertGame('sokoban', resolvedMode, user.accountId, opponentAccountId ?? null, state.status, null, null, state);
    const session = this.sokobanFromRow(row);
    this.emitSokobanEvent(session, 'game.session.created');
    return session;
  }

  async getSokobanSession(id: string, user: AuthAccount): Promise<SokobanSession> {
    const session = this.sokobanFromRow(await this.requireGameRow(id, 'sokoban'));
    this.assertSokobanParticipant(user, session);
    return sessionForSokobanUser(session, user);
  }

  async moveSokoban(id: string, user: AuthAccount, direction: string): Promise<SokobanSession> {
    const session = this.sokobanFromRow(await this.requireGameRow(id, 'sokoban'));
    this.assertSokobanParticipant(user, session);
    if (session.status !== 'playing') {
      throw new BadRequestException('game is already finished');
    }
    this.assertNotPaused(session);
    const side = this.sokobanSideForUser(session, user);
    const playerState = side ? ensureSokobanPlayerState(session, side) : session.state;
    const moveResult = applySokobanMove(session, playerState, direction);
    if (!moveResult.moved) {
      return sessionForSokobanUser(session, user);
    }
    if (playerState.solved) {
      session.status = 'finished';
      session.solvedAt = new Date().toISOString();
      session.winnerSide = side ?? 'challenger';
      session.winnerAccountId = side ? session.players?.[side] : session.ownerAccountId;
      session.finishReason = side ? 'first_clear' : 'solo_clear';
    } else if (
      moveResult.pushedBox &&
      isSokobanBoxTouchingWall(session, moveResult.pushedBox) &&
      !isSokobanStateSolvable(session, playerState)
    ) {
      session.status = 'finished';
      session.finishReason = 'deadlock';
      if (side && session.players) {
        const winner = side === 'challenger' ? 'opponent' : 'challenger';
        session.winnerSide = winner;
        session.winnerAccountId = session.players[winner];
      }
    }
    session.updatedAt = new Date().toISOString();
    const saved = this.sokobanFromRow(await this.updateGame(id, session.status, null, session.winnerSide ?? null, session));
    this.emitSokobanEvent(saved, saved.status === 'finished' ? 'game.session.finished' : 'sokoban.move.played');
    return sessionForSokobanUser(saved, user);
  }

  async sendSokobanEmote(id: string, user: AuthAccount, slot: number): Promise<unknown> {
    const session = this.sokobanFromRow(await this.requireGameRow(id, 'sokoban'));
    this.assertSokobanParticipant(user, session);
    return this.sendSessionEmote('sokoban', session, user, slot);
  }

  async forfeitSokoban(id: string, user: AuthAccount): Promise<SokobanSession> {
    const session = this.sokobanFromRow(await this.requireGameRow(id, 'sokoban'));
    this.assertSokobanParticipant(user, session);
    if (session.status !== 'playing' || !session.players) {
      return sessionForSokobanUser(session, user);
    }
    const loser = this.sokobanSideForUser(session, user) ?? 'challenger';
    const winner = loser === 'challenger' ? 'opponent' : 'challenger';
    session.status = 'finished';
    session.winnerSide = winner;
    session.winnerAccountId = session.players[winner];
    session.finishReason = 'forfeit';
    session.updatedAt = new Date().toISOString();
    const saved = this.sokobanFromRow(await this.updateGame(id, session.status, null, session.winnerSide, session));
    this.emitSokobanEvent(saved, 'game.session.finished');
    return sessionForSokobanUser(saved, user);
  }

  async createSplendorSession(
    user: AuthAccount,
    opponentAccountId?: string,
    forcedMode?: GameMode,
    difficulty: Difficulty = 'medium',
  ): Promise<SplendorClientSession> {
    this.assertDifficulty(difficulty);
    const resolvedMode = forcedMode ?? (opponentAccountId ? 'friend_match' : 'local_ai');
    const opponent = opponentAccountId ?? LOCAL_AI_ACCOUNT_ID;
    const state = createSplendorState(user.accountId, opponent, resolvedMode, difficulty);
    const row = await this.insertGame('splendor', resolvedMode, user.accountId, opponentAccountId ?? null, 'playing', 'challenger', null, state);
    const session = this.splendorFromRow(row);
    this.emitSessionEvent(session, 'game.session.created', splendorClientSession(session));
    return splendorClientSession(session, user.accountId);
  }

  async getSplendorSession(id: string, user: AuthAccount): Promise<SplendorClientSession> {
    const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
    this.assertSplendorParticipant(user, session);
    return splendorClientSession(session, user.accountId);
  }

  async takeSplendorTokens(
    id: string,
    user: AuthAccount,
    tokens: Partial<Record<SplendorToken, number>>,
    discardTokens: Partial<Record<SplendorToken, number>> = {},
  ): Promise<SplendorClientSession> {
    const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
    this.assertSplendorParticipant(user, session);
    const side = this.splendorSideForUser(session, user);
    applySplendorTakeTokens(session, side, user.accountId, tokens, discardTokens);
    const saved = await this.saveSplendorSession(session);
    this.emitSessionEvent(saved, 'splendor.action.played', splendorClientSession(saved));
    this.scheduleSplendorAi(saved);
    return splendorClientSession(saved, user.accountId);
  }

  async reserveSplendorCard(
    id: string,
    user: AuthAccount,
    input: { cardId?: string; tier?: string; discardTokens?: Partial<Record<SplendorToken, number>> },
  ): Promise<SplendorClientSession> {
    const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
    this.assertSplendorParticipant(user, session);
    const side = this.splendorSideForUser(session, user);
    applySplendorReserve(session, side, user.accountId, input);
    const saved = await this.saveSplendorSession(session);
    this.emitSessionEvent(saved, 'splendor.action.played', splendorClientSession(saved));
    this.scheduleSplendorAi(saved);
    return splendorClientSession(saved, user.accountId);
  }

  async buySplendorCard(id: string, user: AuthAccount, cardId: string): Promise<SplendorClientSession> {
    const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
    this.assertSplendorParticipant(user, session);
    const side = this.splendorSideForUser(session, user);
    applySplendorBuy(session, side, user.accountId, cardId);
    const saved = await this.saveSplendorSession(session);
    this.emitSessionEvent(saved, saved.status === 'finished' ? 'game.session.finished' : 'splendor.action.played', splendorClientSession(saved));
    this.scheduleSplendorAi(saved);
    return splendorClientSession(saved, user.accountId);
  }

  async previewSplendorSelection(
    id: string,
    user: AuthAccount,
    input: { cardId?: string | null; tokens?: Record<string, number> },
  ): Promise<{ ok: true }> {
    const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
    this.assertSplendorParticipant(user, session);
    if (session.mode !== 'friend_match' || session.status !== 'playing') {
      return { ok: true };
    }
    const side = this.splendorSideForUser(session, user);
    const tokens = input.tokens && typeof input.tokens === 'object'
      ? Object.fromEntries(Object.entries(input.tokens).map(([key, value]) => [key, Number(value) || 0]))
      : {};
    const recipients = sessionAccountIds(session).filter((accountId) => accountId !== user.accountId);
    this.realtime.emitToAccounts(recipients, 'splendor.selection.preview', {
      gameKey: 'splendor',
      sessionId: session.id,
      accountId: user.accountId,
      side,
      cardId: input.cardId ?? null,
      tokens,
    });
    return { ok: true };
  }

  async sendSplendorEmote(id: string, user: AuthAccount, slot: number): Promise<unknown> {
    const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
    this.assertSplendorParticipant(user, session);
    return this.sendSessionEmote('splendor', session, user, slot);
  }

  async forfeitSplendor(id: string, user: AuthAccount): Promise<SplendorClientSession> {
    const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
    this.assertSplendorParticipant(user, session);
    const side = this.splendorSideForUser(session, user);
    applySplendorForfeit(session, side, user.accountId);
    const saved = await this.saveSplendorSession(session);
    this.emitSessionEvent(saved, 'game.session.finished', splendorClientSession(saved));
    return splendorClientSession(saved, user.accountId);
  }

  async createFortressSession(
    user: AuthAccount,
    opponentAccountId?: string,
    forcedMode?: GameMode,
    difficulty: Difficulty = 'medium',
  ): Promise<ReturnType<typeof fortressClientSession>> {
    this.assertDifficulty(difficulty);
    const resolvedMode = forcedMode ?? (opponentAccountId ? 'friend_match' : 'local_ai');
    const opponent = opponentAccountId ?? LOCAL_AI_ACCOUNT_ID;
    const state = createFortressState(user.accountId, opponent, resolvedMode, difficulty);
    if (resolvedMode === 'local_ai') {
      applyFortressAiTurn(state);
    }
    const row = await this.insertGame(
      'fortress',
      resolvedMode,
      user.accountId,
      opponentAccountId ?? null,
      state.status,
      state.currentTurn,
      state.winnerSide ?? null,
      state,
    );
    const session = this.fortressFromRow(row);
    this.emitSessionEvent(session, 'game.session.created', fortressClientSession(session));
    return fortressClientSession(session, user.accountId);
  }

  async getFortressSession(id: string, user: AuthAccount): Promise<ReturnType<typeof fortressClientSession>> {
    const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
    this.assertFortressParticipant(user, session);
    return fortressClientSession(session, user.accountId);
  }

  async selectFortressTank(
    id: string,
    user: AuthAccount,
    tankKey: string,
  ): Promise<ReturnType<typeof fortressClientSession>> {
    const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
    this.assertFortressParticipant(user, session);
    const side = this.fortressSideForUser(session, user);
    selectFortressTank(session, side, tankKey);
    if (session.mode === 'local_ai') {
      applyFortressAiTurn(session);
    }
    if (session.status === 'playing') {
      this.startFortressTimedTurn(session, session.mode === 'friend_match' ? MATCH_READY_DELAY_MS : 0);
    }
    const saved = await this.saveFortressSession(session);
    this.scheduleFortressTurnTimer(saved);
    this.emitSessionEvent(saved, 'fortress.state.changed', fortressClientSession(saved));
    return fortressClientSession(saved, user.accountId);
  }

  async moveFortress(
    id: string,
    user: AuthAccount,
    distance: number,
  ): Promise<ReturnType<typeof fortressClientSession>> {
    const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
    this.assertFortressParticipant(user, session);
    this.assertNotPaused(session);
    const side = this.fortressSideForUser(session, user);
    applyFortressMove(session, side, distance);
    const saved = await this.saveFortressSession(session);
    this.scheduleFortressTurnTimer(saved);
    this.emitSessionEvent(saved, saved.status === 'finished' ? 'game.session.finished' : 'fortress.state.changed', fortressClientSession(saved));
    this.scheduleFortressAi(saved);
    return fortressClientSession(saved, user.accountId);
  }

  async updateFortressAim(
    id: string,
    user: AuthAccount,
    angle: number,
    power: number,
    charging: boolean,
  ): Promise<ReturnType<typeof fortressClientSession>> {
    const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
    this.assertFortressParticipant(user, session);
    this.assertNotPaused(session);
    const side = this.fortressSideForUser(session, user);
    updateFortressAim(session, side, angle, power, charging);
    const saved = await this.saveFortressSession(session);
    this.emitSessionEvent(saved, 'fortress.state.changed', fortressClientSession(saved));
    return fortressClientSession(saved, user.accountId);
  }

  async shootFortress(
    id: string,
    user: AuthAccount,
    angle: number,
    power: number,
    item?: FortressItemKey,
  ): Promise<FortressShotResult & { session: ReturnType<typeof fortressClientSession> }> {
    const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
    this.assertFortressParticipant(user, session);
    this.assertNotPaused(session);
    const side = this.fortressSideForUser(session, user);
    const result = applyFortressShot(session, side, user.accountId, angle, power, 'manual', item);
    if (result.session.status === 'playing') {
      this.startFortressTimedTurn(result.session, FORTRESS_SHOT_ANIMATION_MS);
    }
    const saved = await this.saveFortressSession(result.session);
    this.scheduleFortressTurnTimer(saved);
    const payload = { ...result, session: fortressClientSession(saved) };
    this.emitSessionEvent(saved, 'fortress.shot.played', payload);
    if (saved.status === 'finished') {
      this.emitSessionEvent(saved, 'game.session.finished', fortressClientSession(saved));
    }
    this.scheduleFortressAi(saved);
    return { ...result, session: fortressClientSession(saved, user.accountId) };
  }

  async sendFortressEmote(id: string, user: AuthAccount, slot: number): Promise<unknown> {
    const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
    this.assertFortressParticipant(user, session);
    return this.sendSessionEmote('fortress', session, user, slot);
  }

  async forfeitFortress(id: string, user: AuthAccount): Promise<ReturnType<typeof fortressClientSession>> {
    const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
    this.assertFortressParticipant(user, session);
    const side = this.fortressSideForUser(session, user);
    applyFortressForfeit(session, side);
    const saved = await this.saveFortressSession(session);
    this.clearTurnTimer(saved.id);
    this.emitSessionEvent(saved, 'game.session.finished', fortressClientSession(saved));
    return fortressClientSession(saved, user.accountId);
  }

  async createCrazyArcadeSession(
    user: AuthAccount,
    opponentAccountId?: string,
    mode?: 'local_ai' | 'friend_match',
    difficulty: Difficulty = 'medium',
  ): Promise<CrazyArcadeSession> {
    this.assertDifficulty(difficulty);
    const resolvedMode = opponentAccountId ? 'friend_match' : mode ?? 'local_ai';
    const now = new Date().toISOString();
    const state: CrazyArcadeSession = {
      id: '',
      mode: resolvedMode,
      ownerAccountId: user.accountId,
      difficulty,
      aiDifficulty: resolvedMode === 'local_ai' ? difficulty : undefined,
      players: {
        challenger: user.accountId,
        opponent: opponentAccountId || LOCAL_AI_ACCOUNT_ID,
      },
      status: 'playing',
      snapshot: {
        seed: Math.floor(Math.random() * 0x7fffffff),
        rows: 11,
        cols: 13,
        createdAt: now,
      },
      inputs: {
        challenger: {},
        opponent: {},
      },
      version: 0,
      createdAt: '',
      updatedAt: '',
    };
    if (resolvedMode === 'friend_match') {
      state.pause = {
        active: false,
        counts: {
          [user.accountId]: 0,
          [opponentAccountId!]: 0,
        },
      };
    }
    const row = await this.insertGame(
      'crazy_arcade',
      resolvedMode,
      user.accountId,
      opponentAccountId ?? null,
      'playing',
      null,
      null,
      state,
    );
    const session = this.crazyArcadeFromRow(row);
    this.emitSessionEvent(session, 'game.session.created', session);
    return sessionForCrazyArcadeUser(session, user);
  }

  async getCrazyArcadeSession(id: string, user: AuthAccount): Promise<CrazyArcadeSession> {
    const session = this.crazyArcadeFromRow(await this.requireGameRow(id, 'crazy_arcade'));
    this.assertCrazyArcadeParticipant(user, session);
    return sessionForCrazyArcadeUser(session, user);
  }

  async syncCrazyArcadeState(
    id: string,
    user: AuthAccount,
    input: {
      snapshot?: Record<string, unknown>;
      status?: string;
      winnerSide?: string | null;
      finishReason?: string;
      version?: number;
    },
  ): Promise<CrazyArcadeSession> {
    const session = this.crazyArcadeFromRow(await this.requireGameRow(id, 'crazy_arcade'));
    this.assertCrazyArcadeParticipant(user, session);
    this.assertNotPaused(session);
    const side = this.crazyArcadeSideForUser(session, user);
    if (session.mode === 'friend_match' && side !== 'challenger' && session.status === 'playing') {
      throw new ForbiddenException('only host can sync matched crazy arcade state');
    }
    if (isRecord(input.snapshot)) {
      session.snapshot = input.snapshot;
    }
    const winnerSide = optionalCrazyArcadeSide(input.winnerSide);
    if (input.status === 'finished' || winnerSide) {
      session.status = 'finished';
      session.winnerSide = winnerSide ?? session.winnerSide;
      session.winnerAccountId = session.winnerSide ? session.players[session.winnerSide] : undefined;
      session.finishReason = stringFromSnapshot(input.finishReason, session.finishReason ?? 'finished');
    } else {
      session.status = 'playing';
      session.winnerSide = undefined;
      session.winnerAccountId = undefined;
      session.finishReason = undefined;
    }
    session.version = Math.max(session.version + 1, typeof input.version === 'number' ? Math.floor(input.version) : 0);
    session.updatedAt = new Date().toISOString();
    const saved = await this.saveCrazyArcadeSession(session);
    this.emitSessionEvent(saved, saved.status === 'finished' ? 'game.session.finished' : 'crazy_arcade.state.synced', saved);
    return sessionForCrazyArcadeUser(saved, user);
  }

  async updateCrazyArcadeInput(
    id: string,
    user: AuthAccount,
    input: Record<string, unknown>,
  ): Promise<CrazyArcadeSession> {
    const session = this.crazyArcadeFromRow(await this.requireGameRow(id, 'crazy_arcade'));
    this.assertCrazyArcadeParticipant(user, session);
    this.assertNotPaused(session);
    const side = this.crazyArcadeSideForUser(session, user);
    session.inputs[side] = {
      ...input,
      accountId: user.accountId,
      side,
      updatedAt: new Date().toISOString(),
    };
    session.version += 1;
    const saved = await this.saveCrazyArcadeSession(session);
    this.emitSessionEvent(saved, 'crazy_arcade.input.updated', {
      sessionId: saved.id,
      side,
      input: saved.inputs[side],
      version: saved.version,
    });
    return sessionForCrazyArcadeUser(saved, user);
  }

  async sendCrazyArcadeEmote(id: string, user: AuthAccount, slot: number): Promise<unknown> {
    const session = this.crazyArcadeFromRow(await this.requireGameRow(id, 'crazy_arcade'));
    this.assertCrazyArcadeParticipant(user, session);
    return this.sendSessionEmote('crazy_arcade', session, user, slot);
  }

  async forfeitCrazyArcade(id: string, user: AuthAccount): Promise<CrazyArcadeSession> {
    const session = this.crazyArcadeFromRow(await this.requireGameRow(id, 'crazy_arcade'));
    this.assertCrazyArcadeParticipant(user, session);
    if (session.status !== 'playing') {
      return sessionForCrazyArcadeUser(session, user);
    }
    const loser = this.crazyArcadeSideForUser(session, user);
    session.status = 'finished';
    session.winnerSide = loser === 'challenger' ? 'opponent' : 'challenger';
    session.winnerAccountId = session.players[session.winnerSide];
    session.finishReason = 'forfeit';
    session.version += 1;
    session.updatedAt = new Date().toISOString();
    const saved = await this.saveCrazyArcadeSession(session);
    this.emitSessionEvent(saved, 'game.session.finished', saved);
    return sessionForCrazyArcadeUser(saved, user);
  }

  async restoreLocalSaveSnapshot(
    gameKey: string,
    id: string,
    user: AuthAccount,
    snapshot: Record<string, unknown>,
  ): Promise<unknown> {
    if (gameKey === 'gomoku') {
      const row = await this.requireGameRow(id, 'gomoku');
      this.assertLocalSaveOwner(row, user);
      const current = this.gomokuFromRow(row);
      this.assertGameParticipant(user, current.players.black, current.players.white);
      this.assertLocalSaveMode(current.mode, 'local_ai');
      const board = gomokuBoardSnapshot(snapshot.board);
      const currentTurn = playerColorFromSnapshot(snapshot.currentTurn, 'black');
      const status = playingStatusFromSnapshot(snapshot.status);
      const winner = status === 'finished' ? optionalPlayerColor(snapshot.winner) : undefined;
      const restored: GomokuSession = {
        ...current,
        aiDifficulty: difficultyFromSnapshot(snapshot.aiDifficulty, current.aiDifficulty ?? 'medium'),
        board,
        currentTurn,
        status,
        winner,
        moves: gomokuMovesFromSnapshot(board, current.players, snapshot.lastMove),
        turnStartedAt: undefined,
        turnDeadlineAt: undefined,
        networkGraceStartedAt: undefined,
        networkGraceDeadlineAt: undefined,
        networkGraceAccountId: undefined,
        pause: undefined,
        finishReason: undefined,
      };
      this.clearTurnTimer(id);
      const saved = this.gomokuFromRow(await this.updateGame(id, restored.status, restored.currentTurn, restored.winner ?? null, restored));
      if (saved.mode === 'local_ai' && saved.status === 'playing' && isLocalAiAccount(saved.players[saved.currentTurn])) {
        this.scheduleLocalGomokuAiTurn(saved.id);
      }
      return saved;
    }

    if (gameKey === 'alkkagi') {
      const row = await this.requireGameRow(id, 'alkkagi');
      this.assertLocalSaveOwner(row, user);
      const current = this.alkkagiFromRow(row);
      this.assertGameParticipant(user, current.players.red, current.players.blue);
      this.assertLocalSaveMode(current.mode, 'local_ai');
      const currentTurn = pieceTeamFromSnapshot(snapshot.currentTurn, 'red');
      const status = playingStatusFromSnapshot(snapshot.status);
      const winner = status === 'finished' ? optionalPieceTeam(snapshot.winner) : undefined;
      const restored: AlkkagiSession = {
        ...current,
        aiDifficulty: difficultyFromSnapshot(snapshot.aiDifficulty, current.aiDifficulty ?? 'medium'),
        pieces: alkkagiPiecesFromSnapshot(snapshot.pieces),
        currentTurn,
        status,
        winner,
        shots: alkkagiShotsFromSnapshot(snapshot.shotCount, current.players),
        turnStartedAt: undefined,
        turnDeadlineAt: undefined,
        networkGraceStartedAt: undefined,
        networkGraceDeadlineAt: undefined,
        networkGraceAccountId: undefined,
        pause: undefined,
        lastAim: undefined,
        finishReason: undefined,
      };
      this.clearTurnTimer(id);
      const saved = this.alkkagiFromRow(await this.updateGame(id, restored.status, restored.currentTurn, restored.winner ?? null, restored));
      if (saved.mode === 'local_ai' && saved.status === 'playing' && isLocalAiAccount(saved.players[saved.currentTurn])) {
        this.scheduleLocalAlkkagiAiTurn(saved.id);
      }
      return saved;
    }

    if (gameKey === 'othello') {
      const row = await this.requireGameRow(id, 'othello');
      this.assertLocalSaveOwner(row, user);
      const current = this.othelloFromRow(row);
      this.assertGameParticipant(user, current.players.black, current.players.white);
      this.assertLocalSaveMode(current.mode, 'local_ai');
      const currentTurn = othelloColorFromSnapshot(snapshot.currentTurn, 'black');
      const status = playingStatusFromSnapshot(snapshot.status);
      const winner = status === 'finished' ? optionalOthelloColor(snapshot.winner) : undefined;
      const restored: OthelloSession = {
        ...current,
        aiDifficulty: difficultyFromSnapshot(snapshot.aiDifficulty, current.aiDifficulty ?? 'medium'),
        board: othelloBoardSnapshot(snapshot.board),
        currentTurn,
        status,
        winner,
        moves: [],
        pause: undefined,
        finishReason: undefined,
      };
      const saved = this.othelloFromRow(await this.updateGame(id, restored.status, restored.currentTurn, restored.winner ?? null, restored));
      if (saved.mode === 'local_ai' && saved.status === 'playing' && isLocalAiAccount(saved.players[saved.currentTurn])) {
        this.scheduleLocalOthelloAiTurn(saved.id);
      }
      return saved;
    }

    if (gameKey === 'sokoban') {
      const row = await this.requireGameRow(id, 'sokoban');
      this.assertLocalSaveOwner(row, user);
      const current = this.sokobanFromRow(row);
      this.assertLocalSaveMode(current.mode, 'solo');
      const walls = sokobanPositionsFromSnapshot(snapshot.walls);
      const goals = sokobanPositionsFromSnapshot(snapshot.goals);
      const boxes = sokobanPositionsFromSnapshot(snapshot.boxes);
      const player = sokobanPositionFromSnapshot(snapshot.player);
      const solved = boxes.length > 0 && boxes.every((box) => hasPosition(goals, box));
      const restored: SokobanSession = {
        ...current,
        difficulty: difficultyFromSnapshot(snapshot.difficulty, current.difficulty),
        mapKey: stringFromSnapshot(snapshot.mapKey, current.mapKey),
        walls,
        goals,
        state: {
          player,
          boxes,
          moves: nonNegativeIntFromSnapshot(snapshot.moves),
          solved,
        },
        status: playingStatusFromSnapshot(snapshot.status),
        winnerSide: undefined,
        winnerAccountId: undefined,
        finishReason: undefined,
        pause: undefined,
        solvedAt: undefined,
      };
      const saved = this.sokobanFromRow(await this.updateGame(id, restored.status, null, null, restored));
      return sessionForSokobanUser(saved, user);
    }

    if (gameKey === 'splendor') {
      const row = await this.requireGameRow(id, 'splendor');
      this.assertLocalSaveOwner(row, user);
      const current = this.splendorFromRow(row);
      this.assertSplendorParticipant(user, current);
      this.assertLocalSaveMode(current.mode, 'local_ai');
      const playerStates = splendorPlayerStatesFromSnapshot(snapshot.playerStates, current.playerStates);
      const market = splendorMarketFromSnapshot(snapshot.market, current.market);
      const nobles = splendorNoblesFromSnapshot(snapshot.nobles, current.nobles);
      const decks = splendorDecksFromVisibleCards(market, playerStates);
      const currentTurn = splendorSideFromSnapshot(snapshot.currentTurn, 'challenger');
      const status = playingStatusFromSnapshot(snapshot.status);
      const winnerSide = status === 'finished' ? optionalSplendorSide(snapshot.winnerSide) : undefined;
      const restored: SplendorSession = {
        ...current,
        aiDifficulty: difficultyFromSnapshot(snapshot.difficulty, current.aiDifficulty as Difficulty | undefined ?? 'medium'),
        currentTurn,
        status,
        winnerSide,
        winnerAccountId: winnerSide ? current.players[winnerSide] : undefined,
        bank: splendorTokenMapFromSnapshot(snapshot.bank, current.bank),
        market,
        decks,
        nobles,
        playerStates,
        moves: splendorMovesFromSnapshot(snapshot.moves),
        finalRoundStartedBy: optionalSplendorSide(snapshot.finalRoundStartedBy),
        pause: undefined,
        finishReason: undefined,
      };
      const saved = await this.saveSplendorSession(restored);
      this.scheduleSplendorAi(saved);
      return splendorClientSession(saved, user.accountId);
    }

    if (gameKey === 'fortress') {
      const row = await this.requireGameRow(id, 'fortress');
      this.assertLocalSaveOwner(row, user);
      const current = this.fortressFromRow(row);
      this.assertFortressParticipant(user, current);
      this.assertLocalSaveMode(current.mode, 'local_ai');
      const tanks = fortressTanksFromSnapshot(snapshot.tanks, current);
      const restored: FortressSession = {
        ...current,
        aiDifficulty: difficultyFromSnapshot(snapshot.difficulty, current.aiDifficulty ?? 'medium'),
        currentTurn: fortressSideFromSnapshot(snapshot.currentTurn, current.currentTurn),
        status: fortressStatusFromSnapshot(snapshot.status, current.status),
        winnerSide: optionalFortressSide(snapshot.winnerSide),
        winnerAccountId: optionalFortressSide(snapshot.winnerSide)
          ? current.players[optionalFortressSide(snapshot.winnerSide)!]
          : undefined,
        movementRemaining: fortressMovementRemainingFromSnapshot(snapshot.movementRemaining, current.movementRemaining),
        aim: fortressAimFromSnapshot(snapshot.aim, current.aim),
        itemsUsed: fortressItemsUsedFromSnapshot(snapshot.itemsUsed, current.itemsUsed),
        floatingPlatforms: fortressFloatingPlatformsFromSnapshot(snapshot.floatingPlatforms),
        turnStartPositions: fortressPositionsFromSnapshot(snapshot.turnStartPositions, tanks),
        terrain: numberArrayFromSnapshot(snapshot.terrain, current.terrain),
        wind: finiteNumber(snapshot.wind, current.wind),
        tanks,
        shots: fortressShotsFromSnapshot(snapshot.shots),
        turnStartedAt: undefined,
        turnDeadlineAt: undefined,
        pause: undefined,
        finishReason: undefined,
      };
      const saved = await this.saveFortressSession(restored);
      this.scheduleFortressAi(saved);
      return fortressClientSession(saved, user.accountId);
    }

    if (gameKey === 'crazy_arcade') {
      const row = await this.requireGameRow(id, 'crazy_arcade');
      this.assertLocalSaveOwner(row, user);
      const current = this.crazyArcadeFromRow(row);
      this.assertCrazyArcadeParticipant(user, current);
      this.assertLocalSaveMode(current.mode, 'local_ai');
      const restored: CrazyArcadeSession = {
        ...current,
        difficulty: difficultyFromSnapshot(snapshot.difficulty, current.difficulty),
        aiDifficulty: difficultyFromSnapshot(snapshot.aiDifficulty, current.aiDifficulty ?? 'medium'),
        status: playingStatusFromSnapshot(snapshot.status),
        winnerSide: optionalCrazyArcadeSide(snapshot.winnerSide),
        winnerAccountId: optionalCrazyArcadeSide(snapshot.winnerSide)
          ? current.players[optionalCrazyArcadeSide(snapshot.winnerSide)!]
          : undefined,
        snapshot: isRecord(snapshot.snapshot) ? snapshot.snapshot : { ...snapshot },
        inputs: { challenger: {}, opponent: {} },
        pause: undefined,
        finishReason: undefined,
        version: current.version + 1,
      };
      const saved = await this.saveCrazyArcadeSession(restored);
      return sessionForCrazyArcadeUser(saved, user);
    }

    throw new BadRequestException('gameKey must be gomoku, alkkagi, othello, sokoban, splendor, fortress, or crazy_arcade');
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
    if (gameKey === 'othello') {
      const session = this.othelloFromRow(await this.requireGameRow(id, 'othello'));
      this.assertGameParticipant(user, session.players.black, session.players.white);
      this.applyPause(session, user);
      const saved = this.othelloFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session));
      this.emitSessionEvent(saved, 'game.session.paused', saved);
      return saved;
    }
    if (gameKey === 'sokoban') {
      const session = this.sokobanFromRow(await this.requireGameRow(id, 'sokoban'));
      this.assertSokobanParticipant(user, session);
      this.applyPause(session, user);
      const saved = this.sokobanFromRow(await this.updateGame(id, session.status, null, session.winnerSide ?? null, session));
      this.emitSokobanEvent(saved, 'game.session.paused');
      return sessionForSokobanUser(saved, user);
    }
    if (gameKey === 'splendor') {
      const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
      this.assertSplendorParticipant(user, session);
      this.applyPause(session, user);
      const saved = await this.saveSplendorSession(session);
      this.emitSessionEvent(saved, 'game.session.paused', splendorClientSession(saved));
      return splendorClientSession(saved, user.accountId);
    }
    if (gameKey === 'fortress') {
      const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
      this.assertFortressParticipant(user, session);
      this.applyPause(session, user);
      const saved = await this.saveFortressSession(session);
      this.clearTurnTimer(saved.id);
      this.emitSessionEvent(saved, 'game.session.paused', fortressClientSession(saved));
      return fortressClientSession(saved, user.accountId);
    }
    if (gameKey === 'crazy_arcade') {
      const session = this.crazyArcadeFromRow(await this.requireGameRow(id, 'crazy_arcade'));
      this.assertCrazyArcadeParticipant(user, session);
      this.applyPause(session, user);
      const saved = await this.saveCrazyArcadeSession(session);
      this.emitSessionEvent(saved, 'game.session.paused', saved);
      return sessionForCrazyArcadeUser(saved, user);
    }
    throw new BadRequestException('gameKey must be sudoku, gomoku, alkkagi, othello, sokoban, splendor, fortress, or crazy_arcade');
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
    if (gameKey === 'othello') {
      const session = this.othelloFromRow(await this.requireGameRow(id, 'othello'));
      this.assertGameParticipant(user, session.players.black, session.players.white);
      this.applyResume(session);
      const saved = this.othelloFromRow(await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session));
      this.emitSessionEvent(saved, 'game.session.resumed', saved);
      return saved;
    }
    if (gameKey === 'sokoban') {
      const session = this.sokobanFromRow(await this.requireGameRow(id, 'sokoban'));
      this.assertSokobanParticipant(user, session);
      this.applyResume(session);
      const saved = this.sokobanFromRow(await this.updateGame(id, session.status, null, session.winnerSide ?? null, session));
      this.emitSokobanEvent(saved, 'game.session.resumed');
      return sessionForSokobanUser(saved, user);
    }
    if (gameKey === 'splendor') {
      const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
      this.assertSplendorParticipant(user, session);
      this.applyResume(session);
      const saved = await this.saveSplendorSession(session);
      this.emitSessionEvent(saved, 'game.session.resumed', splendorClientSession(saved));
      return splendorClientSession(saved, user.accountId);
    }
    if (gameKey === 'fortress') {
      const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
      this.assertFortressParticipant(user, session);
      this.applyResume(session);
      const saved = await this.saveFortressSession(session);
      this.scheduleFortressTurnTimer(saved);
      this.emitSessionEvent(saved, 'game.session.resumed', fortressClientSession(saved));
      return fortressClientSession(saved, user.accountId);
    }
    if (gameKey === 'crazy_arcade') {
      const session = this.crazyArcadeFromRow(await this.requireGameRow(id, 'crazy_arcade'));
      this.assertCrazyArcadeParticipant(user, session);
      this.applyResume(session);
      const saved = await this.saveCrazyArcadeSession(session);
      this.emitSessionEvent(saved, 'game.session.resumed', saved);
      return sessionForCrazyArcadeUser(saved, user);
    }
    throw new BadRequestException('gameKey must be sudoku, gomoku, alkkagi, othello, sokoban, splendor, fortress, or crazy_arcade');
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
    if (gameKey === 'othello') {
      return (await this.createOthelloSession(fakeUser, opponentAccountId, 'friend_match')).id;
    }
    if (gameKey === 'sokoban') {
      return (await this.createSokobanSession(fakeUser, 'medium', opponentAccountId)).id;
    }
    if (gameKey === 'splendor') {
      return (await this.createSplendorSession(fakeUser, opponentAccountId, 'friend_match')).id;
    }
    if (gameKey === 'fortress') {
      return (await this.createFortressSession(fakeUser, opponentAccountId, 'friend_match')).id;
    }
    if (gameKey === 'crazy_arcade') {
      return (await this.createCrazyArcadeSession(fakeUser, opponentAccountId, 'friend_match')).id;
    }
    throw new BadRequestException('match requests support sudoku, gomoku, alkkagi, othello, sokoban, splendor, fortress, or crazy_arcade');
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
      [gameKey, mode, status, currentTurn, winner, ownerAccountId, opponentAccountId, JSON.stringify({ ...(state as Record<string, unknown>), rev: 1 })],
    );
    return result.rows[0];
  }

  private async updateGame(id: string, status: string, currentTurn: string | null, winner: string | null, state: unknown): Promise<GameRow> {
    const stateRecord = state as Record<string, unknown> & { rev?: number };
    const expectedRev = typeof stateRecord.rev === 'number' ? stateRecord.rev : 0;
    const nextRev = expectedRev + 1;
    const result = await this.db.query<GameRow>(
      `UPDATE game_sessions
       SET status = $2, current_turn = $3, winner = $4, state_json = $5::jsonb, updated_at = now()
       WHERE id = $1
         AND COALESCE((state_json->>'rev')::int, 0) = $6
       RETURNING *`,
      [id, status, currentTurn, winner, JSON.stringify({ ...stateRecord, rev: nextRev }), expectedRev],
    );
    const row = result.rows[0];
    if (!row) {
      // Every caller loads the row just before saving, so a missed update means a rev conflict.
      throw new GameStateConflictError();
    }
    stateRecord.rev = nextRev;
    return row;
  }

  private async requireGameRow(id: string, gameKey: string): Promise<GameRow> {
    const row = await this.db.one<GameRow>(`SELECT * FROM game_sessions WHERE id = $1 AND game_key = $2`, [id, gameKey]);
    if (!row) {
      throw new NotFoundException('Game session not found');
    }
    return row;
  }

  private async prepareSokobanMapPool(): Promise<void> {
    if (process.env.GENERATE_MAP !== 'true') {
      return;
    }
    const difficulties: Difficulty[] = ['easy', 'medium', 'hard'];
    for (const difficulty of difficulties) {
      for (let index = 0; index < 30; index += 1) {
        const startedAt = Date.now();
        const map = createVerifiedSokobanMap(difficulty);
        this.validateGeneratedSokobanMap(map, difficulty);
        await this.db.query(
          `INSERT INTO sokoban_maps (difficulty, map_key, map_json, metrics_json)
           VALUES ($1, $2, $3::jsonb, $4::jsonb)
           ON CONFLICT (map_key) DO NOTHING`,
          [difficulty, map.key, JSON.stringify(map), JSON.stringify(map.metrics)],
        );
        console.log(
          `[sokoban-map] generated ${difficulty} ${index + 1}/30 ${map.key} in ${Date.now() - startedAt}ms`,
        );
      }
    }
  }

  private async selectSokobanMap(difficulty: Difficulty): Promise<GeneratedSokobanMap> {
    const result = await this.db.query<SokobanMapRow>(
      `SELECT id, difficulty, map_key, map_json, metrics_json, created_at
       FROM sokoban_maps
       WHERE difficulty = $1
       ORDER BY random()
       LIMIT 1`,
      [difficulty],
    );
    const row = result.rows[0];
    if (!row) {
      return createSokobanMap(difficulty);
    }
    return generatedSokobanMapFromRow(row);
  }

  private validateGeneratedSokobanMap(map: GeneratedSokobanMap, difficulty: Difficulty): void {
    const expectedBoxes = difficulty === 'easy' ? 1 : difficulty === 'medium' ? 2 : 3;
    if (map.boxes.length !== expectedBoxes || map.goals.length !== expectedBoxes) {
      throw new Error(`generated ${difficulty} sokoban map has invalid box/goal count`);
    }
    const session: SokobanSession = {
      id: 'validation',
      mode: 'solo',
      ownerAccountId: 'validation',
      difficulty,
      mapKey: map.key,
      walls: map.walls,
      goals: map.goals,
      initialPlayer: map.player,
      initialBoxes: map.boxes,
      state: createSokobanPlayerState(map),
      status: 'playing',
      createdAt: '',
      updatedAt: '',
    };
    if (!isSokobanStateSolvable(session, session.state)) {
      throw new Error(`generated ${difficulty} sokoban map is not solvable: ${map.key}`);
    }
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

  private othelloFromRow(row: GameRow): OthelloSession {
    return withRowDates(row.state_json as OthelloSession, row);
  }

  private sokobanFromRow(row: GameRow): SokobanSession {
    return withRowDates(row.state_json as SokobanSession, row);
  }

  private splendorFromRow(row: GameRow): SplendorSession {
    return withRowDates(row.state_json as SplendorSession, row);
  }

  private fortressFromRow(row: GameRow): FortressSession {
    const session = withRowDates(row.state_json as FortressSession, row);
    return ensureFortressRuntimeState(session);
  }

  private crazyArcadeFromRow(row: GameRow): CrazyArcadeSession {
    return withRowDates(row.state_json as CrazyArcadeSession, row);
  }

  private async saveSplendorSession(session: SplendorSession): Promise<SplendorSession> {
    return this.splendorFromRow(await this.updateGame(
      session.id,
      session.status,
      session.currentTurn,
      session.winnerSide ?? null,
      session,
    ));
  }

  private async saveFortressSession(session: FortressSession): Promise<FortressSession> {
    return this.fortressFromRow(await this.updateGame(
      session.id,
      session.status,
      session.currentTurn,
      session.winnerSide ?? null,
      session,
    ));
  }

  private async saveCrazyArcadeSession(session: CrazyArcadeSession): Promise<CrazyArcadeSession> {
    return this.crazyArcadeFromRow(await this.updateGame(
      session.id,
      session.status,
      null,
      session.winnerSide ?? null,
      session,
    ));
  }

  private assertDifficulty(difficulty: Difficulty): void {
    if (!['easy', 'medium', 'hard'].includes(difficulty)) {
      throw new BadRequestException('difficulty must be easy, medium, or hard');
    }
  }

  private assertLocalSaveOwner(row: GameRow, user: AuthAccount): void {
    if (row.owner_account_id !== user.accountId) {
      throw new ForbiddenException('local save restore is only available to the session owner');
    }
  }

  private assertLocalSaveMode(mode: GameMode | undefined, expected: 'local_ai' | 'solo'): void {
    if (mode !== expected) {
      throw new BadRequestException('local save restore is not available for matched games');
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

  private assertNotPaused(session: SudokuSession | GomokuSession | AlkkagiSession | OthelloSession | SokobanSession | SplendorSession | FortressSession | CrazyArcadeSession): void {
    if (session.pause?.active) {
      throw new BadRequestException('game is paused');
    }
  }

  private applyPause(session: SudokuSession | GomokuSession | AlkkagiSession | OthelloSession | SokobanSession | SplendorSession | FortressSession | CrazyArcadeSession, user: AuthAccount): void {
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

  private applyResume(session: SudokuSession | GomokuSession | AlkkagiSession | OthelloSession | SokobanSession | SplendorSession | FortressSession | CrazyArcadeSession): void {
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

  private assertSokobanParticipant(user: AuthAccount, session: SokobanSession): void {
    if (session.players) {
      this.assertGameParticipant(user, session.players.challenger, session.players.opponent);
      return;
    }
    this.assertParticipant(user, session.ownerAccountId);
  }

  private assertSplendorParticipant(user: AuthAccount, session: SplendorSession): void {
    this.assertGameParticipant(user, session.players.challenger, session.players.opponent);
  }

  private assertFortressParticipant(user: AuthAccount, session: FortressSession): void {
    this.assertGameParticipant(user, session.players.challenger, session.players.opponent);
  }

  private assertCrazyArcadeParticipant(user: AuthAccount, session: CrazyArcadeSession): void {
    this.assertGameParticipant(user, session.players.challenger, session.players.opponent);
  }

  private splendorSideForUser(session: SplendorSession, user: AuthAccount): SplendorSide {
    const side = splendorSideForAccount(session, user.accountId);
    if (side) {
      return side;
    }
    if (user.permission === 'superadmin') {
      return session.currentTurn;
    }
    throw new ForbiddenException('not a participant');
  }

  private fortressSideForUser(session: FortressSession, user: AuthAccount): FortressSide {
    const side = fortressSideForAccount(session, user.accountId);
    if (side) {
      return side;
    }
    if (user.permission === 'superadmin') {
      return session.currentTurn;
    }
    throw new ForbiddenException('not a participant');
  }

  private crazyArcadeSideForUser(session: CrazyArcadeSession, user: AuthAccount): CrazyArcadeSide {
    if (this.canActAs(user, session.players.challenger)) {
      return 'challenger';
    }
    if (this.canActAs(user, session.players.opponent)) {
      return 'opponent';
    }
    if (user.permission === 'superadmin') {
      return 'challenger';
    }
    throw new ForbiddenException('not a participant');
  }

  private sokobanSideForUser(session: SokobanSession, user: AuthAccount): SokobanSide | undefined {
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

  private async sendSessionEmote(
    gameKey: 'sudoku' | 'gomoku' | 'alkkagi' | 'othello' | 'sokoban' | 'splendor' | 'fortress' | 'crazy_arcade',
    session: SudokuSession | GomokuSession | AlkkagiSession | OthelloSession | SokobanSession | SplendorSession | FortressSession | CrazyArcadeSession,
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
    const move = chooseGomokuAiMove(session, session.aiDifficulty ?? 'medium', Date.now() + GOMOKU_AI_BUDGET_MS);
    if (!move) {
      session.status = 'finished';
      session.finishReason = 'draw';
      session.updatedAt = new Date().toISOString();
      return;
    }
    this.applyGomokuMove(session, LOCAL_AI_ACCOUNT_ID, move.row, move.col, 'ai');
  }

  private scheduleSplendorAi(session: SplendorSession): void {
    if (session.mode !== 'local_ai' || session.status !== 'playing' || session.currentTurn !== 'opponent') {
      return;
    }
    setTimeout(async () => {
      try {
        const current = this.splendorFromRow(await this.requireGameRow(session.id, 'splendor'));
        if (current.status !== 'playing' || current.mode !== 'local_ai' || current.currentTurn !== 'opponent') {
          return;
        }
        applySplendorAiTurn(current);
        const saved = await this.saveSplendorSession(current);
        this.emitSessionEvent(
          saved,
          saved.status === 'finished' ? 'game.session.finished' : 'splendor.action.played',
          splendorClientSession(saved),
        );
      } catch (error) {
        console.warn('[splendor-ai]', error);
      }
    }, LOCAL_AI_RESPONSE_DELAY_MS);
  }

  private scheduleFortressAi(session: FortressSession): void {
    if (session.mode !== 'local_ai' || session.status !== 'playing' || session.currentTurn !== 'opponent') {
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const current = this.fortressFromRow(await this.requireGameRow(session.id, 'fortress'));
        if (current.status !== 'playing' || current.mode !== 'local_ai' || current.currentTurn !== 'opponent') {
          return;
        }
        const result = applyFortressAiTurn(current);
        if (result?.session.status === 'playing') {
          this.startFortressTimedTurn(result.session, FORTRESS_SHOT_ANIMATION_MS);
        }
        const saved = await this.saveFortressSession(current);
        this.scheduleFortressTurnTimer(saved);
        if (result) {
          this.emitSessionEvent(saved, 'fortress.shot.played', {
            ...result,
            session: fortressClientSession(saved),
          });
        if (saved.status === 'finished') {
          this.emitSessionEvent(saved, 'game.session.finished', fortressClientSession(saved));
        }
      } else {
        this.emitSessionEvent(
          saved,
          saved.status === 'finished' ? 'game.session.finished' : 'fortress.state.changed',
          fortressClientSession(saved),
        );
      }
      } catch (error) {
        console.warn('[fortress-ai]', error);
      }
    }, FORTRESS_AI_RESPONSE_DELAY_MS);
    timer.unref?.();
  }

  private startFortressTimedTurn(session: FortressSession, delayMs = 0): void {
    if (!['friend_match', 'local_ai'].includes(session.mode ?? '') || session.status !== 'playing' || session.pause?.active) {
      return;
    }
    const now = Date.now();
    session.turnStartedAt = new Date(now + delayMs).toISOString();
    session.turnDeadlineAt = new Date(now + delayMs + FORTRESS_TURN_LIMIT_MS).toISOString();
  }

  private scheduleFortressTurnTimer(session: FortressSession): void {
    this.clearTurnTimer(session.id);
    if (!['friend_match', 'local_ai'].includes(session.mode ?? '') || session.status !== 'playing' || session.pause?.active) {
      return;
    }
    if (!session.turnDeadlineAt) {
      this.startFortressTimedTurn(session);
    }
    const deadline = session.turnDeadlineAt;
    if (!deadline) {
      return;
    }
    const delay = Math.max(100, Date.parse(deadline) - Date.now());
    const timer = setTimeout(() => {
      void this.handleFortressTimer(session.id).catch((error) => {
        // Timer failures should not crash the API process.
        console.error(error);
      });
    }, delay);
    timer.unref?.();
    this.turnTimers.set(session.id, timer);
  }

  private async handleFortressTimer(id: string): Promise<void> {
    const row = await this.requireGameRow(id, 'fortress');
    if (!['friend_match', 'local_ai'].includes(row.mode) || row.status !== 'playing') {
      this.clearTurnTimer(id);
      return;
    }
    const session = this.fortressFromRow(row);
    if (session.pause?.active) {
      this.clearTurnTimer(id);
      return;
    }
    if (session.turnDeadlineAt && Date.parse(session.turnDeadlineAt) > Date.now() + 50) {
      this.scheduleFortressTurnTimer(session);
      return;
    }
    const side = session.currentTurn;
    const accountId = session.players[side];
    const angle = 24 + Math.random() * 48;
    const power = 24 + Math.random() * 50;
    const result = applyFortressShot(session, side, accountId, angle, power, 'timeout');
    if (result.session.status === 'playing') {
      this.startFortressTimedTurn(result.session, FORTRESS_SHOT_ANIMATION_MS);
    }
    const saved = await this.saveFortressSession(result.session);
    this.scheduleFortressTurnTimer(saved);
    this.emitSessionEvent(saved, 'fortress.shot.played', {
      ...result,
      session: fortressClientSession(saved),
    });
    if (saved.status === 'finished') {
      this.emitSessionEvent(saved, 'game.session.finished', fortressClientSession(saved));
    }
    this.scheduleFortressAi(saved);
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
    const move = chooseGomokuAiMove(session, session.aiDifficulty ?? 'medium', deadline) ?? randomGomokuMove(session.board);
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

  private scheduleLocalOthelloAiTurn(id: string): void {
    setTimeout(() => {
      void this.runLocalOthelloAiTurn(id).catch((error) => {
        // Local AI failures should not crash the API process.
        console.error(error);
      });
    }, LOCAL_AI_RESPONSE_DELAY_MS);
  }

  private async runLocalOthelloAiTurn(id: string): Promise<void> {
    const session = this.othelloFromRow(await this.requireGameRow(id, 'othello'));
    if (session.mode !== 'local_ai' || session.status !== 'playing' || !isLocalAiAccount(session.players[session.currentTurn])) {
      return;
    }
    const move = chooseOthelloAiMove(session);
    if (!move) {
      const next = oppositeOthello(session.currentTurn);
      if (othelloLegalMoves(session.board, next).length === 0) {
        finishOthello(session);
      } else {
        session.currentTurn = next;
      }
    } else {
      applyOthelloMove(session, LOCAL_AI_ACCOUNT_ID, move.row, move.col, 'ai');
    }
    const saved = this.othelloFromRow(await this.updateGame(session.id, session.status, session.currentTurn, session.winner ?? null, session));
    this.emitSessionEvent(saved, 'othello.move.played', saved);
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
    const shot = chooseAlkkagiAiShot(session, session.aiDifficulty ?? 'medium', deadline) ?? randomAlkkagiShot(session);
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
         AND game_key IN ('gomoku', 'alkkagi', 'fortress')`,
    );
    for (const row of result.rows) {
      if (row.game_key === 'gomoku') {
        this.scheduleTurnTimer(this.gomokuFromRow(row), 'gomoku');
      } else if (row.game_key === 'alkkagi') {
        this.scheduleTurnTimer(this.alkkagiFromRow(row), 'alkkagi');
      } else if (row.game_key === 'fortress') {
        this.scheduleFortressTurnTimer(this.fortressFromRow(row));
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

  private emitSessionEvent(
    session: SudokuSession | GomokuSession | AlkkagiSession | OthelloSession | SokobanSession | SplendorSession | FortressSession | CrazyArcadeSession,
    event: string,
    payload: unknown,
  ): void {
    this.realtime.emitToAccounts(sessionAccountIds(session), event, payload);
  }

  private emitSudokuEvent(session: SudokuSession, event: string): void {
    for (const accountId of sessionAccountIds(session)) {
      this.realtime.emitToAccounts([accountId], event, hideSudokuSolutionForAccount(session, accountId));
    }
  }

  private emitSokobanEvent(session: SokobanSession, event: string): void {
    for (const accountId of sessionAccountIds(session)) {
      this.realtime.emitToAccounts([accountId], event, sessionForSokobanAccount(session, accountId));
    }
  }
}

export class GameStateConflictError extends ConflictException {
  constructor() {
    super({ statusCode: 409, code: 'STATE_CONFLICT', message: 'Game state changed. Refresh and retry.', error: 'Conflict' });
  }
}

function playingStatusFromSnapshot(value: unknown): 'playing' | 'finished' {
  return value === 'finished' ? 'finished' : 'playing';
}

function difficultyFromSnapshot(value: unknown, fallback: Difficulty): Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : fallback;
}

function stringFromSnapshot(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function nonNegativeIntFromSnapshot(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function playerColorFromSnapshot(value: unknown, fallback: PlayerColor): PlayerColor {
  return value === 'black' || value === 'white' ? value : fallback;
}

function optionalPlayerColor(value: unknown): PlayerColor | undefined {
  return value === 'black' || value === 'white' ? value : undefined;
}

function pieceTeamFromSnapshot(value: unknown, fallback: PieceTeam): PieceTeam {
  return value === 'red' || value === 'blue' ? value : fallback;
}

function optionalPieceTeam(value: unknown): PieceTeam | undefined {
  return value === 'red' || value === 'blue' ? value : undefined;
}

function othelloColorFromSnapshot(value: unknown, fallback: OthelloColor): OthelloColor {
  return value === 'black' || value === 'white' ? value : fallback;
}

function optionalOthelloColor(value: unknown): OthelloColor | undefined {
  return value === 'black' || value === 'white' ? value : undefined;
}

function splendorSideFromSnapshot(value: unknown, fallback: SplendorSide): SplendorSide {
  return value === 'challenger' || value === 'opponent' ? value : fallback;
}

function optionalSplendorSide(value: unknown): SplendorSide | undefined {
  return value === 'challenger' || value === 'opponent' ? value : undefined;
}

function optionalCrazyArcadeSide(value: unknown): CrazyArcadeSide | undefined {
  return value === 'challenger' || value === 'opponent' ? value : undefined;
}

function sessionForCrazyArcadeUser(session: CrazyArcadeSession, user: AuthAccount): CrazyArcadeSession {
  return {
    ...session,
    mySide: session.players.challenger === user.accountId
      ? 'challenger'
      : session.players.opponent === user.accountId
        ? 'opponent'
        : user.permission === 'superadmin'
          ? 'challenger'
          : undefined,
  };
}

function gomokuBoardSnapshot(value: unknown): (PlayerColor | null)[][] {
  return boardSnapshot(value, GOMOKU_SIZE, playerColorFromCell, 'gomoku board');
}

function othelloBoardSnapshot(value: unknown): (OthelloColor | null)[][] {
  return boardSnapshot(value, OTHELLO_SIZE, playerColorFromCell, 'othello board');
}

function boardSnapshot<T extends string>(
  value: unknown,
  size: number,
  cellMapper: (value: unknown) => T | null,
  label: string,
): (T | null)[][] {
  if (!Array.isArray(value) || value.length !== size) {
    throw new BadRequestException(`invalid ${label}`);
  }
  return value.map((row) => {
    if (!Array.isArray(row) || row.length !== size) {
      throw new BadRequestException(`invalid ${label}`);
    }
    return row.map(cellMapper);
  });
}

function playerColorFromCell(value: unknown): PlayerColor | null {
  if (value === 'black' || value === 'white') {
    return value;
  }
  if (value === null) {
    return null;
  }
  throw new BadRequestException('invalid board cell');
}

function gomokuMovesFromSnapshot(
  board: (PlayerColor | null)[][],
  players: Record<PlayerColor, string>,
  lastMoveValue: unknown,
): GomokuSession['moves'] {
  const now = new Date().toISOString();
  const lastMove = isRecord(lastMoveValue)
    ? {
        row: typeof lastMoveValue.row === 'number' ? lastMoveValue.row : -1,
        col: typeof lastMoveValue.col === 'number' ? lastMoveValue.col : -1,
      }
    : null;
  const moves: GomokuSession['moves'] = [];
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      const color = board[row][col];
      if (!color) {
        continue;
      }
      if (lastMove && lastMove.row === row && lastMove.col === col) {
        continue;
      }
      moves.push({ row, col, color, accountId: players[color], createdAt: now, source: 'manual' });
    }
  }
  if (
    lastMove &&
    lastMove.row >= 0 &&
    lastMove.row < board.length &&
    lastMove.col >= 0 &&
    lastMove.col < board[lastMove.row].length
  ) {
    const color = board[lastMove.row][lastMove.col];
    if (color) {
      moves.push({ row: lastMove.row, col: lastMove.col, color, accountId: players[color], createdAt: now, source: 'manual' });
    }
  }
  return moves;
}

function alkkagiPiecesFromSnapshot(value: unknown): AlkkagiPiece[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('invalid alkkagi pieces');
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new BadRequestException('invalid alkkagi piece');
    }
    const id = stringFromSnapshot(item.id, '');
    if (!id) {
      throw new BadRequestException('invalid alkkagi piece id');
    }
    return {
      id,
      team: pieceTeamFromSnapshot(item.team, 'red'),
      rank: typeof item.rank === 'string' ? item.rank : undefined,
      x: finiteNumber(item.x, 0),
      y: finiteNumber(item.y, 0),
      vx: finiteNumber(item.vx, 0),
      vy: finiteNumber(item.vy, 0),
      radius: typeof item.radius === 'number' ? item.radius : undefined,
      mass: typeof item.mass === 'number' ? item.mass : undefined,
      active: item.active !== false,
    };
  });
}

function alkkagiShotsFromSnapshot(value: unknown, players: Record<PieceTeam, string>): AlkkagiSession['shots'] {
  const count = Math.min(nonNegativeIntFromSnapshot(value), 500);
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, index) => {
    const team: PieceTeam = index % 2 === 0 ? 'red' : 'blue';
    return { pieceId: `restored-${index}`, team, vx: 0, vy: 0, accountId: players[team], createdAt: now, source: 'manual' };
  });
}

function sokobanPositionFromSnapshot(value: unknown): SokobanPosition {
  if (!isRecord(value)) {
    throw new BadRequestException('invalid sokoban position');
  }
  return {
    row: finiteInteger(value.row, 0),
    col: finiteInteger(value.col, 0),
  };
}

function sokobanPositionsFromSnapshot(value: unknown): SokobanPosition[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('invalid sokoban positions');
  }
  return value.map(sokobanPositionFromSnapshot);
}

function splendorTokenMapFromSnapshot(value: unknown, fallback: Record<SplendorToken, number>): Record<SplendorToken, number> {
  const source = isRecord(value) ? value : fallback;
  return {
    white: nonNegativeIntFromSnapshot(source.white),
    blue: nonNegativeIntFromSnapshot(source.blue),
    green: nonNegativeIntFromSnapshot(source.green),
    red: nonNegativeIntFromSnapshot(source.red),
    black: nonNegativeIntFromSnapshot(source.black),
    gold: nonNegativeIntFromSnapshot(source.gold),
  };
}

function splendorGemCostFromSnapshot(value: unknown): Record<'white' | 'blue' | 'green' | 'red' | 'black', number> {
  const source = isRecord(value) ? value : {};
  return {
    white: nonNegativeIntFromSnapshot(source.white),
    blue: nonNegativeIntFromSnapshot(source.blue),
    green: nonNegativeIntFromSnapshot(source.green),
    red: nonNegativeIntFromSnapshot(source.red),
    black: nonNegativeIntFromSnapshot(source.black),
  };
}

function splendorCardFromSnapshot(value: unknown): SplendorCard | null {
  if (!isRecord(value)) {
    return null;
  }
  const tier = value.tier === '1' || value.tier === '2' || value.tier === '3' ? value.tier : null;
  const color = value.color === 'white' || value.color === 'blue' || value.color === 'green' || value.color === 'red' || value.color === 'black'
    ? value.color
    : null;
  if (typeof value.id !== 'string' || !tier || !color) {
    return null;
  }
  return {
    id: value.id,
    tier,
    color,
    points: nonNegativeIntFromSnapshot(value.points),
    cost: splendorGemCostFromSnapshot(value.cost),
    art: typeof value.art === 'string' ? value.art : 'card',
  };
}

function splendorCardsFromSnapshot(value: unknown): SplendorCard[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(splendorCardFromSnapshot).filter((item): item is SplendorCard => item !== null);
}

function splendorNobleFromSnapshot(value: unknown): SplendorNoble | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  return {
    id: value.id,
    points: nonNegativeIntFromSnapshot(value.points),
    cost: splendorGemCostFromSnapshot(value.cost),
    art: typeof value.art === 'string' ? value.art : 'noble',
  };
}

function splendorNoblesFromSnapshot(value: unknown, fallback: SplendorNoble[]): SplendorNoble[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.map(splendorNobleFromSnapshot).filter((item): item is SplendorNoble => item !== null);
}

function splendorMarketFromSnapshot(
  value: unknown,
  fallback: Record<'1' | '2' | '3', SplendorCard[]>,
): Record<'1' | '2' | '3', SplendorCard[]> {
  const source = isRecord(value) ? value : {};
  const tier1 = splendorCardsFromSnapshot(source['1']);
  const tier2 = splendorCardsFromSnapshot(source['2']);
  const tier3 = splendorCardsFromSnapshot(source['3']);
  return {
    '1': tier1.length > 0 ? tier1 : fallback['1'],
    '2': tier2.length > 0 ? tier2 : fallback['2'],
    '3': tier3.length > 0 ? tier3 : fallback['3'],
  };
}

function splendorPlayerStateFromSnapshot(value: unknown, fallback: SplendorPlayerState): SplendorPlayerState {
  const source = isRecord(value) ? value : {};
  return {
    tokens: splendorTokenMapFromSnapshot(source.tokens, fallback.tokens),
    bonuses: splendorGemCostFromSnapshot(source.bonuses),
    reserved: splendorCardsFromSnapshot(source.reserved),
    purchased: splendorCardsFromSnapshot(source.purchased),
    nobles: splendorNoblesFromSnapshot(source.nobles, fallback.nobles),
    score: nonNegativeIntFromSnapshot(source.score),
  };
}

function splendorPlayerStatesFromSnapshot(
  value: unknown,
  fallback: Record<SplendorSide, SplendorPlayerState>,
): Record<SplendorSide, SplendorPlayerState> {
  const source = isRecord(value) ? value : {};
  return {
    challenger: splendorPlayerStateFromSnapshot(source.challenger, fallback.challenger),
    opponent: splendorPlayerStateFromSnapshot(source.opponent, fallback.opponent),
  };
}

function splendorDecksFromVisibleCards(
  market: Record<'1' | '2' | '3', SplendorCard[]>,
  playerStates: Record<SplendorSide, SplendorPlayerState>,
): Record<'1' | '2' | '3', SplendorCard[]> {
  const usedCardIds = new Set<string>();
  for (const tier of SPLENDOR_TIERS) {
    for (const cardItem of market[tier]) {
      usedCardIds.add(cardItem.id);
    }
  }
  for (const player of Object.values(playerStates)) {
    for (const cardItem of [...player.reserved, ...player.purchased]) {
      usedCardIds.add(cardItem.id);
    }
  }
  const decks = createSplendorDecks();
  return {
    '1': decks['1'].filter((cardItem) => !usedCardIds.has(cardItem.id)),
    '2': decks['2'].filter((cardItem) => !usedCardIds.has(cardItem.id)),
    '3': decks['3'].filter((cardItem) => !usedCardIds.has(cardItem.id)),
  };
}

function splendorMovesFromSnapshot(value: unknown): SplendorSession['moves'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const action = item.action === 'take_tokens' || item.action === 'reserve' || item.action === 'buy' || item.action === 'forfeit'
      ? item.action
      : null;
    const side = optionalSplendorSide(item.side);
    if (!action || !side || typeof item.accountId !== 'string') {
      return [];
    }
    return [{
      action,
      side,
      accountId: item.accountId,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      detail: item.detail,
      source: item.source === 'ai' ? 'ai' as const : 'manual' as const,
    }];
  });
}

function fortressStatusFromSnapshot(value: unknown, fallback: FortressSession['status']): FortressSession['status'] {
  return value === 'selecting' || value === 'playing' || value === 'finished' ? value : fallback;
}

function fortressSideFromSnapshot(value: unknown, fallback: FortressSide): FortressSide {
  return value === 'challenger' || value === 'opponent' ? value : fallback;
}

function optionalFortressSide(value: unknown): FortressSide | undefined {
  return value === 'challenger' || value === 'opponent' ? value : undefined;
}

function numberArrayFromSnapshot(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const next = value.map((item, index) => finiteNumber(item, fallback[index] ?? 0));
  return next.length > 0 ? next : [...fallback];
}

function fortressTanksFromSnapshot(value: unknown, current: FortressSession): FortressSession['tanks'] {
  const source = isRecord(value) ? value : {};
  return {
    challenger: fortressTankFromSnapshot(source.challenger, current.tanks.challenger),
    opponent: fortressTankFromSnapshot(source.opponent, current.tanks.opponent),
  };
}

function fortressMovementRemainingFromSnapshot(
  value: unknown,
  fallback: Record<FortressSide, number> | undefined,
): Record<FortressSide, number> {
  const source = isRecord(value) ? value : {};
  return {
    challenger: Math.max(0, finiteNumber(source.challenger, fallback?.challenger ?? 0)),
    opponent: Math.max(0, finiteNumber(source.opponent, fallback?.opponent ?? 0)),
  };
}

function fortressAimFromSnapshot(
  value: unknown,
  fallback: FortressSession['aim'],
): NonNullable<FortressSession['aim']> {
  const source = isRecord(value) ? value : {};
  return {
    challenger: fortressAimSideFromSnapshot(source.challenger, fallback?.challenger, 'challenger'),
    opponent: fortressAimSideFromSnapshot(source.opponent, fallback?.opponent, 'opponent'),
  };
}

function fortressAimSideFromSnapshot(
  value: unknown,
  fallback: NonNullable<FortressSession['aim']>[FortressSide] | undefined,
  side: FortressSide,
): NonNullable<FortressSession['aim']>[FortressSide] {
  const source = isRecord(value) ? value : {};
  return {
    angle: Math.max(-20, Math.min(85, finiteNumber(source.angle, fallback?.angle ?? 45))),
    power: Math.max(0, Math.min(100, finiteNumber(source.power, fallback?.power ?? 0))),
    charging: source.charging === true,
    facing: source.facing === -1 || source.facing === 1
      ? source.facing
      : fallback?.facing ?? (side === 'challenger' ? 1 : -1),
    lastPower: typeof source.lastPower === 'number'
      ? Math.max(0, Math.min(100, finiteNumber(source.lastPower, 0)))
      : fallback?.lastPower,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : fallback?.updatedAt,
  };
}

function fortressItemsUsedFromSnapshot(
  value: unknown,
  fallback: FortressSession['itemsUsed'],
): NonNullable<FortressSession['itemsUsed']> {
  const source = isRecord(value) ? value : {};
  return {
    challenger: fortressItemsSideFromSnapshot(source.challenger, fallback?.challenger),
    opponent: fortressItemsSideFromSnapshot(source.opponent, fallback?.opponent),
  };
}

function fortressItemsSideFromSnapshot(
  value: unknown,
  fallback: NonNullable<FortressSession['itemsUsed']>[FortressSide] | undefined,
): NonNullable<FortressSession['itemsUsed']>[FortressSide] {
  const source = isRecord(value) ? value : {};
  return {
    doubleShot: source.doubleShot === true || fallback?.doubleShot === true,
    airStrike: source.airStrike === true || fallback?.airStrike === true,
  };
}

function fortressFloatingPlatformsFromSnapshot(value: unknown): FortressFloatingPlatform[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }
    const x1 = finiteNumber(item.x1, 0);
    const x2 = finiteNumber(item.x2, 0);
    const y = finiteNumber(item.y, 0);
    const thickness = Math.max(8, finiteNumber(item.thickness, 22));
    if (x2 - x1 < 20 || y <= 0) {
      return [];
    }
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : `platform-${index}`,
      x1,
      x2,
      y,
      thickness,
    }];
  });
}

function fortressPositionsFromSnapshot(
  value: unknown,
  fallback: FortressSession['tanks'],
): Record<FortressSide, FortressPosition> {
  const source = isRecord(value) ? value : {};
  return {
    challenger: fortressPositionFromSnapshot(source.challenger, fallback.challenger),
    opponent: fortressPositionFromSnapshot(source.opponent, fallback.opponent),
  };
}

function fortressPositionFromSnapshot(
  value: unknown,
  fallback: FortressSession['tanks'][FortressSide],
): FortressPosition {
  const source = isRecord(value) ? value : {};
  return {
    x: finiteNumber(source.x, fallback.x),
    y: finiteNumber(source.y, fallback.y),
  };
}

function fortressTankFromSnapshot(
  value: unknown,
  fallback: FortressSession['tanks'][FortressSide],
): FortressSession['tanks'][FortressSide] {
  const source = isRecord(value) ? value : {};
  const tankKey = typeof source.tankKey === 'string' && ['balance', 'heavy', 'scout', 'bomber'].includes(source.tankKey)
    ? source.tankKey as FortressSession['tanks'][FortressSide]['tankKey']
    : fallback.tankKey;
  return {
    ...fallback,
    tankKey,
    x: finiteNumber(source.x, fallback.x),
    y: finiteNumber(source.y, fallback.y),
    hp: Math.max(0, finiteNumber(source.hp, fallback.hp)),
    alive: source.alive !== false,
  };
}

function fortressShotsFromSnapshot(value: unknown): FortressSession['shots'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const side = optionalFortressSide(item.side);
    if (!side || typeof item.accountId !== 'string') {
      return [];
    }
    const hit = item.hit === 'terrain' || item.hit === 'tank' || item.hit === 'out' ? item.hit : undefined;
    return [{
      side,
      accountId: item.accountId,
      angle: finiteNumber(item.angle, 45),
      power: finiteNumber(item.power, 55),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      source: item.source === 'ai' ? 'ai' as const : item.source === 'timeout' ? 'timeout' as const : 'manual' as const,
      tankKey: typeof item.tankKey === 'string' && ['balance', 'heavy', 'scout', 'bomber'].includes(item.tankKey)
        ? item.tankKey as FortressSession['shots'][number]['tankKey']
        : undefined,
      item: item.item === 'doubleShot' || item.item === 'airStrike'
        ? item.item as FortressSession['shots'][number]['item']
        : undefined,
      hit,
      damage: typeof item.damage === 'number' ? item.damage : undefined,
    }];
  });
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
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

function generatedSokobanMapFromRow(row: SokobanMapRow): GeneratedSokobanMap {
  const value = row.map_json;
  if (!value || typeof value !== 'object') {
    throw new Error(`stored sokoban map is invalid: ${row.map_key}`);
  }
  const map = value as GeneratedSokobanMap;
  return {
    key: map.key || row.map_key,
    walls: Array.isArray(map.walls) ? map.walls : [],
    goals: Array.isArray(map.goals) ? map.goals : [],
    player: map.player,
    boxes: Array.isArray(map.boxes) ? map.boxes : [],
    metrics: map.metrics ?? {
      pushes: Number((row.metrics_json as Record<string, unknown> | undefined)?.pushes ?? 0),
      boxLines: Number((row.metrics_json as Record<string, unknown> | undefined)?.boxLines ?? 0),
      boxChanges: Number((row.metrics_json as Record<string, unknown> | undefined)?.boxChanges ?? 0),
    },
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

function sessionAccountIds(session: SudokuSession | GomokuSession | AlkkagiSession | OthelloSession | SokobanSession | SplendorSession | FortressSession | CrazyArcadeSession): string[] {
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

function shiftDeadline(
  session: SudokuSession | GomokuSession | AlkkagiSession | OthelloSession | SokobanSession | SplendorSession | FortressSession | CrazyArcadeSession,
  key: 'turnStartedAt' | 'turnDeadlineAt' | 'networkGraceStartedAt' | 'networkGraceDeadlineAt',
  deltaMs: number,
): void {
  const target = session as unknown as Record<string, string | undefined>;
  const value = target[key];
  if (!value || deltaMs <= 0) return;
  target[key] = new Date(Date.parse(value) + deltaMs).toISOString();
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

function validateOthelloIndex(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= OTHELLO_SIZE) {
    throw new BadRequestException(`${name} must be an integer from 0 to ${OTHELLO_SIZE - 1}`);
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

function initialOthelloBoard(): (OthelloColor | null)[][] {
  const board: (OthelloColor | null)[][] = Array.from({ length: OTHELLO_SIZE }, () =>
    Array.from({ length: OTHELLO_SIZE }, () => null as OthelloColor | null),
  );
  board[3][3] = 'white';
  board[3][4] = 'black';
  board[4][3] = 'black';
  board[4][4] = 'white';
  return board;
}

function oppositeOthello(color: OthelloColor): OthelloColor {
  return color === 'black' ? 'white' : 'black';
}

function othelloFlips(board: (OthelloColor | null)[][], row: number, col: number, color: OthelloColor): Array<[number, number]> {
  if (board[row]?.[col] !== null) {
    return [];
  }
  const enemy = oppositeOthello(color);
  const flips: Array<[number, number]> = [];
  for (const [dr, dc] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
    const line: Array<[number, number]> = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < OTHELLO_SIZE && c >= 0 && c < OTHELLO_SIZE && board[r][c] === enemy) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }
    if (line.length > 0 && r >= 0 && r < OTHELLO_SIZE && c >= 0 && c < OTHELLO_SIZE && board[r][c] === color) {
      flips.push(...line);
    }
  }
  return flips;
}

function othelloLegalMoves(board: (OthelloColor | null)[][], color: OthelloColor): Array<{ row: number; col: number; flips: number }> {
  const moves: Array<{ row: number; col: number; flips: number }> = [];
  for (let row = 0; row < OTHELLO_SIZE; row += 1) {
    for (let col = 0; col < OTHELLO_SIZE; col += 1) {
      const flips = othelloFlips(board, row, col, color).length;
      if (flips > 0) {
        moves.push({ row, col, flips });
      }
    }
  }
  return moves;
}

function applyOthelloMove(session: OthelloSession, accountId: string, row: number, col: number, source: 'manual' | 'ai'): void {
  const color = session.currentTurn;
  const flips = othelloFlips(session.board, row, col, color);
  if (flips.length === 0) {
    throw new BadRequestException('not a legal othello move');
  }
  session.board[row][col] = color;
  for (const [r, c] of flips) {
    session.board[r][c] = color;
  }
  session.moves.push({ row, col, color, accountId, flipped: flips.length, createdAt: new Date().toISOString(), source });
  const next = oppositeOthello(color);
  if (othelloLegalMoves(session.board, next).length > 0) {
    session.currentTurn = next;
  } else if (othelloLegalMoves(session.board, color).length > 0) {
    session.currentTurn = color;
  } else {
    finishOthello(session);
  }
  session.updatedAt = new Date().toISOString();
}

function finishOthello(session: OthelloSession): void {
  const score = othelloScore(session.board);
  session.status = 'finished';
  session.finishReason = score.black === score.white ? 'draw' : 'board_complete';
  if (score.black !== score.white) {
    session.winner = score.black > score.white ? 'black' : 'white';
  }
}

function othelloScore(board: (OthelloColor | null)[][]): Record<OthelloColor, number> {
  let black = 0;
  let white = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === 'black') black += 1;
      if (cell === 'white') white += 1;
    }
  }
  return { black, white };
}

function chooseOthelloAiMove(session: OthelloSession): { row: number; col: number } | undefined {
  const moves = othelloLegalMoves(session.board, session.currentTurn);
  if (moves.length === 0) {
    return undefined;
  }
  const difficulty = session.aiDifficulty ?? 'medium';
  if (difficulty === 'easy') {
    return moves[Math.floor(Math.random() * moves.length)];
  }
  const scored = moves.map((move) => {
    const corner = (move.row === 0 || move.row === 7) && (move.col === 0 || move.col === 7) ? 20 : 0;
    const edge = move.row === 0 || move.row === 7 || move.col === 0 || move.col === 7 ? 4 : 0;
    return { ...move, score: move.flips + corner + edge };
  }).sort((a, b) => b.score - a.score);
  if (difficulty === 'medium' && Math.random() < 0.28) {
    return scored[Math.floor(Math.random() * Math.min(scored.length, 3))];
  }
  return scored[0];
}

function createSokobanPlayerState(input: { player: SokobanPosition; boxes: SokobanPosition[] }): SokobanPlayerState {
  return {
    player: { ...input.player },
    boxes: input.boxes.map((box) => ({ ...box })),
    moves: 0,
    solved: false,
  };
}

function ensureSokobanPlayerState(session: SokobanSession, side: SokobanSide): SokobanPlayerState {
  session.states ??= {
    challenger: createSokobanPlayerState({ player: session.initialPlayer, boxes: session.initialBoxes }),
    opponent: createSokobanPlayerState({ player: session.initialPlayer, boxes: session.initialBoxes }),
  };
  return session.states[side];
}

function sessionForSokobanUser(session: SokobanSession, user: AuthAccount): SokobanSession {
  const side = session.players
    ? (user.accountId === session.players.challenger || user.permission === 'superadmin' ? 'challenger' : 'opponent')
    : undefined;
  if (!side) {
    return session;
  }
  return {
    ...session,
    mySide: side,
    state: ensureSokobanPlayerState(session, side),
  };
}

function sessionForSokobanAccount(session: SokobanSession, accountId: string): SokobanSession {
  const side = session.players
    ? (accountId === session.players.challenger ? 'challenger' : 'opponent')
    : undefined;
  if (!side) {
    return session;
  }
  return {
    ...session,
    mySide: side,
    state: ensureSokobanPlayerState(session, side),
  };
}

function applySokobanMove(
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

function isSokobanBoxTouchingWall(session: SokobanSession, box: SokobanPosition): boolean {
  return SOKOBAN_DELTAS.some((delta) => hasPosition(session.walls, { row: box.row + delta.row, col: box.col + delta.col }));
}

function isSokobanStateSolvable(session: SokobanSession, state: SokobanPlayerState): boolean {
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

function samePosition(left: SokobanPosition, right: SokobanPosition): boolean {
  return left.row === right.row && left.col === right.col;
}

function hasPosition(items: SokobanPosition[], target: SokobanPosition): boolean {
  return items.some((item) => samePosition(item, target));
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

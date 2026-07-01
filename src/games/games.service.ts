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
  PieceTeam,
  PlayerColor,
  SudokuSession,
} from './games.types';

const GOMOKU_SIZE = 15;
const ALKKAGI_BOARD_SIZE = 1000;
const MATCH_READY_DELAY_MS = 4_000;
const GOMOKU_TURN_LIMIT_MS = 15_000;
const ALKKAGI_TURN_LIMIT_MS = 10_000;
const DISCONNECT_GRACE_MS = 10_000;
const EMOTE_COOLDOWN_MS = 3_000;
const EMOTE_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'black', 'white']);
const ALKKAGI_HINGES = [
  { x: 310, y: 500, radius: 30 },
  { x: 690, y: 500, radius: 30 },
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
      { key: 'sudoku', title: 'Sudoku', modes: ['solo'], status: 'playable' },
      { key: 'gomoku', title: 'Gomoku', modes: ['local_two_player', 'friend_match'], status: 'playable' },
      { key: 'alkkagi', title: 'Alkkagi', modes: ['local_two_player', 'friend_match'], status: 'playable' },
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

  async createSudokuSession(user: AuthAccount, difficulty: Difficulty): Promise<Omit<SudokuSession, 'solution'>> {
    this.assertDifficulty(difficulty);
    const { puzzle, solution } = createSudoku(difficulty);
    const state: SudokuSession = {
      id: '',
      ownerAccountId: user.accountId,
      difficulty,
      puzzle,
      board: puzzle.map((row) => [...row]),
      solution,
      status: 'playing',
      createdAt: '',
      updatedAt: '',
    };
    const row = await this.insertGame('sudoku', 'solo', user.accountId, null, state.status, null, null, state);
    const session = this.sudokuFromRow(row);
    this.realtime.emitToAccounts([user.accountId], 'game.session.created', hideSudokuSolution(session));
    return hideSudokuSolution(session);
  }

  async getSudokuSession(id: string, user: AuthAccount): Promise<Omit<SudokuSession, 'solution'>> {
    const session = this.sudokuFromRow(await this.requireGameRow(id, 'sudoku'));
    this.assertParticipant(user, session.ownerAccountId);
    return hideSudokuSolution(session);
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
    this.assertParticipant(user, current.ownerAccountId);
    if (current.puzzle[row][col] !== 0) {
      throw new BadRequestException('given cells cannot be changed');
    }
    current.board[row][col] = value;
    current.updatedAt = new Date().toISOString();
    const saved = this.sudokuFromRow(await this.updateGame(id, current.status, null, null, current));
    this.realtime.emitToAccounts([current.ownerAccountId], 'sudoku.cell.updated', hideSudokuSolution(saved));
    return hideSudokuSolution(saved);
  }

  async submitSudoku(
    id: string,
    user: AuthAccount,
    board?: number[][],
  ): Promise<{ solved: boolean; session: Omit<SudokuSession, 'solution'> }> {
    const current = this.sudokuFromRow(await this.requireGameRow(id, 'sudoku'));
    this.assertParticipant(user, current.ownerAccountId);
    if (board !== undefined) {
      validateSudokuBoard(board);
      current.board = board;
    }
    const solved = isSolvedSudoku(current.board, current.solution);
    current.status = solved ? 'cleared' : 'failed';
    current.updatedAt = new Date().toISOString();
    if (solved) {
      current.clearedAt = current.updatedAt;
    }
    const saved = this.sudokuFromRow(await this.updateGame(id, current.status, null, solved ? 'cleared' : null, current));
    this.realtime.emitToAccounts([current.ownerAccountId], 'sudoku.submitted', hideSudokuSolution(saved));
    return { solved, session: hideSudokuSolution(saved) };
  }

  async createGomokuSession(
    user: AuthAccount,
    opponentAccountId?: string,
    mode?: 'local_two_player' | 'friend_match',
  ): Promise<GomokuSession> {
    const resolvedMode = opponentAccountId ? 'friend_match' : mode ?? 'local_two_player';
    const state: GomokuSession = {
      id: '',
      mode: resolvedMode,
      board: Array.from({ length: GOMOKU_SIZE }, () => Array.from({ length: GOMOKU_SIZE }, () => null)),
      currentTurn: 'black',
      status: 'playing',
      players: {
        black: user.accountId,
        white: opponentAccountId || user.accountId,
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
    const color = session.currentTurn;
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
    mode?: 'local_two_player' | 'friend_match',
  ): Promise<AlkkagiSession> {
    const resolvedMode = opponentAccountId ? 'friend_match' : mode ?? 'local_two_player';
    const state: AlkkagiSession = {
      id: '',
      mode: resolvedMode,
      currentTurn: 'red',
      status: 'playing',
      players: {
        red: user.accountId,
        blue: opponentAccountId || user.accountId,
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
    const team = session.currentTurn;
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
    const team = session.currentTurn;
    if (!this.canActAs(user, session.players[team])) {
      throw new ForbiddenException('not your turn');
    }
    const piece = session.pieces.find((item) => item.id === input.pieceId && item.active);
    if (!piece || piece.team !== team) {
      throw new BadRequestException('piece does not belong to current turn');
    }
    const phase = input.phase === 'end' ? 'end' : input.phase === 'start' ? 'start' : 'update';
    if (phase === 'end') {
      delete session.lastAim;
    } else {
      session.lastAim = {
        accountId: user.accountId,
        pieceId: input.pieceId,
        startX: clamp(input.startX, 0, ALKKAGI_BOARD_SIZE),
        startY: clamp(input.startY, 0, ALKKAGI_BOARD_SIZE),
        currentX: clamp(input.currentX, 0, ALKKAGI_BOARD_SIZE),
        currentY: clamp(input.currentY, 0, ALKKAGI_BOARD_SIZE),
        updatedAt: new Date().toISOString(),
      };
    }
    await this.updateGame(id, session.status, session.currentTurn, session.winner ?? null, session);
    this.emitSessionEvent(session, 'alkkagi.drag.updated', {
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
    });
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

  async createSessionFromMatch(gameKey: string, requesterAccountId: string, opponentAccountId: string): Promise<string> {
    const fakeUser: AuthAccount = {
      accountId: requesterAccountId,
      subject: requesterAccountId,
      serviceKey: 'game-platform',
      permission: 'player',
      claims: {},
    };
    if (gameKey === 'gomoku') {
      return (await this.createGomokuSession(fakeUser, opponentAccountId, 'friend_match')).id;
    }
    if (gameKey === 'alkkagi') {
      return (await this.createAlkkagiSession(fakeUser, opponentAccountId, 'friend_match')).id;
    }
    throw new BadRequestException('match requests support gomoku or alkkagi');
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

  private canActAs(user: AuthAccount, accountId: string): boolean {
    return user.accountId === accountId || user.permission === 'superadmin';
  }

  private async sendSessionEmote(
    gameKey: 'gomoku' | 'alkkagi',
    session: GomokuSession | AlkkagiSession,
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
    source: 'manual' | 'timeout',
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

  private applyAlkkagiShot(
    session: AlkkagiSession,
    accountId: string,
    pieceId: string,
    vx: number,
    vy: number,
    source: 'manual' | 'timeout',
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

  private startTimedTurn(session: GomokuSession | AlkkagiSession, gameKey: 'gomoku' | 'alkkagi', delayMs = 0): void {
    if (session.mode !== 'friend_match' || session.status !== 'playing') {
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

  private emitSessionEvent(session: GomokuSession | AlkkagiSession, event: string, payload: unknown): void {
    this.realtime.emitToAccounts([...new Set(Object.values(session.players))], event, payload);
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

function hideSudokuSolution(session: SudokuSession): Omit<SudokuSession, 'solution'> {
  const { solution: _solution, ...visible } = session;
  return visible;
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

function simulateAlkkagi(pieces: AlkkagiPiece[]): { frameMs: number; frames: AlkkagiPiece[][] } {
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
    resolveHingeCollisions(activePieces);
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
      const dx = item.x - hinge.x;
      const dy = item.y - hinge.y;
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

import { randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, ConflictException, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { intEnv } from '../config/env';
import { AuthAccount } from '../auth/auth.types';
import { emoteGridSizeFor, hasPlayerAccess } from '../auth/roles';
import { RealtimeService } from '../realtime/realtime.service';
import { createSudoku } from './sudoku-generator';
import { createSokobanMap, createVerifiedSokobanMap, GeneratedSokobanMap } from './sokoban-generator';
import {
  applySplendorAiTurn,
  applySplendorForfeit,
  createSplendorDecks,
  createSplendorState,
  createSplendorStateForPlayers,
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
  SudokuSession,
  SudokuSide,
  SokobanPlayerState,
  SokobanPosition,
  SokobanSession,
  SokobanSide,
  ActiveGameSessionSummary,
} from './games.types';
import { GAME_REGISTRY, gameDescriptorFor } from './engine/game-registry';
import {
  applyGomokuMove as applyGomokuEngineMove,
  availableGomokuCells,
  chooseGomokuAiMove,
  GOMOKU_AI_BUDGET_MS,
  GOMOKU_SIZE,
  initialGomokuBoard,
  randomGomokuMove,
  validateGomokuIndex,
} from './gomoku-engine';
import {
  ALKKAGI_AI_BUDGET_MS,
  ALKKAGI_BOARD_SIZE,
  applyAlkkagiShotToSession,
  chooseAlkkagiAiShot,
  initialAlkkagiPieces,
  randomAlkkagiShot,
} from './alkkagi-engine';
import {
  createSokobanPlayerState,
  ensureSokobanPlayerState,
  firstOtherSokobanSide,
  hasPosition,
  isSokobanStateSolvable,
  sessionForSokobanSide,
  sokobanSideForAccount,
  sokobanSides,
} from './sokoban-engine';
import {
  cloneSudokuGrid,
  createSudokuBattleMap,
  createSudokuBattleState,
  createSudokuProgressMap,
  ensureSudokuPlayerBoard,
  hideSudokuSolutionForAccount,
  sudokuSideForAccount,
  sudokuSides,
  validateSudokuBoard,
} from './sudoku-engine';
import {
  advanceCrazyArcadeServer,
  CRAZY_ARCADE_ENGINE,
  createCrazyArcadeSnapshot,
  createCrazyArcadeSnapshotForSides,
} from './crazy-arcade-engine';
import {
  applyOthelloMove,
  chooseOthelloAiMove,
  finishOthello,
  initialOthelloBoard,
  oppositeOthello,
  OTHELLO_SIZE,
  othelloLegalMoves,
} from './othello-engine';

const MATCH_READY_DELAY_MS = 4_000;
const GOMOKU_TURN_LIMIT_MS = 15_000;
const ALKKAGI_TURN_LIMIT_MS = 10_000;
const OTHELLO_TURN_LIMIT_MS = 20_000;
const FORTRESS_TURN_LIMIT_MS = 20_000;
const LOCAL_AI_RESPONSE_DELAY_MS = 180;
const FORTRESS_AI_RESPONSE_DELAY_MS = 1_000;
const FORTRESS_SHOT_ANIMATION_MS = 2_800;
const DISCONNECT_GRACE_MS = intEnv('GAME_PLATFORM_DISCONNECT_GRACE_SECONDS', 60) * 1000;
const CRAZY_ARCADE_SERVER_TICK_MS = 120;
const EMOTE_COOLDOWN_MS = 3_000;
const MATCH_PAUSE_LIMIT = 3;
const MATCH_PAUSE_RESUME_LOCK_MS = 3_000;
const CLIENT_MOVE_HISTORY_LIMIT = 20;
const EMOTE_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'black', 'white']);
const LOCAL_AI_ACCOUNT_ID = '__game_platform_local_ai__';
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

interface GameSessionPlayerRow {
  session_id: string;
  seat: number;
  account_id: string | null;
  kind: 'account' | 'ai';
  ai_difficulty: Difficulty | null;
  status: string;
  result: string | null;
  joined_at: Date;
  left_at: Date | null;
}

interface GameSaveRow {
  id: string;
  account_id: string;
  game_key: string;
  slot: number;
  label: string;
  source_session_id: string | null;
  source_mode: GameMode;
  my_seat: number;
  players_json: unknown;
  state_json: unknown;
  state_version: number;
  created_at: Date;
  updated_at: Date;
  source_session_status?: string | null;
}

interface LocalAiResultInput {
  gameKey: string;
  sessionId: string;
  result: string;
  difficulty: Difficulty;
  reason: string;
  recordedAt: Date;
  payload: Record<string, unknown>;
}

interface GameRoomRow {
  id: string;
  room_code: string;
  game_key: string;
  host_account_id: string;
  max_players: number;
  visibility: string;
  config_json: unknown;
  status: string;
  session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface GameRoomMemberRow {
  room_id: string;
  account_id: string;
  seat: number;
  status: string;
  ready: boolean;
  joined_at: Date;
  updated_at: Date;
  account_login_id?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  account_status?: string | null;
  account_permission_key?: string | null;
}

@Injectable()
export class GamesService implements OnModuleInit, OnModuleDestroy {
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly crazyArcadeTickTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly crazyArcadeInputQueues = new Map<string, Promise<unknown>>();
  private readonly emoteCooldowns = new Map<string, number>();
  private readonly gameRegistry = GAME_REGISTRY;
  private gcTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.db.ready();
    await this.prepareSokobanMapPool();
    await this.restoreActiveTurnTimers();
    await this.restoreCrazyArcadeTicks();
    this.scheduleAbandonedSessionGc();
  }

  onModuleDestroy(): void {
    for (const timer of this.turnTimers.values()) {
      clearTimeout(timer);
    }
    this.turnTimers.clear();
    for (const timer of this.crazyArcadeTickTimers.values()) {
      clearInterval(timer);
    }
    this.crazyArcadeTickTimers.clear();
    this.crazyArcadeInputQueues.clear();
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
  }

  listGames() {
    return this.gameRegistry.list();
  }

  async createGameSession(
    gameKey: string,
    user: AuthAccount,
    input: { opponentAccountId?: string; difficulty?: Difficulty },
  ): Promise<unknown> {
    if (!this.gameRegistry.has(gameKey)) {
      throw new BadRequestException('unsupported gameKey');
    }
    const difficulty = input.difficulty ?? 'medium';
    const opponentAccountId = typeof input.opponentAccountId === 'string' && input.opponentAccountId.length > 0
      ? input.opponentAccountId
      : undefined;
    if (gameKey === 'sudoku') {
      return this.createSudokuSession(user, difficulty, opponentAccountId);
    }
    if (gameKey === 'gomoku') {
      return this.createGomokuSession(user, opponentAccountId, undefined, difficulty);
    }
    if (gameKey === 'alkkagi') {
      return this.createAlkkagiSession(user, opponentAccountId, undefined, difficulty);
    }
    if (gameKey === 'othello') {
      return this.createOthelloSession(user, opponentAccountId, undefined, difficulty);
    }
    if (gameKey === 'sokoban') {
      return this.createSokobanSession(user, difficulty, opponentAccountId);
    }
    if (gameKey === 'splendor') {
      return this.createSplendorSession(user, opponentAccountId, undefined, difficulty);
    }
    if (gameKey === 'fortress') {
      return this.createFortressSession(user, opponentAccountId, undefined, difficulty);
    }
    if (gameKey === 'crazy_arcade') {
      return this.createCrazyArcadeSession(user, opponentAccountId, undefined, difficulty);
    }
    throw new BadRequestException(`unsupported gameKey: ${gameKey}`);
  }

  async getGameSession(gameKey: string, id: string, user: AuthAccount): Promise<unknown> {
    if (!this.gameRegistry.has(gameKey)) {
      throw new BadRequestException('unsupported gameKey');
    }
    if (gameKey === 'sudoku') return this.getSudokuSession(id, user);
    if (gameKey === 'gomoku') return this.getGomokuSession(id, user);
    if (gameKey === 'alkkagi') return this.getAlkkagiSession(id, user);
    if (gameKey === 'othello') return this.getOthelloSession(id, user);
    if (gameKey === 'sokoban') return this.getSokobanSession(id, user);
    if (gameKey === 'splendor') return this.getSplendorSession(id, user);
    if (gameKey === 'fortress') return this.getFortressSession(id, user);
    if (gameKey === 'crazy_arcade') return this.getCrazyArcadeSession(id, user);
    throw new BadRequestException(`unsupported gameKey: ${gameKey}`);
  }

  async listActiveSessions(user: AuthAccount): Promise<{ sessions: ActiveGameSessionSummary[] }> {
    const result = await this.db.query<GameRow>(
      `SELECT DISTINCT gs.*
       FROM game_sessions gs
       JOIN game_session_players gsp ON gsp.session_id = gs.id
       WHERE gs.status NOT IN ('finished', 'cleared', 'failed')
         AND gsp.account_id = $1
         AND gsp.status = 'active'
       ORDER BY gs.updated_at DESC
       LIMIT 50`,
      [user.accountId],
    );
    const sessions = await Promise.all(result.rows.map(async (row) => {
      const state = row.state_json as { rev?: number; players?: Record<string, string> };
      const seats = await this.sessionSeatRows(row);
      const currentTurnAccountId = currentTurnAccountIdForRow(row, seats);
      return {
        sessionId: row.id,
        gameKey: row.game_key,
        mode: row.mode,
        status: row.status,
        rev: state.rev ?? 0,
        opponentAccountIds: seats
          .filter((seat) => seat.status === 'active' && seat.account_id && seat.account_id !== user.accountId)
          .map((seat) => seat.account_id!),
        currentTurnAccountId,
        myTurn: currentTurnAccountId ? currentTurnAccountId === user.accountId : undefined,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    }));
    return { sessions };
  }

  async applyGameAction(
    gameKey: string,
    id: string,
    user: AuthAccount,
    action: { type?: string; payload?: Record<string, unknown>; clientMoveId?: string },
  ): Promise<unknown> {
    if (!this.gameRegistry.has(gameKey)) {
      throw new BadRequestException('unsupported gameKey');
    }
    const type = typeof action.type === 'string' ? action.type : '';
    const payload = isRecord(action.payload) ? action.payload : {};
    const clientMoveId = typeof action.clientMoveId === 'string' ? action.clientMoveId : undefined;

    if (gameKey === 'sudoku') {
      if (type === 'set_cell') {
        return this.applySudokuEngineAction(id, user, {
          type: 'set_cell',
          payload: {
            row: Number(payload.row),
            col: Number(payload.col),
            value: Number(payload.value),
          },
          clientMoveId,
        });
      }
      if (type === 'submit') {
        return this.applySudokuEngineAction(id, user, {
          type: 'submit',
          payload: {
            board: Array.isArray(payload.board) ? payload.board as number[][] : undefined,
          },
          clientMoveId,
        });
      }
    }

    if (gameKey === 'gomoku' && type === 'move') {
      return this.applyGomokuEngineMove(id, user, payload, clientMoveId);
    }

    if (gameKey === 'alkkagi' && type === 'shoot') {
      return this.applyAlkkagiEngineShot(id, user, payload, clientMoveId);
    }

    if (gameKey === 'othello' && type === 'move') {
      return this.applyOthelloEngineMove(id, user, payload, clientMoveId);
    }

    if (gameKey === 'sokoban' && type === 'move') {
      return this.applySokobanEngineMove(id, user, payload, clientMoveId);
    }

    if (gameKey === 'splendor') {
      if (type === 'take_tokens') {
        return this.applySplendorEngineAction(id, user, 'take_tokens', {
          tokens: tokenPayload(payload.tokens),
          discardTokens: tokenPayload(payload.discardTokens),
        }, clientMoveId);
      }
      if (type === 'reserve_card') {
        return this.applySplendorEngineAction(id, user, 'reserve_card', {
          cardId: typeof payload.cardId === 'string' ? payload.cardId : undefined,
          tier: typeof payload.tier === 'string' ? payload.tier : undefined,
          discardTokens: tokenPayload(payload.discardTokens),
        }, clientMoveId);
      }
      if (type === 'buy_card') {
        return this.applySplendorEngineAction(id, user, 'buy_card', {
          cardId: typeof payload.cardId === 'string' ? payload.cardId : '',
        }, clientMoveId);
      }
    }

    if (gameKey === 'fortress') {
      if (type === 'select_tank') {
        return this.applyFortressEngineAction(id, user, 'select_tank', {
          tankKey: typeof payload.tankKey === 'string' ? payload.tankKey : '',
        });
      }
      if (type === 'move') {
        return this.applyFortressEngineAction(id, user, 'move', { distance: Number(payload.distance) }, clientMoveId);
      }
      if (type === 'aim') {
        return this.applyFortressEngineAction(id, user, 'aim', {
          angle: Number(payload.angle),
          power: Number(payload.power),
          charging: payload.charging === true,
        });
      }
      if (type === 'shoot') {
        const item = payload.item === 'doubleShot' || payload.item === 'airStrike'
          ? payload.item as FortressItemKey
          : undefined;
        return this.applyFortressEngineAction(id, user, 'shoot', {
          angle: Number(payload.angle),
          power: Number(payload.power),
          item,
        }, clientMoveId);
      }
    }

    if (gameKey === 'crazy_arcade' && type === 'input') {
      return this.updateCrazyArcadeInput(id, user, payload, clientMoveId);
    }

    throw new BadRequestException(`unsupported action type for ${gameKey}`);
  }

  async createRoom(
    user: AuthAccount,
    input: { gameKey?: string; maxPlayers?: number; visibility?: string; config?: Record<string, unknown> },
  ): Promise<{ room: unknown }> {
    this.assertCanUseRooms(user);
    const gameKey = input.gameKey ?? '';
    const descriptor = this.gameRegistry.get(gameKey);
    if (!descriptor) {
      throw new BadRequestException('unsupported gameKey');
    }
    const maxPlayers = Number(input.maxPlayers ?? descriptor.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < descriptor.minPlayers || maxPlayers > descriptor.maxPlayers) {
      throw new BadRequestException(`maxPlayers must be between ${descriptor.minPlayers} and ${descriptor.maxPlayers}`);
    }
    const roomCode = await this.generateRoomCode();
    const result = await this.db.query<GameRoomRow>(
      `INSERT INTO game_rooms (room_code, game_key, host_account_id, max_players, visibility, config_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [
        roomCode,
        gameKey,
        user.accountId,
        maxPlayers,
        input.visibility === 'public' ? 'public' : 'private',
        JSON.stringify(isRecord(input.config) ? input.config : {}),
      ],
    );
    await this.db.query(
      `INSERT INTO game_room_members (room_id, account_id, seat, status, ready)
       VALUES ($1, $2, 0, 'joined', true)
       ON CONFLICT (room_id, account_id) DO UPDATE SET status = 'joined', ready = true, updated_at = now()`,
      [result.rows[0].id, user.accountId],
    );
    return { room: await this.roomView(result.rows[0], user.accountId) };
  }

  async getRoom(id: string, user: AuthAccount): Promise<{ room: unknown }> {
    const room = await this.requireRoom(id);
    await this.assertRoomVisible(room, user);
    return { room: await this.roomView(room, user.accountId) };
  }

  async inviteToRoom(id: string, user: AuthAccount, input: { accountId?: string }): Promise<{ room: unknown }> {
    this.assertCanUseRooms(user);
    const room = await this.requireRoom(id);
    await this.assertRoomMember(room.id, user.accountId);
    if (room.status !== 'waiting') {
      throw new BadRequestException('room is not waiting');
    }
    const accountId = typeof input.accountId === 'string' ? input.accountId : '';
    if (!accountId || accountId === user.accountId) {
      throw new BadRequestException('accountId must be another account');
    }
    await this.assertFriends(user.accountId, accountId);
    if (!(await this.realtime.isAccountOnline(accountId))) {
      throw new BadRequestException('opponent is offline');
    }
    const members = await this.roomMembers(room.id);
    if (members.length >= room.max_players && !members.some((member) => member.account_id === accountId)) {
      throw new BadRequestException('room is full');
    }
    const seat = members.find((member) => member.account_id === accountId)?.seat ?? nextRoomSeat(members);
    await this.db.query(
      `INSERT INTO game_room_members (room_id, account_id, seat, status, ready)
       VALUES ($1, $2, $3, 'invited', false)
       ON CONFLICT (room_id, account_id) DO UPDATE SET status = 'invited', ready = false, updated_at = now()`,
      [room.id, accountId, seat],
    );
    const updated = await this.requireRoom(id);
    const view = await this.roomView(updated, user.accountId);
    this.realtime.emitToAccounts([accountId], 'room.invited', view);
    await this.emitRoomEvent(updated, 'room.member_invited', view);
    return { room: view };
  }

  async joinRoom(user: AuthAccount, input: { roomCode?: string }): Promise<{ room: unknown }> {
    this.assertCanUseRooms(user);
    const roomCode = typeof input.roomCode === 'string' ? input.roomCode.trim().toUpperCase() : '';
    const room = await this.db.one<GameRoomRow>(`SELECT * FROM game_rooms WHERE room_code = $1`, [roomCode]);
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    if (room.status !== 'waiting') {
      throw new BadRequestException('room is not waiting');
    }
    const members = await this.roomMembers(room.id);
    if (members.length >= room.max_players && !members.some((member) => member.account_id === user.accountId)) {
      throw new BadRequestException('room is full');
    }
    const seat = members.find((member) => member.account_id === user.accountId)?.seat ?? nextRoomSeat(members);
    await this.db.query(
      `INSERT INTO game_room_members (room_id, account_id, seat, status, ready)
       VALUES ($1, $2, $3, 'joined', false)
       ON CONFLICT (room_id, account_id) DO UPDATE SET status = 'joined', updated_at = now()`,
      [room.id, user.accountId, seat],
    );
    const updated = await this.requireRoom(room.id);
    const view = await this.roomView(updated, user.accountId);
    await this.emitRoomEvent(updated, 'room.member_joined', view);
    return { room: view };
  }

  async setRoomReady(id: string, user: AuthAccount, input: { ready?: boolean }): Promise<{ room: unknown }> {
    const room = await this.requireRoom(id);
    await this.assertRoomMember(room.id, user.accountId);
    if (room.status !== 'waiting') {
      throw new BadRequestException('room is not waiting');
    }
    await this.db.query(
      `UPDATE game_room_members
       SET ready = $3, status = 'joined', updated_at = now()
       WHERE room_id = $1 AND account_id = $2`,
      [room.id, user.accountId, input.ready !== false],
    );
    const view = await this.roomView(room, user.accountId);
    await this.emitRoomEvent(room, 'room.member_ready', view);
    return { room: view };
  }

  async startRoom(id: string, user: AuthAccount): Promise<{ room: unknown; sessionId: string }> {
    const room = await this.requireRoom(id);
    if (room.host_account_id !== user.accountId) {
      throw new ForbiddenException('only host can start');
    }
    if (room.status !== 'waiting') {
      throw new BadRequestException('room is not waiting');
    }
    const descriptor = this.gameRegistry.get(room.game_key);
    if (!descriptor) {
      throw new BadRequestException('unsupported gameKey');
    }
    const members = (await this.roomMembers(room.id)).filter((member) => member.status === 'joined');
    if (members.length < descriptor.minPlayers) {
      throw new BadRequestException('not enough players');
    }
    if (members.some((member) => !member.ready)) {
      throw new BadRequestException('all players must be ready');
    }
    const orderedMembers = [...members].sort((a, b) => a.seat - b.seat);
    const sessionId = await this.createSessionFromRoom(room, orderedMembers);
    const updated = await this.db.one<GameRoomRow>(
      `UPDATE game_rooms
       SET status = 'started', session_id = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [room.id, sessionId],
    );
    const view = await this.roomView(updated ?? room, user.accountId);
    await this.emitRoomEvent(updated ?? room, 'room.started', { ...view, sessionId });
    return { room: view, sessionId };
  }

  private scheduleAbandonedSessionGc(): void {
    const abandonDays = intEnv('GAME_PLATFORM_SESSION_ABANDON_DAYS', 7);
    if (abandonDays <= 0) {
      return;
    }
    void this.gcAbandonedSessions().catch((error) => console.error('[session-gc]', error));
    this.gcTimer = setInterval(() => {
      void this.gcAbandonedSessions().catch((error) => console.error('[session-gc]', error));
    }, 60 * 60 * 1000);
    this.gcTimer.unref?.();
  }

  async gcAbandonedSessions(): Promise<number> {
    const abandonDays = intEnv('GAME_PLATFORM_SESSION_ABANDON_DAYS', 7);
    const result = await this.db.query<{ id: string }>(
      `UPDATE game_sessions
       SET status = 'finished',
           state_json = state_json || jsonb_build_object('status', 'finished', 'finishReason', 'abandoned'),
           updated_at = now()
       WHERE status NOT IN ('finished', 'cleared', 'failed')
         AND updated_at < now() - make_interval(days => $1)
       RETURNING id`,
      [abandonDays],
    );
    for (const row of result.rows) {
      this.clearTurnTimer(row.id);
    }
    return result.rows.length;
  }

  async claimDisconnectedWin(gameKey: string, id: string, user: AuthAccount): Promise<unknown> {
    const { key, session } = await this.requireDisconnectClaimable(gameKey, id, user);
    const absentAccountId = session.networkGraceAccountId as string;
    if (await this.realtime.isAccountOnline(absentAccountId)) {
      // 상대가 돌아와 있으면 몰수 대신 턴을 재개한다.
      if (key === 'crazy_arcade') {
        const crazy = session as CrazyArcadeSession;
        this.clearNetworkGrace(crazy);
        const resumed = await this.saveCrazyArcadeSession(crazy);
        this.ensureCrazyArcadeTick(resumed);
        this.emitSessionEvent(resumed, 'game.opponent_returned', resumed);
      } else if (key === 'fortress') {
        const fortress = session as FortressSession;
        this.startFortressTimedTurn(fortress);
        const resumed = await this.saveFortressSession(fortress);
        this.scheduleFortressTurnTimer(resumed);
        this.emitSessionEvent(resumed, 'game.opponent_returned', fortressClientSession(resumed));
      } else if (key === 'othello') {
        const othello = session as OthelloSession;
        this.startTimedTurn(othello, 'othello');
        const resumed = this.othelloFromRow(await this.updateGame(othello.id, othello.status, othello.currentTurn, othello.winner ?? null, othello));
        this.scheduleTurnTimer(resumed, 'othello');
        this.emitSessionEvent(resumed, 'game.opponent_returned', resumed);
      } else {
        const timedSession = session as GomokuSession | AlkkagiSession;
        this.startTimedTurn(timedSession, key);
        const resumed = key === 'gomoku'
          ? this.gomokuFromRow(await this.updateGame(timedSession.id, timedSession.status, (timedSession as GomokuSession).currentTurn, timedSession.winner ?? null, timedSession))
          : this.alkkagiFromRow(await this.updateGame(timedSession.id, timedSession.status, (timedSession as AlkkagiSession).currentTurn, timedSession.winner ?? null, timedSession));
        this.scheduleTurnTimer(resumed, key);
        this.emitSessionEvent(resumed, 'game.opponent_returned', resumed);
      }
      throw new ConflictException({
        statusCode: 409,
        code: 'OPPONENT_RECONNECTED',
        message: 'Opponent reconnected. The match continues.',
        error: 'Conflict',
      });
    }
    if (key === 'gomoku') {
      const gomoku = session as GomokuSession;
      const mySide = this.participantSide(gomoku.players, user.accountId, gomoku.currentTurn);
      gomoku.status = 'finished';
      gomoku.winner = mySide;
      gomoku.finishReason = 'disconnect';
      gomoku.updatedAt = new Date().toISOString();
      this.clearTurnTimer(gomoku.id);
      const saved = this.gomokuFromRow(await this.updateGame(gomoku.id, gomoku.status, gomoku.currentTurn, gomoku.winner, gomoku));
      this.emitSessionEvent(saved, 'gomoku.move.played', saved);
      this.emitSessionEvent(saved, 'game.session.finished', saved);
      return saved;
    }
    if (key === 'othello') {
      const othello = session as OthelloSession;
      const mySide = this.participantSide(othello.players, user.accountId, othello.currentTurn);
      othello.status = 'finished';
      othello.winner = mySide;
      othello.finishReason = 'disconnect';
      othello.updatedAt = new Date().toISOString();
      this.clearNetworkGrace(othello);
      this.clearTurnTimer(othello.id);
      const saved = this.othelloFromRow(await this.updateGame(othello.id, othello.status, othello.currentTurn, othello.winner, othello));
      this.emitSessionEvent(saved, 'othello.move.played', saved);
      this.emitSessionEvent(saved, 'game.session.finished', saved);
      return saved;
    }
    if (key === 'fortress') {
      const fortress = session as FortressSession;
      const absentSide = fortressSideForAccount(fortress, absentAccountId);
      if (!absentSide) {
        throw new BadRequestException('Opponent has not left the match');
      }
      applyFortressForfeit(fortress, absentSide);
      fortress.finishReason = 'disconnect';
      this.clearNetworkGrace(fortress);
      this.clearTurnTimer(fortress.id);
      const saved = await this.saveFortressSession(fortress);
      const payload = fortressClientSession(saved, user.accountId);
      this.emitSessionEvent(saved, 'fortress.state.changed', fortressClientSession(saved));
      this.emitSessionEvent(saved, 'game.session.finished', fortressClientSession(saved));
      return payload;
    }
    if (key === 'crazy_arcade') {
      const crazy = session as CrazyArcadeSession;
      const absentSide = this.crazyArcadeSideForAccount(crazy, absentAccountId);
      if (!absentSide) {
        throw new BadRequestException('Opponent has not left the match');
      }
      const winnerSide = Object.keys(crazy.players).find((side) => side !== absentSide) as CrazyArcadeSide | undefined;
      if (!winnerSide) {
        throw new BadRequestException('No remaining player can claim this match');
      }
      crazy.status = 'finished';
      crazy.winnerSide = winnerSide;
      crazy.winnerAccountId = crazy.players[crazy.winnerSide];
      crazy.finishReason = 'disconnect';
      crazy.version += 1;
      crazy.updatedAt = new Date().toISOString();
      this.clearNetworkGrace(crazy);
      this.clearCrazyArcadeTickTimer(crazy.id);
      const saved = await this.saveCrazyArcadeSession(crazy);
      this.emitSessionEvent(saved, 'crazy_arcade.state.synced', saved);
      this.emitSessionEvent(saved, 'game.session.finished', saved);
      return sessionForCrazyArcadeUser(saved, user);
    }
    const alkkagi = session as AlkkagiSession;
    const mySide = this.participantSide(alkkagi.players, user.accountId, alkkagi.currentTurn);
    alkkagi.status = 'finished';
    alkkagi.winner = mySide;
    alkkagi.finishReason = 'disconnect';
    alkkagi.updatedAt = new Date().toISOString();
    this.clearTurnTimer(alkkagi.id);
    const saved = this.alkkagiFromRow(await this.updateGame(alkkagi.id, alkkagi.status, alkkagi.currentTurn, alkkagi.winner, alkkagi));
    this.emitSessionEvent(saved, 'alkkagi.shot.played', { session: saved, animation: { frameMs: 16, frames: [] } });
    this.emitSessionEvent(saved, 'game.session.finished', saved);
    return saved;
  }

  async waitForOpponent(gameKey: string, id: string, user: AuthAccount): Promise<unknown> {
    // D7: "계속 대기" — 세션은 열린 채 유지되고 언제든 claim-win 할 수 있다. (최후 안전망은 세션 GC)
    const { key, session } = await this.requireDisconnectClaimable(gameKey, id, user);
    if (key === 'fortress') {
      return fortressClientSession(session as FortressSession, user.accountId);
    }
    if (key === 'crazy_arcade') {
      return sessionForCrazyArcadeUser(session as CrazyArcadeSession, user);
    }
    return session;
  }

  private async requireDisconnectClaimable(
    gameKey: string,
    id: string,
    user: AuthAccount,
  ): Promise<{
    key: 'gomoku' | 'alkkagi' | 'othello' | 'fortress' | 'crazy_arcade';
    session: GomokuSession | AlkkagiSession | OthelloSession | FortressSession | CrazyArcadeSession;
  }> {
    if (gameKey !== 'gomoku' && gameKey !== 'alkkagi' && gameKey !== 'othello' && gameKey !== 'fortress' && gameKey !== 'crazy_arcade') {
      throw new BadRequestException('claim is not supported for this game yet');
    }
    const row = await this.requireGameRow(id, gameKey);
    const session = gameKey === 'gomoku'
      ? this.gomokuFromRow(row)
      : gameKey === 'alkkagi'
        ? this.alkkagiFromRow(row)
        : gameKey === 'othello'
          ? this.othelloFromRow(row)
          : gameKey === 'fortress'
            ? this.fortressFromRow(row)
            : this.crazyArcadeFromRow(row);
    if (session.mode !== 'friend_match' || session.status !== 'playing') {
      throw new BadRequestException('Session is not an active match');
    }
    if (!session.opponentLeftAt || !session.networkGraceAccountId) {
      throw new BadRequestException('Opponent has not left the match');
    }
    const participants = Object.values(session.players);
    if (!participants.includes(user.accountId) || user.accountId === session.networkGraceAccountId) {
      throw new ForbiddenException('Only the remaining player can decide');
    }
    return { key: gameKey, session };
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
    return this.applySudokuEngineAction(id, user, {
      type: 'set_cell',
      payload: { row, col, value },
    }) as Promise<Omit<SudokuSession, 'solution'>>;
  }

  async submitSudoku(
    id: string,
    user: AuthAccount,
    board?: number[][],
  ): Promise<{ solved: boolean; session: Omit<SudokuSession, 'solution'> }> {
    return this.applySudokuEngineAction(id, user, {
      type: 'submit',
      payload: { board },
    }) as Promise<{ solved: boolean; session: Omit<SudokuSession, 'solution'> }>;
  }

  private async applySudokuEngineAction(
    id: string,
    user: AuthAccount,
    action: { type: 'set_cell' | 'submit'; payload?: Record<string, unknown>; clientMoveId?: string },
  ): Promise<Omit<SudokuSession, 'solution'> | { solved: boolean; session: Omit<SudokuSession, 'solution'> }> {
    const current = this.sudokuFromRow(await this.requireGameRow(id, 'sudoku'));
    this.assertSudokuParticipant(user, current);
    this.assertNotPaused(current);
    const side = this.sudokuSideForUser(current, user);
    const payload = action.payload ?? {};
    if (action.type === 'submit' && Array.isArray(payload.board) && !side) {
      validateSudokuBoard(payload.board as number[][]);
      current.board = payload.board as number[][];
    }
    const engine = this.gameRegistry.engine('sudoku');
    if (!engine) {
      throw new BadRequestException('unsupported gameKey');
    }
    const seat = side ? Math.max(0, sudokuSides(current).indexOf(side)) : 0;
    const result = engine.applyAction(current, seat, {
      type: action.type,
      payload,
      clientMoveId: action.clientMoveId,
    });
    const nextSession = result.state as SudokuSession;
    const solved = nextSession.status === 'cleared' || (side ? nextSession.status === 'finished' && nextSession.winnerSide === side : false);
    const saved = this.sudokuFromRow(await this.updateGame(
      id,
      nextSession.status,
      null,
      action.type === 'submit' && solved ? (side ?? 'cleared') : null,
      nextSession,
    ));
    if (action.type === 'set_cell') {
      this.emitSudokuEvent(saved, 'sudoku.cell.updated');
      return hideSudokuSolution(saved, user);
    }
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
      board: initialGomokuBoard(),
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

  async playGomokuMove(id: string, user: AuthAccount, row: number, col: number, clientMoveId?: string): Promise<GomokuSession> {
    return this.applyGomokuEngineMove(id, user, { row, col }, clientMoveId);
  }

  private async applyGomokuEngineMove(
    id: string,
    user: AuthAccount,
    payload: Record<string, unknown>,
    clientMoveId?: string,
  ): Promise<GomokuSession> {
    const row = Number(payload.row);
    const col = Number(payload.col);
    validateGomokuIndex(row, 'row');
    validateGomokuIndex(col, 'col');
    const session = this.gomokuFromRow(await this.requireGameRow(id, 'gomoku'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    if (session.status !== 'playing') {
      throw new BadRequestException('game is already finished');
    }
    this.assertNotPaused(session);
    if (!this.consumeClientMoveId(session, user.accountId, clientMoveId)) {
      return session;
    }
    const color = session.currentTurn;
    if (isLocalAiAccount(session.players[color])) {
      throw new ForbiddenException('not your turn');
    }
    if (!this.canActAs(user, session.players[color])) {
      throw new ForbiddenException('not your turn');
    }
    const engine = this.gameRegistry.engine('gomoku');
    if (!engine) {
      throw new BadRequestException('unsupported gameKey');
    }
    const seat = color === 'black' ? 0 : 1;
    const result = engine.applyAction(session, seat, {
      type: 'move',
      payload: { row, col },
      clientMoveId,
    });
    const nextSession = result.state as GomokuSession;
    const saved = this.gomokuFromRow(await this.updateGame(id, nextSession.status, nextSession.currentTurn, nextSession.winner ?? null, nextSession));
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
    clientMoveId?: string,
  ): Promise<AlkkagiShotResult> {
    return this.applyAlkkagiEngineShot(id, user, { pieceId, vx, vy }, clientMoveId);
  }

  private async applyAlkkagiEngineShot(
    id: string,
    user: AuthAccount,
    payload: Record<string, unknown>,
    clientMoveId?: string,
  ): Promise<AlkkagiShotResult> {
    const pieceId = typeof payload.pieceId === 'string' ? payload.pieceId : '';
    const vx = Number(payload.vx);
    const vy = Number(payload.vy);
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
      throw new BadRequestException('vx and vy must be numbers');
    }
    const session = this.alkkagiFromRow(await this.requireGameRow(id, 'alkkagi'));
    this.assertGameParticipant(user, session.players.red, session.players.blue);
    if (session.status !== 'playing') {
      throw new BadRequestException('game is already finished');
    }
    this.assertNotPaused(session);
    if (!this.consumeClientMoveId(session, user.accountId, clientMoveId)) {
      return { session, animation: { frameMs: 16, frames: [] } };
    }
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
    const engine = this.gameRegistry.engine('alkkagi');
    if (!engine) {
      throw new BadRequestException('unsupported gameKey');
    }
    const seat = team === 'red' ? 0 : 1;
    const engineResult = engine.applyAction(session, seat, {
      type: 'shoot',
      payload: { pieceId, vx: cappedVx, vy: cappedVy },
      clientMoveId,
    });
    const animation = alkkagiAnimationFromEngineResult(engineResult);
    const nextSession = engineResult.state as AlkkagiSession;
    const saved = this.alkkagiFromRow(await this.updateGame(id, nextSession.status, nextSession.currentTurn, nextSession.winner ?? null, nextSession));
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
      this.startTimedTurn(state, 'othello', MATCH_READY_DELAY_MS);
    }
    const row = await this.insertGame('othello', resolvedMode, user.accountId, opponentAccountId ?? null, 'playing', 'black', null, state);
    const session = this.othelloFromRow(row);
    this.scheduleTurnTimer(session, 'othello');
    this.emitSessionEvent(session, 'game.session.created', session);
    return session;
  }

  async getOthelloSession(id: string, user: AuthAccount): Promise<OthelloSession> {
    const session = this.othelloFromRow(await this.requireGameRow(id, 'othello'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    return session;
  }

  async playOthelloMove(id: string, user: AuthAccount, row: number, col: number, clientMoveId?: string): Promise<OthelloSession> {
    return this.applyOthelloEngineMove(id, user, { row, col }, clientMoveId);
  }

  private async applyOthelloEngineMove(
    id: string,
    user: AuthAccount,
    payload: Record<string, unknown>,
    clientMoveId?: string,
  ): Promise<OthelloSession> {
    const row = Number(payload.row);
    const col = Number(payload.col);
    validateOthelloIndex(row, 'row');
    validateOthelloIndex(col, 'col');
    const session = this.othelloFromRow(await this.requireGameRow(id, 'othello'));
    this.assertGameParticipant(user, session.players.black, session.players.white);
    if (session.status !== 'playing') {
      throw new BadRequestException('game is already finished');
    }
    this.assertNotPaused(session);
    if (!this.consumeClientMoveId(session, user.accountId, clientMoveId)) {
      return session;
    }
    const color = session.currentTurn;
    if (isLocalAiAccount(session.players[color])) {
      throw new ForbiddenException('not your turn');
    }
    if (!this.canActAs(user, session.players[color])) {
      throw new ForbiddenException('not your turn');
    }
    const engine = this.gameRegistry.engine('othello');
    if (!engine) {
      throw new BadRequestException('unsupported gameKey');
    }
    const seat = color === 'black' ? 0 : 1;
    const result = engine.applyAction(session, seat, {
      type: 'move',
      payload: { row, col },
      clientMoveId,
    });
    const nextSession = result.state as OthelloSession;
    if (session.status === 'playing') {
      this.startTimedTurn(nextSession, 'othello');
    } else {
      this.clearTurnTimer(nextSession.id);
    }
    const saved = this.othelloFromRow(await this.updateGame(id, nextSession.status, nextSession.currentTurn, nextSession.winner ?? null, nextSession));
    this.scheduleTurnTimer(saved, 'othello');
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
    this.clearTurnTimer(id);
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

  async moveSokoban(id: string, user: AuthAccount, direction: string, clientMoveId?: string): Promise<SokobanSession> {
    return this.applySokobanEngineMove(id, user, { direction }, clientMoveId);
  }

  private async applySokobanEngineMove(
    id: string,
    user: AuthAccount,
    payload: Record<string, unknown>,
    clientMoveId?: string,
  ): Promise<SokobanSession> {
    const session = this.sokobanFromRow(await this.requireGameRow(id, 'sokoban'));
    this.assertSokobanParticipant(user, session);
    if (session.status !== 'playing') {
      throw new BadRequestException('game is already finished');
    }
    this.assertNotPaused(session);
    if (!this.consumeClientMoveId(session, user.accountId, clientMoveId)) {
      return sessionForSokobanUser(session, user);
    }
    const side = this.sokobanSideForUser(session, user);
    const playerState = side ? ensureSokobanPlayerState(session, side) : session.state;
    const beforeMoves = playerState.moves;
    const seat = side ? Math.max(0, sokobanSides(session).indexOf(side)) : 0;
    const engine = this.gameRegistry.engine('sokoban');
    if (!engine) {
      throw new BadRequestException('unsupported gameKey');
    }
    const result = engine.applyAction(session, seat, {
      type: 'move',
      payload: { direction: typeof payload.direction === 'string' ? payload.direction : '' },
      clientMoveId,
    });
    const nextSession = result.state as SokobanSession;
    const nextState = side ? ensureSokobanPlayerState(nextSession, side) : nextSession.state;
    if (nextState.moves === beforeMoves) {
      return sessionForSokobanUser(session, user);
    }
    const saved = this.sokobanFromRow(await this.updateGame(id, nextSession.status, null, nextSession.winnerSide ?? null, nextSession));
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
    const winner = firstOtherSokobanSide(session, loser);
    session.status = 'finished';
    session.winnerSide = winner;
    session.winnerAccountId = winner ? session.players[winner] : undefined;
    session.finishReason = 'forfeit';
    session.updatedAt = new Date().toISOString();
    const saved = this.sokobanFromRow(await this.updateGame(id, session.status, null, session.winnerSide ?? null, session));
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
    clientMoveId?: string,
  ): Promise<SplendorClientSession> {
    return this.applySplendorEngineAction(id, user, 'take_tokens', { tokens, discardTokens }, clientMoveId);
  }

  async reserveSplendorCard(
    id: string,
    user: AuthAccount,
    input: { cardId?: string; tier?: string; discardTokens?: Partial<Record<SplendorToken, number>> },
    clientMoveId?: string,
  ): Promise<SplendorClientSession> {
    return this.applySplendorEngineAction(id, user, 'reserve_card', input, clientMoveId);
  }

  async buySplendorCard(id: string, user: AuthAccount, cardId: string, clientMoveId?: string): Promise<SplendorClientSession> {
    return this.applySplendorEngineAction(id, user, 'buy_card', { cardId }, clientMoveId);
  }

  private async applySplendorEngineAction(
    id: string,
    user: AuthAccount,
    type: 'take_tokens' | 'reserve_card' | 'buy_card',
    payload: Record<string, unknown>,
    clientMoveId?: string,
  ): Promise<SplendorClientSession> {
    const session = this.splendorFromRow(await this.requireGameRow(id, 'splendor'));
    this.assertSplendorParticipant(user, session);
    const side = this.splendorSideForUser(session, user);
    if (!this.consumeClientMoveId(session, user.accountId, clientMoveId)) {
      return splendorClientSession(session, user.accountId);
    }
    const engine = this.gameRegistry.engine('splendor');
    if (!engine) {
      throw new BadRequestException('unsupported gameKey');
    }
    const result = engine.applyAction(session, splendorSeatForSide(session, side), {
      type,
      payload,
      clientMoveId,
    });
    const saved = await this.saveSplendorSession(result.state as SplendorSession);
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
    return this.applyFortressEngineAction(id, user, 'select_tank', { tankKey }) as Promise<ReturnType<typeof fortressClientSession>>;
  }

  async moveFortress(
    id: string,
    user: AuthAccount,
    distance: number,
    clientMoveId?: string,
  ): Promise<ReturnType<typeof fortressClientSession>> {
    return this.applyFortressEngineAction(id, user, 'move', { distance }, clientMoveId) as Promise<ReturnType<typeof fortressClientSession>>;
  }

  async updateFortressAim(
    id: string,
    user: AuthAccount,
    angle: number,
    power: number,
    charging: boolean,
  ): Promise<ReturnType<typeof fortressClientSession>> {
    return this.applyFortressEngineAction(id, user, 'aim', { angle, power, charging }) as Promise<ReturnType<typeof fortressClientSession>>;
  }

  async shootFortress(
    id: string,
    user: AuthAccount,
    angle: number,
    power: number,
    item?: FortressItemKey,
    clientMoveId?: string,
  ): Promise<FortressShotResult & { session: ReturnType<typeof fortressClientSession> }> {
    return this.applyFortressEngineAction(id, user, 'shoot', { angle, power, item }, clientMoveId) as Promise<FortressShotResult & { session: ReturnType<typeof fortressClientSession> }>;
  }

  private async applyFortressEngineAction(
    id: string,
    user: AuthAccount,
    type: 'select_tank' | 'move' | 'aim' | 'shoot',
    payload: Record<string, unknown>,
    clientMoveId?: string,
  ): Promise<ReturnType<typeof fortressClientSession> | FortressShotResult & { session: ReturnType<typeof fortressClientSession> }> {
    const session = this.fortressFromRow(await this.requireGameRow(id, 'fortress'));
    this.assertFortressParticipant(user, session);
    if (type !== 'select_tank') {
      this.assertNotPaused(session);
    }
    if ((type === 'move' || type === 'shoot') && !this.consumeClientMoveId(session, user.accountId, clientMoveId)) {
      if (type === 'move') {
        return fortressClientSession(session, user.accountId);
      }
      return {
        session: fortressClientSession(session, user.accountId),
        animation: {
          frameMs: 16,
          projectile: [],
          terrainBefore: session.terrain,
          terrainAfter: session.terrain,
          tanksBefore: session.tanks,
          tanksAfter: session.tanks,
        },
      };
    }
    const side = this.fortressSideForUser(session, user);
    const engine = this.gameRegistry.engine('fortress');
    if (!engine) {
      throw new BadRequestException('unsupported gameKey');
    }
    const engineResult = engine.applyAction(session, side === 'challenger' ? 0 : 1, {
      type,
      payload,
      clientMoveId,
    });
    if (type === 'select_tank') {
      const nextSession = engineResult.state as FortressSession;
      if (nextSession.mode === 'local_ai') {
        applyFortressAiTurn(nextSession);
      }
      if (nextSession.status === 'playing') {
        this.startFortressTimedTurn(nextSession, nextSession.mode === 'friend_match' ? MATCH_READY_DELAY_MS : 0);
      }
      const saved = await this.saveFortressSession(nextSession);
      this.scheduleFortressTurnTimer(saved);
      this.emitSessionEvent(saved, 'fortress.state.changed', fortressClientSession(saved));
      return fortressClientSession(saved, user.accountId);
    }
    if (type === 'move') {
      const saved = await this.saveFortressSession(engineResult.state as FortressSession);
      this.scheduleFortressTurnTimer(saved);
      this.emitSessionEvent(saved, saved.status === 'finished' ? 'game.session.finished' : 'fortress.state.changed', fortressClientSession(saved));
      this.scheduleFortressAi(saved);
      return fortressClientSession(saved, user.accountId);
    }
    if (type === 'aim') {
      const saved = await this.saveFortressSession(engineResult.state as FortressSession);
      this.emitSessionEvent(saved, 'fortress.state.changed', fortressClientSession(saved));
      return fortressClientSession(saved, user.accountId);
    }
    const result = fortressShotResultFromEngineResult(engineResult, engineResult.state as FortressSession);
    if (result.session.status === 'playing') {
      this.startFortressTimedTurn(result.session, FORTRESS_SHOT_ANIMATION_MS);
    }
    const saved = await this.saveFortressSession(result.session);
    this.scheduleFortressTurnTimer(saved);
    const shotPayload = { ...result, session: fortressClientSession(saved) };
    this.emitSessionEvent(saved, 'fortress.shot.played', shotPayload);
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
      snapshot: createCrazyArcadeSnapshot(Math.floor(Math.random() * 0x7fffffff), difficulty),
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
    this.ensureCrazyArcadeTick(session);
    this.emitSessionEvent(session, 'game.session.created', session);
    return sessionForCrazyArcadeUser(session, user);
  }

  async getCrazyArcadeSession(id: string, user: AuthAccount): Promise<CrazyArcadeSession> {
    const session = this.crazyArcadeFromRow(await this.requireGameRow(id, 'crazy_arcade'));
    this.assertCrazyArcadeParticipant(user, session);
    if (session.mode === 'friend_match' && session.status === 'playing' && session.pause?.active !== true) {
      const advanced = advanceCrazyArcadeServer(session);
      const saved = await this.saveCrazyArcadeSession(advanced);
      this.ensureCrazyArcadeTick(saved);
      return sessionForCrazyArcadeUser(saved, user);
    }
    this.ensureCrazyArcadeTick(session);
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
    if (session.mode === 'friend_match') {
      const advanced = advanceCrazyArcadeServer(session);
      const saved = await this.saveCrazyArcadeSession(advanced);
      this.emitSessionEvent(saved, saved.status === 'finished' ? 'game.session.finished' : 'crazy_arcade.state.synced', saved);
      this.ensureCrazyArcadeTick(saved);
      return sessionForCrazyArcadeUser(saved, user);
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
    this.ensureCrazyArcadeTick(saved);
    return sessionForCrazyArcadeUser(saved, user);
  }

  async updateCrazyArcadeInput(
    id: string,
    user: AuthAccount,
    input: Record<string, unknown>,
    clientMoveId?: string,
  ): Promise<CrazyArcadeSession> {
    const session = this.crazyArcadeFromRow(await this.requireGameRow(id, 'crazy_arcade'));
    this.assertCrazyArcadeParticipant(user, session);
    this.assertNotPaused(session);
    if (!this.consumeClientMoveId(session, user.accountId, clientMoveId)) {
      return sessionForCrazyArcadeUser(session, user);
    }
    const side = this.crazyArcadeSideForUser(session, user);
    if (session.mode === 'friend_match') {
      const seat = Object.keys(session.players).indexOf(side);
      const result = CRAZY_ARCADE_ENGINE.applyAction(session, seat, {
        type: 'input',
        payload: input,
        clientMoveId,
      });
      const saved = await this.saveCrazyArcadeSession(result.state);
      this.emitSessionEvent(saved, saved.status === 'finished' ? 'game.session.finished' : 'crazy_arcade.state.synced', saved);
      this.ensureCrazyArcadeTick(saved);
      return sessionForCrazyArcadeUser(saved, user);
    }
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

  async enqueueCrazyArcadeSocketInput(
    id: string,
    user: AuthAccount,
    input: Record<string, unknown>,
    clientMoveId?: string,
  ): Promise<CrazyArcadeSession> {
    const previous = this.crazyArcadeInputQueues.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.updateCrazyArcadeInput(id, user, input, clientMoveId));
    const queued = next.finally(() => {
      if (this.crazyArcadeInputQueues.get(id) === queued) {
        this.crazyArcadeInputQueues.delete(id);
      }
    });
    this.crazyArcadeInputQueues.set(id, queued);
    return next;
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
    this.clearCrazyArcadeTickTimer(saved.id);
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

  async saveGameSessionToSlot(
    gameKey: string,
    id: string,
    user: AuthAccount,
    input: { slot?: number; label?: string },
  ): Promise<{ save: unknown }> {
    const descriptor = this.gameRegistry.get(gameKey);
    if (!descriptor) {
      throw new BadRequestException('unsupported gameKey');
    }
    if (!descriptor.supportsMatchSave) {
      throw new BadRequestException(`${gameKey} does not support server save slots yet`);
    }
    const slot = Number(input.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 3) {
      throw new BadRequestException('slot must be 1, 2, or 3');
    }
    const row = await this.requireGameRow(id, gameKey);
    this.assertRowParticipant(row, user);
    if (row.status !== 'playing' && row.status !== 'selecting') {
      throw new BadRequestException('only active sessions can be saved');
    }
    const seats = await this.sessionSeatRows(row);
    const mySeat = mySeatFromPlayers(seats, user.accountId);
    if (mySeat < 0) {
      throw new ForbiddenException('not a participant');
    }
    const result = await this.db.query<GameSaveRow>(
      `INSERT INTO game_saves
       (account_id, game_key, slot, label, source_session_id, source_mode, my_seat, players_json, state_json, state_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
       ON CONFLICT (account_id, game_key, slot) DO UPDATE SET
         label = EXCLUDED.label,
         source_session_id = EXCLUDED.source_session_id,
         source_mode = EXCLUDED.source_mode,
         my_seat = EXCLUDED.my_seat,
         players_json = EXCLUDED.players_json,
         state_json = EXCLUDED.state_json,
         state_version = EXCLUDED.state_version,
         updated_at = now()
       RETURNING *`,
      [
        user.accountId,
        gameKey,
        slot,
        typeof input.label === 'string' ? input.label.slice(0, 80) : '',
        row.id,
        row.mode,
        mySeat,
        JSON.stringify(seats.map(sessionPlayerView)),
        JSON.stringify(row.state_json),
        stateVersionForGame(gameKey),
      ],
    );
    return { save: this.saveRowView(result.rows[0], user.accountId, row.status) };
  }

  async listGameSaves(user: AuthAccount, gameKey?: string): Promise<{ saves: unknown[] }> {
    const params: unknown[] = [user.accountId];
    const where = ['game_saves.account_id = $1'];
    if (gameKey) {
      if (!this.gameRegistry.has(gameKey)) {
        throw new BadRequestException('unsupported gameKey');
      }
      params.push(gameKey);
      where.push(`game_saves.game_key = $${params.length}`);
    }
    const result = await this.db.query<GameSaveRow>(
      `SELECT game_saves.*, game_sessions.status AS source_session_status
       FROM game_saves
       LEFT JOIN game_sessions ON game_sessions.id = game_saves.source_session_id
       WHERE ${where.join(' AND ')}
       ORDER BY game_saves.game_key ASC, game_saves.slot ASC`,
      params,
    );
    return { saves: result.rows.map((row) => this.saveRowView(row, user.accountId)) };
  }

  async continueGameSave(
    saveId: string,
    user: AuthAccount,
    input: { difficulty?: Difficulty },
  ): Promise<{
    session: unknown;
    sessionId: string;
    gameKey: string;
    sourceSave: { id: string; slot: number; label: string; updatedAt: string };
  }> {
    const row = await this.db.one<GameSaveRow>(`SELECT * FROM game_saves WHERE id = $1`, [saveId]);
    if (!row) {
      throw new NotFoundException('Save slot not found');
    }
    if (row.account_id !== user.accountId) {
      throw new ForbiddenException('not your save slot');
    }
    if (row.source_mode === 'friend_match' && row.source_session_id) {
      const source = await this.db.one<GameRow>(`SELECT * FROM game_sessions WHERE id = $1`, [row.source_session_id]);
      if (source && !isTerminalGameStatus(source.status)) {
        throw new BadRequestException('saved matched games can be continued after the original match finishes');
      }
    }
    const difficulty = input.difficulty ?? 'medium';
    this.assertDifficulty(difficulty);
    const state = forkSavedStateForLocalAi(row.game_key, row.state_json, user.accountId, difficulty);
    const currentTurn = currentTurnForState(row.game_key, state);
    const winner = winnerForState(row.game_key, state);
    const status = statusForState(state);
    const result = await this.insertGame(
      row.game_key,
      modeForContinuedSave(row.game_key),
      user.accountId,
      null,
      status,
      currentTurn,
      winner,
      state,
    );
    const session = await this.visibleSessionForRow(result, user);
    this.scheduleAiForRestoredSession(row.game_key, result);
    return {
      session,
      sessionId: result.id,
      gameKey: row.game_key,
      sourceSave: {
        id: row.id,
        slot: row.slot,
        label: row.label,
        updatedAt: row.updated_at.toISOString(),
      },
    };
  }

  async deleteGameSave(saveId: string, user: AuthAccount): Promise<{ ok: true }> {
    const row = await this.db.one<GameSaveRow>(`SELECT * FROM game_saves WHERE id = $1`, [saveId]);
    if (!row) {
      throw new NotFoundException('Save slot not found');
    }
    if (row.account_id !== user.accountId) {
      throw new ForbiddenException('not your save slot');
    }
    await this.db.query(`DELETE FROM game_saves WHERE id = $1 AND account_id = $2`, [saveId, user.accountId]);
    return { ok: true };
  }

  async uploadLocalAiResults(
    user: AuthAccount,
    input: { results?: unknown[] },
  ): Promise<{ accepted: number; skipped: number; acceptedKeys: string[] }> {
    if (!Array.isArray(input.results)) {
      throw new BadRequestException('results must be an array');
    }
    if (input.results.length > 200) {
      throw new BadRequestException('results must contain at most 200 entries');
    }
    const acceptedKeys: string[] = [];
    let skipped = 0;
    for (const raw of input.results) {
      const parsed = parseLocalAiResult(raw);
      if (!parsed) {
        skipped++;
        continue;
      }
      await this.db.query(
        `INSERT INTO local_ai_results
         (account_id, game_key, session_id, result, difficulty, reason, recorded_at, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (account_id, game_key, session_id) DO UPDATE SET
           result = EXCLUDED.result,
           difficulty = EXCLUDED.difficulty,
           reason = EXCLUDED.reason,
           recorded_at = EXCLUDED.recorded_at,
           payload_json = EXCLUDED.payload_json,
           updated_at = now()`,
        [
          user.accountId,
          parsed.gameKey,
          parsed.sessionId,
          parsed.result,
          parsed.difficulty,
          parsed.reason,
          parsed.recordedAt,
          JSON.stringify(parsed.payload),
        ],
      );
      acceptedKeys.push(localAiResultKey(parsed.gameKey, parsed.sessionId));
    }
    return { accepted: acceptedKeys.length, skipped, acceptedKeys };
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
      this.clearTurnTimer(id);
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
      this.clearCrazyArcadeTickTimer(saved.id);
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
      this.scheduleTurnTimer(saved, 'othello');
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
      this.ensureCrazyArcadeTick(saved);
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

  private async createSessionFromRoom(room: GameRoomRow, members: GameRoomMemberRow[]): Promise<string> {
    if (members.length === 2) {
      return this.createSessionFromMatch(room.game_key, members[0].account_id, members[1].account_id);
    }
    const descriptor = this.gameRegistry.get(room.game_key);
    if (!descriptor || descriptor.maxPlayers < members.length) {
      throw new BadRequestException('unsupported room size');
    }
    if (!['splendor', 'sudoku', 'sokoban', 'crazy_arcade'].includes(room.game_key)) {
      throw new BadRequestException('multi-player room start is not available for this game');
    }
    const orderedMembers = [...members].sort((a, b) => a.seat - b.seat);
    if (room.game_key === 'splendor') {
      const state = createSplendorStateForPlayers(
        orderedMembers.map((member) => ({
          side: `seat${member.seat}`,
          accountId: member.account_id,
        })),
        'friend_match',
      );
      const row = await this.insertGame(
        room.game_key,
        'friend_match',
        orderedMembers[0].account_id,
        null,
        'playing',
        state.currentTurn,
        null,
        {
          ...state,
          roomId: room.id,
          roomCode: room.room_code,
          roomMode: 'multi_player',
          roomPlayers: orderedMembers.map((member) => ({
            seat: member.seat,
            accountId: member.account_id,
            kind: 'account',
            status: 'active',
          })),
        },
      );
      return row.id;
    }
    if (room.game_key === 'sudoku') {
      const difficulty = difficultyFromSnapshot(
        isRecord(room.config_json) ? room.config_json.difficulty : undefined,
        'medium',
      );
      const { puzzle, solution } = createSudoku(difficulty);
      const board = puzzle.map((row) => [...row]);
      const players = Object.fromEntries(
        orderedMembers.map((member) => [`seat${member.seat}`, member.account_id]),
      ) as Record<SudokuSide, string>;
      const boards = Object.fromEntries(
        Object.keys(players).map((side) => [side, cloneSudokuGrid(board)]),
      ) as Record<SudokuSide, number[][]>;
      const state: SudokuSession = {
        id: '',
        mode: 'friend_match',
        ownerAccountId: orderedMembers[0].account_id,
        difficulty,
        puzzle,
        board,
        solution,
        players,
        boards,
        progress: {},
        battle: {},
        roomId: room.id,
        roomCode: room.room_code,
        roomMode: 'multi_player',
        roomPlayers: orderedMembers.map((member) => ({
          seat: member.seat,
          accountId: member.account_id,
          kind: 'account',
          status: 'active',
        })),
        pause: {
          active: false,
          counts: Object.fromEntries(orderedMembers.map((member) => [member.account_id, 0])),
        },
        status: 'playing',
        createdAt: '',
        updatedAt: '',
      } as SudokuSession & Record<string, unknown>;
      state.progress = createSudokuProgressMap(state);
      state.battle = createSudokuBattleMap(state);
      const row = await this.insertGame(
        room.game_key,
        'friend_match',
        orderedMembers[0].account_id,
        null,
        'playing',
        null,
        null,
        state,
      );
      return row.id;
    }
    if (room.game_key === 'sokoban') {
      const difficulty = difficultyFromSnapshot(
        isRecord(room.config_json) ? room.config_json.difficulty : undefined,
        'medium',
      );
      const initial = await this.selectSokobanMap(difficulty);
      const players = Object.fromEntries(
        orderedMembers.map((member) => [`seat${member.seat}`, member.account_id]),
      ) as Record<SokobanSide, string>;
      const state: SokobanSession = {
        id: '',
        mode: 'friend_match',
        ownerAccountId: orderedMembers[0].account_id,
        difficulty,
        mapKey: initial.key,
        walls: initial.walls,
        goals: initial.goals,
        initialPlayer: initial.player,
        initialBoxes: initial.boxes,
        state: createSokobanPlayerState(initial),
        players,
        states: Object.fromEntries(
          Object.keys(players).map((side) => [side, createSokobanPlayerState(initial)]),
        ) as Record<SokobanSide, SokobanPlayerState>,
        roomId: room.id,
        roomCode: room.room_code,
        roomMode: 'multi_player',
        roomPlayers: orderedMembers.map((member) => ({
          seat: member.seat,
          accountId: member.account_id,
          kind: 'account',
          status: 'active',
        })),
        pause: {
          active: false,
          counts: Object.fromEntries(orderedMembers.map((member) => [member.account_id, 0])),
        },
        status: 'playing',
        createdAt: '',
        updatedAt: '',
      } as SokobanSession & Record<string, unknown>;
      const row = await this.insertGame(
        room.game_key,
        'friend_match',
        orderedMembers[0].account_id,
        null,
        'playing',
        null,
        null,
        state,
      );
      return row.id;
    }
    if (room.game_key === 'crazy_arcade') {
      const difficulty = difficultyFromSnapshot(
        isRecord(room.config_json) ? room.config_json.difficulty : undefined,
        'medium',
      );
      const sides = orderedMembers.map((member) => `seat${member.seat}` as CrazyArcadeSide);
      const players = Object.fromEntries(
        orderedMembers.map((member, index) => [sides[index], member.account_id]),
      ) as Record<string, string>;
      const state: CrazyArcadeSession = {
        id: '',
        mode: 'friend_match',
        ownerAccountId: orderedMembers[0].account_id,
        difficulty,
        players,
        status: 'playing',
        snapshot: createCrazyArcadeSnapshotForSides(
          sides,
          Math.floor(Math.random() * 0x7fffffff),
          difficulty,
        ),
        inputs: Object.fromEntries(sides.map((side) => [side, {}])),
        roomId: room.id,
        roomCode: room.room_code,
        roomMode: 'multi_player',
        roomPlayers: orderedMembers.map((member) => ({
          seat: member.seat,
          accountId: member.account_id,
          kind: 'account',
          status: 'active',
        })),
        pause: {
          active: false,
          counts: Object.fromEntries(orderedMembers.map((member) => [member.account_id, 0])),
        },
        version: 0,
        createdAt: '',
        updatedAt: '',
      } as CrazyArcadeSession & Record<string, unknown>;
      const row = await this.insertGame(
        room.game_key,
        'friend_match',
        orderedMembers[0].account_id,
        null,
        'playing',
        null,
        null,
        state,
      );
      this.ensureCrazyArcadeTick(this.crazyArcadeFromRow(row));
      return row.id;
    }
    const players = Object.fromEntries(orderedMembers.map((member) => [`seat${member.seat}`, member.account_id]));
    const turnOrder = orderedMembers.map((member) => member.seat);
    const currentSeat = descriptor.turnType === 'turnBased' ? turnOrder[0] : undefined;
    const state = {
      id: '',
      mode: 'friend_match' as const,
      ownerAccountId: orderedMembers[0].account_id,
      roomId: room.id,
      roomCode: room.room_code,
      roomMode: 'multi_player',
      gameKey: room.game_key,
      players,
      roomPlayers: orderedMembers.map((member) => ({
        seat: member.seat,
        accountId: member.account_id,
        kind: 'account',
        status: 'active',
      })),
      currentSeat,
      turnOrder,
      status: 'playing',
      createdAt: '',
      updatedAt: '',
    };
    const row = await this.insertGame(
      room.game_key,
      'friend_match',
      orderedMembers[0].account_id,
      null,
      'playing',
      typeof currentSeat === 'number' ? `seat${currentSeat}` : null,
      null,
      state,
    );
    return row.id;
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
    const row = result.rows[0];
    await this.syncSessionPlayers(row);
    return row;
  }

  private async syncSessionPlayers(row: GameRow): Promise<void> {
    const seats = inferSessionSeats(row.game_key, row.state_json, row.owner_account_id, row.opponent_account_id);
    for (const seat of seats) {
      await this.db.query(
        `INSERT INTO game_session_players (session_id, seat, account_id, kind, ai_difficulty, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (session_id, seat) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           kind = EXCLUDED.kind,
           ai_difficulty = EXCLUDED.ai_difficulty,
           status = EXCLUDED.status`,
        [row.id, seat.seat, seat.accountId, seat.kind, seat.aiDifficulty ?? null, seat.status],
      );
    }
  }

  /**
   * 멱등 제출(root §4.2-5): seat/계정별 최근 clientMoveId 를 state_json 에 최대 20개 보관한다.
   * 처음 보는 id 면 기록 후 true(진행), 이미 처리한 id 면 false(재적용 금지 — 호출부가 현재 상태 재응답).
   * clientMoveId 가 없으면 항상 true. state_json 에 함께 직렬화되므로 별도 컬럼/타입 변경이 필요 없다.
   */
  private consumeClientMoveId(session: unknown, accountId: string, clientMoveId?: string): boolean {
    if (!clientMoveId) {
      return true;
    }
    const state = session as { recentClientMoves?: Record<string, string[]> };
    const store = state.recentClientMoves ?? (state.recentClientMoves = {});
    const seen = store[accountId] ?? [];
    if (seen.includes(clientMoveId)) {
      return false;
    }
    seen.push(clientMoveId);
    if (seen.length > CLIENT_MOVE_HISTORY_LIMIT) {
      seen.splice(0, seen.length - CLIENT_MOVE_HISTORY_LIMIT);
    }
    store[accountId] = seen;
    return true;
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

  private assertRowParticipant(row: GameRow, user: AuthAccount): void {
    const state = row.state_json as { players?: Record<string, string>; ownerAccountId?: string };
    const participants = state.players
      ? Object.values(state.players)
      : [state.ownerAccountId ?? row.owner_account_id, row.opponent_account_id].filter((item): item is string => Boolean(item));
    if (!participants.some((accountId) => this.canActAs(user, accountId))) {
      throw new ForbiddenException('not a participant');
    }
  }

  private async sessionSeatRows(row: GameRow): Promise<GameSessionPlayerRow[]> {
    const result = await this.db.query<GameSessionPlayerRow>(
      `SELECT *
       FROM game_session_players
       WHERE session_id = $1
       ORDER BY seat ASC`,
      [row.id],
    );
    if (result.rows.length > 0) {
      return result.rows;
    }
    await this.syncSessionPlayers(row);
    const refreshed = await this.db.query<GameSessionPlayerRow>(
      `SELECT *
       FROM game_session_players
       WHERE session_id = $1
       ORDER BY seat ASC`,
      [row.id],
    );
    return refreshed.rows;
  }

  private saveRowView(row: GameSaveRow, accountId: string, sourceStatus = row.source_session_status): Record<string, unknown> {
    const continueAvailable = row.source_mode !== 'friend_match' || !row.source_session_id || !sourceStatus || isTerminalGameStatus(sourceStatus);
    return {
      id: row.id,
      gameKey: row.game_key,
      slot: row.slot,
      label: row.label,
      sourceSessionId: row.source_session_id,
      sourceMode: row.source_mode,
      sourceSessionStatus: sourceStatus ?? null,
      continueAvailable,
      mySeat: row.my_seat,
      players: row.players_json,
      stateVersion: row.state_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      preview: visibleStateForGame(row.game_key, row.state_json, accountId, row.my_seat),
    };
  }

  private async visibleSessionForRow(row: GameRow, user: AuthAccount): Promise<unknown> {
    const engine = this.gameRegistry.engine(row.game_key);
    if (engine) {
      try {
        const seats = await this.sessionSeatRows(row);
        const mySeat = mySeatFromPlayers(seats, user.accountId);
        return engine.viewFor(row.state_json, mySeat >= 0 ? mySeat : 'spectator');
      } catch {
        // Keep legacy game-specific views as a compatibility fallback for old states.
      }
    }
    if (row.game_key === 'sudoku') return hideSudokuSolution(this.sudokuFromRow(row), user);
    if (row.game_key === 'gomoku') return this.gomokuFromRow(row);
    if (row.game_key === 'alkkagi') return this.alkkagiFromRow(row);
    if (row.game_key === 'othello') return this.othelloFromRow(row);
    if (row.game_key === 'sokoban') return sessionForSokobanUser(this.sokobanFromRow(row), user);
    if (row.game_key === 'splendor') return splendorClientSession(this.splendorFromRow(row), user.accountId);
    if (row.game_key === 'fortress') return fortressClientSession(this.fortressFromRow(row), user.accountId);
    if (row.game_key === 'crazy_arcade') return sessionForCrazyArcadeUser(this.crazyArcadeFromRow(row), user);
    throw new BadRequestException('unsupported gameKey');
  }

  private scheduleAiForRestoredSession(gameKey: string, row: GameRow): void {
    if (gameKey === 'gomoku') {
      const session = this.gomokuFromRow(row);
      if (session.status === 'playing' && isLocalAiAccount(session.players[session.currentTurn])) {
        this.scheduleLocalGomokuAiTurn(session.id);
      }
    } else if (gameKey === 'alkkagi') {
      const session = this.alkkagiFromRow(row);
      if (session.status === 'playing' && isLocalAiAccount(session.players[session.currentTurn])) {
        this.scheduleLocalAlkkagiAiTurn(session.id);
      }
    } else if (gameKey === 'othello') {
      const session = this.othelloFromRow(row);
      if (session.status === 'playing' && isLocalAiAccount(session.players[session.currentTurn])) {
        this.scheduleLocalOthelloAiTurn(session.id);
      }
    } else if (gameKey === 'splendor') {
      this.scheduleSplendorAi(this.splendorFromRow(row));
    } else if (gameKey === 'fortress') {
      this.scheduleFortressAi(this.fortressFromRow(row));
    }
  }

  private assertCanUseRooms(user: AuthAccount): void {
    if (!hasPlayerAccess(user)) {
      throw new ForbiddenException('player permission is required for rooms');
    }
  }

  private async generateRoomCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
      const existing = await this.db.one<GameRoomRow>(`SELECT * FROM game_rooms WHERE room_code = $1`, [code]);
      if (!existing) {
        return code;
      }
    }
    throw new Error('failed to allocate room code');
  }

  private async requireRoom(id: string): Promise<GameRoomRow> {
    const room = await this.db.one<GameRoomRow>(`SELECT * FROM game_rooms WHERE id = $1`, [id]);
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    return room;
  }

  private async assertRoomVisible(room: GameRoomRow, user: AuthAccount): Promise<void> {
    if (room.visibility === 'public' || room.host_account_id === user.accountId) {
      return;
    }
    await this.assertRoomMember(room.id, user.accountId);
  }

  private async assertRoomMember(roomId: string, accountId: string): Promise<GameRoomMemberRow> {
    const member = await this.db.one<GameRoomMemberRow>(
      `SELECT *
       FROM game_room_members
       WHERE room_id = $1 AND account_id = $2`,
      [roomId, accountId],
    );
    if (!member) {
      throw new ForbiddenException('room member required');
    }
    return member;
  }

  private async roomMembers(roomId: string): Promise<GameRoomMemberRow[]> {
    const result = await this.db.query<GameRoomMemberRow>(
      `SELECT
         grm.*,
         sa.login_id AS account_login_id,
         sa.name AS account_name,
         sa.email AS account_email,
         sa.status AS account_status,
         sa.permission_key AS account_permission_key
       FROM game_room_members grm
       LEFT JOIN social_accounts sa ON sa.account_id = grm.account_id
       WHERE grm.room_id = $1
       ORDER BY grm.seat ASC`,
      [roomId],
    );
    return result.rows;
  }

  private async roomView(room: GameRoomRow, viewerAccountId: string): Promise<Record<string, unknown>> {
    const members = await this.roomMembers(room.id);
    return {
      id: room.id,
      roomCode: room.room_code,
      gameKey: room.game_key,
      hostAccountId: room.host_account_id,
      maxPlayers: room.max_players,
      visibility: room.visibility,
      config: room.config_json,
      status: room.status,
      sessionId: room.session_id,
      viewerSeat: members.find((member) => member.account_id === viewerAccountId)?.seat,
      members: members.map(roomMemberView),
      createdAt: room.created_at.toISOString(),
      updatedAt: room.updated_at.toISOString(),
    };
  }

  private async emitRoomEvent(room: GameRoomRow, event: string, payload: unknown): Promise<void> {
    const members = await this.roomMembers(room.id);
    this.realtime.emitToAccounts(members.map((member) => member.account_id), event, payload);
  }

  private async assertFriends(leftAccountId: string, rightAccountId: string): Promise<void> {
    const row = await this.db.one(
      `SELECT id
       FROM friend_requests
       WHERE status = 'accepted'
         AND (
           (requester_account_id = $1 AND recipient_account_id = $2)
           OR (requester_account_id = $2 AND recipient_account_id = $1)
         )`,
      [leftAccountId, rightAccountId],
    );
    if (!row) {
      throw new ForbiddenException('room invites are only available between friends');
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
      if (!Object.values(session.players).some((accountId) => this.canActAs(user, accountId))) {
        throw new ForbiddenException('not a participant');
      }
      return;
    }
    this.assertParticipant(user, session.ownerAccountId);
  }

  private sudokuSideForUser(session: SudokuSession, user: AuthAccount): SudokuSide | undefined {
    if (!session.players) {
      return undefined;
    }
    for (const [side, accountId] of Object.entries(session.players)) {
      if (this.canActAs(user, accountId)) {
        return side;
      }
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

  private sessionSideForUser(
    session: { players?: unknown },
    user: AuthAccount,
  ): string | undefined {
    if (!isRecord(session.players)) {
      return undefined;
    }
    for (const [side, accountId] of Object.entries(session.players)) {
      if (typeof accountId === 'string' && this.canActAs(user, accountId)) {
        return side;
      }
    }
    return undefined;
  }

  private assertSokobanParticipant(user: AuthAccount, session: SokobanSession): void {
    if (session.players) {
      if (!Object.values(session.players).some((accountId) => this.canActAs(user, accountId))) {
        throw new ForbiddenException('not a participant');
      }
      return;
    }
    this.assertParticipant(user, session.ownerAccountId);
  }

  private assertSplendorParticipant(user: AuthAccount, session: SplendorSession): void {
    if (!Object.values(session.players).some((accountId) => this.canActAs(user, accountId))) {
      throw new ForbiddenException('not a participant');
    }
  }

  private assertFortressParticipant(user: AuthAccount, session: FortressSession): void {
    this.assertGameParticipant(user, session.players.challenger, session.players.opponent);
  }

  private assertCrazyArcadeParticipant(user: AuthAccount, session: CrazyArcadeSession): void {
    if (!Object.values(session.players).some((accountId) => this.canActAs(user, accountId))) {
      throw new ForbiddenException('not a participant');
    }
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
    for (const [side, accountId] of Object.entries(session.players)) {
      if (this.canActAs(user, accountId)) {
        return side as CrazyArcadeSide;
      }
    }
    if (user.permission === 'superadmin') {
      return Object.keys(session.players)[0] as CrazyArcadeSide;
    }
    throw new ForbiddenException('not a participant');
  }

  private crazyArcadeSideForAccount(session: CrazyArcadeSession, accountId: string): CrazyArcadeSide | undefined {
    for (const [side, playerAccountId] of Object.entries(session.players)) {
      if (playerAccountId === accountId) {
        return side as CrazyArcadeSide;
      }
    }
    return undefined;
  }

  private sokobanSideForUser(session: SokobanSession, user: AuthAccount): SokobanSide | undefined {
    if (!session.players) {
      return undefined;
    }
    for (const [side, accountId] of Object.entries(session.players)) {
      if (this.canActAs(user, accountId)) {
        return side;
      }
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
      senderSide: this.sessionSideForUser(session, user),
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
    applyGomokuEngineMove(session, accountId, row, col, source);
    this.clearNetworkGrace(session);
    if (session.status === 'playing') {
      this.startTimedTurn(session, 'gomoku');
    } else {
      this.clearTurnTimer(session.id);
    }
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
    this.clearNetworkGrace(session);
  }

  private scheduleFortressTurnTimer(session: FortressSession): void {
    this.clearTurnTimer(session.id);
    if (!['friend_match', 'local_ai'].includes(session.mode ?? '') || session.status !== 'playing' || session.pause?.active) {
      return;
    }
    if (!session.turnDeadlineAt) {
      this.startFortressTimedTurn(session);
    }
    const deadline = session.networkGraceDeadlineAt ?? session.turnDeadlineAt;
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
    if (session.mode === 'friend_match' && await this.resolveFortressDisconnectGrace(session)) {
      return;
    }
    const side = session.currentTurn;
    const accountId = session.players[side];
    if (session.mode === 'friend_match' && !(await this.realtime.isAccountOnline(accountId))) {
      await this.startFortressDisconnectGrace(session, accountId);
      return;
    }
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

  private async resolveFortressDisconnectGrace(session: FortressSession): Promise<boolean> {
    if (!session.networkGraceDeadlineAt || !session.networkGraceAccountId) {
      return false;
    }
    if (Date.parse(session.networkGraceDeadlineAt) > Date.now() + 50) {
      this.scheduleFortressTurnTimer(session);
      return true;
    }
    if (await this.realtime.isAccountOnline(session.networkGraceAccountId)) {
      this.clearNetworkGrace(session);
      return false;
    }
    if (session.opponentLeftAt) {
      this.clearTurnTimer(session.id);
      return true;
    }
    session.opponentLeftAt = new Date().toISOString();
    session.updatedAt = session.opponentLeftAt;
    this.clearTurnTimer(session.id);
    const saved = await this.saveFortressSession(session);
    this.emitSessionEvent(saved, 'game.opponent_left', fortressClientSession(saved));
    return true;
  }

  private async startFortressDisconnectGrace(session: FortressSession, accountId: string): Promise<void> {
    const now = Date.now();
    session.networkGraceStartedAt = new Date(now).toISOString();
    session.networkGraceDeadlineAt = new Date(now + DISCONNECT_GRACE_MS).toISOString();
    session.networkGraceAccountId = accountId;
    session.updatedAt = new Date(now).toISOString();
    const saved = await this.saveFortressSession(session);
    this.scheduleFortressTurnTimer(saved);
    this.emitSessionEvent(saved, 'game.turn.network_waiting', fortressClientSession(saved));
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
    const animation = applyAlkkagiShotToSession(session, accountId, pieceId, vx, vy, source);
    this.clearNetworkGrace(session);
    if (session.status === 'playing') {
      this.startTimedTurn(session, 'alkkagi');
    } else {
      this.clearTurnTimer(session.id);
    }
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

  private startTimedTurn(session: GomokuSession | AlkkagiSession | OthelloSession, gameKey: 'gomoku' | 'alkkagi' | 'othello', delayMs = 0): void {
    if (session.mode !== 'friend_match' || session.status !== 'playing' || session.pause?.active) {
      return;
    }
    const now = Date.now();
    const limitMs = gameKey === 'gomoku'
      ? GOMOKU_TURN_LIMIT_MS
      : gameKey === 'alkkagi'
        ? ALKKAGI_TURN_LIMIT_MS
        : OTHELLO_TURN_LIMIT_MS;
    session.turnStartedAt = new Date(now + delayMs).toISOString();
    session.turnDeadlineAt = new Date(now + delayMs + limitMs).toISOString();
    this.clearNetworkGrace(session);
  }

  private clearNetworkGrace(session: GomokuSession | AlkkagiSession | OthelloSession | FortressSession | CrazyArcadeSession): void {
    delete session.networkGraceStartedAt;
    delete session.networkGraceDeadlineAt;
    delete session.networkGraceAccountId;
    delete session.opponentLeftAt;
  }

  private scheduleTurnTimer(session: GomokuSession | AlkkagiSession | OthelloSession, gameKey: 'gomoku' | 'alkkagi' | 'othello'): void {
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

  private async handleTurnTimer(id: string, gameKey: 'gomoku' | 'alkkagi' | 'othello'): Promise<void> {
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
    if (gameKey === 'othello') {
      await this.handleOthelloTimer(row);
      return;
    }
    await this.handleAlkkagiTimer(row);
  }

  private async restoreActiveTurnTimers(): Promise<void> {
    const result = await this.db.query<GameRow>(
      `SELECT * FROM game_sessions
       WHERE mode = 'friend_match'
         AND status = 'playing'
         AND game_key IN ('gomoku', 'alkkagi', 'othello', 'fortress')`,
    );
    for (const row of result.rows) {
      if (row.game_key === 'gomoku') {
        this.scheduleTurnTimer(this.gomokuFromRow(row), 'gomoku');
      } else if (row.game_key === 'alkkagi') {
        this.scheduleTurnTimer(this.alkkagiFromRow(row), 'alkkagi');
      } else if (row.game_key === 'othello') {
        this.scheduleTurnTimer(this.othelloFromRow(row), 'othello');
      } else if (row.game_key === 'fortress') {
        this.scheduleFortressTurnTimer(this.fortressFromRow(row));
      }
    }
  }

  private async restoreCrazyArcadeTicks(): Promise<void> {
    const result = await this.db.query<GameRow>(
      `SELECT * FROM game_sessions
       WHERE mode = 'friend_match'
         AND status = 'playing'
         AND game_key = 'crazy_arcade'`,
    );
    for (const row of result.rows) {
      this.ensureCrazyArcadeTick(this.crazyArcadeFromRow(row));
    }
  }

  private ensureCrazyArcadeTick(session: CrazyArcadeSession): void {
    if (!this.isCrazyArcadeRealtimeTickable(session)) {
      this.clearCrazyArcadeTickTimer(session.id);
      return;
    }
    if (this.crazyArcadeTickTimers.has(session.id)) {
      return;
    }
    const timer = setInterval(() => {
      void this.tickCrazyArcadeSession(session.id).catch((error) => {
        if (error instanceof GameStateConflictError) {
          return;
        }
        if (error instanceof NotFoundException) {
          this.clearCrazyArcadeTickTimer(session.id);
          return;
        }
        console.error('[crazy-arcade-tick]', error);
      });
    }, CRAZY_ARCADE_SERVER_TICK_MS);
    timer.unref?.();
    this.crazyArcadeTickTimers.set(session.id, timer);
  }

  private clearCrazyArcadeTickTimer(sessionId: string): void {
    const timer = this.crazyArcadeTickTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.crazyArcadeTickTimers.delete(sessionId);
    }
  }

  private async tickCrazyArcadeSession(id: string): Promise<void> {
    const row = await this.requireGameRow(id, 'crazy_arcade');
    const session = this.crazyArcadeFromRow(row);
    if (!this.isCrazyArcadeRealtimeTickable(session)) {
      this.clearCrazyArcadeTickTimer(id);
      return;
    }
    if (await this.resolveCrazyArcadeDisconnectGrace(session)) {
      return;
    }
    const disconnected = await this.firstOfflineCrazyArcadeParticipant(session);
    if (disconnected) {
      await this.startCrazyArcadeDisconnectGrace(session, disconnected.accountId);
      return;
    }
    const saved = await this.saveCrazyArcadeSession(advanceCrazyArcadeServer(session));
    this.emitSessionEvent(saved, saved.status === 'finished' ? 'game.session.finished' : 'crazy_arcade.state.synced', saved);
    if (!this.isCrazyArcadeRealtimeTickable(saved)) {
      this.clearCrazyArcadeTickTimer(id);
    }
  }

  private isCrazyArcadeRealtimeTickable(session: CrazyArcadeSession): boolean {
    return session.mode === 'friend_match' &&
      session.status === 'playing' &&
      session.pause?.active !== true &&
      !session.opponentLeftAt &&
      isRecord(session.snapshot) &&
      Array.isArray(session.snapshot.tiles);
  }

  private async firstOfflineCrazyArcadeParticipant(
    session: CrazyArcadeSession,
  ): Promise<{ side: CrazyArcadeSide; accountId: string } | undefined> {
    for (const [side, accountId] of Object.entries(session.players)) {
      if (!(await this.realtime.isAccountOnline(accountId))) {
        return { side: side as CrazyArcadeSide, accountId };
      }
    }
    return undefined;
  }

  private async resolveCrazyArcadeDisconnectGrace(session: CrazyArcadeSession): Promise<boolean> {
    if (!session.networkGraceDeadlineAt || !session.networkGraceAccountId) {
      return false;
    }
    if (Date.parse(session.networkGraceDeadlineAt) > Date.now() + 50) {
      return true;
    }
    if (await this.realtime.isAccountOnline(session.networkGraceAccountId)) {
      this.clearNetworkGrace(session);
      return false;
    }
    if (session.opponentLeftAt) {
      this.clearCrazyArcadeTickTimer(session.id);
      return true;
    }
    session.opponentLeftAt = new Date().toISOString();
    session.updatedAt = session.opponentLeftAt;
    session.version += 1;
    this.clearCrazyArcadeTickTimer(session.id);
    const saved = await this.saveCrazyArcadeSession(session);
    this.emitSessionEvent(saved, 'game.opponent_left', saved);
    return true;
  }

  private async startCrazyArcadeDisconnectGrace(session: CrazyArcadeSession, accountId: string): Promise<void> {
    const now = Date.now();
    session.networkGraceStartedAt = new Date(now).toISOString();
    session.networkGraceDeadlineAt = new Date(now + DISCONNECT_GRACE_MS).toISOString();
    session.networkGraceAccountId = accountId;
    session.updatedAt = new Date(now).toISOString();
    session.version += 1;
    const saved = await this.saveCrazyArcadeSession(session);
    this.emitSessionEvent(saved, 'game.turn.network_waiting', saved);
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
    if (!(await this.realtime.isAccountOnline(currentAccountId))) {
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
    if (!(await this.realtime.isAccountOnline(currentAccountId))) {
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

  private async handleOthelloTimer(row: GameRow): Promise<void> {
    const session = this.othelloFromRow(row);
    if (this.shouldRescheduleBeforeDeadline(session, 'othello')) {
      this.scheduleTurnTimer(session, 'othello');
      return;
    }
    if (await this.resolveDisconnectGrace(session, 'othello')) {
      return;
    }
    const currentAccountId = session.players[session.currentTurn];
    if (!(await this.realtime.isAccountOnline(currentAccountId))) {
      await this.startDisconnectGrace(session, 'othello', currentAccountId);
      return;
    }
    const moves = othelloLegalMoves(session.board, session.currentTurn);
    if (moves.length === 0) {
      const next = oppositeOthello(session.currentTurn);
      if (othelloLegalMoves(session.board, next).length === 0) {
        finishOthello(session);
      } else {
        session.currentTurn = next;
        this.startTimedTurn(session, 'othello');
      }
      session.updatedAt = new Date().toISOString();
    } else {
      const move = moves[Math.floor(Math.random() * moves.length)];
      applyOthelloMove(session, currentAccountId, move.row, move.col, 'timeout');
      if (session.status === 'playing') {
        this.startTimedTurn(session, 'othello');
      } else {
        this.clearTurnTimer(session.id);
      }
    }
    const saved = this.othelloFromRow(await this.updateGame(session.id, session.status, session.currentTurn, session.winner ?? null, session));
    this.scheduleTurnTimer(saved, 'othello');
    this.emitSessionEvent(saved, 'othello.move.played', saved);
    if (saved.status === 'finished') {
      this.emitSessionEvent(saved, 'game.session.finished', saved);
    }
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

  private shouldRescheduleBeforeDeadline(session: GomokuSession | AlkkagiSession | OthelloSession, gameKey: 'gomoku' | 'alkkagi' | 'othello'): boolean {
    const deadline = session.networkGraceDeadlineAt ?? session.turnDeadlineAt;
    if (!deadline) {
      this.startTimedTurn(session, gameKey);
      return false;
    }
    return Date.parse(deadline) > Date.now() + 50;
  }

  private async resolveDisconnectGrace(session: GomokuSession | AlkkagiSession | OthelloSession, gameKey: 'gomoku' | 'alkkagi' | 'othello'): Promise<boolean> {
    if (!session.networkGraceDeadlineAt || !session.networkGraceAccountId) {
      return false;
    }
    if (Date.parse(session.networkGraceDeadlineAt) > Date.now() + 50) {
      this.scheduleTurnTimer(session, gameKey);
      return true;
    }
    if (await this.realtime.isAccountOnline(session.networkGraceAccountId)) {
      this.clearNetworkGrace(session);
      return false;
    }
    if (session.opponentLeftAt) {
      // 이미 상대 결정 대기 상태 — 타이머는 더 돌리지 않는다.
      this.clearTurnTimer(session.id);
      return true;
    }
    // D7: grace 만료 시 즉시 몰수하지 않고 남은 유저에게 선택권을 준다 (claim-win / 계속 대기).
    session.opponentLeftAt = new Date().toISOString();
    session.updatedAt = session.opponentLeftAt;
    this.clearTurnTimer(session.id);
    const saved = gameKey === 'gomoku'
      ? this.gomokuFromRow(await this.updateGame(session.id, session.status, (session as GomokuSession).currentTurn, session.winner ?? null, session))
      : gameKey === 'alkkagi'
        ? this.alkkagiFromRow(await this.updateGame(session.id, session.status, (session as AlkkagiSession).currentTurn, session.winner ?? null, session))
        : this.othelloFromRow(await this.updateGame(session.id, session.status, (session as OthelloSession).currentTurn, session.winner ?? null, session));
    this.emitSessionEvent(saved, 'game.opponent_left', saved);
    return true;
  }

  private async startDisconnectGrace(
    session: GomokuSession | AlkkagiSession | OthelloSession,
    gameKey: 'gomoku' | 'alkkagi' | 'othello',
    accountId: string,
  ): Promise<void> {
    const now = Date.now();
    session.networkGraceStartedAt = new Date(now).toISOString();
    session.networkGraceDeadlineAt = new Date(now + DISCONNECT_GRACE_MS).toISOString();
    session.networkGraceAccountId = accountId;
    session.updatedAt = new Date(now).toISOString();
    const saved = gameKey === 'gomoku'
      ? this.gomokuFromRow(await this.updateGame(session.id, session.status, (session as GomokuSession).currentTurn, session.winner ?? null, session))
      : gameKey === 'alkkagi'
        ? this.alkkagiFromRow(await this.updateGame(session.id, session.status, (session as AlkkagiSession).currentTurn, session.winner ?? null, session))
        : this.othelloFromRow(await this.updateGame(session.id, session.status, (session as OthelloSession).currentTurn, session.winner ?? null, session));
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

function tokenPayload(value: unknown): Partial<Record<SplendorToken, number>> {
  if (!isRecord(value)) {
    return {};
  }
  const tokens: Partial<Record<SplendorToken, number>> = {};
  for (const key of ['white', 'blue', 'green', 'red', 'black', 'gold'] as SplendorToken[]) {
    const amount = value[key];
    if (typeof amount === 'number' && Number.isFinite(amount)) {
      tokens[key] = amount;
    }
  }
  return tokens;
}

function splendorSeatForSide(session: SplendorSession, side: SplendorSide): number {
  const explicit = session.turnOrder?.filter((candidate) => Boolean(session.players[candidate]));
  const order = explicit && explicit.length > 0 ? explicit : Object.keys(session.players);
  const index = order.indexOf(side);
  return index >= 0 ? index : 0;
}

function alkkagiAnimationFromEngineResult(result: { events?: Array<{ type: string; payload?: unknown }> }): AlkkagiShotResult['animation'] {
  const event = result.events?.find((item) => item.type === 'alkkagi.shot.played');
  if (isRecord(event?.payload) && isRecord(event.payload.animation) && Array.isArray(event.payload.animation.frames)) {
    const frameMs = Number(event.payload.animation.frameMs);
    return {
      frameMs: Number.isFinite(frameMs) ? frameMs : 16,
      frames: event.payload.animation.frames as AlkkagiPiece[][],
    };
  }
  return { frameMs: 16, frames: [] };
}

function fortressShotResultFromEngineResult(
  result: { events?: Array<{ type: string; payload?: unknown }> },
  session: FortressSession,
): FortressShotResult {
  const event = result.events?.find((item) => item.type === 'fortress.shot.played');
  if (isRecord(event?.payload) && isRecord(event.payload.animation)) {
    const animation = event.payload.animation;
    const frameMs = Number(animation.frameMs);
    return {
      session,
      animation: {
        frameMs: Number.isFinite(frameMs) ? frameMs : 16,
        projectile: Array.isArray(animation.projectile) ? animation.projectile as Array<{ x: number; y: number }> : [],
        sequences: Array.isArray(animation.sequences) ? animation.sequences as FortressShotResult['animation']['sequences'] : undefined,
        terrainBefore: Array.isArray(animation.terrainBefore) ? animation.terrainBefore as number[] : session.terrain,
        terrainAfter: Array.isArray(animation.terrainAfter) ? animation.terrainAfter as number[] : session.terrain,
        tanksBefore: isRecord(animation.tanksBefore) ? animation.tanksBefore as FortressShotResult['animation']['tanksBefore'] : session.tanks,
        tanksAfter: isRecord(animation.tanksAfter) ? animation.tanksAfter as FortressShotResult['animation']['tanksAfter'] : session.tanks,
        impact: isRecord(animation.impact) ? animation.impact as FortressShotResult['animation']['impact'] : undefined,
      },
    };
  }
  return {
    session,
    animation: {
      frameMs: 16,
      projectile: [],
      terrainBefore: session.terrain,
      terrainAfter: session.terrain,
      tanksBefore: session.tanks,
      tanksAfter: session.tanks,
    },
  };
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
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function optionalSplendorSide(value: unknown): SplendorSide | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalCrazyArcadeSide(value: unknown): CrazyArcadeSide | undefined {
  return typeof value === 'string' && value.length > 0 ? value as CrazyArcadeSide : undefined;
}

function sessionForCrazyArcadeUser(session: CrazyArcadeSession, user: AuthAccount): CrazyArcadeSession {
  const mySide = Object.entries(session.players).find(([, accountId]) => accountId === user.accountId)?.[0] ??
    (user.permission === 'superadmin' ? Object.keys(session.players)[0] : undefined);
  const snapshot = mySide && isRecord(session.snapshot)
    ? crazyArcadeSnapshotForSide(session.snapshot, mySide)
    : session.snapshot;
  return {
    ...session,
    snapshot,
    mySide: mySide as CrazyArcadeSide | undefined,
  };
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
  const sides = new Set([...Object.keys(fallback), ...Object.keys(source)]);
  return Object.fromEntries(
    [...sides].map((side) => [
      side,
      splendorPlayerStateFromSnapshot(source[side], fallback[side] ?? {
        tokens: { white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 },
        bonuses: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
        reserved: [],
        purchased: [],
        nobles: [],
        score: 0,
      }),
    ]),
  );
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

function inferSessionSeats(
  gameKey: string,
  stateValue: unknown,
  ownerAccountId: string,
  opponentAccountId: string | null,
): Array<{
  seat: number;
  accountId: string | null;
  kind: 'account' | 'ai';
  aiDifficulty?: Difficulty;
  status: string;
}> {
  const state = isRecord(stateValue) ? stateValue : {};
  if (Array.isArray(state.roomPlayers)) {
    return state.roomPlayers
      .map((item, index) => {
        const record = isRecord(item) ? item : {};
        const accountId = typeof record.accountId === 'string' ? record.accountId : '';
        const kind: 'account' | 'ai' = record.kind === 'ai' || isLocalAiAccount(accountId) ? 'ai' : 'account';
        return {
          seat: typeof record.seat === 'number' && Number.isInteger(record.seat) ? record.seat : index,
          accountId: kind === 'ai' ? null : accountId,
          kind,
          aiDifficulty: kind === 'ai' ? difficultyFromSnapshot(record.aiDifficulty, difficultyFromSnapshot(state.aiDifficulty, 'medium')) : undefined,
          status: typeof record.status === 'string' ? record.status : 'active',
        };
      })
      .filter((item) => item.kind === 'ai' || Boolean(item.accountId));
  }
  const players = isRecord(state.players) ? state.players : undefined;
  const entries = players
    ? Object.values(players).map((value) => (typeof value === 'string' ? value : ''))
    : [ownerAccountId, opponentAccountId].filter((item): item is string => Boolean(item));
  const aiDifficulty = difficultyFromSnapshot(state.aiDifficulty, difficultyFromSnapshot(state.difficulty, 'medium'));
  return entries.map((accountId, seat) => ({
    seat,
    accountId: isLocalAiAccount(accountId) ? null : accountId,
    kind: isLocalAiAccount(accountId) ? 'ai' : 'account',
    aiDifficulty: isLocalAiAccount(accountId) ? aiDifficulty : undefined,
    status: 'active',
  }));
}

function sessionPlayerView(row: GameSessionPlayerRow): Record<string, unknown> {
  return {
    seat: row.seat,
    accountId: row.account_id,
    kind: row.kind,
    aiDifficulty: row.ai_difficulty,
    status: row.status,
    result: row.result,
    joinedAt: row.joined_at.toISOString(),
    leftAt: row.left_at?.toISOString() ?? null,
  };
}

function currentTurnAccountIdForRow(row: GameRow, seats: GameSessionPlayerRow[]): string | undefined {
  const state = isRecord(row.state_json) ? row.state_json : {};
  const players = isRecord(state.players) ? state.players as Record<string, unknown> : undefined;
  if (row.current_turn && players) {
    const accountId = players[row.current_turn];
    if (typeof accountId === 'string' && !isLocalAiAccount(accountId)) {
      return accountId;
    }
  }
  const currentSeat = typeof state.currentSeat === 'number'
    ? state.currentSeat
    : row.current_turn && /^\d+$/.test(row.current_turn)
      ? Number(row.current_turn)
      : undefined;
  if (typeof currentSeat === 'number') {
    const seat = seats.find((item) => item.seat === currentSeat);
    return seat?.account_id ?? undefined;
  }
  return undefined;
}

function roomMemberView(row: GameRoomMemberRow): Record<string, unknown> {
  return {
    accountId: row.account_id,
    account: {
      accountId: row.account_id,
      loginId: row.account_login_id || row.account_id,
      name: row.account_name || '',
      email: row.account_email || '',
      status: row.account_status || '',
      permissionKey: row.account_permission_key || '',
    },
    seat: row.seat,
    status: row.status,
    ready: row.ready,
    joinedAt: row.joined_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function nextRoomSeat(members: GameRoomMemberRow[]): number {
  const used = new Set(members.map((member) => member.seat));
  let seat = 0;
  while (used.has(seat)) {
    seat += 1;
  }
  return seat;
}

function mySeatFromPlayers(players: GameSessionPlayerRow[], accountId: string): number {
  return players.find((player) => player.account_id === accountId)?.seat ?? -1;
}

function stateVersionForGame(gameKey: string): number {
  return GAME_REGISTRY.engine(gameKey)?.stateVersion ?? (gameDescriptorFor(gameKey) ? 1 : 0);
}

function visibleStateForGame(gameKey: string, stateValue: unknown, accountId: string, seat: number): unknown {
  const engine = GAME_REGISTRY.engine(gameKey);
  if (engine) {
    try {
      return engine.viewFor(stateValue, Number.isInteger(seat) && seat >= 0 ? seat : 'spectator');
    } catch {
      // Legacy saves can still fall back to the pre-engine view filters below.
    }
  }
  const state = stateValue as Record<string, unknown>;
  if (gameKey === 'sudoku') {
    return hideSudokuSolutionForAccount(state as unknown as SudokuSession, accountId);
  }
  if (gameKey === 'sokoban') {
    return sessionForSokobanAccount(state as unknown as SokobanSession, accountId);
  }
  if (gameKey === 'splendor') {
    return splendorClientSession(state as unknown as SplendorSession, accountId);
  }
  if (gameKey === 'fortress') {
    return fortressClientSession(state as unknown as FortressSession, accountId);
  }
  if (gameKey === 'crazy_arcade') {
    return {
      ...(state as unknown as CrazyArcadeSession),
      mySide: (state.players as Record<string, string> | undefined)?.challenger === accountId
        ? 'challenger'
        : (state.players as Record<string, string> | undefined)?.opponent === accountId
          ? 'opponent'
          : undefined,
    };
  }
  return state;
}

function forkSavedStateForLocalAi(gameKey: string, stateValue: unknown, accountId: string, difficulty: Difficulty): Record<string, unknown> {
  if (!gameDescriptorFor(gameKey)) {
    throw new BadRequestException('unsupported gameKey');
  }
  const state = deepCloneRecord(stateValue);
  if (gameKey === 'sudoku') {
    return forkSavedSudokuAsSolo(state as unknown as SudokuSession, accountId);
  }
  if (gameKey === 'sokoban') {
    return forkSavedSokobanAsSolo(state as unknown as SokobanSession, accountId);
  }
  state.mode = 'local_ai';
  state.aiDifficulty = difficulty;
  state.id = '';
  state.createdAt = '';
  state.updatedAt = '';
  state.pause = undefined;
  state.networkGraceStartedAt = undefined;
  state.networkGraceDeadlineAt = undefined;
  state.networkGraceAccountId = undefined;
  state.opponentLeftAt = undefined;
  state.turnStartedAt = undefined;
  state.turnDeadlineAt = undefined;
  state.finishReason = undefined;
  const players = isRecord(state.players) ? state.players : undefined;
  if (players) {
    for (const key of Object.keys(players)) {
      players[key] = players[key] === accountId ? accountId : LOCAL_AI_ACCOUNT_ID;
    }
  }
  if (typeof state.ownerAccountId === 'string') {
    state.ownerAccountId = accountId;
  }
  if (gameKey === 'crazy_arcade') {
    state.inputs = Object.fromEntries(
      Object.keys(players ?? { challenger: accountId, opponent: LOCAL_AI_ACCOUNT_ID })
        .map((side) => [side, {}]),
    );
  }
  return state;
}

function forkSavedSudokuAsSolo(session: SudokuSession, accountId: string): Record<string, unknown> {
  const side = sudokuSideForAccount(session, accountId);
  const soloBoard = side ? cloneSudokuGrid(ensureSudokuPlayerBoard(session, side)) : cloneSudokuGrid(session.board);
  const state: SudokuSession = {
    ...session,
    id: '',
    mode: 'solo',
    ownerAccountId: accountId,
    board: soloBoard,
    status: 'playing',
    createdAt: '',
    updatedAt: '',
    players: undefined,
    boards: undefined,
    progress: undefined,
    battle: undefined,
    winnerAccountId: undefined,
    winnerSide: undefined,
    clearedAt: undefined,
    pause: undefined,
    finishReason: undefined,
  };
  return state as unknown as Record<string, unknown>;
}

function forkSavedSokobanAsSolo(session: SokobanSession, accountId: string): Record<string, unknown> {
  const side = sokobanSideForAccount(session, accountId);
  const playerState = side ? ensureSokobanPlayerState(session, side) : session.state;
  const state: SokobanSession = {
    ...session,
    id: '',
    mode: 'solo',
    ownerAccountId: accountId,
    state: {
      player: { ...playerState.player },
      boxes: playerState.boxes.map((box) => ({ ...box })),
      moves: playerState.moves,
      solved: playerState.solved,
    },
    status: 'playing',
    createdAt: '',
    updatedAt: '',
    players: undefined,
    states: undefined,
    winnerAccountId: undefined,
    winnerSide: undefined,
    mySide: undefined,
    pause: undefined,
    finishReason: undefined,
    solvedAt: undefined,
  };
  return state as unknown as Record<string, unknown>;
}

function deepCloneRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BadRequestException('saved state is invalid');
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function currentTurnForState(gameKey: string, state: Record<string, unknown>): string | null {
  if (typeof state.currentTurn === 'string') return state.currentTurn;
  if (gameKey === 'sudoku' || gameKey === 'sokoban' || gameKey === 'crazy_arcade') return null;
  return null;
}

function winnerForState(_gameKey: string, state: Record<string, unknown>): string | null {
  if (typeof state.winner === 'string') return state.winner;
  if (typeof state.winnerSide === 'string') return state.winnerSide;
  return null;
}

function statusForState(state: Record<string, unknown>): string {
  return typeof state.status === 'string' ? state.status : 'playing';
}

function isTerminalGameStatus(status: string): boolean {
  return status === 'finished' || status === 'cleared' || status === 'failed';
}

function modeForContinuedSave(gameKey: string): GameMode {
  return gameKey === 'sudoku' || gameKey === 'sokoban' ? 'solo' : 'local_ai';
}

function parseLocalAiResult(value: unknown): LocalAiResultInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const gameKey = typeof value.gameKey === 'string' ? value.gameKey : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
  if (!gameDescriptorFor(gameKey) || sessionId.length === 0 || sessionId.length > 160) {
    return undefined;
  }
  const result = typeof value.result === 'string' ? value.result : '';
  if (!['win', 'loss', 'draw'].includes(result)) {
    return undefined;
  }
  const difficulty = difficultyFromSnapshot(value.difficulty, 'medium');
  const reason = typeof value.reason === 'string' ? value.reason.slice(0, 120) : '';
  const parsedRecordedAt = typeof value.recordedAt === 'string' ? new Date(value.recordedAt) : new Date();
  const recordedAt = Number.isFinite(parsedRecordedAt.getTime()) ? parsedRecordedAt : new Date();
  return {
    gameKey,
    sessionId,
    result,
    difficulty,
    reason,
    recordedAt,
    payload: { ...value },
  };
}

function localAiResultKey(gameKey: string, sessionId: string): string {
  return `${gameKey}|${sessionId}`;
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

function validateOthelloIndex(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= OTHELLO_SIZE) {
    throw new BadRequestException(`${name} must be an integer from 0 to ${OTHELLO_SIZE - 1}`);
  }
}

function sessionForSokobanUser(session: SokobanSession, user: AuthAccount): SokobanSession {
  const side = session.players
    ? user.permission === 'superadmin'
      ? sokobanSides(session)[0]
      : sokobanSideForAccount(session, user.accountId)
    : undefined;
  if (!side) {
    return session;
  }
  return sessionForSokobanSide(session, side);
}

function sessionForSokobanAccount(session: SokobanSession, accountId: string): SokobanSession {
  const side = sokobanSideForAccount(session, accountId);
  if (!side) {
    return session;
  }
  return sessionForSokobanSide(session, side);
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue);
}

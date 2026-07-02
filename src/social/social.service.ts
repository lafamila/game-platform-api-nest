import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { env } from '../config/env';
import { AuthAccount, GamePlatformSession } from '../auth/auth.types';
import { hasPlayerAccess } from '../auth/roles';
import { GamesService } from '../games/games.service';
import { RealtimeService } from '../realtime/realtime.service';

interface FriendRequestRow {
  id: string;
  requester_account_id: string;
  recipient_account_id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface MatchRequestRow {
  id: string;
  game_key: string;
  requester_account_id: string;
  opponent_account_id: string;
  status: string;
  session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SocialAccountRow {
  account_id: string;
  login_id: string;
  name: string;
  email: string;
  status: string;
  permission_key: string;
  updated_at: Date;
}

interface SocialBlockRow {
  blocker_account_id: string;
  blocked_account_id: string;
  created_at: Date;
}

export interface SocialAccountView {
  accountId: string;
  loginId: string;
  name: string;
  email: string;
  status: string;
  permissionKey: string;
}

const SHADOW_PENDING_MS = 5 * 60 * 1000;

@Injectable()
export class SocialService {
  constructor(
    private readonly db: DatabaseService,
    private readonly games: GamesService,
    private readonly realtime: RealtimeService,
  ) {}

  async searchAccounts(q: string) {
    if (!q || q.trim().length < 1) {
      return { accounts: [] };
    }
    const url = new URL('/api/internal/service-accounts/search', env('AUTH_API_BASE_URL', 'http://localhost:3032'));
    url.searchParams.set('serviceKey', env('AUTH_SERVICE_KEY', 'game-platform'));
    url.searchParams.set('q', q.trim());
    const response = await fetch(url, {
      headers: {
        'x-auth-service-key-id': env('AUTH_SERVICE_KEY_ID'),
        'x-auth-service-secret': env('AUTH_SERVICE_SECRET'),
      },
    });
    if (!response.ok) {
      throw new BadRequestException(await responseText(response, 'Auth account search failed'));
    }
    const payload = await response.json();
    const accounts = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { accounts?: unknown }).accounts)
        ? (payload as { accounts: unknown[] }).accounts
        : [];
    const query = q.trim().toLowerCase();
    const normalized = accounts
      .map((item) => normalizeAccount(item))
      .filter((account) => account.loginId.toLowerCase() === query);
    await this.cacheAccounts(normalized);
    return { accounts: normalized };
  }

  async createFriendRequest(user: AuthAccount, recipientAccountId: string) {
    this.assertCanMatch(user);
    await this.cacheAuthAccount(user);
    if (recipientAccountId === user.accountId) {
      throw new BadRequestException('cannot add yourself');
    }
    const recipientStatus = await this.fetchPermissionUpgradeStatus(recipientAccountId);
    if (!hasPlayerPermissionKey(recipientStatus.currentPermission)) {
      throw new ForbiddenException('friend requests require a player account');
    }
    if (await this.areFriends(user.accountId, recipientAccountId)) {
      throw new BadRequestException('already friends');
    }
    if (await this.isBlocked(user.accountId, recipientAccountId)) {
      throw new BadRequestException('blocked account cannot be requested');
    }
    const shadowPending = await this.isBlocked(recipientAccountId, user.accountId);
    const result = await this.db.query<FriendRequestRow>(
      `INSERT INTO friend_requests (requester_account_id, recipient_account_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (requester_account_id, recipient_account_id)
       DO UPDATE SET status = EXCLUDED.status, created_at = now(), updated_at = now()
       RETURNING *`,
      [user.accountId, recipientAccountId, shadowPending ? 'shadow_pending' : 'pending'],
    );
    const request = await this.friendRequestResponse(result.rows[0]);
    if (!shadowPending) {
      this.realtime.emitToAccounts([recipientAccountId], 'friend.request.created', request);
    }
    return request;
  }

  async listFriendRequests(user: AuthAccount) {
    await this.cacheAuthAccount(user);
    const result = await this.db.query<FriendRequestRow>(
      `SELECT * FROM friend_requests
       WHERE (
          status = 'pending'
          AND (requester_account_id = $1 OR recipient_account_id = $1)
       ) OR (
          status = 'shadow_pending'
          AND requester_account_id = $1
          AND created_at > now() - ($2::text)::interval
       )
       ORDER BY updated_at DESC`,
      [user.accountId, `${SHADOW_PENDING_MS} milliseconds`],
    );
    return { requests: await this.friendRequestResponses(result.rows) };
  }

  async listFriends(user: AuthAccount) {
    await this.cacheAuthAccount(user);
    const result = await this.db.query<FriendRequestRow>(
      `SELECT * FROM friend_requests
       WHERE status = 'accepted'
         AND (requester_account_id = $1 OR recipient_account_id = $1)
       ORDER BY updated_at DESC`,
      [user.accountId],
    );
    const accountIds = result.rows.map((row) =>
      row.requester_account_id === user.accountId ? row.recipient_account_id : row.requester_account_id,
    );
    const accounts = await this.accountMap(accountIds);
    return {
      friends: result.rows.map((row) => {
        const accountId = row.requester_account_id === user.accountId ? row.recipient_account_id : row.requester_account_id;
        return {
          requestId: row.id,
          accountId,
          account: accounts.get(accountId) ?? accountViewFallback(accountId),
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        };
      }),
    };
  }

  async acceptFriendRequest(user: AuthAccount, id: string) {
    await this.cacheAuthAccount(user);
    const row = await this.db.one<FriendRequestRow>(`SELECT * FROM friend_requests WHERE id = $1`, [id]);
    if (!row) {
      throw new NotFoundException('Friend request not found');
    }
    if (row.recipient_account_id !== user.accountId) {
      throw new BadRequestException('only recipient can accept');
    }
    if (row.status !== 'pending') {
      throw new BadRequestException('friend request is not pending');
    }
    const result = await this.db.query<FriendRequestRow>(
      `UPDATE friend_requests SET status = 'accepted', updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    const request = await this.friendRequestResponse(result.rows[0]);
    this.realtime.emitToAccounts([row.requester_account_id, row.recipient_account_id], 'friend.request.accepted', request);
    return request;
  }

  async rejectFriendRequest(user: AuthAccount, id: string) {
    await this.cacheAuthAccount(user);
    const row = await this.db.one<FriendRequestRow>(`SELECT * FROM friend_requests WHERE id = $1`, [id]);
    if (!row) {
      throw new NotFoundException('Friend request not found');
    }
    if (row.recipient_account_id !== user.accountId) {
      throw new BadRequestException('only recipient can reject');
    }
    if (row.status !== 'pending') {
      throw new BadRequestException('friend request is not pending');
    }
    const result = await this.db.query<FriendRequestRow>(
      `UPDATE friend_requests SET status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    const request = await this.friendRequestResponse(result.rows[0]);
    this.realtime.emitToAccounts([row.requester_account_id, row.recipient_account_id], 'friend.request.rejected', request);
    return request;
  }

  async listBlocks(user: AuthAccount) {
    await this.cacheAuthAccount(user);
    const result = await this.db.query<SocialBlockRow>(
      `SELECT blocker_account_id, blocked_account_id, created_at
       FROM social_blocks
       WHERE blocker_account_id = $1
       ORDER BY created_at DESC`,
      [user.accountId],
    );
    const accounts = await this.accountMap(result.rows.map((row) => row.blocked_account_id));
    return {
      blocks: result.rows.map((row) => ({
        accountId: row.blocked_account_id,
        account: accounts.get(row.blocked_account_id) ?? accountViewFallback(row.blocked_account_id),
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async blockAccount(user: AuthAccount, blockedAccountId: string) {
    await this.cacheAuthAccount(user);
    if (blockedAccountId === user.accountId) {
      throw new BadRequestException('cannot block yourself');
    }
    const result = await this.db.query<SocialBlockRow>(
      `INSERT INTO social_blocks (blocker_account_id, blocked_account_id)
       VALUES ($1, $2)
       ON CONFLICT (blocker_account_id, blocked_account_id) DO UPDATE SET created_at = social_blocks.created_at
       RETURNING blocker_account_id, blocked_account_id, created_at`,
      [user.accountId, blockedAccountId],
    );
    await this.db.query(
      `UPDATE friend_requests
       SET status = 'blocked', updated_at = now()
       WHERE (requester_account_id = $1 AND recipient_account_id = $2)
          OR (requester_account_id = $2 AND recipient_account_id = $1)`,
      [user.accountId, blockedAccountId],
    );
    const accounts = await this.accountMap([blockedAccountId]);
    const block = {
      accountId: blockedAccountId,
      account: accounts.get(blockedAccountId) ?? accountViewFallback(blockedAccountId),
      createdAt: result.rows[0].created_at.toISOString(),
    };
    this.realtime.emitToAccounts([user.accountId], 'friend.block.created', block);
    return block;
  }

  async unblockAccount(user: AuthAccount, blockedAccountId: string) {
    await this.db.query(
      `DELETE FROM social_blocks WHERE blocker_account_id = $1 AND blocked_account_id = $2`,
      [user.accountId, blockedAccountId],
    );
    return { ok: true };
  }

  async createMatchRequest(user: AuthAccount, input: { gameKey: string; opponentAccountId: string }) {
    this.assertCanMatch(user);
    if (!['sudoku', 'gomoku', 'alkkagi'].includes(input.gameKey)) {
      throw new BadRequestException('gameKey must be sudoku, gomoku, or alkkagi');
    }
    if (input.opponentAccountId === user.accountId) {
      throw new BadRequestException('opponent must be another account');
    }
    await this.assertAreFriends(user.accountId, input.opponentAccountId);
    const result = await this.db.query<MatchRequestRow>(
      `INSERT INTO match_requests (game_key, requester_account_id, opponent_account_id, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [input.gameKey, user.accountId, input.opponentAccountId],
    );
    const request = await this.matchRequestResponse(result.rows[0]);
    this.realtime.emitToAccounts([input.opponentAccountId], 'match.request.created', request);
    return request;
  }

  async listMatchRequests(user: AuthAccount) {
    const result = await this.db.query<MatchRequestRow>(
      `SELECT * FROM match_requests
       WHERE requester_account_id = $1 OR opponent_account_id = $1
       ORDER BY updated_at DESC`,
      [user.accountId],
    );
    return { requests: await this.matchRequestResponses(result.rows) };
  }

  async acceptMatchRequest(user: AuthAccount, id: string) {
    this.assertCanMatch(user);
    const row = await this.db.one<MatchRequestRow>(`SELECT * FROM match_requests WHERE id = $1`, [id]);
    if (!row) {
      throw new NotFoundException('Match request not found');
    }
    if (row.opponent_account_id !== user.accountId) {
      throw new BadRequestException('only opponent can accept');
    }
    if (row.status !== 'pending') {
      throw new BadRequestException('match request is not pending');
    }
    await this.assertAreFriends(row.requester_account_id, row.opponent_account_id);
    const sessionId = await this.games.createSessionFromMatch(row.game_key, row.requester_account_id, row.opponent_account_id);
    const result = await this.db.query<MatchRequestRow>(
      `UPDATE match_requests SET status = 'accepted', session_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, sessionId],
    );
    const request = await this.matchRequestResponse(result.rows[0]);
    this.realtime.emitToAccounts([row.requester_account_id, row.opponent_account_id], 'match.request.accepted', request);
    return request;
  }

  async rejectMatchRequest(user: AuthAccount, id: string) {
    const row = await this.db.one<MatchRequestRow>(`SELECT * FROM match_requests WHERE id = $1`, [id]);
    if (!row) {
      throw new NotFoundException('Match request not found');
    }
    if (row.opponent_account_id !== user.accountId && row.requester_account_id !== user.accountId) {
      throw new BadRequestException('not a participant');
    }
    if (row.status !== 'pending') {
      throw new BadRequestException('match request is not pending');
    }
    const nextStatus = row.requester_account_id === user.accountId ? 'cancelled' : 'rejected';
    const result = await this.db.query<MatchRequestRow>(
      `UPDATE match_requests SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, nextStatus],
    );
    const request = await this.matchRequestResponse(result.rows[0]);
    this.realtime.emitToAccounts([row.requester_account_id, row.opponent_account_id], `match.request.${nextStatus}`, request);
    return request;
  }

  async createPermissionUpgradeRequest(session: GamePlatformSession | undefined) {
    if (!session?.accessToken) {
      throw new UnauthorizedException('Game-platform session is required');
    }
    if (hasPlayerAccess(session.account)) {
      return { alreadyAllowed: true, permission: session.account.permission };
    }
    const response = await fetch(`${env('AUTH_API_BASE_URL', 'http://localhost:3032')}/api/service-applications`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceKey: env('AUTH_SERVICE_KEY', 'game-platform'),
        message: 'game-platform 서비스를 매칭 플레이어로 이용하기 위해 player 권한 상승을 요청합니다.',
      }),
    });
    if (!response.ok) {
      throw new BadRequestException(await responseText(response, 'Permission upgrade request failed'));
    }
    const body = await response.json();
    return { alreadyAllowed: false, status: 'pending', request: body };
  }

  async getPermissionUpgradeStatus(session: GamePlatformSession | undefined) {
    if (!session) {
      throw new UnauthorizedException('Game-platform session is required');
    }
    const status = await this.fetchPermissionUpgradeStatus(session.account.accountId);
    return {
      ...status,
      sessionPermission: session.account.permission,
      hasPlayerAccess: hasPlayerAccess(session.account),
    };
  }

  private assertCanMatch(user: AuthAccount): void {
    if (!hasPlayerAccess(user)) {
      throw new ForbiddenException('player permission is required for matching');
    }
  }

  private async assertAreFriends(leftAccountId: string, rightAccountId: string): Promise<void> {
    if (!(await this.areFriends(leftAccountId, rightAccountId))) {
      throw new ForbiddenException('matching is only available between friends');
    }
  }

  private async areFriends(leftAccountId: string, rightAccountId: string): Promise<boolean> {
    const row = await this.db.one<FriendRequestRow>(
      `SELECT * FROM friend_requests
       WHERE status = 'accepted'
         AND (
           (requester_account_id = $1 AND recipient_account_id = $2)
           OR (requester_account_id = $2 AND recipient_account_id = $1)
         )`,
      [leftAccountId, rightAccountId],
    );
    return Boolean(row);
  }

  private async isBlocked(blockerAccountId: string, blockedAccountId: string): Promise<boolean> {
    const row = await this.db.one<SocialBlockRow>(
      `SELECT blocker_account_id, blocked_account_id, created_at
       FROM social_blocks
       WHERE blocker_account_id = $1 AND blocked_account_id = $2`,
      [blockerAccountId, blockedAccountId],
    );
    return Boolean(row);
  }

  private async cacheAuthAccount(user: AuthAccount): Promise<void> {
    await this.cacheAccounts([{
      accountId: user.accountId,
      loginId: user.loginId ?? '',
      name: user.name ?? '',
      email: user.email ?? '',
      status: '',
      permissionKey: user.permission,
    }]);
  }

  private async fetchPermissionUpgradeStatus(accountId: string): Promise<{
    accountId: string;
    serviceKey: string;
    currentPermission: string | null;
    status: 'none' | 'pending' | 'approved' | 'rejected';
    application?: unknown;
  }> {
    const serviceKey = env('AUTH_SERVICE_KEY', 'game-platform');
    const url = new URL('/api/internal/service-applications/status', env('AUTH_API_BASE_URL', 'http://localhost:3032'));
    url.searchParams.set('serviceKey', serviceKey);
    url.searchParams.set('accountId', accountId);
    const response = await fetch(url, {
      headers: {
        'x-auth-service-key-id': env('AUTH_SERVICE_KEY_ID'),
        'x-auth-service-secret': env('AUTH_SERVICE_SECRET'),
      },
    });
    if (!response.ok) {
      throw new BadRequestException(await responseText(response, 'Permission status lookup failed'));
    }
    return (await response.json()) as {
      accountId: string;
      serviceKey: string;
      currentPermission: string | null;
      status: 'none' | 'pending' | 'approved' | 'rejected';
      application?: unknown;
    };
  }

  private async cacheAccounts(accounts: SocialAccountView[]): Promise<void> {
    for (const account of accounts.filter((item) => item.accountId)) {
      await this.db.query(
        `INSERT INTO social_accounts
         (account_id, login_id, name, email, status, permission_key, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (account_id)
         DO UPDATE SET
           login_id = EXCLUDED.login_id,
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           status = EXCLUDED.status,
           permission_key = EXCLUDED.permission_key,
           updated_at = now()`,
        [account.accountId, account.loginId, account.name, account.email, account.status, account.permissionKey],
      );
    }
  }

  private async accountMap(accountIds: string[]): Promise<Map<string, SocialAccountView>> {
    const uniqueIds = [...new Set(accountIds.filter(Boolean))];
    const map = new Map<string, SocialAccountView>();
    for (const accountId of uniqueIds) {
      map.set(accountId, accountViewFallback(accountId));
    }
    if (uniqueIds.length === 0) {
      return map;
    }
    const result = await this.db.query<SocialAccountRow>(
      `SELECT account_id, login_id, name, email, status, permission_key, updated_at
       FROM social_accounts
       WHERE account_id = ANY($1::text[])`,
      [uniqueIds],
    );
    for (const row of result.rows) {
      map.set(row.account_id, accountViewFromRow(row));
    }
    return map;
  }

  private async friendRequestResponse(row: FriendRequestRow) {
    const responses = await this.friendRequestResponses([row]);
    return responses[0];
  }

  private async friendRequestResponses(rows: FriendRequestRow[]) {
    const accounts = await this.accountMap(rows.flatMap((row) => [row.requester_account_id, row.recipient_account_id]));
    return rows.map((row) => friendRequestView(row, accounts));
  }

  private async matchRequestResponse(row: MatchRequestRow) {
    const responses = await this.matchRequestResponses([row]);
    return responses[0];
  }

  private async matchRequestResponses(rows: MatchRequestRow[]) {
    const accounts = await this.accountMap(rows.flatMap((row) => [row.requester_account_id, row.opponent_account_id]));
    return rows.map((row) => matchRequestView(row, accounts));
  }
}

function normalizeAccount(value: unknown): SocialAccountView & { isSuperAdmin: boolean } {
  const account = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    accountId: String(account.accountId ?? account.id ?? ''),
    loginId: String(account.loginId ?? ''),
    name: String(account.name ?? ''),
    email: String(account.email ?? ''),
    status: String(account.status ?? ''),
    permissionKey: String(account.permissionKey ?? ''),
    isSuperAdmin: account.isSuperAdmin === true,
  };
}

function accountViewFallback(accountId: string): SocialAccountView {
  return {
    accountId,
    loginId: accountId,
    name: '',
    email: '',
    status: '',
    permissionKey: '',
  };
}

function accountViewFromRow(row: SocialAccountRow): SocialAccountView {
  return {
    accountId: row.account_id,
    loginId: row.login_id,
    name: row.name,
    email: row.email,
    status: row.status,
    permissionKey: row.permission_key,
  };
}

function hasPlayerPermissionKey(permission: string | null | undefined): boolean {
  return ['player', 'premium', 'superadmin'].includes(String(permission ?? '').toLowerCase());
}

function friendRequestView(row: FriendRequestRow, accounts: Map<string, SocialAccountView>) {
  return {
    id: row.id,
    requesterAccountId: row.requester_account_id,
    recipientAccountId: row.recipient_account_id,
    requester: accounts.get(row.requester_account_id) ?? accountViewFallback(row.requester_account_id),
    recipient: accounts.get(row.recipient_account_id) ?? accountViewFallback(row.recipient_account_id),
    status: row.status === 'shadow_pending' ? 'pending' : row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function matchRequestView(row: MatchRequestRow, accounts: Map<string, SocialAccountView>) {
  return {
    id: row.id,
    gameKey: row.game_key,
    requesterAccountId: row.requester_account_id,
    opponentAccountId: row.opponent_account_id,
    requester: accounts.get(row.requester_account_id) ?? accountViewFallback(row.requester_account_id),
    opponent: accounts.get(row.opponent_account_id) ?? accountViewFallback(row.opponent_account_id),
    status: row.status,
    sessionId: row.session_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function responseText(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; message?: string; error_description?: string };
    return body.detail ?? body.message ?? body.error_description ?? fallback;
  } catch {
    return fallback;
  }
}

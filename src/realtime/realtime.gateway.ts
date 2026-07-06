import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { AuthAccount } from '../auth/auth.types';
import { GamePlatformSessionService } from '../auth/session.service';
import { listEnv } from '../config/env';
import { GamesService } from '../games/games.service';
import { RealtimeService } from './realtime.service';

export function accountRoom(accountId: string): string {
  return `account:${accountId}`;
}

function allowedOrigins(): string[] | boolean {
  const origins = listEnv('GAME_PLATFORM_ALLOWED_ORIGINS');
  return origins.length > 0 ? origins : true;
}

@WebSocketGateway({
  path: '/api/socket.io',
  cors: { origin: allowedOrigins(), credentials: true },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly sessions: GamePlatformSessionService,
    private readonly realtime: RealtimeService,
    private readonly games: GamesService,
  ) {}

  afterInit(server: Server): void {
    this.realtime.attachSocketServer(server);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const session = await this.sessions.requireSession(this.extractSessionId(client));
      const accountId = session.account.accountId;
      const connectionId = randomUUID();
      client.data.accountId = accountId;
      client.data.account = session.account;
      client.data.connectionId = connectionId;
      await client.join(accountRoom(accountId));
      this.realtime.registerSocketConnection(accountId, connectionId);
      client.emit('connected', { accountId });
    } catch (error) {
      const response = hasGetResponse(error) ? (error.getResponse() as { code?: string; message?: string }) : undefined;
      client.emit('auth_error', {
        code: response?.code ?? 'AUTH_REQUIRED',
        message: response?.message ?? (error instanceof Error ? error.message : 'Game-platform session is required'),
      });
      client.disconnect(true);
    }
  }

  @SubscribeMessage('crazy_arcade.input')
  async handleCrazyArcadeInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true; session: unknown } | { ok: false; code: string; message: string }> {
    try {
      const account = client.data?.account as AuthAccount | undefined;
      if (!account) {
        throw new UnauthorizedException('Game-platform socket session is required');
      }
      const payload = isRecord(body) ? body : {};
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
      if (!sessionId) {
        throw new BadRequestException('sessionId is required');
      }
      const input = isRecord(payload.input) ? payload.input : {};
      const clientMoveId = typeof payload.clientMoveId === 'string' && payload.clientMoveId.trim()
        ? payload.clientMoveId.trim()
        : undefined;
      return {
        ok: true,
        session: await this.games.enqueueCrazyArcadeSocketInput(sessionId, account, input, clientMoveId),
      };
    } catch (error) {
      const response = hasGetResponse(error) ? (error.getResponse() as { code?: string; message?: string }) : undefined;
      return {
        ok: false,
        code: response?.code ?? 'CRAZY_ARCADE_INPUT_FAILED',
        message: response?.message ?? (error instanceof Error ? error.message : 'Crazy Arcade input failed'),
      };
    }
  }

  handleDisconnect(client: Socket): void {
    const accountId = client.data?.accountId as string | undefined;
    const connectionId = client.data?.connectionId as string | undefined;
    if (accountId && connectionId) {
      this.realtime.unregisterSocketConnection(accountId, connectionId);
    }
  }

  private extractSessionId(client: Socket): string | undefined {
    const header = client.handshake.headers['x-game-platform-session'];
    if (typeof header === 'string' && header.trim()) {
      return header.trim();
    }
    const auth = (client.handshake.auth as { sessionId?: unknown } | undefined)?.sessionId;
    return typeof auth === 'string' && auth.trim() ? auth.trim() : undefined;
  }
}

function hasGetResponse(error: unknown): error is { getResponse: () => unknown } {
  return typeof (error as { getResponse?: unknown })?.getResponse === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

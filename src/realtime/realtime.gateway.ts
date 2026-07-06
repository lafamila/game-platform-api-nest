import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { GamePlatformSessionService } from '../auth/session.service';
import { listEnv } from '../config/env';
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

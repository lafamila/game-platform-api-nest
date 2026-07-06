import { Injectable } from '@nestjs/common';
import { MessageEvent } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable, Subject, interval, map, merge } from 'rxjs';
import type { Server } from 'socket.io';
import { PresenceService } from './presence.service';

export interface PresenceChange {
  accountId: string;
  online: boolean;
}

@Injectable()
export class RealtimeService {
  private readonly accountStreams = new Map<string, Subject<MessageEvent>>();
  private readonly connectionCounts = new Map<string, number>();
  private readonly presenceSubject = new Subject<PresenceChange>();
  private readonly socketRefreshTimers = new Map<string, ReturnType<typeof setInterval>>();
  private socketServer?: Server;

  constructor(private readonly presence: PresenceService) {}

  streamForAccount(accountId: string): Observable<MessageEvent> {
    const subject = this.subjectFor(accountId);
    const heartbeat = interval(25_000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: { at: new Date().toISOString() },
      })),
    );
    return new Observable<MessageEvent>((subscriber) => {
      const connectionId = randomUUID();
      this.setConnectionCount(accountId, 1);
      void this.presence.connect(accountId, connectionId).then((changed) => {
        if (changed) {
          this.presenceSubject.next({ accountId, online: true });
        }
      });
      const refreshTimer = setInterval(() => {
        void this.presence.refresh(accountId, connectionId);
      }, 25_000);
      const subscription = merge(subject.asObservable(), heartbeat).subscribe(subscriber);
      return () => {
        clearInterval(refreshTimer);
        subscription.unsubscribe();
        this.setConnectionCount(accountId, -1);
        void this.presence.disconnect(accountId, connectionId).then((changed) => {
          if (changed) {
            this.presenceSubject.next({ accountId, online: false });
          }
        });
      };
    });
  }

  emitToAccounts(accountIds: string[], event: string, data: unknown): void {
    for (const accountId of accountIds.filter(Boolean)) {
      const payload = normalizeMessageData(data);
      this.subjectFor(accountId).next({
        type: event,
        data: payload,
      });
      this.socketServer?.to(`account:${accountId}`).emit(event, payload);
    }
  }

  attachSocketServer(server: Server): void {
    this.socketServer = server;
  }

  registerSocketConnection(accountId: string, connectionId: string): void {
    this.setConnectionCount(accountId, 1);
    void this.presence.connect(accountId, connectionId).then((changed) => {
      if (changed) {
        this.presenceSubject.next({ accountId, online: true });
      }
    });
    const refreshTimer = setInterval(() => {
      void this.presence.refresh(accountId, connectionId);
    }, 25_000);
    refreshTimer.unref?.();
    this.socketRefreshTimers.set(connectionId, refreshTimer);
  }

  unregisterSocketConnection(accountId: string, connectionId: string): void {
    const timer = this.socketRefreshTimers.get(connectionId);
    if (timer) {
      clearInterval(timer);
      this.socketRefreshTimers.delete(connectionId);
    }
    this.setConnectionCount(accountId, -1);
    void this.presence.disconnect(accountId, connectionId).then((changed) => {
      if (changed) {
        this.presenceSubject.next({ accountId, online: false });
      }
    });
  }

  isAccountConnected(accountId: string | undefined): boolean {
    if (!accountId) {
      return false;
    }
    return (this.connectionCounts.get(accountId) ?? 0) > 0;
  }

  presenceChanges(): Observable<PresenceChange> {
    return this.presenceSubject.asObservable();
  }

  private subjectFor(accountId: string): Subject<MessageEvent> {
    let subject = this.accountStreams.get(accountId);
    if (!subject) {
      subject = new Subject<MessageEvent>();
      this.accountStreams.set(accountId, subject);
    }
    return subject;
  }

  private setConnectionCount(accountId: string, delta: 1 | -1): void {
    const next = Math.max(0, (this.connectionCounts.get(accountId) ?? 0) + delta);
    if (next === 0) {
      this.connectionCounts.delete(accountId);
      return;
    }
    this.connectionCounts.set(accountId, next);
  }
}

function normalizeMessageData(data: unknown): string | object {
  if (typeof data === 'string') {
    return data;
  }
  if (data && typeof data === 'object') {
    return data;
  }
  return { value: data };
}

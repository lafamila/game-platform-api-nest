import { Injectable } from '@nestjs/common';
import { MessageEvent } from '@nestjs/common';
import { Observable, Subject, interval, map, merge } from 'rxjs';

@Injectable()
export class RealtimeService {
  private readonly accountStreams = new Map<string, Subject<MessageEvent>>();
  private readonly connectionCounts = new Map<string, number>();

  streamForAccount(accountId: string): Observable<MessageEvent> {
    const subject = this.subjectFor(accountId);
    const heartbeat = interval(25_000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: { at: new Date().toISOString() },
      })),
    );
    return new Observable<MessageEvent>((subscriber) => {
      this.setConnectionCount(accountId, 1);
      const subscription = merge(subject.asObservable(), heartbeat).subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        this.setConnectionCount(accountId, -1);
      };
    });
  }

  emitToAccounts(accountIds: string[], event: string, data: unknown): void {
    for (const accountId of accountIds.filter(Boolean)) {
      this.subjectFor(accountId).next({
        type: event,
        data: normalizeMessageData(data),
      });
    }
  }

  isAccountConnected(accountId: string | undefined): boolean {
    if (!accountId) {
      return false;
    }
    return (this.connectionCounts.get(accountId) ?? 0) > 0;
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

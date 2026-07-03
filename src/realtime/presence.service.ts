import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient } from 'redis';
import { env, intEnv } from '../config/env';

interface PresenceRedisClient {
  readonly isOpen: boolean;
  quit(): Promise<unknown>;
  sAdd(key: string, member: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean | number>;
  sCard(key: string): Promise<number>;
  sRem(key: string, member: string): Promise<number>;
  del(key: string): Promise<number>;
}

@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly fallbackConnections = new Map<string, Set<string>>();
  private readonly keyPrefix = env('PRESENCE_REDIS_PREFIX', 'game-platform:presence');
  private readonly ttlSeconds = intEnv('PRESENCE_TTL_SECONDS', 75);
  private redis?: PresenceRedisClient;

  async onModuleInit(): Promise<void> {
    const redisUrl = env('REDIS_URL', '');
    if (!redisUrl) {
      this.logger.warn('REDIS_URL is not set; using in-memory presence fallback');
      return;
    }
    const client = createClient({ url: redisUrl });
    client.on('error', (error) => {
      this.logger.warn(`Redis presence error: ${error instanceof Error ? error.message : String(error)}`);
    });
    try {
      await client.connect();
      this.redis = client as unknown as PresenceRedisClient;
      this.logger.log('Redis presence connected');
    } catch (error) {
      this.redis = undefined;
      this.logger.warn(`Redis presence unavailable; using in-memory fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis?.isOpen) {
      await this.redis.quit();
    }
  }

  async connect(accountId: string, connectionId: string): Promise<boolean> {
    const wasOnline = await this.isOnline(accountId);
    await this.addConnection(accountId, connectionId);
    return !wasOnline && await this.isOnline(accountId);
  }

  async refresh(accountId: string, connectionId: string): Promise<void> {
    const redis = this.redis;
    if (!redis?.isOpen) {
      return;
    }
    try {
      await redis.sAdd(this.accountKey(accountId), connectionId);
      await redis.expire(this.accountKey(accountId), this.ttlSeconds);
    } catch (error) {
      this.logger.warn(`Redis presence refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(accountId: string, connectionId: string): Promise<boolean> {
    const wasOnline = await this.isOnline(accountId);
    await this.removeConnection(accountId, connectionId);
    return wasOnline && !(await this.isOnline(accountId));
  }

  async isOnline(accountId: string | undefined): Promise<boolean> {
    if (!accountId) {
      return false;
    }
    const redis = this.redis;
    if (!redis?.isOpen) {
      return (this.fallbackConnections.get(accountId)?.size ?? 0) > 0;
    }
    try {
      return await redis.sCard(this.accountKey(accountId)) > 0;
    } catch (error) {
      this.logger.warn(`Redis presence lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return (this.fallbackConnections.get(accountId)?.size ?? 0) > 0;
    }
  }

  async onlineMap(accountIds: string[]): Promise<Map<string, boolean>> {
    const uniqueIds = [...new Set(accountIds.filter(Boolean))];
    const entries = await Promise.all(uniqueIds.map(async (accountId) => [accountId, await this.isOnline(accountId)] as const));
    return new Map(entries);
  }

  private async addConnection(accountId: string, connectionId: string): Promise<void> {
    const redis = this.redis;
    if (!redis?.isOpen) {
      this.fallbackSet(accountId).add(connectionId);
      return;
    }
    try {
      await redis.sAdd(this.accountKey(accountId), connectionId);
      await redis.expire(this.accountKey(accountId), this.ttlSeconds);
    } catch (error) {
      this.logger.warn(`Redis presence connect failed: ${error instanceof Error ? error.message : String(error)}`);
      this.fallbackSet(accountId).add(connectionId);
    }
  }

  private async removeConnection(accountId: string, connectionId: string): Promise<void> {
    const redis = this.redis;
    if (!redis?.isOpen) {
      this.removeFallbackConnection(accountId, connectionId);
      return;
    }
    try {
      const key = this.accountKey(accountId);
      await redis.sRem(key, connectionId);
      if (await redis.sCard(key) === 0) {
        await redis.del(key);
      } else {
        await redis.expire(key, this.ttlSeconds);
      }
    } catch (error) {
      this.logger.warn(`Redis presence disconnect failed: ${error instanceof Error ? error.message : String(error)}`);
      this.removeFallbackConnection(accountId, connectionId);
    }
  }

  private fallbackSet(accountId: string): Set<string> {
    let set = this.fallbackConnections.get(accountId);
    if (!set) {
      set = new Set<string>();
      this.fallbackConnections.set(accountId, set);
    }
    return set;
  }

  private removeFallbackConnection(accountId: string, connectionId: string): void {
    const set = this.fallbackConnections.get(accountId);
    if (!set) {
      return;
    }
    set.delete(connectionId);
    if (set.size === 0) {
      this.fallbackConnections.delete(accountId);
    }
  }

  private accountKey(accountId: string): string {
    return `${this.keyPrefix}:account:${accountId}:connections`;
  }
}

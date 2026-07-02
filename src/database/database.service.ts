import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { env } from '../config/env';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/game_platform'),
  });
  private readyPromise?: Promise<void>;

  async onModuleInit(): Promise<void> {
    await this.ready();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.query<T>(sql, params);
    return result.rows[0];
  }

  ready(): Promise<void> {
    this.readyPromise ??= this.migrate();
    return this.readyPromise;
  }

  private async migrate(): Promise<void> {
    await this.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await this.query(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        id text PRIMARY KEY,
        account_id text NOT NULL,
        user_json jsonb NOT NULL,
        access_token text NOT NULL,
        refresh_token text NOT NULL,
        access_token_expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_app_sessions_account ON app_sessions(account_id)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS login_transactions (
        id text PRIMARY KEY,
        state text NOT NULL UNIQUE,
        verifier text NOT NULL,
        code_challenge text NOT NULL,
        return_uri text NULL,
        status text NOT NULL,
        session_id text NULL,
        error_code text NULL,
        error text NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS game_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_key text NOT NULL,
        mode text NOT NULL,
        status text NOT NULL,
        current_turn text NULL,
        winner text NULL,
        owner_account_id text NOT NULL,
        opponent_account_id text NULL,
        state_json jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_game_sessions_owner ON game_sessions(owner_account_id)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_game_sessions_opponent ON game_sessions(opponent_account_id)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS friend_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_account_id text NOT NULL,
        recipient_account_id text NOT NULL,
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(requester_account_id, recipient_account_id)
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient ON friend_requests(recipient_account_id)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS social_accounts (
        account_id text PRIMARY KEY,
        login_id text NOT NULL DEFAULT '',
        name text NOT NULL DEFAULT '',
        email text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT '',
        permission_key text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_social_accounts_login_id ON social_accounts(login_id)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS social_blocks (
        blocker_account_id text NOT NULL,
        blocked_account_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(blocker_account_id, blocked_account_id)
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_social_blocks_blocked ON social_blocks(blocked_account_id)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS match_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_key text NOT NULL,
        requester_account_id text NOT NULL,
        opponent_account_id text NOT NULL,
        status text NOT NULL,
        session_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_match_requests_requester ON match_requests(requester_account_id)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_match_requests_opponent ON match_requests(opponent_account_id)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS custom_emotes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id text NOT NULL,
        slot integer NOT NULL CHECK (slot >= 1 AND slot <= 3),
        grid_size integer NOT NULL CHECK (grid_size IN (8, 16)),
        cells_json jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(account_id, slot)
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_custom_emotes_account ON custom_emotes(account_id, slot)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS client_error_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id text NOT NULL,
        method text NOT NULL DEFAULT '',
        path text NOT NULL DEFAULT '',
        status_code integer NULL,
        message text NOT NULL DEFAULT '',
        context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_client_error_reports_account ON client_error_reports(account_id, created_at DESC)`);
  }
}

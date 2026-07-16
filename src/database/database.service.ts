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
    // 세션 keepalive job(refresh 체인 유지)이 refresh token 발급 시각을 추적하기 위한 컬럼.
    await this.query(`ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS refresh_token_issued_at timestamptz`);
    await this.query(`UPDATE app_sessions SET refresh_token_issued_at = created_at WHERE refresh_token_issued_at IS NULL`);
    await this.query(
      `CREATE INDEX IF NOT EXISTS idx_app_sessions_refresh_issued ON app_sessions(refresh_token_issued_at) WHERE refresh_token_issued_at IS NOT NULL`,
    );

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
      CREATE TABLE IF NOT EXISTS ai_decisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
        ply integer NOT NULL CHECK (ply >= 0),
        game_key text NOT NULL,
        engine_version text NOT NULL,
        color text NOT NULL,
        board_hash text NOT NULL,
        chosen_row integer NULL,
        chosen_col integer NULL,
        budget_ms integer NOT NULL,
        elapsed_ms integer NOT NULL,
        completed_depth integer NOT NULL,
        search_nodes integer NOT NULL,
        vcf_nodes integer NOT NULL,
        vct_nodes integer NOT NULL,
        evaluation_calls integer NOT NULL,
        forbidden_checks integer NOT NULL,
        candidate_generations integer NOT NULL,
        score integer NOT NULL,
        principal_variation_json jsonb NOT NULL DEFAULT '[]'::jsonb,
        exit_reason text NOT NULL,
        decision_source text NOT NULL DEFAULT 'search_final',
        fallback_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(session_id, ply, color)
      )
    `);
    await this.query(`ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS decision_source text NOT NULL DEFAULT 'search_final'`);
    await this.query(`ALTER TABLE ai_decisions ADD COLUMN IF NOT EXISTS fallback_reason text NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_ai_decisions_session ON ai_decisions(session_id, ply)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_ai_decisions_game_created ON ai_decisions(game_key, created_at DESC)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS game_session_players (
        session_id uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
        seat integer NOT NULL CHECK (seat >= 0),
        account_id text NULL,
        kind text NOT NULL DEFAULT 'account',
        ai_difficulty text NULL,
        status text NOT NULL DEFAULT 'active',
        result text NULL,
        joined_at timestamptz NOT NULL DEFAULT now(),
        left_at timestamptz NULL,
        PRIMARY KEY(session_id, seat)
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_game_session_players_account ON game_session_players(account_id) WHERE account_id IS NOT NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_game_session_players_session ON game_session_players(session_id, status)`);
    await this.query(`
      INSERT INTO game_session_players (session_id, seat, account_id, kind, status, joined_at)
      SELECT id, 0, owner_account_id, 'account', 'active', created_at
      FROM game_sessions
      ON CONFLICT (session_id, seat) DO NOTHING
    `);
    await this.query(`
      INSERT INTO game_session_players (session_id, seat, account_id, kind, status, joined_at)
      SELECT id, 1, opponent_account_id, 'account', 'active', created_at
      FROM game_sessions
      WHERE opponent_account_id IS NOT NULL
      ON CONFLICT (session_id, seat) DO NOTHING
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS game_rooms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        room_code text NOT NULL UNIQUE,
        game_key text NOT NULL,
        host_account_id text NOT NULL,
        max_players integer NOT NULL CHECK (max_players >= 2 AND max_players <= 6),
        visibility text NOT NULL DEFAULT 'private',
        config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'waiting',
        session_id uuid NULL REFERENCES game_sessions(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_game_rooms_host ON game_rooms(host_account_id, status)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_game_rooms_status ON game_rooms(status, updated_at DESC)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS game_room_members (
        room_id uuid NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
        account_id text NOT NULL,
        seat integer NOT NULL CHECK (seat >= 0),
        status text NOT NULL DEFAULT 'joined',
        ready boolean NOT NULL DEFAULT false,
        joined_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(room_id, account_id),
        UNIQUE(room_id, seat)
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_game_room_members_account ON game_room_members(account_id, status)`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS game_saves (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id text NOT NULL,
        game_key text NOT NULL,
        slot integer NOT NULL CHECK (slot >= 1 AND slot <= 3),
        label text NOT NULL DEFAULT '',
        source_session_id uuid NULL,
        source_mode text NOT NULL,
        my_seat integer NOT NULL,
        players_json jsonb NOT NULL,
        state_json jsonb NOT NULL,
        state_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(account_id, game_key, slot)
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_game_saves_account_game ON game_saves(account_id, game_key, slot)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_game_saves_source_session ON game_saves(source_session_id) WHERE source_session_id IS NOT NULL`);

    await this.query(`
      CREATE TABLE IF NOT EXISTS local_ai_results (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id text NOT NULL,
        game_key text NOT NULL,
        session_id text NOT NULL,
        result text NOT NULL,
        difficulty text NOT NULL,
        reason text NOT NULL DEFAULT '',
        recorded_at timestamptz NOT NULL,
        payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(account_id, game_key, session_id)
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_local_ai_results_account ON local_ai_results(account_id, created_at DESC)`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_local_ai_results_game ON local_ai_results(game_key, created_at DESC)`);

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

    await this.query(`
      CREATE TABLE IF NOT EXISTS sokoban_maps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        difficulty text NOT NULL,
        map_key text NOT NULL UNIQUE,
        map_json jsonb NOT NULL,
        metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_sokoban_maps_difficulty ON sokoban_maps(difficulty, created_at DESC)`);

    await this.query(`
      UPDATE game_sessions
      SET status = 'finished',
          current_turn = NULL,
          state_json = jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(state_json, '{status}', '"finished"'::jsonb, true),
                '{finishReason}', '"server_restart"'::jsonb, true
              ),
              '{currentTurn}', 'null'::jsonb, true
            ),
            '{updatedAt}', to_jsonb(now()), true
          ),
          updated_at = now()
      WHERE status NOT IN ('finished', 'cleared', 'failed')
    `);
  }
}

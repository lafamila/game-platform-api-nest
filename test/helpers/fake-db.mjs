// Shared in-memory fakes for GamesService integration tests.
// Extracted verbatim from local-ai.test.mjs so multiple test files can reuse the harness.

export class FakeDb {
  rows = new Map();
  sokobanMaps = [];
  sessionPlayers = [];
  rooms = [];
  roomMembers = [];
  socialAccounts = new Map();
  friendRequests = [];
  saves = [];
  customEmotes = [];
  localAiResults = [];
  nextId = 1;

  async query(sql, args = []) {
    if (sql.includes('INSERT INTO custom_emotes')) {
      const existingIndex = this.customEmotes.findIndex(
        (item) => item.account_id === args[0] && item.slot === args[1],
      );
      const now = new Date();
      const row = {
        account_id: args[0],
        slot: args[1],
        grid_size: args[2],
        cells_json: JSON.parse(args[3]),
        updated_at: now,
      };
      if (existingIndex >= 0) {
        this.customEmotes[existingIndex] = row;
      } else {
        this.customEmotes.push(row);
      }
      return { rows: [row] };
    }
    if (sql.includes('FROM custom_emotes')) {
      return {
        rows: this.customEmotes
          .filter((row) => row.account_id === args[0])
          .sort((a, b) => a.slot - b.slot),
      };
    }
    if (sql.includes('INSERT INTO game_rooms')) {
      const row = {
        id: `room-${this.rooms.length + 1}`,
        room_code: args[0],
        game_key: args[1],
        host_account_id: args[2],
        max_players: args[3],
        visibility: args[4],
        config_json: JSON.parse(args[5]),
        status: 'waiting',
        session_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.rooms.push(row);
      return { rows: [row] };
    }
    if (sql.includes('INSERT INTO game_room_members')) {
      const existingIndex = this.roomMembers.findIndex((item) => item.room_id === args[0] && item.account_id === args[1]);
      const nextSeat = this.roomMembers.filter((item) => item.room_id === args[0]).length;
      const row = {
        room_id: args[0],
        account_id: args[1],
        seat: typeof args[2] === 'number' ? args[2] : sql.includes("0, 'joined'") ? 0 : nextSeat,
        status: sql.includes("'invited'") ? 'invited' : 'joined',
        ready: sql.includes("'invited'") ? false : sql.includes('true') ? true : args[3] ?? false,
        joined_at: new Date(),
        updated_at: new Date(),
      };
      if (existingIndex >= 0) {
        this.roomMembers[existingIndex] = { ...this.roomMembers[existingIndex], ...row };
      } else {
        this.roomMembers.push(row);
      }
      return { rows: [row] };
    }
    if (sql.includes('UPDATE game_room_members')) {
      const member = this.roomMembers.find((item) => item.room_id === args[0] && item.account_id === args[1]);
      if (member) {
        member.ready = args[2];
        member.status = 'joined';
        member.updated_at = new Date();
      }
      return { rows: member ? [member] : [] };
    }
    if (sql.includes('DELETE FROM game_room_members')) {
      const before = this.roomMembers.length;
      if (args[1] instanceof Date) {
        this.roomMembers = this.roomMembers.filter(
          (item) => item.room_id !== args[0] || item.status !== 'invited' || item.updated_at >= args[1],
        );
      } else {
        this.roomMembers = this.roomMembers.filter(
          (item) => !(item.room_id === args[0] && item.account_id === args[1]),
        );
      }
      return { rows: [], rowCount: before - this.roomMembers.length };
    }
    if (sql.includes('UPDATE game_rooms')) {
      const room = this.rooms.find((item) => item.id === args[0]);
      if (room) {
        room.status = 'started';
        room.session_id = args[1];
        room.updated_at = new Date();
      }
      return { rows: room ? [room] : [] };
    }
    if (sql.includes('FROM game_room_members')) {
      return {
        rows: this.roomMembers
          .filter((row) => row.room_id === args[0])
          .sort((a, b) => a.seat - b.seat)
          .map((row) => {
            const account = this.socialAccounts.get(row.account_id) ?? {};
            return {
              ...row,
              account_login_id: account.login_id ?? null,
              account_name: account.name ?? null,
              account_email: account.email ?? null,
              account_status: account.status ?? null,
              account_permission_key: account.permission_key ?? null,
            };
          }),
      };
    }
    if (sql.includes('INSERT INTO game_sessions')) {
      const row = {
        id: `game-${this.nextId++}`,
        game_key: args[0],
        mode: args[1],
        status: args[2],
        current_turn: args[3],
        winner: args[4],
        owner_account_id: args[5],
        opponent_account_id: args[6],
        state_json: JSON.parse(args[7]),
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.rows.set(row.id, row);
      return { rows: [row] };
    }
    if (sql.includes('INSERT INTO game_session_players')) {
      const existingIndex = this.sessionPlayers.findIndex((item) => item.session_id === args[0] && item.seat === args[1]);
      const row = {
        session_id: args[0],
        seat: args[1],
        account_id: args[2],
        kind: args[3],
        ai_difficulty: args[4],
        status: args[5],
        result: null,
        joined_at: new Date(),
        left_at: args[5] === 'active' ? null : new Date(),
      };
      if (existingIndex >= 0) {
        this.sessionPlayers[existingIndex] = { ...this.sessionPlayers[existingIndex], ...row };
      } else {
        this.sessionPlayers.push(row);
      }
      return { rows: [row] };
    }
    if (sql.includes('FROM game_session_players')) {
      return {
        rows: this.sessionPlayers
          .filter((row) => row.session_id === args[0])
          .sort((a, b) => a.seat - b.seat),
      };
    }
    if (sql.includes('INSERT INTO game_saves')) {
      const existingIndex = this.saves.findIndex(
        (item) => item.account_id === args[0] && item.game_key === args[1] && item.slot === args[2],
      );
      const now = new Date();
      const row = {
        id: existingIndex >= 0 ? this.saves[existingIndex].id : `save-${this.saves.length + 1}`,
        account_id: args[0],
        game_key: args[1],
        slot: args[2],
        label: args[3],
        source_session_id: args[4],
        source_mode: args[5],
        my_seat: args[6],
        players_json: JSON.parse(args[7]),
        state_json: JSON.parse(args[8]),
        state_version: args[9],
        created_at: existingIndex >= 0 ? this.saves[existingIndex].created_at : now,
        updated_at: now,
      };
      if (existingIndex >= 0) {
        this.saves[existingIndex] = row;
      } else {
        this.saves.push(row);
      }
      return { rows: [row] };
    }
    if (sql.includes('INSERT INTO local_ai_results')) {
      const existingIndex = this.localAiResults.findIndex(
        (item) => item.account_id === args[0] && item.game_key === args[1] && item.session_id === args[2],
      );
      const now = new Date();
      const row = {
        id: existingIndex >= 0 ? this.localAiResults[existingIndex].id : `local-ai-result-${this.localAiResults.length + 1}`,
        account_id: args[0],
        game_key: args[1],
        session_id: args[2],
        result: args[3],
        difficulty: args[4],
        reason: args[5],
        recorded_at: args[6],
        payload_json: JSON.parse(args[7]),
        created_at: existingIndex >= 0 ? this.localAiResults[existingIndex].created_at : now,
        updated_at: now,
      };
      if (existingIndex >= 0) {
        this.localAiResults[existingIndex] = row;
      } else {
        this.localAiResults.push(row);
      }
      return { rows: [row] };
    }
    if (sql.includes('FROM game_saves')) {
      let rows = this.saves.filter((row) => row.account_id === args[0]);
      if (sql.includes('game_key') && args[1]) {
        rows = rows.filter((row) => row.game_key === args[1]);
      }
      return {
        rows: rows
          .sort((a, b) => a.game_key.localeCompare(b.game_key) || a.slot - b.slot)
          .map((row) => ({
            ...row,
            source_session_status: row.source_session_id ? this.rows.get(row.source_session_id)?.status ?? null : null,
          })),
      };
    }
    if (sql.includes('DELETE FROM game_saves')) {
      this.saves = this.saves.filter((row) => !(row.id === args[0] && row.account_id === args[1]));
      return { rows: [] };
    }
    if (sql.includes('FROM game_sessions') && sql.includes('game_session_players') && sql.includes('ORDER BY')) {
      const active = [...this.rows.values()].filter(
        (row) =>
          !['finished', 'cleared', 'failed'].includes(row.status) &&
          this.sessionPlayers.some(
            (player) => player.session_id === row.id && player.account_id === args[0] && player.status === 'active',
          ),
      );
      return { rows: active.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime()) };
    }
    if (sql.includes('FROM game_sessions') && sql.includes('ORDER BY updated_at')) {
      const active = [...this.rows.values()].filter(
        (row) =>
          !['finished', 'cleared', 'failed'].includes(row.status) &&
          (row.owner_account_id === args[0] || row.opponent_account_id === args[0]),
      );
      return { rows: active };
    }
    if (sql.includes('FROM sokoban_maps')) {
      return { rows: this.sokobanMaps.filter((row) => row.difficulty === args[0]).slice(0, 1) };
    }
    if (sql.includes('INSERT INTO sokoban_maps')) {
      const row = {
        id: `map-${this.sokobanMaps.length + 1}`,
        difficulty: args[0],
        map_key: args[1],
        map_json: JSON.parse(args[2]),
        metrics_json: JSON.parse(args[3]),
        created_at: new Date(),
      };
      if (!this.sokobanMaps.some((item) => item.map_key === row.map_key)) {
        this.sokobanMaps.push(row);
      }
      return { rows: [] };
    }
    if (sql.includes('UPDATE game_sessions') && sql.includes('abandoned')) {
      const cutoff = Date.now() - args[0] * 86_400_000;
      const updated = [];
      for (const row of this.rows.values()) {
        if (!['finished', 'cleared', 'failed'].includes(row.status) && row.updated_at.getTime() < cutoff) {
          row.status = 'finished';
          row.state_json = { ...row.state_json, status: 'finished', finishReason: 'abandoned' };
          row.updated_at = new Date();
          updated.push(row);
        }
      }
      return { rows: updated };
    }
    if (sql.includes('UPDATE game_sessions')) {
      const row = this.rows.get(args[0]);
      if (args.length > 5 && (row.state_json.rev ?? 0) !== args[5]) {
        return { rows: [] };
      }
      row.status = args[1];
      row.current_turn = args[2];
      row.winner = args[3];
      row.state_json = JSON.parse(args[4]);
      row.updated_at = new Date();
      return { rows: [row] };
    }
    return { rows: [] };
  }

  async one(sql, args = []) {
    if (sql.includes('FROM custom_emotes')) {
      return this.customEmotes.find((row) => row.account_id === args[0] && row.slot === args[1]) ?? null;
    }
    if (sql.includes('UPDATE game_rooms')) {
      const room = this.rooms.find((item) => item.id === args[0]);
      if (room) {
        room.status = 'started';
        room.session_id = args[1];
        room.updated_at = new Date();
      }
      return room ?? null;
    }
    if (sql.includes('FROM game_saves')) {
      return this.saves.find((row) => row.id === args[0] && (args.length < 2 || row.account_id === args[1])) ?? null;
    }
    if (sql.includes('FROM game_rooms') && sql.includes('room_code')) {
      return this.rooms.find((row) => row.room_code === args[0]) ?? null;
    }
    if (sql.includes('FROM game_rooms')) {
      return this.rooms.find((row) => row.id === args[0]) ?? null;
    }
    if (sql.includes('FROM game_room_members')) {
      return this.roomMembers.find((row) => row.room_id === args[0] && row.account_id === args[1]) ?? null;
    }
    if (sql.includes('FROM friend_requests')) {
      const found = this.friendRequests.find(
        (row) =>
          row.status === 'accepted' &&
          ((row.requester_account_id === args[0] && row.recipient_account_id === args[1]) ||
            (row.requester_account_id === args[1] && row.recipient_account_id === args[0])),
      );
      return found ? { id: found.id } : null;
    }
    if (sql.includes('FROM game_sessions') && sql.includes('WHERE id = $1') && !sql.includes('game_key')) {
      return this.rows.get(args[0]) ?? null;
    }
    const row = this.rows.get(args[0]);
    if (!row || row.game_key !== args[1]) {
      return null;
    }
    return row;
  }
}

export class FakeRealtime {
  online = true;
  events = [];

  emitToAccounts(accounts, event, payload) {
    this.events.push({ accounts, event, payload });
  }

  isAccountConnected() {
    return this.online;
  }

  async isAccountOnline() {
    return this.online;
  }
}

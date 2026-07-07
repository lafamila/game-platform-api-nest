import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeDb, FakeRealtime } from './helpers/fake-db.mjs';
import { GamesService } from '../dist/games/games.service.js';

const LOCAL_AI = '__game_platform_local_ai__';

const host = { accountId: 'host-1', subject: 'host-1', serviceKey: 'game-platform', permission: 'player', claims: {} };
const seatUser = (n) => ({ ...host, accountId: `player-${n}`, subject: `player-${n}` });

test('N-player save -> continue forks each non-saver seat to a distinct AI id (M5)', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  try {
    const members = [seatUser(2), seatUser(3), seatUser(4)];
    const room = await service.createRoom(host, { gameKey: 'splendor', maxPlayers: 4 });
    for (const member of members) {
      await service.joinRoom(member, { roomCode: room.room.roomCode });
      await service.setRoomReady(room.room.id, member, { ready: true });
    }
    await service.setRoomReady(room.room.id, host, { ready: true });
    const started = await service.startRoom(room.room.id, host);
    const sourceId = started.sessionId;

    // Save while the 4-player match is still live (friend_match save is allowed).
    const saved = await service.saveGameSessionToSlot('splendor', sourceId, host, { slot: 1, label: 'mid-match' });
    const saveId = saved.save.id;

    // Continue is blocked while the source match is still playing.
    await assert.rejects(() => service.continueGameSave(saveId, host, {}), /after the original match finishes/);

    // Finish the source: the three non-host seats forfeit, leaving the host as the last active seat.
    for (const member of members) {
      await service.forfeitSplendor(sourceId, member);
    }
    assert.equal(db.rows.get(sourceId).status, 'finished');

    // Now continue -> a fresh local_ai session forked from the saved snapshot.
    const continued = await service.continueGameSave(saveId, host, { difficulty: 'hard' });
    const forked = db.rows.get(continued.sessionId);
    assert.equal(forked.mode, 'local_ai');

    // Saver keeps their seat; every other seat gets a unique `<sentinel>#<seat>` id.
    const players = forked.state_json.players;
    assert.equal(players.seat0, host.accountId);
    assert.equal(players.seat1, `${LOCAL_AI}#1`);
    assert.equal(players.seat2, `${LOCAL_AI}#2`);
    assert.equal(players.seat3, `${LOCAL_AI}#3`);
    const aiIds = [players.seat1, players.seat2, players.seat3];
    assert.equal(new Set(aiIds).size, 3, 'AI seat ids must be distinct');

    // Seat rows: the saver is an account seat, the rest are AI seats.
    const seatRows = db.sessionPlayers
      .filter((r) => r.session_id === continued.sessionId)
      .sort((a, b) => a.seat - b.seat);
    assert.deepEqual(seatRows.map((r) => r.kind), ['account', 'ai', 'ai', 'ai']);
    assert.equal(seatRows[0].account_id, host.accountId);
    assert.deepEqual(seatRows.slice(1).map((r) => r.account_id), [null, null, null]);
  } finally {
    service.onModuleDestroy?.();
  }
});

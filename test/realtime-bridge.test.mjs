import assert from 'node:assert/strict';
import test from 'node:test';

import { RealtimeGateway } from '../dist/realtime/realtime.gateway.js';
import { RealtimeService } from '../dist/realtime/realtime.service.js';

class FakePresence {
  async connect() {
    return true;
  }

  async refresh() {}

  async disconnect() {
    return true;
  }
}

class FakeSocketServer {
  emitted = [];

  to(room) {
    return {
      emit: (event, data) => this.emitted.push({ room, event, data }),
    };
  }
}

test('socket connections share presence counts and receive bridged events', () => {
  const service = new RealtimeService(new FakePresence());
  const server = new FakeSocketServer();
  service.attachSocketServer(server);

  service.registerSocketConnection('acc-1', 'conn-1');
  assert.equal(service.isAccountConnected('acc-1'), true);

  service.emitToAccounts(['acc-1'], 'gomoku.move.played', { rev: 3 });
  assert.equal(server.emitted.length, 1);
  assert.deepEqual(server.emitted[0], {
    room: 'account:acc-1',
    event: 'gomoku.move.played',
    data: { rev: 3 },
  });

  service.unregisterSocketConnection('acc-1', 'conn-1');
  assert.equal(service.isAccountConnected('acc-1'), false);
});

test('events still reach the SSE stream after the socket bridge', () => {
  const service = new RealtimeService(new FakePresence());
  service.attachSocketServer(new FakeSocketServer());

  const received = [];
  const subscription = service.streamForAccount('acc-2').subscribe((event) => received.push(event));
  service.emitToAccounts(['acc-2'], 'game.session.finished', { rev: 9 });
  subscription.unsubscribe();

  const sessionEvents = received.filter((event) => event.type === 'game.session.finished');
  assert.equal(sessionEvents.length, 1);
  assert.deepEqual(sessionEvents[0].data, { rev: 9 });
});

test('gateway routes crazy arcade socket input through the authenticated game queue', async () => {
  const account = {
    accountId: 'acc-3',
    subject: 'acc-3',
    serviceKey: 'game-platform',
    permission: 'player',
    claims: {},
  };
  const sessions = {
    async requireSession(sessionId) {
      assert.equal(sessionId, 'socket-session-1');
      return { account };
    },
  };
  const realtime = new RealtimeService(new FakePresence());
  const games = {
    calls: [],
    async enqueueCrazyArcadeSocketInput(sessionId, inputAccount, input, clientMoveId) {
      this.calls.push({ sessionId, inputAccount, input, clientMoveId });
      return { id: sessionId, mySide: 'challenger' };
    },
  };
  const gateway = new RealtimeGateway(sessions, realtime, games);
  const socket = {
    handshake: { headers: {}, auth: { sessionId: 'socket-session-1' } },
    data: {},
    joined: [],
    emitted: [],
    async join(room) {
      this.joined.push(room);
    },
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
  };

  await gateway.handleConnection(socket);
  const result = await gateway.handleCrazyArcadeInput(socket, {
    sessionId: 'crazy-session-1',
    input: { direction: 'right', placeBomb: true },
    clientMoveId: 'move-1',
  });

  assert.deepEqual(socket.joined, ['account:acc-3']);
  assert.equal(result.ok, true);
  assert.deepEqual(games.calls, [
    {
      sessionId: 'crazy-session-1',
      inputAccount: account,
      input: { direction: 'right', placeBomb: true },
      clientMoveId: 'move-1',
    },
  ]);
});

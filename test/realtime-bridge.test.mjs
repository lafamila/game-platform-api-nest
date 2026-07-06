import assert from 'node:assert/strict';
import test from 'node:test';

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

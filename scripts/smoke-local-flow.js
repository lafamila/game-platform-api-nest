async function main() {
  await login('game-local-player', 'GameLocal!234', { returnUri: 'gameplatform://auth/callback' });

  const player = await login('game-local-player', 'GameLocal!234');
  const opponent = await login('game-local-opponent', 'GameOpponent!234');
  const playerHeaders = sessionHeaders(player.sessionId);
  const opponentHeaders = sessionHeaders(opponent.sessionId);

  console.log(`player=${player.user.loginId} permission=${player.user.permission}`);
  console.log(`opponent=${opponent.user.loginId} permission=${opponent.user.permission}`);

  const realtime = waitForRealtimeEvent(player.sessionId, 'gomoku.move.played');

  const search = await api('/accounts/search?q=game-local-opponent', { headers: playerHeaders });
  assert(search.accounts?.[0]?.accountId === opponent.user.accountId, 'account search should find opponent');

  const friendRequest = await api('/friends/requests', {
    method: 'POST',
    headers: playerHeaders,
    body: { recipientAccountId: opponent.user.accountId },
  });
  await api(`/friends/requests/${friendRequest.id}/accept`, {
    method: 'POST',
    headers: opponentHeaders,
  });

  const match = await api('/matches', {
    method: 'POST',
    headers: playerHeaders,
    body: { gameKey: 'gomoku', opponentAccountId: opponent.user.accountId },
  });
  const accepted = await api(`/matches/${match.id}/accept`, {
    method: 'POST',
    headers: opponentHeaders,
  });
  assert(accepted.sessionId, 'accepted match should create a game session');

  const gomoku = await api(`/gomoku/sessions/${accepted.sessionId}`, { headers: playerHeaders });
  assert(gomoku.players.black === player.user.accountId, 'player should own black turn');
  await api(`/gomoku/sessions/${accepted.sessionId}/moves`, {
    method: 'POST',
    headers: playerHeaders,
    body: { row: 7, col: 7 },
  });
  await realtime;

  const sudoku = await api('/sudoku/sessions', {
    method: 'POST',
    headers: playerHeaders,
    body: { difficulty: 'easy' },
  });
  assert(Array.isArray(sudoku.puzzle) && !('solution' in sudoku), 'sudoku response should hide solution');

  const alkkagi = await api('/alkkagi/sessions', {
    method: 'POST',
    headers: playerHeaders,
    body: {},
  });
  assert(Array.isArray(alkkagi.pieces), 'alkkagi session should be created');
  assert(alkkagi.pieces.every((piece) => piece.rank && piece.radius && piece.mass), 'alkkagi pieces should carry rank, radius, and mass');
  const redPiece = alkkagi.pieces.find((piece) => piece.team === 'red' && piece.active);
  assert(redPiece, 'alkkagi should have an active red piece');
  const shot = await api(`/alkkagi/sessions/${alkkagi.id}/shots`, {
    method: 'POST',
    headers: playerHeaders,
    body: { pieceId: redPiece.id, vx: 12, vy: -10 },
  });
  assert(Array.isArray(shot.animation?.frames) && shot.animation.frames.length > 1, 'alkkagi shot should return animation frames');
  assert(Array.isArray(shot.session?.pieces), 'alkkagi shot should return persisted session');

  const persisted = await sqlCount();
  console.log(JSON.stringify({ ok: true, matchSessionId: accepted.sessionId, persisted }, null, 2));
}

async function login(loginId, password, options = {}) {
  const start = await api('/session/oidc/start', {
    method: 'POST',
    body: options.returnUri ? { returnUri: options.returnUri } : {},
  });
  const authorizeUrl = new URL(start.authorizeUrl);
  const loginBody = new URLSearchParams();
  for (const [key, value] of authorizeUrl.searchParams.entries()) {
    loginBody.set(key, value);
  }
  loginBody.set('loginId', loginId);
  loginBody.set('password', password);

  const loginResponse = await fetch('http://localhost:3032/oauth/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: loginBody,
  });
  const loginResponseText = loginResponse.status >= 300 && loginResponse.status < 400 ? '' : await loginResponse.text();
  const failureMessage = loginResponseText.match(/<p id="failure-message"[^>]*>(.*?)<\/p>/s)?.[1] ?? loginResponseText.slice(0, 2000);
  assert(
    loginResponse.status >= 300 && loginResponse.status < 400,
    `login redirect expected, got ${loginResponse.status}: ${failureMessage}`,
  );
  const callbackUrl = loginResponse.headers.get('location');
  assert(callbackUrl, 'login redirect location is required');

  const callback = await fetch(callbackUrl, { redirect: 'manual' });
  const callbackText = await callback.text();
  assert(callback.ok, `callback failed with ${callback.status}: ${callbackText}`);
  if (options.returnUri) {
    assert(callbackText.includes('현재 기기로 돌아가기'), 'app return callback should render a current-platform return button');
    assert(callbackText.includes('iOS 앱으로 돌아가기'), 'app return callback should render an iOS return button');
    assert(callbackText.includes('macOS 앱으로 돌아가기'), 'app return callback should render a macOS return button');
    assert(callbackText.includes('Android 앱으로 돌아가기'), 'app return callback should render an Android return button');
    assert(callbackText.includes('로그아웃'), 'app return callback should render logout controls');
    assert(callbackText.includes('intent://auth/callback'), 'app return callback should render Android intent fallback');
    assert(callbackText.includes(options.returnUri), 'app return callback should include the app return URI');
  }

  return api('/session/oidc/complete', {
    method: 'POST',
    body: { loginTransactionId: start.loginTransactionId },
  });
}

async function api(path, options = {}) {
  const headers = {
    accept: 'application/json',
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers ?? {}),
  };
  const response = await fetch(`http://localhost:3035/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${text}`);
  }
  return payload;
}

function sessionHeaders(sessionId) {
  return { 'x-game-platform-session': sessionId };
}

async function waitForRealtimeEvent(sessionId, eventName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('http://localhost:3035/api/realtime/events', {
      headers: {
        accept: 'text/event-stream',
        'x-game-platform-session': sessionId,
      },
      signal: controller.signal,
    });
    assert(response.ok, `realtime failed with ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(`event: ${eventName}`)) {
        controller.abort();
        return true;
      }
    }
    throw new Error(`realtime event ${eventName} was not received`);
  } finally {
    clearTimeout(timeout);
  }
}

async function sqlCount() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/game_platform' });
  try {
    const result = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM app_sessions) AS app_sessions,
        (SELECT count(*)::int FROM game_sessions) AS game_sessions,
        (SELECT count(*)::int FROM friend_requests) AS friend_requests,
        (SELECT count(*)::int FROM match_requests) AS match_requests
    `);
    return result.rows[0];
  } finally {
    await pool.end();
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// /replay 웹 뷰 (레포 최초 웹 서피스 — 의도적으로 최소). 프레임워크·빌드 파이프라인 없는
// 단일 vanilla HTML+CSS+JS. tsc 가 이 .ts 를 dist 로 옮기므로 별도 정적 자산 복사가 필요 없다.
// 인증: 페이지 자체는 가드 없이 셸만 서빙하고, JS 가 superadmin 전용 API(401/403/200)로 상태를 분기한다.
// 페이지 JS 는 바깥 템플릿 리터럴과 충돌하지 않도록 backtick 과 ${ 를 쓰지 않는다(문자열 concat 사용).
export const REPLAY_VIEW_HTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Game Replay</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", sans-serif; margin: 0; background: #f5f3ee; color: #1d2521; }
    header { padding: 16px 20px; background: #2f6f5e; color: #fff; }
    header h1 { margin: 0; font-size: 1.15rem; }
    header .sub { margin-top: 2px; font-size: 0.8rem; opacity: 0.85; }
    main { max-width: 980px; margin: 0 auto; padding: 16px; }
    .hidden { display: none !important; }
    .card { background: #fff; border: 1px solid #e2ddd3; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    .muted { color: #66736d; }
    button { appearance: none; border: 1px solid #cfd8d4; background: #fff; color: #1d2521; border-radius: 8px; padding: 8px 14px; font: inherit; cursor: pointer; min-height: 38px; }
    button.primary { background: #2f6f5e; color: #fff; border-color: #2f6f5e; font-weight: 700; }
    button:disabled { opacity: 0.5; cursor: default; }
    label { font-size: 0.85rem; font-weight: 600; }
    select, input[type=text] { font: inherit; padding: 7px 10px; border: 1px solid #cfd8d4; border-radius: 8px; min-height: 38px; }
    .filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
    .filters > div { display: flex; flex-direction: column; gap: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #eee5d8; }
    th { color: #66736d; font-weight: 600; white-space: nowrap; }
    tr.row { cursor: pointer; }
    tr.row:hover { background: #f7f4ec; }
    .pager { display: flex; gap: 10px; align-items: center; margin-top: 12px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .chip { border: 1px solid #cfd8d4; border-radius: 999px; padding: 5px 12px; cursor: pointer; background: #fff; font-size: 0.85rem; }
    .chip.active { background: #2f6f5e; color: #fff; border-color: #2f6f5e; }
    .board-wrap { display: flex; justify-content: center; }
    canvas { max-width: 100%; height: auto; background: #d8b98a; border-radius: 6px; touch-action: none; }
    .status-line { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 12px 0; font-size: 0.92rem; }
    .status-line b { font-weight: 700; }
    .controls { display: flex; gap: 10px; flex-wrap: wrap; }
    .error { color: #b42318; }
    .stone-dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%; vertical-align: middle; margin-right: 4px; border: 1px solid #333; }
  </style>
</head>
<body>
  <header>
    <h1>Game Replay</h1>
    <div class="sub">오목 · 오델로 리플레이 (superadmin 전용)</div>
  </header>
  <main>
    <div id="gate" class="card hidden"></div>

    <section id="list-view" class="hidden">
      <div class="card">
        <div class="filters">
          <div>
            <label for="game-filter">게임</label>
            <select id="game-filter">
              <option value="">전체</option>
              <option value="gomoku">오목</option>
              <option value="othello">오델로</option>
            </select>
          </div>
          <div style="flex:1; min-width:180px;">
            <label for="user-search">유저 검색 (정확한 로그인 ID)</label>
            <div style="display:flex; gap:8px;">
              <input type="text" id="user-search" placeholder="login id" style="flex:1;">
              <button id="user-search-btn">검색</button>
            </div>
          </div>
        </div>
        <div id="user-chips" class="chips"></div>
      </div>
      <div class="card">
        <div id="list-status" class="muted">불러오는 중…</div>
        <div style="overflow-x:auto;">
          <table id="replay-table" class="hidden">
            <thead>
              <tr><th>게임</th><th>플레이어</th><th>상대</th><th>시작 시간 (KST)</th><th>승자</th><th>종료 사유</th><th>수</th></tr>
            </thead>
            <tbody id="replay-tbody"></tbody>
          </table>
        </div>
        <div class="pager">
          <button id="prev-page">이전</button>
          <span id="page-label" class="muted"></span>
          <button id="next-page">다음</button>
        </div>
      </div>
    </section>

    <section id="player-view" class="hidden">
      <div class="card">
        <button id="back-btn">← 목록으로</button>
        <div id="player-meta" class="status-line"></div>
        <div class="board-wrap"><canvas id="board" width="480" height="480"></canvas></div>
        <div id="play-status" class="status-line"></div>
        <div class="controls">
          <button id="pause-btn" class="primary">일시정지</button>
          <button id="restart-btn">처음부터</button>
          <button id="pdf-btn">기보 PDF</button>
        </div>
      </div>
    </section>
  </main>

  <script>
  (function () {
    var API = '/api';
    var state = { accountId: null, accountLabel: null, game: '', page: 1, pageSize: 20, total: 0 };
    var el = function (id) { return document.getElementById(id); };

    var FINISH_LABELS = {
      board_complete: '정상 종료', completed: '정상 종료', draw: '무승부',
      forfeit: '기권', opponent_left: '상대 이탈', abandoned: '장기 미접속',
      timeout_random_win: '시간초과 랜덤 착수', disconnect: '연결 종료', server_restart: '서버 재시작'
    };
    function finishLabel(reason) { if (!reason) return '-'; return FINISH_LABELS[reason] || reason; }

    function fmtTime(iso) {
      try { return new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }); }
      catch (e) { return iso; }
    }

    function api(path) {
      return fetch(API + path, { credentials: 'include', headers: { Accept: 'application/json' } });
    }

    // ---- auth gate -------------------------------------------------------
    function showGate(html) {
      el('list-view').classList.add('hidden');
      el('player-view').classList.add('hidden');
      var gate = el('gate');
      gate.classList.remove('hidden');
      gate.innerHTML = html;
    }

    function renderLoginRequired() {
      showGate('<h2>로그인이 필요합니다</h2>'
        + '<p class="muted">이 페이지는 superadmin 계정 전용입니다. 로그인 후 이용해 주세요.</p>'
        + '<button class="primary" id="login-btn">로그인</button>');
      el('login-btn').addEventListener('click', startLogin);
    }

    function renderForbidden() {
      showGate('<h2>권한 없음</h2>'
        + '<p class="muted">리플레이는 superadmin 권한이 있어야 열람할 수 있습니다.</p>'
        + '<button id="logout-btn">로그아웃</button>');
      el('logout-btn').addEventListener('click', function () {
        fetch(API + '/session/logout', { method: 'POST', credentials: 'include' })
          .catch(function () {}).then(function () { location.reload(); });
      });
    }

    function startLogin() {
      fetch(API + '/session/oidc/start', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUri: location.origin + '/replay' })
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.authorizeUrl) { location.href = data.authorizeUrl; }
          else { showGate('<h2 class="error">로그인을 시작할 수 없습니다.</h2>'); }
        })
        .catch(function () { showGate('<h2 class="error">로그인을 시작할 수 없습니다.</h2>'); });
    }

    // handles a fetch Response, routing 401/403 to the gate; returns parsed json or null.
    function handleAuth(response) {
      if (response.status === 401) { renderLoginRequired(); return null; }
      if (response.status === 403) { renderForbidden(); return null; }
      return response.json();
    }

    // ---- list ------------------------------------------------------------
    function loadList() {
      el('gate').classList.add('hidden');
      el('player-view').classList.add('hidden');
      el('list-view').classList.remove('hidden');
      el('list-status').textContent = '불러오는 중…';
      el('replay-table').classList.add('hidden');
      var q = '?page=' + state.page + '&pageSize=' + state.pageSize;
      if (state.game) { q += '&game=' + encodeURIComponent(state.game); }
      if (state.accountId) { q += '&accountId=' + encodeURIComponent(state.accountId); }
      api('/replays' + q).then(handleAuth).then(function (data) {
        if (!data) return;
        state.total = data.total || 0;
        renderRows(data.items || []);
        var totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
        el('page-label').textContent = state.total + '건 · ' + state.page + ' / ' + totalPages + ' 페이지';
        el('prev-page').disabled = state.page <= 1;
        el('next-page').disabled = state.page >= totalPages;
      }).catch(function () { el('list-status').textContent = '목록을 불러오지 못했습니다.'; });
    }

    function humanOf(players) { for (var i = 0; i < players.length; i++) { if (!players[i].isAi) return players[i]; } return players[0]; }
    function playerByColor(players, color) { for (var i = 0; i < players.length; i++) { if (players[i].color === color) return players[i]; } return null; }

    function winnerLabel(item) {
      if (item.winner === 'draw') return '무승부';
      if (item.winner === 'ai') return 'AI';
      if (!item.winner) return '-';
      var p = null;
      for (var i = 0; i < item.players.length; i++) { if (item.players[i].accountId === item.winner) { p = item.players[i]; } }
      return p ? p.displayName : item.winner;
    }

    function renderRows(items) {
      var tbody = el('replay-tbody');
      tbody.innerHTML = '';
      if (items.length === 0) {
        el('list-status').textContent = '리플레이할 완료 게임이 없습니다. (로깅 배포 이후 게임만 표시됩니다)';
        el('replay-table').classList.add('hidden');
        return;
      }
      el('list-status').textContent = '';
      el('replay-table').classList.remove('hidden');
      items.forEach(function (item) {
        var tr = document.createElement('tr');
        tr.className = 'row';
        var left, right;
        if (item.mode === 'local_ai') {
          var human = humanOf(item.players);
          left = human.displayName;
          right = 'AI (' + (item.aiDifficulty || 'medium') + ')';
        } else {
          left = item.players[0] ? item.players[0].displayName : '-';
          right = item.players[1] ? item.players[1].displayName : '-';
        }
        var gameName = item.gameKey === 'gomoku' ? '오목' : '오델로';
        tr.innerHTML = '<td>' + gameName + '</td><td>' + esc(left) + '</td><td>' + esc(right) + '</td><td>'
          + esc(fmtTime(item.startedAt)) + '</td><td>' + esc(winnerLabel(item)) + '</td><td>'
          + esc(finishLabel(item.finishReason)) + '</td><td>' + item.moveCount + '</td>';
        tr.addEventListener('click', function () { openReplay(item.sessionId); });
        tbody.appendChild(tr);
      });
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---- user search -----------------------------------------------------
    function doUserSearch() {
      var q = el('user-search').value.trim();
      if (!q) return;
      api('/replays/accounts/search?q=' + encodeURIComponent(q)).then(handleAuth).then(function (data) {
        if (!data) return;
        var chips = el('user-chips');
        chips.innerHTML = '';
        var accounts = (data && data.accounts) || [];
        if (accounts.length === 0) {
          chips.innerHTML = '<span class="muted">일치하는 계정이 없습니다.</span>';
          return;
        }
        accounts.forEach(function (acc) {
          var chip = document.createElement('span');
          chip.className = 'chip';
          var label = (acc.name || acc.loginId || acc.accountId);
          chip.textContent = label + ' (' + acc.loginId + ')';
          chip.addEventListener('click', function () { setAccountFilter(acc.accountId, label); });
          chips.appendChild(chip);
        });
      }).catch(function () {});
    }

    function setAccountFilter(accountId, label) {
      state.accountId = accountId; state.accountLabel = label; state.page = 1;
      renderActiveChip();
      loadList();
    }

    function clearAccountFilter() {
      state.accountId = null; state.accountLabel = null; state.page = 1;
      renderActiveChip();
      loadList();
    }

    function renderActiveChip() {
      var chips = el('user-chips');
      if (!state.accountId) { return; }
      chips.innerHTML = '';
      var chip = document.createElement('span');
      chip.className = 'chip active';
      chip.textContent = '필터: ' + (state.accountLabel || state.accountId) + '  ✕';
      chip.addEventListener('click', clearAccountFilter);
      chips.appendChild(chip);
    }

    // ---- player / playback ----------------------------------------------
    var pb = { detail: null, index: -1, paused: false, timer: null, stepStart: 0, stepRemain: 0 };

    function openReplay(sessionId) {
      api('/replays/' + encodeURIComponent(sessionId)).then(handleAuth).then(function (data) {
        if (!data) return;
        pb.detail = data;
        el('gate').classList.add('hidden');
        el('list-view').classList.add('hidden');
        el('player-view').classList.remove('hidden');
        renderPlayerMeta(data);
        startPlayback();
      }).catch(function () {});
    }

    function renderPlayerMeta(d) {
      var gameName = d.gameKey === 'gomoku' ? '오목' : '오델로';
      var p0 = d.players[0], p1 = d.players[1];
      var line = '<span><b>' + gameName + '</b></span>';
      line += '<span>' + colorDot('black') + esc(nameForColor(d, 'black')) + '</span>';
      line += '<span>' + colorDot('white') + esc(nameForColor(d, 'white')) + '</span>';
      line += '<span class="muted">시작 ' + esc(fmtTime(d.startedAt)) + '</span>';
      var winnerTxt = winnerLabel(d);
      line += '<span>승자: <b>' + esc(winnerTxt) + '</b></span>';
      line += '<span class="muted">' + esc(finishLabel(d.finishReason)) + '</span>';
      el('player-meta').innerHTML = line;
    }

    function nameForColor(d, color) {
      var p = playerByColor(d.players, color);
      return p ? p.displayName : color;
    }
    function colorDot(color) {
      var bg = color === 'black' ? '#1d2521' : '#ffffff';
      return '<span class="stone-dot" style="background:' + bg + '"></span>';
    }

    function startPlayback() {
      clearTimeout(pb.timer);
      pb.index = -1; pb.paused = false;
      el('pause-btn').textContent = '일시정지';
      drawInitial();
      updatePlayStatus();
      scheduleNext();
    }

    function scheduleNext() {
      if (pb.paused) return;
      var moves = pb.detail.moves;
      if (pb.index + 1 >= moves.length) { updatePlayStatus(); return; }
      var next = moves[pb.index + 1];
      pb.stepRemain = next.delayMs || 0;
      runStep();
    }

    function runStep() {
      pb.stepStart = Date.now();
      pb.timer = setTimeout(function () {
        pb.index += 1;
        renderCurrent();
        updatePlayStatus();
        scheduleNext();
      }, pb.stepRemain);
    }

    function togglePause() {
      if (pb.paused) {
        // resume: 남은 간격부터 이어서 재생 (D7)
        pb.paused = false;
        el('pause-btn').textContent = '일시정지';
        if (pb.index + 1 < pb.detail.moves.length) { runStep(); }
      } else {
        pb.paused = true;
        el('pause-btn').textContent = '재개';
        clearTimeout(pb.timer);
        var elapsed = Date.now() - pb.stepStart;
        pb.stepRemain = Math.max(0, pb.stepRemain - elapsed);
      }
    }

    function updatePlayStatus() {
      var moves = pb.detail.moves;
      var shown = pb.index + 1; // number of moves shown
      var status = '<span>수 ' + Math.max(0, shown) + ' / ' + moves.length + '</span>';
      if (pb.index >= 0 && pb.index < moves.length) {
        var m = moves[pb.index];
        var who = colorDot(m.color) + esc(nameForColor(pb.detail, m.color));
        if (m.type === 'pass') { status += '<span>' + who + ' — 패스</span>'; }
        else { status += '<span>' + who + ' — (' + (m.x + 1) + ', ' + (m.y + 1) + ')</span>'; }
      }
      if (shown >= moves.length) { status += '<span class="muted">재생 완료</span>'; }
      el('play-status').innerHTML = status;
    }

    // board drawing -------------------------------------------------------
    function drawInitial() {
      var size = pb.detail.boardSize;
      var board = [];
      for (var r = 0; r < size; r++) { board.push(new Array(size).fill(null)); }
      if (pb.detail.gameKey === 'othello') {
        board[3][3] = 'white'; board[3][4] = 'black'; board[4][3] = 'black'; board[4][4] = 'white';
      }
      drawBoard(board, null);
    }

    function renderCurrent() {
      var snap = pb.detail.snapshots[pb.index];
      var m = pb.detail.moves[pb.index];
      var last = (m && m.type === 'move') ? { x: m.x, y: m.y } : null;
      drawBoard(snap, last);
    }

    // App-faithful renderer — mirrors GomokuPainter (game-platform-app-flutter
    // lib/main.dart:9412) and OthelloBoard (main.dart:15602); palette = GamePalette (main.dart:1157).
    var PAL = { ink: '#2b1b10', leafDeep: '#356d1f', gold: '#ffd166' };
    function rgba(hex, a) {
      var n = parseInt(hex.replace('#', ''), 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    function roundRectPath(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    // golden ring = the app's gomoku last-move idiom; reused for othello (which has none) — documented.
    function paintLastRing(ctx, cx, cy, radius) {
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.lineWidth = 2.5; ctx.strokeStyle = PAL.gold; ctx.stroke();
    }

    function paintGomoku(ctx, W, board, last) {
      var cell = W / 15, inset = W * 0.012, r = W * 0.045;
      roundRectPath(ctx, inset, inset + W * 0.018, W - 2 * inset, W - 2 * inset, r);
      ctx.fillStyle = rgba(PAL.ink, 0.48); ctx.fill();
      roundRectPath(ctx, inset, inset, W - 2 * inset, W - 2 * inset, r);
      var g = ctx.createLinearGradient(0, 0, W, W);
      g.addColorStop(0, '#ffe08a'); g.addColorStop(1, '#d89544');
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = Math.max(3, W * 0.0125); ctx.strokeStyle = PAL.ink; ctx.stroke();
      ctx.strokeStyle = rgba(PAL.ink, 0.08); ctx.lineWidth = 1.5;
      for (var wi = 0; wi < 9; wi++) {
        var yy = W * (0.14 + wi * 0.09);
        ctx.beginPath(); ctx.moveTo(W * 0.09, yy);
        ctx.quadraticCurveTo(W * 0.34, yy + Math.sin(wi) * W * 0.012, W * 0.58, yy - Math.cos(wi) * W * 0.01);
        ctx.quadraticCurveTo(W * 0.78, yy + Math.sin(wi * 1.7) * W * 0.012, W * 0.91, yy);
        ctx.stroke();
      }
      ctx.strokeStyle = rgba(PAL.ink, 0.58); ctx.lineWidth = 1.2;
      var gi = cell * 0.5;
      for (var i = 0; i < 15; i++) {
        var o = gi + i * cell;
        ctx.beginPath(); ctx.moveTo(gi, o); ctx.lineTo(W - gi, o); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(o, gi); ctx.lineTo(o, W - gi); ctx.stroke();
      }
      for (var row = 0; row < 15; row++) {
        for (var col = 0; col < 15; col++) {
          var v = board[row] && board[row][col];
          if (!v) continue;
          var cx = col * cell + cell / 2, cy = row * cell + cell / 2;
          ctx.beginPath(); ctx.arc(cx + cell * 0.05, cy + cell * 0.07, cell * 0.38, 0, Math.PI * 2);
          ctx.fillStyle = rgba(PAL.ink, 0.26); ctx.fill();
          var rg = ctx.createRadialGradient(cx - 0.28 * cell * 0.42, cy - 0.32 * cell * 0.42, 0, cx, cy, cell * 0.42);
          if (v === 'black') { rg.addColorStop(0, '#5b4535'); rg.addColorStop(1, PAL.ink); }
          else { rg.addColorStop(0, '#ffffff'); rg.addColorStop(1, '#ffe8a8'); }
          ctx.beginPath(); ctx.arc(cx, cy, cell * 0.38, 0, Math.PI * 2); ctx.fillStyle = rg; ctx.fill();
          ctx.beginPath(); ctx.arc(cx - cell * 0.12, cy - cell * 0.14, cell * 0.11, 0, Math.PI * 2);
          ctx.fillStyle = rgba('#ffffff', 0.42); ctx.fill();
          ctx.beginPath(); ctx.arc(cx, cy, cell * 0.38, 0, Math.PI * 2);
          ctx.lineWidth = 2; ctx.strokeStyle = rgba(PAL.ink, 0.42); ctx.stroke();
        }
      }
      if (last) { paintLastRing(ctx, last.x * cell + cell / 2, last.y * cell + cell / 2, cell * 0.45); }
    }

    function paintOthello(ctx, W, board, last) {
      var cell = W / 8, m = Math.max(1, W * 0.004), cr = Math.max(2, W * 0.008);
      ctx.fillStyle = PAL.leafDeep; ctx.fillRect(0, 0, W, W);
      for (var row = 0; row < 8; row++) {
        for (var col = 0; col < 8; col++) {
          var x = col * cell, y = row * cell;
          roundRectPath(ctx, x + m, y + m, cell - 2 * m, cell - 2 * m, cr);
          ctx.fillStyle = ((row + col) % 2 === 0) ? '#2f8f4e' : '#267441'; ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = PAL.ink; ctx.stroke();
          var v = board[row] && board[row][col];
          if (!v) continue;
          var cx = x + cell / 2, cy = y + cell / 2, rad = cell * 0.36;
          ctx.beginPath(); ctx.arc(cx, cy + 3, rad, 0, Math.PI * 2); ctx.fillStyle = rgba('#000000', 0.32); ctx.fill();
          ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.fillStyle = v === 'black' ? '#16181d' : '#f6f0df'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = PAL.ink; ctx.stroke();
        }
      }
      if (last) { paintLastRing(ctx, last.x * cell + cell / 2, last.y * cell + cell / 2, cell * 0.42); }
    }

    function paintBoard(ctx, W, gameKey, board, last) {
      ctx.clearRect(0, 0, W, W);
      if (gameKey === 'gomoku') { paintGomoku(ctx, W, board, last); }
      else { paintOthello(ctx, W, board, last); }
    }

    function drawBoard(board, last) {
      var canvas = el('board');
      paintBoard(canvas.getContext('2d'), canvas.width, pb.detail.gameKey, board, last);
    }

    // ---- 기보 PDF export -------------------------------------------------
    // NOTE: giboColorLabel / giboMoveCaption / giboGridPlan / giboPageCount / encodeJpegPdf below
    // are a browser port of src/replay/gibo-pdf.ts (unit-tested there). The /replay page has no
    // build pipeline, so this copy is deliberate — KEEP THE TWO IN SYNC.
    function giboColorLabel(color) { return color === 'black' ? '흑' : '백'; }
    function giboMoveCaption(index, move) {
      var n = index + 1, who = giboColorLabel(move.color);
      if (move.type === 'pass') { return n + '수 · ' + who + ' 패스'; }
      return n + '수 · ' + who + ' (' + (move.x + 1) + ',' + (move.y + 1) + ')';
    }
    function giboPageCount(tileCount, cap1, capRest) {
      if (tileCount <= 0) return 1;
      if (tileCount <= cap1) return 1;
      return 1 + Math.ceil((tileCount - cap1) / Math.max(1, capRest));
    }
    function giboGridPlan(tileCount, o) {
      var contentW = o.pageW - 2 * o.margin;
      var tileW = (contentW - (o.cols - 1) * o.colGap) / o.cols;
      var tileH = tileW * o.tileAspect;
      var gridTop1 = o.margin + (o.headerHpt > 0 ? o.headerHpt + o.rowGap : 0);
      function rowsFor(top) { return Math.max(1, Math.floor((o.pageH - top - o.margin + o.rowGap) / (tileH + o.rowGap))); }
      var cap1 = rowsFor(gridTop1) * o.cols, capRest = rowsFor(o.margin) * o.cols;
      var slots = [], i = 0;
      for (var page = 0; i < tileCount; page++) {
        var cap = page === 0 ? cap1 : capRest, gridTop = page === 0 ? gridTop1 : o.margin;
        for (var k = 0; k < cap && i < tileCount; k++, i++) {
          slots.push({ page: page, xPt: o.margin + (k % o.cols) * (tileW + o.colGap), yTopPt: gridTop + Math.floor(k / o.cols) * (tileH + o.rowGap) });
        }
      }
      return { tileW: tileW, tileH: tileH, cap1: cap1, capRest: capRest, pages: giboPageCount(tileCount, cap1, capRest), slots: slots };
    }
    function pdfEnc(s) { return new TextEncoder().encode(s); }
    function pdfConcat(list) {
      var total = 0, j; for (j = 0; j < list.length; j++) total += list[j].length;
      var out = new Uint8Array(total), at = 0;
      for (j = 0; j < list.length; j++) { out.set(list[j], at); at += list[j].length; }
      return out;
    }
    function pdfNum(n) { return (n % 1 === 0) ? String(n) : n.toFixed(2); }
    function pdfPad10(n) { var s = String(n); while (s.length < 10) s = '0' + s; return s; }
    function encodeJpegPdf(pageWpt, pageHpt, pages) {
      var objs = [], next = 3, pageRefs = [];
      function put(n, body) { objs[n - 1] = body; }
      for (var p = 0; p < pages.length; p++) {
        var imgNums = [], content = '', pl;
        for (var q = 0; q < pages[p].length; q++) {
          pl = pages[p][q]; var inum = next++;
          var dict = '<< /Type /XObject /Subtype /Image /Width ' + pl.wPx + ' /Height ' + pl.hPx +
            ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pl.jpeg.length + ' >>\\nstream\\n';
          put(inum, pdfConcat([pdfEnc(dict), pl.jpeg, pdfEnc('\\nendstream')]));
          imgNums.push(inum);
          content += 'q ' + pdfNum(pl.wPt) + ' 0 0 ' + pdfNum(pl.hPt) + ' ' + pdfNum(pl.xPt) + ' ' + pdfNum(pl.yPtBottom) + ' cm /Im' + inum + ' Do Q\\n';
        }
        var cnum = next++, cbytes = pdfEnc(content);
        put(cnum, pdfConcat([pdfEnc('<< /Length ' + cbytes.length + ' >>\\nstream\\n'), cbytes, pdfEnc('\\nendstream')]));
        var pnum = next++, res = imgNums.map(function (n) { return '/Im' + n + ' ' + n + ' 0 R'; }).join(' ');
        put(pnum, pdfEnc('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pdfNum(pageWpt) + ' ' + pdfNum(pageHpt) +
          '] /Resources << /XObject << ' + res + ' >> >> /Contents ' + cnum + ' 0 R >>'));
        pageRefs.push(pnum);
      }
      put(2, pdfEnc('<< /Type /Pages /Kids [' + pageRefs.map(function (n) { return n + ' 0 R'; }).join(' ') + '] /Count ' + pageRefs.length + ' >>'));
      put(1, pdfEnc('<< /Type /Catalog /Pages 2 0 R >>'));
      var out = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xff, 0xff, 0xff, 0xff, 0x0a]);
      var offsets = [];
      for (var oi = 0; oi < objs.length; oi++) {
        var n = oi + 1; offsets[n] = out.length;
        out = pdfConcat([out, pdfEnc(n + ' 0 obj\\n'), objs[oi] || pdfEnc('<< >>'), pdfEnc('\\nendobj\\n')]);
      }
      var xrefStart = out.length, xref = 'xref\\n0 ' + (objs.length + 1) + '\\n0000000000 65535 f \\n';
      for (var xn = 1; xn <= objs.length; xn++) { xref += pdfPad10(offsets[xn] || 0) + ' 00000 n \\n'; }
      return pdfConcat([out, pdfEnc(xref), pdfEnc('trailer\\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\\nstartxref\\n' + xrefStart + '\\n%%EOF\\n')]);
    }

    function dataUrlToBytes(url) {
      var bin = atob(url.slice(url.indexOf(',') + 1)), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    function playersLine(d) {
      function nm(p) { return !p ? '-' : (p.isAi ? 'AI(' + (d.aiDifficulty || 'medium') + ')' : p.displayName); }
      return '흑 ' + nm(playerByColor(d.players, 'black')) + '   vs   백 ' + nm(playerByColor(d.players, 'white'));
    }
    function buildHeaderCanvas() {
      var d = pb.detail, HW = 1500, HH = Math.round(HW * 80 / 523);
      var hc = document.createElement('canvas'); hc.width = HW; hc.height = HH;
      var ctx = hc.getContext('2d');
      ctx.fillStyle = '#fff8e7'; ctx.fillRect(0, 0, HW, HH);
      ctx.strokeStyle = PAL.ink; ctx.lineWidth = 6; ctx.strokeRect(3, 3, HW - 6, HH - 6);
      ctx.fillStyle = PAL.ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = 'bold ' + Math.round(HH * 0.34) + 'px sans-serif';
      ctx.fillText((d.gameKey === 'gomoku' ? '오목' : '오델로') + ' 기보', 40, HH * 0.32);
      ctx.font = Math.round(HH * 0.19) + 'px sans-serif';
      ctx.fillText(playersLine(d), 40, HH * 0.66);
      ctx.textAlign = 'right';
      ctx.fillText(fmtTime(d.startedAt) + '  ·  승자 ' + winnerLabel(d) + '  ·  ' + finishLabel(d.finishReason), HW - 40, HH * 0.66);
      return hc;
    }
    function buildTileCanvas(index) {
      var B = 460, capH = 64, tc = document.createElement('canvas');
      tc.width = B; tc.height = B + capH;
      var ctx = tc.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, tc.width, tc.height);
      var move = pb.detail.moves[index];
      if (move.type === 'pass') {
        ctx.fillStyle = '#efe6cf'; roundRectPath(ctx, 8, 8, B - 16, B - 16, 16); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = PAL.ink; ctx.stroke();
        ctx.fillStyle = PAL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = 'bold ' + Math.round(B * 0.12) + 'px sans-serif'; ctx.fillText('PASS', B / 2, B * 0.44);
        ctx.font = Math.round(B * 0.07) + 'px sans-serif'; ctx.fillText(giboColorLabel(move.color) + ' 패스', B / 2, B * 0.6);
      } else {
        paintBoard(ctx, B, pb.detail.gameKey, pb.detail.snapshots[index], { x: move.x, y: move.y });
      }
      ctx.fillStyle = rgba(PAL.ink, 0.86); roundRectPath(ctx, 10, 10, Math.max(42, B * 0.14), Math.round(B * 0.088), 8); ctx.fill();
      ctx.fillStyle = PAL.gold; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = 'bold ' + Math.round(B * 0.055) + 'px sans-serif'; ctx.fillText(String(index + 1), 22, 10 + B * 0.046);
      ctx.fillStyle = PAL.ink; ctx.fillRect(0, B, B, capH);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = Math.round(capH * 0.42) + 'px sans-serif'; ctx.fillText(giboMoveCaption(index, move), B / 2, B + capH / 2);
      return tc;
    }
    function exportGiboPdf() {
      var d = pb.detail; if (!d) return;
      var btn = el('pdf-btn'), old = btn.textContent; btn.disabled = true; btn.textContent = '생성 중…';
      setTimeout(function () {
        try {
          var pageW = 595, pageH = 842, margin = 36, headerHpt = 80, contentW = pageW - 2 * margin;
          var plan = giboGridPlan(d.moves.length, { pageW: pageW, pageH: pageH, margin: margin, cols: 3, colGap: 14, rowGap: 16, headerHpt: headerHpt, tileAspect: 524 / 460 });
          var pagesPlac = []; for (var pi = 0; pi < plan.pages; pi++) pagesPlac.push([]);
          var hc = buildHeaderCanvas();
          pagesPlac[0].push({ jpeg: dataUrlToBytes(hc.toDataURL('image/jpeg', 0.9)), wPx: hc.width, hPx: hc.height, xPt: margin, yPtBottom: pageH - margin - headerHpt, wPt: contentW, hPt: headerHpt });
          for (var i = 0; i < d.moves.length; i++) {
            var tc = buildTileCanvas(i), s = plan.slots[i];
            pagesPlac[s.page].push({ jpeg: dataUrlToBytes(tc.toDataURL('image/jpeg', 0.85)), wPx: tc.width, hPx: tc.height, xPt: s.xPt, yPtBottom: pageH - s.yTopPt - plan.tileH, wPt: plan.tileW, hPt: plan.tileH });
          }
          var blob = new Blob([encodeJpegPdf(pageW, pageH, pagesPlac)], { type: 'application/pdf' });
          var url = URL.createObjectURL(blob), a = document.createElement('a');
          a.href = url; a.download = 'gibo-' + d.gameKey + '-' + d.sessionId + '.pdf';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        } catch (e) { alert('PDF 생성 실패: ' + e); }
        btn.disabled = false; btn.textContent = old;
      }, 30);
    }

    // ---- wiring ----------------------------------------------------------
    el('game-filter').addEventListener('change', function () { state.game = this.value; state.page = 1; loadList(); });
    el('user-search-btn').addEventListener('click', doUserSearch);
    el('user-search').addEventListener('keydown', function (e) { if (e.key === 'Enter') doUserSearch(); });
    el('prev-page').addEventListener('click', function () { if (state.page > 1) { state.page -= 1; loadList(); } });
    el('next-page').addEventListener('click', function () { state.page += 1; loadList(); });
    el('back-btn').addEventListener('click', function () { clearTimeout(pb.timer); loadList(); });
    el('pause-btn').addEventListener('click', togglePause);
    el('restart-btn').addEventListener('click', startPlayback);
    el('pdf-btn').addEventListener('click', exportGiboPdf);

    loadList();
  })();
  </script>
</body>
</html>`;

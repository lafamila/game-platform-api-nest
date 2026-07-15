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

    function drawBoard(board, last) {
      var canvas = el('board');
      var ctx = canvas.getContext('2d');
      var size = pb.detail.boardSize;
      var W = canvas.width;
      var cell = W / size;
      var isGomoku = pb.detail.gameKey === 'gomoku';
      ctx.clearRect(0, 0, W, W);
      ctx.fillStyle = isGomoku ? '#d8b98a' : '#2f7d55';
      ctx.fillRect(0, 0, W, W);
      // grid
      ctx.strokeStyle = isGomoku ? 'rgba(80,50,20,0.55)' : 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      for (var i = 0; i <= size; i++) {
        var p = Math.round(i * cell) + 0.5;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, W); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(W, p); ctx.stroke();
      }
      // stones / disks (centered in each cell)
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          var v = board[r] && board[r][c];
          if (!v) continue;
          var cx = c * cell + cell / 2;
          var cy = r * cell + cell / 2;
          var radius = cell * 0.42;
          ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fillStyle = v === 'black' ? '#111' : '#fafafa';
          ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
        }
      }
      // last-move marker
      if (last) {
        var mx = last.x * cell + cell / 2;
        var my = last.y * cell + cell / 2;
        ctx.beginPath(); ctx.arc(mx, my, cell * 0.12, 0, Math.PI * 2);
        ctx.fillStyle = '#e23b3b'; ctx.fill();
      }
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

    loadList();
  })();
  </script>
</body>
</html>`;

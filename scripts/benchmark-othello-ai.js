#!/usr/bin/env node

const { searchOthelloMove } = require('../dist/games/othello-ai.js');
const {
  applyOthelloMove,
  initialOthelloBoard,
  othelloLegalMoves,
} = require('../dist/games/othello-engine.js');

function createSession() {
  return {
    id: 'othello-benchmark',
    mode: 'friend_match',
    board: initialOthelloBoard(),
    currentTurn: 'black',
    status: 'playing',
    players: { black: 'black', white: 'white' },
    moves: [],
    createdAt: '',
    updatedAt: '',
  };
}

function positionAfter(plies, seed) {
  const session = createSession();
  let state = seed >>> 0;
  for (let ply = 0; ply < plies && session.status === 'playing'; ply += 1) {
    const moves = othelloLegalMoves(session.board, session.currentTurn);
    if (moves.length === 0) break;
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const move = moves[state % moves.length];
    const accountId = session.currentTurn === 'black' ? 'black' : 'white';
    applyOthelloMove(session, accountId, move.row, move.col, 'manual');
  }
  return session;
}

function measure(name, session, configuredBudgetMs) {
  const startedAt = Date.now();
  const result = searchOthelloMove(session.board, session.currentTurn, configuredBudgetMs);
  return {
    name,
    empties: session.board.flat().filter((cell) => cell === null).length,
    configuredBudgetMs,
    effectiveBudgetMs: result.diagnostics?.budgetMs,
    elapsedMs: Date.now() - startedAt,
    move: result.move,
    depth: result.depth,
    nodes: result.nodes,
    nodesPerSecond: Math.round(result.nodes / Math.max(0.001, (result.diagnostics?.elapsedMs ?? 1) / 1_000)),
    exitReason: result.diagnostics?.exitReason,
  };
}

const configuredBudgetMs = Math.max(1, Number.parseInt(process.argv[2] ?? '10000', 10) || 10_000);
searchOthelloMove(initialOthelloBoard(), 'black', 50, undefined, { maxSearchNodes: 2_000, exactMode: 'off' });

const cases = [
  ['opening', positionAfter(0, 7)],
  ['midgame', positionAfter(16, 7)],
  ['late-midgame', positionAfter(42, 7)],
  ['endgame', positionAfter(52, 1)],
];

console.log(JSON.stringify(cases.map(([name, session]) => measure(name, session, configuredBudgetMs)), null, 2));

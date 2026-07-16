import { searchGomokuMove } from '../dist/games/gomoku-ai.js';
import { initialGomokuBoard } from '../dist/games/gomoku-engine.js';

const nodeLimit = Number.parseInt(process.argv[2] ?? '50000', 10);

function boardWith(black, white) {
  const board = initialGomokuBoard();
  for (const [row, col] of black) board[row][col] = 'black';
  for (const [row, col] of white) board[row][col] = 'white';
  return board;
}

const positions = [
  {
    name: 'opening',
    turn: 'white',
    board: boardWith([[7, 7]], []),
  },
  {
    name: 'wide-midgame',
    turn: 'black',
    board: boardWith(
      [[7, 7], [5, 5], [9, 9], [4, 9], [10, 4], [3, 6], [11, 8], [6, 11]],
      [[7, 8], [8, 7], [6, 6], [9, 5], [5, 9], [10, 10], [4, 7], [11, 6]],
    ),
  },
];

for (const position of positions) {
  const result = searchGomokuMove(position.board, position.turn, 25_000, undefined, {
    maxSearchNodes: nodeLimit,
    useOpeningBook: false,
  });
  const elapsedMs = Math.max(1, result.diagnostics.elapsedMs);
  console.log({
    name: position.name,
    move: result.move,
    depth: result.depth,
    score: result.score,
    nodes: result.nodes,
    nps: Math.round((result.nodes * 1_000) / elapsedMs),
    elapsedMs,
    vcfNodes: result.diagnostics.vcfNodes,
    vctNodes: result.diagnostics.vctNodes,
    exitReason: result.diagnostics.exitReason,
  });
}

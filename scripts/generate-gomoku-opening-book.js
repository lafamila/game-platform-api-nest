import fs from 'node:fs';

import { searchGomokuMove } from '../dist/games/gomoku-ai.js';
import { initialGomokuBoard } from '../dist/games/gomoku-engine.js';
import { encodeGomokuOpeningBookEntry } from '../dist/games/gomoku-opening-book.js';

const outputPath = process.argv[2] ?? '/tmp/gomoku-opening-book.generated.json';
const nodeLimit = Number.parseInt(process.env.GOMOKU_BOOK_NODES ?? '75000', 10);
const budgetMs = Number.parseInt(process.env.GOMOKU_BOOK_BUDGET_MS ?? '25000', 10);
const plies = Number.parseInt(process.env.GOMOKU_BOOK_PLIES ?? '12', 10);
const whiteBranches = [[7, 6], [6, 6], [6, 7]];
const entries = new Map();
const lines = [];

for (const [branchIndex, whiteBranch] of whiteBranches.entries()) {
  const board = initialGomokuBoard();
  const line = [];
  for (let ply = 0; ply < plies; ply += 1) {
    const turn = ply % 2 === 0 ? 'black' : 'white';
    let move;
    let diagnostics = null;
    let score = 0;
    if (ply === 1) {
      move = { row: whiteBranch[0], col: whiteBranch[1] };
    } else {
      const result = searchGomokuMove(board, turn, budgetMs, undefined, {
        maxSearchNodes: nodeLimit,
        useOpeningBook: false,
      });
      move = result.move;
      diagnostics = result.diagnostics;
      score = result.score;
    }
    if (!move) throw new Error(`analysis returned no move at ply ${ply + 1}`);

    const entry = encodeGomokuOpeningBookEntry(board, turn, move);
    if (!entry) throw new Error(`could not encode move ${JSON.stringify(move)} at ply ${ply + 1}`);
    const existing = entries.get(entry[0]);
    // Alternate white replies branch the analysis tree; only the first branch
    // defines the runtime book's deterministic reply for the shared position.
    if (ply !== 1 || branchIndex === 0) {
      if (existing !== undefined && existing !== entry[1]) {
        throw new Error(`canonical book conflict for ${entry[0]}: ${existing} vs ${entry[1]}`);
      }
      entries.set(entry[0], entry[1]);
    }
    line.push({ turn, move, depth: diagnostics?.completedDepth ?? 0, score });
    board[move.row][move.col] = turn;
  }
  lines.push(line);
}

const output = {
  format: 'gomoku-opening-book-v1',
  boardSize: 15,
  analysis: { engine: 'gomoku-hard-v3', nodeLimit, budgetMs, plies, branches: whiteBranches },
  entries: [...entries.entries()],
  lines,
};
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${entries.size} canonical entries to ${outputPath}`);

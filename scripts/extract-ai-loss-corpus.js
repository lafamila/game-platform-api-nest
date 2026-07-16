#!/usr/bin/env node

const fs = require('node:fs');
const { Pool } = require('pg');

const LOCAL_AI_ACCOUNT_ID = '__game_platform_local_ai__';

function initialBoard(gameKey) {
  if (gameKey === 'gomoku') {
    return Array.from({ length: 15 }, () => Array(15).fill(null));
  }
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  board[3][3] = 'white';
  board[3][4] = 'black';
  board[4][3] = 'black';
  board[4][4] = 'white';
  return board;
}

function applyOthelloMove(board, row, col, color) {
  const opponent = color === 'black' ? 'white' : 'black';
  const flips = [];
  for (const [dr, dc] of [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1],
  ]) {
    const line = [];
    let nextRow = row + dr;
    let nextCol = col + dc;
    while (board[nextRow]?.[nextCol] === opponent) {
      line.push([nextRow, nextCol]);
      nextRow += dr;
      nextCol += dc;
    }
    if (line.length > 0 && board[nextRow]?.[nextCol] === color) flips.push(...line);
  }
  board[row][col] = color;
  for (const [flipRow, flipCol] of flips) board[flipRow][flipCol] = color;
}

function boardBeforePly(gameKey, history, ply) {
  const board = initialBoard(gameKey);
  for (const entry of history) {
    if (entry.n >= ply) break;
    if (entry.type !== 'move') continue;
    if (gameKey === 'gomoku') board[entry.y][entry.x] = entry.color;
    else applyOthelloMove(board, entry.y, entry.x, entry.color);
  }
  return board;
}

async function extractLossCorpus(gameKey, connectionString) {
  if (gameKey !== 'gomoku' && gameKey !== 'othello') {
    throw new Error('gameKey must be gomoku or othello');
  }
  const pool = new Pool({ connectionString });
  try {
    const sessions = await pool.query(`
      SELECT id::text, winner, state_json
      FROM game_sessions
      WHERE game_key = $1
        AND mode = 'local_ai'
        AND status = 'finished'
        AND state_json->>'aiDifficulty' = 'hard'
        AND winner IS NOT NULL
      ORDER BY updated_at DESC
    `, [gameKey]);
    const decisions = await pool.query(`
      SELECT session_id::text, ply, color, board_hash, chosen_row, chosen_col,
             budget_ms, elapsed_ms, completed_depth, search_nodes, vcf_nodes,
             vct_nodes, evaluation_calls, forbidden_checks,
             candidate_generations, score, principal_variation_json,
             exit_reason, engine_version, decision_source, fallback_reason
      FROM ai_decisions
      WHERE game_key = $1
      ORDER BY session_id, ply
    `, [gameKey]);
    const bySession = new Map();
    for (const decision of decisions.rows) {
      const list = bySession.get(decision.session_id) ?? [];
      list.push(decision);
      bySession.set(decision.session_id, list);
    }

    const corpus = [];
    for (const row of sessions.rows) {
      const state = row.state_json;
      const winnerAccountId = state.players?.[row.winner];
      if (!winnerAccountId || winnerAccountId === LOCAL_AI_ACCOUNT_ID) continue;
      const history = Array.isArray(state.moveHistory) ? state.moveHistory : [];
      for (const decision of bySession.get(row.id) ?? []) {
        if (state.players?.[decision.color] !== LOCAL_AI_ACCOUNT_ID) continue;
        corpus.push({
          gameKey,
          sessionId: row.id,
          eventualWinner: row.winner,
          ply: decision.ply,
          color: decision.color,
          board: boardBeforePly(gameKey, history, decision.ply),
          chosenMove: decision.chosen_row === null ? null : { row: decision.chosen_row, col: decision.chosen_col },
          diagnostics: {
            engineVersion: decision.engine_version,
            boardHash: decision.board_hash,
            budgetMs: decision.budget_ms,
            elapsedMs: decision.elapsed_ms,
            completedDepth: decision.completed_depth,
            searchNodes: decision.search_nodes,
            vcfNodes: decision.vcf_nodes,
            vctNodes: decision.vct_nodes,
            evaluationCalls: decision.evaluation_calls,
            forbiddenChecks: decision.forbidden_checks,
            candidateGenerations: decision.candidate_generations,
            score: decision.score,
            principalVariation: decision.principal_variation_json,
            exitReason: decision.exit_reason,
            decisionSource: decision.decision_source,
            fallbackReason: decision.fallback_reason,
          },
          remainingMoves: history.filter((entry) => entry.n >= decision.ply),
        });
      }
    }
    return corpus;
  } finally {
    await pool.end();
  }
}

async function main(gameKey, outputPath = process.argv[2]) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const corpus = await extractLossCorpus(gameKey, connectionString);
  const output = JSON.stringify({ gameKey, generatedAt: new Date().toISOString(), positions: corpus }, null, 2);
  if (outputPath) {
    fs.writeFileSync(outputPath, `${output}\n`);
    console.log(`wrote ${corpus.length} ${gameKey} positions to ${outputPath}`);
  } else {
    process.stdout.write(`${output}\n`);
  }
}

module.exports = { applyOthelloMove, boardBeforePly, extractLossCorpus, initialBoard, main };

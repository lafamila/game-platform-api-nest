#!/usr/bin/env node

const fs = require('node:fs');
const { Pool } = require('pg');

const LOCAL_AI_ACCOUNT_ID = '__game_platform_local_ai__';
const SIZE = 15;

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
}

function boardBeforePly(history, ply) {
  const board = emptyBoard();
  for (const entry of history) {
    if (entry.n >= ply) break;
    if (entry.type === 'move') board[entry.y][entry.x] = entry.color;
  }
  return board;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString });
  try {
    const sessions = await pool.query(`
      SELECT id::text, winner, state_json
      FROM game_sessions
      WHERE game_key = 'gomoku'
        AND mode = 'local_ai'
        AND status = 'finished'
        AND state_json->>'aiDifficulty' = 'hard'
        AND winner IS NOT NULL
      ORDER BY updated_at DESC
    `);
    const decisions = await pool.query(`
      SELECT session_id::text, ply, color, board_hash, chosen_row, chosen_col,
             budget_ms, elapsed_ms, completed_depth, search_nodes, vcf_nodes,
             vct_nodes, evaluation_calls, forbidden_checks,
             candidate_generations, score, principal_variation_json,
             exit_reason, engine_version
      FROM ai_decisions
      WHERE game_key = 'gomoku'
      ORDER BY session_id, ply
    `);
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
          sessionId: row.id,
          eventualWinner: row.winner,
          ply: decision.ply,
          color: decision.color,
          board: boardBeforePly(history, decision.ply),
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
          },
          remainingMoves: history.filter((entry) => entry.n >= decision.ply),
        });
      }
    }

    const output = JSON.stringify({ generatedAt: new Date().toISOString(), positions: corpus }, null, 2);
    const outputPath = process.argv[2];
    if (outputPath) {
      fs.writeFileSync(outputPath, `${output}\n`);
      console.log(`wrote ${corpus.length} positions to ${outputPath}`);
    } else {
      process.stdout.write(`${output}\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

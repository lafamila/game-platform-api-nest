import { PlayerColor } from './games.types';
import {
  AiDepthReporter,
  AiSearchDiagnostics,
  AiSearchResult,
  AiWorkerMove,
} from './engine/ai-worker-protocol';
import { FixedTranspositionTable } from './engine/fixed-transposition-table';
import { TTFlag } from './engine/zobrist';
import {
  GOMOKU_AI_SIZE,
  GomokuAiBoard,
  GomokuAiPosition,
  GomokuThreatProfile,
} from './gomoku-ai-position';
import { lookupGomokuOpeningMove } from './gomoku-opening-book';

const WIN = 10_000_000;
const ROOT_QUIET_LIMIT = 28;
const SHALLOW_QUIET_LIMIT = 14;
const DEEP_QUIET_LIMIT = 10;
// Canonical threat-profile property sampling keeps 360 as the lowest observed
// open-three ordering score. Use a small margin while excluding quiet noise.
export const GOMOKU_TACTICAL_SCAN_FLOOR = 350;
const VCF_MAX_DEPTH = 12;
const THREAT_MAX_DEPTH = 9;
const MAX_FORCED_EXTENSIONS = 8;
const MAX_SEARCH_PLIES = 64;
const TT_POWER = 19;
const THREAT_TT_POWER = 16;
const ASPIRATION_INITIAL = 2_000;
const PROOF_INFINITY = 1_000_000_000;
const SHARED_SEARCH_TT = new FixedTranspositionTable(TT_POWER);
const SHARED_THREAT_TT = new FixedTranspositionTable(THREAT_TT_POWER);
export const GOMOKU_AI_ENGINE_VERSION = 'gomoku-hard-v3';
const TIMEOUT = Symbol('gomoku-ai-timeout');
const NODE_LIMIT = Symbol('gomoku-ai-node-limit');
const WORKER_RETURN_MARGIN_MS = 5;

interface ScoredMove extends AiWorkerMove {
  score: number;
  tacticalScore: number;
  mandatory: boolean;
}

interface TacticalBudget {
  remaining: number;
  exhausted: boolean;
}

interface ThreatProof {
  proof: number;
  disproof: number;
  move: AiWorkerMove | null;
}

type ExitReason = AiSearchDiagnostics['exitReason'];

export interface GomokuSearchOptions {
  maxSearchNodes?: number;
  deadlineAt?: number;
  useOpeningBook?: boolean;
}

function opposite(color: PlayerColor): PlayerColor {
  return color === 'black' ? 'white' : 'black';
}

function moveIndex(move: AiWorkerMove): number {
  return move.row * GOMOKU_AI_SIZE + move.col;
}

function moveFromIndex(index: number): AiWorkerMove {
  return { row: Math.floor(index / GOMOKU_AI_SIZE), col: index % GOMOKU_AI_SIZE };
}

function sameMove(first: AiWorkerMove, second: AiWorkerMove): boolean {
  return first.row === second.row && first.col === second.col;
}

function stoneCount(board: GomokuAiBoard): number {
  let count = 0;
  for (const row of board) for (const cell of row) if (cell) count += 1;
  return count;
}

export function gomokuPhaseBudgetMs(board: GomokuAiBoard, configuredBudgetMs: number): number {
  const safeBudget = Math.max(1, configuredBudgetMs);
  if (safeBudget < 500) return safeBudget;
  const stones = stoneCount(board);
  if (stones <= 4) return Math.min(safeBudget, 3_000);
  if (stones <= 8) return Math.min(safeBudget, 8_000);
  return safeBudget;
}

function threatValue(profile: GomokuThreatProfile | null): number {
  if (!profile) return 0;
  if (profile.exactFive) return WIN;
  if (profile.fours >= 2 || (profile.fours >= 1 && profile.openThrees >= 1)) return WIN / 2;
  if (profile.openThrees >= 2) return WIN / 4;
  return profile.fours * 16_000 + profile.openThrees * 1_800 + profile.crossingThreats * 900;
}

function saturatingAdd(first: number, second: number): number {
  return Math.min(PROOF_INFINITY, first + second);
}

class GomokuSearch {
  readonly position: GomokuAiPosition;
  readonly startedAt = Date.now();
  readonly deadline: number;
  readonly budgetMs: number;
  readonly initialBoardHash: string;

  private readonly tt = SHARED_SEARCH_TT;
  private readonly threatTt = SHARED_THREAT_TT;
  private readonly killers = new Int16Array(MAX_SEARCH_PLIES * 2);
  private readonly history = new Int32Array(GOMOKU_AI_SIZE * GOMOKU_AI_SIZE * 2);
  private readonly maxSearchNodes?: number;

  constructor(board: GomokuAiBoard, budgetMs: number, options?: GomokuSearchOptions) {
    this.position = new GomokuAiPosition(board);
    this.budgetMs = budgetMs;
    this.deadline = this.startedAt + budgetMs;
    this.initialBoardHash = this.position.boardHash();
    this.maxSearchNodes = options?.maxSearchNodes;
    this.killers.fill(-1);
    // Search is synchronous within each worker isolate, so these backing
    // arrays can be reused without per-turn multi-megabyte allocations.
    this.tt.clear();
    this.threatTt.clear();
    this.tt.beginGeneration();
    this.threatTt.beginGeneration();
  }

  private checkDeadline(force = false): void {
    if (this.maxSearchNodes !== undefined && this.position.metrics.searchNodes >= this.maxSearchNodes) {
      throw NODE_LIMIT;
    }
    if ((force || (this.position.metrics.searchNodes & 255) === 0) && Date.now() >= this.deadline) {
      throw TIMEOUT;
    }
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  private probe(table: FixedTranspositionTable, color: PlayerColor, attacker?: PlayerColor): number {
    let [primary, verifier] = this.position.hash(color);
    if (attacker === 'white') {
      primary = (primary ^ 0xa511e9b3) >>> 0;
      verifier = (verifier ^ 0x63d83595) >>> 0;
    }
    return table.probe(primary, verifier);
  }

  private store(
    table: FixedTranspositionTable,
    color: PlayerColor,
    depth: number,
    score: number,
    flag: TTFlag,
    move: AiWorkerMove | null,
    attacker?: PlayerColor,
  ): void {
    let [primary, verifier] = this.position.hash(color);
    if (attacker === 'white') {
      primary = (primary ^ 0xa511e9b3) >>> 0;
      verifier = (verifier ^ 0x63d83595) >>> 0;
    }
    table.store(primary, verifier, depth, score, flag, move ? moveIndex(move) : -1);
  }

  private validTtMove(color: PlayerColor, slot: number): AiWorkerMove | null {
    if (slot < 0) return null;
    const index = this.tt.moveAt(slot);
    if (index < 0) return null;
    const move = moveFromIndex(index);
    if (!this.position.isEmpty(move.row, move.col)) return null;
    return this.position.isLegal(move.row, move.col, color) ? move : null;
  }

  private quietLimit(ply: number): number {
    if (ply === 0) return ROOT_QUIET_LIMIT;
    if (ply <= 2) return SHALLOW_QUIET_LIMIT;
    return DEEP_QUIET_LIMIT;
  }

  private historyScore(color: PlayerColor, move: AiWorkerMove): number {
    const offset = color === 'black' ? 0 : GOMOKU_AI_SIZE * GOMOKU_AI_SIZE;
    return this.history[offset + moveIndex(move)];
  }

  private recordCutoff(color: PlayerColor, move: AiWorkerMove, depth: number, ply: number): void {
    if (ply < MAX_SEARCH_PLIES) {
      const index = moveIndex(move);
      const first = ply * 2;
      if (this.killers[first] !== index) {
        this.killers[first + 1] = this.killers[first];
        this.killers[first] = index;
      }
    }
    const offset = color === 'black' ? 0 : GOMOKU_AI_SIZE * GOMOKU_AI_SIZE;
    const slot = offset + moveIndex(move);
    this.history[slot] += Math.max(1, depth * depth);
    if (this.history[slot] > 1_000_000) {
      for (let index = 0; index < this.history.length; index += 1) this.history[index] >>= 1;
    }
  }

  candidates(color: PlayerColor, ply = 0, depth = 1, precise = false): AiWorkerMove[] {
    const opponent = opposite(color);
    const cells = this.position.candidateCells();
    const ownWins = new Set(this.position.immediateWinningMoves(color).map(moveIndex));
    const opponentWins = new Set(this.position.immediateWinningMoves(opponent).map(moveIndex));
    const scored: ScoredMove[] = cells.map((move) => {
      const attack = this.position.moveOrderingScore(move.row, move.col, color);
      let defense = this.position.moveOrderingScore(move.row, move.col, opponent);
      if (opponent === 'black' && defense >= 2_500 && !this.position.isLegal(move.row, move.col, opponent)) {
        defense = 0;
      }
      const center = 14 - Math.abs(move.row - 7) - Math.abs(move.col - 7);
      const index = moveIndex(move);
      const killerBase = Math.min(ply, MAX_SEARCH_PLIES - 1) * 2;
      const killer = this.killers[killerBase] === index ? 45_000 : this.killers[killerBase + 1] === index ? 22_000 : 0;
      return {
        ...move,
        score: attack + defense * 0.92 + center + killer + this.historyScore(color, move),
        tacticalScore: Math.max(attack, defense),
        mandatory: ownWins.has(index) || opponentWins.has(index),
      };
    });
    scored.sort((first, second) => second.score - first.score || moveIndex(first) - moveIndex(second));

    const profileCount = Math.min(
      scored.length,
      precise ? 48 : Math.max(32, this.quietLimit(ply) * 2),
    );
    for (let index = 0; index < scored.length; index += 1) {
      const move = scored[index];
      if (!precise || index >= profileCount) {
        // The cheap ordering score deliberately over-approximates tactical
        // shapes. Deep nodes keep every such move without paying two full
        // canonical forbidden/profile simulations per candidate.
        move.mandatory ||= move.tacticalScore >= GOMOKU_TACTICAL_SCAN_FLOOR;
        continue;
      }
      const attack = this.position.threatProfile(move.row, move.col, color);
      const defense = this.position.threatProfile(move.row, move.col, opponent);
      const tactical = Boolean(
        attack?.exactFive || attack?.fours || attack?.openThrees ||
        defense?.exactFive || defense?.fours || defense?.openThrees,
      );
      move.mandatory ||= tactical;
      move.score += threatValue(attack) + threatValue(defense) * 0.95;
    }
    scored.sort((first, second) => second.score - first.score || moveIndex(first) - moveIndex(second));

    const legal: AiWorkerMove[] = [];
    let quiet = 0;
    const quietLimit = this.quietLimit(ply);
    for (const move of scored) {
      if (!this.position.isLegal(move.row, move.col, color)) continue;
      if (!move.mandatory && quiet >= quietLimit) continue;
      legal.push({ row: move.row, col: move.col });
      if (!move.mandatory) quiet += 1;
    }
    return legal;
  }

  private withTtFirst(color: PlayerColor, moves: AiWorkerMove[]): AiWorkerMove[] {
    const ttMove = this.validTtMove(color, this.probe(this.tt, color));
    if (!ttMove) return moves;
    return [ttMove, ...moves.filter((move) => !sameMove(move, ttMove))];
  }

  private negamax(
    color: PlayerColor,
    depth: number,
    alphaIn: number,
    betaIn: number,
    ply: number,
    forcedExtensions: number,
  ): number {
    this.position.metrics.searchNodes += 1;
    this.checkDeadline();

    let alpha = alphaIn;
    let beta = betaIn;
    const slot = this.probe(this.tt, color);
    if (slot >= 0 && this.tt.depthAt(slot) >= depth) {
      const score = this.tt.scoreAt(slot);
      const flag = this.tt.flagAt(slot);
      if (flag === 'exact') return score;
      if (flag === 'lower') alpha = Math.max(alpha, score);
      if (flag === 'upper') beta = Math.min(beta, score);
      if (alpha >= beta) return score;
    }

    const ownWins = this.position.immediateWinningMoves(color);
    if (ownWins.length > 0) return WIN - ply;

    const opponent = opposite(color);
    const opponentWins = this.position.immediateWinningMoves(opponent);
    const forced = opponentWins.length > 0;
    if (!forced && depth <= 0) return this.position.evaluate(color);
    if (opponentWins.length >= 2) return -WIN + ply;

    let moves = forced
      ? opponentWins.filter((move) => this.position.isLegal(move.row, move.col, color))
      : this.candidates(color, ply, depth);
    if (moves.length === 0) return forced ? -WIN + ply : this.position.evaluate(color);
    moves = this.withTtFirst(color, moves);

    const searchedAlpha = alpha;
    const searchedBeta = beta;
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves[0];
    let firstMove = true;
    for (const move of moves) {
      this.position.makeMove(move.row, move.col, color);
      let score: number;
      try {
        if (this.position.isExactFiveAt(move.row, move.col, color)) {
          score = WIN - ply;
        } else {
          const extend = forced && forcedExtensions < MAX_FORCED_EXTENSIONS;
          const nextDepth = extend ? depth : depth - 1;
          const nextExtensions = extend ? forcedExtensions + 1 : forcedExtensions;
          if (firstMove) {
            score = -this.negamax(opponent, nextDepth, -beta, -alpha, ply + 1, nextExtensions);
          } else {
            score = -this.negamax(opponent, nextDepth, -alpha - 1, -alpha, ply + 1, nextExtensions);
            if (score > alpha && score < beta) {
              score = -this.negamax(opponent, nextDepth, -beta, -alpha, ply + 1, nextExtensions);
            }
          }
        }
      } finally {
        this.position.unmakeMove(move.row, move.col);
      }
      firstMove = false;
      if (score > best) {
        best = score;
        bestMove = move;
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        this.recordCutoff(color, move, depth, ply);
        break;
      }
    }

    const flag: TTFlag = best <= searchedAlpha ? 'upper' : best >= searchedBeta ? 'lower' : 'exact';
    this.store(this.tt, color, depth, best, flag, bestMove);
    return best;
  }

  searchRoot(
    color: PlayerColor,
    depth: number,
    alphaIn = -WIN,
    betaIn = WIN,
    restrictedMoves?: AiWorkerMove[],
  ): { move: AiWorkerMove | null; score: number } {
    let moves = restrictedMoves?.length ? restrictedMoves.slice() : this.candidates(color, 0, depth, true);
    moves = moves.filter((move) => this.position.isEmpty(move.row, move.col) && this.position.isLegal(move.row, move.col, color));
    if (moves.length === 0) return { move: null, score: 0 };
    moves = this.withTtFirst(color, moves);

    const opponent = opposite(color);
    let alpha = alphaIn;
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves[0];
    let firstMove = true;
    for (const move of moves) {
      this.checkDeadline(true);
      this.position.makeMove(move.row, move.col, color);
      let score: number;
      try {
        if (this.position.isExactFiveAt(move.row, move.col, color)) {
          score = WIN - 1;
        } else if (firstMove) {
          score = -this.negamax(opponent, depth - 1, -betaIn, -alpha, 1, 0);
        } else {
          score = -this.negamax(opponent, depth - 1, -alpha - 1, -alpha, 1, 0);
          if (score > alpha && score < betaIn) {
            score = -this.negamax(opponent, depth - 1, -betaIn, -alpha, 1, 0);
          }
        }
      } finally {
        this.position.unmakeMove(move.row, move.col);
      }
      firstMove = false;
      if (score > best) {
        best = score;
        bestMove = move;
      }
      if (best > alpha) alpha = best;
      if (alpha >= betaIn) {
        this.recordCutoff(color, move, depth, 0);
        break;
      }
    }
    const flag: TTFlag = best <= alphaIn ? 'upper' : best >= betaIn ? 'lower' : 'exact';
    this.store(this.tt, color, depth, best, flag, bestMove);
    return { move: bestMove, score: best };
  }

  searchRootAspiration(
    color: PlayerColor,
    depth: number,
    previousScore: number,
    restrictedMoves?: AiWorkerMove[],
  ): { move: AiWorkerMove | null; score: number } {
    if (depth <= 2 || Math.abs(previousScore) >= WIN - 10_000) {
      return this.searchRoot(color, depth, -WIN, WIN, restrictedMoves);
    }
    let window = ASPIRATION_INITIAL;
    while (window < WIN) {
      const alpha = Math.max(-WIN, previousScore - window);
      const beta = Math.min(WIN, previousScore + window);
      const result = this.searchRoot(color, depth, alpha, beta, restrictedMoves);
      if (result.score > alpha && result.score < beta) return result;
      window = Math.min(WIN, window * 4);
    }
    return this.searchRoot(color, depth, -WIN, WIN, restrictedMoves);
  }

  private forcingMoves(color: PlayerColor, includeThrees: boolean, limit: number): AiWorkerMove[] {
    const cells = this.position.candidateCells()
      .map((move) => ({ ...move, score: this.position.moveOrderingScore(move.row, move.col, color) }))
      .sort((first, second) => second.score - first.score || moveIndex(first) - moveIndex(second));
    const result: ScoredMove[] = [];
    for (const move of cells) {
      // The numeric ordering score is a conservative prefilter: every exact
      // five/four scores at least 2,800 and every open-three at least 4,500.
      // Avoid canonical rule simulation for unrelated quiet cells.
      if (move.score < (includeThrees ? GOMOKU_TACTICAL_SCAN_FLOOR : 2_500)) break;
      this.checkDeadline(true);
      const profile = this.position.threatProfile(move.row, move.col, color);
      if (!profile) continue;
      if (profile.exactFive || profile.fours > 0 || (includeThrees && profile.openThrees > 0)) {
        result.push({
          ...move,
          score: threatValue(profile) + move.score,
          tacticalScore: move.score,
          mandatory: true,
        });
      }
    }
    result.sort((first, second) => second.score - first.score || moveIndex(first) - moveIndex(second));
    return result.slice(0, limit).map(({ row, col }) => ({ row, col }));
  }

  vcf(attacker: PlayerColor, depthLeft: number): AiWorkerMove | null {
    this.position.metrics.vcfNodes += 1;
    this.checkDeadline(true);
    if (depthLeft <= 0) return null;
    const defender = opposite(attacker);
    const attackerWins = this.position.immediateWinningMoves(attacker);
    if (attackerWins.length > 0) return attackerWins[0];
    if (this.position.immediateWinningMoves(defender).length > 0) return null;

    for (const move of this.forcingMoves(attacker, false, GOMOKU_AI_SIZE * GOMOKU_AI_SIZE)) {
      this.position.makeMove(move.row, move.col, attacker);
      let succeeds = false;
      try {
        if (this.position.isExactFiveAt(move.row, move.col, attacker)) return move;
        const attackerPoints = this.position.immediateWinningMoves(attacker);
        if (attackerPoints.length === 0) continue;
        if (this.position.immediateWinningMoves(defender).length > 0) continue;
        if (attackerPoints.length >= 2) return move;

        const block = attackerPoints[0];
        if (!this.position.isLegal(block.row, block.col, defender)) return move;
        this.position.makeMove(block.row, block.col, defender);
        try {
          if (!this.position.isExactFiveAt(block.row, block.col, defender)) {
            succeeds = this.vcf(attacker, depthLeft - 1) !== null;
          }
        } finally {
          this.position.unmakeMove(block.row, block.col);
        }
      } finally {
        this.position.unmakeMove(move.row, move.col);
      }
      if (succeeds) return move;
    }
    return null;
  }

  private spendTacticalNode(budget: TacticalBudget): boolean {
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      return false;
    }
    budget.remaining -= 1;
    this.position.metrics.vctNodes += 1;
    this.checkDeadline(true);
    return true;
  }

  private exactThreatDefenses(attacker: PlayerColor, defender: PlayerColor): AiWorkerMove[] {
    const replies = new Map<number, AiWorkerMove>();
    const add = (move: AiWorkerMove) => {
      if (this.position.isLegal(move.row, move.col, defender)) replies.set(moveIndex(move), move);
    };

    const defenderWins = this.position.immediateWinningMoves(defender);
    for (const move of defenderWins) add(move);
    const attackerWins = this.position.immediateWinningMoves(attacker);
    if (attackerWins.length > 0) {
      for (const move of attackerWins) add(move);
      return [...replies.values()];
    }

    const extensions = this.position.openThreeExtensionMoves(attacker);
    if (extensions.length <= 2) {
      // A single open-three can have non-obvious line-changing replies under
      // the custom forbidden rules. Enumerate every legal defense; if the node
      // budget cannot cover them the proof stays unknown, never a false win.
      for (let index = 0; index < GOMOKU_AI_SIZE * GOMOKU_AI_SIZE; index += 1) {
        add(moveFromIndex(index));
      }
      return [...replies.values()];
    }

    // Independent/crossing threats use their complete cost-square set.
    for (const move of extensions) add(move);
    for (const move of this.forcingMoves(attacker, true, GOMOKU_AI_SIZE * GOMOKU_AI_SIZE)) add(move);
    for (const move of this.forcingMoves(defender, false, GOMOKU_AI_SIZE * GOMOKU_AI_SIZE)) add(move);
    return [...replies.values()];
  }

  threatSpace(attacker: PlayerColor, depthLeft: number, budget: TacticalBudget): ThreatProof {
    if (!this.spendTacticalNode(budget)) return { proof: 1, disproof: 1, move: null };
    const defender = opposite(attacker);
    const attackerWins = this.position.immediateWinningMoves(attacker);
    if (attackerWins.length > 0) return { proof: 0, disproof: PROOF_INFINITY, move: attackerWins[0] };
    if (this.position.immediateWinningMoves(defender).length > 0 || depthLeft <= 0) {
      return { proof: 1, disproof: 0, move: null };
    }

    const ttSlot = this.probe(this.threatTt, attacker, attacker);
    if (ttSlot >= 0 && this.threatTt.depthAt(ttSlot) >= depthLeft) {
      const score = this.threatTt.scoreAt(ttSlot);
      const index = this.threatTt.moveAt(ttSlot);
      return score > 0
        ? { proof: 0, disproof: PROOF_INFINITY, move: index >= 0 ? moveFromIndex(index) : null }
        : { proof: 1, disproof: 0, move: null };
    }

    const attacks = this.forcingMoves(attacker, true, GOMOKU_AI_SIZE * GOMOKU_AI_SIZE);
    if (attacks.length === 0) {
      this.store(this.threatTt, attacker, depthLeft, -1, 'exact', null, attacker);
      return { proof: 1, disproof: 0, move: null };
    }

    let proof = PROOF_INFINITY;
    let disproof = 0;
    for (const move of attacks) {
      this.position.makeMove(move.row, move.col, attacker);
      let moveProof = 0;
      let moveDisproof = PROOF_INFINITY;
      try {
        if (!this.position.isExactFiveAt(move.row, move.col, attacker)) {
          if (this.position.immediateWinningMoves(defender).length > 0) {
            moveProof = 1;
            moveDisproof = 0;
          } else {
            const defenses = this.exactThreatDefenses(attacker, defender);
            if (defenses.length === 0) {
              moveProof = 1;
              moveDisproof = 0;
            } else {
              for (const defense of defenses) {
                if (!this.spendTacticalNode(budget)) {
                  moveProof = Math.max(1, moveProof);
                  moveDisproof = Math.min(moveDisproof, 1);
                  break;
                }
                this.position.makeMove(defense.row, defense.col, defender);
                let child: ThreatProof;
                try {
                  child = this.position.isExactFiveAt(defense.row, defense.col, defender)
                    ? { proof: 1, disproof: 0, move: null }
                    : this.threatSpace(attacker, depthLeft - 1, budget);
                } finally {
                  this.position.unmakeMove(defense.row, defense.col);
                }
                moveProof = saturatingAdd(moveProof, child.proof);
                moveDisproof = Math.min(moveDisproof, child.disproof);
                if (child.proof !== 0 || budget.exhausted) break;
              }
            }
          }
        }
      } finally {
        this.position.unmakeMove(move.row, move.col);
      }

      proof = Math.min(proof, moveProof);
      disproof = saturatingAdd(disproof, moveDisproof);
      if (moveProof === 0 && !budget.exhausted) {
        this.store(this.threatTt, attacker, depthLeft, 1, 'exact', move, attacker);
        return { proof: 0, disproof: PROOF_INFINITY, move };
      }
      if (budget.exhausted) break;
    }

    if (!budget.exhausted) this.store(this.threatTt, attacker, depthLeft, -1, 'exact', null, attacker);
    return { proof: Math.max(1, proof), disproof: Math.min(disproof, PROOF_INFINITY), move: null };
  }

  findThreatDefenses(
    defender: PlayerColor,
    attacker: PlayerColor,
    attackerFirst: AiWorkerMove,
    depth: number,
    budget: TacticalBudget,
  ): AiWorkerMove[] {
    const options = this.candidates(defender, 0, depth, true);
    const seen = new Set(options.map(moveIndex));
    for (let index = 0; index < GOMOKU_AI_SIZE * GOMOKU_AI_SIZE; index += 1) {
      const move = moveFromIndex(index);
      if (!seen.has(index) && this.position.isLegal(move.row, move.col, defender)) {
        options.push(move);
        seen.add(index);
      }
    }
    if (this.position.isLegal(attackerFirst.row, attackerFirst.col, defender) &&
      !options.some((move) => sameMove(move, attackerFirst))) options.unshift(attackerFirst);
    const defenses: AiWorkerMove[] = [];
    for (const move of options) {
      if (budget.exhausted) break;
      this.position.makeMove(move.row, move.col, defender);
      try {
        if (this.position.isExactFiveAt(move.row, move.col, defender)) {
          defenses.push(move);
          continue;
        }
        const probe = this.threatSpace(attacker, Math.max(1, depth - 1), budget);
        if (probe.proof !== 0 && !budget.exhausted) defenses.push(move);
      } finally {
        this.position.unmakeMove(move.row, move.col);
      }
    }
    return defenses;
  }

  principalVariation(color: PlayerColor, maxDepth: number): AiWorkerMove[] {
    const result: AiWorkerMove[] = [];
    const made: AiWorkerMove[] = [];
    let turn = color;
    try {
      for (let depth = 0; depth < maxDepth; depth += 1) {
        const move = this.validTtMove(turn, this.probe(this.tt, turn));
        if (!move) break;
        result.push(move);
        this.position.makeMove(move.row, move.col, turn);
        made.push(move);
        if (this.position.isExactFiveAt(move.row, move.col, turn)) break;
        turn = opposite(turn);
      }
    } finally {
      while (made.length > 0) {
        const move = made.pop();
        if (move) this.position.unmakeMove(move.row, move.col);
      }
    }
    return result;
  }

  result(
    move: AiWorkerMove | null,
    depth: number,
    score: number,
    exitReason: ExitReason,
    principalVariation?: AiWorkerMove[],
  ): AiSearchResult {
    const metrics = this.position.metrics;
    return {
      move,
      depth,
      score,
      nodes: metrics.searchNodes,
      diagnostics: {
        engineVersion: GOMOKU_AI_ENGINE_VERSION,
        boardHash: this.initialBoardHash,
        budgetMs: this.budgetMs,
        elapsedMs: Date.now() - this.startedAt,
        completedDepth: depth,
        searchNodes: metrics.searchNodes,
        vcfNodes: metrics.vcfNodes,
        vctNodes: metrics.vctNodes,
        evaluationCalls: metrics.evaluationCalls,
        forbiddenChecks: metrics.forbiddenChecks,
        candidateGenerations: metrics.candidateGenerations,
        principalVariation: principalVariation ?? (move ? [move] : []),
        exitReason,
      },
    };
  }
}

export function searchGomokuMove(
  board: GomokuAiBoard,
  turn: PlayerColor,
  configuredBudgetMs: number,
  onDepth?: AiDepthReporter,
  options?: GomokuSearchOptions,
): AiSearchResult {
  const phaseBudgetMs = gomokuPhaseBudgetMs(board, configuredBudgetMs);
  const absoluteRemainingMs = options?.deadlineAt === undefined
    ? phaseBudgetMs
    : options.deadlineAt - Date.now() - WORKER_RETURN_MARGIN_MS;
  const budgetMs = Math.max(0, Math.min(phaseBudgetMs, absoluteRemainingMs));
  const search = new GomokuSearch(board, budgetMs, options);

  if (search.position.stoneCount === 0) {
    const move = { row: 7, col: 7 };
    onDepth?.({ depth: 1, move, score: 0 });
    return search.result(move, 1, 0, 'empty_board');
  }

  const immediate = search.position.immediateWinningMoves(turn);
  if (immediate.length > 0) {
    onDepth?.({ depth: 1, move: immediate[0], score: WIN });
    return search.result(immediate[0], 1, WIN, 'immediate_win');
  }

  const opponent = opposite(turn);
  const opponentWins = search.position.immediateWinningMoves(opponent);
  if (opponentWins.length === 1 && search.position.isLegal(opponentWins[0].row, opponentWins[0].col, turn)) {
    onDepth?.({ depth: 1, move: opponentWins[0], score: 0 });
    return search.result(opponentWins[0], 1, 0, 'forced_block');
  }

  const useOpeningBook = options?.useOpeningBook ?? options?.maxSearchNodes === undefined;
  if (useOpeningBook && budgetMs > 0) {
    const opening = lookupGomokuOpeningMove(board, turn);
    if (opening && search.position.isLegal(opening.row, opening.col, turn)) {
      onDepth?.({ depth: 0, move: opening, score: 0 });
      return search.result(opening, 0, 0, 'opening_book');
    }
  }

  const rootCandidates = search.candidates(turn, 0, 1, true);
  if (rootCandidates.length === 0) return search.result(null, 0, 0, 'no_legal_move');
  onDepth?.({ depth: 0, move: rootCandidates[0], score: 0 });
  let restrictedRoot: AiWorkerMove[] | undefined;

  try {
    if (budgetMs >= 250) {
      const vcfMove = search.vcf(turn, VCF_MAX_DEPTH);
      if (vcfMove) {
        onDepth?.({ depth: VCF_MAX_DEPTH, move: vcfMove, score: WIN });
        return search.result(vcfMove, VCF_MAX_DEPTH, WIN, 'vcf');
      }
    }

    if (budgetMs >= 700 && search.position.stoneCount >= 5 && search.remainingMs() >= 250) {
      const ownBudget: TacticalBudget = { remaining: 6_000, exhausted: false };
      const ownProof = search.threatSpace(turn, THREAT_MAX_DEPTH, ownBudget);
      if (ownProof.proof === 0 && ownProof.move && !ownBudget.exhausted) {
        onDepth?.({ depth: THREAT_MAX_DEPTH, move: ownProof.move, score: WIN - 500 });
        return search.result(ownProof.move, THREAT_MAX_DEPTH, WIN - 500, 'vct');
      }

      const opponentBudget: TacticalBudget = { remaining: 4_000, exhausted: false };
      const opponentProof = search.threatSpace(opponent, THREAT_MAX_DEPTH, opponentBudget);
      if (opponentProof.proof === 0 && opponentProof.move && !opponentBudget.exhausted && search.remainingMs() >= 200) {
        const defenseBudget: TacticalBudget = { remaining: 5_000, exhausted: false };
        const defenses = search.findThreatDefenses(turn, opponent, opponentProof.move, THREAT_MAX_DEPTH, defenseBudget);
        if (defenses.length > 0 && !defenseBudget.exhausted) restrictedRoot = defenses;
      }
    }
  } catch (error) {
    if (error !== TIMEOUT && error !== NODE_LIMIT) throw error;
    return search.result(rootCandidates[0], 0, 0, error === NODE_LIMIT ? 'node_limit' : 'timeout');
  }

  let best = { move: rootCandidates[0] as AiWorkerMove | null, score: 0, depth: 0 };
  let previousDepthMs = 0;
  let exitReason: ExitReason = 'completed';
  try {
    for (let depth = 1; depth <= 24; depth += 1) {
      const depthStartedAt = Date.now();
      const result = search.searchRootAspiration(turn, depth, best.score, restrictedRoot);
      const depthMs = Math.max(1, Date.now() - depthStartedAt);
      if (result.move) best = { move: result.move, score: result.score, depth };
      onDepth?.({ depth, move: best.move, score: best.score });
      if (Math.abs(best.score) >= WIN - 1_000) {
        exitReason = 'proven';
        break;
      }

      if (depth >= 2) {
        const measuredGrowth = previousDepthMs > 0 ? depthMs / previousDepthMs : 2.8;
        const growth = Math.min(3.5, Math.max(1.8, measuredGrowth));
        const expectedNextMs = Math.ceil(depthMs * growth * 1.12);
        if (search.remainingMs() <= expectedNextMs) {
          exitReason = 'predicted_timeout';
          break;
        }
      }
      previousDepthMs = depthMs;
    }
  } catch (error) {
    if (error !== TIMEOUT && error !== NODE_LIMIT) throw error;
    exitReason = error === NODE_LIMIT ? 'node_limit' : 'timeout';
  }

  return search.result(
    best.move,
    best.depth,
    best.score,
    exitReason,
    search.principalVariation(turn, best.depth),
  );
}

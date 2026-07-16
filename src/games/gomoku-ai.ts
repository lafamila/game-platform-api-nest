import { PlayerColor } from './games.types';
import {
  AiDepthReporter,
  AiSearchDiagnostics,
  AiSearchResult,
  AiWorkerMove,
} from './engine/ai-worker-protocol';
import { TTFlag } from './engine/zobrist';
import {
  GOMOKU_AI_SIZE,
  GomokuAiBoard,
  GomokuAiPosition,
  GomokuThreatProfile,
} from './gomoku-ai-position';
import { countOpenThrees } from './gomoku-rules';

const WIN = 10_000_000;
const CANDIDATE_LIMIT = 16;
const ROOT_PROFILE_LIMIT = 24;
const VCF_MAX_DEPTH = 12;
const VCT_MAX_DEPTH = 5;
const MAX_FORCED_EXTENSIONS = 8;
const ENGINE_VERSION = 'gomoku-hard-v2';
const TIMEOUT = Symbol('gomoku-ai-timeout');
const NODE_LIMIT = Symbol('gomoku-ai-node-limit');

interface ScoredMove extends AiWorkerMove {
  score: number;
}

interface GomokuTtEntry {
  verifier: number;
  depth: number;
  score: number;
  flag: TTFlag;
  move: number;
}

interface TacticalBudget {
  remaining: number;
  exhausted: boolean;
}

type ExitReason = AiSearchDiagnostics['exitReason'];

export interface GomokuSearchOptions {
  maxSearchNodes?: number;
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
  if (profile.fours >= 2) return WIN / 2;
  if (profile.fours >= 1 && profile.openThrees >= 1) return WIN / 2;
  if (profile.openThrees >= 2) return WIN / 4;
  return profile.fours * 16_000 + profile.openThrees * 1_800;
}

class GomokuSearch {
  readonly position: GomokuAiPosition;
  readonly tt = new Map<number, GomokuTtEntry>();
  readonly startedAt = Date.now();
  readonly deadline: number;
  readonly budgetMs: number;
  readonly initialBoardHash: string;
  private readonly maxSearchNodes?: number;

  constructor(board: GomokuAiBoard, budgetMs: number, options?: GomokuSearchOptions) {
    this.position = new GomokuAiPosition(board);
    this.budgetMs = budgetMs;
    this.deadline = this.startedAt + budgetMs;
    this.initialBoardHash = this.position.boardHash();
    this.maxSearchNodes = options?.maxSearchNodes;
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

  private ttEntry(color: PlayerColor): GomokuTtEntry | undefined {
    const [primary, verifier] = this.position.hash(color);
    const entry = this.tt.get(primary);
    return entry?.verifier === verifier ? entry : undefined;
  }

  private storeTt(color: PlayerColor, depth: number, score: number, flag: TTFlag, move: AiWorkerMove): void {
    const [primary, verifier] = this.position.hash(color);
    const existing = this.tt.get(primary);
    if (!existing || existing.verifier !== verifier || existing.depth <= depth) {
      this.tt.set(primary, { verifier, depth, score, flag, move: moveIndex(move) });
    }
  }

  private validTtMove(color: PlayerColor, entry: GomokuTtEntry | undefined): AiWorkerMove | null {
    if (!entry || entry.move < 0) return null;
    const move = moveFromIndex(entry.move);
    if (!this.position.isEmpty(move.row, move.col)) return null;
    return this.position.isLegal(move.row, move.col, color) ? move : null;
  }

  candidates(color: PlayerColor, limit = CANDIDATE_LIMIT, precise = false): AiWorkerMove[] {
    const opponent = opposite(color);
    const scored: ScoredMove[] = this.position.candidateCells().map((move) => {
      const attack = this.position.moveOrderingScore(move.row, move.col, color);
      let defense = this.position.moveOrderingScore(move.row, move.col, opponent);
      // Only tactical-looking black threats pay the full forbidden-rule cost.
      // This keeps an illegal 3-3/4-4 from distorting defensive ordering without
      // reintroducing a forbidden scan for every empty cell at every node.
      if (opponent === 'black' && defense >= 2_500 && !this.position.isLegal(move.row, move.col, opponent)) {
        defense = 0;
      }
      const center = 14 - Math.abs(move.row - 7) - Math.abs(move.col - 7);
      return { ...move, score: attack + defense * 0.92 + center };
    });
    scored.sort((first, second) => second.score - first.score);

    if (precise) {
      for (const move of scored.slice(0, ROOT_PROFILE_LIMIT)) {
        const attack = this.position.threatProfile(move.row, move.col, color);
        const defense = this.position.threatProfile(move.row, move.col, opponent);
        move.score += threatValue(attack) + threatValue(defense) * 0.95;
      }
      scored.sort((first, second) => second.score - first.score);
    }

    // Lazy legality quota: illegal black moves do not consume one of the 16
    // candidate slots. Continue down the ordered list until the quota is full.
    const legal: AiWorkerMove[] = [];
    for (const move of scored) {
      if (!this.position.isLegal(move.row, move.col, color)) continue;
      legal.push({ row: move.row, col: move.col });
      if (legal.length >= limit) break;
    }
    return legal;
  }

  private withTtFirst(color: PlayerColor, moves: AiWorkerMove[]): AiWorkerMove[] {
    const ttMove = this.validTtMove(color, this.ttEntry(color));
    if (!ttMove || moves.some((move) => sameMove(move, ttMove))) {
      return ttMove ? [ttMove, ...moves.filter((move) => !sameMove(move, ttMove))] : moves;
    }
    return [ttMove, ...moves].slice(0, CANDIDATE_LIMIT);
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
    const entry = this.ttEntry(color);
    if (entry && entry.depth >= depth) {
      if (entry.flag === 'exact') return entry.score;
      if (entry.flag === 'lower') alpha = Math.max(alpha, entry.score);
      else if (entry.flag === 'upper') beta = Math.min(beta, entry.score);
      if (alpha >= beta) return entry.score;
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
      : this.candidates(color);
    if (moves.length === 0) return forced ? -WIN + ply : this.position.evaluate(color);
    moves = this.withTtFirst(color, moves);

    const originalAlpha = alpha;
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves[0];
    for (const move of moves) {
      this.position.makeMove(move.row, move.col, color);
      let score: number;
      try {
        if (this.position.isExactFiveAt(move.row, move.col, color)) {
          score = WIN - ply;
        } else {
          const extend = forced && forcedExtensions < MAX_FORCED_EXTENSIONS;
          score = -this.negamax(
            opponent,
            extend ? depth : depth - 1,
            -beta,
            -alpha,
            ply + 1,
            extend ? forcedExtensions + 1 : forcedExtensions,
          );
        }
      } finally {
        this.position.unmakeMove(move.row, move.col);
      }
      if (score > best) {
        best = score;
        bestMove = move;
      }
      alpha = Math.max(alpha, best);
      if (alpha >= beta) break;
    }

    const flag: TTFlag = best <= originalAlpha ? 'upper' : best >= betaIn ? 'lower' : 'exact';
    this.storeTt(color, depth, best, flag, bestMove);
    return best;
  }

  searchRoot(color: PlayerColor, depth: number, restrictedMoves?: AiWorkerMove[]): { move: AiWorkerMove | null; score: number } {
    let moves = restrictedMoves?.length ? restrictedMoves.slice() : this.candidates(color);
    moves = moves.filter((move) => this.position.isEmpty(move.row, move.col) && this.position.isLegal(move.row, move.col, color));
    if (moves.length === 0) return { move: null, score: 0 };
    moves = this.withTtFirst(color, moves);

    const opponent = opposite(color);
    let alpha = Number.NEGATIVE_INFINITY;
    const beta = Number.POSITIVE_INFINITY;
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves[0];
    for (const move of moves) {
      this.checkDeadline(true);
      this.position.makeMove(move.row, move.col, color);
      let score: number;
      try {
        score = this.position.isExactFiveAt(move.row, move.col, color)
          ? WIN - 1
          : -this.negamax(opponent, depth - 1, -beta, -alpha, 1, 0);
      } finally {
        this.position.unmakeMove(move.row, move.col);
      }
      if (score > best) {
        best = score;
        bestMove = move;
      }
      alpha = Math.max(alpha, best);
    }
    this.storeTt(color, depth, best, 'exact', bestMove);
    return { move: bestMove, score: best };
  }

  private forcingMoves(color: PlayerColor, includeThrees: boolean, limit: number): AiWorkerMove[] {
    const cells = this.position.candidateCells()
      .map((move) => ({ ...move, score: this.position.moveOrderingScore(move.row, move.col, color) }))
      .sort((first, second) => second.score - first.score)
      .slice(0, Math.max(24, limit * 2));
    const result: AiWorkerMove[] = [];
    for (const move of cells) {
      this.checkDeadline(true);
      if (!this.position.isLegal(move.row, move.col, color)) continue;
      this.position.makeMove(move.row, move.col, color);
      let forcing = false;
      try {
        forcing =
          this.position.isExactFiveAt(move.row, move.col, color) ||
          this.position.immediateWinningMoves(color).length > 0 ||
          (includeThrees && countOpenThrees(this.position.ruleBoard, move.row, move.col, color) > 0);
      } finally {
        this.position.unmakeMove(move.row, move.col);
      }
      if (forcing) result.push({ row: move.row, col: move.col });
      if (result.length >= limit) break;
    }
    return result;
  }

  vcf(attacker: PlayerColor, depthLeft: number): AiWorkerMove | null {
    this.position.metrics.vcfNodes += 1;
    this.checkDeadline(true);
    if (depthLeft <= 0) return null;
    const defender = opposite(attacker);
    const attackerWins = this.position.immediateWinningMoves(attacker);
    if (attackerWins.length > 0) return attackerWins[0];
    if (this.position.immediateWinningMoves(defender).length > 0) return null;

    for (const move of this.forcingMoves(attacker, false, CANDIDATE_LIMIT)) {
      this.position.makeMove(move.row, move.col, attacker);
      let succeeds = false;
      try {
        if (this.position.isExactFiveAt(move.row, move.col, attacker)) return move;
        const attackerPoints = this.position.immediateWinningMoves(attacker);
        if (attackerPoints.length === 0) continue;
        // Counter-win must be checked before treating a two-point four as forced.
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

  private relevantVctReplies(attacker: PlayerColor, defender: PlayerColor): AiWorkerMove[] {
    const replies = new Map<number, AiWorkerMove>();
    const add = (move: AiWorkerMove) => replies.set(moveIndex(move), move);
    // A relevant VCT defense must either occupy an attacker's next forcing
    // point or create a forcing counter-threat. Quiet moves cannot refute a
    // continuous-threat line and only multiply equivalent losing branches.
    for (const move of this.forcingMoves(attacker, false, 10)) add(move);
    for (const move of this.forcingMoves(defender, false, 8)) add(move);
    return [...replies.values()].filter((move) => this.position.isLegal(move.row, move.col, defender));
  }

  vct(attacker: PlayerColor, depthLeft: number, budget: TacticalBudget): AiWorkerMove | null {
    if (depthLeft <= 0 || !this.spendTacticalNode(budget)) return null;
    const defender = opposite(attacker);
    const attackerWins = this.position.immediateWinningMoves(attacker);
    if (attackerWins.length > 0) return attackerWins[0];
    if (this.position.immediateWinningMoves(defender).length > 0) return null;

    for (const move of this.forcingMoves(attacker, true, 12)) {
      this.position.makeMove(move.row, move.col, attacker);
      let succeeds = false;
      try {
        if (this.position.isExactFiveAt(move.row, move.col, attacker)) return move;
        if (this.position.immediateWinningMoves(defender).length > 0) continue;
        const directWins = this.position.immediateWinningMoves(attacker);
        if (directWins.length >= 2) return move;

        const replies = directWins.length === 1
          ? directWins.filter((reply) => this.position.isLegal(reply.row, reply.col, defender))
          : this.relevantVctReplies(attacker, defender);
        if (replies.length === 0) continue;

        succeeds = true;
        for (const reply of replies) {
          if (!this.spendTacticalNode(budget)) {
            succeeds = false;
            break;
          }
          this.position.makeMove(reply.row, reply.col, defender);
          let continues = false;
          try {
            continues =
              !this.position.isExactFiveAt(reply.row, reply.col, defender) &&
              this.vct(attacker, depthLeft - 1, budget) !== null;
          } finally {
            this.position.unmakeMove(reply.row, reply.col);
          }
          if (!continues) {
            succeeds = false;
            break;
          }
        }
      } finally {
        this.position.unmakeMove(move.row, move.col);
      }
      if (succeeds && !budget.exhausted) return move;
    }
    return null;
  }

  findVctDefenses(
    defender: PlayerColor,
    attacker: PlayerColor,
    attackerFirst: AiWorkerMove,
    depth: number,
    budget: TacticalBudget,
  ): AiWorkerMove[] {
    const options = this.candidates(defender, CANDIDATE_LIMIT, true);
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
        const probe = this.vct(attacker, Math.max(1, depth - 1), budget);
        if (!probe && !budget.exhausted) defenses.push(move);
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
        const move = this.validTtMove(turn, this.ttEntry(turn));
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
        engineVersion: ENGINE_VERSION,
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
  const budgetMs = gomokuPhaseBudgetMs(board, configuredBudgetMs);
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

  const rootCandidates = search.candidates(turn, CANDIDATE_LIMIT, true);
  if (rootCandidates.length === 0) return search.result(null, 0, 0, 'no_legal_move');
  let restrictedRoot: AiWorkerMove[] | undefined;

  try {
    const vcfMove = search.vcf(turn, VCF_MAX_DEPTH);
    if (vcfMove) {
      onDepth?.({ depth: VCF_MAX_DEPTH, move: vcfMove, score: WIN });
      return search.result(vcfMove, VCF_MAX_DEPTH, WIN, 'vcf');
    }

    if (budgetMs >= 700 && search.position.stoneCount >= 5 && search.remainingMs() >= 250) {
      const ownVctBudget: TacticalBudget = { remaining: 3_500, exhausted: false };
      const vctMove = search.vct(turn, VCT_MAX_DEPTH, ownVctBudget);
      if (vctMove && !ownVctBudget.exhausted) {
        onDepth?.({ depth: VCT_MAX_DEPTH, move: vctMove, score: WIN - 500 });
        return search.result(vctMove, VCT_MAX_DEPTH, WIN - 500, 'vct');
      }

      const opponentVctBudget: TacticalBudget = { remaining: 2_000, exhausted: false };
      const opponentVct = search.vct(opponent, VCT_MAX_DEPTH, opponentVctBudget);
      if (opponentVct && !opponentVctBudget.exhausted && search.remainingMs() >= 200) {
        const defenseBudget: TacticalBudget = { remaining: 2_500, exhausted: false };
        const defenses = search.findVctDefenses(turn, opponent, opponentVct, VCT_MAX_DEPTH, defenseBudget);
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
      const result = search.searchRoot(turn, depth, restrictedRoot);
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

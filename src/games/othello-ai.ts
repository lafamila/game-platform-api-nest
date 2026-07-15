import { OthelloColor } from './games.types';
import { AiDepthReporter, AiSearchResult } from './engine/ai-worker-protocol';
import { TTEntry, Zobrist } from './engine/zobrist';

// Othello hard 엔진 — 반복 심화 네가맥스 + 알파베타 + Zobrist 전치표 + 국면별 평가 + ≤14 빈칸 정확 종반.
// 순수 모듈(부작용 없음). hard 전용이며 easy/medium 은 othello-engine 의 그리디를 계속 사용한다.
// 내부는 Int8Array(64) (0 빈칸, 1 흑, 2 백) + make/unmake 로 동작하고 입력 board 는 변경하지 않는다.

const SIZE = 8;
const CELLS = 64;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const ENDGAME_EXACT_EMPTIES = 14;
const TERMINAL_BASE = 1_000_000; // 종국(정확) 점수. 휴리스틱 평가치보다 항상 크게.
const WIN_GUARD = 500_000; // 이 값 이상이면 승패 확정으로 보고 반복 심화 조기 종료.
const TIMEOUT = Symbol('othello-ai-timeout');

// 8방향.
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

// 각 칸에서 방향별로 미리 계산한 인접 스텝(경계 밖은 -1). [sq][dir] = 다음 칸 인덱스 또는 -1.
const STEP: Int8Array[] = buildSteps();

function buildSteps(): Int8Array[] {
  const steps: Int8Array[] = [];
  for (let sq = 0; sq < CELLS; sq += 1) {
    const row = Math.floor(sq / SIZE);
    const col = sq % SIZE;
    const arr = new Int8Array(DIRS.length);
    for (let d = 0; d < DIRS.length; d += 1) {
      const nr = row + DIRS[d][0];
      const nc = col + DIRS[d][1];
      arr[d] = nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE ? nr * SIZE + nc : -1;
    }
    steps.push(arr);
  }
  return steps;
}

// 위치 가중표(고전값): 코너 大, X/C 칸 음수.
const SQUARE_VALUE = new Int16Array([
  100, -20, 10, 5, 5, 10, -20, 100,
  -20, -50, -2, -2, -2, -2, -50, -20,
  10, -2, -1, -1, -1, -1, -2, 10,
  5, -2, -1, -1, -1, -1, -2, 5,
  5, -2, -1, -1, -1, -1, -2, 5,
  10, -2, -1, -1, -1, -1, -2, 10,
  -20, -50, -2, -2, -2, -2, -50, -20,
  100, -20, 10, 5, 5, 10, -20, 100,
]);

const CORNERS = [0, 7, 56, 63];
// 각 코너에 인접한 X/C 칸(코너가 비었을 때 특히 위험).
const CORNER_ADJ: Record<number, number[]> = {
  0: [1, 8, 9],
  7: [6, 14, 15],
  56: [48, 49, 57],
  63: [54, 55, 62],
};

interface PhaseWeights {
  corner: number;
  cornerAdj: number;
  mobility: number;
  potential: number;
  frontier: number;
  disc: number;
  positional: number;
}

function weightsFor(empties: number): PhaseWeights {
  if (empties > 40) {
    return { corner: 45, cornerAdj: 18, mobility: 12, potential: 2.5, frontier: 3, disc: 0, positional: 1 };
  }
  if (empties > ENDGAME_EXACT_EMPTIES) {
    return { corner: 45, cornerAdj: 14, mobility: 9, potential: 1.5, frontier: 3, disc: 1, positional: 1 };
  }
  return { corner: 45, cornerAdj: 8, mobility: 5, potential: 0.5, frontier: 1.5, disc: 4, positional: 1 };
}

function toInternal(board: (OthelloColor | null)[][]): Int8Array {
  const b = new Int8Array(CELLS);
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const cell = board[r]?.[c] ?? null;
      b[r * SIZE + c] = cell === 'black' ? BLACK : cell === 'white' ? WHITE : EMPTY;
    }
  }
  return b;
}

function sqToRC(sq: number): { row: number; col: number } {
  return { row: Math.floor(sq / SIZE), col: sq % SIZE };
}

class OthelloSearch {
  readonly b: Int8Array;
  readonly zob = new Zobrist(CELLS, 3);
  readonly turnKey: bigint;
  tt = new Map<bigint, TTEntry>();
  hash = 0n;
  nodes = 0;
  deadline: number;

  constructor(board: (OthelloColor | null)[][], budgetMs: number) {
    this.b = toInternal(board);
    this.turnKey = this.zob.key(0, 2);
    for (let sq = 0; sq < CELLS; sq += 1) {
      if (this.b[sq] !== EMPTY) this.hash ^= this.zob.key(sq, this.b[sq] === BLACK ? 0 : 1);
    }
    this.deadline = Date.now() + budgetMs;
  }

  private pieceIdx(color: number): number {
    return color === BLACK ? 0 : 1;
  }

  private mapKey(color: number): bigint {
    return color === WHITE ? this.hash ^ this.turnKey : this.hash;
  }

  emptyCount(): number {
    let n = 0;
    for (let sq = 0; sq < CELLS; sq += 1) if (this.b[sq] === EMPTY) n += 1;
    return n;
  }

  // sq 에 color 를 두었을 때 뒤집히는 칸 목록. 불법(0개)이면 빈 배열.
  private flipsFor(sq: number, color: number): number[] {
    if (this.b[sq] !== EMPTY) return [];
    const opp = color === BLACK ? WHITE : BLACK;
    const flips: number[] = [];
    for (let d = 0; d < DIRS.length; d += 1) {
      let cur = STEP[sq][d];
      const line: number[] = [];
      while (cur >= 0 && this.b[cur] === opp) {
        line.push(cur);
        cur = STEP[cur][d];
      }
      if (line.length > 0 && cur >= 0 && this.b[cur] === color) {
        for (const f of line) flips.push(f);
      }
    }
    return flips;
  }

  genMoves(color: number): number[] {
    const moves: number[] = [];
    for (let sq = 0; sq < CELLS; sq += 1) {
      if (this.b[sq] !== EMPTY) continue;
      if (this.hasFlip(sq, color)) moves.push(sq);
    }
    return moves;
  }

  private hasFlip(sq: number, color: number): boolean {
    const opp = color === BLACK ? WHITE : BLACK;
    for (let d = 0; d < DIRS.length; d += 1) {
      let cur = STEP[sq][d];
      let seenOpp = false;
      while (cur >= 0 && this.b[cur] === opp) {
        seenOpp = true;
        cur = STEP[cur][d];
      }
      if (seenOpp && cur >= 0 && this.b[cur] === color) return true;
    }
    return false;
  }

  private countMoves(color: number): number {
    let n = 0;
    for (let sq = 0; sq < CELLS; sq += 1) {
      if (this.b[sq] === EMPTY && this.hasFlip(sq, color)) n += 1;
    }
    return n;
  }

  private make(sq: number, color: number, flips: number[]): void {
    this.b[sq] = color;
    this.hash ^= this.zob.key(sq, this.pieceIdx(color));
    const opp = color === BLACK ? WHITE : BLACK;
    for (const f of flips) {
      this.b[f] = color;
      this.hash ^= this.zob.key(f, this.pieceIdx(opp)) ^ this.zob.key(f, this.pieceIdx(color));
    }
  }

  private unmake(sq: number, color: number, flips: number[]): void {
    const opp = color === BLACK ? WHITE : BLACK;
    for (const f of flips) {
      this.b[f] = opp;
      this.hash ^= this.zob.key(f, this.pieceIdx(color)) ^ this.zob.key(f, this.pieceIdx(opp));
    }
    this.b[sq] = EMPTY;
    this.hash ^= this.zob.key(sq, this.pieceIdx(color));
  }

  private checkDeadline(): void {
    if ((this.nodes & 2047) === 0 && Date.now() > this.deadline) throw TIMEOUT;
  }

  private discDiff(color: number): number {
    let mine = 0;
    let opp = 0;
    for (let sq = 0; sq < CELLS; sq += 1) {
      if (this.b[sq] === color) mine += 1;
      else if (this.b[sq] !== EMPTY) opp += 1;
    }
    return mine - opp;
  }

  private terminalScore(color: number): number {
    const diff = this.discDiff(color);
    if (diff > 0) return TERMINAL_BASE + diff;
    if (diff < 0) return -TERMINAL_BASE + diff;
    return 0;
  }

  // color 관점 휴리스틱 평가.
  private evaluate(color: number): number {
    const opp = color === BLACK ? WHITE : BLACK;
    const empties = this.emptyCount();
    const w = weightsFor(empties);
    let positional = 0;
    let frontier = 0;
    let potential = 0;
    for (let sq = 0; sq < CELLS; sq += 1) {
      const v = this.b[sq];
      if (v === EMPTY) continue;
      const sign = v === color ? 1 : -1;
      positional += sign * SQUARE_VALUE[sq];
      // 프런티어: 빈칸에 인접한 자기 돌은 감점 요인.
      let touchesEmpty = false;
      for (let d = 0; d < DIRS.length; d += 1) {
        const n = STEP[sq][d];
        if (n >= 0 && this.b[n] === EMPTY) {
          touchesEmpty = true;
          break;
        }
      }
      if (touchesEmpty) frontier += sign;
    }
    // 잠재 모빌리티: 상대 돌에 인접한 빈칸(내가 둘 수 있게 될 여지).
    for (let sq = 0; sq < CELLS; sq += 1) {
      if (this.b[sq] !== EMPTY) continue;
      let nearOpp = 0;
      let nearMine = 0;
      for (let d = 0; d < DIRS.length; d += 1) {
        const n = STEP[sq][d];
        if (n < 0) continue;
        if (this.b[n] === opp) nearOpp += 1;
        else if (this.b[n] === color) nearMine += 1;
      }
      potential += (nearOpp > 0 ? 1 : 0) - (nearMine > 0 ? 1 : 0);
    }
    let corner = 0;
    let cornerAdj = 0;
    for (const csq of CORNERS) {
      if (this.b[csq] === color) corner += 1;
      else if (this.b[csq] === opp) corner -= 1;
      else {
        // 코너가 비었으면 인접 X/C 칸 점유는 위험(상대에게 코너를 내줌).
        for (const adj of CORNER_ADJ[csq]) {
          if (this.b[adj] === color) cornerAdj -= 1;
          else if (this.b[adj] === opp) cornerAdj += 1;
        }
      }
    }
    const myMob = this.countMoves(color);
    const oppMob = this.countMoves(opp);
    const mobility = myMob + oppMob > 0 ? (myMob - oppMob) : 0;
    const disc = this.discDiff(color);
    return (
      w.corner * corner +
      w.cornerAdj * cornerAdj +
      w.mobility * mobility +
      w.potential * potential -
      w.frontier * frontier +
      w.disc * disc +
      w.positional * positional
    );
  }

  private orderMoves(moves: number[], ttMove: number): number[] {
    return moves
      .map((sq) => ({ sq, key: sq === ttMove ? 1_000_000 : SQUARE_VALUE[sq] }))
      .sort((a, b) => b.key - a.key)
      .map((m) => m.sq);
  }

  // 휴리스틱 네가맥스(깊이 제한). 반환은 color 관점.
  private negamax(color: number, depth: number, alphaIn: number, betaIn: number): number {
    this.nodes += 1;
    this.checkDeadline();
    let alpha = alphaIn;
    let beta = betaIn;
    const key = this.mapKey(color);
    const entry = this.tt.get(key);
    let ttMove = -1;
    if (entry && entry.depth >= depth) {
      if (entry.flag === 'exact') return entry.score;
      if (entry.flag === 'lower' && entry.score > alpha) alpha = entry.score;
      else if (entry.flag === 'upper' && entry.score < beta) beta = entry.score;
      if (alpha >= beta) return entry.score;
      ttMove = entry.move;
    } else if (entry) {
      ttMove = entry.move;
    }

    const opp = color === BLACK ? WHITE : BLACK;
    const moves = this.genMoves(color);
    if (moves.length === 0) {
      if (this.genMoves(opp).length === 0) return this.terminalScore(color);
      // 패스: 깊이를 소모하지 않는다.
      return -this.negamax(opp, depth, -beta, -alpha);
    }
    if (depth <= 0) return this.evaluate(color);

    const ordered = this.orderMoves(moves, ttMove);
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = ordered[0];
    const origAlpha = alpha;
    for (const sq of ordered) {
      const flips = this.flipsFor(sq, color);
      this.make(sq, color, flips);
      const score = -this.negamax(opp, depth - 1, -beta, -alpha);
      this.unmake(sq, color, flips);
      if (score > best) {
        best = score;
        bestMove = sq;
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    const flag: TTEntry['flag'] = best <= origAlpha ? 'upper' : best >= beta ? 'lower' : 'exact';
    this.tt.set(key, { depth, score: best, flag, move: bestMove });
    return best;
  }

  // 정확 종반 네가맥스(깊이 무제한, 종국 석차로 평가).
  private negamaxExact(color: number, alphaIn: number, betaIn: number): number {
    this.nodes += 1;
    this.checkDeadline();
    let alpha = alphaIn;
    let beta = betaIn;
    const opp = color === BLACK ? WHITE : BLACK;
    const moves = this.genMoves(color);
    if (moves.length === 0) {
      if (this.genMoves(opp).length === 0) return this.terminalScore(color);
      return -this.negamaxExact(opp, -beta, -alpha);
    }
    const ordered = this.orderMoves(moves, -1);
    let best = Number.NEGATIVE_INFINITY;
    for (const sq of ordered) {
      const flips = this.flipsFor(sq, color);
      this.make(sq, color, flips);
      const score = -this.negamaxExact(opp, -beta, -alpha);
      this.unmake(sq, color, flips);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  searchRoot(color: number, depth: number): { move: number; score: number } {
    const opp = color === BLACK ? WHITE : BLACK;
    const moves = this.orderMoves(this.genMoves(color), this.tt.get(this.mapKey(color))?.move ?? -1);
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves[0];
    let alpha = Number.NEGATIVE_INFINITY;
    const beta = Number.POSITIVE_INFINITY;
    for (const sq of moves) {
      const flips = this.flipsFor(sq, color);
      this.make(sq, color, flips);
      const score = -this.negamax(opp, depth - 1, -beta, -alpha);
      this.unmake(sq, color, flips);
      if (score > best) {
        best = score;
        bestMove = sq;
      }
      if (best > alpha) alpha = best;
    }
    this.tt.set(this.mapKey(color), { depth, score: best, flag: 'exact', move: bestMove });
    return { move: bestMove, score: best };
  }

  searchRootExact(color: number): { move: number; score: number } {
    const opp = color === BLACK ? WHITE : BLACK;
    const moves = this.orderMoves(this.genMoves(color), -1);
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves[0];
    let alpha = Number.NEGATIVE_INFINITY;
    const beta = Number.POSITIVE_INFINITY;
    for (const sq of moves) {
      const flips = this.flipsFor(sq, color);
      this.make(sq, color, flips);
      const score = -this.negamaxExact(opp, -beta, -alpha);
      this.unmake(sq, color, flips);
      if (score > best) {
        best = score;
        bestMove = sq;
      }
      if (best > alpha) alpha = best;
    }
    return { move: bestMove, score: best };
  }
}

export function searchOthelloMove(
  board: (OthelloColor | null)[][],
  turn: OthelloColor,
  budgetMs: number,
  onDepth?: AiDepthReporter,
): AiSearchResult {
  const search = new OthelloSearch(board, budgetMs);
  const color = turn === 'black' ? BLACK : WHITE;
  const rootMoves = search.genMoves(color);
  if (rootMoves.length === 0) {
    return { move: null, depth: 0, score: 0, nodes: search.nodes };
  }

  let best: { move: number; score: number; depth: number } = { move: rootMoves[0], score: 0, depth: 0 };
  const empties = search.emptyCount();
  const maxDepth = empties;

  try {
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const res = search.searchRoot(color, depth);
      best = { move: res.move, score: res.score, depth };
      onDepth?.({ depth, move: sqToRC(res.move), score: res.score });
      if (Math.abs(res.score) >= WIN_GUARD) break; // 승패 확정 → 더 깊이 볼 필요 없음
      if (Date.now() > search.deadline) break;
    }
  } catch (err) {
    if (err !== TIMEOUT) throw err;
    // 마지막으로 완료된 깊이의 best 를 유지.
  }

  // 정확 종반 해결(예산 남아 있고 빈칸이 임계 이하일 때).
  if (empties <= ENDGAME_EXACT_EMPTIES && Date.now() < search.deadline) {
    try {
      const exact = search.searchRootExact(color);
      best = { move: exact.move, score: exact.score, depth: empties };
      onDepth?.({ depth: empties, move: sqToRC(exact.move), score: exact.score });
    } catch (err) {
      if (err !== TIMEOUT) throw err;
    }
  }

  return { move: sqToRC(best.move), depth: best.depth, score: best.score, nodes: search.nodes };
}

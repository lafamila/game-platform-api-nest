import { PlayerColor } from './games.types';
import { AiDepthReporter, AiSearchResult, AiWorkerMove } from './engine/ai-worker-protocol';
import { TTEntry, Zobrist } from './engine/zobrist';
import { countFours, countOpenThrees, getForbiddenReason, isExactFive } from './gomoku-rules';

// Gomoku hard 엔진 — 위협 우선 후보 + 반복 심화 알파베타 + Zobrist TT + VCF 확장.
// 렌주 금수(흑) 를 탐색 전체에서 배제하고(자신·상대 시뮬 모두), 승리는 정확히 5(장목 비승리)로 판정한다.
// 순수 모듈(부작용 없음). hard 전용이며 easy/medium 은 gomoku-engine 의 gomokuMinimax 를 계속 사용한다.
// 입력 board 는 복제해서 사용하므로 변경하지 않는다.

const SIZE = 15;
const CELLS = SIZE * SIZE;
const WIN = 10_000_000;
const CANDIDATE_LIMIT = 16;
const VCF_MAX_DEPTH = 12;
const TIMEOUT = Symbol('gomoku-ai-timeout');

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

// opp-free 5칸 창의 자기 돌 수별 점수(가파른 가중 — 3·4 를 강하게 평가). 숫자 스캔이라 문자열보다 빠르다.
const WINDOW_SCORE = [0, 2, 45, 600, 20_000, 1_000_000];

type Board = (PlayerColor | null)[][];

function opposite(color: PlayerColor): PlayerColor {
  return color === 'black' ? 'white' : 'black';
}

function cloneBoard(board: Board): Board {
  return board.map((row) => row.slice());
}

function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

interface Scored {
  row: number;
  col: number;
  score: number;
}

class GomokuSearch {
  readonly board: Board;
  readonly zob = new Zobrist(CELLS, 3);
  readonly turnKey: bigint;
  tt = new Map<bigint, TTEntry>();
  hash = 0n;
  nodes = 0;
  deadline: number;

  constructor(board: Board, budgetMs: number) {
    this.board = cloneBoard(board);
    this.turnKey = this.zob.key(0, 2);
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        const cell = this.board[r][c];
        if (cell) this.hash ^= this.zob.key(r * SIZE + c, cell === 'black' ? 0 : 1);
      }
    }
    this.deadline = Date.now() + budgetMs;
  }

  private mapKey(color: PlayerColor): bigint {
    return color === 'white' ? this.hash ^ this.turnKey : this.hash;
  }

  private place(r: number, c: number, color: PlayerColor): void {
    this.board[r][c] = color;
    this.hash ^= this.zob.key(r * SIZE + c, color === 'black' ? 0 : 1);
  }

  private remove(r: number, c: number): void {
    const color = this.board[r][c];
    if (!color) return;
    this.hash ^= this.zob.key(r * SIZE + c, color === 'black' ? 0 : 1);
    this.board[r][c] = null;
  }

  private checkDeadline(): void {
    if ((this.nodes & 1023) === 0 && Date.now() > this.deadline) throw TIMEOUT;
  }

  hasStones(): boolean {
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) if (this.board[r][c]) return true;
    }
    return false;
  }

  // 돌 주변 radius 이내의 빈칸.
  private nearbyEmpties(radius: number): AiWorkerMove[] {
    const seen = new Set<number>();
    const cells: AiWorkerMove[] = [];
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        if (!this.board[r][c]) continue;
        for (let dr = -radius; dr <= radius; dr += 1) {
          for (let dc = -radius; dc <= radius; dc += 1) {
            const nr = r + dr;
            const nc = c + dc;
            if (!inBounds(nr, nc) || this.board[nr][nc]) continue;
            const idx = nr * SIZE + nc;
            if (!seen.has(idx)) {
              seen.add(idx);
              cells.push({ row: nr, col: nc });
            }
          }
        }
      }
    }
    return cells;
  }

  private consec(r: number, c: number, dr: number, dc: number, color: PlayerColor): number {
    let n = 0;
    let nr = r + dr;
    let nc = c + dc;
    while (inBounds(nr, nc) && this.board[nr][nc] === color) {
      n += 1;
      nr += dr;
      nc += dc;
    }
    return n;
  }

  // (r,c) 에 color 를 두었을 때 만들어지는 국지 위협 점수(정렬용, 저비용). 돌은 이미 놓였다고 가정.
  private localThreat(r: number, c: number, color: PlayerColor): number {
    let value = 0;
    for (const [dr, dc] of DIRS) {
      const fwd = this.consec(r, c, dr, dc, color);
      const bwd = this.consec(r, c, -dr, -dc, color);
      const total = 1 + fwd + bwd;
      const openF = inBounds(r + dr * (fwd + 1), c + dc * (fwd + 1)) && this.board[r + dr * (fwd + 1)][c + dc * (fwd + 1)] === null;
      const openB = inBounds(r - dr * (bwd + 1), c - dc * (bwd + 1)) && this.board[r - dr * (bwd + 1)][c - dc * (bwd + 1)] === null;
      const opens = (openF ? 1 : 0) + (openB ? 1 : 0);
      if (total >= 5) value += 100_000;
      else if (total === 4) value += opens === 2 ? 50_000 : opens === 1 ? 8_000 : 0;
      else if (total === 3) value += opens === 2 ? 4_000 : opens === 1 ? 400 : 0;
      else if (total === 2) value += opens === 2 ? 200 : opens === 1 ? 20 : 0;
      else value += opens;
    }
    return value;
  }

  // 착수 (r,c,color) 의 공격 가치(빈칸 가정). 즉승/이중위협을 크게 친다.
  private attackValue(r: number, c: number, color: PlayerColor): number {
    this.place(r, c, color);
    let value: number;
    if (isExactFive(this.board, r, c, color)) {
      value = WIN;
    } else {
      const fours = countFours(this.board, r, c, color);
      const threes = countOpenThrees(this.board, r, c, color);
      if (fours >= 2) value = WIN / 2; // 사사(이중 4)
      else if (fours >= 1 && threes >= 1) value = WIN / 2; // 사삼
      else if (threes >= 2) value = WIN / 4; // 삼삼(백 강수; 흑은 금수라 후보에서 배제됨)
      else value = fours * 12_000 + threes * 1_200 + this.localThreat(r, c, color);
    }
    this.remove(r, c);
    return value;
  }

  // 저비용 정렬 점수: 즉승 + 국지 연속 위협만(countFours/countOpenThrees 미사용 → 탐색 노드에서 빠름).
  private orderScore(r: number, c: number, color: PlayerColor): number {
    this.place(r, c, color);
    const value = isExactFive(this.board, r, c, color) ? WIN : this.localThreat(r, c, color);
    this.remove(r, c);
    return value;
  }

  // 흑이면 금수 배제. 정렬은 공격 + 방어(상대가 그 자리에 두었을 때의 위협) 가중.
  // precise=true(루트 전용)는 이중위협까지 보는 attackValue 로 정밀 정렬; 탐색 내부는 저비용 orderScore.
  candidates(color: PlayerColor, limit: number, precise = false): AiWorkerMove[] {
    const opp = opposite(color);
    const cells = this.hasStones() ? this.nearbyEmpties(2) : [{ row: 7, col: 7 }];
    const scored: Scored[] = [];
    for (const cell of cells) {
      if (color === 'black' && getForbiddenReason(this.board, cell.row, cell.col) !== null) continue;
      const attack = precise ? this.attackValue(cell.row, cell.col, color) : this.orderScore(cell.row, cell.col, color);
      const defense = precise ? this.attackValue(cell.row, cell.col, opp) : this.orderScore(cell.row, cell.col, opp);
      const center = 14 - Math.abs(cell.row - 7) - Math.abs(cell.col - 7);
      scored.push({ row: cell.row, col: cell.col, score: attack + defense * 0.9 + center });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => ({ row: s.row, col: s.col }));
  }

  // 한 색의 5칸 창 점수 합 + 이중위협 보너스(숫자 스캔, 빠름). 겹치는 창을 세어 자연히 열린 형태를 더 높게 친다.
  // 이중위협(사사·사삼·삼삼)은 상대가 한 수로 다 막을 수 없어 사실상 승세 → 가산 합보다 훨씬 크게 친다.
  private scoreColor(color: PlayerColor): number {
    let score = 0;
    let fours = 0;
    let threes = 0;
    for (const [dr, dc] of DIRS) {
      for (let r = 0; r < SIZE; r += 1) {
        for (let c = 0; c < SIZE; c += 1) {
          const er = r + dr * 4;
          const ec = c + dc * 4;
          if (!inBounds(er, ec)) continue;
          let self = 0;
          let blocked = 0;
          for (let k = 0; k < 5; k += 1) {
            const cell = this.board[r + dr * k][c + dc * k];
            if (cell === color) self += 1;
            else if (cell !== null) blocked += 1;
          }
          if (blocked > 0 || self === 0) continue;
          score += WINDOW_SCORE[self];
          if (self === 4) fours += 1;
          else if (self === 3) threes += 1;
        }
      }
    }
    if (fours >= 2 || (fours >= 1 && threes >= 1)) score += 90_000;
    else if (threes >= 2) score += 40_000;
    return score;
  }

  // color 관점 평가(대칭 — 네가맥스 일관성 유지). 상대 위협도 같은 척도로 평가해 자연스럽게 방어한다.
  private evaluate(color: PlayerColor): number {
    return this.scoreColor(color) - this.scoreColor(opposite(color));
  }

  private negamax(color: PlayerColor, depth: number, alphaIn: number, betaIn: number, ply: number): number {
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

    if (depth <= 0) return this.evaluate(color);

    const opp = opposite(color);
    let moves = this.candidates(color, CANDIDATE_LIMIT);
    if (moves.length === 0) return this.evaluate(color); // 금수뿐이거나 둘 곳 없음
    if (ttMove >= 0) {
      const tr = Math.floor(ttMove / SIZE);
      const tc = ttMove % SIZE;
      moves = [{ row: tr, col: tc }, ...moves.filter((m) => m.row !== tr || m.col !== tc)];
    }

    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves[0].row * SIZE + moves[0].col;
    const origAlpha = alpha;
    for (const m of moves) {
      this.place(m.row, m.col, color);
      let score: number;
      if (isExactFive(this.board, m.row, m.col, color)) {
        score = WIN - ply;
      } else {
        score = -this.negamax(opp, depth - 1, -beta, -alpha, ply + 1);
      }
      this.remove(m.row, m.col);
      if (score > best) {
        best = score;
        bestMove = m.row * SIZE + m.col;
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    const flag: TTEntry['flag'] = best <= origAlpha ? 'upper' : best >= beta ? 'lower' : 'exact';
    this.tt.set(key, { depth, score: best, flag, move: bestMove });
    return best;
  }

  searchRoot(color: PlayerColor, depth: number): { move: AiWorkerMove | null; score: number } {
    const opp = opposite(color);
    let moves = this.candidates(color, CANDIDATE_LIMIT);
    if (moves.length === 0) return { move: null, score: 0 };
    const ttMove = this.tt.get(this.mapKey(color))?.move ?? -1;
    if (ttMove >= 0) {
      const tr = Math.floor(ttMove / SIZE);
      const tc = ttMove % SIZE;
      moves = [{ row: tr, col: tc }, ...moves.filter((m) => m.row !== tr || m.col !== tc)];
    }
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves[0];
    let alpha = Number.NEGATIVE_INFINITY;
    const beta = Number.POSITIVE_INFINITY;
    for (const m of moves) {
      this.place(m.row, m.col, color);
      let score: number;
      if (isExactFive(this.board, m.row, m.col, color)) {
        score = WIN - 1;
      } else {
        score = -this.negamax(opp, depth - 1, -beta, -alpha, 1);
      }
      this.remove(m.row, m.col);
      if (score > best) {
        best = score;
        bestMove = m;
      }
      if (best > alpha) alpha = best;
    }
    this.tt.set(this.mapKey(color), { depth, score: best, flag: 'exact', move: bestMove.row * SIZE + bestMove.col });
    return { move: bestMove, score: best };
  }

  // color 가 즉시 정확 5를 만들 수 있는 빈칸들.
  fivePoints(color: PlayerColor): AiWorkerMove[] {
    const pts: AiWorkerMove[] = [];
    for (const cell of this.nearbyEmpties(1)) {
      this.place(cell.row, cell.col, color);
      const win = isExactFive(this.board, cell.row, cell.col, color);
      this.remove(cell.row, cell.col);
      if (win) pts.push(cell);
    }
    return pts;
  }

  // 4(오목 완성 위협)를 만드는 착수. 흑이면 금수 배제.
  private fourMoves(color: PlayerColor): AiWorkerMove[] {
    const moves: AiWorkerMove[] = [];
    for (const cell of this.nearbyEmpties(1)) {
      if (color === 'black' && getForbiddenReason(this.board, cell.row, cell.col) !== null) continue;
      this.place(cell.row, cell.col, color);
      const makesFive = isExactFive(this.board, cell.row, cell.col, color);
      const fours = makesFive ? 0 : countFours(this.board, cell.row, cell.col, color);
      this.remove(cell.row, cell.col);
      if (makesFive || fours >= 1) moves.push(cell);
    }
    return moves;
  }

  // 연속 4 위협으로 강제 승리를 찾는다. 첫 수를 반환하거나 null.
  vcf(attacker: PlayerColor, depthLeft: number): AiWorkerMove | null {
    if (depthLeft <= 0) return null;
    this.checkDeadline();
    const defender = opposite(attacker);
    for (const m of this.fourMoves(attacker)) {
      this.place(m.row, m.col, attacker);
      if (isExactFive(this.board, m.row, m.col, attacker)) {
        this.remove(m.row, m.col);
        return m;
      }
      const pts = this.fivePoints(attacker);
      if (pts.length === 0) {
        this.remove(m.row, m.col);
        continue;
      }
      if (pts.length >= 2) {
        // 열린 4 / 이중 4 — 상대가 모두 막을 수 없다.
        this.remove(m.row, m.col);
        return m;
      }
      const block = pts[0];
      if (defender === 'black' && getForbiddenReason(this.board, block.row, block.col) !== null) {
        // 수비수(흑)가 금수라 막을 수 없다 → 공격 성공.
        this.remove(m.row, m.col);
        return m;
      }
      this.place(block.row, block.col, defender);
      const cont = this.vcf(attacker, depthLeft - 1);
      this.remove(block.row, block.col);
      this.remove(m.row, m.col);
      if (cont) return m;
    }
    return null;
  }
}

export function searchGomokuMove(
  board: Board,
  turn: PlayerColor,
  budgetMs: number,
  onDepth?: AiDepthReporter,
): AiSearchResult {
  const search = new GomokuSearch(board, budgetMs);
  const color = turn;

  if (!search.hasStones()) {
    onDepth?.({ depth: 1, move: { row: 7, col: 7 }, score: 0 });
    return { move: { row: 7, col: 7 }, depth: 1, score: 0, nodes: 0 };
  }

  const rootCandidates = search.candidates(color, CANDIDATE_LIMIT, true);
  if (rootCandidates.length === 0) {
    return { move: null, depth: 0, score: 0, nodes: search.nodes };
  }

  const opp = opposite(color);
  const legalForMover = (m: AiWorkerMove) => color !== 'black' || getForbiddenReason(board, m.row, m.col) === null;

  // 1) 즉승: 정확 5를 완성하는 수가 있으면 바로 둔다(깊이 무관 보장).
  const myFives = search.fivePoints(color).filter(legalForMover);
  if (myFives.length > 0) {
    onDepth?.({ depth: 1, move: myFives[0], score: WIN });
    return { move: myFives[0], depth: 1, score: WIN, nodes: search.nodes };
  }

  // 2) VCF: 연속 4 강제 승리 수순.
  try {
    const vcfMove = search.vcf(color, VCF_MAX_DEPTH);
    if (vcfMove) {
      onDepth?.({ depth: VCF_MAX_DEPTH, move: vcfMove, score: WIN });
      return { move: vcfMove, depth: VCF_MAX_DEPTH, score: WIN, nodes: search.nodes };
    }
  } catch (err) {
    if (err !== TIMEOUT) throw err;
  }

  // 3) 즉시 방어: 상대의 5 위협이 하나뿐이면 반드시 막는다(탐색 깊이에 의존하지 않는 필수 방어).
  //    둘 이상이면 한 수로 다 못 막으므로 탐색이 최선의 발버둥을 고르게 둔다.
  const oppFives = search.fivePoints(opp);
  if (oppFives.length === 1 && legalForMover(oppFives[0])) {
    onDepth?.({ depth: 1, move: oppFives[0], score: 0 });
    return { move: oppFives[0], depth: 1, score: 0, nodes: search.nodes };
  }

  let best: { move: AiWorkerMove | null; score: number; depth: number } = {
    move: rootCandidates[0],
    score: 0,
    depth: 0,
  };

  try {
    for (let depth = 1; depth <= 24; depth += 1) {
      const res = search.searchRoot(color, depth);
      if (res.move) best = { move: res.move, score: res.score, depth };
      onDepth?.({ depth, move: best.move, score: best.score });
      if (Math.abs(best.score) >= WIN - 1000) break; // 승패 확정
      if (Date.now() > search.deadline) break;
    }
  } catch (err) {
    if (err !== TIMEOUT) throw err;
  }

  return { move: best.move, depth: best.depth, score: best.score, nodes: search.nodes };
}

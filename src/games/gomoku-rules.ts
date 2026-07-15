import { PlayerColor } from './games.types';

// 렌주형 오목 규칙(순수 함수). 보드는 `(PlayerColor | null)[][]` 이며 크기는 board.length 로 파생한다
// (엔진 상수와의 순환 import 를 피하기 위함). 좌표는 [row][col].
//
// 규칙 요약(root GAME_PLATFORM_OTHELLO_GOMOKU_AI_PLAN §5.1):
// - 흑 금수: 삼삼(열린 3 ×2+), 사사(4 ×2+, 같은 라인 이중 4 포함), 장목(6목 이상). 착수 자체 거부.
// - 5 우선: 착수가 (어느 라인에서든) 정확히 5 를 만들면 금수와 무관하게 즉시 승리 → 금수 아님.
// - 백: 금수 없음. 장목 착수 가능하나 승리 아님.
// - 승리(양색 공통): 정확히 5. 6목 이상은 5 로 치지 않는다.

type Cell = PlayerColor | null;
type Board = Cell[][];

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

export type ForbiddenReason = 'double-three' | 'double-four' | 'overline';

function inBounds(board: Board, r: number, c: number): boolean {
  return r >= 0 && r < board.length && c >= 0 && c < board[r].length;
}

function isColor(board: Board, r: number, c: number, color: PlayerColor): boolean {
  return inBounds(board, r, c) && board[r][c] === color;
}

function isEmpty(board: Board, r: number, c: number): boolean {
  return inBounds(board, r, c) && board[r][c] === null;
}

// (r,c) 에서 (dr,dc) 방향으로 이어지는 같은 색 돌 수 (자기 자신 제외).
function countConsecutive(board: Board, r: number, c: number, dr: number, dc: number, color: PlayerColor): number {
  let total = 0;
  let nr = r + dr;
  let nc = c + dc;
  while (isColor(board, nr, nc, color)) {
    total += 1;
    nr += dr;
    nc += dc;
  }
  return total;
}

// (r,c) 를 지나는 한 방향의 최대 연속 길이 (돌이 이미 놓였다고 가정).
function runLengthThrough(board: Board, r: number, c: number, dr: number, dc: number, color: PlayerColor): number {
  return 1 + countConsecutive(board, r, c, dr, dc, color) + countConsecutive(board, r, c, -dr, -dc, color);
}

// 정확히 5 (양색 공통 승리 판정). 6 이상은 5 가 아니다.
export function isExactFive(board: Board, r: number, c: number, color: PlayerColor): boolean {
  return DIRECTIONS.some(([dr, dc]) => runLengthThrough(board, r, c, dr, dc, color) === 5);
}

// 장목: 어느 방향이든 6목 이상.
export function makesOverline(board: Board, r: number, c: number, color: PlayerColor): boolean {
  return DIRECTIONS.some(([dr, dc]) => runLengthThrough(board, r, c, dr, dc, color) >= 6);
}

// 열린 4(양단 개방, 렌주에서 승리로 이어지는 사): (r,c) 를 지나는 연속 4 이며 양 끝이 모두 빈칸.
function isStraightFourInDirection(
  board: Board,
  r: number,
  c: number,
  dr: number,
  dc: number,
  color: PlayerColor,
): boolean {
  const fwd = countConsecutive(board, r, c, dr, dc, color);
  const bwd = countConsecutive(board, r, c, -dr, -dc, color);
  if (1 + fwd + bwd !== 4) return false;
  return (
    isEmpty(board, r + dr * (fwd + 1), c + dc * (fwd + 1)) &&
    isEmpty(board, r - dr * (bwd + 1), c - dc * (bwd + 1))
  );
}

// (tr,tc) 가 (r,c) 의 최대 연속 런 안에 있는가.
function runIncludesCell(
  board: Board,
  r: number,
  c: number,
  dr: number,
  dc: number,
  color: PlayerColor,
  tr: number,
  tc: number,
): boolean {
  const fwd = countConsecutive(board, r, c, dr, dc, color);
  const bwd = countConsecutive(board, r, c, -dr, -dc, color);
  const k = dr !== 0 ? (tr - r) / dr : (tc - c) / dc;
  return Number.isInteger(k) && k >= -bwd && k <= fwd;
}

// 한 방향이 만드는 4의 개수 (돌이 (r,c) 에 이미 놓였다고 가정).
// - 빈칸 e 에 색을 두어 (r,c) 를 지나는 정확한 5 가 되는 e 를 승리점으로 수집.
// - 열린 4(연속 4·양단 개방)는 승리점이 2개이지만 4는 하나로 센다.
// - 그 외 서로 다른 승리점이 2개면 "같은 라인 이중 4" 로 2를 센다.
function foursInDirection(board: Board, r: number, c: number, dr: number, dc: number, color: PlayerColor): number {
  const winning = new Set<string>();
  for (let k = -4; k <= 4; k += 1) {
    if (k === 0) continue;
    const er = r + dr * k;
    const ec = c + dc * k;
    if (!isEmpty(board, er, ec)) continue;
    board[er][ec] = color;
    const completesFive = runLengthThrough(board, r, c, dr, dc, color) === 5;
    board[er][ec] = null;
    if (completesFive) winning.add(`${er}:${ec}`);
  }
  if (winning.size === 0) return 0;
  if (winning.size >= 2 && isStraightFourInDirection(board, r, c, dr, dc, color)) return 1;
  return winning.size;
}

// 한 방향에 열린 3이 있는가 (돌이 (r,c) 에 이미 놓였다고 가정).
// 열린 3 = 빈칸 e 하나를 더 두면 (r,c)+e 를 포함하는 열린 4(정확 4·양단 개방)가 되는 3.
// e 가 (r,c) 의 런에 포함되도록 요구하여, 이미 4인 방향(사동반)은 3으로 세지 않는다.
function openThreeInDirection(board: Board, r: number, c: number, dr: number, dc: number, color: PlayerColor): boolean {
  for (let k = -4; k <= 4; k += 1) {
    if (k === 0) continue;
    const er = r + dr * k;
    const ec = c + dc * k;
    if (!isEmpty(board, er, ec)) continue;
    board[er][ec] = color;
    const straight =
      isStraightFourInDirection(board, r, c, dr, dc, color) &&
      runIncludesCell(board, r, c, dr, dc, color, er, ec);
    board[er][ec] = null;
    if (straight) return true;
  }
  return false;
}

// (r,c) 착수가 만드는 4의 총 개수 (돌이 이미 놓였다고 가정).
export function countFours(board: Board, r: number, c: number, color: PlayerColor): number {
  let total = 0;
  for (const [dr, dc] of DIRECTIONS) {
    total += foursInDirection(board, r, c, dr, dc, color);
  }
  return total;
}

// (r,c) 착수가 만드는 열린 3의 방향 개수 (돌이 이미 놓였다고 가정).
export function countOpenThrees(board: Board, r: number, c: number, color: PlayerColor): number {
  let total = 0;
  for (const [dr, dc] of DIRECTIONS) {
    if (openThreeInDirection(board, r, c, dr, dc, color)) total += 1;
  }
  return total;
}

// 흑 착수 (r,c) 의 금수 사유. 금수가 아니면 null.
// 우선순위: 5 우선(승리) → 장목 → 사사 → 삼삼.
// board 는 착수 전 상태를 받아 내부에서 흑을 임시로 놓았다가 복원한다.
export function getForbiddenReason(board: Board, r: number, c: number): ForbiddenReason | null {
  if (!isEmpty(board, r, c)) return null;
  board[r][c] = 'black';
  try {
    if (isExactFive(board, r, c, 'black')) return null; // 5 우선: 승리 착수는 항상 허용
    if (makesOverline(board, r, c, 'black')) return 'overline';
    if (countFours(board, r, c, 'black') >= 2) return 'double-four';
    if (countOpenThrees(board, r, c, 'black') >= 2) return 'double-three';
    return null;
  } finally {
    board[r][c] = null;
  }
}

// Dual 32-bit Zobrist keys shared by the hard Othello and Gomoku engines.

export type TTFlag = 'exact' | 'lower' | 'upper';

// 첫 키는 Map 인덱스, 두 번째 키는 TT probe 충돌 검증에 사용한다.
function splitmix32(state: number): number {
  let z = (state + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

export class DualZobrist32 {
  private readonly primary: Uint32Array;
  private readonly verifier: Uint32Array;
  private readonly pieces: number;

  constructor(
    cells: number,
    pieces: number,
    primarySeed = 0x2545f491,
    verifierSeed = 0x9e3779b9,
  ) {
    this.pieces = pieces;
    this.primary = new Uint32Array(cells * pieces);
    this.verifier = new Uint32Array(cells * pieces);
    let first = primarySeed >>> 0;
    let second = verifierSeed >>> 0;
    for (let index = 0; index < this.primary.length; index += 1) {
      first = splitmix32(first);
      second = splitmix32(second);
      this.primary[index] = first;
      this.verifier[index] = second;
    }
  }

  key(cell: number, piece: number): readonly [number, number] {
    const index = cell * this.pieces + piece;
    return [this.primary[index], this.verifier[index]];
  }
}

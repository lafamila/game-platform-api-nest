// Zobrist 해싱 유틸 — othello-ai / gomoku-ai 의 전치표(TT) 공용 키 생성기.
// 64bit 난수 테이블을 splitmix64 로 결정적으로 채운다(시드 고정 → 재현 가능).

const MASK64 = (1n << 64n) - 1n;

function splitmix64(state: bigint): bigint {
  let z = (state + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

export type TTFlag = 'exact' | 'lower' | 'upper';

export interface TTEntry {
  depth: number;
  score: number;
  flag: TTFlag;
  // 후보 이동을 정렬 우선순위로 재사용하기 위한 인코딩된 인덱스(엔진별 의미). 없으면 -1.
  move: number;
}

// cells × pieces 크기의 64bit 키 테이블. key(cell, piece) 를 make/unmake 시 XOR 하여 증분 해시를 유지한다.
export class Zobrist {
  private readonly keys: BigUint64Array;
  private readonly pieces: number;

  constructor(cells: number, pieces: number, seed: bigint = 0x2545f4914f6cdd1dn) {
    this.pieces = pieces;
    this.keys = new BigUint64Array(cells * pieces);
    let state = seed & MASK64;
    for (let i = 0; i < this.keys.length; i += 1) {
      state = splitmix64(state);
      this.keys[i] = state;
    }
  }

  key(cell: number, piece: number): bigint {
    return this.keys[cell * this.pieces + piece];
  }
}

// JavaScript BigInt 연산이 hot path가 되는 게임을 위한 dual 32-bit 키.
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

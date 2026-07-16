import type { TTFlag } from './zobrist';

export type { TTFlag } from './zobrist';

export const TT_MISS = -1;
export const TT_NO_MOVE = -1;

export const TT_EXACT: TTFlag = 'exact';
export const TT_LOWER: TTFlag = 'lower';
export const TT_UPPER: TTFlag = 'upper';

const ENCODED_EXACT = 0;
const ENCODED_LOWER = 1;
const ENCODED_UPPER = 2;
const MAX_CAPACITY_POWER = 30;

/**
 * A fixed-capacity, direct-mapped transposition table for search hot paths.
 *
 * `probe` returns a slot that can be read through the primitive getters. This
 * keeps probes allocation-free while still verifying both halves of a dual
 * 32-bit key. Call `beginGeneration` before a new root search so stale entries
 * are preferred for replacement.
 */
export class FixedTranspositionTable {
  readonly capacity: number;

  private readonly mask: number;
  private readonly primaryKeys: Uint32Array;
  private readonly verifierKeys: Uint32Array;
  private readonly depths: Int16Array;
  private readonly scores: Int32Array;
  private readonly flags: Uint8Array;
  private readonly moves: Int16Array;
  private readonly entryGenerations: Uint16Array;
  private currentGeneration = 1;

  constructor(power: number) {
    if (!Number.isInteger(power) || power < 0 || power > MAX_CAPACITY_POWER) {
      throw new RangeError(
        `transposition table power must be an integer from 0 to ${MAX_CAPACITY_POWER}`,
      );
    }

    const capacity = 2 ** power;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.primaryKeys = new Uint32Array(capacity);
    this.verifierKeys = new Uint32Array(capacity);
    this.depths = new Int16Array(capacity);
    this.scores = new Int32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.moves = new Int16Array(capacity);
    this.entryGenerations = new Uint16Array(capacity);
  }

  get generation(): number {
    return this.currentGeneration;
  }

  /**
   * Starts a new replacement generation without clearing the table.
   * Frequently probed entries are refreshed into the current generation.
   */
  beginGeneration(): number {
    if (this.currentGeneration === 0xffff) {
      // Zero is the empty marker. Clearing on the rare wrap prevents an old
      // entry from appearing current again after the generation counter wraps.
      this.entryGenerations.fill(0);
      this.currentGeneration = 1;
    } else {
      this.currentGeneration += 1;
    }
    return this.currentGeneration;
  }

  clear(): void {
    this.entryGenerations.fill(0);
    this.currentGeneration = 1;
  }

  /** Returns a readable slot, or `TT_MISS` when either key half differs. */
  probe(primary: number, verifier: number): number {
    const normalizedPrimary = primary >>> 0;
    const slot = (normalizedPrimary & this.mask) >>> 0;
    if (
      this.entryGenerations[slot] === 0 ||
      this.primaryKeys[slot] !== normalizedPrimary ||
      this.verifierKeys[slot] !== (verifier >>> 0)
    ) {
      return TT_MISS;
    }

    this.entryGenerations[slot] = this.currentGeneration;
    return slot;
  }

  /**
   * Stores an entry when the slot is empty or stale, or when the new search is
   * at least as deep as the current-generation occupant.
   */
  store(
    primary: number,
    verifier: number,
    depth: number,
    score: number,
    flag: TTFlag,
    move = TT_NO_MOVE,
  ): boolean {
    const normalizedPrimary = primary >>> 0;
    const slot = (normalizedPrimary & this.mask) >>> 0;
    const occupiedInCurrentGeneration = this.entryGenerations[slot] === this.currentGeneration;
    if (occupiedInCurrentGeneration && depth < this.depths[slot]) {
      return false;
    }

    this.primaryKeys[slot] = normalizedPrimary;
    this.verifierKeys[slot] = verifier >>> 0;
    this.depths[slot] = depth;
    this.scores[slot] = score;
    this.flags[slot] =
      flag === TT_EXACT ? ENCODED_EXACT : flag === TT_LOWER ? ENCODED_LOWER : ENCODED_UPPER;
    this.moves[slot] = move;
    this.entryGenerations[slot] = this.currentGeneration;
    return true;
  }

  depthAt(slot: number): number {
    return this.depths[slot];
  }

  scoreAt(slot: number): number {
    return this.scores[slot];
  }

  flagAt(slot: number): TTFlag {
    const flag = this.flags[slot];
    return flag === ENCODED_EXACT ? TT_EXACT : flag === ENCODED_LOWER ? TT_LOWER : TT_UPPER;
  }

  moveAt(slot: number): number {
    return this.moves[slot];
  }
}

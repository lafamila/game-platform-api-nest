import { createHash, randomBytes } from 'crypto';

/**
 * 서버 권위 시드 RNG (root plan §5.1 / 검토 H1).
 *
 * 카드 셔플·딜·맵 시드 등 "공정성과 재현성이 중요한" 무작위 경로는 반드시 이 유틸을 통해야 한다.
 * - seed 미지정 시 crypto 로 생성한다 (Math.random 금지).
 * - 사용된 seed 를 반환값으로 노출하므로 호출부가 state_json 에 감사/재현용으로 기록할 수 있다.
 * - 시드가 노출되면 히든 정보(딜 순서 등)를 역산할 수 있으므로 viewFor/클라 응답에는 seed 를 절대 포함하지 않는다.
 *
 * AI 의 행동 노이즈처럼 공정성과 무관한 무작위는 기존 Math.random 을 유지해도 된다.
 */
export interface SeededRng {
  /** 이 RNG 를 재현하는 데 필요한 seed 문자열. 감사 로그 전용 — 클라에는 절대 노출 금지. */
  readonly seed: string;
  /** [0, 1) 부동소수 */
  next(): number;
  /** [0, maxExclusive) 정수 */
  int(maxExclusive: number): number;
  /** Fisher-Yates in-place 셔플. 입력 배열을 그대로 반환한다. */
  shuffle<T>(items: T[]): T[];
  /** 배열에서 하나를 균등 확률로 선택 */
  pick<T>(items: T[]): T;
}

/** 128-bit crypto seed 를 hex 문자열로 생성 (감사/재현용 기본 seed). */
export function cryptoSeed(): string {
  return randomBytes(16).toString('hex');
}

/**
 * crypto 기반 31-bit 양의 정수 seed.
 * crazy_arcade 처럼 내부적으로 숫자 seed 를 쓰는 경로의 seed 소스를 Math.random 에서 crypto 로 교체할 때 사용한다.
 */
export function cryptoSeedInt(): number {
  return randomBytes(4).readUInt32LE(0) & 0x7fffffff;
}

function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededRng(seed?: string): SeededRng {
  const resolvedSeed = seed && seed.length > 0 ? seed : cryptoSeed();
  // seed 문자열을 SHA-256 으로 32-bit 상태로 축약해 PRNG 를 초기화한다.
  const digest = createHash('sha256').update(resolvedSeed).digest();
  const next = mulberry32(digest.readUInt32LE(0));
  const int = (maxExclusive: number): number => {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) {
      return 0;
    }
    return Math.floor(next() * maxExclusive);
  };
  return {
    seed: resolvedSeed,
    next,
    int,
    shuffle<T>(items: T[]): T[] {
      for (let index = items.length - 1; index > 0; index -= 1) {
        const swapIndex = int(index + 1);
        [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
      }
      return items;
    },
    pick<T>(items: T[]): T {
      return items[int(items.length)];
    },
  };
}

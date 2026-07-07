import { BadRequestException } from '@nestjs/common';

/**
 * 고스톱(gostop) 엔진 — 2인(맞고)·3인 화투 점수/재화 게임.
 *
 * 세션 재화 루프는 섯다(seotda-engine.ts)와 동일한 구조다:
 * - 세션 시작 시 공통 재화를 전원에게 동일 분배(기본 10,000, config).
 * - 연속 판(round) 진행. 선(先) = 직전 판 승자.
 * - 판마다 점수 × 배수 × 점당금액(pointValue, 기본 100)을 패자가 승자에게 지불.
 *   3인은 패자 각자 지불하며, 박 배수는 패자별로 적용된다.
 * - 잔액 0 이하 발생 또는 이탈 시 세션 종료 → 잔액 최다 보유자 승리(reason bankrupt|opponent_left).
 *
 * 이 파일의 첫 계층(카드 매핑·점수 계산)은 순수 함수로, 상태머신과 분리해 전수 테스트한다.
 *
 * 채택한 표준 룰 기본값(지방룰 변형 옵션은 서비스 보고서 참조):
 * - 덱 48장. 카드 id 'hwatu_{month}_{1..4}'. 파생 규칙 없이 명시 매핑 테이블만 사용.
 * - kind: gwang | yeol | tti | pi | ssangpi.
 * - 띠 단 그룹: 홍단(1·2·3월) / 청단(6·9·10월) / 초단(4·5·7월). 비띠(12월)는 단 그룹 없음.
 * - 고도리: 2·4·8월 열끗 3장.
 */

export type GostopCardKind = 'gwang' | 'yeol' | 'tti' | 'pi' | 'ssangpi';
export type GostopTtiGroup = 'hongdan' | 'cheongdan' | 'chodan';
export type GostopCardIndex = 1 | 2 | 3 | 4;

export interface GostopCard {
  id: string; // 'hwatu_{month}_{index}'
  month: number; // 1..12
  index: GostopCardIndex;
  kind: GostopCardKind;
  /** 단(띠) 그룹. 비띠(12월 띠)는 그룹이 없다. */
  ttiGroup?: GostopTtiGroup;
  /** 고도리 새(2·4·8월 열끗). */
  godori?: boolean;
  /** 비광(12월 광). 3광 계산 시 2점 판정에 쓰인다. */
  biGwang?: boolean;
}

interface CardSpec {
  kind: GostopCardKind;
  ttiGroup?: GostopTtiGroup;
  godori?: boolean;
  biGwang?: boolean;
}

/**
 * 48장 명시 매핑 테이블. 이 테이블이 카드 정의의 유일한 소스다(파생 규칙 금지).
 * 1~10월: 1=광(1·3·8월)/열끗(그 외), 2=띠(8월만 열끗), 3·4=피.
 * 11월(오동): 1=광, 2=쌍피, 3=피, 4=피.
 * 12월(비): 1=비광, 2=열끗, 3=비띠, 4=쌍피.
 */
const CARD_TABLE: Record<number, Record<GostopCardIndex, CardSpec>> = {
  1: { 1: { kind: 'gwang' }, 2: { kind: 'tti', ttiGroup: 'hongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  2: { 1: { kind: 'yeol', godori: true }, 2: { kind: 'tti', ttiGroup: 'hongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  3: { 1: { kind: 'gwang' }, 2: { kind: 'tti', ttiGroup: 'hongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  4: { 1: { kind: 'yeol', godori: true }, 2: { kind: 'tti', ttiGroup: 'chodan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  5: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'chodan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  6: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'cheongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  7: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'chodan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  8: { 1: { kind: 'gwang' }, 2: { kind: 'yeol', godori: true }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  9: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'cheongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  10: { 1: { kind: 'yeol' }, 2: { kind: 'tti', ttiGroup: 'cheongdan' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  11: { 1: { kind: 'gwang' }, 2: { kind: 'ssangpi' }, 3: { kind: 'pi' }, 4: { kind: 'pi' } },
  12: { 1: { kind: 'gwang', biGwang: true }, 2: { kind: 'yeol' }, 3: { kind: 'tti' }, 4: { kind: 'ssangpi' } },
};

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const INDICES: GostopCardIndex[] = [1, 2, 3, 4];

export function gostopCardId(month: number, index: GostopCardIndex): string {
  return `hwatu_${month}_${index}`;
}

function makeCard(month: number, index: GostopCardIndex): GostopCard {
  const spec = CARD_TABLE[month]?.[index];
  if (!spec) {
    throw new BadRequestException(`invalid gostop card: ${month}/${index}`);
  }
  return {
    id: gostopCardId(month, index),
    month,
    index,
    kind: spec.kind,
    ttiGroup: spec.ttiGroup,
    godori: spec.godori,
    biGwang: spec.biGwang,
  };
}

export function parseGostopCardId(id: string): GostopCard {
  const match = /^hwatu_(\d{1,2})_(1|2|3|4)$/.exec(id);
  if (!match) {
    throw new BadRequestException(`invalid gostop card id: ${id}`);
  }
  const month = Number(match[1]);
  const index = Number(match[2]) as GostopCardIndex;
  if (!MONTHS.includes(month)) {
    throw new BadRequestException(`invalid gostop card month: ${id}`);
  }
  return makeCard(month, index);
}

export function createGostopDeck(): GostopCard[] {
  const deck: GostopCard[] = [];
  for (const month of MONTHS) {
    for (const index of INDICES) {
      deck.push(makeCard(month, index));
    }
  }
  return deck;
}

// ---------------------------------------------------------------------------
// 점수 계산 (획득 패 실시간 계산 — 순수 함수)
// ---------------------------------------------------------------------------

export interface GostopScoreBreakdown {
  gwang: number;
  yeol: number;
  tti: number;
  pi: number;
  total: number;
  /** 고도리 성립 여부(2·4·8월 열끗 3장). */
  godori: boolean;
  /** 완성된 단 그룹. */
  danGroups: GostopTtiGroup[];
  /** 환산 피 장수(쌍피=2). */
  piCount: number;
  /** 광 장수. */
  gwangCount: number;
  /** 비광 포함 여부. */
  hasBiGwang: boolean;
}

/** 획득한 카드 배열로 실시간 점수를 계산한다. */
export function scoreGostopCaptures(cards: GostopCard[]): GostopScoreBreakdown {
  // 광.
  const gwangCards = cards.filter((card) => card.kind === 'gwang');
  const gwangCount = gwangCards.length;
  const hasBiGwang = gwangCards.some((card) => card.biGwang);
  let gwang = 0;
  if (gwangCount >= 5) {
    gwang = 15;
  } else if (gwangCount === 4) {
    gwang = 4;
  } else if (gwangCount === 3) {
    gwang = hasBiGwang ? 2 : 3;
  }

  // 열끗 + 고도리.
  const yeolCards = cards.filter((card) => card.kind === 'yeol');
  const yeolCount = yeolCards.length;
  let yeol = yeolCount >= 5 ? yeolCount - 4 : 0;
  const godoriCount = cards.filter((card) => card.godori).length;
  const godori = godoriCount >= 3;
  if (godori) {
    yeol += 5;
  }

  // 단(띠).
  const ttiCards = cards.filter((card) => card.kind === 'tti');
  const ttiCount = ttiCards.length;
  let tti = ttiCount >= 5 ? ttiCount - 4 : 0;
  const danGroups: GostopTtiGroup[] = [];
  for (const group of ['hongdan', 'cheongdan', 'chodan'] as GostopTtiGroup[]) {
    if (ttiCards.filter((card) => card.ttiGroup === group).length >= 3) {
      danGroups.push(group);
      tti += 3;
    }
  }

  // 피(쌍피=2 환산).
  let piCount = 0;
  for (const card of cards) {
    if (card.kind === 'pi') {
      piCount += 1;
    } else if (card.kind === 'ssangpi') {
      piCount += 2;
    }
  }
  const pi = piCount >= 10 ? piCount - 9 : 0;

  return {
    gwang,
    yeol,
    tti,
    pi,
    total: gwang + yeol + tti + pi,
    godori,
    danGroups,
    piCount,
    gwangCount,
    hasBiGwang,
  };
}

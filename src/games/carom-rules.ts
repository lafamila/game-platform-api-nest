/**
 * 캐롬(사구/삼구) 판정식 — 물리 접촉 이벤트 스트림을 룰 결과로 환산한다.
 *
 * 물리 엔진(`billiards-physics.ts`)이 만든 시간순 `ContactEvent[]` 에서 **수구(shooter cue)** 의
 * 접촉만 추려서 다음을 계산한다:
 *  - `ballsHit`: 수구가 맞힌 공 id 순서(목적구=빨강, 상대 수구 포함).
 *  - `redsHit`: 수구가 맞힌 서로 다른 빨강 공 개수(0..2).
 *  - `cushionsBeforeSecondObject`: 두 번째 목적구(빨강) 접촉 전까지 수구가 친 쿠션 수.
 *  - `hitOpponentCue`: 수구가 상대 수구를 건드렸는지.
 *  - `threeCushion`: 두 번째 목적구 접촉 전 쿠션 3회 이상(삼구 성공 조건).
 *
 * 사구/삼구가 이 결과를 그대로 재사용한다:
 *  - 사구 성공  = redsHit === 2 && !hitOpponentCue
 *  - 사구 파울  = hitOpponentCue (상대 수구 접촉)
 *  - 삼구 성공  = redsHit === 2 && threeCushion (&& !hitOpponentCue 는 삼구 룰에 따라 선택)
 */

import { ContactEvent } from './billiards-physics';

export interface CaromContext {
  /** 이번 타격의 수구 id. */
  cueBallId: string;
  /** 상대 수구 id(사구에서는 파울 판정 대상). */
  opponentCueId: string;
  /** 목적구(빨강) id 목록. */
  redBallIds: string[];
}

export interface CaromResult {
  /** 수구가 맞힌 공 id 순서(빨강 + 상대 수구). */
  ballsHit: string[];
  /** 수구가 맞힌 서로 다른 빨강 개수(0..2). */
  redsHit: number;
  /** 두 번째 목적구 접촉 전까지 수구가 친 쿠션 수. */
  cushionsBeforeSecondObject: number;
  /** 수구가 상대 수구를 접촉했는지. */
  hitOpponentCue: boolean;
  /** 두 번째 목적구 접촉 전 쿠션 3회 이상. */
  threeCushion: boolean;
}

export function evaluateCarom(events: ContactEvent[], context: CaromContext): CaromResult {
  const reds = new Set(context.redBallIds);
  const ordered = [...events].sort((a, b) => a.t - b.t);

  const ballsHit: string[] = [];
  const distinctReds = new Set<string>();
  let hitOpponentCue = false;
  let cushionCount = 0;
  let cushionsBeforeSecondObject = 0;
  let reachedSecondObject = false;

  for (const event of ordered) {
    if (!involvesCue(event, context.cueBallId)) {
      continue;
    }
    if (event.type === 'cushion') {
      cushionCount += 1;
      continue;
    }
    // ball 접촉: 수구 상대 공 식별.
    const other = event.ball === context.cueBallId ? event.other : event.ball;
    if (!other) {
      continue;
    }
    if (other === context.opponentCueId) {
      hitOpponentCue = true;
      ballsHit.push(other);
      continue;
    }
    if (reds.has(other)) {
      ballsHit.push(other);
      const isNewObject = !distinctReds.has(other);
      distinctReds.add(other);
      if (isNewObject && distinctReds.size === 2 && !reachedSecondObject) {
        reachedSecondObject = true;
        cushionsBeforeSecondObject = cushionCount;
      }
    }
  }

  // 두 번째 목적구에 도달하지 못하면 지금까지의 쿠션 수를 그대로 노출.
  if (!reachedSecondObject) {
    cushionsBeforeSecondObject = cushionCount;
  }

  return {
    ballsHit,
    redsHit: distinctReds.size,
    cushionsBeforeSecondObject,
    hitOpponentCue,
    threeCushion: reachedSecondObject && cushionsBeforeSecondObject >= 3,
  };
}

/** 사구 성공/파울 요약. */
export interface FourBallOutcome {
  scored: boolean;
  foul: boolean;
  threeCushion: boolean;
  cushions: number;
  ballsHit: string[];
}

export function evaluateFourBall(events: ContactEvent[], context: CaromContext): FourBallOutcome {
  const carom = evaluateCarom(events, context);
  const foul = carom.hitOpponentCue;
  const scored = carom.redsHit === 2 && !foul;
  return {
    scored,
    foul,
    threeCushion: carom.threeCushion,
    cushions: carom.cushionsBeforeSecondObject,
    ballsHit: carom.ballsHit,
  };
}

function involvesCue(event: ContactEvent, cueBallId: string): boolean {
  return event.ball === cueBallId || event.other === cueBallId;
}

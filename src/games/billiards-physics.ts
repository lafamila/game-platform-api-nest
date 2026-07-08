/**
 * 결정적 2D 당구 물리 엔진 (사구/삼구 공용).
 *
 * 고정 타임스텝(8ms) 시뮬레이션으로, 동일 입력 + 동일 seed 면 항상 동일한 프레임/이벤트를 만든다.
 * 사구 엔진(`four-ball-engine.ts`)이 이 모듈을 호출하고, 추후 삼구도 같은 엔진을 재사용한다.
 *
 * 좌표계: 화면 좌표(x 오른쪽, y 아래쪽). 테이블은 1000×500, 공 반지름 15.
 * 쿠션 = 4벽. 공 중심은 항상 [R, W-R] × [R, H-R] 안에 유지된다.
 *
 * 사용자 강조사항(정성 요구):
 *  1) 감속: 슬라이딩(초기 큰 미끄럼 마찰) → 롤링(작은 저항) 2단계 + 쿠션 반발 시 확실한 감속.
 *  2) 회전:
 *     - 사이드 스핀(english, tipX)이 쿠션 반사각을 바꾼다(접선 속도에 스핀 전달, 스핀 소모).
 *     - follow/draw(tipY)는 수구가 목적구에 정면 충돌한 뒤 전진(밀어치기)/후진(끌어치기) 거동을 만든다.
 *     - 무회전 정면 충돌 = 스톱샷(수구 정지) 근사.
 *     - 스핀 자체도 시간·접촉으로 감쇠.
 *  3) 삑사리(miscue): 당점 거리 d 가 크면 시드 RNG 로 확률 발생, power/각도 교란.
 */

// ---------------------------------------------------------------------------
// 상수 (좌표계·물리 상수는 명시적으로 export — 클라/삼구가 공유)
// ---------------------------------------------------------------------------

export const TABLE_WIDTH = 1000;
export const TABLE_HEIGHT = 500;
export const BALL_RADIUS = 15;

/** power=1 일 때 초속(units/second). */
export const MAX_SPEED = 1400;

/** 고정 타임스텝(초). 8ms. */
export const TIMESTEP = 0.008;
/** 프레임 출력 간격(ms). 2 스텝마다 한 프레임. */
export const FRAME_MS = 16;
const STEPS_PER_FRAME = Math.max(1, Math.round(FRAME_MS / (TIMESTEP * 1000)));
/** 최대 시뮬 시간(초). 이후 강제 정지. */
export const MAX_SIM_TIME = 12;
const MAX_STEPS = Math.ceil(MAX_SIM_TIME / TIMESTEP);

/** 쿠션 법선 반발계수(0.85 내외) — 반발 시 확실한 감속. */
export const CUSHION_RESTITUTION = 0.85;
/** 쿠션 접선 성분 마찰 감쇠(접선 속도 유지 비율). */
export const CUSHION_TANGENT_KEEP = 0.85;
/** 사이드 스핀이 쿠션 접선 속도로 전달되는 계수. */
export const CUSHION_SIDE_TRANSFER = 0.55;
/** 쿠션 1회 반발 후 남는 사이드 스핀 비율(스핀 소모). */
export const CUSHION_SIDE_CONSUME = 0.5;

/** 슬라이딩(초기) 감속 가속도(units/s²) — 크다. */
export const SLIDING_DECEL = 900;
/** 롤링 감속 가속도(units/s²) — 작다. */
export const ROLLING_DECEL = 180;
/** 슬라이딩 → 롤링 전환까지의 시간(초). */
export const SLIDE_TIME = 0.15;

/** 당점 거리 → 스핀량 스케일(follow/draw, side 공통). */
export const SPIN_SCALE = 1.0;
/** follow/draw 가 정면 충돌 후 수구 속도에 전달되는 계수(units/s per unit spin). */
export const FOLLOW_TRANSFER = 520;
/** 스핀의 초당 감쇠 비율. */
export const SPIN_DECAY_PER_SEC = 1.1;

/** 정지로 간주하는 속력(units/s). */
export const STOP_SPEED = 4;

/** 삑사리 상한 확률(d=1 에서). */
export const MISCUE_MAX_PROB = 0.25;
/** 삑사리가 시작되는 당점 거리 임계값. */
export const MISCUE_THRESHOLD = 0.3;
/** 삑사리 시 파워 배율. */
export const MISCUE_POWER_SCALE = 0.25;
/** 삑사리 시 각도 지터 상한(라디안, ±). */
export const MISCUE_ANGLE_JITTER = (12 * Math.PI) / 180;

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

export interface BilliardsBallInput {
  id: string;
  x: number;
  y: number;
}

export interface ShotInput {
  /** 타격하는 수구 id. */
  ballId: string;
  /** 라디안. 화면 좌표(0 = +x, y 아래). */
  angle: number;
  /** 0..1. */
  power: number;
  /** -1..1. 사이드 스핀(english). */
  tipX: number;
  /** -1..1. tipY>0 = follow(전진 회전), tipY<0 = draw(후진 회전). */
  tipY: number;
}

export type BilliardsFrame = Record<string, { x: number; y: number }>;

export interface ContactEvent {
  /** 접촉 시각(초). */
  t: number;
  type: 'cushion' | 'ball';
  /** 접촉의 주체가 되는 공 id. */
  ball: string;
  /** ball-ball 인 경우 상대 공 id. */
  other?: string;
  /** cushion 인 경우 어느 벽인지. */
  cushion?: 'left' | 'right' | 'top' | 'bottom';
}

export interface SimulationResult {
  frameMs: number;
  frames: BilliardsFrame[];
  /** 시간순 접촉 이벤트 목록(판정식 입력). */
  events: ContactEvent[];
  /** 삑사리 발생 여부. */
  miscue: boolean;
  /** 최종 공 위치(id → {x,y}). */
  finalPositions: Record<string, { x: number; y: number }>;
}

/** 삑사리 판정을 위한 최소 RNG 계약(engine 의 시드 RNG 와 호환). */
export interface DeterministicRng {
  /** [0, 1) */
  next(): number;
}

interface WorkingBall {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** follow(+)/draw(-) 스핀, 참조 방향(dirX,dirY) 기준. */
  spinFollow: number;
  /** 사이드 스핀(english). */
  spinSide: number;
  /** follow/draw 참조 방향(타격 시 진행 방향). */
  dirX: number;
  dirY: number;
  /** 슬라이딩 경과 시간(초). SLIDE_TIME 초과 시 롤링. */
  slideElapsed: number;
  /** 이 공이 이미 공-공 접촉을 했는지(follow/draw 는 첫 접촉에만 표현). */
  hitBallOnce: boolean;
  active: boolean;
}

// ---------------------------------------------------------------------------
// 삑사리 확률
// ---------------------------------------------------------------------------

/** 당점 거리 d(=hypot(tipX,tipY), 0..1) → 삑사리 확률(0..MISCUE_MAX_PROB). */
export function miscueProbability(tipX: number, tipY: number): number {
  const d = Math.min(1, Math.hypot(tipX, tipY));
  if (d <= MISCUE_THRESHOLD) {
    return 0;
  }
  const ratio = (d - MISCUE_THRESHOLD) / (1 - MISCUE_THRESHOLD);
  return ratio * MISCUE_MAX_PROB;
}

// ---------------------------------------------------------------------------
// 시뮬레이션
// ---------------------------------------------------------------------------

export function simulateBilliards(
  balls: BilliardsBallInput[],
  shot: ShotInput,
  rng: DeterministicRng,
): SimulationResult {
  const working: WorkingBall[] = balls.map((ball) => ({
    id: ball.id,
    x: ball.x,
    y: ball.y,
    vx: 0,
    vy: 0,
    spinFollow: 0,
    spinSide: 0,
    dirX: 0,
    dirY: 0,
    slideElapsed: 0,
    hitBallOnce: false,
    active: true,
  }));

  const cue = working.find((ball) => ball.id === shot.ballId);
  const miscue = applyShot(cue, shot, rng);

  const events: ContactEvent[] = [];
  const frames: BilliardsFrame[] = [snapshot(working)];

  let step = 0;
  for (; step < MAX_STEPS; step += 1) {
    const t = step * TIMESTEP;
    integrate(working);
    resolveCushions(working, events, t + TIMESTEP);
    resolveBallCollisions(working, events, t + TIMESTEP);
    decaySpin(working);

    if ((step + 1) % STEPS_PER_FRAME === 0) {
      frames.push(snapshot(working));
    }
    if (allResting(working)) {
      break;
    }
  }

  // 마지막 프레임 보정(정지 상태 확정).
  for (const ball of working) {
    ball.vx = 0;
    ball.vy = 0;
    ball.x = round2(ball.x);
    ball.y = round2(ball.y);
  }
  frames.push(snapshot(working));

  const finalPositions: Record<string, { x: number; y: number }> = {};
  for (const ball of working) {
    finalPositions[ball.id] = { x: ball.x, y: ball.y };
  }

  return { frameMs: FRAME_MS, frames, events, miscue, finalPositions };
}

// ---------------------------------------------------------------------------
// 내부 헬퍼
// ---------------------------------------------------------------------------

function applyShot(cue: WorkingBall | undefined, shot: ShotInput, rng: DeterministicRng): boolean {
  if (!cue) {
    return false;
  }
  let angle = shot.angle;
  let power = clamp(shot.power, 0, 1);
  let tipX = clamp(shot.tipX, -1, 1);
  let tipY = clamp(shot.tipY, -1, 1);

  const probability = miscueProbability(tipX, tipY);
  let miscue = false;
  if (probability > 0 && rng.next() < probability) {
    miscue = true;
    power *= MISCUE_POWER_SCALE;
    angle += (rng.next() * 2 - 1) * MISCUE_ANGLE_JITTER;
    // 삑사리는 큐가 헛나가므로 의도한 스핀도 대부분 실패한다.
    tipX *= 0.2;
    tipY *= 0.2;
  }

  const speed = power * MAX_SPEED;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  cue.vx = dirX * speed;
  cue.vy = dirY * speed;
  cue.dirX = dirX;
  cue.dirY = dirY;
  cue.spinFollow = tipY * SPIN_SCALE;
  cue.spinSide = tipX * SPIN_SCALE;
  cue.slideElapsed = 0;
  return miscue;
}

function integrate(balls: WorkingBall[]): void {
  for (const ball of balls) {
    if (!ball.active) {
      continue;
    }
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed <= 0) {
      continue;
    }
    ball.x += ball.vx * TIMESTEP;
    ball.y += ball.vy * TIMESTEP;

    // 슬라이딩 → 롤링 2단계 감속.
    ball.slideElapsed += TIMESTEP;
    const decel = ball.slideElapsed < SLIDE_TIME ? SLIDING_DECEL : ROLLING_DECEL;
    const drop = decel * TIMESTEP;
    const nextSpeed = Math.max(0, speed - drop);
    if (nextSpeed <= 0) {
      ball.vx = 0;
      ball.vy = 0;
    } else {
      const scale = nextSpeed / speed;
      ball.vx *= scale;
      ball.vy *= scale;
    }
  }
}

function resolveCushions(balls: WorkingBall[], events: ContactEvent[], t: number): void {
  const minX = BALL_RADIUS;
  const maxX = TABLE_WIDTH - BALL_RADIUS;
  const minY = BALL_RADIUS;
  const maxY = TABLE_HEIGHT - BALL_RADIUS;
  for (const ball of balls) {
    if (!ball.active) {
      continue;
    }
    // 좌/우 벽: 법선 = x, 접선 = y.
    if (ball.x < minX && ball.vx < 0) {
      ball.x = minX + (minX - ball.x);
      bounceVertical(ball);
      events.push({ t: round4(t), type: 'cushion', ball: ball.id, cushion: 'left' });
    } else if (ball.x > maxX && ball.vx > 0) {
      ball.x = maxX - (ball.x - maxX);
      bounceVertical(ball);
      events.push({ t: round4(t), type: 'cushion', ball: ball.id, cushion: 'right' });
    }
    // 상/하 벽: 법선 = y, 접선 = x.
    if (ball.y < minY && ball.vy < 0) {
      ball.y = minY + (minY - ball.y);
      bounceHorizontal(ball);
      events.push({ t: round4(t), type: 'cushion', ball: ball.id, cushion: 'top' });
    } else if (ball.y > maxY && ball.vy > 0) {
      ball.y = maxY - (ball.y - maxY);
      bounceHorizontal(ball);
      events.push({ t: round4(t), type: 'cushion', ball: ball.id, cushion: 'bottom' });
    }
    // 안전 클램프(수치 오차로 밖에 남는 경우).
    ball.x = clamp(ball.x, minX, maxX);
    ball.y = clamp(ball.y, minY, maxY);
  }
}

/** 좌/우 벽 반발: 법선(x) restitution, 접선(y) 마찰 + 사이드 스핀 전달(입사 법선 속력에 비례). */
function bounceVertical(ball: WorkingBall): void {
  const normalSpeed = Math.abs(ball.vx);
  ball.vx = -ball.vx * CUSHION_RESTITUTION;
  ball.vy = ball.vy * CUSHION_TANGENT_KEEP + ball.spinSide * CUSHION_SIDE_TRANSFER * normalSpeed;
  ball.spinSide *= CUSHION_SIDE_CONSUME;
  ball.slideElapsed = 0;
}

/** 상/하 벽 반발: 법선(y) restitution, 접선(x) 마찰 + 사이드 스핀 전달(입사 법선 속력에 비례). */
function bounceHorizontal(ball: WorkingBall): void {
  const normalSpeed = Math.abs(ball.vy);
  ball.vy = -ball.vy * CUSHION_RESTITUTION;
  ball.vx = ball.vx * CUSHION_TANGENT_KEEP + ball.spinSide * CUSHION_SIDE_TRANSFER * normalSpeed;
  ball.spinSide *= CUSHION_SIDE_CONSUME;
  ball.slideElapsed = 0;
}

function resolveBallCollisions(balls: WorkingBall[], events: ContactEvent[], t: number): void {
  const minDistance = BALL_RADIUS * 2;
  for (let i = 0; i < balls.length; i += 1) {
    for (let j = i + 1; j < balls.length; j += 1) {
      const a = balls[i];
      const b = balls[j];
      if (!a.active || !b.active) {
        continue;
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= 0 || distance >= minDistance) {
        continue;
      }
      const nx = dx / distance;
      const ny = dy / distance;

      // 위치 분리(등질량이므로 절반씩).
      const overlap = minDistance - distance;
      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;

      // 접근 중일 때만 처리.
      const relVx = b.vx - a.vx;
      const relVy = b.vy - a.vy;
      const approaching = relVx * nx + relVy * ny;
      if (approaching >= 0) {
        continue;
      }

      // 등질량 탄성: 법선 성분 교환.
      const impulse = approaching; // (등질량, 완전탄성 → 상대 법선속도 부호 반전)
      a.vx += impulse * nx;
      a.vy += impulse * ny;
      b.vx -= impulse * nx;
      b.vy -= impulse * ny;

      events.push({ t: round4(t), type: 'ball', ball: a.id, other: b.id });

      // follow/draw: 수구가 목적구에 첫 정면 충돌한 뒤 전진/후진.
      applyFollowDraw(a);
      applyFollowDraw(b);
    }
  }
}

function applyFollowDraw(ball: WorkingBall): void {
  if (ball.hitBallOnce || ball.spinFollow === 0) {
    ball.hitBallOnce = true;
    return;
  }
  ball.hitBallOnce = true;
  ball.vx += ball.dirX * ball.spinFollow * FOLLOW_TRANSFER;
  ball.vy += ball.dirY * ball.spinFollow * FOLLOW_TRANSFER;
  ball.spinFollow = 0;
  ball.slideElapsed = 0;
}

function decaySpin(balls: WorkingBall[]): void {
  const factor = Math.max(0, 1 - SPIN_DECAY_PER_SEC * TIMESTEP);
  for (const ball of balls) {
    ball.spinFollow *= factor;
    ball.spinSide *= factor;
    if (Math.abs(ball.spinFollow) < 1e-4) {
      ball.spinFollow = 0;
    }
    if (Math.abs(ball.spinSide) < 1e-4) {
      ball.spinSide = 0;
    }
  }
}

function allResting(balls: WorkingBall[]): boolean {
  return balls.every((ball) => Math.hypot(ball.vx, ball.vy) < STOP_SPEED);
}

function snapshot(balls: WorkingBall[]): BilliardsFrame {
  const frame: BilliardsFrame = {};
  for (const ball of balls) {
    frame[ball.id] = { x: round2(ball.x), y: round2(ball.y) };
  }
  return frame;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(Math.max(value, minValue), maxValue);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

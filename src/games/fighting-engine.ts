import { BadRequestException } from '@nestjs/common';

import {
  EngineResult,
  FinishInfo,
  GameAction,
  GameDescriptor,
  GameEngine,
  SeatInfo,
} from './engine/game-engine';

/**
 * 격투 (fighting) — 1:1 실시간 격투(KOF/철권류), local_ai 전용.
 *
 * 실행 모델: 60fps 프레임 정밀 시뮬레이션(히트박스/히트스톱/넉백)은 **클라이언트 로컬**에서
 * 돌고(서버 coarse-tick 으로는 격투 판정 불가), 서버는 세션 소유 + **라운드 결과의 권위 검증**을
 * 맡는다(리듬 게임과 같은 "로컬 판정 + 서버 결과 검증" 구조 — backlog §4.3 확정 방향).
 * 온라인전(friend_match)은 socket.io 입력 채널 위 후속 과제로 명시적으로 제외한다.
 *
 * 서버가 검증하는 것:
 *  - 라운드 번호의 단조 순차성(1,2,3...) 과 매치 종료 후 제출 거부
 *  - reason/HP 정합성: ko → 패자 HP 정확히 0, 승자 HP > 0 / timeout → 승자 HP ≥ 패자 HP
 *  - HP 범위(0..maxHp), 라운드 시간 범위(최소 1초 ~ 라운드 제한 + 슬랙)
 *  - 3판 2선승 종료 판정과 승자 확정 (클라이언트가 보낸 승자 주장과 일치해야 함)
 */

export type FightingRoundReason = 'ko' | 'timeout';

export interface FightingRoundResult {
  round: number;
  winner: 'player' | 'ai';
  reason: FightingRoundReason;
  playerHp: number;
  aiHp: number;
  durationMs: number;
  reportedAt: string;
}

export interface FightingGameWinner {
  winner: 'player' | 'ai';
  accountId?: string;
  reason: 'completed' | 'forfeit';
  wins: { player: number; ai: number };
}

export interface FightingSession {
  id: string;
  rev?: number;
  mode: 'local_ai';
  aiDifficulty?: string;
  players: Record<string, string>; // seat0 → 사람 계정 (AI 는 클라이언트 로컬 — 좌석 없음)
  seatCount: number;
  characters: { player: string; ai: string };
  bestOf: number; // 3판 2선승
  roundTimeSeconds: number;
  maxHp: number;
  phase: 'playing' | 'finished';
  status: 'playing' | 'finished';
  currentSeat: number;
  currentTurn: string;
  rounds: FightingRoundResult[];
  wins: { player: number; ai: number };
  gameWinner?: FightingGameWinner;
  winnerSide?: string;
  winnerAccountId?: string;
  finishReason?: string;
  createdAt: string;
  updatedAt: string;
  recentClientMoves?: Record<string, string[]>;
}

export const FIGHTING_BEST_OF = 3;
export const FIGHTING_ROUND_TIME_SECONDS = 60;
export const FIGHTING_MAX_HP = 100;
/** 라운드 최소 소요(즉발 결과 스팸 방지)와 최대 슬랙(일시정지/전환 여유). */
export const FIGHTING_MIN_ROUND_MS = 1_000;
export const FIGHTING_MAX_ROUND_SLACK_MS = 30_000;

const FIGHTING_DESCRIPTOR: GameDescriptor = {
  key: 'fighting',
  title: '격투',
  minPlayers: 1,
  maxPlayers: 1,
  modes: ['local_ai'],
  turnType: 'simultaneous',
  hiddenInfo: false,
  supportsAi: true,
  supportsMatchSave: false,
  status: 'playable',
};

function winsNeeded(session: FightingSession): number {
  return Math.floor(session.bestOf / 2) + 1;
}

function requireInt(value: unknown, name: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new BadRequestException(`${name} must be an integer`);
  }
  return num;
}

function applyRoundResult(
  session: FightingSession,
  payload: Record<string, unknown>,
): EngineResult<FightingSession> {
  if (session.status !== 'playing') {
    throw new BadRequestException('match already finished');
  }
  const round = requireInt(payload.round, 'round');
  if (round !== session.rounds.length + 1) {
    throw new BadRequestException(
      `round must be ${session.rounds.length + 1} (got ${round})`,
    );
  }
  const winner = payload.winner;
  if (winner !== 'player' && winner !== 'ai') {
    throw new BadRequestException("winner must be 'player' or 'ai'");
  }
  const reason = payload.reason;
  if (reason !== 'ko' && reason !== 'timeout') {
    throw new BadRequestException("reason must be 'ko' or 'timeout'");
  }
  const playerHp = requireInt(payload.playerHp, 'playerHp');
  const aiHp = requireInt(payload.aiHp, 'aiHp');
  if (playerHp < 0 || playerHp > session.maxHp || aiHp < 0 || aiHp > session.maxHp) {
    throw new BadRequestException(`hp must be within 0..${session.maxHp}`);
  }
  const winnerHp = winner === 'player' ? playerHp : aiHp;
  const loserHp = winner === 'player' ? aiHp : playerHp;
  if (reason === 'ko') {
    if (loserHp !== 0 || winnerHp <= 0) {
      throw new BadRequestException('ko requires loser hp 0 and winner hp > 0');
    }
  } else if (winnerHp < loserHp) {
    throw new BadRequestException('timeout winner must have the hp lead');
  }
  const durationMs = requireInt(payload.durationMs, 'durationMs');
  const maxMs = session.roundTimeSeconds * 1000 + FIGHTING_MAX_ROUND_SLACK_MS;
  if (durationMs < FIGHTING_MIN_ROUND_MS || durationMs > maxMs) {
    throw new BadRequestException(
      `durationMs must be within ${FIGHTING_MIN_ROUND_MS}..${maxMs}`,
    );
  }
  if (reason === 'timeout' && durationMs < session.roundTimeSeconds * 1000) {
    throw new BadRequestException('timeout round cannot be shorter than the round timer');
  }

  session.rounds.push({
    round,
    winner,
    reason,
    playerHp,
    aiHp,
    durationMs,
    reportedAt: new Date().toISOString(),
  });
  session.wins[winner] += 1;

  const events: Array<{ type: string; payload?: unknown }> = [
    { type: 'fighting.round.recorded', payload: { round, winner, reason } },
  ];
  if (session.wins[winner] >= winsNeeded(session)) {
    finishMatch(session, winner, 'completed');
    events.push({ type: 'fighting.match.finished', payload: session.gameWinner });
  }
  return { state: session, events };
}

function finishMatch(
  session: FightingSession,
  winner: 'player' | 'ai',
  reason: FightingGameWinner['reason'],
): void {
  session.status = 'finished';
  session.phase = 'finished';
  session.gameWinner = {
    winner,
    accountId: winner === 'player' ? session.players.seat0 : undefined,
    reason,
    wins: { ...session.wins },
  };
  session.winnerSide = winner === 'player' ? 'seat0' : 'ai';
  session.winnerAccountId = winner === 'player' ? session.players.seat0 : undefined;
  session.finishReason = reason;
}

export const FIGHTING_ENGINE: GameEngine<FightingSession> = {
  descriptor: FIGHTING_DESCRIPTOR,
  stateVersion: 1,

  createState(players: SeatInfo[], config: Record<string, unknown>): FightingSession {
    const human = players.find((seat) => seat.kind === 'account');
    if (!human?.accountId) {
      throw new BadRequestException('fighting requires one human seat');
    }
    const now = new Date().toISOString();
    return {
      id: typeof config.id === 'string' ? config.id : '',
      mode: 'local_ai',
      aiDifficulty:
        typeof config.aiDifficulty === 'string' ? config.aiDifficulty : 'medium',
      players: { seat0: human.accountId },
      seatCount: 1,
      characters: { player: 'martial_hero', ai: 'martial_hero_2' },
      bestOf: FIGHTING_BEST_OF,
      roundTimeSeconds: FIGHTING_ROUND_TIME_SECONDS,
      maxHp: FIGHTING_MAX_HP,
      phase: 'playing',
      status: 'playing',
      currentSeat: 0,
      currentTurn: 'seat0',
      rounds: [],
      wins: { player: 0, ai: 0 },
      createdAt: now,
      updatedAt: now,
    };
  },

  applyAction(
    state: FightingSession,
    seat: number,
    action: GameAction,
  ): EngineResult<FightingSession> {
    if (seat !== 0) {
      throw new BadRequestException('fighting has a single human seat');
    }
    const payload = action.payload ?? {};
    if (action.type === 'round_result') {
      return applyRoundResult(state, payload);
    }
    if (action.type === 'forfeit') {
      if (state.status === 'playing') {
        finishMatch(state, 'ai', 'forfeit');
      }
      return {
        state,
        events: [{ type: 'fighting.match.finished', payload: state.gameWinner }],
      };
    }
    throw new BadRequestException(`unsupported fighting action: ${action.type}`);
  },

  viewFor(state: FightingSession): unknown {
    const { recentClientMoves: _hidden, ...view } = state;
    return view;
  },

  finishInfo(state: FightingSession): FinishInfo | null {
    if (state.status !== 'finished') {
      return null;
    }
    return {
      status: 'finished',
      winnerSeat: state.gameWinner?.winner === 'player' ? 0 : undefined,
      reason: state.finishReason,
    };
  },
};

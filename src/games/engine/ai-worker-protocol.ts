// AI 워커 프로토콜 (메인 ↔ dist/games/engine/ai-worker.js).
// 보드는 구조화 복제로 워커에 전달 가능한 순수 데이터((color|null)[][]).

export type AiWorkerGame = 'othello' | 'gomoku';
export type AiCellColor = 'black' | 'white';

export interface AiWorkerRequest {
  game: AiWorkerGame;
  board: (AiCellColor | null)[][];
  turn: AiCellColor; // 착수할 차례(= AI 가 두는 색)
  aiColor: AiCellColor; // 프로토콜 명세상 포함. 현재는 turn 과 동일.
  budgetMs: number;
  // Submission-to-response absolute deadline. Pool queue time is charged to it.
  deadlineAt?: number;
}

export interface AiWorkerMove {
  row: number;
  col: number;
}

export interface AiSearchDiagnostics {
  engineVersion: string;
  boardHash: string;
  budgetMs: number;
  elapsedMs: number;
  completedDepth: number;
  searchNodes: number;
  vcfNodes: number;
  vctNodes: number;
  evaluationCalls: number;
  forbiddenChecks: number;
  candidateGenerations: number;
  principalVariation: AiWorkerMove[];
  exitReason: 'empty_board' | 'no_legal_move' | 'immediate_win' | 'forced_block' | 'vcf' | 'vct' | 'proven' | 'exact' | 'exact_timeout' | 'predicted_timeout' | 'node_limit' | 'timeout' | 'completed';
}

// 완료된 깊이마다 보고되는 잠정 최선수. 메인은 타임아웃 강제 종료 시 마지막 interim 을 사용한다.
export interface AiWorkerInterim {
  type: 'interim';
  move: AiWorkerMove | null;
  depth: number;
  score: number;
}

export interface AiWorkerFinal {
  type: 'final';
  move: AiWorkerMove | null;
  depth: number;
  score: number;
  nodes: number;
  diagnostics?: AiSearchDiagnostics;
}

export type AiWorkerMessage = AiWorkerInterim | AiWorkerFinal;

// 검색 함수가 완료 깊이마다 호출하는 콜백(워커에서는 postMessage(interim) 로 연결).
export type AiDepthReporter = (report: { depth: number; move: AiWorkerMove | null; score: number }) => void;

export interface AiSearchResult {
  move: AiWorkerMove | null;
  depth: number;
  score: number;
  nodes: number;
  diagnostics?: AiSearchDiagnostics;
}

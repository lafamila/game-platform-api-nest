import { parentPort } from 'node:worker_threads';
import { searchOthelloMove } from '../othello-ai';
import { searchGomokuMove } from '../gomoku-ai';
import { AiWorkerMessage, AiWorkerRequest } from './ai-worker-protocol';

// dist/games/engine/ai-worker.js 로 빌드되어 워커 스레드에서 실행된다.
// 요청을 받아 해당 게임의 검색을 돌리고, 완료 깊이마다 interim, 완료 시 final 을 postMessage 한다.
// 25초급 탐색을 워커에서 돌려 메인 이벤트 루프(타 세션 HTTP·타이머·socket.io)를 막지 않는다.

if (!parentPort) {
  throw new Error('ai-worker must be run as a worker thread');
}

const port = parentPort;

port.on('message', (request: AiWorkerRequest) => {
  const onDepth = (report: { depth: number; move: { row: number; col: number } | null; score: number }) => {
    const interim: AiWorkerMessage = { type: 'interim', move: report.move, depth: report.depth, score: report.score };
    port.postMessage(interim);
  };

  const result =
    request.game === 'othello'
      ? searchOthelloMove(request.board, request.turn, request.budgetMs, onDepth, { deadlineAt: request.deadlineAt })
      : searchGomokuMove(request.board, request.turn, request.budgetMs, onDepth, { deadlineAt: request.deadlineAt });

  const final: AiWorkerMessage = {
    type: 'final',
    move: result.move,
    depth: result.depth,
    score: result.score,
    nodes: result.nodes,
    diagnostics: result.diagnostics,
  };
  port.postMessage(final);
});

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { AiWorkerFinal, AiWorkerMessage, AiWorkerRequest } from './ai-worker-protocol';

// AI 워커 실행기 — 동시 실행을 상한(기본 2)으로 묶고 초과분은 FIFO 큐로 대기시킨다.
// 코어 포화를 막고, 큐 대기부터 계산까지 하나의 절대 마감 안에서 처리한다.
// 잡마다 워커를 새로 스폰해 상태 누수를 원천 차단한다(스폰 비용은 25초 예산 대비 무시 가능).

const DEFAULT_WORKER_FILE = path.join(__dirname, 'ai-worker.js');

export class AiWorkerPool {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly workerFile: string = DEFAULT_WORKER_FILE,
  ) {}

  // 검색을 워커에서 수행하고 final(또는 타임아웃 시 마지막 interim)을 반환한다.
  // 스폰/직렬화 실패 등은 reject → 호출부가 동기 구 엔진으로 강등한다.
  async run(request: AiWorkerRequest): Promise<AiWorkerFinal> {
    const deadlineAt = request.deadlineAt ?? Date.now() + request.budgetMs;
    await this.acquire();
    try {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        return { type: 'final', move: null, depth: 0, score: 0, nodes: 0 };
      }
      return await this.execute({
        ...request,
        budgetMs: Math.max(1, Math.min(request.budgetMs, remainingMs)),
        deadlineAt,
      });
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next(); // 슬롯을 대기 잡에 그대로 넘긴다(active 유지).
    } else {
      this.active -= 1;
    }
  }

  private execute(request: AiWorkerRequest): Promise<AiWorkerFinal> {
    return new Promise<AiWorkerFinal>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(this.workerFile);
      } catch (err) {
        reject(err);
        return;
      }

      let settled = false;
      let killTimer: ReturnType<typeof setTimeout>;
      let lastInterim: AiWorkerFinal = { type: 'final', move: null, depth: 0, score: 0, nodes: 0 };

      const finish = (result: AiWorkerFinal): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        void worker.terminate();
        resolve(result);
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        void worker.terminate();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      killTimer = setTimeout(() => finish(lastInterim), request.budgetMs);

      worker.on('message', (msg: AiWorkerMessage) => {
        if (msg.type === 'interim') {
          lastInterim = { type: 'final', move: msg.move, depth: msg.depth, score: msg.score, nodes: 0 };
        } else {
          finish(msg);
        }
      });
      worker.on('error', (err) => fail(err));
      worker.on('exit', (code) => {
        if (settled) return;
        if (lastInterim.move) finish(lastInterim);
        else fail(new Error(`ai-worker exited (code ${code}) before producing a move`));
      });

      worker.postMessage(request);
    });
  }
}

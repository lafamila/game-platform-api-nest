const { parentPort } = require('node:worker_threads');

parentPort.on('message', () => {
  parentPort.postMessage({
    type: 'interim',
    move: { row: 6, col: 7 },
    depth: 0,
    score: 0,
  });
});

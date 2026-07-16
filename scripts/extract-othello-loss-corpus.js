#!/usr/bin/env node

const { main } = require('./extract-ai-loss-corpus');

main('othello').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

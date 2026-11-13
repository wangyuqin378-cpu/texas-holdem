const { parentPort } = require('node:worker_threads');
const { decide } = require('./botStrategy');
parentPort.on('message', ({ id, state, options }) => {
  try { parentPort.postMessage({ id, decision: decide(state, options) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});

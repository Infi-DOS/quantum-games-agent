'use strict';
// One TiqTaqToe search thread, so the HTTP thread can always answer at the deadline while a search
// is busy. Protocol (every message carries the request id):
//   in : { id, observation, deadline, seed, options }   options: forestSearch's (mcts.js)
//   out: { type: 'ready' } once warm; then { id, type: 'pass', ... } with the merged result after
//        every tree, and { id, type: 'done' } or { id, type: 'error' }.
const { parentPort } = require('node:worker_threads');
const { TiqTaqToeEnvironment: Env } = require('./rules/environment');
const { mctsSearch, forestSearch } = require('./mcts');

async function warm() {
    // Loads the engine and compiles the hot paths before the first real request.
    const env = await Env.create({ quantumness: 2 });
    env.step([4]);
    await mctsSearch(env.observation(), { deadline: Date.now() + 300 });
}

parentPort.on('message', async ({ id, observation, deadline, seed, options = {} }) => {
    try {
        await forestSearch(observation, { ...options, deadline, seed,
            onProgress: r => parentPort.postMessage({ id, type: 'pass', action: r.action, values: r.values,
                visits: r.visits, totals: r.totals, iterations: r.iterations, calls: r.calls, ms: r.ms,
                trees: r.trees }) });
        parentPort.postMessage({ id, type: 'done' });
    } catch (error) {
        parentPort.postMessage({ id, type: 'error', message: error.message });
    }
});

warm().then(() => parentPort.postMessage({ type: 'ready' }),
    error => { console.error('worker warm-up failed:', error); process.exit(1); });

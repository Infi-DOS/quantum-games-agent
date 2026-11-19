/**
 * One Cheqqers search thread for the pool (pool.mjs): loads the engine, says it is ready, then answers
 * { id, request, budgetMs } with { type: 'move', id, move } from the search (search.mjs: searchStrategy).
 * The settings come from the environment, which this thread inherits from the agent (.env):
 * CHEQQERS_MAX_DEPTH and CHEQQERS_EXPLORATION.
 */
import { parentPort } from 'node:worker_threads';
import { ready } from './state.mjs';
import { searchStrategy } from './search.mjs';

const number = (name, fallback) => Number(process.env[name] ?? fallback);
const SEARCH = { maxDepth: number('CHEQQERS_MAX_DEPTH', 8), c: number('CHEQQERS_EXPLORATION', 0.9) };

await ready();
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', async ({ id, request, budgetMs }) => {
    try {
        parentPort.postMessage({ type: 'move', id, move: await searchStrategy(request, { budgetMs, ...SEARCH }) });
    } catch (error) {
        parentPort.postMessage({ type: 'move', id, move: null, error: error.message });
    }
});

'use strict';
/**
 * The TiqTaqToe player (DESIGN.md §2). agent.mjs serves it inside the same process on a local port
 * and sends it the X/O requests.
 *
 *   1. A position in the opening book (data/opening-book.json; used at quantumness 2 without decoherence)
 *      gets the book move.
 *   2. Otherwise BOT_THREADS_PER_MOVE search threads (search-worker.js) run the forest search
 *      (mcts.js) until 0.3 s before the answer is due, and the most-visited move is played. The answer
 *      is due TIME_MARGIN_MS before the request's limit; the search lasts at most BOT_MAX_SEARCH_MS.
 *      With BOT_PRIOR=on (off by default), the learned move prior (data/prior.json) guides it at the
 *      quantumness levels in BOT_PRIOR_LEVELS.
 *   3. A search that fails or overruns gets a quick legal move instead, and its thread is replaced.
 *
 * Each decision is written as one JSON line to `recordDir` (empty: no records).
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { payloadToObservation, fallbackMove, limitSeconds, answerByMs, same } = require('./payload');
const { mergeRoots } = require('./mcts');
const { loadBook, lookup } = require('./book');

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const MAX_BODY_BYTES = 1 << 20;
const DEFAULT_BOOK = path.join(__dirname, 'data', 'opening-book.json');
// The optional move prior: { network, weight, widening } (DESIGN.md §2.4).
const PRIOR_CONFIG = path.join(__dirname, 'data', 'prior.json');
function shippedPrior() {
    if (!fs.existsSync(PRIOR_CONFIG)) return null;
    const c = JSON.parse(fs.readFileSync(PRIOR_CONFIG, 'utf8'));
    return { network: path.resolve(path.dirname(PRIOR_CONFIG), c.network), weight: c.weight ?? 1, widening: c.widening ?? 0 };
}
const SHIPPED_PRIOR = shippedPrior();
// BOT_PRIOR=on: the shipped network's file, which must then exist. Off (the default): the search alone.
function movePrior(setting) {
    if (setting !== 'on') return null;
    if (!SHIPPED_PRIOR || !fs.existsSync(SHIPPED_PRIOR.network)) throw new Error(`BOT_PRIOR=on, but the move prior is missing (${PRIOR_CONFIG})`);
    return SHIPPED_PRIOR.network;
}
const SEARCH_MARGIN_MS = 60;

// BOT_PRIOR_LEVELS: '2', '2,3', ... or 'all' (null: every level).
function levelsOf(text) {
    if (String(text).trim() === 'all') return null;
    return new Set(String(text).split(',').map(s => Number(s.trim())).filter(Number.isInteger));
}

function spawnSlot(file, onUnexpectedExit) {
    const slot = { busy: false, ready: false, retired: false, handler: null, worker: new Worker(file) };
    slot.worker.on('message', message => {
        if (message.type === 'ready') slot.ready = true;
        else slot.handler?.(message);
    });
    slot.worker.on('error', error => slot.handler?.({ type: 'error', message: error.message }));
    slot.worker.on('exit', () => {
        slot.ready = false;
        if (!slot.retired) onUnexpectedExit(slot);
    });
    return slot;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) { reject(new Error('Body too large')); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

const CORES = os.availableParallelism?.() ?? os.cpus().length;

// Defaults leave two threads free so a second simultaneous game still gets a search.
function createPlayer({ workerFile = path.join(__dirname, 'search-worker.js'),
    workers = Number(process.env.BOT_WORKERS ?? Math.max(2, Math.min(6, CORES - 2))),
    threadsPerMove = Number(process.env.BOT_THREADS_PER_MOVE ?? Math.max(1, workers - 2)),
    treeSteps = Number(process.env.BOT_TREE_STEPS ?? 2000),
    exploration = Number(process.env.BOT_EXPLORATION ?? 1.0),
    priorFile = movePrior(process.env.BOT_PRIOR ?? 'off'),
    priorWeight = Number(process.env.BOT_PRIOR_WEIGHT ?? SHIPPED_PRIOR?.weight ?? 1),
    priorWidening = Number(process.env.BOT_PRIOR_WIDENING ?? SHIPPED_PRIOR?.widening ?? 0),
    // The quantumness levels at which the move prior guides the search ('all' = every level). It
    // learned from level-2 games only.
    priorLevels = levelsOf(process.env.BOT_PRIOR_LEVELS ?? '2'),
    drawValue = Number(process.env.BOT_DRAW_VALUE ?? 0.5),
    bothValue = Number(process.env.BOT_BOTH_VALUE ?? drawValue),
    timeMarginMs = Number(process.env.TIME_MARGIN_MS ?? 500),
    maxSearchMs = Number(process.env.BOT_MAX_SEARCH_MS ?? 4000),
    bookFile = process.env.BOT_BOOK === undefined ? DEFAULT_BOOK : process.env.BOT_BOOK || null,
    recordDir = null,
    log = line => console.log(line) } = {}) {
    if (!(treeSteps >= 1)) throw new Error(`BOT_TREE_STEPS must be at least 1, not ${treeSteps}`);
    const searchOptions = { drawValue, bothValue, exploration, treeSteps,
        ...(priorFile ? { priorFile: path.resolve(priorFile), priorWeight, priorWidening } : {}) };
    // The same search without the prior, for levels outside priorLevels.
    const { priorFile: _f, priorWeight: _w, priorWidening: _wd, ...plainOptions } = searchOptions;
    const book = bookFile ? loadBook(path.resolve(bookFile)) : null;
    let closing = false;
    const start = () => spawnSlot(workerFile, replace);
    const slots = Array.from({ length: workers }, start);
    let nextId = 1;

    // The search ends 300 ms before the answer is due (answerByMs: timeMarginMs before the limit, where
    // agent.mjs's guard sends a quick legal move if no answer has come), and lasts at most maxSearchMs.
    const searchMs = settings =>
        Math.max(50, Math.min(maxSearchMs, answerByMs(limitSeconds(settings) * 1000, timeMarginMs) - 300));

    // Swap in a fresh worker for one that is stuck past its deadline or has died.
    function replace(slot) {
        slot.retired = true;
        slot.worker.terminate();
        const index = slots.indexOf(slot);
        if (index !== -1 && !closing) slots[index] = start();
    }

    // Resolves with the best move found by the deadline and where it came from.
    async function decide(payload, received) {
        const legal = payload.legalMoves;
        let observation;
        try {
            observation = payloadToObservation(payload);
        } catch (error) {
            return { move: fallbackMove(legal), source: `fallback (${error.message})` };
        }
        const fallback = { move: fallbackMove(legal), source: 'fallback' };
        const hit = book && lookup(book, observation);
        if (hit) return { move: hit.move, source: 'book', note: `${hit.entry.games} games, score ${hit.entry.score.toFixed(3)}` };
        const team = slots.filter(s => s.ready && !s.busy).slice(0, threadsPerMove);
        if (!team.length) return { ...fallback, source: 'fallback (no idle worker)' };

        const id = nextId++;
        const level = observation.settings.quantumness;     // the request's, else BOT_DEFAULT_QUANTUMNESS
        const usePrior = Boolean(priorFile) && (!priorLevels || priorLevels.has(level));
        const deadline = received + searchMs(observation.settings);
        const latest = new Map(), finished = new Set(), failed = new Map();
        team.forEach(slot => { slot.busy = true; });
        const outcome = await new Promise(resolve => {
            const timer = setTimeout(() => resolve('deadline'), Math.max(0, deadline - Date.now()));
            for (const slot of team) {
                slot.handler = message => {
                    if (message.id !== id) return;
                    if (message.type === 'pass') { latest.set(slot, message); return; }
                    finished.add(slot);
                    if (message.type === 'error') failed.set(slot, message.message);
                    if (finished.size === team.length) { clearTimeout(timer); resolve('done'); }
                };
                // Searches stop a little before the watchdog so they normally finish cleanly;
                // the watchdog (and worker replacement) is only for a search that overruns.
                slot.worker.postMessage({ id, observation, deadline: deadline - SEARCH_MARGIN_MS,
                    options: usePrior ? searchOptions : plainOptions, seed: (Math.random() * 2 ** 32) >>> 0 });
            }
        });
        for (const slot of team) {
            slot.handler = null;
            if (finished.has(slot) && !failed.has(slot)) slot.busy = false;
            else replace(slot);                   // still busy or crashed: start a clean worker
        }
        const note = outcome === 'deadline' ? 'deadline' : failed.size ? `errors: ${[...failed.values()].join('; ')}` : undefined;
        const passes = [...latest.values()];
        if (!passes.length) return { ...fallback, note: note ?? 'no search result' };
        const merged = mergeRoots(legal, observation.currentTurn, passes);
        const move = legal.find(m => same(m, merged.action));
        if (!move) return { ...fallback, note: 'search returned a move that is not legal' };
        const trees = passes.reduce((s, p) => s + (p.trees ?? 1), 0);
        const search = { level: `x${passes.length} threads, ${trees} trees, ${merged.iterations} iterations` +
            `${priorFile && !usePrior ? `, no prior at level ${level}` : ''}`, calls: merged.calls, ms: merged.ms };
        return { move, source: 'search', values: merged.values, search, note };
    }

    async function handleMove(req, res) {
        const received = Date.now();
        let payload;
        try {
            payload = JSON.parse(await readBody(req));
        } catch (error) {
            return send(res, 400, { error: `Malformed request: ${error.message}` });
        }
        if (!Array.isArray(payload?.legalMoves) || payload.legalMoves.length === 0)
            return send(res, 400, { error: 'legalMoves missing or empty' });

        const result = await decide(payload, received);
        // Last guard: only ever return a move the game server listed.
        const move = payload.legalMoves.find(m => same(m, result.move)) ?? fallbackMove(payload.legalMoves);
        const level = result.search ? `${result.search.level} calls=${result.search.calls}` : '-';
        log(`[tiqtaqtoe] ${new Date().toISOString()} ${payload.player} legal=${payload.legalMoves.length} ` +
            `${result.source}${result.note ? ` [${result.note}]` : ''} ${level} ` +
            `${Date.now() - received}ms → ${JSON.stringify(move)}`);
        send(res, 200, { move });
        record(payload, move, result);
    }

    // One JSON line per decision, appended after the reply so it never costs time.
    // `values` are fixed-X scores aligned with legalMoves (null for a book or fallback move).
    let recordDirReady = null;
    function record(payload, move, result) {
        if (!recordDir) return;
        const safe = text => String(text ?? 'game').replace(/[^\w.-]+/g, '_').slice(0, 80);
        const file = path.join(recordDir, `${safe(payload.gameId)}__${safe(payload.roundId)}.jsonl`);
        const frame = {
            gameId: payload.gameId, roundId: payload.roundId, player: payload.player,
            by: 'bot', receivedAt: new Date().toISOString(),
            state: Object.fromEntries(['board', 'probabilities', 'measuredSquares', 'emptySquares',
                'quantumState', 'pairs', 'squareToPair'].map(key => [key, payload[key]])),
            settings: payload.settings, legalMoves: payload.legalMoves, move,
            candidates: result.values ? payload.legalMoves.map((m, i) => ({ move: m, value: result.values[i] })) : null,
            search: result.search ?? null,
            source: result.source
        };
        recordDirReady ??= fs.promises.mkdir(recordDir, { recursive: true });
        recordDirReady.then(() => fs.promises.appendFile(file, JSON.stringify(frame) + '\n'))
            .catch(error => log(`[tiqtaqtoe] could not record game: ${error.message}`));
    }

    function send(res, status, body) {
        res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify(body));
    }

    const server = http.createServer((req, res) => {
        if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
        if (req.method === 'GET' && ['/', '/health', '/move'].includes(req.url))
            return send(res, 200, { status: 'ok', ready: slots.filter(s => s.ready && !s.busy).length, endpoint: 'POST /move',
                movePrior: priorFile ? 'on' : 'off' });
        if (req.method === 'POST' && req.url === '/move')
            return handleMove(req, res).catch(error => {
                log(`[tiqtaqtoe] unexpected error: ${error.stack}`);
                if (!res.headersSent) send(res, 500, { error: error.message });
            });
        send(res, 404, { error: 'POST /move only' });
    });

    const whenReady = async () => {
        while (!slots.every(s => s.ready)) await new Promise(r => setTimeout(r, 20));
    };
    const close = () => new Promise(resolve => {
        closing = true;
        slots.forEach(s => { s.retired = true; s.worker.terminate(); });
        server.close(() => resolve());
        server.closeAllConnections?.();
    });
    return { server, whenReady, close };
}

module.exports = { createPlayer };

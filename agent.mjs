#!/usr/bin/env node
/**
 * Agent 1.0: one URL for both games.
 *
 *   node agent.mjs                  (PORT, default 8081; also node ai-server.js, npm start or ./start.sh)
 *   POST /move     a TiqTaqToe or Cheqqers request  ->  200 { "move": [...] }
 *   GET  /health   (also / and GET /move)           ->  200 { status: "ok", supports, tiqtaqtoe, cheqqers, ... }
 *   OPTIONS *      ->  204 with CORS headers
 *
 * TiqTaqToe (player X or O): tiqtaqtoe/player.js, the opening book and the exact tree search, on its
 * own search threads; a learned move prior can guide the search (BOT_PRIOR=on, off by default). It is
 * served inside this process on a local port and keeps its own deadline watchdog.
 * Cheqqers (player white or black): cheqqers/, the tree search on the organizers' rules, on a pool of
 * search threads (pool.mjs).
 *
 * This thread never searches, so it can always answer on time: a player that fails, is late or answers
 * a move outside legalMoves is replaced by a quick legal move (TiqTaqToe: centre, corners, edges;
 * Cheqqers: random). Each decision is also written as one JSON line per game (to BOT_RECORD_DIR and
 * CHEQQERS_RECORD_DIR; an empty one turns it off).
 *
 * Every parameter is in .env, loaded and checked by env.mjs before anything else runs.
 */
import './env.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeMove } from './cheqqers/safe-move.mjs';
import { createPool } from './cheqqers/pool.mjs';

const require = createRequire(import.meta.url);
const { createPlayer } = require('./tiqtaqtoe/player.js');
const { fallbackMove, limitSeconds, answerByMs } = require('./tiqtaqtoe/payload.js');
const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const VERSION = 'agent 1.0.7: TiqTaqToe = opening book + exact tree search (learned move prior optional, off by default); ' +
    'Cheqqers = tree search on the organizers\' rules';
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, ngrok-skip-browser-warning',
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Which game a request is from: the players are X/O in TiqTaqToe and white/black in Cheqqers. */
export function gameOf(request) {
    const player = request?.player ?? request?.currentTurn;
    if (player === 'X' || player === 'O') return 'tiqtaqtoe';
    if (player === 'white' || player === 'black') return 'cheqqers';
    if (Array.isArray(request?.quantumStates) || request?.settings?.boardSize) return 'cheqqers';
    if (request?.quantumState || (Array.isArray(request?.board) && request.board.length === 9)) return 'tiqtaqtoe';
    return 'unknown';
}

export function createAgent({ name = process.env.AI_NAME || 'christos-athanasios',
    tiqtaqtoe = {},                                   // createPlayer options (workers, threadsPerMove, ...)
    cheqqersThreads = Number(process.env.CHEQQERS_THREADS ?? 3), cheqqersWorkerFile,
    // Every answer, in both games, is due this long before the limit: the time left for the network.
    timeMarginMs = Number(process.env.TIME_MARGIN_MS ?? 500),
    // The Cheqqers limit for a request that leaves it out.
    cheqqersDefaultTimeoutMs = Number(process.env.CHEQQERS_DEFAULT_TIMEOUT_MS ?? 3000),
    tiqtaqtoeRecordDir = null, cheqqersRecordDir = null, log = line => console.log(line) } = {}) {
    const player = createPlayer({ recordDir: tiqtaqtoeRecordDir, log, ...tiqtaqtoe });
    const pool = createPool({ size: cheqqersThreads, log, ...(cheqqersWorkerFile ? { workerFile: cheqqersWorkerFile } : {}) });
    const keepAlive = new http.Agent({ keepAlive: true });
    let playerPort = null;
    const playerListening = new Promise(resolve => player.server.listen(0, '127.0.0.1', () => { playerPort = player.server.address().port; resolve(); }));

    // The TiqTaqToe player's answer through its local port, or null if it fails or is late.
    function askTiqTaqToe(body, ms) {
        return new Promise(resolve => {
            const timer = setTimeout(() => { req.destroy(); resolve(null); }, ms);
            const req = http.request({ host: '127.0.0.1', port: playerPort, path: '/move', method: 'POST', agent: keepAlive,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(data).move ?? null); } catch { resolve(null); } });
            });
            req.on('error', () => { clearTimeout(timer); resolve(null); });
            req.end(body);
        });
    }

    // Waits until the given time; every answer is sent when it is due, so the same time is always left.
    const untilTime = time => new Promise(resolve => setTimeout(resolve, Math.max(0, time - Date.now())));

    async function tiqtaqtoeMove(request, body, arrived) {
        const legal = request.legalMoves;
        await playerListening;
        // The answer is due timeMarginMs before the limit. The player's search ends 0.3 s before that; if
        // it has not answered by then, a quick legal move goes instead. Too little time: no search at all.
        const dueAt = arrived + answerByMs(limitSeconds(request.settings) * 1000, timeMarginMs);
        const answer = dueAt - Date.now() >= 300 ? await askTiqTaqToe(body, dueAt - Date.now()) : null;
        const move = legal.find(m => same(m, answer));
        if (!move) log(`[agent] tiqtaqtoe fallback (${answer === null ? 'no answer in time' : 'not a legal move'})`);
        await untilTime(dueAt);
        return move ?? fallbackMove(legal);
    }

    let recordReady = null;
    function recordCheqqers(request, move, source, ms) {
        if (!cheqqersRecordDir) return;
        const safe = text => String(text ?? 'game').replace(/[^\w.-]+/g, '_').slice(0, 80);
        const file = path.join(cheqqersRecordDir, `${safe(request.gameId)}__${safe(request.roundId)}.jsonl`);
        const frame = { time: new Date().toISOString(), gameId: request.gameId, roundId: request.roundId, player: request.player,
            settings: request.settings, board: request.board, quantumStates: request.quantumStates, legalMoves: request.legalMoves,
            move, source, ms };
        recordReady ??= fs.promises.mkdir(cheqqersRecordDir, { recursive: true });
        recordReady.then(() => fs.promises.appendFile(file, JSON.stringify(frame) + '\n')).catch(error => log(`[agent] record failed: ${error.message}`));
    }

    async function cheqqersMove(request, arrived) {
        const timeout = Number(request.settings?.timeout) || cheqqersDefaultTimeoutMs;
        // The answer is due timeMarginMs before the limit; the search stops 0.2 s before that.
        const dueAt = arrived + answerByMs(timeout, timeMarginMs);
        const { move, source } = await safeMove(request, pool.strategy, { budgetMs: Math.max(0, dueAt - Date.now()) });
        await untilTime(dueAt);
        const ms = Date.now() - arrived;
        log(JSON.stringify({ game: 'cheqqers', time: new Date().toISOString(), player: request.player, legal: request.legalMoves.length, ms, move, source }));
        recordCheqqers(request, move, source, ms);
        return move;
    }

    async function health() {
        let tiq = { ready: 0 };
        try {
            await playerListening;
            const res = await fetch(`http://127.0.0.1:${playerPort}/health`, { signal: AbortSignal.timeout(500) });
            tiq = await res.json();
        } catch { /* reported as not ready */ }
        return { status: 'ok', ok: true, ai: name, version: VERSION, endpoint: 'POST /move', supports: ['tiqtaqtoe', 'cheqqers'],
            tiqtaqtoe: { searchThreadsReady: tiq.ready ?? 0, movePrior: tiq.movePrior ?? 'unknown' }, cheqqers: pool.status() };
    }

    const server = http.createServer((req, res) => {
        const arrived = Date.now();                   // the limit is counted from here
        const send = (status, body) => {
            res.writeHead(status, { ...CORS, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) });
            res.end(body === undefined ? undefined : JSON.stringify(body));
        };
        if (req.method === 'OPTIONS') return send(204);
        const url = req.url.split('?')[0];
        if (req.method === 'GET' && ['/', '/health', '/move'].includes(url)) return health().then(h => send(200, h));
        if (req.method !== 'POST' || url !== '/move') return send(404, { error: 'POST /move only' });
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { if (body.length < 20e6) body += chunk; });
        req.on('error', () => send(400, { error: 'request failed' }));
        req.on('end', async () => {
            let request;
            try { request = JSON.parse(body); } catch (error) { return send(400, { error: `Malformed JSON: ${error.message}` }); }
            const legal = Array.isArray(request?.legalMoves) ? request.legalMoves : [];
            if (!legal.length) return send(400, { error: 'legalMoves missing or empty' });
            const game = gameOf(request);
            try {
                if (game === 'tiqtaqtoe') return send(200, { move: await tiqtaqtoeMove(request, body, arrived) });
                if (game === 'cheqqers') return send(200, { move: await cheqqersMove(request, arrived) });
                log(`[agent] unknown game (player ${JSON.stringify(request.player)}): first legal move`);
                return send(200, { move: legal[0] });
            } catch (error) {
                log(`[agent] ${game} error: ${error.message}; answering a legal move`);
                return send(200, { move: game === 'tiqtaqtoe' ? fallbackMove(legal) : legal[Math.floor(Math.random() * legal.length)] });
            }
        });
    });

    // Keep idle connections open for 65 s. With Node's default of 5 s, a Node client that reuses the
    // connection, as the organizers' referee does, gives up after 4 s instead of at the time limit.
    for (const s of [server, player.server]) { s.keepAliveTimeout = 65000; s.headersTimeout = 66000; }

    return {
        server,
        whenReady: async () => { await playerListening; await player.whenReady(); await pool.whenReady(); },
        close: async () => { pool.close(); keepAlive.destroy(); server.closeAllConnections?.(); await new Promise(r => server.close(() => r())); await player.close(); },
    };
}

// Starts the agent on PORT (default 8081). `node agent.mjs` calls it, and so does ai-server.js, so that the
// agent also starts as the organizers' starter does (`node ai-server.js`, `npm start`, `./start.sh`).
export function main() {
    const port = Number(process.env.PORT || 8081);
    const dir = (name, fallback) => (process.env[name] ?? fallback) || null;
    const agent = createAgent({ tiqtaqtoeRecordDir: dir('BOT_RECORD_DIR', path.join(ROOT, 'games', 'tiqtaqtoe')),
        cheqqersRecordDir: dir('CHEQQERS_RECORD_DIR', path.join(ROOT, 'games', 'cheqqers')) });
    agent.server.listen(port, '0.0.0.0', async () => {
        console.log(`[agent] ${VERSION}`);
        console.log(`[agent] listening on http://0.0.0.0:${port}/move, starting the search threads...`);
        await agent.whenReady();
        console.log(`[agent] ready: POST /move for TiqTaqToe and Cheqqers, GET /health`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => agent.close().then(() => process.exit(0)));
    // A stray error must not take the agent down in the middle of a tournament: log it and keep serving.
    process.on('uncaughtException', error => console.error(`[agent] uncaught error, still serving: ${error?.stack ?? error}`));
    process.on('unhandledRejection', error => console.error(`[agent] unhandled rejection, still serving: ${error?.stack ?? error}`));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

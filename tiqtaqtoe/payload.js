'use strict';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Quick sensible move when no time is left: prefer centre, corners, then edges,
// otherwise the first legal move. Always returns an element of legalMoves.
const PREFERENCE = [[4], [0], [2], [6], [8], [1], [3], [5], [7]];
function fallbackMove(legalMoves) {
    for (const move of PREFERENCE) {
        const hit = legalMoves.find(m => same(m, move));
        if (hit) return hit;
    }
    return legalMoves[0];
}

// A setting the request leaves out takes the agent's default (.env BOT_DEFAULT_*, which env.mjs
// loads); a value the request gives always wins.
function defaultOf(name, fallback) {
    const text = process.env[name];
    const value = Number(text);
    return text !== undefined && text.trim() !== '' && Number.isFinite(value) ? value : fallback;
}

// Seconds the game server allows for one answer. With timers disabled the
// guide says 5 s applies, whatever moveTime says.
function limitSeconds(settings) {
    if (settings?.timerEnabled === false) return 5;
    const moveTime = settings?.moveTime;
    return Number.isFinite(moveTime) && moveTime > 0 ? moveTime : defaultOf('BOT_DEFAULT_MOVE_TIME', 5);
}

// When an answer is due: marginMs before the limit, so that the same time (TIME_MARGIN_MS) is always
// left for the network, in both games.
function answerByMs(limitMs, marginMs) {
    return Math.max(0, limitMs - marginMs);
}

function isNineArray(value) {
    return Array.isArray(value) && value.length === 9;
}

// Rebuild the simulator observation from the tournament request body. The
// payload omits status, winner, justProjected, decoherenceCounters and
// statistics. None is read before the rules recompute it, except the
// decoherence counters, which restart at zero here: exact only while
// decoherence is disabled (the default).
function payloadToObservation(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Payload must be an object');
    const turn = payload.currentTurn ?? payload.player;
    if (turn !== 'X' && turn !== 'O') throw new Error('Unknown player');
    if (!Array.isArray(payload.legalMoves) || payload.legalMoves.length === 0)
        throw new Error('No legal moves in payload');
    for (const key of ['board', 'probabilities', 'measuredSquares', 'emptySquares'])
        if (!isNineArray(payload[key])) throw new Error(`${key} must have 9 entries`);
    if (!payload.quantumState || typeof payload.quantumState !== 'object')
        throw new Error('quantumState missing');
    const given = payload.settings ?? {};
    const quantumness = given.quantumness ?? defaultOf('BOT_DEFAULT_QUANTUMNESS', 2);
    const decoherence = given.decoherence ?? defaultOf('BOT_DEFAULT_DECOHERENCE', 0);
    if (!Number.isInteger(quantumness) || quantumness < 0 || quantumness > 4)
        throw new Error('settings.quantumness must be an integer from 0 to 4');

    const state = structuredClone({
        roundNumber: turn === 'X' ? 1 : 2,
        status: 'ongoing',
        currentTurn: turn,
        winner: null,
        justProjected: false,
        quantumState: payload.quantumState,
        measuredSquares: payload.measuredSquares,
        emptySquares: payload.emptySquares,
        probabilities: payload.probabilities,
        pairs: payload.pairs ?? [null, null, null, null],
        squareToPair: payload.squareToPair ?? {},
        board: payload.board,
        decoherenceCounters: Array(9).fill(0),
        statistics: { numStates: 0, xWinCount: 0, oWinCount: 0, drawCount: 0, bothCount: 0,
            xWinProb: 0, oWinProb: 0, drawProb: 0, bothProb: 0 }
    });
    return { ...state, player: turn, ply: 0,
        // Timers count as enabled unless the request says otherwise, so the search gets the same limit
        // as the agent's guard (limitSeconds of the request).
        settings: { quantumness, decoherence, timerEnabled: given.timerEnabled !== false, moveTime: limitSeconds(given) },
        legalMoves: structuredClone(payload.legalMoves) };
}

module.exports = { payloadToObservation, fallbackMove, limitSeconds, answerByMs, same };

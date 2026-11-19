'use strict';
// One simulated TiqTaqToe move for the tree search, on the organizers' rules (rules/rules.js).
// The engine draws random numbers only when a move measures. They come from a generator seeded
// per simulated move, so a search with a given seed is reproducible.
const rules = require('./rules/rules');

const clone = value => JSON.parse(JSON.stringify(value));

// The same generator as TiqTaqToeEnvironment.random().
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// One simulated move from `state`; the parent is left untouched. randomCalls === 0 means this
// move from this state always has the same result.
function advance(settings, state, action, seed) {
    const next = clone(state);
    const random = Math.random;
    const draw = seededRandom(seed);
    let randomCalls = 0;
    Math.random = () => { randomCalls++; return draw(); };
    try {
        rules.doMove(settings, next, action, next.currentTurn, true);
    } finally {
        Math.random = random;
    }
    if (next.winner) next.status = 'completed';
    // The legality checker writes errorMessage while it tries candidates.
    const legalMoves = next.status === 'ongoing' ? rules.getAvailableMoves(settings, next) : [];
    delete next.errorMessage;
    return { state: next, legalMoves, randomCalls };
}

module.exports = { advance };

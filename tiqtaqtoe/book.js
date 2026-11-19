'use strict';
// Opening book: moves chosen from game results (DESIGN.md §2.1), looked up by
// position before any search. The key ignores representation details that differ between
// the simulator and the tournament payload: amplitudes are rounded and sorted by board,
// pairs lose their empty slots, and only the fields that define the position are used.
const fs = require('node:fs');
const { same } = require('./payload');

const round = v => Math.round(v * 1e6) / 1e6 + 0;     // + 0 turns -0 into 0
const swapMarks = text => text.replace(/[XO]/g, c => (c === 'X' ? 'O' : 'X'));
// mirrored: the same position with X and O exchanged (who is to move and every mark).
function bookKey(state, mirrored = false) {
    const name = mirrored ? swapMarks : s => s;
    const amplitudes = Object.entries(state.quantumState).map(([board, a]) => [name(board), round(a.real), round(a.imaginary)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const pairs = (state.pairs ?? []).filter(Boolean).map(p => [...p].sort((a, b) => a - b))
        .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    return JSON.stringify([name(state.currentTurn), amplitudes, state.measuredSquares.map(Boolean), pairs]);
}

function loadBook(file) {
    const book = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...book, byKey: new Map(book.entries.map(e => [e.key, e])) };
}

// The book move for this observation, or null: wrong settings, unknown position, or a move
// that is not legal here. A position is also found through its X<->O mirror: the rules are
// symmetric between the marks (same moves, mirrored states and Born probabilities), and the
// even rounds of a match start with O.
function lookup(book, observation) {
    const { quantumness, decoherence = 0 } = observation.settings ?? {};
    if (quantumness !== book.settings.quantumness || decoherence !== book.settings.decoherence) return null;
    for (const mirrored of [false, true]) {
        const entry = book.byKey.get(bookKey(observation, mirrored));
        const move = entry && observation.legalMoves.find(m => same(m, entry.move));
        if (move) return { move, entry, mirrored };
    }
    return null;
}

module.exports = { bookKey, loadBook, lookup };

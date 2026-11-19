'use strict';
// Quantum-state helpers for search. The board state is a superposition of classical
// boards (9-character strings over 0/X/O) with complex amplitudes; |amplitude|^2 is the
// probability of each board (Born rule). Superpositions are small, so these exact sums
// are cheap.

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const weight = amplitude => amplitude.real * amplitude.real + amplitude.imaginary * amplitude.imaginary;

// Exact probability that a move measuring squares produced `child` from `parent`: the
// Born weight of the parent boards that agree with the child on every square this move
// measured. Null when the move measured nothing (so its randomness is not a measurement).
function bornProbability(parent, child) {
    const measured = [];
    for (let i = 0; i < 9; i++) if (child.measuredSquares[i] && !parent.measuredSquares[i]) measured.push(i);
    if (!measured.length) return null;
    const outcome = Object.keys(child.quantumState)[0];
    let agree = 0, total = 0;
    for (const [board, amplitude] of Object.entries(parent.quantumState)) {
        const w = weight(amplitude);
        total += w;
        if (measured.every(i => board[i] === outcome[i])) agree += w;
    }
    return total > 0 ? agree / total : null;
}

// Line potential of one classical board: for each line still open to a side, the square of
// that side's marks on it, X positive and O negative.
function boardScore(board) {
    let score = 0;
    for (const line of LINES) {
        let x = 0, o = 0;
        for (const i of line) { if (board[i] === 'X') x++; else if (board[i] === 'O') o++; }
        if (!o) score += x * x;
        if (!x) score -= o * o;
    }
    return score;
}

// Per-world evaluation from X's point of view in [0, 1]: score every classical board in the
// superposition separately (keeping correlations between squares), weight by probability.
function worldsValue(state) {
    let total = 0, mass = 0;
    for (const [board, amplitude] of Object.entries(state.quantumState)) {
        const w = weight(amplitude);
        mass += w;
        total += w * boardScore(board);
    }
    return (Math.tanh((mass ? total / mass : 0) / 12) * 0.8 + 1) / 2;
}

module.exports = { bornProbability, worldsValue, boardScore };

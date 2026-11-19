'use strict';
// The rules part (sections 1-2) of the organizers' local-tiqtaqtoe-server.js, taken unchanged.
let QuantumEntity, Operations, EntanglementEngine, JointQuantumSystem;

async function initEngine() {
    const engine = await import('@quantumplayed/quantum-game-engine');
    QuantumEntity = engine.QuantumEntity;
    Operations = engine.Operations;
    EntanglementEngine = engine.EntanglementEngine;
    JointQuantumSystem = engine.JointQuantumSystem;
}


// ==========================================
// 1. Complex Number Math
// ==========================================
class Complex {
    constructor(real, imaginary) {
        this.real = real;
        this.imaginary = imaginary;
    }
}

const charToValue = { '0': 0, 'X': 1, 'O': 2 };
const valueToChar = { 0: '0', 1: 'X', 2: 'O' };

function boardStringToBasisIndex(boardStr) {
    let index = 0;
    for (let i = 0; i < 9; i++) {
        const val = charToValue[boardStr[i]] ?? 0;
        index = index * 3 + val;
    }
    return index;
}

function basisIndexToBoardString(index) {
    let chars = [];
    let temp = index;
    for (let i = 8; i >= 0; i--) {
        const val = temp % 3;
        chars[i] = valueToChar[val];
        temp = Math.floor(temp / 3);
    }
    return chars.join("");
}

function reconstructEngineState(quantumState) {
    const entities = Array.from({ length: 9 }, () => new QuantumEntity({ dimension: 3, initialState: 0 }));
    const jointAmplitudes = {};
    for (const [boardStr, amp] of Object.entries(quantumState)) {
        const idx = boardStringToBasisIndex(boardStr);
        jointAmplitudes[idx] = { re: amp.real, im: amp.imaginary };
    }
    return JointQuantumSystem.inject(entities, jointAmplitudes);
}

function serializeEngineState(system) {
    const newState = {};
    for (const [basisKStr, amp] of Object.entries(system.jointAmplitudes)) {
        const magnitudeSquared = amp.re * amp.re + amp.im * amp.im;
        if (magnitudeSquared >= 0.0001) {
            const boardStr = basisIndexToBoardString(parseInt(basisKStr));
            newState[boardStr] = new Complex(amp.re, amp.im);
        }
    }
    return newState;
}

// ==========================================
// 2. TiqTaqToe Game Constants & Rules
// ==========================================
const TicTacToken = { EMPTY: 0, X: 1, O: 2 };
const TicTacResult = { UNFINISHED: 0, X: 1, O: 2, BOTH: 3, DRAW: 4 };
const TicTacRules = { CLASSICAL: 0, QUANTUM_V1: 1, QUANTUM_V2: 2, QUANTUM_V3: 3, QUANTUM_V4: 4 };

const _POSSIBLE_WINS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
];

function deriveEntanglements(quantumState, previousPairs = []) {
    const marginals = Array.from({ length: 9 }, () => ({ '0': 0, 'X': 0, 'O': 0 }));
    let totalAmpSquared = 0;

    for (const amp of Object.values(quantumState)) {
        totalAmpSquared += amp.real * amp.real + amp.imaginary * amp.imaginary;
    }
    if (totalAmpSquared === 0) totalAmpSquared = 1;

    for (const [boardStr, amp] of Object.entries(quantumState)) {
        const prob = (amp.real * amp.real + amp.imaginary * amp.imaginary) / totalAmpSquared;
        for (let i = 0; i < 9; i++) {
            const char = boardStr[i];
            if (marginals[i][char] !== undefined) {
                marginals[i][char] += prob;
            }
        }
    }

    const adj = Array.from({ length: 9 }, () => []);

    for (let i = 0; i < 9; i++) {
        for (let j = i + 1; j < 9; j++) {
            const joint = {
                '00': 0, '0X': 0, '0O': 0,
                'X0': 0, 'XX': 0, 'XO': 0,
                'O0': 0, 'OX': 0, 'OO': 0
            };
            for (const [boardStr, amp] of Object.entries(quantumState)) {
                const prob = (amp.real * amp.real + amp.imaginary * amp.imaginary) / totalAmpSquared;
                const key = boardStr[i] + boardStr[j];
                if (joint[key] !== undefined) {
                    joint[key] += prob;
                }
            }

            let isDependent = false;
            for (const x of ['0', 'X', 'O']) {
                for (const y of ['0', 'X', 'O']) {
                    const pJoint = joint[x + y];
                    const pMarginalProduct = marginals[i][x] * marginals[j][y];
                    if (Math.abs(pJoint - pMarginalProduct) > 0.01) {
                        isDependent = true;
                        break;
                    }
                }
                if (isDependent) break;
            }

            if (isDependent) {
                adj[i].push(j);
                adj[j].push(i);
            }
        }
    }

    const visited = Array(9).fill(false);
    const rawComponents = [];

    for (let i = 0; i < 9; i++) {
        if (!visited[i]) {
            const component = [];
            const queue = [i];
            visited[i] = true;

            while (queue.length > 0) {
                const curr = queue.shift();
                component.push(curr);
                for (const neighbor of adj[curr]) {
                    if (!visited[neighbor]) {
                        visited[neighbor] = true;
                        queue.push(neighbor);
                    }
                }
            }

            if (component.length >= 2) {
                component.sort((a, b) => a - b);
                rawComponents.push(component);
            }
        }
    }

    // Assign rawComponents to persistent slots based on previousPairs
    const pairs = Array(4).fill(null);
    const assignedSlots = new Set();
    const componentToSlot = [];

    // 1. Inherit slots from previous pairs if there is overlap
    for (const comp of rawComponents) {
        let bestSlot = -1;
        let maxOverlap = 0;

        for (let slot = 0; slot < previousPairs.length; slot++) {
            const prevComp = previousPairs[slot];
            if (prevComp && !assignedSlots.has(slot)) {
                const overlap = comp.filter(x => prevComp.includes(x)).length;
                if (overlap > maxOverlap) {
                    maxOverlap = overlap;
                    bestSlot = slot;
                }
            }
        }

        if (bestSlot !== -1) {
            componentToSlot.push({ component: comp, slot: bestSlot });
            assignedSlots.add(bestSlot);
        } else {
            componentToSlot.push({ component: comp, slot: null });
        }
    }

    // 2. Assign remaining components to first vacant slot
    for (const item of componentToSlot) {
        if (item.slot === null) {
            let slot = 0;
            while (assignedSlots.has(slot)) {
                slot++;
            }
            item.slot = slot;
            assignedSlots.add(slot);
        }
    }

    // 3. Build the mapping and pairs array
    const squareToPair = {};
    for (const item of componentToSlot) {
        pairs[item.slot] = item.component;
        for (const idx of item.component) {
            squareToPair[idx] = item.slot;
        }
    }

    return { pairs, squareToPair };
}

const isEmpty = (roundState, square) => roundState.emptySquares[parseInt(square)];
const computeIsEmpty = (quantumState, square) => Object.keys(quantumState).every(s => s[square] === '0');
const isBoardFull = (roundState) => roundState.emptySquares.every(s => !s);
const near = (a, b) => Math.abs(a - b) < 0.01;

function winner(classicalState, measuredSquares) {
    let xWinLines = 0;
    let oWinLines = 0;
    for (let check of _POSSIBLE_WINS) {
        if (check.every(idx => classicalState[idx] === 'X' && measuredSquares[idx])) xWinLines++;
        if (check.every(idx => classicalState[idx] === 'O' && measuredSquares[idx])) oWinLines++;
    }
    if (xWinLines > oWinLines && xWinLines > 0) return TicTacResult.X;
    if (oWinLines > xWinLines && oWinLines > 0) return TicTacResult.O;
    if (xWinLines > 0 && oWinLines > 0 && xWinLines === oWinLines) return TicTacResult.BOTH;
    if (xWinLines === 0 && oWinLines === 0) {
        if (classicalState.includes('0')) return TicTacResult.UNFINISHED;
        return TicTacResult.DRAW;
    }
    return TicTacResult.UNFINISHED;
}

function computeSquareProbabilities(roundState) {
    let allStates = Object.keys(roundState.quantumState);
    let allProbabilities = Object.values(roundState.quantumState).map(p => p.real * p.real + p.imaginary * p.imaginary);
    let probabilities = Array.from({ length: 9 }, () => [0, 0, 0]);

    for (let i = 0; i < allStates.length; i++) {
        let state = allStates[i];
        let probability = allProbabilities[i];
        for (let j = 0; j < 9; j++) {
            if (state[j] === '0') probabilities[j][0] += probability;
            else if (state[j] === 'X') probabilities[j][1] += probability;
            else if (state[j] === 'O') probabilities[j][2] += probability;
        }
    }
    return probabilities;
}

function resolveDeterministicSquares(roundState) {
    for (let i = 0; i < 9; i++) {
        if (!roundState.emptySquares[i]) {
            let p = roundState.probabilities[i];
            if (near(p[1], 1) || near(p[2], 1)) {
                roundState.measuredSquares[i] = true;
            }
        }
    }
}

const UI_STATES = [
    { name: null, p: [1, 0, 0] },
    { name: 'X', p: [0, 1, 0] },
    { name: 'O', p: [0, 0, 1] },
    { name: 'half-x', p: [0.5, 0.5, 0] },
    { name: 'half-o', p: [0.5, 0, 0.5] },
    { name: 'xo', p: [0, 0.5, 0.5] },
    { name: 'exO', p: [0.25, 0.25, 0.5] },
    { name: 'eXo', p: [0.25, 0.5, 0.25] },
    { name: 'eX', p: [0.25, 0.75, 0] },
    { name: 'eO', p: [0.25, 0, 0.75] }
];

function getClosestUiState(p) {
    let bestState = UI_STATES[0];
    let minDistance = Infinity;
    for (const state of UI_STATES) {
        const dist = Math.abs(p[0] - state.p[0]) + Math.abs(p[1] - state.p[1]) + Math.abs(p[2] - state.p[2]);
        if (dist < minDistance) {
            minDistance = dist;
            bestState = state;
        }
    }
    return bestState.name;
}

function computeBoard(roundState) {
    let board = Array.from({ length: 9 }, () => null);
    for (let i = 0; i < 9; i++) {
        let p = roundState.probabilities[i];
        board[i] = getClosestUiState(p);

        if (board[i] !== null) {
            let pairIndex = roundState.squareToPair[i];
            if (pairIndex !== undefined) {
                let pair = roundState.pairs[pairIndex];
                if (pair) {
                    let positionInPair = pair.indexOf(i);
                    if (positionInPair !== -1) {
                        board[i] += (positionInPair + 1);
                    }
                }
            }
        }
    }
    return board;
}

function computeManyWorldStatistics(roundState) {
    let allStates = Object.keys(roundState.quantumState);
    let allProbabilities = Object.values(roundState.quantumState).map(p => p.real * p.real + p.imaginary * p.imaginary);
    let statistics = {
        'numStates': allStates.length,
        'xWinCount': 0, 'oWinCount': 0, 'drawCount': 0, 'bothCount': 0,
        'xWinProb': 0, 'oWinProb': 0, 'drawProb': 0, 'bothProb': 0
    };
    for (let i = 0; i < allStates.length; i++) {
        let state = allStates[i];
        let w = winner(state, Array(9).fill(true));
        if (w == TicTacResult.X) { statistics.xWinCount++; statistics.xWinProb += allProbabilities[i]; }
        else if (w == TicTacResult.O) { statistics.oWinCount++; statistics.oWinProb += allProbabilities[i]; }
        else if (w == TicTacResult.BOTH) { statistics.bothCount++; statistics.bothProb += allProbabilities[i]; }
        else if (w == TicTacResult.DRAW) { statistics.drawCount++; statistics.drawProb += allProbabilities[i]; }
    }
    return statistics;
}

function result(roundState) {
    return winner(Object.keys(roundState.quantumState)[0], roundState.measuredSquares);
}

function isLegalMove(move, settings, roundState) {
    if (move.length === 2 && (move[1] === 'M' || move[1] === 'measure')) {
        let square = parseInt(move[0]);
        if (isNaN(square) || square < 0 || square > 8) {
            roundState.errorMessage = "Invalid square index.";
            return false;
        }
        if (isEmpty(roundState, square)) {
            roundState.errorMessage = "Cannot measure an empty square.";
            return false;
        }
        if (roundState.measuredSquares[square]) {
            roundState.errorMessage = "Square is already measured.";
            return false;
        }
        roundState.errorMessage = "";
        return true;
    }

    if (move.length === 1) {
        if (!roundState.emptySquares[parseInt(move[0])]) {
            roundState.errorMessage = "Square is not empty.";
            return false;
        }
    } else if (move.length === 2) {
        let [square1, square2] = move.map(Number);
        if (settings.quantumness === TicTacRules.CLASSICAL) {
            if (square1 !== square2) {
                roundState.errorMessage = "Quantum moves are not available in classical TTT.";
                return false;
            }
        }
        if (roundState.measuredSquares[square1] || roundState.measuredSquares[square2]) {
            roundState.errorMessage = "Cannot make a quantum move involving a measured square.";
            return false;
        }
        if (isEmpty(roundState, square1) && isEmpty(roundState, square2)) {
            if (settings.quantumness === TicTacRules.CLASSICAL) {
                if (square1 !== square2) {
                    roundState.errorMessage = "Quantum moves are not available in classical TTT.";
                    return false;
                }
            }
        }
        if (!isEmpty(roundState, square1) && !isEmpty(roundState, square2)) {
            if (settings.quantumness < TicTacRules.QUANTUM_V4) {
                roundState.errorMessage = "This move is only allowed at the highest quantumness level.";
                return false;
            }
            if (near(roundState.probabilities[square1][roundState.currentTurn === 'X' ? 1 : 2], 0)) {
                roundState.errorMessage = "Phase moves must have your own tokens.";
                return false;
            }
            if (roundState.squareToPair[square1] !== roundState.squareToPair[square2]) {
                roundState.errorMessage = "Phase moves must involve the same pair.";
                return false;
            }
        }
        if ((isEmpty(roundState, square1) && !isEmpty(roundState, square2)) || (!isEmpty(roundState, square1) && isEmpty(roundState, square2))) {
            if (settings.quantumness < TicTacRules.QUANTUM_V2) {
                roundState.errorMessage = "Entangling moves are only allowed at quantumness level 2 or higher.";
                return false;
            }
            let emptySquare = isEmpty(roundState, square1) ? square1 : square2;
            let nonEmptySquare = emptySquare == square1 ? square2 : square1;
            if (!near(roundState.probabilities[nonEmptySquare][roundState.currentTurn === 'X' ? 1 : 2], 0)) {
                roundState.errorMessage = "You can't entangle with your own token.";
                return false;
            }
            if (!near(roundState.probabilities[nonEmptySquare][roundState.currentTurn === 'X' ? 2 : 1], 1)) {
                if (settings.quantumness < TicTacRules.QUANTUM_V3) {
                    roundState.errorMessage = "Entangling with a non-full square is only allowed at level 3 or higher.";
                    return false;
                }
            }
        }
    } else {
        roundState.errorMessage = "Select one or maximally two squares.";
        return false;
    }
    roundState.errorMessage = "";
    return true;
}

function getAvailableMoves(settings, roundState) {
    const moves = [];
    for (let i = 0; i < 9; i++) {
        if (isLegalMove([i], settings, roundState)) moves.push([i]);
    }
    if (settings.quantumness > 0) {
        for (let i = 0; i < 9; i++) {
            for (let j = i + 1; j < 9; j++) {
                if (isLegalMove([i, j], settings, roundState)) moves.push([i, j]);
            }
        }
    }
    // Long-press measure moves (represented as [i, 'M'])
    for (let i = 0; i < 9; i++) {
        if (isLegalMove([i, 'M'], settings, roundState)) {
            moves.push([i, 'M']);
        }
    }
    return moves;
}

function doClassicalMove(targetIndex, token, roundState, measureImmediately = false) {
    const system = reconstructEngineState(roundState.quantumState);
    const val = token === 'X' ? 1 : 2;
    system.applyLocal(targetIndex, Operations.Shift(val));
    roundState.quantumState = serializeEngineState(system);

    roundState.emptySquares[parseInt(targetIndex)] = false;
    if (measureImmediately) {
        roundState.measuredSquares[targetIndex] = true;
    }
    const derived = deriveEntanglements(roundState.quantumState, roundState.pairs);
    roundState.pairs = derived.pairs;
    roundState.squareToPair = derived.squareToPair;
}

function doQuantumMove(square1, square2, token, roundState) {
    square1 = parseInt(square1);
    square2 = parseInt(square2);
    const val = token === 'X' ? 1 : 2;
    const system = reconstructEngineState(roundState.quantumState);

    if (isEmpty(roundState, square1) && isEmpty(roundState, square2)) {
        system.applyLocal(square1, Operations.Shift(val));
        EntanglementEngine.interactMany([system.entities[square1], system.entities[square2]], Operations.SqrtSwap());
    } else if ((!isEmpty(roundState, square1) && isEmpty(roundState, square2)) || (isEmpty(roundState, square1) && !isEmpty(roundState, square2))) {
        let emptySquare = isEmpty(roundState, square1) ? square1 : square2;
        let nonEmptySquare = emptySquare == square1 ? square2 : square1;
        system.applyLocal(emptySquare, Operations.Shift(val));
        EntanglementEngine.interactMany([system.entities[nonEmptySquare], system.entities[emptySquare]], Operations.SqrtSwap());
    } else {
        EntanglementEngine.interactMany([system.entities[square1], system.entities[square2]], Operations.SqrtSwap());
    }

    roundState.quantumState = serializeEngineState(system);
    for (let i = 0; i < 9; i++) {
        roundState.emptySquares[i] = computeIsEmpty(roundState.quantumState, i);
    }
    const derived = deriveEntanglements(roundState.quantumState, roundState.pairs);
    roundState.pairs = derived.pairs;
    roundState.squareToPair = derived.squareToPair;
}

function measureSquares(roundState, squaresToMeasure) {
    const system = reconstructEngineState(roundState.quantumState);
    for (const idx of squaresToMeasure) {
        system.measureTarget(system.entities[idx]);
    }
    roundState.quantumState = serializeEngineState(system);

    squaresToMeasure.forEach(idx => {
        roundState.measuredSquares[idx] = true;
    });

    for (let i = 0; i < 9; i++) {
        roundState.emptySquares[i] = computeIsEmpty(roundState.quantumState, i);
        if (roundState.emptySquares[i]) {
            roundState.measuredSquares[i] = false;
        }
    }

    const derived = deriveEntanglements(roundState.quantumState, roundState.pairs);
    roundState.pairs = derived.pairs;
    roundState.squareToPair = derived.squareToPair;

    roundState.winner = result(roundState);
    roundState.statistics = computeManyWorldStatistics(roundState);
    roundState.probabilities = computeSquareProbabilities(roundState);
    roundState.board = computeBoard(roundState);
}

function computeDecoherence(roundState, decoherenceLimit, touchedSquares = []) {
    if (decoherenceLimit <= 0) return false;
    if (!roundState.decoherenceCounters) {
        roundState.decoherenceCounters = Array(9).fill(0);
    }
    touchedSquares.forEach(idx => {
        roundState.decoherenceCounters[idx] = 0;
    });

    let squaresToDecohere = [];
    for (let i = 0; i < 9; i++) {
        if (!roundState.measuredSquares[i] && !roundState.emptySquares[i]) {
            if (!touchedSquares.includes(i)) {
                roundState.decoherenceCounters[i]++;
            }
            if (roundState.decoherenceCounters[i] >= decoherenceLimit) {
                squaresToDecohere.push(i);
            }
        }
    }

    if (squaresToDecohere.length > 0) {
        let uniqueSquaresToMeasure = [...squaresToDecohere];
        squaresToDecohere.forEach(sq => {
            let pairIndex = roundState.squareToPair[sq];
            if (pairIndex !== undefined && roundState.pairs[pairIndex]) {
                roundState.pairs[pairIndex].forEach(idx => {
                    if (!uniqueSquaresToMeasure.includes(idx) && !roundState.measuredSquares[idx]) {
                        uniqueSquaresToMeasure.push(idx);
                    }
                });
            }
        });
        measureSquares(roundState, uniqueSquaresToMeasure);
        uniqueSquaresToMeasure.forEach(idx => {
            roundState.decoherenceCounters[idx] = 0;
        });
        return true;
    }
    return false;
}

function doMove(settings, roundState, move, token, project) {
    if (!isLegalMove(move, settings, roundState)) {
        throw new Error(roundState.errorMessage);
    }

    let measureImmediately = (settings.quantumness === TicTacRules.CLASSICAL || settings.quantumness === TicTacRules.QUANTUM_V1);
    if (move.length === 1) {
        doClassicalMove(parseInt(move[0]), token, roundState, measureImmediately);
    } else if (move.length === 2) {
        if (move[1] === 'M' || move[1] === 'measure') {
            let squareIndex = parseInt(move[0]);
            let squaresToMeasure = [squareIndex];
            let pairIndex = roundState.squareToPair[squareIndex];
            if (pairIndex !== undefined && roundState.pairs[pairIndex]) {
                roundState.pairs[pairIndex].forEach(idx => {
                    if (idx !== squareIndex && !roundState.measuredSquares[idx]) squaresToMeasure.push(idx);
                });
            }
            measureSquares(roundState, squaresToMeasure);
        } else {
            let sq1 = parseInt(move[0]);
            let sq2 = parseInt(move[1]);
            if (sq1 === sq2) doClassicalMove(sq1, token, roundState, measureImmediately);
            else doQuantumMove(sq1, sq2, token, roundState);
        }
    }

    roundState.justProjected = false;
    const hasUnmeasuredSquares = roundState.measuredSquares.some((m, i) => !m && !roundState.emptySquares[i]);
    if (isBoardFull(roundState) && project && hasUnmeasuredSquares) {
        resolveDeterministicSquares(roundState);
        for (let i = 0; i < 9; i++) {
            if (!roundState.measuredSquares[i] && !roundState.emptySquares[i]) {
                let squaresToMeasure = [i];
                let pairIndex = roundState.squareToPair[i];
                if (pairIndex !== undefined && roundState.pairs[pairIndex]) {
                    roundState.pairs[pairIndex].forEach(idx => {
                        if (idx !== i && !roundState.measuredSquares[idx]) squaresToMeasure.push(idx);
                    });
                }
                measureSquares(roundState, squaresToMeasure);
            }
        }
        roundState.statistics = computeManyWorldStatistics(roundState);
        roundState.probabilities = computeSquareProbabilities(roundState);
        roundState.board = computeBoard(roundState);
        roundState.winner = result(roundState);
        roundState.justProjected = true;
        roundState.currentTurn = roundState.currentTurn === 'X' ? 'O' : 'X';
        return;
    }

    roundState.statistics = computeManyWorldStatistics(roundState);
    roundState.probabilities = computeSquareProbabilities(roundState);
    roundState.board = computeBoard(roundState);

    let decohered = false;
    if (settings.decoherence > 0) {
        const touchedSquares = move.filter(m => typeof m === 'number' || !isNaN(parseInt(m))).map(m => parseInt(m));
        decohered = computeDecoherence(roundState, settings.decoherence, touchedSquares);
        if (decohered) {
            roundState.statistics = computeManyWorldStatistics(roundState);
            roundState.probabilities = computeSquareProbabilities(roundState);
            roundState.board = computeBoard(roundState);
            roundState.winner = result(roundState);
            roundState.justProjected = true;
            roundState.currentTurn = roundState.currentTurn === 'X' ? 'O' : 'X';
            return;
        }
    }

    roundState.winner = result(roundState);
    roundState.currentTurn = roundState.currentTurn === 'X' ? 'O' : 'X';
}

function createFreshRound(roundNumber) {
    return {
        roundNumber: roundNumber,
        status: 'ongoing',
        currentTurn: roundNumber % 2 === 1 ? 'X' : 'O',
        winner: null,
        justProjected: false,
        quantumState: { '000000000': new Complex(1, 0) },
        measuredSquares: Array(9).fill(false),
        emptySquares: Array(9).fill(true),
        probabilities: Array(9).fill([1, 0, 0]),
        pairs: [null, null, null, null],
        squareToPair: {},
        board: Array(9).fill(null),
        decoherenceCounters: Array(9).fill(0),
        statistics: {
            'numStates': 1,
            'xWinCount': 0, 'oWinCount': 0, 'drawCount': 0, 'bothCount': 0,
            'xWinProb': 0, 'oWinProb': 0, 'drawProb': 0, 'bothProb': 0
        }
    };
}


module.exports = { initEngine, createFreshRound, getAvailableMoves, doMove, TicTacResult };

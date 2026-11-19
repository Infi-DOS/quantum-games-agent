/**
 * Cheqqers positions between the tournament request and the organizers' game object
 * (rules/game.generated.mjs).
 *
 *   requestOf(game)   the request the tournament server sends for this position (as local-cheqqers-server.js)
 *   fromRequest(req)  a CheqqersGame rebuilt from a request: board, pieces and every quantum system's
 *                     amplitudes exactly; hidden counters (draw rules) start at zero. `exact` is true
 *                     when the rebuilt game generates exactly the request's legalMoves, the condition
 *                     for searching from it.
 */
import { initEngine, CheqqersGame, PieceColor, GameType, SquareState, moveToArray, serializeBoardState, engine } from './rules/game.generated.mjs';

let loaded = null;
export const ready = () => (loaded ??= initEngine());
export { CheqqersGame, PieceColor, GameType, SquareState, moveToArray };

// The engine catches errors inside applyMove (QuantumLimitExceeded when a split would build a joint
// system above 32,768 dimensions), logs "Move application error" and leaves the move half applied with
// the same player on turn. applyChecked reports such an error instead of logging it.
let moveError = null;
const consoleError = console.error;
console.error = (...args) => { if (args[0] === 'Move application error') moveError = args[1] ?? true; else consoleError(...args); };

/** Apply `move`; returns the number of measurements and the engine's error, if any (then discard the game). */
export function applyChecked(game, move) {
    moveError = null;
    const measured = game.applyMove(move);
    const error = moveError;
    moveError = null;
    return { measured, error };
}

/** 'take', 'split', 'merge' or 'move': the kind a move array alone does not tell for three squares. */
export const kindOf = move => (move.is_take_move ? 'take' : 'to_index1' in move ? 'split' : 'from_index1' in move ? 'merge' : 'move');

export function requestOf(game, timeout = 3000) {
    const state = game.toGameStateObject();
    const color = game.turn === PieceColor.WHITE ? 'white' : 'black';
    return { gameId: 'local', roundId: 'local', player: color, currentTurn: color, board: serializeBoardState(state),
        quantumStates: state.quantum_states, settings: { boardSize: game.boardSize, quantumness: game.gameType, timeout },
        legalMoves: state.possible_moves.map(moveToArray) };
}

const key = m => JSON.stringify(m);
const sameMoves = (a, b) => a.length === b.length && new Set(a.map(key)).size === new Set([...a, ...b].map(key)).size;
const stateIndex = s => (s === 'E' ? SquareState.EMPTY : SquareState.OCCUPIED);

/**
 * The board size: the request's; else read off the board, since a board of size n has n*n/2 playable
 * squares; else the agent's default (.env CHEQQERS_DEFAULT_BOARD_SIZE).
 */
export function boardSizeOf(request) {
    const given = Number(request.settings?.boardSize);
    if (Number.isInteger(given) && given > 0) return given;
    const squares = Array.isArray(request.board) ? request.board.length : 0;
    const side = Math.round(Math.sqrt(2 * squares));
    if (squares > 0 && side * side === 2 * squares) return side;
    return Number(process.env.CHEQQERS_DEFAULT_BOARD_SIZE ?? 6);
}

export function fromRequest(request) {
    const { JointQuantumSystem } = engine();
    // The quantumness: the request's, else the agent's default (.env CHEQQERS_DEFAULT_QUANTUMNESS).
    const size = boardSizeOf(request);
    const level = Number(request.settings?.quantumness ?? process.env.CHEQQERS_DEFAULT_QUANTUMNESS ?? GameType.ENTANGLEMENT);
    const game = new CheqqersGame(size, 0, level);
    game.turn = request.player === 'white' ? PieceColor.WHITE : PieceColor.BLACK;
    const board = request.board, systems = request.quantumStates || [];

    // Pieces: the parts of one split piece share an id (same colour within one quantum system).
    let nextId = 1;
    const ids = new Map();
    for (const sys of systems) for (const i of sys.squares) {
        const cell = board[i];
        if (cell?.piece) { const k = `${systems.indexOf(sys)}:${cell.piece}`; if (!ids.has(k)) ids.set(k, nextId++); }
    }
    for (let i = 0; i < board.length; i++) {
        const cell = board[i];
        if (!cell?.piece) { game.pieceProperties[i] = null; continue; }
        const sys = systems.findIndex(s => s.squares.includes(i));
        const id = sys >= 0 ? ids.get(`${sys}:${cell.piece}`) : nextId++;
        game.pieceProperties[i] = { color: cell.piece === 'white' ? PieceColor.WHITE : PieceColor.BLACK, crowned: !!cell.crowned, pieceIds: [id] };
    }
    game.nextPieceId = nextId;

    // Quantum state: classical squares, single-square superpositions, entangled systems.
    const inSystem = new Set(systems.flatMap(s => s.squares));
    for (let i = 0; i < board.length; i++) {
        if (!inSystem.has(i) && board[i]?.piece && board[i].probability > 0) game.squares[i].amplitudes = { [SquareState.OCCUPIED]: { re: 1, im: 0 } };
    }
    for (const sys of systems) {
        const amps = {};
        if (sys.type === 'entangled') {
            const joint = JointQuantumSystem.create(sys.squares.map(i => game.squares[i]));
            for (const a of sys.amplitudes) amps[joint.composeState(a.state.split('⊗').map(stateIndex))] = { re: a.re, im: a.im };
            joint.jointAmplitudes = amps;
        } else {
            for (const a of sys.amplitudes) amps[stateIndex(a.state)] = { re: a.re, im: a.im };
            game.squares[sys.squares[0]].amplitudes = amps;
        }
    }

    // A multi-jump in progress shows as jumps from one square only.
    const legal = (request.legalMoves || []).filter(Array.isArray);
    let generated = game.getPossibleMoves().map(moveToArray);
    if (!sameMoves(generated, legal) && legal.length && legal.every(m => m.length === 2 && m[0] === legal[0][0])) {
        game.multiJumpSquare = legal[0][0];
        generated = game.getPossibleMoves().map(moveToArray);
    }
    return { game, exact: sameMoves(generated, legal), generated: generated.length, legal: legal.length };
}

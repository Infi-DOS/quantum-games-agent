/**
 * The Cheqqers search (DESIGN.md §3.2): open-loop Monte Carlo tree search on the organizers' game
 * object. Measurements are sampled by the engine as in a real game, so a tree node's statistics average
 * over collapse outcomes; the legal moves can differ between simulations, and statistics are kept per
 * move. Simulations stop at a new node or `maxDepth` plies and are scored by `evaluate` (terminal
 * results; otherwise material weighted by occupancy probability). The player to move comes from the
 * game at every step (a multi-jump keeps the same player on turn).
 */
import { ready, fromRequest, moveToArray, PieceColor, applyChecked } from './state.mjs';
import { GameState } from './rules/game.generated.mjs';

const WHITE = PieceColor.WHITE;
const keyOf = m => moveToArray(m).join(',');

/** Probability-like value of the position for white, in [0, 1]. */
export function whiteValue(game, { king = 1.6, scale = 2.5 } = {}) {
    if (game.state === GameState.WHITE_WON) return 1;
    if (game.state === GameState.BLACK_WON) return 0;
    if (game.state === GameState.DRAW) return 0.5;
    let white = 0, black = 0;
    for (let i = 0; i < game.squares.length; i++) {
        const piece = game.pieceProperties[i];
        if (!piece) continue;
        const occupied = game.squares[i].getProbabilities()[1] || 0;
        const worth = occupied * (piece.crowned ? king : 1);
        if (piece.color === WHITE) white += worth; else black += worth;
    }
    return 0.5 + 0.5 * Math.tanh(scale * (white - black) / Math.max(1, white + black));
}

class Node {
    constructor() { this.n = 0; this.w = 0; this.children = new Map(); }
}

/**
 * Visits and mean values of the root's moves after searching until `deadline` (ms since epoch) or
 * `limit` simulations, whichever comes first (a limit alone makes a seeded search reproducible).
 */
export function search(rootGame, { limit = Infinity, deadline = limit < Infinity ? Infinity : undefined, maxDepth = 8, c = 0.9,
    random = Math.random, evaluate = whiteValue } = {}) {
    const root = new Node();
    let simulations = 0;
    // A move the engine fails to apply (see applyChecked) leaves the same player on turn, so the server
    // would ask again: never choose one at the root unless every move fails.
    let rootMoves = rootGame.getPossibleMoves();
    const working = rootMoves.filter(m => !applyChecked(rootGame.clone(), m).error);
    if (working.length) rootMoves = working;
    if (rootMoves.length === 1) return { simulations, stats: [{ move: moveToArray(rootMoves[0]), n: 1, value: null }] };
    do {
        const game = rootGame.clone();
        let node = root;
        const path = [];
        let failed = null;                             // the player whose move the engine failed to apply
        for (let depth = 0; depth < maxDepth && game.state === GameState.IN_PROGRESS; depth++) {
            const moves = depth === 0 ? rootMoves : game.getPossibleMoves();
            if (!moves.length) break;
            const mover = game.turn, fresh = [];
            let best = -1, bestScore = -Infinity;
            for (let i = 0; i < moves.length; i++) {
                const child = node.children.get(keyOf(moves[i]));
                if (!child || child.n === 0) { fresh.push(i); continue; }
                const score = child.w / child.n + c * Math.sqrt(Math.log(node.n + 1) / child.n);
                if (score > bestScore) { bestScore = score; best = i; }
            }
            // An untried move is tried first, picked at random; otherwise the best UCT score.
            const expand = fresh.length > 0;
            const pick = expand ? fresh[Math.floor(random() * fresh.length)] : best;
            const key = keyOf(moves[pick]);
            let child = node.children.get(key);
            if (!child) { child = new Node(); node.children.set(key, child); }
            const { error } = applyChecked(game, moves[pick]);   // moves are plain data (indices), valid on the clone
            path.push({ node: child, mover });
            node = child;
            if (error) { failed = mover; break; }
            if (expand) break;
        }
        const white = failed === null ? evaluate(game) : failed === WHITE ? 0 : 1;   // a failed move scores as a loss
        root.n++;
        for (const { node: n, mover } of path) { n.n++; n.w += mover === WHITE ? white : 1 - white; }
        simulations++;
    } while (simulations < limit && Date.now() < deadline);
    const stats = rootMoves.map(m => {
        const child = root.children.get(keyOf(m));
        return { move: moveToArray(m), n: child?.n ?? 0, value: child?.n ? child.w / child.n : null };
    }).sort((a, b) => b.n - a.n || (b.value ?? 0) - (a.value ?? 0));
    return { simulations, stats };
}

/**
 * The Cheqqers strategy: rebuild the position, search until 0.2 s before `budgetMs` runs out, answer the
 * most visited move. `options` are search()'s (maxDepth, c). A position that cannot be rebuilt exactly
 * gets null, and safeMove then answers a random legal move. Hidden state such as piece identities can
 * make the rebuilt game disagree with the server about a forced capture.
 */
export async function searchStrategy(request, { budgetMs = 2400, ...options } = {}) {
    const started = Date.now();
    await ready();
    const { game, exact } = fromRequest(request);
    if (!exact) return null;
    const { stats } = search(game, { deadline: started + Math.max(50, budgetMs - 200), ...options });
    return stats[0].move;
}

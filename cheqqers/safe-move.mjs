/**
 * The Cheqqers answer that can never forfeit (DESIGN.md §4). A forfeit is a timeout, an illegal move,
 * a bad response or an error status, so the answer is always a move from the request's own
 * legalMoves, sent within the budget: the strategy's move if it comes in time and is legal, otherwise
 * a random legal move. Never throws.
 *
 *   const { move, source } = await safeMove(request, pool.strategy, { budgetMs });
 */
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

export function legalMovesOf(request) {
    const moves = Array.isArray(request?.legalMoves) ? request.legalMoves : [];
    return moves.filter(m => Array.isArray(m) && m.length >= 2 && m.every(Number.isInteger));
}

/**
 * The move to send: the strategy's, if it answers within `budgetMs` with a move from legalMoves;
 * otherwise a random legal move. `budgetMs` defaults to the request's timeout minus TIME_MARGIN_MS.
 */
export async function safeMove(request, strategy, { budgetMs, random = Math.random } = {}) {
    const legal = legalMovesOf(request);
    if (!legal.length) return { move: [], source: 'no legal moves' };
    const timeout = Number(request?.settings?.timeout) || Number(process.env.CHEQQERS_DEFAULT_TIMEOUT_MS) || 3000;
    const budget = Math.max(50, budgetMs ?? timeout - Number(process.env.TIME_MARGIN_MS ?? 500));
    const fallback = () => legal[Math.floor(random() * legal.length)];
    let timer;
    try {
        const late = new Promise(resolve => { timer = setTimeout(() => resolve({ late: true }), budget); });
        const answer = await Promise.race([Promise.resolve().then(() => strategy(request, { budgetMs: budget, random })), late]);
        if (answer && answer.late) return { move: fallback(), source: 'fallback: late' };
        const move = legal.find(m => same(m, answer));
        return move ? { move, source: 'strategy' } : { move: fallback(), source: 'fallback: not a legal move' };
    } catch (error) {
        return { move: fallback(), source: `fallback: ${error.message}` };
    } finally {
        clearTimeout(timer);
    }
}

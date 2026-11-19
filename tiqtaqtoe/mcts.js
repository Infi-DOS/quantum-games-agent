'use strict';
// Monte Carlo tree search over the organizers' rules (DESIGN.md §2.2–2.4).
//
// Each iteration walks the tree, adds one move, scores the new position and backs the score up
// the path. A position is scored by the per-world evaluation (quantum.js): every classical board
// in the superposition is scored, and the scores are averaged with their Born weights.
//
// Chance: a move that measures can lead to several boards. Every edge keeps one child per
// resulting board (keyed by the full public state). Outcomes are discovered by simulation, but
// each one is weighted by its exact Born probability from the parent's amplitudes. Once the
// discovered outcomes cover the probability mass, visits are spread in proportion to probability
// and the move's value is the probability-weighted mean of its outcomes, with no sampling noise.
// A move whose randomness is not a measurement keeps sampled outcomes. Moves that draw no random
// numbers are deterministic: their single child is reused without simulating again.
//
// The search runs as a forest (forestSearch): many independent small trees, one after another
// until the deadline, merged at the root. A single tree that grows deeper amplifies the biases of
// the evaluation (DESIGN.md §2.2).
//
// Values are from X's point of view in [0, 1]: X win 1, O win 0, draw `drawValue`, both-win
// `bothValue`. Reported `values` are on a fixed-X scale [-1, 1].
const { TiqTaqToeEnvironment: Env } = require('./rules/environment');
const { advance } = require('./simulate');
const { bornProbability, worldsValue } = require('./quantum');
const { ValuePolicyNetwork } = require('./network');

const networks = new Map();          // network file -> loaded network, once per thread
const loadNetwork = file => {
    if (!networks.has(file)) networks.set(file, ValuePolicyNetwork.load(file));
    return networks.get(file);
};

const KEY_FIELDS = ['currentTurn', 'winner', 'status', 'quantumState', 'measuredSquares', 'emptySquares',
    'pairs', 'squareToPair', 'decoherenceCounters'];
const stateKey = state => JSON.stringify(KEY_FIELDS.map(key => state[key]));
const COVERED = 0.999;           // probability mass at which an outcome set counts as complete
const MAX_OUTCOME_SAMPLES = 64;  // stop discovering outcomes after this many simulations
const PRIOR_CACHE_SIZE = 200000;      // positions per prior network and thread
const priorCaches = new Map();        // prior network file -> Map(stateKey -> prior)
const priorCache = file => {
    if (!priorCaches.has(file)) priorCaches.set(file, new Map());
    return priorCaches.get(file);
};

// One tree. Stops at `deadline` (epoch ms) or once `maxSteps` simulated moves have been spent,
// whichever comes first.
//
// Move prior (DESIGN.md §2.4; off unless `priorFile` is given): the network's move-preference
// logits, softmaxed over the legal moves, guide the tree (progressive bias, Chaslot et al. 2008):
//   - untried moves are expanded in order of the prior, best first, instead of at random;
//   - selection adds priorWeight * P(move) / (1 + visits) to the UCB1 score;
//   - with priorWidening c > 0, a node expands a new move only while it has fewer than
//     max(1, ceil(c * sqrt(visits))) children (progressive widening), so moves the prior
//     dislikes are tried only once the node has been visited often.
// One network call per guided node, on its first expansion.
async function mctsSearch(observation, { deadline = Infinity, maxSteps = Infinity, seed = 0, exploration = 1.0,
    drawValue = 0.5, bothValue = drawValue, priorFile = null, priorWeight = 1.0, priorWidening = 0,
    now = Date.now } = {}) {
    const legal = observation.legalMoves;
    if (!legal?.length) throw new Error('No legal actions');
    if (!(priorWeight >= 0) || !(priorWidening >= 0)) throw new Error('bad prior settings');
    if (!Number.isFinite(deadline) && !Number.isFinite(maxSteps)) throw new Error('Give a deadline or maxSteps');
    const priorNetwork = priorFile ? loadNetwork(priorFile) : null;
    let priorCalls = 0;
    await Env.create(observation.settings);              // loads the engine once
    const settings = observation.settings;
    const started = now();
    let rng = seed >>> 0;
    const nextSeed = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0);
    const uniform = () => nextSeed() / 4294967296;
    const outcome = winner => winner === 1 ? 1 : winner === 2 ? 0 : winner === 3 ? bothValue : drawValue;
    let steps = 0, iterations = 0;

    const makeNode = (state, legalMoves) => {
        const terminal = Boolean(state.winner) || legalMoves.length === 0;
        return { state, legal: legalMoves, untried: legalMoves.map((_, i) => i), edges: [], visits: 0, total: 0,
            terminal, value: terminal ? (state.winner ? outcome(state.winner) : drawValue) : null };
    };
    const rootState = structuredClone(observation);
    for (const key of ['settings', 'legalMoves', 'player', 'ply']) delete rootState[key];
    const root = makeNode(rootState, legal);

    // Probability-weighted mean of an edge's outcomes when exact, else the sample mean.
    function edgeMean(edge) {
        if (!edge.exact) return edge.total / edge.visits;
        let value = 0, mass = 0;
        for (const child of edge.children.values()) {
            if (!child.visits) continue;
            value += child.p * child.total / child.visits;
            mass += child.p;
        }
        return mass ? value / mass : edge.total / edge.visits;
    }

    function follow(node, edge) {
        if (edge.deterministic && edge.child) return edge.child;
        if (edge.exact && edge.complete) {
            // Spread visits in proportion to each outcome's probability.
            let chosen = null, lowest = Infinity;
            for (const child of edge.children.values()) {
                const ratio = (child.visits + 1) / child.p;
                if (ratio < lowest) { lowest = ratio; chosen = child; }
            }
            return chosen;
        }
        const next = advance(settings, node.state, edge.action, nextSeed());
        steps++;
        if (edge.deterministic === null) {
            edge.deterministic = next.randomCalls === 0;
            if (!edge.deterministic) edge.exact = bornProbability(node.state, next.state) !== null;
        }
        if (edge.deterministic) return (edge.child = makeNode(next.state, next.legalMoves));
        const key = stateKey(next.state);
        let child = edge.children.get(key);
        if (!child) {
            child = makeNode(next.state, next.legalMoves);
            edge.children.set(key, child);
            if (edge.exact) {
                child.p = bornProbability(node.state, next.state) ?? 0;
                edge.coverage += child.p;
            }
        }
        if (edge.exact && (edge.coverage >= COVERED || ++edge.samples >= MAX_OUTCOME_SAMPLES))
            edge.complete = [...edge.children.values()].every(c => c.p > 0);
        return child;
    }

    const evaluate = node => node.terminal ? node.value : worldsValue(node.state);

    // A guided node's prior: the network's logits softmaxed over its legal moves, computed on the
    // node's first expansion; its untried moves are then ordered best first. Priors are cached by
    // position across trees and searches in this thread (a forest rebuilds its trees from scratch).
    function priorOf(node) {
        if (!priorNetwork) return null;
        if (!node.prior) {
            const cache = priorCache(priorFile), key = stateKey(node.state);
            node.prior = cache.get(key);
            if (!node.prior) {
                const { logits } = priorNetwork.evaluate(node.state, settings, node.legal);
                priorCalls++;
                const top = Math.max(...logits), exps = logits.map(l => Math.exp(l - top));
                const sum = exps.reduce((s, e) => s + e, 0);
                node.prior = exps.map(e => e / sum);
                if (cache.size >= PRIOR_CACHE_SIZE) cache.clear();
                cache.set(key, node.prior);
            }
            node.untried.sort((a, b) => node.prior[b] - node.prior[a]);
        }
        return node.prior;
    }

    function select(node, prior) {
        const logVisits = Math.log(node.visits);
        const forX = node.state.currentTurn === 'X';
        let best = null, bestScore = -Infinity;
        for (const edge of node.edges) {
            const mean = edgeMean(edge);
            let score = (forX ? mean : 1 - mean) + exploration * Math.sqrt(logVisits / edge.visits);
            if (prior) score += priorWeight * prior[edge.index] / (1 + edge.visits);
            if (score > bestScore) { bestScore = score; best = edge; }
        }
        return best;
    }

    function iterate() {
        const path = [];
        let node = root, value;
        for (;;) {
            if (node.terminal) { value = node.value; path.push([node, null]); break; }
            const prior = priorOf(node);
            const room = !prior || !(priorWidening > 0) ||
                node.edges.length < Math.max(1, Math.ceil(priorWidening * Math.sqrt(node.visits)));
            if (node.untried.length && room) {
                const at = prior ? 0 : Math.floor(uniform() * node.untried.length);
                const [index] = node.untried.splice(at, 1);
                const edge = { action: node.legal[index], index, visits: 0, total: 0, deterministic: null,
                    child: null, children: new Map(), exact: false, coverage: 0, samples: 0, complete: false };
                node.edges.push(edge);
                const child = follow(node, edge);
                path.push([node, edge], [child, null]);
                value = evaluate(child);
                break;
            }
            const edge = select(node, prior);
            const child = follow(node, edge);
            path.push([node, edge]);
            node = child;
        }
        for (const [visited, edge] of path) {
            visited.visits++;
            visited.total += value;
            if (edge) { edge.visits++; edge.total += value; }
        }
        iterations++;
    }

    if (legal.length > 1) {
        while (steps < maxSteps && now() < deadline) {
            const before = steps;
            iterate();
            // An iteration that only revisits known positions (game ends, cached deterministic
            // moves, fully weighted outcomes) simulates nothing; count it as one step so a step
            // budget always runs out.
            if (steps === before) steps++;
        }
    }
    const visits = legal.map(() => 0), totals = legal.map(() => 0);
    for (const edge of root.edges) { visits[edge.index] = edge.visits; totals[edge.index] = edgeMean(edge) * edge.visits; }
    return { ...pick(legal, visits, totals, observation.currentTurn), visits, totals, iterations,
        calls: steps, ms: now() - started, priorCalls };
}

// Most-visited move; ties go to the better average for the player to move.
// `values` are fixed-X in [-1, 1] (null where a move was never tried).
function pick(legal, visits, totals, player) {
    const values = visits.map((n, i) => n ? 2 * totals[i] / n - 1 : null);
    let best = 0;
    for (let i = 1; i < legal.length; i++) {
        const better = visits[i] > visits[best] || (visits[i] === visits[best] && visits[i] > 0 &&
            (player === 'X' ? values[i] > values[best] : values[i] < values[best]));
        if (better) best = i;
    }
    return { action: legal[best], values };
}

// The search the player runs: independent `treeSteps`-step trees, one after another until the
// deadline (or `maxTrees`, which makes a seeded search reproducible), merged at the root.
// `onProgress` gets the merged result after every tree.
async function forestSearch(observation, { deadline = Infinity, treeSteps = 2000, maxTrees = Infinity, seed = 0,
    onProgress = () => {}, now = Date.now, ...options } = {}) {
    if (!Number.isFinite(deadline) && !Number.isFinite(maxTrees)) throw new Error('Give a deadline or maxTrees');
    const legal = observation.legalMoves;
    const trees = [];
    do {
        trees.push(await mctsSearch(observation, { ...options, maxSteps: treeSteps, deadline, now,
            seed: (seed + 7919 * trees.length) >>> 0 }));
        onProgress({ ...mergeRoots(legal, observation.currentTurn, trees), trees: trees.length });
    } while (legal.length > 1 && trees.length < maxTrees && now() < deadline);
    return { ...mergeRoots(legal, observation.currentTurn, trees), trees: trees.length };
}

// Combine root statistics from independent searches (trees and threads).
function mergeRoots(legal, player, results) {
    const visits = legal.map(() => 0), totals = legal.map(() => 0);
    let iterations = 0, calls = 0, ms = 0;
    for (const result of results) {
        result.visits.forEach((n, i) => { visits[i] += n; totals[i] += result.totals[i]; });
        iterations += result.iterations; calls += result.calls; ms = Math.max(ms, result.ms);
    }
    return { ...pick(legal, visits, totals, player), visits, totals, iterations, calls, ms };
}

module.exports = { mctsSearch, forestSearch, mergeRoots };

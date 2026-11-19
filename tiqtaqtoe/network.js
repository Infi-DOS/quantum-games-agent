'use strict';
// The optional move prior's network (BOT_PRIOR=on; DESIGN.md §2.4), in plain JavaScript. It reads a
// position's whole quantum state (encoding schema tiqtaqtoe-structured-v1) and scores each legal
// move; its value output is not used by the agent. The weights are in data/prior-network.json.
const fs = require('node:fs');
const { worldsValue } = require('./quantum');

const FORMAT = 'tiqtaqtoe-value-policy-v1';

// erf with |error| < 1.2e-7 (Numerical Recipes erfc), enough for PyTorch's exact GELU.
function erf(x) {
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
        t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? 1 - r : r - 1;
}
const gelu = x => 0.5 * x * (1 + erf(x / Math.SQRT2));

function linear(layer, input) {
    const { weight, bias, rows, cols } = layer;
    const out = new Float64Array(rows);
    for (let r = 0; r < rows; r++) {
        let sum = bias[r];
        const offset = r * cols;
        for (let c = 0; c < cols; c++) sum += weight[offset + c] * input[c];
        out[r] = sum;
    }
    return out;
}
const geluAll = v => v.map(gelu);

function layerNorm(norm, v) {
    let mean = 0;
    for (const x of v) mean += x;
    mean /= v.length;
    let variance = 0;
    for (const x of v) variance += (x - mean) * (x - mean);
    variance /= v.length;
    const scale = 1 / Math.sqrt(variance + 1e-5);
    return v.map((x, i) => (x - mean) * scale * norm.weight[i] + norm.bias[i]);
}

// ---- state encoding --------------------------------------------------------------
function encodeState(state, settings) {
    const squares = [];
    for (let i = 0; i < 9; i++) {
        const p = state.probabilities[i];
        squares.push([p[0], p[1], p[2], state.measuredSquares[i] ? 1 : 0, state.emptySquares[i] ? 1 : 0,
            state.decoherenceCounters[i], ...Array.from({ length: 9 }, (_, j) => (i === j ? 1 : 0))]);
    }
    const basis = [];
    let index = 0;
    for (const [board, amp] of Object.entries(state.quantumState)) {
        const token = [];
        for (const c of board) for (const symbol of '0XO') token.push(c === symbol ? 1 : 0);
        token.push(amp.real, amp.imaginary, index++);
        basis.push(token);
    }
    const adjacency = new Float64Array(81);
    for (const group of state.pairs) if (group) for (const i of group) for (const j of group) adjacency[i * 9 + j] = 1;
    const winner = state.winner || 0;
    const globals = [state.currentTurn === 'X' ? 1 : 0, state.currentTurn === 'O' ? 1 : 0,
        ...[0, 1, 2, 3, 4].map(q => (settings.quantumness === q ? 1 : 0)), settings.decoherence,
        ...[0, 1, 2, 3, 4].map(w => (winner === w ? 1 : 0)),
        state.status === 'ongoing' ? 1 : 0, state.status === 'completed' ? 1 : 0];
    return { squares, basis, adjacency, globals };
}

function encodeAction(action) {
    const out = new Float64Array(21);
    const kind = action.length === 1 ? 0 : action[1] === 'M' ? 2 : 1;
    out[kind] = 1;
    out[3 + action[0]] = 1;
    if (kind === 1) out[12 + action[1]] = 1;
    return out;
}

class ValuePolicyNetwork {
    constructor(spec) {
        if (spec.format !== FORMAT) throw new Error(`Unsupported network format ${spec.format}`);
        if (spec.encoder_schema !== 'tiqtaqtoe-structured-v1') throw new Error('Unsupported state encoding');
        this.inputs = spec.inputs;
        // A residual network's value output is a correction to the per-world score (quantum.js).
        this.residual = spec.residual === true;
        const layer = name => {
            const w = spec.weights[`${name}.weight`], b = spec.weights[`${name}.bias`];
            if (!w || !b) throw new Error(`Missing layer ${name}`);
            return { weight: Float64Array.from(w.data), bias: Float64Array.from(b.data), rows: w.shape[0], cols: w.shape[1] };
        };
        if (this.inputs === 'superposition' || this.inputs === 'magnitude') {
            this.square = layer('encoder.square.0');
            this.basis1 = layer('encoder.basis.0');
            this.basis2 = layer('encoder.basis.2');
            this.combine1 = layer('encoder.combine.0');
            this.combine2 = layer('encoder.combine.2');
            this.norm = layer('encoder.combine.3');
        } else if (this.inputs === 'marginal') {
            this.combine1 = layer('encoder.net.0');
            this.combine2 = layer('encoder.net.2');
            this.norm = layer('encoder.net.3');
        } else {
            throw new Error(`Unknown network inputs ${this.inputs}`);
        }
        this.value1 = layer('value.0');
        this.value2 = layer('value.2');
        this.move1 = layer('move.0');
        this.move2 = layer('move.2');
    }

    static load(file) {
        return new ValuePolicyNetwork(JSON.parse(fs.readFileSync(file, 'utf8')));
    }

    latent(state, settings) {
        const x = encodeState(state, settings);
        let input;
        if (this.inputs !== 'marginal') {
            const squares = x.squares.flatMap(s => Array.from(geluAll(linear(this.square, s))));
            const pooled = new Float64Array(this.basis2.rows);
            let mass = 0;
            for (const token of x.basis) {
                // The magnitude input sees each amplitude as (|α|, 0): the board's probability, no phase.
                if (this.inputs === 'magnitude') [token[27], token[28]] = [Math.hypot(token[27], token[28]), 0];
                const features = linear(this.basis2, geluAll(linear(this.basis1, token)));
                const w = token[27] * token[27] + token[28] * token[28];
                mass += w;
                for (let i = 0; i < features.length; i++) pooled[i] += w * features[i];
            }
            const scale = 1 / Math.max(mass, 1e-8);
            input = [...squares, ...Array.from(pooled, v => v * scale), ...x.adjacency, ...x.globals];
        } else {
            input = [...x.squares.flat(), ...x.adjacency, ...x.globals];
        }
        return layerNorm(this.norm, linear(this.combine2, geluAll(linear(this.combine1, input))));
    }

    // Value from X's point of view in [-1, 1], and one move-preference logit per legal move.
    evaluate(state, settings, legalMoves = []) {
        const latent = this.latent(state, settings);
        const head = linear(this.value2, geluAll(linear(this.value1, latent)))[0];
        const value = this.residual
            ? Math.min(1, Math.max(-1, 2 * worldsValue(state) - 1 + head))
            : Math.tanh(head);
        const logits = legalMoves.map(move =>
            linear(this.move2, geluAll(linear(this.move1, [...latent, ...encodeAction(move)])))[0]);
        return { value, logits };
    }
}

module.exports = { ValuePolicyNetwork, encodeState, encodeAction, erf };

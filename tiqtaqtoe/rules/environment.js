'use strict';

const rules = require('./rules');
const clone = value => JSON.parse(JSON.stringify(value));
let initialized;

class TiqTaqToeEnvironment {
    static async create(options = {}) {
        initialized ??= rules.initEngine();
        await initialized;
        return new TiqTaqToeEnvironment(options);
    }

    constructor({ quantumness = 2, decoherence = 0, seed = 0 } = {}) {
        if (!Number.isInteger(quantumness) || quantumness < 0 || quantumness > 4)
            throw new Error('quantumness must be an integer from 0 to 4');
        if (!Number.isInteger(decoherence) || decoherence < 0)
            throw new Error('decoherence must be a nonnegative integer');
        this.settings = { quantumness, decoherence, timerEnabled: false, moveTime: 5 };
        this.reset({ seed });
    }

    reset({ seed = 0, startingPlayer = 'X' } = {}) {
        if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
            throw new Error('seed must be a uint32');
        if (!['X', 'O'].includes(startingPlayer)) throw new Error('Invalid starting player');
        this.rngState = seed >>> 0;
        this.ply = 0;
        this.state = rules.createFreshRound(startingPlayer === 'X' ? 1 : 2);
        return this.observation();
    }

    random() {
        this.rngState = (this.rngState + 0x6D2B79F5) >>> 0;
        let t = this.rngState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    legal_actions() {
        if (this.state.status !== 'ongoing') return [];
        // The supplied legality checker writes errorMessage; queries must be pure.
        return rules.getAvailableMoves(this.settings, clone(this.state));
    }

    observation() {
        return clone({ ...this.state, player: this.state.currentTurn,
            settings: this.settings, legalMoves: this.legal_actions(), ply: this.ply });
    }

    snapshot() {
        return clone({ schemaVersion: 1, simulatorVersion: 'tiqtaqtoe-supplied-v1',
            settings: this.settings, state: this.state, rngState: this.rngState, ply: this.ply });
    }

    restore(snapshot) {
        if (snapshot.schemaVersion !== 1 || snapshot.simulatorVersion !== 'tiqtaqtoe-supplied-v1')
            throw new Error('Unsupported snapshot version');
        const saved = clone(snapshot);
        this.settings = saved.settings;
        this.state = saved.state;
        this.rngState = saved.rngState;
        this.ply = saved.ply;
        return this.observation();
    }

    step(action) {
        if (!this.legal_actions().some(a => JSON.stringify(a) === JSON.stringify(action)))
            throw new Error('Illegal action or terminal episode');
        const before = this.snapshot();
        const random = Math.random;
        try {
            // Engine 1.0.3 samples through Math.random. All rule execution here is
            // synchronous; restore the global immediately, including on failure.
            Math.random = () => this.random();
            rules.doMove(this.settings, this.state, action, this.state.currentTurn, true);
            this.ply++;
            if (this.state.winner) this.state.status = 'completed';
        } catch (error) {
            this.restore(before);
            throw error;
        } finally {
            Math.random = random;
        }
        const outcome = { 1: 'X', 2: 'O', 3: 'both', 4: 'draw' }[this.state.winner] ?? null;
        return { observation: this.observation(), terminated: this.state.status === 'completed',
            outcome, valueX: outcome === 'X' ? 1 : outcome === 'O' ? -1 : 0 };
    }
}

module.exports = { TiqTaqToeEnvironment };

/**
 * The agent's parameters: loads .env (next to this file) into the environment before anything else runs.
 * agent.mjs imports this file first, and the search threads inherit the variables from the agent.
 *
 * .env has one parameter per line, NAME=value; text after " #" is a comment.
 *   - A parameter missing from .env keeps its shipped value (PARAMETERS below).
 *   - auto (numbers only): the agent decides; the TiqTaqToe thread counts then follow the machine's cores.
 *   - Paths are relative to this folder. An empty path turns that part off (game records, book).
 *   - A variable already set in the shell wins over the file for that run, e.g. in PowerShell:
 *       $env:PORT=9000; node agent.mjs
 * A value that cannot work (a word where a number belongs, 0 threads) stops the agent at start with a
 * message naming it, instead of costing games later.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = path.join(ROOT, '.env');

// NAME: [kind, shipped value, limits]. int and number: [min, max]; choice: the allowed words.
export const PARAMETERS = {
    PORT: ['int', 8081, [1, 65535]],
    AI_NAME: ['text', 'christos-athanasios'],
    BOT_WORKERS: ['int', 'auto', [1, 64]],
    BOT_THREADS_PER_MOVE: ['int', 'auto', [1, 64]],
    CHEQQERS_THREADS: ['int', 3, [1, 64]],
    TIME_MARGIN_MS: ['number', 500, [0, 60000]],
    BOT_MAX_SEARCH_MS: ['number', 4000, [50, 60000]],
    BOT_DEFAULT_MOVE_TIME: ['number', 5, [0.1, 600]],
    BOT_DEFAULT_QUANTUMNESS: ['int', 2, [0, 4]],
    BOT_DEFAULT_DECOHERENCE: ['int', 0, [0, 3]],
    CHEQQERS_DEFAULT_TIMEOUT_MS: ['number', 3000, [100, 600000]],
    CHEQQERS_DEFAULT_QUANTUMNESS: ['int', 2, [0, 3]],
    CHEQQERS_DEFAULT_BOARD_SIZE: ['choice', '6', ['4', '6', '8', '10']],
    BOT_RECORD_DIR: ['path', 'games/tiqtaqtoe'],
    CHEQQERS_RECORD_DIR: ['path', 'games/cheqqers'],
    BOT_BOOK: ['path', 'tiqtaqtoe/data/opening-book.json'],
    BOT_PRIOR: ['choice', 'off', ['on', 'off']],
    BOT_PRIOR_WEIGHT: ['number', 1, [0, 1000]],
    BOT_PRIOR_WIDENING: ['number', 1, [0, 1000]],
    BOT_PRIOR_LEVELS: ['levels', '2'],
    BOT_TREE_STEPS: ['int', 2000, [1, 1e9]],
    BOT_EXPLORATION: ['number', 1, [0, 1000]],
    BOT_DRAW_VALUE: ['number', 0.5, [0, 1]],
    BOT_BOTH_VALUE: ['number', 0.5, [0, 1]],
    CHEQQERS_MAX_DEPTH: ['int', 8, [1, 1000]],
    CHEQQERS_EXPLORATION: ['number', 0.9, [0, 1000]],
};

/** The NAME=value pairs of a .env text (a later line wins), and the lines that are not one. */
export function parseEnv(text) {
    const values = new Map(), problems = [];
    text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) { problems.push(`line ${i + 1} is not NAME=value: ${line}`); return; }
        const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(match[2]);
        values.set(match[1], quoted ? quoted[2] : match[2].startsWith('#') ? '' : match[2].replace(/\s+#.*$/, '').trim());
    });
    return { values, problems };
}

/** Why `value` cannot work for a parameter of this kind, or null. */
function problemOf(kind, value, limits) {
    if (kind === 'int' || kind === 'number') {
        if (value === 'auto') return null;
        const n = Number(value);
        if (value.trim() === '' || Number.isNaN(n)) return 'must be a number or auto';
        if (kind === 'int' && Number.isFinite(n) && !Number.isInteger(n)) return 'must be a whole number';
        if (n < limits[0] || n > limits[1]) return `must be from ${limits[0]} to ${limits[1]}`;
    }
    if (kind === 'choice' && !limits.includes(value)) return `must be one of: ${limits.join(', ')}`;
    if (kind === 'levels' && value.trim() !== 'all' && !/^\s*[0-4](\s*,\s*[0-4])*\s*$/.test(value))
        return 'must be quantumness levels from 0 to 4 separated by commas (2, or 2,3), or all';
    return null;
}

/** Puts every parameter into `env` (shell first, then .env, then the shipped value) and checks it. */
export function loadParameters({ env = process.env, file = ENV_FILE, log = console.log } = {}) {
    const found = fs.existsSync(file);
    const { values, problems } = found ? parseEnv(fs.readFileSync(file, 'utf8')) : { values: new Map(), problems: [] };
    const errors = problems.map(problem => `.env ${problem}`), changed = [], shell = [];
    const shown = (name, value) => `${name}=${value === '' ? '""' : value}`;
    const unknown = [...values.keys()].filter(name => !(name in PARAMETERS));
    for (const [name, [kind, shipped, limits]] of Object.entries(PARAMETERS)) {
        const fromShell = env[name] !== undefined;
        const value = fromShell ? env[name] : values.has(name) ? values.get(name) : String(shipped);
        const problem = problemOf(kind, value, limits);
        if (problem) {
            errors.push(`${name}=${value} (from ${fromShell ? 'the shell' : values.has(name) ? '.env' : 'the shipped values'}) ${problem}`);
            continue;
        }
        if (fromShell && values.has(name) && value !== values.get(name)) shell.push(shown(name, value));
        const numeric = (kind === 'int' || kind === 'number') && value !== 'auto' && shipped !== 'auto';
        if (numeric ? Number(value) !== Number(shipped) : value !== String(shipped)) changed.push(shown(name, value));
        if (value === 'auto') delete env[name];                      // the agent's own default
        else if (!fromShell) env[name] = kind === 'path' && value ? path.resolve(ROOT, value) : value;
    }
    if (errors.length) return { ok: false, errors };
    log(`[agent] parameters from ${found ? '.env' : 'the shipped values (no .env file)'}: ` +
        (changed.length ? `changed ${changed.join(', ')}` : 'all as shipped'));
    if (shell.length) log(`[agent] the shell overrides .env: ${shell.join(', ')}`);
    if (unknown.length) log(`[agent] .env: unknown parameter ${unknown.join(', ')} (a typo?), ignored`);
    return { ok: true };
}

const result = loadParameters();
if (!result.ok) {
    for (const error of result.errors) console.error(`[agent] parameter problem: ${error}`);
    console.error(`[agent] not started: fix ${ENV_FILE} (or the shell variable) and start again`);
    process.exit(1);
}

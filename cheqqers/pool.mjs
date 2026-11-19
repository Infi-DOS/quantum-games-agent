/**
 * A pool of Cheqqers search threads (worker.mjs), so the server's own thread stays free: several games
 * can be answered at once, and the time limit is kept even when a search overruns (safeMove's timer can
 * only fire while the server's thread is free). A request waits for a free thread with the time it has
 * left; a thread still busy `graceMs` after its budget is replaced by a fresh one.
 *
 *   const pool = createPool({ size: 3 });
 *   await pool.whenReady();
 *   const { move, source } = await safeMove(request, pool.strategy);
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));

export function createPool({ size = 3, workerFile = WORKER, graceMs = 1500, log = () => {} } = {}) {
    let closing = false, nextId = 1;
    const queue = [];
    const jobs = new Map();                          // id -> { resolve, slot }

    function spawn() {
        const slot = { worker: new Worker(workerFile), ready: false, busy: false, retired: false, watchdog: null };
        slot.worker.on('message', message => {
            if (message.type === 'ready') { slot.ready = true; drain(); return; }
            if (message.type !== 'move') return;
            const job = jobs.get(message.id);
            jobs.delete(message.id);
            clearTimeout(slot.watchdog);
            slot.busy = false;
            if (message.error) log(`[cheqqers] search error: ${message.error}`);
            job?.resolve(message.move ?? null);
            drain();
        });
        slot.worker.on('error', error => { log(`[cheqqers] search thread failed: ${error.message}`); replace(slot); });
        slot.worker.on('exit', () => { if (!slot.retired && !closing) replace(slot); });
        return slot;
    }

    // A stuck or dead thread: its request gets null (safeMove then answers a random legal move), a fresh one takes its place.
    function replace(slot) {
        if (slot.retired) return;
        slot.retired = true;
        clearTimeout(slot.watchdog);
        slot.worker.terminate();
        for (const [id, job] of jobs) if (job.slot === slot) { jobs.delete(id); job.resolve(null); }
        const index = slots.indexOf(slot);
        if (index !== -1 && !closing) slots[index] = spawn();
    }

    function drain() {
        while (queue.length) {
            const slot = slots.find(s => s.ready && !s.busy && !s.retired);
            if (!slot) return;
            const job = queue.shift();
            const left = job.deadline - Date.now();
            if (left < 250) { job.resolve(null); continue; }   // too late to search: safeMove's fallback answers
            const id = nextId++;
            slot.busy = true;
            jobs.set(id, { resolve: job.resolve, slot });
            slot.watchdog = setTimeout(() => { log('[cheqqers] search thread stuck, replacing it'); replace(slot); }, left + graceMs);
            slot.worker.postMessage({ id, request: job.request, budgetMs: left });
        }
    }

    const slots = Array.from({ length: size }, spawn);

    /** A strategy for safeMove: the search's move within budgetMs, or null. */
    function strategy(request, { budgetMs = 2400 } = {}) {
        return new Promise(resolve => {
            queue.push({ request, deadline: Date.now() + budgetMs, resolve });
            drain();
        });
    }

    return {
        strategy,
        whenReady: async () => { while (!slots.every(s => s.ready)) await new Promise(r => setTimeout(r, 20)); },
        status: () => ({ threads: slots.length, ready: slots.filter(s => s.ready && !s.retired).length,
            busy: slots.filter(s => s.busy).length }),
        close: () => { closing = true; for (const s of slots) { s.retired = true; clearTimeout(s.watchdog); s.worker.terminate(); } },
    };
}

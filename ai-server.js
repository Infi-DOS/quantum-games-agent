#!/usr/bin/env node
'use strict';
/**
 * Starts the agent the way the organizers' participant starter is started: `node ai-server.js`, which
 * `npm start` and `./start.sh` also run. Same port (PORT, default 8081), same endpoints (POST /move,
 * GET /health) and same AI_NAME as the starter. The agent itself is agent.mjs; this file only runs it.
 */
import('./agent.mjs')
    .then(({ main }) => main())
    .catch((error) => {
        console.error(`[agent] failed to start: ${error?.stack ?? error}`);
        process.exit(1);
    });

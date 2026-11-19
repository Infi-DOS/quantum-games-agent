# Agent 1.0.7: Christos & Athanasios

One URL plays both games. `POST /move` answers Quantum TiqTaqToe (players X and O) and Quantum Cheqqers (players white and black).

How the agent plays: [DESIGN.md](DESIGN.md).

## Run

You need Node.js 18 or newer. There is nothing to install: the organizers' game engine (`@quantumplayed/quantum-game-engine` 1.0.3) is already in `node_modules`.

```
node agent.mjs
```

Wait for `[agent] ready`, then open `http://127.0.0.1:8081/health` to check it. Ctrl+C stops the agent.

The agent also starts the same ways as the organizers' participant starter, with the same port (8081, or `PORT`), the same endpoints and the same `AI_NAME`:
- `node ai-server.js`, or `npm start`;
- `bash start.sh` on macOS or Linux. This is the starter's own launcher, unchanged. It starts the agent and an ngrok tunnel, and prints the public URL to send.

On Windows you can also run `powershell -ExecutionPolicy Bypass -File start-agent.ps1`. It starts the agent, checks that it is ready, keeps a log in `logs\`, and starts the agent again if it ever stops.

- `-Port 9000` uses another port for that run.
- `-Tunnel` also opens a public ngrok URL. The arena connector does not need one.

If the folder was copied without `node_modules`, run `npm ci` first.

## Endpoints

| Request | Answer |
|---|---|
| `POST /move` with a game request | `200 {"move": [...]}`, always one of the request's `legalMoves` |
| `GET /health` (also `GET /` and `GET /move`) | `200` with the version, the games it supports, and its search threads |
| `OPTIONS` | `204` with CORS headers |

The agent tells the two games apart by the player: X or O is TiqTaqToe, and white or black is Cheqqers.

## Settings

All settings are in `.env`, one per line with a comment. Edit the file, then restart the agent.

- At start, the agent prints which settings differ from the shipped values.
- It refuses to start if a value cannot work, and names the setting.
- A variable set in the shell wins over `.env` for that run, for example `$env:PORT=9000; node agent.mjs` in PowerShell.

Every request carries the game's settings (time limit, quantumness, board size, decoherence), and the agent always uses them. The `*_DEFAULT_*` values in `.env` apply only to a setting that a request leaves out. They are the tournament's settings: TiqTaqToe 5 s, quantumness 2, no decoherence; Cheqqers 3 s, 6×6, quantumness 2.

The agent plays without a neural network. `BOT_PRIOR=on` turns on an optional learned move prior for TiqTaqToe (DESIGN.md §2.4). `/health` shows whether it is on.

## Play in the arena

The connector runs on this computer and calls the agent, so the agent needs no public address.

1. Start the agent (see Run).
2. Download the connector once, from the arena address:

   ```
   curl.exe -o arena-connector.js <arena address>/connector.js
   ```

3. Run one connector per game, each with your team's token for that game:

   ```
   node arena-connector.js --arena <Cheqqers arena address> --token <Cheqqers token> --agent http://127.0.0.1:8081/move
   node arena-connector.js --arena <TiqTaqToe arena address> --token <TiqTaqToe token> --agent http://127.0.0.1:8081/move
   ```

Type tokens on the command line only, and never save them in this folder. The agent writes a record of each game to `games/`.

## What is in the folder

| Path | What it is |
|---|---|
| `agent.mjs` | The server. It sends each request to the right player and checks every answer against the request's `legalMoves`. If a player fails or is late, it answers a quick legal move. |
| `ai-server.js` | Starts the agent as the organizers' starter is started (`node ai-server.js`, `npm start`) |
| `start.sh` | The organizers' launcher from their starter, unchanged: the agent plus an ngrok tunnel (macOS, Linux) |
| `.env`, `env.mjs` | The settings, and the code that loads and checks them |
| `tiqtaqtoe/` | The TiqTaqToe player |
| `cheqqers/` | The Cheqqers player |
| `node_modules/` | The organizers' quantum game engine |
| `start-agent.ps1` | A Windows starter that keeps a log and restarts the agent if it stops |
| `README.md`, `DESIGN.md` | This file, and how the agent plays |

Each player folder has its own code at the top and the organizers' rules in `rules/`.

### The TiqTaqToe player, `tiqtaqtoe/`

| File | What it does |
|---|---|
| `player.js` | Answers a request: the opening book, else the search on its threads, with a deadline guard |
| `search-worker.js` | One search thread |
| `mcts.js` | The tree search: small trees merged at the root, exact chance nodes for measurements |
| `quantum.js` | Born probabilities of measurement outcomes, and the evaluation of a position |
| `simulate.js` | Plays one move on the organizers' rules, for the search |
| `payload.js` | Reads a request: the position, the time limit, a quick fallback move |
| `book.js` | Looks a position up in the opening book |
| `network.js` | The optional move prior's network |
| `rules/rules.js` | The organizers' TiqTaqToe rules, taken from their local server |
| `rules/environment.js` | A small wrapper around those rules |
| `data/opening-book.json` | The opening book |
| `data/prior-network.json`, `data/prior.json` | The optional move prior's weights and settings (used only with `BOT_PRIOR=on`) |

### The Cheqqers player, `cheqqers/`

| File | What it does |
|---|---|
| `safe-move.mjs` | The answer: the search's move if it is legal and in time, else a random legal move |
| `pool.mjs`, `worker.mjs` | The pool of search threads, and one thread |
| `search.mjs` | The tree search and its evaluation |
| `state.mjs` | Rebuilds a request's position on the organizers' game code, and checks it against the request's legal moves |
| `rules/game.generated.mjs` | The organizers' Cheqqers rules, taken from their local server |

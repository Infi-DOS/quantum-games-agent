# How the agent plays

Team: Christos & Athanasios. How to run it: [README.md](README.md).

The agent plays Quantum TiqTaqToe and Quantum Cheqqers from one endpoint. Both players use Monte Carlo tree search on the games' exact quantum rules, and the organizers' own rules code runs inside the search. The rules give the outcomes of every measurement with exact probabilities, so the agent builds the quantum structure into the search instead of learning it.

## 1. What is quantum in the games, and what it means for the agent

**TiqTaqToe.** The state is a superposition of classical 3×3 boards, each with a complex amplitude. A move is one of three kinds:

- a classical placement (`[s]`);
- a quantum operation on two squares (`[a,b]`);
- a measurement of a square (`[s,"M"]`).

A measurement collapses the superposition. Each outcome occurs with its Born probability: the sum of |α|² over the boards consistent with that outcome. Only measured lines count towards a win.

**Cheqqers.** Checkers with quantum moves. Depending on the quantumness level:
- a piece can split into a superposition of two squares;
- superposed pieces can become entangled;
- split pieces can merge back, so that amplitudes interfere.

Measurements resolve these superpositions with Born probabilities.

This shapes the agent in three ways:

1. **Chance comes with exactly known probabilities.** A search can average over the outcomes of a measurement instead of guessing.
2. **The state is more than the board.** Two positions that look the same square by square can differ in their amplitudes, and so in how they will collapse. The agent reads the whole superposition.
3. **The rules are cheap to simulate.** The agent simulates them during the search, with the organizers' own code.

## 2. TiqTaqToe

A request takes one of two paths:

- If the position is in the opening book, the agent plays the book move.
- Otherwise it searches and plays the move the search visited most.

### 2.1 Opening book

- **What.** 33 positions, each with a chosen move. For example, X opens with the classical edge move `[7]`. The book is used at quantumness 2 without decoherence. In every other setting, the search plays from the first move.
- **Why.** At the start of a game almost nothing has been measured, so positions are hardest to judge there. Each book move was chosen by game results. Many games were played from every candidate move, and the best candidate was kept (sequential halving; Karnin et al. 2013).

### 2.2 Tree search with exact chance nodes

- **What.** Monte Carlo tree search with UCT (Kocsis & Szepesvári 2006). When a move measures, the tree keeps each outcome with its exact Born probability. It values the move by the probability-weighted average of its outcomes.
- **Why.** The rules give each outcome's probability exactly, and a measurement has few outcomes. Averaging over them removes the noise of sampling one outcome at a time.
- **Many small trees.** The search runs many independent trees of 2,000 simulated moves each, on worker threads. It adds up their visit counts at the root (root parallelization; Chaslot et al. 2008). More time gives more trees, not deeper ones, because with this evaluation merged small trees choose more reliably than one deep tree.

### 2.3 Evaluating a position

- **What.** Where a simulation stops, every classical board in the superposition is scored by its open lines. A line with k marks of one player and none of the other counts k². The board scores are then averaged with their Born weights |α|².
- **Why.** The result is the expected score if every square were measured now. Scoring board by board keeps the correlations between squares (entanglement), which the probabilities of single squares would lose.

### 2.4 Optional: a learned move prior (off by default)

- **What.** A small network (82,306 parameters) that scores each legal move. It reads the whole quantum state:
  - every board of the superposition, with its amplitude;
  - the probability of each square;
  - which squares are entangled;
  - the decoherence counters.

  It was trained to imitate a deeper search, which spent 120,000 simulated moves on each of 910 positions from self-play games at quantumness 2.
- **How the search uses it.** With `BOT_PRIOR=on`:
  - untried moves are tried best first;
  - a move's selection score gets a bonus P/(1+visits), which fades as the move collects visits, so the search can overrule the network (progressive bias; Chaslot et al. 2008);
  - a node with N visits keeps at most ⌈√N⌉ children (progressive widening; Coulom 2007).

  This is the idea behind AlphaZero's prior and expert iteration (Silver et al. 2018; Anthony et al. 2017), in its simplest form: one round of imitation.
- **When.** Only at quantumness 2, the level it was trained on. It is off by default, and then the agent plays with the search alone.

## 3. Cheqqers

A request goes through three steps:

1. The agent rebuilds the position on the organizers' own game code.
2. If the rebuilt game has exactly the legal moves listed in the request, the agent searches. Otherwise it plays a random legal move.
3. The search runs on a pool of 3 threads, so games played at the same time each keep their time limit.

### 3.1 The organizers' rules

- **What.** The game code is taken from the organizers' local Cheqqers server, in its version of 16 November. The request's board, and the amplitudes of every quantum system, are loaded into it.
- **Why.** The referee's own code simulates the splits, merges, entanglement and measurements, so the agent does not re-implement the quantum mechanics. Checking the rebuilt game against the request's legal moves catches any mismatch before the search starts.

### 3.2 Search and evaluation

- **What.** Open-loop Monte Carlo tree search:
  - Each simulation plays moves on a copy of the game.
  - The engine resolves measurements itself, as in a real game, so a node's statistics average over the collapse outcomes.
  - A simulation stops at a new node or after 8 plies.
  - The position is then scored by expected material. Each piece counts with the probability that its square is occupied, and a king counts 1.6. The balance is mapped to [0, 1] with tanh.
- **Why.**
  - Expected material under the Born distribution is the natural counterpart of material in classical checkers.
  - Open-loop search handles chance without explicit chance nodes, and copes with legal moves that differ between simulations.

## 4. Time and reliability

- **Time.** The organizers measure the time limit on their side, so the network time counts too. Every answer, in both games, is sent 0.5 s before the limit (`TIME_MARGIN_MS`), even when it is ready earlier.
  - TiqTaqToe searches until 0.3 s before that, and for at most 4 s. At the 5 s limit it searches 4 s and answers at 4.5 s.
  - Cheqqers searches until 0.2 s before that. At the 3 s limit it searches about 2.3 s and answers at 2.5 s.
- **Always a legal move.** A request with legal moves always gets one of them back, with status 200. If a search fails or is late, a guard answers with a quick legal move. A stuck search thread is replaced.
- **Connections.** Idle connections stay open for 65 s, so a client that reuses its connection, as the organizers' referee does, keeps it between moves.
- **Errors.** An unexpected error is logged, and the agent keeps serving. `start-agent.ps1` restarts the agent if it stops.
- **Threads.** TiqTaqToe uses 2 to 6 search threads, depending on the machine's cores. Cheqqers uses 3. Both can be set in `.env`.

## 5. Scope

- The opening book covers quantumness 2 without decoherence. In other settings the search plays from the first move.
- The optional move prior was trained at quantumness 2, so it is used only there.
- The Cheqqers search constants (depth 8, exploration 0.9, king 1.6) are set by hand.
- The chance probabilities are exact as the official engine gives them. When the engine serializes a state, it drops basis states with |α|² below 0.0001.

## References

- Anthony, T., Tian, Z., Barber, D. (2017). Thinking fast and slow with deep learning and tree search. NeurIPS.
- Chaslot, G., Winands, M., van den Herik, H. J., Uiterwijk, J., Bouzy, B. (2008). Progressive strategies for Monte-Carlo tree search. New Mathematics and Natural Computation 4(3).
- Chaslot, G., Winands, M., van den Herik, H. J. (2008). Parallel Monte-Carlo tree search. Computers and Games.
- Coulom, R. (2007). Computing "Elo ratings" of move patterns in the game of Go. ICGA Journal 30(4).
- Karnin, Z., Koren, T., Somekh, O. (2013). Almost optimal exploration in multi-armed bandits. ICML.
- Kocsis, L., Szepesvári, C. (2006). Bandit based Monte-Carlo planning. ECML.
- Silver, D., et al. (2018). A general reinforcement learning algorithm that masters chess, shogi, and Go through self-play. Science.

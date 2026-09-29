# slight: a revised vision

Sep 29, 2026 · First draft · Revises the earlier `VISION.md` (`design-002-ish/`) and narrows `../../design-xxx/DESIGN-001.md`

Sep 29, 2026 · Section 5, on judgment and models, added, then updated from OpenJev and Verdict

The earlier vision described a personal computational estate: thousands of durable actors spread across a laptop, an always-on box and rented cloud cores, placed by cost, latency and trust. DESIGN-001 set out to build toward it and to bring in the best of the earlier prototypes. The result is a coherent design, and also a research program: the estate, tick-exact JIT tapes, a mergeable image and plans offloaded by equivalence are each a thesis on their own.

This document narrows the focus. It says what slight is for, which guarantees matter, what gets looser, what is built on top later, and what is shelved. It sets priorities and does not change semantics by itself: a change it calls for in the language or the runtime is proposed in `DECISIONS.md`, with options, before it is built. The starting point is the current system, including the deviations `DECISIONS.md` records (roles, plans and the language additions).

## 1. The vision

**slight is a small, deterministic actor runtime for one person's automations, agents and simulations, in which every run survives restarts, can be replayed exactly, and can say where its results came from.**

A program is still a society of small actors, each a function that receives a message, acts, and calls itself with its new state. Actors run as processes in an image. A control plane written in the language, the CPI, runs them. The host owns time, I/O, models and storage, and everything outside the language is reached through a host request.

One idea carries the rest: **record only what cannot be recomputed.** Nondeterminism can enter an image only through host requests, so an image that writes down the answers it gets, in a journal, can recompute everything else: its own state after a crash, the chain of causes behind any output, and the same run with one input changed. Durability, provenance, simulation and the replay of an agent's run are one mechanism, not four.

The scale is one person, and later the few people they share with: a few thousand active actors and many more idle ones, on machines the person owns. At that scale the interpreter is fast enough and memory is plentiful. The costs that matter are model calls, attention and trust, not processor time.

The estate is still the horizon, but it is built on top rather than into the runtime. Moving computation means shipping a snapshot and its journal, or an actor's code and loop arguments, and placement is a policy written in the language, as the earlier vision already said.

## 2. Why narrow

DESIGN-001 covers a streaming compiler pipeline, phases and phase-time FExprs, a mixer of tapes, tick-exact JIT tapes, layered effects, recovery strategies, durable mailboxes with acknowledgment, parking, capabilities, a content-addressed image with Irmin-style branches and merges, distribution between images, promises and futures, external event streams, refill and hierarchical quotas, deterministic replay, reflection and security. The prototype has built what SPEC-CPI covers, plus plans, roles, a terminal UI and an HTTP server, and has measured them.

Three things came out of that work:

- **The pieces are good, but they don't all belong in the runtime.** Merging, sharing and moving computation can be built from snapshots, journals and messages without reaching into the evaluator.
- **Precision has costs the common case shouldn't pay.** Exact tick costs, tick-exact JIT tapes and per-operation price tables serve rare needs. Counting steps gives most programs fair shares.
- **The uses that matter most need three things first:** determinism, durability and provenance. All three come from the same place.

## 3. What it is for

**Agents.** An agent is an actor whose behavior includes judgment: a model consulted through a host request, the way the host provides time. Most of its judgments are closed decisions, which a fast decision model makes; a generative model writes and plans when a decision says it's worth it (section 5). slight gives an agent a combination that agent frameworks rarely offer:

- only the authority it is granted, with no ambient access to anything;
- a budget on what it may spend, counted by the capability that spends it;
- a record of every model answer, so a run can be replayed without calling the model, forked at a decision ("what if it had answered this instead?"), and audited, spending included;
- parking for days while it waits for a person, with its pending actions held as data, not taken (the baseline's rule: state merges, a sent email does not);
- a separate image for code a model writes, with only what the owner grants.

**Simulations.** A simulation is a run with scripted inputs. Determinism makes it repeatable, and a journal makes it forkable: change one input and replay from there. The Life examples are simulations already. Agent-based simulations, in which many actors consult models, combine the two uses.

**Automations with kept history.** Actors that watch feeds, mail and files, triage what arrives, and produce notes and summaries. This is where the Memex survives, as inspiration rather than as a product: an image is a personal record of what came in and what was made from it. Every result can say where it came from, and history is curated rather than overwritten.

A flagship demo combines all three: a research agent that fetches sources, decides which are worth reading, has a generative model summarize them, and writes notes. Any note can be traced back through the journal to the fetches and model answers that produced it. The run survives `kill -9`, replays without calling the model, and can be forked at any decision.

## 4. Record what cannot be recomputed

### The journal

Every host action is one of three kinds:

| Kind | On a live run | On replay | Examples |
| --- | --- | --- | --- |
| Recomputable | Runs | Runs again | `process::`, `mailbox::`, `environment::`, `actor::`, `plan::`, and timers, which fire from journaled time |
| Input | The world answers, and the answer is journaled | Answered from the journal | `host::now`; `host::wait` and what it delivers (keys, HTTP requests, answers that took time); later, model answers, file reads and randomness |
| Effect | Acts on the world | Suppressed | `IO::print`, `tui::render`, HTTP responses; later, outbound requests and the asking half of a model call |

The journal is ordered by the image's sequence of host requests, which is deterministic between inputs, so replay can put every answer back exactly where it was. Answers that take time, such as a model's, arrive as messages at `host::wait` like any other event, so the journal records when they arrived as well as what they said.

An effect whose outcome matters or mustn't repeat, such as an outbound request or a model call, is journaled before and after it is performed. Printing and drawing are simply suppressed on replay and redone when the image goes live. Effects that set something up, such as `http::listen` or `tui::subscribe`, are replayed into the handler's own state without touching the world, and are re-established when the image goes live.

Replay checks that each request matches the one recorded. A mismatch means the code changed, the runtime changed, or something nondeterministic leaked in, and replay stops there and says so. The same check makes forks work: change an answer or the code, replay up to the first difference, and carry on live from there.

The code an image starts with is recorded by hash. Code loaded later is an input like any other, so replay loads it at the same point, and a hot reload replays like everything else.

### Snapshots

A snapshot is the image's state at a quiet point, between two of the CPI's host requests: every process with its continuation, every mailbox and environment, the state of the host's handlers and plans, and the CPI itself. A snapshot is a cache of replaying the journal: restoring one and replaying the journal after it brings the image back exactly as it was. The journal before a snapshot is kept or dropped by policy, which is where curation comes in.

### What falls out

- **Durability.** Restore the last snapshot and replay the journal. Every actor, mailbox and message in flight comes back, with no per-actor acknowledgment or checkpoint protocol.
- **Provenance on demand.** Replaying with tracing on recomputes the chain of causes behind any output: the turns, the messages between them, the inputs they started from, and the code each one ran. Nothing is recorded for provenance until someone asks.
- **Simulations and tests.** A simulation is a scripted journal. The tests already work this way: the virtual clock, the headless terminal and scripted HTTP requests make up a hand-written journal.
- **Agent replay, forks and audit,** as in section 3.
- **Debugging.** Stop anywhere, inspect and step, in a copy of the run.

### Time

Time is real, and it is an input. Today the runtime reads the clock through one function, but from 27 places, so time can move in the middle of a round. For replay, time must advance only at journaled points, such as when `host::wait` returns, and everything in between sees the same time. External events already enter only at `host::wait`. Plans run in the host but follow the same rule: they see time only through the journal. This is a change to runtime timing, so it is proposed in `DECISIONS.md` before it is built.

## 5. Judgment

An agent's judgment comes from models, consulted through host requests like time or storage. Two kinds of model do different jobs, and the system treats them differently.

**Decision models** answer closed questions. Given text or program state and a question declared in advance, a decision model returns a typed answer with probabilities, never prose: the probability that the answer to a yes/no question is yes, which of a declared set of options applies, or where an input falls on an ordered rubric. TypeSafe's Jev, launched on September 15, 2026, is built only for this: it calls the three kinds Noul, Choice and Score, and is trained so that its probabilities are calibrated. Open implementations followed within two weeks: OpenJev serves open models behind Jev's wire protocol, and Verdict is a 151M-parameter encoder trained for calibrated decisions.

**Generative models** answer open questions. They write, summarize, extract and plan, and their answers are text or code.

Most of an agent's judgments are decisions: which of these, how urgent, whether to ask, whether something deserves to wake anyone. Decision models suit the system unusually well:

- **Closed answers.** Every possible answer is declared in the request, so the model can only choose among the options the actor listed. An injected prompt can make it choose badly, but it can't make it act outside the list or write code. Model output gets the same discipline as a grant.
- **Small journal entries.** A key, its probabilities and a confidence take a few tens of bytes. Replay is exact, and a decision's provenance reads naturally, such as "filed as `later` at 0.62".
- **Probabilities become policy.** Above one threshold the actor acts on its own. In the middle, or when the model abstains, it holds the action as data for a person, and below it asks a generative model. Most decisions pass in a fraction of a second, and the doubtful ones go to someone who can judge.
- **Reflexes.** Triage, routing and deciding what deserves to wake are reflexes, not deliberation: the "AI hat" the earlier vision gave its always-on box. A score can even feed the CPI's choice of which parked actor to wake first, and scheduling stays deterministic because the answers are journaled inputs.
- **Distributions for simulations.** A simulated agent samples from the returned distribution with a seeded random source, so the simulation can rerun with another seed without calling the model again.
- **Comparison by replay.** Swap the backend and replay the journaled questions to see where two models decide differently. Similar accuracy can hide different decisions, and the journal shows which ones.

In an actor, a decision reads like a `case` whose test is a judgment. The namespace, the answer's shape and the helpers here are placeholders:

```lisp
(defun triage (owner)
    (let msg (actor::recv))
    (let answer (judge::choose (value->string msg) '(urgent later archive)))
    (let pick (car answer))
    (let confidence (car (cdr answer)))
    (cond
        ((< confidence 0.7) (actor::send owner (list :unsure msg answer)))
        ((eq? pick :urgent) (wake-assistant msg))
        (#true (file-away pick msg)))
    (triage owner))
```

Questions that depend on each other need nothing special: the actor asks them in order and puts the earlier answers into the state for the later ones.

Generative models do what decisions can't, such as the research agent's summaries, and a decision says when they are worth calling. Their answers make larger journal entries, a streamed answer is many inputs, and code they write runs in its own image.

### The namespaces

There are two host namespaces, one for decisions and one for generation, and their names and signatures are left to a proposal. The decision namespace has one action for each kind of question and returns typed values, with abstention as an answer of its own. Jev's wire protocol is a good model for it: a state and named questions go in, and typed answers come out (`POST /v1/systemone`). OpenJev already speaks that protocol, so one handler can reach every backend except the in-process and scripted ones by changing a URL. Behind each namespace the backend can be swapped:

- **Hosted:** Jev, or OpenJev as hosted by Codiv. What is asked leaves the machine, and nothing works offline.
- **Local and large:** an OpenJev server running DiffusionGemma 26B-A4B (26 billion parameters, 4 billion active), through MLX on Apple silicon or vLLM on an NVIDIA GPU. On a Mac it needs about 16 GB of memory to load, more in service, and answers three questions in 0.2 to 0.4 seconds on an M3 Ultra or M4 Max. It also answers questions about images, and the same server generates text, so one local server can back both namespaces.
- **Local and small:** an encoder such as Verdict (151M parameters) or Laya (421M). Verdict takes about 35 ms a question on a single WebAssembly thread, and it runs in JavaScript through ONNX, so it could live inside the host process.
- **Scripted,** for tests, like the headless terminal and the scripted HTTP requests.

The journal records which backend and model answered (a local model by the hash of its weights), the settings that shaped the answer, and what was asked, so it also shows exactly what left the machine. Grants decide which actors may send anything off the machine at all, and budgets count calls on the capability. If a hosted service goes away, past decisions stay replayable, and new ones fall back to another backend.

### Choosing a model

The models differ far more in quality than in speed. On TypeSafe's 337 public evaluation cases, the Verdict repository reports 48% accuracy for Verdict, 88% for DiffusionGemma and 91% for Jev. Its own tables show the small encoder doing well on narrow, well-defined choices, such as picking a tool or an intent, especially after fine-tuning, and badly on open judgments, such as spotting phishing or a jailbreak. So a backend is chosen per question, not per image, and the journal is where the choice is checked: replaying the same questions against two backends shows where they differ on the owner's own data.

A decision the image makes again and again can also be learned. Every case a person settled after an escalation is a labeled example in the journal, and the Verdict repository reports that on narrow workflows a plain classifier trained on examples came within two points of Jev's published accuracy. Training a local model from the journal is a library, not part of the runtime.

Three cautions:

- **A confidence means different things in different models.** Jev's is trained against its accuracy. Verdict's probabilities are scaled by a temperature fitted for each number of options. OpenJev reports one minus the normalized entropy of the answer's distribution, which measures certainty, not accuracy. So thresholds belong to a model, and are set from its record in the journal.
- **Calibration holds across many answers, not for any one of them.** "0.8" means right about 80% of the time over many decisions.
- **Answers repeat only on one setup.** OpenJev seeds each read from a hash of the request, so that the same request gets the same answer, but precision and kernels move the probabilities: by up to 0.055 between two runtimes of the same model. Replay therefore always uses the journal and never asks again.

Sources: [OpenJev](https://github.com/razorback16/openjev) and [Verdict](https://github.com/Heman10x-NGU/Verdict-open-jev), read on September 29, 2026.

## 6. Four guarantees

1. **Determinism.** The same code, the same runtime version and the same journal give the same run: the same values, the same host requests in the same order, and the same output.
2. **Durability.** An image restored from its last snapshot and its journal continues as if it had not stopped. It is the same run, so its PIDs survive. DESIGN-001's rule that a restart ends every PID still holds for an image started fresh. An effect cut off by a crash may happen twice, so the handlers of effects that mustn't repeat use idempotency keys.
3. **Provenance.** Every input has a journal entry: what arrived, when, and which request it answered. Every turn can be traced to its process, the messages it received and the code it ran (by binding hash), so the causes of any output can be recomputed.
4. **Containment.** A process can't reach past its grants, and it can't take the image down. This matters more than it used to: when recovery is replay, a crash of the whole image repeats on every recovery.

## 7. Principles

These are carried from the earlier documents unless marked as new.

**Record only what cannot be recomputed** (new). What the world says is written down, and everything else is worked out again when it's needed.

**Exceptional things are treated exceptionally** (DESIGN-001). The common case pays nothing for what only the exceptional case needs: provenance is recomputed when asked for, precise accounting is a library, and strong isolation is a separate image. Primitives exist so that policies can be built, and defaults exist so that nobody has to build them.

**Fair, not priced** (new). A tick is a share of the processor, not a price. There is one tick per step, and how many ticks a form costs may change between runtime versions (it is already implementation-defined). Preemption depends on the quota and never on the clock, or determinism is lost. What costs money is budgeted on the capability that spends it.

**Reasonable limits at human scale** (new). Nobody should need a spreadsheet to know what a program costs. Limits are coarse, and they protect the image, not a ledger. What one operation can build is capped, host exceptions become errors, and the host checks the heap between rounds. A kill the check decides is journaled like any other input.

**One way in, one way out** (earlier vision). Into a process comes a message; out of a process goes a host request. Nothing else crosses.

**The host owns the dirty world** (earlier vision). Time, randomness, I/O, models and storage are host requests, and the journal is where the dirty world is written down.

**Closed questions first** (new). Where a decision will do, ask a closed question whose answers are declared in advance. Open-ended generation is for what decisions can't do, and what it produces is data to check or code to contain.

**PIDs never leave the image** (earlier vision). Addresses cross between images; PIDs stay home.

**Suspension is the normal case** (earlier vision). An image can stop between any two host requests and continue from its snapshot and journal, whether the lid closed, the process was killed or the machine changed.

**Layers on top stay on top** (new). Sharing, merging, moving computation and placement are built from snapshots, journals, checkpoints and messages. None of them reaches into the evaluator.

**The floor is fixed** (DESIGN-001). The core language doesn't change underneath the code built on it. A small, fixed language also suits a time when models write much of the code: it is small enough to teach a model from one tutorial.

## 8. What changes

Compared with DESIGN-001 and the prototype as they stand:

| Area | Status | Notes |
| --- | --- | --- |
| Determinism, the journal, snapshots, replay | **The foundation** | New work; sections 4 and 10. |
| Containment | **Firm, coarse** | Caps on † operations, host exceptions as errors, a journaled heap check. Untrusted code runs in its own image with a heap cap. |
| Canonical encoding and hashing of values | **Firm, needed now** | The journal, snapshots and any later sharing all use it. It is the one part of the store layer that isn't separable. |
| Capabilities | Kept as they are | Grants and addresses, with no ambient authority. Agents are the reason. |
| Language, roles, environments, hot reload | Kept | A reload is a journaled input. |
| The CPI, the scheduler and plans | Kept, done for now | No more scheduling work unless a use needs it. |
| Metering | **Loosened** | One tick per step, with counts that may change between versions. No cost tables, and no tick-exactness for a future JIT, which only needs to be deterministic. |
| Agent budgets | **On capabilities** | An actor that holds a model namespace, counts what is spent, and can be cut off. |
| Models | **Two kinds, behind host namespaces** | Decisions (closed and typed, with probabilities) and generation, each with swappable backends: hosted, local and scripted. Section 5. |
| Per-actor durability protocols: acknowledgment with checkpoint, exactly-once bookkeeping | **Loosened** | Not needed for local durability. Mailboxes that outlive their process stay; parking and hibernation stay as memory features. |
| Merging and sharing | Later, on top | Irmin or another model, operating on values and documents, not on running state. |
| Moving computation, placement, the estate | Later, on top | An image moves as a snapshot and journal; an actor moves as code by hash and loop arguments. |
| Distribution between images | Later, on top | Images talk by messages. |
| The owner's gate, the verifier, the capabilities hash | Later | Model-written code is the first code from elsewhere, and it runs in its own image. |
| Promises and futures | Library idioms | Not runtime structures. |
| Phases, phase-time FExprs, the streaming pipeline | Shelved | The loader and roles cover loading. |
| Tapes, the mixer, JIT tapes | Shelved | The journal is the one tape that matters. |
| Refill and hierarchical quotas | Shelved | The round quota is enough. |
| Reflection beyond the pads | Shelved | Model-written code runs in its own image instead of being spliced into a process. |
| Deadlock detection | Shelved | A policy, if anyone needs one. |

## 9. Where the prototype stands

These parts carry over as they are:
- the CEK machine, with plain-data frames and constant-space tail calls;
- the CPI and its plans;
- roles, environments, binding hashes and hot reload;
- grants, and addresses and PIDs that code can't forge;
- bounded mailboxes, traps and parking;
- reclamation of processes and mailboxes that nothing can name;
- `tui::` and `http::`, whose events are delivered at `host::wait`;
- tests that compare exact traces under the virtual clock and the headless terminal.

The focus needs five things that aren't there yet:

- **State as plain data.** Parked continuations live in a runtime table under an integer key, addresses are counters, and values have no canonical encoding. A snapshot needs all of it as plain data with stable identities.
- **The journal.** The handler classification, recording, replay with effects suppressed, and time that advances only at journaled points.
- **Containment.** Today a process granted nothing can crash the whole image within a 1,000-tick quota. With a 1 GB heap, 26 doublings of a list with `append` exhaust it and the image aborts. The 29th doubling of a string with `string-append` passes V8's length limit, and the `RangeError` escapes uncaught.
- **The model namespaces** of section 5, with budgets; an outbound HTTP client, which the host doesn't have yet; and a separate image for code nobody trusts.
- **Provenance tools:** replay with tracing, and a way to ask for an output's causes.

### The arithmetic, at human scale

- The interpreter does 18 to 20 million ticks a second on an M2 Max (`PERFORMANCE.md`). On the same laptop, a message costs 2.3 µs when the host runs the rounds (`examples/ring/README.md`). The earlier vision's numbers assumed an engine doing 100 to 150 million steps a second. A rotation of 500 actors at 1,000 ticks each takes about 26 ms here instead of 5, which is fine for people.
- A process and its mailbox take about 1.2 KB, and an ended one costs nothing once nothing names it. The ring benchmark created 3.8 million processes on the laptop and peaked at 1.3 GB.
- At this scale, journals are small. These are rough estimates, still to be measured: an image that wakes once a second writes a few megabytes a day; a terminal UI at 60 frames a second writes about 150 MB a day before compression, mostly timestamps; and a thousand model calls a day come to about 5 MB.
- A snapshot costs time in proportion to the image, perhaps a second for 100,000 idle actors (also still to be measured), so it is taken at quiet points and by policy.

## 10. First steps

1. **Journal and replay.** Classify the handlers, record inputs, replay with effects suppressed, and make time advance only at journaled points (a spec proposal first). The acceptance test: record a Life runner session with real time and keystrokes, replay it, and compare every frame exactly; then do the same for a gateway session under load.
2. **Snapshots and recovery.** Parked state and addresses as plain data, a canonical encoding, snapshots at quiet points, and recovery that re-establishes listeners and subscriptions. The acceptance test: kill an image with `kill -9` mid-run, restore it, and finish with the same output as a run that was never interrupted.
3. **Containment.** Caps on † operations and host exceptions as errors (both spec proposals), and the journaled heap check. The acceptance test: the doubling programs fail only their own process, and a slow leak is killed at the same point on replay.
4. **Agents.** An outbound HTTP client in the host, then the decision and generation namespaces of section 5, each with a scripted backend for tests, a local one and a hosted one; budgets on the capability; thresholds that act, ask a person or escalate; pending actions awaiting approval; and code from a generative model run in its own image.
5. **Provenance.** Given an output, replay with tracing and show its causes.
6. **The flagship:** the research agent of section 3.

## 11. Costs and open questions

These costs are known now:

- **Replay needs the same runtime version.** A journal records the version that wrote it. Upgrading the runtime takes a snapshot first, and older journals replay only on the version that wrote them.
- **Journals grow.** Snapshots bound the time recovery takes, and retention decides how much history is kept.
- **Effects at a crash can repeat.** They happen at least once, with idempotency keys where it matters.
- **Replay covers the whole image.** One bad input affects the recovery of everything. That is why containment is firm, and why recovery needs a way to skip an input, which is itself a journaled decision.
- **Replay re-executes.** Recovery takes as long as the work done since the last snapshot, so busy images take snapshots more often.

Open questions:

1. One journal per image, which this document assumes, or one per actor, which moving a single actor with its history would want.
2. Where snapshots and journals live: in files, in SQLite, or as content-addressed objects. The choice meets the sharing layer later.
3. The shape of a provenance query. Causes at the level of messages are the default; tracking individual values is exceptional.
4. How a person approves an agent's pending actions: through a trap to the CPI, or through a mailbox that a user interface reads.
5. The model namespaces: their names and signatures, how a generative model's streamed answer is journaled (each piece is an input), how budgets are expressed, and which local decision model is the default for private data: a small encoder is fast but weak on open judgments, and DiffusionGemma is strong but needs about 16 GB.
6. Whether recovery is an explicit act or happens at start-up. The earlier vision says restoring is explicit, never a reflex of the host.
7. What the owner decides, and how, before a model's code runs in its own image.

## 12. What slight is not

- **Not everything the earlier documents describe, yet.** The store model, merging, distribution, phases and a JIT wait until the core stands.
- **Not a price list.** Ticks are fair shares.
- **Not BEAM-scale per node, not a cluster runtime, and not hyperscale** (unchanged from the earlier vision).
- **Not four PhDs.** It is one thesis, deterministic replay as the substrate for durable, explainable agent systems at human scale, and one product: a flight recorder for personal agents.

## 13. How this relates to the earlier documents

- **The earlier vision** (`design-002-ish/VISION.md`). Kept: the actor model, human scale, agents, and the principles above marked as its own. The estate moves to a layer on top, and its engine-speed arithmetic doesn't apply to this engine.
- **The baseline** (`design-000/vm-design-baseline.md`). Kept: bounded builtins (coarsely) and the limit on merging effects. Leases, keypair identity, pairing and encryption at rest wait for the layers that need them.
- **DESIGN-001.** Kept: the fixed core, plain-data continuations (which snapshots now rely on), the CPI, environments, capabilities, host requests and determinism (its section 12). Metering and per-actor durability are loosened. The store, merging and distribution move to layers on top. Phases, the pipeline, tapes, JIT tapes and most of reflection are shelved.
- **SPEC-CPI and `DECISIONS.md`.** Unchanged until proposals land. This document calls for four: time advancing only at journaled points; caps on † operations and an error for host exceptions; PIDs surviving a restore; and the handler classification.

When a new question comes up, ask whether it serves the four guarantees for the three uses. If it doesn't, it waits.

**On one line: slight remembers what the world told it and recomputes everything else, and that is how it survives, explains itself, and lets you ask what if.**

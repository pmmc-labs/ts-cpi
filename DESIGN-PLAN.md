# Plans: the host runs the desk, the CPI reacts

Sep 28, 2026 · draft, decisions agreed (see Decisions)

DESIGN-001 section 2 says the control plane "functions much like a
multi-track mixer". This note takes that literally, from what the prototype
has measured. A mixing desk has a setup (routing, levels, inserts, meters)
that is separate from the audio going through it. The engineer changes the
setup and reacts to what happens, and the audio never passes through the
engineer's hands.

- **The plan** is the desk's setup: plain data that says which processes and mailboxes exist, how they are connected, how they are scheduled, when they sleep and wake, and what is metered.
- **The host runs the plan.** It is the image's main loop.
- **The CPI reacts.** It builds the plan, edits it, and handles the events the plan hands it: escalations.

Today's prototype has the engineer passing every sample by hand. Once agreed,
what survives here moves into DESIGN-001, as DECISIONS.md text moves into
SPEC-CPI.

## Why: what the prototype measured

From `PERFORMANCE.md` (Sep 28, 2026), on the gateway example:

- **CPI code is 100 to 2,000 times slower than host code,** so any loop in the CPI over turns, requests, messages or frames costs more than the work it manages. Before `process::run-ready`, the CPI spent 9,400 ticks of its own on each hello request; the request itself took 430 ticks in two processes.
- **Taking the loop out of the CPI was the biggest win.** `process::run-ready` runs the round in the host, defined as the loop the CPI would have written. With metrics stubbed, throughput went from 5,941 to 13,602 requests a second, and the CPI's share of the CPU from 57% to 25%.
- **What remains in the CPI is more loops of the same kind:** metrics, about 90% of the CPI's remaining 5,800 ticks per request, and polling the mailboxes of sleeping actors, which halves throughput once 200 counters are asleep.
- **Speeding up the interpreter itself pays less.** Converting code lists to arrays once, the largest item in the interpreter's profile, was worth 10 to 14%.

The CPI is fast enough to decide. It is not fast enough to run things.

## What changes in DESIGN-001

Section by section, what the evidence supports changing. Everything not
listed stays: the core language, plain-data frames, parking at `recv` and
`join`, capabilities, environments, hashing, and effects either handled by
the host or trapped.

**Layers.** "The control plane interpreter is the image's main loop: it runs
processes with `(run pid n)`" becomes:

> The host's executor is the image's main loop: it runs the plan the control plane gives it. The control plane interpreter builds and edits the plan, and runs when the plan hands it an event: an escalation, a trapped effect, or an external event routed to it. It can still run processes itself with `(run pid n)`, and a control plane that wants no plan does exactly that.

**Section 2, the mixer.** The mini scheduler becomes the first plan node, not
a loop in the CPI. The bullet "The control plane as a tape" becomes the
centre of the section: the plan is a **control tape**, and a JIT tape is
either a control tape or a **process tape** (the code tapes the section
already describes). Both carry the same guarantee:

> A tape is indistinguishable from interpretation. A process tape produces the same values and host requests, in the same order, as the code it stands in for. A control tape produces the same stop reasons, deliveries and events, in the same order, as the reference program that defines its node.

**Section 4, the effect interface.** Add: "Which decisions the host makes and
which it escalates to the control plane is a per-node choice, as which
effects trap is a per-effect choice." Traps are already this idea for
effects; plans extend it to decisions.

**Section 12, scheduling.** "The scheduler is control plane code: a loop in the
control plane interpreter over the results of `run`" becomes: "Scheduling
policy is control plane code: the plan's round, quotas and refill quotas,
chosen by the control plane and run by the host. A control plane that needs
a policy the plan cannot express writes the loop over `run` itself."

**Determinism.** Still true on one thread. With parallel schedulers
(`parallel::`, next), it becomes: deterministic given a recording of the
order of deliveries between threads. That recording is a tape.

**Primitives and policies.** The policies marked "Provided" (round robin,
mailbox watcher, message-based quotas) become the plan's node vocabulary.
Add a row to the primitives table:

| Area | Primitives the design relies on |
| --- | --- |
| Plans | Build and edit a plan; run it until the control plane is needed; node kinds, each with a reference program in the language |

**Open question 4, the CPI's own failure.** A CPI that runs per event can be
given a quota per event. A handler that never returns becomes a detectable
fault, not a hung image.

## The rules

1. **Every node kind has a reference program** written in the language, and the host's node must be indistinguishable from it. `process::run-ready` is the first: it is specified as the loop the CPI could write. The two are tested against each other, as the Life runner's engines are checked against the reference.
2. **The plan is optional.** `process::run`, `park`, `unpark` and every other primitive stay. A CPI can run with an empty plan and do everything itself, only slower. Nothing the Life examples do may become impossible.
3. **The CPI sees events, not turns.** Escalations arrive as a list of events, like `run-ready`'s. A node escalates only what it cannot decide from its parameters.
4. **Edits take effect between rounds,** so a run stays deterministic: the plan, its edits, the external events and the CPI's answers to escalations are a complete recording of it.
5. **Per-request, per-turn and per-frame work belongs to nodes.** If the CPI has to do something for every request, a node is missing.

## A first node vocabulary

Drawn from the gateway and DESIGN-001's defaults. Each would be a spec
change, proposed and measured one at a time.

| Node | What it does | Escalates | Today |
| --- | --- | --- | --- |
| round | One batch per ready process, quota `n` | Exits, failures, traps, idle | `process::run-ready` (built) |
| watcher | Notices mail for a parked receiver | "Mail for this parked process", or unparks it itself | The CPI polls `mailbox::size` for every sleeper, every loop |
| pool | Receivers on one queue from a template: grow on backlog up to a maximum, park idle ones down to a minimum | Nothing, or "pool at its maximum" | `scale-hello` and `sleep-idle` in CPI code |
| monitor | A faux actor: aggregates what it is sent and what it is subscribed to (the served log, ticks by group, queue lengths) into counts and histograms, and redraws the view when something changed | Keys from the view, and the summary on request | `record-served`, `sample-queues`, `add-ticks` and the monitor's frames in CPI code |
| supervisor | Restarts from the checkpoint, retries, or stops, by DESIGN-001 section 5's defaults | Restart intensity exceeded | Life example 13 and the actors examples, in CPI code |

The router stays an actor. Routing could be a node, a patch bay on the desk,
but it is user code in the gateway, and the plan should not swallow what
users write as actors.

## The gateway as a plan

An illustrative sketch, not proposed syntax:

```lisp
(plan
    (round 200 :idle 2000)
    (process router :code router-code :args (routes) :mailbox router-box :supervise restart)
    (process counters :code counters-code :args (inbox ()) :mailbox counters-box :supervise restart)
    (process slow :code slow-code :mailbox slow-box)
    (pool hello :template hello-template :queue queue :min 1 :max 4 :cold #true)
    (watcher counter-mailboxes :wake unpark)
    (monitor view :served http-log :key first-segment :bins (1 2 5 10 20 50 100 200 500 1000) :ticks-by kind :queues (queue counters-box slow-box router-box inbox))
    (escalate inbox))
```

Each part of `gateway.slight`'s supervisor loop, and where it goes:

| Loop today | Goes to | Cost today (hello, 8 clients) |
| --- | --- | --- |
| `run-round` | round node (done) | was 41% of the CPI's ticks with metrics stubbed |
| `scale-hello`, parking idle hello workers | pool node | small per loop |
| `wake-counters`, parking idle counters | watcher node, idle from the round | hello 854/s with 202 counters asleep, 2,505/s without the polling |
| `read-served-log`, `sample-queues`, charging ticks | the monitor faux actor | about 90% of 5,800 CPI ticks per request |
| `handle-inbox`: `/system` requests, `make-counter` | escalations: CPI code | per event |
| `start-gateway` | CPI code that builds the plan | once |
| the monitor's view | the monitor faux actor, redrawn when something changed | 13 to 25 ms a frame |

What is left for the CPI is what it should decide: making a counter for a
new name, answering `/system` requests, and changing the plan (a new
maximum for the hello pool, from the monitor's `+` key).

## When the plan is empty

`examples/life/17-amb.slight` decides at every `recv`: it parks a process,
unparks it twice, and sends each copy a different answer. No node could
express that, and none should. It keeps running as it does today, with an
empty plan and its own loop over `process::run`. The same holds for
`12-timer-wheel.slight`, which reads the board back from wake times.

These are the desk with every channel routed to the engineer. The plan
makes the ordinary case fast; the exceptional case stays possible.
DESIGN-001's second principle says exactly this: "Exceptional circumstances
should be treated exceptionally."

## Tapes

- **Control tapes** are plans. A node's host implementation is a hand-written JIT tape of its reference program.
- **Process tapes** are DESIGN-001's code tapes: inlining, threading, bytecode, rebuilding plain frames at `recv` and `join`. They matter more now that process batches are a quarter of the CPU, but they come after the plan.
- **Recording.** A run is the plan, its edits, the external events and the escalations with the CPI's answers. The headless HTTP script format is already a recording of external events.
- **Derived plans, later.** A tracing JIT could record the CPI's own loop and compile its steady state into a plan, with guards that fall back to the CPI. Declared plans come first, in a form a tracer could also produce.

## Parallelism, next

A plan divides into parts, and each part can run on its own scheduler
thread. The CPI supervises the plan, not turns, so it is off the path of
every thread. Groups, which `run-ready` left out, arrive as the parts of a
plan, and hierarchical quotas (DESIGN-001 section 12) as each part's budget.

## Decisions (Sep 28, 2026)

1. **Whole plans.** The CPI builds a plan as plain data and hands it over whole; the host works out what changed. A plan is the desk's setup, not every voice on it: the members of a pool, or the counters made one per name, live in their node's state, so the plan does not grow with them and an edit stays small.
2. **One blocking request** runs the plan until the CPI is needed and returns the events: `run-ready` and `host::wait` fused. The CPI's loop becomes one call per batch of events.
3. **Host nodes only.** Nodes are written in the host. Compiling a node written in the language (a derived tape) is left for later.
4. **Equivalence is an exact trace.** Each node's reference program acts between rounds, and a test runs the same scripted scenario under the virtual clock twice, once with the reference program in the CPI and once with the host node, and compares stop reasons, deliveries, parks and unparks, and responses. The Life runner's engine check is the model.
5. **Metrics and display are one faux actor.** A host node with an address: anything can send it events, it aggregates in the host (the served log, ticks, queue lengths), and it redraws the view when there is something new, with no frame rate of its own. It looks like an actor to the rest of the system, but no interpreted code runs per request.
6. **sys/ actors have full CPI privileges.** A sys/ actor is a real process, running code in the language, granted the privileged namespaces. This is a spec change: SPEC-CPI section 10 says an ordinary process is never granted them. The faux actor in 5 is a host node, not a sys/ actor.

## Findings from step 1 (`plan::run`, Sep 28, 2026)

- **Built and measured.** With no served log to read, the gateway's CPI used 0.1% of the CPU and hello reached 17,416 requests a second (`PERFORMANCE.md`). The CPI now wakes once per batch of events.
- **The inbox node already watches.** Putting a sleeping counter's mailbox in the plan's inbox makes its first request wake the CPI, which unparks that counter. That is the watcher's escalating half, with no new node.
- **But whole plans cost the size of the plan on every edit,** and the CPI builds the plan in interpreted code. With 500 counters asleep, each one falling asleep rebuilds a 600-address list. Sleeping counters are voices, not the desk's setup: the watcher (step 2) should hold parked receivers in its own state, and could unpark them itself.
- **A wait inside a plan is capped at the round's idle threshold,** so idle processes are reported at most that late; without the cap a long timeout would hide them.
- **The pool now scales once per wake, not once per round.** In the gateway test's burst it added two workers where the round-by-round loop added three. The pool node (step 4) brings scaling back to every round, in the host.

## Open questions

1. **The plan's shape.** Which fields each node kind has, and how the host diffs two plans: by node name, with a changed node's state carried over where its kind allows.
2. **Escalations while the CPI works.** Events that happen while the CPI handles a batch wait for its next call; nothing runs meanwhile, as today. Should the executor keep running the plan during a long CPI handler? Not while there is one thread.
3. **sys/ and usr/.** What sys/ actors are for, once the faux actor covers metrics and display: supervisors written in the language, per-subsystem control planes? And whether a sys/ actor's privileges should be narrowed later (for example, to the namespaces it declares).
4. **The CPI's quota per event** (DESIGN-001 open question 4): what happens when a handler exceeds it.

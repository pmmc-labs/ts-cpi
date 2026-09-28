# Specification: HTTP namespace (draft)

Sep 28, 2026 · Accepted and implemented · Extends `../../design-xxx/SPEC-CPI.md` and `SPEC-TUI.md`

This document specifies `http::`, a privileged namespace through which the
CPI accepts HTTP requests as messages and through which any process holding
a request's reply address can answer it. Section 9 records the decisions
made in review.

## Conventions

As in SPEC-CPI: **must** is required, **should** is followed unless there is
a stated reason not to, signatures are written `(name arg ...) → result`, and
rationale is set apart.

## 1. Scope

`http::` turns an HTTP server into an external event stream (DESIGN-001
section 11), the second after terminal input (SPEC-TUI section 6). Its driving
example is a gateway: a router actor receives requests and forwards them to
endpoint workers, which answer them directly.

- `http::` is privileged. Only the CPI can start or stop listening. A process never needs the namespace: it answers a request by sending to the request's reply address with `actor::send`.
- Requests and responses are plain values. The host parses HTTP and writes it; the language never sees bytes or sockets.
- Out of scope: TLS, streaming or binary bodies, WebSockets, and HTTP clients.

> **Rationale.** ts-slight's `(connect :keypress (Actor))` spawned an actor
> and attached a named source to its PID. In the CPI a source is attached to
> an address instead, as `tui::subscribe` already is. The address outlives any
> one process, so a restarted worker keeps its stream, and a mailbox with
> several receivers is a work queue, so subscribing a pool's shared address
> balances requests across the pool with no dispatcher.

## 2. Builtins: `http::`

| Signature | Result | Errors |
| --- | --- | --- |
| `(http::listen port addr timeout)` | `#true`. Accepts HTTP requests on `127.0.0.1:port` and sends each to `addr` as a request message (section 3). A request not answered within `timeout` milliseconds is answered `504` by the host. | `bad-state` if already listening on `port`, or the port cannot be opened; `type-error`. |
| `(http::close port)` | `#true`. Stops accepting on `port`. Requests already delivered can still be answered. | `bad-state` unless listening on `port`. |

The host stops every listener when the image exits, or when the CPI fails
(SPEC-CPI section 12), and answers requests still waiting with `503`.

## 3. Requests

A request arrives as the message:

```lisp
(request reply-to method path query headers body)
```

| Field | Value |
| --- | --- |
| `reply-to` | A reply address for this request (section 4). |
| `method` | A lowercase symbol: `get`, `post`, `put`, `delete`, ... |
| `path` | The list of decoded path segments as strings: `/users/42` is `("users" "42")`, and `/` is `()`. |
| `query` | The query parameters, in order, as a list of `(name value)` string pairs. |
| `headers` | The headers, in order, as a list of `(name value)` string pairs, names in lowercase. |
| `body` | The body as a string, `""` if there is none. |

A path as a list of segments makes routing a walk down a list, and lets an
endpoint pass the rest of the path to a child endpoint.

## 4. Reply addresses

A **reply address** is an address minted by the host for one request. The
host is its only receiver.

- Sending `(response status headers body)` to it answers the request: `status` is an integer, `headers` a list of `(name value)` string pairs, `body` a string. The host writes the response when the send is delivered: at once from the CPI, or when the sender's batch ends (SPEC-CPI section 11).
- A reply address takes one message. After it, or after the host has answered `504` or `503`, or after the client has disconnected, the mailbox is **closed** (DECISIONS.md, "Several receivers on one mailbox"): later sends go to the dead-letter queue.
- A message that is not a well-formed response is not written. The host answers `500`, closes the mailbox, and records the message as a dead letter so the mistake can be found.
- A send to a reply address never fails with `full`.
- `mailbox::size` and `mailbox::take` on a reply address, and `process::spawn`, `http::listen` or `tui::subscribe` onto one, throw `bad-state`: no process or CPI can receive on it.

A reply address is an ordinary address in every other way. It can be sent in
messages, stored and forwarded, so the process that answers need not be the
one that received the request.

> **Rationale.** This is DESIGN-001's "one-shot reply mailbox per request"
> (section 10), which is also how futures answer remote computations. Holding
> the address is the capability to answer that one request, and nothing else:
> a worker needs no grant, and the CPI does not handle each response. When
> workers move to other images, the reply address travels with the request
> like any address.

## 5. Delivery

Requests are external events and follow SPEC-TUI section 6:

- Requests are delivered only while the CPI is suspended in `host::wait`, in the order they arrived. `host::wait` returns when a request is waiting (amends SPEC-TUI section 9). A request makes no process ready by itself; a receiver blocked in `recv` on `addr` is woken as for any message.
- Every request that arrived is delivered, even if its client has disconnected since; its reply address is then already closed.
- `host::wait` returns the PIDs of the receivers a delivered request or input event woke, as well as the sleepers whose deadlines passed (SPEC-CPI section 10.3: "the list of PIDs that became ready").
- If `addr` is full, the host answers `503` at once and records a dead letter.
- If `addr` is closed, the host answers `503` and records a dead letter.

A CPI that is always busy never calls `host::wait`, so it accepts no
requests. A gateway's scheduling loop should call `(host::wait 0)` every so
many batches, which delivers what is waiting and returns at once.

> **Rationale.** One entry point for external events keeps the CPI's view
> of its mailboxes deterministic between `host::wait` calls (SPEC-TUI
> decision D2), and it is the single place a recording of the image's input
> would be taken. The cost, request latency bounded by how often the CPI
> waits, is what running workers in other images would remove.

## 6. Time

A request's timeout is measured on `host::now`. Under the virtual clock
(tests only), it expires when `host::wait` moves the clock past it.

## 7. Testing

The host provides a **headless** HTTP backend for tests, selected only
through the `Runtime` constructor, like the headless TUI. Requests come from
a script and responses are recorded in the order they were written, with
clients that disconnected recorded as such. Under
the virtual clock, each scripted request says how long after the previous one
it arrives. Requests due at the same moment arrive together, as a burst, and
`host::wait` moves the clock to the next arrival as it does to a sleeper's
deadline. A test can therefore drive a gateway through bursts and quiet
periods deterministically and assert every response.

The real backend uses Node's `node:http` on the loopback interface.

## 8. What this changes elsewhere

**SPEC-CPI**
- §10.2: a mailbox may have the host as its receiver (section 4).
- §10.3 `host::wait`: a held request is a wake source.

**SPEC-TUI**
- §9: the wake sources gain held HTTP requests, and the PIDs `host::wait` returns include receivers woken by delivered input events. Before, it reported only sleepers.

**The prototype**
- `mailbox::` checks reply addresses (section 4).
- A `Runtime` option selects the HTTP backend, as `tui` does.

## 9. Decisions

Accepted Sep 28, 2026, each as recommended.

| # | Question | Decided | Alternative considered |
| --- | --- | --- | --- |
| D1 | The API's shape. | A namespace per source, `http::listen` beside `tui::subscribe`: each source has its own configuration and lifecycle, and the namespace is the capability boundary. | A generic `(host::connect source config addr)` for every stream, as ts-slight's `connect`. Worth doing once a third source exists; delivery through `host::wait` is already one door either way. |
| D2 | How a request is answered. | A reply address per request (section 4). | `(http::respond id response)`, privileged: every response passes through the CPI. |
| D3 | When requests enter mailboxes. | Only in `host::wait` (section 5), as for keys. | Whenever the host gets control: lower latency, but mailboxes change during `process::run`. |
| D4 | A full or closed mailbox. | Answer `503` at once. | Drop the request, as a key is dropped: the client waits for its own timeout. |
| D5 | An unanswered request. | Answer `504` after the `listen` timeout, then close the reply address. | No timeout: a lost request holds the connection until the client gives up. |
| D6 | The body. | A string. Parsing it is the application's job, and path segments stay strings too; both are revisited later. | Parse `application/sexp` bodies into values. That needs a reader the language can call, which is a core change of its own. |

## Open issues

- The language has no reader it can call, so an s-expression body stays a string. `(string->value s)` would be a core operation, with a load-error-like error for malformed text.
- No builtin makes a string of a number except `value->string`, and none parses one, so a path segment `"42"` cannot become the integer `42`. `string->number` is a small core addition.
- Headers and query parameters are association lists. Roles would give named lookup, but a role per request is heavy; an `assoc` in a library is enough for the example.

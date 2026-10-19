# Maintaining this plugin

The plugin is one file of logic and two pieces of data, and the data is the part
that goes out of date. This is how to look after it.

## What is actually fragile

`fingerprint.json` holds a capture of a real OpenCode: the wording of the tools
its free tier knows by name, and the User-Agent that identifies it. Zen accepts a
request only when the whole of it matches one generation of OpenCode, so when
OpenCode changes any of that, the copy here stops being accepted.

Nothing about a stale copy looks different from a working one. The symptom is a
`403 FreeTierError` on every request, which reads as "you are not OpenCode" and
sends people off to change headers.

## Limits Zen under-reports

`models.mjs` declares each model's limits from Zen's catalogue, and for some free
ids the catalogue is wrong in the one direction nothing complains about: too
small. `mimo-v2.6-flash-free` is declared 200000/32000 against a model whose own
vendor publishes 1048576/131072. The ids the tier added on
2026-10-16 were under-reported the same way on the day they appeared:
`ll-alpha-free` names a 262144-token completion ceiling in its own refusal
against a declared 65536, and `glm-5.3-flash-free` is declared 200000/32000
while its paid twin `glm-5.3-flash` is declared 1000000/131072 in the same
catalogue — and a 232685-token prompt was served through the free id, which the
declared window does not allow. `space-bunny-free` under-reports on a third
axis, its `input`: the catalogue derives that number from its own pair
(`context − output`, 524288) while prompts of 535,110, 935,110 and 979,550
tokens were served through the free id, and the axis is what a host that shows
a window shows: magpie's `context_window` and `max_input_tokens` both follow it
when one is declared, and the window it reports is the smaller of the two, so
the derivation was on screen as half a window. That is the same fact the rule
below restates at run time, which is why an under-declared `input` now follows
the window, wherever that window came from.

All of these numbers are acted on. The window decides when a conversation is
compacted and how much of it is ever sent; the output cap is sent as
`max_tokens` on every request, so a reply is cut at it with a finish reason that
reads like the model's own decision; the `input` axis is the size a
window-showing host displays. A window that is too small is never refused, it is
just quietly never used, which is why this stayed invisible for so long.

`limits.mjs` holds what was measured, per axis, with the catalogue value it was
measured against. Each axis carries `samples` and `how`; the short of it:

| id | axis | value | from |
| --- | --- | --- | --- |
| `deepseek-v4.1-flash-free` | context | 326000 | the last point this route is measured to serve (326,702), rounded down on 2026-10-19 because its refusal names no number and refuses 326,750 itself |
| `deepseek-v4.1-flash-free` | output | 384000 | the paid twin's figure, and nothing on this route confirms it today: the `[1, 393216]` sentence did not reproduce on a 2026-10-19 re-ask, which was answered 200 |
| `mimo-v2.6-flash-free` | context | 343000 | the route's own enforcement, found by bracketing on 2026-10-19 (343,131 tokens served, a prompt of about 407,725 refused), not the 1048576 the route used to state |
| `mimo-v2.6-flash-free` | output | 131072 | the vendor's own catalogue entry |
| `big-pickle` | context | 343000 | the route's own enforcement, found by bracketing on 2026-10-19 (343,131 served, about 407,725 refused), an axis an earlier sweep had left to the catalogue |
| `big-pickle` | output | 131072 | the ceiling the route names when it is asked for too much, named again on a 2026-10-19 re-ask |
| `nemotron-3.5-lightning-free` | context | 1000000 | the route's own refusal, in its own words |
| `longcat-2.5-preview-free` | output | 262144 | the ceiling the route names when it is asked for too much |
| `ll-alpha-free` | output | 262144 | the ceiling the route's own refusal names, against a declared 65536 |
| `glm-5.3-flash-free` | context | 311000 | the route's own enforcement, found by bracketing on 2026-10-19 (311,109 served, about 343,348 refused), not the paid twin's 1000000 |
| `glm-5.3-flash-free` | output | 131072 | what this route declares for the same upstream model |
| `space-bunny-free` | input | 1048576 | the window this route declares for the same id, with prompts of up to nearly twice the declared input served |

A prompt sized just over the window is refused with

```
This model's maximum context length is 1048576 tokens. However, you requested
1422278 tokens (1038278 in the messages, 384000 in the completion).
```

which is the route stating its own window, and better evidence than any vendor
page. The output figure is the paid twin's declaration, so the route has already
published what that model does; a single reply of 306,880 completion tokens
(`finish_reason: stop`) was watched and is recorded as the witness. The route
states that ceiling on some endpoints and not others: on 2026-10-19 an ask above
it was refused with `Invalid max_tokens value, the valid range of max_tokens is
[1, 393216]`, and a later ask that day for `max_tokens` 1000000 was answered 200
instead. So 384000 stands — nothing on this route has contradicted it — and
nothing confirms it either. Where the range sentence does appear, the live
statement is applied as it stands for the rest of the process, so it outranks the
twin-derived figure this table carries.

The DeepSeek id was the first entry measured this way and is no longer one: its
1,048,576-token window was withdrawn on 2026-10-19, when the route began
refusing prompts past a wall it no longer names. The paragraph below is for a
route that still names its window; what to do when it stops is the subsection
after it.

**Re-measuring.** The window: send a prompt of about 1.05M tokens and read the
number out of the refusal, three times, interleaved, per the rule below. The
filler measured 4.887 characters per token with about 1700 tokens of fixed
request overhead, and a request that is *served* says nothing about where the
wall is — it is what the calibration is checked against, since
`usage.prompt_tokens` is the real count while the refusal's "requested about"
figure is a rough one (characters, not tokens) and must not be read as a count.
A second upstream words the same fact as "This endpoint's maximum context length
is …" and breaks the request into text input, tool input and output.

**When the refusal stops naming the number.** Measured 2026-10-19 on
`deepseek-v4.1-flash-free`, and the shape to expect on any id this route starts
validating: a prompt past the window came back 400 with a body that names no
number at all —

```
{"error":{"message":"Your request resulted in more tokens than this model's
maximum context length allows. Please reduce the length of the messages or run
compaction.","type":"invalid_request_error","code":"context_length_exceeded"}}
```

— while the same run's `max_tokens` over the ceiling was refused *with* its
range: `Invalid max_tokens value, the valid range of max_tokens is [1, 393216]`.
The route states that ceiling on some endpoints and not others, though: a re-ask
the same day for `max_tokens` 1000000 was answered 200 with no number in it, so
that sentence is a statement to read when it appears rather than one to count on.
Nothing in `limits.mjs` reads the first wording, and it should not be made to:
it states no number, so any value taken from it would be the reader's guess.
What is left is a bracket, and it has to be measured in characters rather than
tokens, because a refused request reports no `usage.prompt_tokens`: 1,522,400
characters of this file's filler were served and counted 326,702 tokens, while
1,522,800 was refused — putting the wall within roughly a hundred tokens of
326,750, at 4.66 characters per token measured on that run. Two further probes
placed it there: 1,522,000 characters (326,617 tokens) served, 1,524,000
refused, and `max_tokens: 100000` alongside a 300,573-token prompt served, so
the two limits are enforced independently of each other. Six more sessions were
asked 250,413-token prompts and all six were served, which says the wall is not
somewhere below the biggest served sample.

The axis is set from that bracket, not from a statement: `limits.mjs` carries
**326000** for this id — the largest point the route is measured to serve
(326,702), rounded down, because a host has to stop below the wall and the wall
itself refuses the exact figure too: 1,522,600 characters, about 326,745
tokens, was asked three times and refused three times, so 326,750 cannot be the
declared budget. It is deliberately not the catalogue's 200000: the route
serves more than that from every session tried, and a window set there is the
quiet under-use this file exists to remove. It is not the old 1,048,576 either —
the refusal that named that figure has been replaced by one that refuses a third
of it. The remaining margin is also about the endpoints: on the same day, a
host's 254,196- and 279,095-token requests were refused in the same words while
a 331,989-token request was served, so an endpoint that says no sooner can be
reached at any size above 200000. Re-measuring means bracketing on fresh
samples, not reading a number: this refusal will not name one, and the wall
behind it moves.

**The input**, the third axis: nothing cheap names it — the refusals on this
route name the window, and this id's own refusal names nothing at all — so it is
measured by serving. A prompt sized past the declared input is the measurement
(535,110, 935,110 and 979,550-token prompts each came back with the needle at
their end echoed, and `usage.prompt_tokens` is the count that says how much was
served), and the window the catalogue declares for the same id bounds the value
from above: a request placed over it is refused. A measurement of its own is no
longer the only way the axis moves: at run time the axis follows the window, from
the table, from the sweep or from a window the route names while the plugin runs,
and an `input` the catalogue declares under that window is raised to it, which is
the rule stated in full under what a model is actually given below.

The ceiling, which is cheaper than the window: ask for `max_tokens: 1000000` on a
short prompt and stop reading as soon as the answer starts. An upstream that
validates the ceiling refuses and names it — `max_tokens is too large: 1000000.
This model supports at most 131072 completion tokens`, or LongCat's
`/max_tokens: 1000000 is not less or equal to 262144` — and one that does not
just begins to answer, so the cost of asking every model is a few tokens each.
There are three wordings now, all of them in `limits.mjs` (`namedOutputCap`) and
all of them read from production refusals as well, which is how a ceiling that
moves gets noticed without anyone running anything: the two above, and this
route's own range — `Invalid max_tokens value, the valid range of max_tokens is
[1, 393216]` — where the ceiling is the upper end of the interval it says it
accepts. The range pattern carries its own end, the closing bracket being part of
it, so a read that stopped inside the digits matches nothing and leaves the axis
unread; the two older wordings end on their number, and those depend on the
reader noticing where the read stopped (`digitsEnd`) before it trusts what it
read.

The output: a paid twin's `limit` in `https://models.opencode.ai/api.json` is
the stronger source, and re-reading it is the whole job. With no twin — `mimo`
has none — the figure rests on the vendor's own entry, which is weaker evidence
and has to say so in `samples`: what is declared is what a vendor publishes, not
something watched. A value Zen accepts is not evidence — `max_tokens: 2000000`
under a short prompt answers 200 and writes nothing like it, and `mimo`'s refusal
came back with the 200000 it was asked for rather than with a ceiling — and
neither is a generation nobody watched finish.

The evidence tiers are `route`, `route-twin`, `route-sweep`, `vendor` and
`witnessed`, in that order. The table here draws on `route`, `route-twin` and
`vendor` only: `route-sweep` is a measurement on this same route taken by a
machine rather than by hand, read at run time from the file the scheduled sweep
writes rather than written into this file, and it answers where the table has
nothing to say (below); `witnessed` - a generation somebody watched finish - is
used by nothing that ships here, and is accepted because `limitOverrides` is
exported and a caller may hand it a table that says so, while no shipped entry
says it. A live refusal is not an entry either: `observeRouteStatement` applies
one to the running process, for the rest of that process, and needs no record in
this file.

**What voids it.** Each axis records the catalogue value it was measured
against, and an axis whose declaration moved is dropped rather than kept: a
measurement of one question is not an answer to another. A catalogue that raises
the free id to the paid twin's figures therefore makes this file inert on its
own, which is the intended end state.

**While the plugin runs.** A refusal that names a window is read on its way past
(`observeRouteStatement`, called from the provider's `fetch`), and it corrects
that model's window for the rest of the process. The list is rebuilt at every
start and hourly after, so a route that changes the window it enforces is
followed without anyone editing this file. That correction is not written down: a
restart falls back to what is measured here and to the bracket below. The `input`
axis has no live form of its own: the refusals this route sends name a window and
a completion ceiling, and never an input cap. It does follow a window this
process was told about, though, exactly as it follows one from the table or from
the sweep: where the route names a window that the catalogue's `input` sits
under, that `input` is raised to it for the rest of the process, which is what
keeps the route's own answer from being shown as a smaller catalogue number.

**The wall is learned while the plugin runs.** Everything above was measured by
somebody by hand and written into a table, and that does not scale: the wall this
route enforces moved under one id on 2026-10-19, and the only reason it was
noticed is that a conversation filled the window and every request after it was
refused. The plugin already sees the traffic that would have shown it, so
`limits.mjs` keeps a bracket per model id and moves it only by what the route
itself answers, out of requests the host was making anyway. Nothing in this layer
sends a request of its own: a model nobody asks anything of is never probed, and
its declaration is exactly what the table and the catalogue said.

The two ends of the bracket are the two answers a route can give. `floor` is the
largest request the route is known to have served and `ceil` the smallest it is
known to have refused; `ceiling` is what the plugin then declares, and the one
number a host acts on, because it is what a conversation is compacted at and what
decides whether a request is worth sending at all. Both ends are read from the
characters of the request through one estimate rather than two, because a floor
and a ceiling read through different estimates are numbers on different scales
and the search between them would be searching a scale nobody declared in:
`estimateTokens` counts a Chinese, Japanese or Korean character at 0.7 of a token
and everything else at the route's own measured 4.66 characters per token, and it
reads only the strings a request body carries, so the JSON written around them is
not counted either. The script awareness is the point of it — a window declared
from a Latin ratio alone would come out at a third of the real one for a wall of
Chinese text, which is the under-declaration this section exists to remove — and
what keeps the estimate honest is the structure around it rather than its
precision.

**What the declaration is, and what moves it.** `ceiling` is the largest of three
numbers: the proven floor plus the current step, the seed, which is the table's
value while the catalogue still declares what it was measured against and the
catalogue's own number when it does not, and the value already declared. It is
then held under the bound a refusal puts on it and under the cap, and never below
1. `step` is how far above the proven floor the declaration is willing to go:
seeded at 5% of the seed and at least 1024, doubled each time a raise is taken
(by at least 1024, and capped at a quarter of the seed, with 4096 as the smallest
that cap may be) and halved on every refusal (never below 1024). The bound is the
size the route refused, once it has refused one: a declaration may not sit on a
size the route turned down, and where the refusal named no number the bound is 2%
under it, while a window the route named is exact and may be declared as it
stands. The cap is `OPENCODE_ZEN_FREE_MAX_WINDOW`, 1048576 by default, and it is
read as at least the seed, so it only ever holds back a value the search raised
and never cuts down a number the table or the catalogue declared.

**Not every refusal is about the window.** An answer that is not 200 is not
evidence about size by itself: the route's failures wear the same clothes, and a
500, a rate limit and a 400 about a parameter it did not accept arrive as readily
as a prompt that was too long. Reading one of those as a wall would declare a
model smaller than the route had just served it, at the cost of part of a budget
that is four refusals deep: on 2026-10-19 `nemotron-3.5-super-vl-free` answered
two asks with a 500 and then served the identical sizes, and `space-bunny-free`
answered a ceiling question with `400 invalid request`. So the axis is decided
before anything is recorded (`refusalAxis` in `limits.mjs`), and only an answer
that is about the window moves the window. A number the refusal names decides it
first, because a numbered sentence is the route stating a limit and cannot be
anything else; failing that, only 400 and 413 can be about size, and the words
have to say so — `context_length_exceeded`, a maximum context length or a token
count the request went past, a prompt or messages said to be too long, or the
instruction to reduce the length of the messages. A refusal about `max_tokens` is
the other axis and is recorded as one; an answer that says neither —
`invalid request`, an empty body, a 500 — is about no axis and moves nothing.

**A refusal the route contradicts stops counting.** `ceil` only ever comes down,
so a bound drawn by one endpoint that was about to fail would be permanent, and
the declaration could never again climb over a size the route had in fact served.
That is not hypothetical: on 2026-10-19 `big-pickle` answered a 1,600,000-character
prompt with a 400 and then served that identical request, counting 343,131
tokens. So a served request at or above a size that was refused clears the bound
and gives the refusal back to the budget, and the note it reports is
`wall-unrefused`; `refusals` counts the refusals the file still believes rather
than the refusals that happened. A window the route named in its own words is
exempt, because that is the route stating a limit rather than one endpoint
misbehaving: every named number the sweep re-asked held still.

A raise is demand-driven, and that is the whole of the search. The host filling
the declaration, which is the largest request the route has served reaching 90%
of what was declared, is the only evidence there is that it wants more room: a
model whose traffic sits well under its window is left alone rather than given a
bigger one to not use, and when the host does fill it the step doubles and the
declaration moves above the floor. A raise also waits out a cooldown
(`OPENCODE_ZEN_FREE_LIMITS_COOLDOWN_MS`, 900000 by default, which is fifteen
minutes), and a refusal stamps the same clock, so probes are spaced whichever way
the last one went. The cost is the part worth being plain about: a probe that
overshoots costs one refused turn, paid for by whoever was working with the
model, so a refusal below the bound so far tightens it to 2% under the size it
refused, halves the step and returns the declaration to the floor, and once four
refusals the file still believes have accumulated, the search stops raising for
that model; a record counts those refusals so an entry can be explained
afterwards. That is what makes the probes converge instead of oscillating: the
first refusal in a run is the largest, the next probe is under 98% of it, and the
declaration comes to rest at or under the largest size the route is known to have
served rather than on one nobody proved.

**What survives a restart.** A bracket forgotten on every restart is a bracket
re-learned by being refused again, which is the cost this layer exists to avoid,
so it is written to one small JSON file rather than derived again.
`OPENCODE_ZEN_FREE_LIMITS_STATE` names that file, and an empty value keeps the
state in memory only; unset, it is `limits.json` under `opencode-zen-freex` in
the cache directory the platform uses — `%LOCALAPPDATA%` on Windows, else
`$XDG_CACHE_HOME`, else `~/.cache`. The write is atomic, a temporary file beside
the target and a rename over it, because a half-written state file would be read
as a bracket somebody measured; it happens at most once per
`OPENCODE_ZEN_FREE_LIMITS_STATE_DEBOUNCE_MS` (5000 by default, and 0 writes
straight away) and never delays a request. The read is tolerant in the same
direction: a missing file, an unreadable one, one holding another shape or a
version this build does not know is simply no state, and the process starts from
the table; every field is checked before it becomes a record, and the file is
bounded at 500 models and 256 KiB. Nothing here may fail a request: a file that
cannot be written is a bracket that is not remembered, and a file that cannot be
read is a model with no history.

**What a model is actually given.** The context axis has five tiers, and the
order is the order they are consulted in: a window a refusal named while this
process was running, which is exact and applied as it stands; then the bracket's
ceiling, which exists only because a request was served or refused and so speaks
about the wall as it is enforced now; then the shipped table's entry, while the
catalogue still declares what it was measured against, so the table has the first
word for an id it names; then what the scheduled sweep measured on this same
route, which is the tier that answers for an id the table never named and for an
axis whose catalogue value has moved since, and which may lower a declaration
only when the wall behind it was bracketed; and last the catalogue's own number.
Whichever of them settles an axis is also what a fresh record is seeded from, so
the search starts from the table's number where the table answers and from the
sweep's where it does not, while the bracket the route teaches keeps the last
word either way. The bracket is route evidence by construction and is not bound
by the raise-only rule the weaker tiers obey, which is the point of it: it may
lower a declaration as well as raise it, and what it lowers to is the largest
size the route is known to have served. The output axis keeps its own tiers and
gains a third wording: besides the completion ceiling an upstream names when it
refuses the ask — `supports at most N completion tokens` — and LongCat's `is not
less or equal to` form, it now reads the range this route answers an oversized
`max_tokens` with, `the valid range of max_tokens is [1, 393216]`, and takes the
upper end of it, which is the ceiling the route says it accepts up to. The
`input` axis still has no refusal form - no refusal this route sends names an
input cap - but it is not static any more: it follows the window, and the window
may be answered by the table's entry while that entry still applies, by the
sweep, or by a refusal that named it while this process was running, which is the
strongest of the three and is taken as it stands. Where the catalogue declares an
`input` under that window, the axis is raised to it, because the two axes are one
fact stated twice and magpie reads `context_window` from the smaller of them. The
raise goes one way only - a declared `input` above the window is left alone - and
it happens only where the catalogue declares an `input` at all, since with none
declared magpie's own fallback already reads the window, and the table's own
entry for this axis wins while that entry still applies, because the entry
carries the samples behind it.

**What the sweep leaves, and how it is read back.** The scheduled workflow
(`.github/workflows/walls.yml`, hourly at :17) runs `limits-watch.mjs --sweep`,
which measures the ids the listing offers and the snapshot does not name yet and
folds each result into `limits-observed.json` beside `limits.mjs`: the file is
pushed as a branch and opened as a pull request, with a compare link in the run
summary where the repository does not let Actions open one, and it never reaches
`main` as a push - what reaches `main` is a merged pull request, which in a
repository that allows it is what the run does itself (below). A wall that moves
under an id already measured is not re-measured on that timer, and `--all` is a
person asking for a fresh reading of everything. That file is an input at run time
now rather than only a workflow artifact: `measuredWalls()` reads it once per path
and keeps the answer, taking the path from its argument, else
`OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT`, else the file beside the module, with an empty
value of that variable meaning no snapshot at all. A missing file, an unreadable
one, one that is not JSON, one whose `models` is not an object and one past 256
KiB answer the same way - no measurement - because a build that cannot read a
measurement declares what its table and its catalogue say, and nothing here may
fail a request.

Each row contributes two facts and no more: the largest prompt the route was
watched to serve, floored to a whole thousand, the same rounding and for the same
reason as the numbers in the table above; and whether the sweep hit a wall at
all, which is whether its `wall` is `bracketed`. A bracketed wall had two refused
sizes behind it, so the served sample is a point the wall is known to sit above
and the axis may be answered with it either way, which is what lets a sweep value
lower a declaration as well as raise one. A wall the sweep never hit is a floor -
the route served this much and said nothing about the rest - and a floor under
the declaration says nothing about the declaration, so it may only raise one. The
sweep's other two labels, `openEnded` and `single-refusal`, are that same floor
when the row has a served sample; a row with none, which is what a sweep that was
refused everything leaves behind, is no measurement at all. The sweep asks
for sixteen completion tokens and measures a prompt, so it answers the context
axis only: the output axis is still the table and the catalogue, and `input` is
still measured by nothing here, though the window that axis follows may be the
one the sweep settled rather than the table's (above).

Applying one is reported as it happens: `OPENCODE_ZEN_FREE_LIMITS_DEBUG=1` gets a
`sweep-statement` line naming the model, the axis, the value, the wall behind it
and the date the sweep wrote. Where the sweep is what settles an axis, its value
is also what a record is seeded from, so a wall that moved and was measured again
is the number the runtime bracket searches around rather than the one the
catalogue still prints.

**What happens to a run.** A run that measured something new leaves one changed
file on a branch, opens it as a pull request and merges it, so the measurement is
on `main` before the run ends and an id Zen made free an hour ago has a measured
window this hour instead of waiting for somebody to notice. The report travels in
the pull request body and the diff beside it: a row per model, the sizes that were
served,
the sizes that were refused and the two labels above.

Merging unattended is defensible here for two reasons, and the workflow checks
both rather than assuming them. The pull request is `limits-observed.json` and
nothing else, compared against the file list GitHub reports for it - a pull request
that turns out to carry anything else is left open with a warning instead. And the
numbers are bounded by construction: a row's value is the largest prompt the route
was watched to serve, floored, and the table keeps the first word for every id it
names, so an automatic merge can only move an id the table does not answer, and
only to a size something was actually served at. A measurement can still be wrong
in a way a person could have seen - an endpoint that answered a size it should not
have, a model measured on the wrong protocol - and that is what the pull request
record is for afterwards, since a merged commit is reverted as easily as it was
merged.

A repository that wants the click back sets the variable `WALLS_AUTOMERGE` to
`off`: the pull request is then left open, and the run summary says so.

A host picks the file up when it next starts, because it is read once per process;
an id that appeared on Zen is offered whether or not this file mentions it, at
whatever the catalogue declares, until that happens.

**What this does not do.** It cannot learn a wall above the sizes the host
actually sends: the declared ceiling is what gives the host a reason to send a
bigger request, and a host that compacts at the declaration never reaches a wall
far above it, so the bracket climbs one declaration at a time and only while
something is filling each one. A learned value also reaches the host at its next
model-list rebuild — the start, an hour later, or an explicit `refresh()` — and
not on the request that learned it, which is what keeps this from being a loop:
the bracket moves on traffic the host sent against the declaration it was given,
not against the one being computed now. And the estimate is read from characters
while the route counts tokens, so a bracket proves a size a few per cent away
from what a tokenizer would say.

**Re-measuring, now that the plugin measures too.** The hand measurement above is
still the ground truth where it speaks, and is still what a bracket is seeded
from for an id it names while the catalogue has not moved; for an id it does not
name, the sweep's measurement is that seed instead, and the plugin's own learning
is no substitute for either, since it can never reach a wall the traffic does not
touch. A single refusal is not a wall on this route either: the same id
has refused a prompt and then served the identical request, so what a hand
measurement looks for is two refused sizes behind one wall, which is the runtime
counterpart of the bound this layer drops when the route serves past it. What the
plugin believes is in the state file named above, and each movement is reported as
it happens when `OPENCODE_ZEN_FREE_LIMITS_DEBUG=1` is set: each raise that moves
the declaration, each refusal that moves it back, and each refusal the route goes
on to contradict gets a line of its own, naming the model and the numbers behind
it — the value the declaration moved to, the size the route served or refused, the
window a refusal named when it named one, and how many refusals the model has
cost. A bracket that has learned something wrong is forgotten by deleting that
file, or by pointing `OPENCODE_ZEN_FREE_LIMITS_STATE` at an empty string for a run
that should not remember anything. What comes out of the state file is not
evidence for the table in this file: it is one process's traffic, and the table
wants a measurement.

**The same shape on a second upstream.** `mimo-v2.6-flash-free` is declared
200000/32000 in the catalogue, the under-report the DeepSeek id has, and the route
once named its window in its own words: an 850,249 token prompt was served first,
its needle echoed back, and then a prompt just over the wall was refused with

```
This endpoint's maximum context length is 1048576 tokens. However, you requested
about 1496523 tokens (1295079 of text input, 1444 of tool input, 200000 in the
output).
```

which is the route naming its own window, on an upstream that words it
differently from the DeepSeek ids. That figure was overtaken on 2026-10-19, when
a prompt of about 408,000 tokens was refused — less than half of it — so the axis
is the route's own enforcement found by bracketing (343,131 tokens served,
1,900,000 characters refused) rather than the number the route stated, the same
way the DeepSeek id's stated million went. Its output is the first figure in this
file resting on a vendor page: that same refusal came back with the 200000 it was
asked for, unclamped, so this route states no completion ceiling of its own, and
131072 is Xiaomi's entry for `mimo-v2.6-flash` (`api.xiaomimimo.com`, and its
China token plan). Nothing above 32000 has been watched on this route, and
`samples` says that rather than implying a witness.

**Looking for the next one, instead of waiting to notice it.** `bun run
limits:audit` asks the route which free models it still offers — the listing's
ten, not the forty the catalogue still describes — and asks each one the cheap
question above. It groups them by the `x-opencode-upstream-model-id` the route
answers with, because two ids naming one upstream model are one capability, so a
declaration that differs inside a group is the question worth asking. It prints
those, the ceilings it was told, the windows a refusal named, and the ids that
are gone (410) or unavailable (400); it writes nothing and measures no window.
Its first run named
`big-pickle`'s ceiling and two ids declared below what the route says
(`nemotron-3.5-lightning-free` at a quarter of its window, `longcat-2.5-preview-free`
at half its ceiling), which is the whole argument for having it. The run behind
the 2026-10-19 table above was that work done by hand, and the audit after it
reports no candidates at all — nothing offered is under-declared relative to the
sibling the route groups it with — which is the state the table was moved to reach
rather than a reason to stop asking, since the walls move.

## The loop

```sh
bun test              # the unit tests; these never touch the network
bun run limits:audit  # what the route offers, what limits it states, what to measure
bun run check:gate    # asks Zen which generations are still accepted
bun run capture -- --dry   # takes a fresh capture and reports the difference
bun run capture            # writes it
bun run check:gate         # did that fix it
```

`bun test` reads the tree; a running gateway does not. Magpie's plugin host
imports the plugin once, when it starts, and no `magpie plugin` subcommand
reloads it — pointing a gateway at this tree does not make it watch the tree, so
a change to be measured through a live gateway needs that gateway restarted
first.

`check:gate` is the one that matters. It asks each generation twice, because the
plugin sends two shapes and Zen does not answer them alike:

| shape | tools sent | what it is |
| --- | --- | --- |
| `floor` | the names in `required` | what the plugin stands in for a host that is not OpenCode and has none of these tools by name |
| `full` | every tool in the profile | what a host that is OpenCode itself sends |

It reports each request as:

| verdict | meaning |
| --- | --- |
| `answered` | Zen served it; this shape is current |
| `refused` | Zen did not recognise it (403) |
| `superseded` | Zen wants a newer OpenCode than the profile claims (426) |
| `failed` | Zen answered with something other than a 403, so it never judged the fingerprint |
| `malformed` | the request could not be built: a name in `required` has no tool behind it in `fingerprint.json`. Zen was never asked, and the line names the generation, the shape and the name |
| `unreachable` | Zen could not be asked at all |

A `malformed` row is a `fingerprint.json` problem, not a network one, and the
summary says so rather than sending the reader to `capture`. It is deliberately
not counted as `answered`: a run whose floors are all `malformed` exits non-zero.

The `floor` decides the exit code, because it is the shape this plugin exists to
send. The `full` is reported for what it says about a wording that has gone
stale. Asking only the full shape left a real gap: `read` alone is `answered` and
everything but `read` is `refused`, so a Zen that began insisting on one more
name would keep `full` passing while the shape actually sent was refused. The
diagnosis at the end reads the floor rows only: a stray 5xx on a `full` request
says something about that request and nothing about whether the wording is
current, so it must not turn "nothing was served" into "check the network".

Only a 403 and a 426 are Zen answering about the fingerprint. A 5xx, a 429 or a
401 says nothing about the wording, and the gate says so rather than sending the
reader to `capture` over an outage — as it does when nothing was reached, or when
part of a run answered and part of it did not.

`capture` needs `opencode` on PATH. It points a real OpenCode at a server running
locally and reads the request it makes, so nothing is sent to Zen and no key is
involved.

The wording it reads is the host's, so the host's own details are put back to
something neutral before the capture is written: the OS banner, the scratch
directory, and now the shell's version. That last one was live — opencode 1.19.0
words `bash`'s description after the machine it runs on, one host saying
"Executes a given Windows PowerShell (5.1) command…" and another "PowerShell
(7+)…", and Zen reads those bytes out of the request, so two machines disagreed
about a description that belongs to neither. The version is dropped, which is
also what a capture on Linux already says; the live gate answered the neutral
wording four times running on 2026-10-16. What any wording is worth is settled by
`check:gate`, never by this file.

## Reading a failure

**Every `floor` `refused`.** OpenCode reworded its tools, or moved the endpoint.
Run `bun run capture`, then `check:gate` again. If the endpoint moved,
`DEFAULT_BASE` in `provider.mjs` is what has to change.

**One `floor` `refused`, the other `answered`.** OpenCode has released and this
generation is retired. Capture from a current OpenCode: it will be detected as
the other generation, so what is captured goes into that profile.

**A `floor` `refused` while its `full` is `answered`.** Zen has begun insisting
on a tool this plugin does not stand in, which the gate names in a line of its
own. What gets stood in is `required` in `fingerprint.json`, and the wording it
is stood in with is that profile's `tools`, so the name has to reach both, from a
capture taken of an OpenCode that has it. A host that brings its own tool by that
name is served either way, which is why only the `floor` shows this.

**`superseded` (426).** Zen raised the minimum version this profile claims. Raise
`agent.opencode` in `fingerprint.json` above what it asks for. 426 is Zen saying
"your client is too old", which is a different problem from 403 and is not fixed
by changing tools.

**`malformed`.** `fingerprint.json` names a tool in `required` that the same
profile does not carry under `tools`, so the gate could not build the request it
wants to ask with. This is not a network problem and not something Zen said: the
line names the generation, the shape and the missing name. Fix the file — a
capture from a current OpenCode is the usual way — and ask again. The run exits
non-zero, and the summary says the same thing in one sentence.

**`unreachable`.** Not a fingerprint problem. Check the network, and whether
repeated refusals from this address have put it in a cooldown — they can, and
the cooldown answers like a refusal.

**`failed`.** Zen answered, but not with 403: a 5xx or a 429, or a 401 if the
request was not authorized. Not a fingerprint problem either, and the gate says
so rather than naming the wording. A 429 is the one to read twice: repeated
refusals from this address can put it in a cooldown, and a cooldown answers
quickly and often.

## Things that are easy to break

**Marking a list as fallen back when Zen's own list was read.** `discover()`
returns every id Zen's `/models` lists; the catalogue and the console docs only
add what each model *is* — name, protocol, limits. When either of those two
cannot be read, the list is not a fallback: it is Zen's, current, and complete to
the last id. Saying so costs a user something real, because the host reacts to
that marker by keeping the last list it read in full, and a machine that cannot
reach `raw.githubusercontent.com` or `models.opencode.ai` — mainland China, for
one — then never sees a model Zen made free since. The marker belongs to the one
case that describes it: the listing itself could not be read, so what is returned
really is the last list there was (`yetone/magpie#2385`).

**Waiting for the catalogue before offering a model Zen already lists.** An id
ending in `-free` that neither the catalogue nor the docs describe is offered
anyway, asked through the provider's own protocol (openai-compatible, and so
chat) — the way OpenCode asks a model with no package of its own. Zen lists a
model the hour it turns free and the catalogue catches up later; a host should
see it in between. An id that does not call itself free still needs the
catalogue's word, and one the snapshot or the docs name keeps that say:
`jev-1.13-free` is SystemOne and stays out.

**Adding a header.** The set sent has one owner: `outboundHeaders` in
`provider.mjs`, which the plugin builds its request with and which the gate asks
Zen with, so neither can drift from the other on its own. `index.test.mjs` pins
the names on the wire. `x-opencode-request`, `x-session-affinity` and
`x-session-id` are all in OpenCode's own header set upstream and none is sent;
measured 2026-10-15, each of the three answers on its own while
x-opencode-request with x-session-affinity is refused. A header cannot be judged
by adding it on its own, so add it in `outboundHeaders` and let the pinned test
and a live `check:gate` say what it did.

**Rewriting the tool wording.** The wording sent upstream is OpenCode's, because
Zen reads it. What replaces it is only the wording: the host's tool and its
parameters are kept, so the call the model makes still fits the tool that runs
it. Rewriting the parameters as well looks tidier and breaks the agent.

**Replacing the wording with something of your own.** That is what 0.1.5 and
earlier did, and it is a guaranteed refusal.

**Leaving out a call the agent has no tool for.** A call whose name folded onto
no declared tool was dropped from the reply with a note in its text, and a reply
whose every call was dropped ended as a plain `stop`. An autonomous host reads
that as an answer: DeepSeek Harness ended 16 of the 19 such turns one user
measured and the model never saw an error it could correct
(`magpie-community/plugins#209`; upstream made the same change in its 0.1.11).
The name now goes on as the model wrote it — same name, same id, same arguments,
a tool-call finish — and the host answers it with its own unknown-tool error,
which is the correction signal. A name two declared tools fold to is still never
guessed: it goes on as called. Only a call with **no name** is left out now, and
`droppedNote` says so. Measured 2026-10-18 through a local magpie pointed at
this tree, `deepseek-v4.1-flash-free`, declaring `pwsh` and calling `bash`:
before, `200` + `finish_reason: "stop"` + the note; after, `200` + `tool_calls`
+ `bash` carrying its id. Do not put the drop back to "protect" a host —
answering is the host's to do, and a silent `stop` is the failure this replaced.

**Merging a tool call's frames over its id.** The route puts `"id": null` on
the continuation frames of a call whose first frame named it (measured
2026-10-17 on `deepseek-v4.1-flash-free`), and a host that keys a tool result
by the id — dsh writes `tool/result` records keyed by it — fails its turn on
an empty one and cannot reload the session afterwards ("tool call id requires
a nonempty string"). Merging frames must read the id as a name that only
replaces itself, and a call the route never names has to leave with an
invented one. Both live in `tool-response.mjs` — the merge's keep, and
`ensureCallIDs` at the two places a call is published — and `stream.mjs`'s
collapse reads the same rule.

Both of those places publish the **chat** shape only. A Responses or Messages
reply whose call carries no id of its own is handed on as it stands — no id, no
`call_id` — and both protocols require the field. Measured 2026-10-18, no free
model is served on either route: the tier's own `/models` listed none,
`muse-spark-1.3-contributor-free` answered 410 `ModelDeprecated` and the four
Messages models answered "Model is unavailable". So the gap is real but not
reachable today, and the sentence above — every published call leaves with a
non-empty id — is chat's. A free model on either route puts it back in scope,
and then the id has to be minted once per call across its added, done and
terminal copies, the way the dropped ones already are.

**Trusting one observation.** The gate is not steady: it moved more than once in
a day while this was being worked out, and identical requests were answered both
ways minutes apart. Anything measured once is not a fact. Measure it three times,
interleaved, before believing it. When two sources disagree, prefer the shape
that passes under the stricter of them, since the looser one will not last.

## Layout

| file | what it is |
| --- | --- |
| `fingerprint.json` | the capture: the wording and User-Agent Zen accepts |
| `core-tools.mjs` | reads the capture; says which generation a request is |
| `provider.mjs` | the plugin: discovery, headers, tools, the diagnostic |
| `models.mjs` | which models are free, and what protocol each speaks |
| `limits.mjs` | what a model's limits are, where the catalogue under-reports them |
| `stream.mjs`, `tool-response.mjs` | replies Zen cuts short, and tool calls |
| `limits-audit.mjs` | asks the route which ids it still offers and which look under-declared (`limits:audit`) |
| `limits-sweep.mjs` | brackets one id's prompt wall on the live route (`limits:sweep`) |
| `limits-watch.mjs` | the scheduled diff and sweep: what is offered, what was measured, what to measure (`limits:watch`) |
| `limits-observed.json` | what the last scheduled run measured: read at run time as the `route-sweep` tier |
| `capture.mjs` | takes a new capture |
| `tools-smoke.mjs` | asks Zen what it accepts (`check:gate`) |

`capture.mjs`, `limits-audit.mjs`, `limits-sweep.mjs`, `limits-watch.mjs` and
`tools-smoke.mjs` are maintenance tools for this repository, not part of what a
host loads: they are not in `package.json`'s `files`, so a published tarball
carries the modules a host imports, `fingerprint.json`, `limits-observed.json`
(which `limits.mjs` does read at run time) and the four documents beside them
(`README.md`, `MAINTAINING.md`, `LICENSE`, `NOTICE`) - fourteen files in all, the
last being `package.json`, which npm packs whatever `files` says. The same list
is why `npm run` has nothing to run in an installed package: `check:gate`,
`limits:audit`, `capture`, `limits:sweep` and `limits:watch` are entry points for
a checkout, and the tools they name stay here. `package.json`'s `exports` names
those public modules one by one rather than mapping `./*`, so a file that was
never meant to be imported cannot
be reached as a subpath — `capture.mjs` in particular starts a server and
rewrites `fingerprint.json` when it runs.

## Which copy of the icon and the concurrency is authoritative

`icon` and `maxConcurrency` are declared twice, and neither copy can be read by
the other: `package.json`'s `magpie` block is host-facing JSON, and the `auth`
object in `provider.mjs` is the runtime's. Nothing builds one from the other, so
a change to either alone drifts.

The runtime values are authoritative for what the plugin asks for. The manifest
block is what a host reads before it loads the plugin, so a host that reads it
will act on that copy, and one that does not will act on the runtime's — which
means editing one and not the other silently changes how many requests the host
makes at once (too high and Zen rate-limits them, too low and they queue behind
each other). Change both, and keep them saying the same thing.

## What runs this

Every script in `package.json` names `bun`: `bun test` is the suite, and
`check:gate`, `limits:audit`, `capture`, `limits:sweep` and `limits:watch` are
the tools. `bun test` is what CI runs, at the version pinned in
`.github/workflows/ci.yml` so a run says something about the commit rather than
about whatever Bun was newest that morning.

Nothing here is installed with Bun — there are no dependencies — so Bun is the
tools only, and the floor a host's runtime has to clear is the newest API the
modules a host imports reach for. That is `AbortSignal.any` (`provider.mjs`,
`limits.mjs`), which Node added in 20.3.0 and backported to 18.17.0 — so
`engines.node` says `>=18.17.0` and not `>=20.3.0`, which would have warned
hosts that work. Everything else those modules use is older: `AbortSignal.timeout`
and `throwIfAborted` (17.3), `findLast` (18.0), `Object.hasOwn` (16.9), and the
fetch globals (18.0 unflagged).

`import.meta.main` is what decides whether `tools-smoke.mjs` runs its
gate or is being imported by a test, and a Node older than 22.18 does not define
it: the gate falls back to comparing the entry path. That comparison resolves
both paths and then their real paths, so a symlink or a junction naming this file
is still recognised as this file, and a hard link is compared by device and inode
(only where the filesystem reports an inode at all). A question it cannot answer
exits non-zero saying nothing was asked — never a silent success, which is the
one outcome a release gate must not have.

Both scripts read their endpoint and model from the environment when the
defaults are wrong: `ZEN_BASE_URL`, `ZEN_CHECK_MODEL` (gate), `ZEN_CATALOG_URL`,
`ZEN_GENERATION` (audit) and `CAPTURE_PORT` (capture). `.env.example` lists them
with their defaults. Nothing loads a file by itself, so export them or copy that
file to `.env` and export from it.

## Publishing

The package is `opencode-zen-freex`; the provider it registers is
`opencode-zen-free`, which is the same one magpie-community/plugins' version
registers. That is deliberate: a model is written `opencode-zen-free/<model>`
either way, so one stays in place whichever is installed. It does mean the two
are mutually exclusive — installing both leaves two plugins claiming one
provider id, and which one wins is down to load order. Pick one.

To publish: bump `version`, commit, `npm publish` in a terminal, and tag — in
that order, so the tarball, the commit the tag names, and the tree both were
built from are one thing. `magpie plugin add opencode-zen-freex` installs it by
that name.

What ships is `package.json`'s `files` list, and it is deliberately narrower than
the repository: the five maintenance scripts (`capture.mjs`, `tools-smoke.mjs`,
`limits-audit.mjs`, `limits-sweep.mjs`, `limits-watch.mjs`) stay here, because a
host never loads them and one of them rewrites the shipped `fingerprint.json`
when it is run, while `limits-observed.json` does ship, because `limits.mjs`
reads it at run time. `LICENSE` is
MIT with its text unmodified and both copyright lines in place — upstream's and
this fork's — so what a licence scanner reads is a standard MIT file; the fork's
provenance is in `NOTICE`, which is where a reader finds why this fork exists.

**The second factor is a browser, not a password.** Run `npm publish` in a
terminal. When the account has 2FA on, the command stops and offers the whole
exchange at once:

```
Authenticate your account at:
https://www.npmjs.com/auth/cli/...
Press ENTER to open in the browser...
```

Press ENTER, authorize in the browser, and the same command carries on by
itself. Nothing is typed back into the terminal and nothing is passed to a
script: the address is tied to the browser session that printed it and differs
every time, so it is read out of the running command rather than composed in
advance. Whoever is at the browser authorizes, so the command can be started for
them and left waiting — the one thing it needs from them is the ENTER that opens
it.

Both halves of that depend on the command having a terminal. Run as a background
job or piped into a file, npm has no browser to offer, redacts the address to
`https://www.npmjs.com/auth/cli/***` and exits `EOTP` rather than waiting, so a
log of the failed attempt cannot be used to finish it — start it again in a
terminal.

An account with no second factor to give publishes in one step. So does
`npm login --auth-type=web`, which is the same browser exchange kept as a
session, and so does a granular token below.

**With a granular token** (unattended, CI). A token with publish permission
authorizes the publish on its own and never asks for the second factor. Write it
to an npmrc outside the repository and point npm at it for that one command, so
it does not land in a tracked file:

```sh
printf '//registry.npmjs.org/:_authToken=npm_...\n' > "$TMP/npmrc"
npm publish --userconfig "$TMP/npmrc"; rm -f "$TMP/npmrc"
```

Whatever carries a token — a shell, a chat, a CI log under
`%LOCALAPPDATA%\npm-cache\_logs` — is now a place the token has been, and
npm's debug log records the whole command line. Rotate it once the publish is
done. It is not needed to install the package afterwards.

Two things that read as failures and are not. A version already published
cannot be published again, so a republished README means a new `version`, not
a retry — `README.md` is in `files`, so it ships and npmjs.com renders it.
And for a minute or two after a successful publish, `npm view` still 404s
while the registry replicates; wait rather than publishing under a second
number.

One trap worth knowing: a token that is missing, truncated or malformed is
reported by npm as

```
404 The requested resource 'opencode-zen-freex@0.2.1' could not be found or
you do not have permission to access it.
```

which reads exactly like the package not existing. It is the same status npm
gives a genuine permission failure, so a 404 from a publish says nothing at
all until the token has been checked.

**A publish that no longer offers the browser at all.** A token can be dead
while npm says nothing about it until a write is attempted. Measured: `npm
whoami` answers

```
npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami
```

and the publish answers that same 404 without ever printing an auth address,
because with no usable credential the request goes out unauthenticated and npm
reports the result as not-found. `npm login --auth-type=web` is the fix — the
browser exchange again, which replaces the stored token — and the publish after
it asks for the second factor in the browser once more. **Two authorizations in
a row is the normal shape of this**, not a sign that something is wrong. So on a
404 from a publish, ask `npm whoami` before anything else: 401 is a session that
has to be renewed, and everything else is the permission problem above.

npm says on login that "tokens that bypass 2FA are being restricted for account
changes and direct publishing", so the granular route below is on its way out as
a way to publish; the browser is the road, and the token is the exception it is
already written to be.
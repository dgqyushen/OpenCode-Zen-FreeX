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
small. `deepseek-v4.1-flash-free` is declared 200000/32000 while
`deepseek-v4.1-flash` — the paid id serving the same upstream model, which
`x-opencode-upstream-model-id` confirms — is declared 1000000/384000 in that
same catalogue, and `mimo-v2.6-flash-free` is declared 200000/32000 against a
model whose own vendor publishes 1048576/131072. The ids the tier added on
2026-10-16 were under-reported the same way on the day they appeared:
`ll-alpha-free` names a 262144-token completion ceiling in its own refusal
against a declared 65536, and `glm-5.3-flash-free` is declared 200000/32000
while its paid twin `glm-5.3-flash` is declared 1000000/131072 in the same
catalogue — and a 232685-token prompt was served through the free id, which the
declared window does not allow. `space-bunny-free` under-reports on a third
axis, its `input`: the catalogue derives that number from its own pair
(`context − output`, 524288) while prompts of 535,110, 935,110 and 979,550
tokens were served through the free id, and the axis is what a host that shows
a window shows — magpie's `context_window` and `max_input_tokens` both follow
it, so the derivation was on screen as half a window.

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
| `deepseek-v4.1-flash-free` | context | 1048576 | the route's own refusal, in its own words |
| `deepseek-v4.1-flash-free` | output | 384000 | what this route declares for the same upstream model |
| `mimo-v2.6-flash-free` | context | 1048576 | the route's own refusal, in its own words |
| `mimo-v2.6-flash-free` | output | 131072 | the vendor's own catalogue entry |
| `big-pickle` | output | 131072 | the ceiling the route names when it is asked for too much |
| `nemotron-3.5-lightning-free` | context | 1000000 | the route's own refusal, in its own words |
| `longcat-2.5-preview-free` | output | 262144 | the ceiling the route names when it is asked for too much |
| `ll-alpha-free` | output | 262144 | the ceiling the route's own refusal names, against a declared 65536 |
| `glm-5.3-flash-free` | context | 1000000 | what this route declares for the same upstream model, with a 232685-token prompt served as witness |
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
(`finish_reason: stop`) was watched and is recorded as the witness.

**Re-measuring.** The window: send a prompt of about 1.05M tokens and read the
number out of the refusal, three times, interleaved, per the rule below. The
filler measured 4.887 characters per token with about 1700 tokens of fixed
request overhead, and a request that is *served* says nothing about where the
wall is — it is what the calibration is checked against, since
`usage.prompt_tokens` is the real count while the refusal's "requested about"
figure is a rough one (characters, not tokens) and must not be read as a count.
A second upstream words the same fact as "This endpoint's maximum context length
is …" and breaks the request into text input, tool input and output.

**The input**, the third axis: nothing cheap names it — the refusals on this
route name the window, and this id's own refusal names nothing at all — so it is
measured by serving. A prompt sized past the declared input is the measurement
(535,110, 935,110 and 979,550-token prompts each came back with the needle at
their end echoed, and `usage.prompt_tokens` is the count that says how much was
served), and the window the catalogue declares for the same id bounds the value
from above: a request placed over it is refused.

The ceiling, which is cheaper than the window: ask for `max_tokens: 1000000` on a
short prompt and stop reading as soon as the answer starts. An upstream that
validates the ceiling refuses and names it — `max_tokens is too large: 1000000.
This model supports at most 131072 completion tokens`, or LongCat's
`/max_tokens: 1000000 is not less or equal to 262144` — and one that does not
just begins to answer, so the cost of asking every model is a few tokens each.
Both wordings are in `limits.mjs` (`namedOutputCap`) and both are read from
production refusals as well, which is how a ceiling that moves gets noticed
without anyone running anything.

The output: a paid twin's `limit` in `https://models.opencode.ai/api.json` is
the stronger source, and re-reading it is the whole job. With no twin — `mimo`
has none — the figure rests on the vendor's own entry, which is weaker evidence
and has to say so in `samples`: what is declared is what a vendor publishes, not
something watched. A value Zen accepts is not evidence — `max_tokens: 2000000`
under a short prompt answers 200 and writes nothing like it, and `mimo`'s refusal
came back with the 200000 it was asked for rather than with a ceiling — and
neither is a generation nobody watched finish.

`witnessed`, the fourth evidence tier, is used by nothing that ships here. The
table draws on `route`, `route-twin` and `vendor` only; `witnessed` — a
generation somebody watched finish — is accepted because `limitOverrides` is
exported and a caller may hand it a table that says so, and no shipped entry
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
followed without anyone editing this file. Nothing is persisted: a restart falls
back to what is measured here. The `input` axis has no live form: the refusals
this route sends name a window and a completion ceiling, and never an input cap.

**The same shape on a second upstream.** `mimo-v2.6-flash-free` is declared
200000/32000 here too, and its window is a route figure like the one above — an
850,249 token prompt was served first, its needle echoed back, and then a prompt
just over the wall was refused with

```
This endpoint's maximum context length is 1048576 tokens. However, you requested
about 1496523 tokens (1295079 of text input, 1444 of tool input, 200000 in the
output).
```

which is the route naming its own window, on an upstream that words it
differently from the DeepSeek ids. Its output is the first figure in this file
resting on a vendor page: that same refusal came back with the 200000 it was
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
at half its ceiling), which is the whole argument for having it.

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
| `capture.mjs` | takes a new capture |
| `tools-smoke.mjs` | asks Zen what it accepts (`check:gate`) |

`capture.mjs`, `limits-audit.mjs` and `tools-smoke.mjs` are maintenance tools for
this repository, not part of what a host loads: they are not in `package.json`'s
`files`, so a published tarball carries only the modules a host imports plus
`fingerprint.json`. `package.json`'s `exports` names those public modules one by
one rather than mapping `./*`, so a file that was never meant to be imported
cannot be reached as a subpath — `capture.mjs` in particular starts a server and
rewrites `fingerprint.json` the moment it is imported.

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
`check:gate`, `limits:audit` and `capture` are the tools. `bun test` is what CI
runs, at the version pinned in `.github/workflows/ci.yml` so a run says something
about the commit rather than about whatever Bun was newest that morning.

Nothing here is installed with Bun — there are no dependencies — so Bun is the
tools only. `import.meta.main` is what decides whether `tools-smoke.mjs` runs its
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
the repository: the three maintenance scripts (`capture.mjs`, `tools-smoke.mjs`,
`limits-audit.mjs`) stay here, because a host never loads them and one of them
rewrites the shipped `fingerprint.json` if it is ever imported. `LICENSE` is
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
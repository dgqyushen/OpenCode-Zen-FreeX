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
same catalogue.

Both numbers are acted on. The window decides when a conversation is compacted
and how much of it is ever sent; the output cap is sent as `max_tokens` on every
request, so a reply is cut at it with a finish reason that reads like the
model's own decision. A window that is too small is never refused, it is just
quietly never used, which is why this stayed invisible for so long.

`limits.mjs` holds what was measured, per axis, with the catalogue value it was
measured against. Each axis carries `samples` and `how`; the short of it:

| axis | value | from |
| --- | --- | --- |
| context | 1048576 | the route's own refusal, in its own words |
| output | 384000 | what this route declares for the same upstream model |

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
wall is. The output: re-read the paid id's `limit` in
`https://models.opencode.ai/api.json`. A value Zen accepts is not evidence —
`max_tokens: 2000000` under a short prompt answers 200 and writes nothing like
it — and neither is a generation nobody watched finish.

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
back to what is measured here.

**A lead, not evidence.** `mimo-v2.6-flash-free` is declared 200000/32000 here
too, and another plugin on this route has reported Zen answering that id with
`maximum context length is 1048576 tokens`. That is somebody else's measurement
of a different id, so it is not in `limits.mjs`: measure it before adding it.

## The loop

```sh
bun test              # the unit tests; these never touch the network
bun run check:gate    # asks Zen which generations are still accepted
bun run capture -- --dry   # takes a fresh capture and reports the difference
bun run capture            # writes it
bun run check:gate         # did that fix it
```

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
| `unreachable` | Zen could not be asked at all |

The `floor` decides the exit code, because it is the shape this plugin exists to
send. The `full` is reported for what it says about a wording that has gone
stale. Asking only the full shape left a real gap: `read` alone is `answered` and
everything but `read` is `refused`, so a Zen that began insisting on one more
name would keep `full` passing while the shape actually sent was refused.

`capture` needs `opencode` on PATH. It points a real OpenCode at a server running
locally and reads the request it makes, so nothing is sent to Zen and no key is
involved.

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

**`unreachable`.** Not a fingerprint problem. Check the network, and whether
repeated refusals from this address have put it in a cooldown — they can, and
the cooldown answers like a refusal.

## Things that are easy to break

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
| `capture.mjs` | takes a new capture |
| `tools-smoke.mjs` | asks Zen what it accepts (`check:gate`) |

## Publishing

The package is `opencode-zen-freex`; the provider it registers is
`opencode-zen-free`, which is the same one magpie-community/plugins' version
registers. That is deliberate: a model is written `opencode-zen-free/<model>`
either way, so one stays in place whichever is installed. It does mean the two
are mutually exclusive — installing both leaves two plugins claiming one
provider id, and which one wins is down to load order. Pick one.

To publish: bump `version`, `npm publish`, and tag. `magpie plugin add
opencode-zen-freex` installs it by that name.

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
# Maintaining this plugin

The plugin is one file of logic and one piece of data, and the data is the part
that goes out of date. This is how to look after it.

## What is actually fragile

`fingerprint.json` holds a capture of a real OpenCode: the wording of the tools
its free tier knows by name, and the User-Agent that identifies it. Zen accepts a
request only when the whole of it matches one generation of OpenCode, so when
OpenCode changes any of that, the copy here stops being accepted.

Nothing about a stale copy looks different from a working one. The symptom is a
`403 FreeTierError` on every request, which reads as "you are not OpenCode" and
sends people off to change headers.

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
| `fingerprint.json` | the capture. The only thing that goes out of date |
| `core-tools.mjs` | reads the capture; says which generation a request is |
| `provider.mjs` | the plugin: discovery, headers, tools, the diagnostic |
| `models.mjs` | which models are free, and what protocol each speaks |
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

Publishing is the one step here that cannot be run unattended, because it is
the one step npm asks a person about. Run it as yourself.

**With 2FA on the account.** `npm publish` fails with `EOTP` and prints a
`https://www.npmjs.com/auth/cli/...` address, redacted in the error and
different every time. Open it, finish, and the same command carries on. There
is nothing to pass to a script: the address is tied to the browser session that
prints it.

**With a granular token.** A token with publish permission authorizes the
publish on its own and never asks for the second factor. Write it to an npmrc
outside the repository and point npm at it for that one command, so it does
not land in a tracked file:

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
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

`check:gate` is the one that matters. It reports each generation as:

| verdict | meaning |
| --- | --- |
| `answered` | Zen served it; this generation is current |
| `refused` | Zen did not recognise it (403) |
| `superseded` | Zen wants a newer OpenCode than the profile claims (426) |
| `unreachable` | Zen could not be asked at all |

`capture` needs `opencode` on PATH. It points a real OpenCode at a server running
locally and reads the request it makes, so nothing is sent to Zen and no key is
involved.

## Reading a failure

**Every generation `refused`.** OpenCode reworded its tools, or moved the
endpoint. Run `bun run capture`, then `check:gate` again. If the endpoint moved,
`DEFAULT_BASE` in `provider.mjs` is what has to change.

**One generation `refused`, the other `answered`.** OpenCode has released and
this generation is retired. Capture from a current OpenCode: it will be detected
as the other generation, so what is captured goes into that profile.

**`superseded` (426).** Zen raised the minimum version this profile claims. Raise
`agent.opencode` in `fingerprint.json` above what it asks for. 426 is Zen saying
"your client is too old", which is a different problem from 403 and is not fixed
by changing tools.

**`unreachable`.** Not a fingerprint problem. Check the network, and whether
repeated refusals from this address have put it in a cooldown — they can, and
the cooldown answers like a refusal.

## Things that are easy to break

**Adding a header.** The set sent is pinned by name in `index.test.mjs`. Zen has
been measured refusing `x-opencode-request`, `x-session-affinity` and
`x-session-id`, all of which appear in OpenCode's own header set upstream. Adding
one is the easiest way to break this plugin, so the test names them.

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

The package name and `repository` in `package.json` are set for the fork. To
publish: bump `version`, `npm publish`, and tag. `magpie plugin add
opencode-zen-freex` installs it by that name.
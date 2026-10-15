# OpenCode Zen Free

OpenCode Zen's free models for a host that is not OpenCode. Provider id:
`opencode-zen-free`.

Zen's free tier answers 403 FreeTierError ("can only be used from within
OpenCode") to a request that isn't OpenCode's, and it reads the request body
as well as its headers: the tools it knows by name have to be described the
way OpenCode describes them. This plugin asks the endpoint that serves the
free tier, and presents the tools the way OpenCode presents them while
keeping the host's own tools, so its calls still run.

This is a maintained fork of the plugin from `magpie-community/plugins`,
which is MIT licensed. It is forked because that fingerprint moves faster
than that repository follows it: its last release is still built for an
endpoint that no longer serves the free tier. See [MAINTAINING.md](MAINTAINING.md)
for how to keep it working, and `bun run check:gate` for whether it is
working now.

## Install

```sh
magpie plugin add <package-name>
magpie plugin login opencode-zen-free
```

## Sign in

Enter `public` in the key field. No personal API key is needed.
The credential is kept in OpenCode's `auth.json` or magpie's
`plugin-auth.json`.

## Models

The plugin discovers Zen's current free models, including their context
windows and reasoning levels. Use `opencode-zen-free/<model>`, for example
`opencode-zen-free/big-pickle`.

Retired models and SystemOne models are excluded. The list is asked
again each time the host lists models (magpie does this on start and every
hour): a model Zen no longer gives free leaves it, and a new free one joins
it. When Zen's list can't be read, the last list is kept. A request for a
model that isn't free now gets a 404 naming the free ones; one made free
since the last list is served after the list is asked again (at most once a
minute). Availability and rate limits are set by Zen; the plugin has no
remaining-quota data.

## When the free tier stops answering

A stale fingerprint does not look different from a working one until
somebody is refused. Ask Zen which generations the plugin still speaks:

```sh
bun run check:gate
```

Each profile is reported as `answered`, `refused` (403), `superseded`
(426 — Zen wants a newer OpenCode than the profile claims) or
`unreachable`. Run it before a release and whenever a 403 is reported.

If every profile is refused, capture the wording again from a current
OpenCode: point a release at a local server and read the tools out of the
request it makes. A refusal from the plugin says which wording went out
and where to look, rather than leaving it to be guessed at.

Note that the gate is not steady: it moved more than once in a day while
this was being worked out, and repeated refusals from one address can
themselves be answered for a while. Read a verdict here as "at this
moment", and run it again before believing a change.

## Requests

Requests go to `https://opencode.ai/inference/v1` using each model's
native Chat Completions, Responses or Anthropic Messages API. Streaming and
ordinary JSON replies are supported.

The agent's tools are preserved. Zen's models often call OpenCode's own
tool names; such a call is given the agent's tool whose name differs only
in case (`bash` to `Bash`), or else only in case and `_`/`-` (`todowrite`
to `todo_write`, `webfetch` to `web_fetch`), when exactly one does. A
call with no such tool (or with no name) is left out of the reply, and
the reply's text says which name was left out; a turn whose every call
was left out ends as an ordinary answer. Tools run in the agent.

Zen's free tier reads the body as well as the headers, and answers a
request only when the whole of it belongs to one generation of OpenCode:
the User-Agent, the headers and the tools have to agree. Two generations
are current, and the tools a request carries say which: `shell` and `read`
are 2.x, `bash`, `glob`, `grep` and `read` are 1.x. A host that is OpenCode
itself says which it is in its own User-Agent, and that is passed on rather
than pinned, so it is never behind. Where nothing says, the tools decide
and the User-Agent follows them.

Within a generation, the tools Zen knows by name — `bash`, `glob`, `grep`,
`read`, `write`, `edit` — have to be there and described the way OpenCode
describes them. The first four are added when the host lacks them; the
other two are only read when the host has them. A tool is never
discarded: the host's own tool is kept whole, and only the wording sent
upstream is replaced, so the call the model makes still fits the tool that
runs it. A tool of any other name is not looked at.

A tool that was *added* has nothing behind it: the agent has no such tool
and a call to it is dropped. Describing it as OpenCode describes it is what
Zen asks for, and it also makes the model want to call it, so a note saying
so is placed after the opening Zen reads and before the closing it does
not. That note is phrased about the one tool on purpose: a blanket "these
tools are not available" was measured to stop the model using the host's
own tools as well.

The headers sent are exactly those of one generation and no more, and that
set is a deliberate subset of everything Zen has been seen to accept.
`x-opencode-request` was measured refused on 2026-10-14 and has never been
measured to be needed, so it is not sent. `x-session-affinity` and
`x-session-id` are in OpenCode's own header set upstream and have been
measured refused, so they are not sent either. A test pins the set by name,
because adding a header is the easiest way to break this plugin.

Now and then Zen closes a streamed Chat Completions reply before its
`[DONE]`. When the reply has said something and no tool call of it is
unfinished, it ends there as an ordinary answer, and its text says it was
cut short; asking again goes on. A reply cut short with a tool call
unfinished, with nothing said, or collapsed for a client that doesn't
stream fails with an error naming the reply's id and how much of it came.
An Anthropic Messages or Responses reply cut short fails too: magpie
tells it from a whole one and, where the model can, goes on with it.

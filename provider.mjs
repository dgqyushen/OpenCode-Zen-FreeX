import { createHash, randomBytes } from "node:crypto";
import { agentFor, generationOf, profileFor } from "./core-tools.mjs";
import {
  PROVIDER,
  SDK,
  bootstrapProtocols,
  bootstrapProvider,
  buildModels,
  configModels,
  parseProtocolDocs,
} from "./models.mjs";
import { observeRouteStatement } from "./limits.mjs";
import { STALE_BODY_HEADERS, collapseResponse } from "./stream.mjs";
import { guardToolResponse } from "./tool-response.mjs";

// Zen moved behind opencode.ai/inference; everything under /zen/ answers 403
// FreeTierError now, however the request is made.
export const DEFAULT_BASE = "https://opencode.ai/inference/v1";
export const CATALOG = "https://models.opencode.ai/api.json";
const DOCS =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/models.mdx";
const PATHS = { chat: "/chat/completions", responses: "/responses", anthropic: "/messages" };
// Which generation to present when the host's tools name neither one: a floor,
// and not a claim about what opencode-ai publishes as latest. What it publishes
// as latest is 2.x, and `fingerprint.json` captures it — the profile whose
// channel is `latest`, opencode 2.0.29 — so a comment saying this constant is
// "the latest generation" would be the one thing here that is not true.
//
// It stays 1.x because a default is only reached when nothing identified the
// host, and 1.x is the generation with more to say for it in that case: its
// `required` set is the wider one, `normalizeTools` can stand in for every name
// in it, and `bash`/`glob`/`grep`/`read` are the names a host that never sent
// `shell` still carries. The floor is what a request falls back to, so it is
// the generation a body is likeliest to already agree with — not the newest one
// opencode-ai ships, which only a host that says so should be presented as.
const DEFAULT_GENERATION = "1.x";
// Said only of a tool this plugin added, which the agent has no such tool for.
// It has to be phrased as being about that one tool: a blanket "these tools are
// not available" was measured to stop the model using the host's own tools too.
const PLACEHOLDER =
  "This one is a placeholder that satisfies OpenCode Zen's request and is not " +
  "connected to anything: do not call it, and use the other tools you have.";

// Zen answers a request only when the whole of it belongs to one generation of
// OpenCode: its User-Agent, its headers and its tools have to agree. So the
// User-Agent is not a constant here. A host that is OpenCode itself already
// says which one it is, and that answer is above whatever floor Zen is holding,
// so it is passed through; otherwise the generation is taken from the tools
// the request actually carries, which is what the gate compares anyway.
//
// Both current shapes answer to this: 1.x sends
// `opencode/<version> ai-sdk/provider-utils/<version> runtime/bun/<version>`,
// 2.x sends `opencode/<channel>/<version>/<client>`. Testing only the channel
// form — which is what this did — silently re-pinned every 1.x host to the
// version in fingerprint.json, so a host newer than the floor was told, on a
// 426 or a refusal, that this package was too old to update. A host's own
// answer is passed through whichever shape it comes in.
//
// The version has to start at 1-9 in both: that is what tells a release from a
// development build (`opencode/dev/0.0.0-dev-1/cli`), whose word is not one Zen
// would serve and so is not taken.
const RELEASE = /^opencode\/(?:[a-z-]+\/[1-9][^/]*\/[^/]+|[1-9][^ ]*\s+ai-sdk\/\S+\s+\S+)$/;

// The generation and the agent belong together: the agent says which OpenCode
// this is, and the generation is what the tools in the request say. Deciding
// them in one place is what `normalizeTools` reports back, so the User-Agent
// cannot describe a generation the body does not.
function agentForRequest(protocol, generation, given) {
  const said = given?.get("user-agent");
  if (said && RELEASE.test(said)) return said;
  return agentFor(generation, protocol);
}

// The complete set of headers that leaves here, and nothing else: one owner for
// the names. tools-smoke.mjs builds the request it asks Zen with from this
// function, so what the gate reports is about the request this plugin makes and
// not about a copy of it. A copy drifts, and one did: the gate was missing
// `accept`, and nothing failed on it. index.test.mjs asserts the names on the
// wire.
//
// x-session-affinity, x-session-id and x-opencode-request are in OpenCode's own
// header set upstream (packages/core/src/session/model-request.ts) and none of
// them is needed, so none is sent. Measured on this set, 2026-10-15: each of the
// three answers on its own, x-opencode-request with x-session-id answers, and
// x-opencode-request with x-session-affinity is refused. It is the pair and not
// either header, so a header cannot be judged by adding it on its own.
export function outboundHeaders({
  session,
  agent,
  protocol = "chat",
  project = "global",
  given,
}) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": agent,
    "x-opencode-project": project,
    "x-opencode-session": session,
    "x-opencode-client": "cli",
    "x-opencode-session-id": session,
  });
  if (protocol === "anthropic") {
    headers.set("x-api-key", "public");
    headers.set("anthropic-version", given?.get("anthropic-version") || "2023-06-01");
    if (given?.get("anthropic-beta")) headers.set("anthropic-beta", given.get("anthropic-beta"));
  } else {
    headers.set("authorization", "Bearer public");
  }
  return headers;
}

// The headers a reply's bytes are described by, for a reply whose body is
// written again. A response rebuilt from a body this package read no longer is
// the response that arrived: a length, an encoding and the validators a cache
// or a conditional request compares against all describe the old bytes only.
// `stream.mjs` keeps the list, and the two places that write an upstream body
// again (here, and `tool-response.mjs`) must both use it — a body re-served
// under the upstream's `content-encoding` cannot be read by the caller at all,
// which for a refusal is the one message a user has to be able to read.
function rewrittenHeaders(response) {
  const headers = new Headers(response.headers);
  for (const name of STALE_BODY_HEADERS) headers.delete(name);
  headers.set("content-type", "application/json");
  return headers;
}

// The headers a body this package read once and writes again unchanged is
// described by. The staleness rule is the same one `rewrittenHeaders` applies —
// a length, an encoding and the validators all describe the bytes that arrived,
// not the ones going out — but the content type is left as the upstream sent
// it: a refusal relayed from a gateway may be HTML, and calling it JSON here
// would be this package's word rather than the upstream's.
function relayedHeaders(response) {
  const headers = new Headers(response.headers);
  for (const name of STALE_BODY_HEADERS) headers.delete(name);
  return headers;
}

// What was read of a refusal is a prefix, not necessarily the refusal. Handing
// that prefix on as the whole body is a lie the caller cannot see: a host that
// parses it reports a JSON error of its own instead of Zen's, which is the one
// message this path exists to keep readable. So a read that did not reach the
// end of the body — one that got nothing at all included — is answered with a
// refusal that says what happened, carries the opening that was read under
// `upstream`, and keeps the status the upstream sent.
//
// What that message may say about *why* the read stopped is bounded by what the
// reader reports: `observeRouteStatement` answers "the read stopped short" for a
// budget it reached, a deadline that passed, a read that failed and a caller
// that aborted, and it names none of them. The length read is not a reason
// either — a body past the budget and one a stalled upstream left half-sent
// arrive as the same prefix — so the message states the fact it holds (the body
// was not read to its end) and how much of it was read, and leaves the cause
// where it is known rather than guessing one here.
const KEPT_PREFIX = 512;

function relayedRefusal(response, observed) {
  const read = typeof observed.text === "string" ? observed.text : "";
  const why = read
    ? "its body was not read to the end, so only the opening of it came back, " +
      `the ${read.length} characters read before the read stopped`
    : "its body could not be read at all";
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "upstream_error",
        message:
          `Upstream answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}, and ${why}.`,
        upstream: read.slice(0, KEPT_PREFIX) + (read.length > KEPT_PREFIX ? "…" : ""),
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: rewrittenHeaders(response),
    },
  );
}

// The response this path hands on, from what the limits reader made of the one
// that arrived: the same response when it never read it — the reader touches no
// 2xx body, so that is the common branch — the bytes it read under headers
// corrected for them when it read the whole body, and a refusal that says so
// when it stopped short. One decision, written once, so the three outcomes
// cannot be read as a chain of ternaries at the call site.
function relayed(response, observed) {
  if (observed === undefined) return response;
  if (!observed.ended) return relayedRefusal(response, observed);
  return new Response(observed.text, {
    status: response.status,
    statusText: response.statusText,
    headers: relayedHeaders(response),
  });
}

// How long a request for a model the last list didn't have waits before it
// asks Zen's list again: a model Zen made free since is served at once,
// and a model typed in by hand doesn't ask the list on every request.
const RELIST_AFTER = 60_000;

function httpURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Expected an HTTP(S) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

// Whether a catalogue's row for an id is a description of a model at all. The
// shape rule lives in one place because two readings depend on it — what the
// catalogue says about an id, and what this plugin kept for it — and a row read
// as a description by one of them and not the other is a model that disappears
// without anything saying so.
//
// An array is not one, though `typeof []` is `"object"`: the catalogue writes a
// row per model and never a list, so a list there is a row it could not fill in,
// the same fact as `null`. `models.mjs` reads a row as a description by the same
// test; the two must agree.
function describesModel(row) {
  return typeof row === "object" && row !== null && !Array.isArray(row);
}

// Give a model map an entry under an id that came from upstream, as an own
// property whatever that id is. `map[id] = value` is not enough: for the id
// `"__proto__"` a plain write is the prototype setter, so the entry is not
// stored at all and the map's prototype is what changes — the one write here
// whose id is not this package's to trust. An id may name a model, and it may
// not reach past the map to do it.
function own(map, id, value) {
  if (id === "__proto__") {
    return Object.defineProperty(map, id, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  map[id] = value;
  return map;
}

// The catalogue's own row for an id, or `undefined` when the catalogue has none
// under that name. Own properties only, for the reason the preservation loop
// states: `models?.["toString"]` is the prototype's function, and reading it as
// a description of a model invents one nothing described.
function catalogueRow(metadata, id) {
  return Object.hasOwn(metadata.models ?? {}, id) ? metadata.models[id] : undefined;
}

function requirePublic(auth) {
  if (auth?.type !== "api" || auth.key !== "public") {
    throw new Error(
      "OpenCode Zen Free uses the public credential. Enable its free access login method.",
    );
  }
}

async function readRemote(url, json, headers, callerSignal) {
  const timeout = AbortSignal.timeout(15000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Model discovery returned HTTP ${response.status}`);
  }
  return json ? response.json() : response.text();
}

function normalizeTools(body, protocol) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error("tools must be an array");
  }
  body.tools ??= [];
  // A name is read out of whichever shape it arrived in. The protocol decides
  // what is sent, but a host that sent the other shape's tools still declared
  // them, and taking the name from one shape only would fill a gap that is not
  // one and send the same tool twice.
  const nameOf = (tool) => tool?.function?.name ?? tool?.name;
  const present = new Set(body.tools.map(nameOf));
  const declared = new Set([...present].filter((value) => typeof value === "string"));
  // The legacy top-level `functions` array is the older way of declaring the
  // same tools, and one a chat host may still use. Its names are declarations,
  // so they count as declared, and the fill loop below finds them by name: a
  // name that only arrived through `functions` has no index in `body.tools`, so
  // it is looked up in the array itself and reworded where it sits rather than
  // being stood in for. Without that the same tool would go out twice, which is
  // what the note on `nameOf` says must not happen.
  const legacy = Array.isArray(body.functions) && protocol === "chat" ? body.functions : [];
  for (const tool of legacy) if (typeof tool?.name === "string") declared.add(tool.name);
  // Zen takes a request for one generation of OpenCode or the other, and the tools
  // it carries say which: `shell` is 2.x, `bash` is 1.x. Names move far less
  // often than descriptions do, so this survives a rewording that a pinned
  // User-Agent would not.
  //
  // Neither name being there is not the same as 1.x being there: the fallback
  // is the floor described on DEFAULT_GENERATION, and it decides the names this
  // loop then fills in as well as the User-Agent `agentForRequest` composes.
  const generation = generationOf(body.tools) ?? DEFAULT_GENERATION;
  // Through `profileFor`, not `PROFILES[generation]`: a capture that holds one
  // generation leaves the other key absent, and the direct read fails below on
  // `profile.tools` with a TypeError that names nothing — the capture is what
  // has to change, and it is the one thing that error does not say.
  const profile = profileFor(generation);
  const filled = [];
  const at = new Map();
  body.tools.forEach((tool, index) => {
    const name = nameOf(tool);
    if (name && !at.has(name)) at.set(name, index);
  });
  for (const [name, spoken] of Object.entries(profile.tools)) {
    const index = at.get(name);
    if (index !== undefined) {
      // The host's own tool, kept whole so that it still runs and the reply's
      // call still finds it. Only the wording is replaced: Zen reads the
      // wording of a tool it knows by name, and a host that is not OpenCode
      // describes its tools in its own words. The host's parameters are left
      // as they are, since Zen does not read those and the call the model
      // makes has to fit the tool that will run it.
      setDescription(body.tools[index], spoken.description);
      continue;
    }
    // The names in `required` are stood in for: a host that is not OpenCode has
    // no tool by these names, and Zen reads a request as belonging to a
    // generation partly by the tools it carries. `required` is deliberately
    // wider than what Zen was measured to insist on — `read` alone was answered,
    // and everything but `read` was refused, on 2026-10-15 — because a wider
    // set is served, so the extra names cost a host that lacks them only the
    // tokens of a tool it will not call, and they are the first thing a
    // tightened check would otherwise find missing.
    if (!profile.required.includes(name)) continue;
    // Declared through `functions` rather than `tools`: this host does have the
    // tool, so it is not one to stand in for. Its wording is still the host's,
    // though, and Zen reads the wording of a tool it knows by name whichever
    // array carried it — leaving that one entry as the host wrote it is the
    // refusal this loop exists to prevent, and it is the entry `explain()`
    // would then describe wrongly. The legacy shape carries `description` at
    // the top level, which `setDescription` already handles.
    const throughFunctions = legacy.find((tool) => tool?.name === name);
    if (throughFunctions) {
      setDescription(throughFunctions, spoken.description);
      continue;
    }
    filled.push(name);
    // A tool added here has nothing behind it: the agent has no such tool, so a
    // call to it goes to the agent as called and comes back as the agent's own
    // unknown-tool error, which the model corrects. Describing it as OpenCode
    // describes it is what Zen asks for, and that description also makes the
    // model want to call it, so the note goes after the opening Zen reads and
    // before the closing it does not.
    body.tools.push(shapeOf({ ...spoken, description: `${spoken.description}\n\n${PLACEHOLDER}` }, protocol));
  }
  return { declared, filled, generation };
}

// The description sits inside `function` on the chat shape and beside the name
// on the other two, and which one a host used is its own business: it is
// matched by where the name was found, so a tool sent in the other shape still
// has its wording read and replaced.
function setDescription(tool, description) {
  if (tool?.function) tool.function.description = description;
  else if (tool) tool.description = description;
}

function shapeOf(definition, protocol) {
  if (protocol === "chat") return { type: "function", function: definition };
  if (protocol === "anthropic") {
    return {
      name: definition.name,
      description: definition.description,
      input_schema: definition.parameters,
    };
  }
  return { type: "function", ...definition };
}

// Zen's own wording for a refusal says only that the request did not look like
// OpenCode's, which sends people off to change headers. Everything the plugin
// sends apart from the tool wording is what Zen expects — the endpoint, the
// shape of the User-Agent, both session headers — so a refusal this far in is
// about the wording, and this says so, and says which wording went out.
//
// The body arrives already read: on this path the refusal has to be read for
// the window it may name before the message that replaces it is built (see
// limits.mjs), and a response body can only be read once. So the text is passed
// in rather than read here, and every reply this function rebuilds is built
// under headers that describe the bytes it returns. A refusal that is not this
// route's — or one whose body could not be read at all — is handed on as it
// arrived.
function explain(text, source, toolPolicy) {
  if (source.status !== 403 && source.status !== 426) return source;
  // Zen's free tier names itself in the body. Without the body there is no way
  // to tell its refusal from anybody else's 403, and this is an error path on a
  // request whose caller is waiting, so the answer is passed on rather than
  // guessed at.
  if (text === null) return source;
  // A 403 that is not Zen's free tier is somebody else's; it is left as sent —
  // its bytes are what arrived, and so are the headers describing them.
  if (source.status === 403 && !text.includes("FreeTierError")) return source;
  // The same lookup `normalizeTools` made, through the same owner: the refusal
  // this message explains is about the generation that request was sent as, and
  // a capture that lost that profile has to say so rather than fail on `.tools`.
  const profile = profileFor(toolPolicy.generation);
  const names = Object.keys(profile.tools).join(", ");
  const { filled } = toolPolicy;
  // 426 is not a refusal of the wording: it is this plugin presenting itself as
  // an OpenCode older than Zen accepts, which only a newer copy of it answers.
  const message =
    source.status === 426
      ? `OpenCode Zen answered 426 Upgrade Required: this plugin presents itself as OpenCode ${profile.agent.opencode} and Zen now wants a newer one. Update the plugin, or run inside a newer OpenCode.`
      : [
          "OpenCode Zen's free tier refused this request as not coming from OpenCode.",
          `Zen reads the wording of ${names} from the request body, not only its headers, and wants OpenCode's own. The wording sent was this package's, for OpenCode ${profile.agent.opencode}.`,
          filled.length
            ? `The host declares none of ${filled.join(", ")}, so those were added from it.`
            : `The host declared every one of them; only the wording was replaced, and its own parameters were kept so its tools still run.`,
          "OpenCode rewords those tools between releases. Run `bun run check:gate` from a clone of this repository to see whether that copy is still current; if it is not, capture the wording again from a current OpenCode and update this package.",
        ].join(" ");
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: source.status === 426 ? "upgrade_required" : "FreeTierError", message },
    }),
    { status: source.status, statusText: source.statusText, headers: rewrittenHeaders(source) },
  );
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastStamp = 0;
let counter = 0;

// An id the way OpenCode makes one (packages/schema/src/identifier.ts):
// 12 hex of Date.now() * 0x1000 + a per-millisecond counter (bit-inverted
// for a session, so newer sorts first), then 14 random base62 characters.
// Zen's free tier checks a session id has this shape, a small counter
// included, and answers 403 FreeTierError to one that doesn't (#100).
//
// The counter is the low 12 bits of the id and realSessionID reads it back as
// a counter, so it is kept inside the 4 bits OpenCode's own counter lives in
// and wraps there rather than carrying into the time field: the 16th id of one
// millisecond would otherwise say it was made later than it was, and stop
// reading as an id OpenCode could have made. A millisecond that produces
// sixteen ids is a burst, and every id of it still has the shape Zen checks.
export function opencodeID(prefix, descending, now = Date.now()) {
  if (now !== lastStamp) {
    lastStamp = now;
    counter = 0;
  }
  counter = counter >= 15 ? 1 : counter + 1;
  const current = BigInt(now) * 0x1000n + BigInt(counter);
  const value = (descending ? ~current : current) & 0xffffffffffffn;
  const random = randomBytes(14);
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 62];
  return `${prefix}_${value.toString(16).padStart(12, "0")}${tail}`;
}

// A session id OpenCode itself could have made: its counter (the low 12
// bits, inverted) is small. A hash cut to the same shape isn't one.
export function realSessionID(value) {
  const match = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/.exec(value ?? "");
  return !!match && 0xfff - Number.parseInt(match[1], 16) < 16;
}

// One made-up session per conversation, so its turns keep one session.
const SESSIONS = new Map();
const KEEP_SESSIONS = 1000;

export function sessionID(headers, body) {
  let signal;
  for (const name of [
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
    "conversation-id",
  ]) {
    if (headers.get(name)) {
      signal = headers.get(name);
      break;
    }
  }
  if (typeof body.metadata?.session_id === "string") signal ??= body.metadata.session_id;
  if (realSessionID(signal)) return signal;
  const messages = body.messages ?? body.input;
  const first = Array.isArray(messages)
    ? messages.find((message) => message.role === "user")?.content
    : messages;
  // A host signal is the conversation's own name for itself, so it is the key
  // on its own and nothing else is folded in beside it: a host that carries a
  // signal may open a later turn with a shortened history, and keyed by the
  // opening too, the same conversation would answer a new id the moment its
  // first message moved. It is also what keeps two conversations that happen to
  // open with the same words — "hi", a template prompt — in separate Zen
  // sessions rather than one, and the only thing that can: a host that sends no
  // signal at all is keyed by its opening below, and two such hosts with one
  // opening are one key. That limit is pinned in session.test.mjs.
  //
  // `first === ""` is separated from `first === undefined` because an empty
  // opening is a conversation with nothing to key by, which a host signal still
  // names, while no user message at all is a body with nothing to key by. Read
  // by truthiness — as `!first` read both — the two are one branch, and the
  // signal is spent before either can be told from the other.
  if (signal !== undefined) {
    const named = createHash("sha256").update(`ses\0${signal}`).digest("hex");
    return kept(named);
  }
  // An empty opening has nothing to key a conversation by, and one cannot be
  // invented: two of them are indistinguishable from a single one, so any key
  // derived here would either be shared by unrelated conversations — one Zen
  // session, with its affinity and its quota — or differ again on the next
  // turn. Not sharing is the half worth keeping, so this answer is minted per
  // call exactly as the unnamed case below is.
  if (first === "" || first === undefined) {
    // Nothing names this conversation: no session header, no metadata, and no
    // user message to key one by. There is no identity to keep for the next
    // turn, so this one gets an id of its own rather than being folded into
    // whichever conversation happened to arrive first — but it is still an id
    // of OpenCode's shape, because that shape is what the tier checks.
    return opencodeID("ses", true);
  }
  return kept(createHash("sha256").update(`ses\0${JSON.stringify(first)}`).digest("hex"));
}

// The id kept for a key, minted on first sight and reused while the key stays
// in the map. Every caller that names a conversation goes through here, so the
// eviction of the oldest entry is written once rather than at each key.
function kept(key) {
  let session = SESSIONS.get(key);
  if (session) {
    SESSIONS.delete(key);
  } else {
    session = opencodeID("ses", true);
    if (SESSIONS.size >= KEEP_SESSIONS) SESSIONS.delete(SESSIONS.keys().next().value);
  }
  SESSIONS.set(key, session);
  return session;
}

async function server(_input, options = {}) {
  const baseURL = httpURL(options.baseURL ?? DEFAULT_BASE);
  const catalogURL = httpURL(options.catalogURL ?? CATALOG);
  const docsURL = httpURL(options.docsURL ?? DOCS);
  let known = buildModels(
    Object.keys(bootstrapProvider.models),
    bootstrapProvider,
    bootstrapProtocols,
    baseURL,
  );
  let metadata = bootstrapProvider;
  let protocols = { ...bootstrapProtocols };
  // When the list was last read, or last asked for: 0 until the first ask. A
  // failed ask sets it too, so a host whose listing can't be read waits out the
  // same interval as one whose listing can, instead of asking three times with
  // a 15 s timeout each on every request that names a model it doesn't know.
  let listedAt = 0;

  // The discovery in flight, and who is waiting for it. Nineteen of the twenty
  // requests a host makes name a model already known, so this exists for the
  // ones that do not: without it two of them arriving together both read the
  // listing, the catalogue and the docs — six upstream reads for one answer —
  // and then race to write `known`, `metadata` and `protocols`, so which of the
  // two survives is whichever settled last. One flight, one write.
  let inflight = null;
  // What every caller's lease travels on: the reads end when the last caller
  // waiting for them has gone, and not before. A host that walks away from one
  // request is still a host, so one caller's abandonment must not cancel an
  // answer another is still waiting for.
  //
  // A lease is a caller's membership of the flight it waits for, and it is
  // released by the first of the two things that end that caller's interest: its
  // own signal aborting, and the flight settling. Both are needed, and neither
  // alone is enough. Released only on the caller's signal, a lease taken by a
  // caller that never aborts would outlive every answer it waited for — the
  // `models()` hook and `refresh()` have no signal to give, so there was one
  // such lease for every open of a host's model chooser — and the release that
  // empties the set would then never be the last one, so the reads of a flight
  // whose callers had all walked away would never end. Released only when the
  // flight settles, a caller that walked away would go on being counted as one
  // still waiting, and its abandonment would not end reads nobody wants.
  //
  // The release is the removal and nothing else, and it deliberately does not
  // travel on the caller's own cancel channel (`passing`): aborting that channel
  // is how a caller is told it has given up, so a release that travelled on it
  // would say the same thing as an abandonment — the outcome for a caller whose
  // flight answered would then depend on which of the two promises the race
  // below saw settle first, and a success could be reported as the caller's own
  // walking away. Dropping the registry entry has no such ordering to depend on.
  const leases = new Set();

  // This caller's own way out, and its membership of the flight. `signal` is
  // resolved when the caller's own signal aborts; `release` gives the membership
  // up, and whoever ends that caller's interest first calls it. An
  // already-aborted caller — for which no listener ever fires — ends its lease
  // here rather than holding it for ever.
  function leased(flight, outward) {
    const passing = new AbortController();
    let held = true;
    const lease = {
      signal: passing.signal,
      flight,
      release() {
        if (!held) return;
        held = false;
        leases.delete(lease);
        outward?.removeEventListener("abort", end);
        // The reads are this flight's own, and they are ended only when the last
        // caller waiting for them has gone while the flight is still running: a
        // lease released because the flight settled describes reads that have
        // already ended.
        if (!leases.size && !flight.settled) flight.control.abort();
      },
    };
    const end = () => {
      passing.abort(outward?.reason ?? new DOMException("Aborted", "AbortError"));
      lease.release();
    };
    leases.add(lease);
    if (outward?.aborted) end();
    else outward?.addEventListener("abort", end, { once: true });
    return lease;
  }

  // A caller's wait for a discovery, told which signal says it has given up: a
  // caller that walks away hears about it from its own abort rather than
  // inheriting whoever started the flight's, and the flight itself carries on
  // for the callers still waiting for it.
  function waiting(signal, named) {
    return Promise.race([
      named,
      new Promise((_, reject) => {
        const end = () => reject(signal.reason);
        if (signal.aborted) end();
        else signal.addEventListener("abort", end, { once: true });
      }),
    ]);
  }

  // The discovery one caller waits for. Every caller takes a lease, the ones
  // joining a flight included, so giving up is the caller's own.
  function shared(observed) {
    // A flight that has already answered is not one to join: its result
    // predates this caller's question, which is what the caller is asking
    // again. `inflight` is kept rather than cleared, so this is the same test
    // as "is it still running" and does not race the settle below.
    //
    // A flight whose own controller is already aborted is not one to join
    // either, and this is a different answer from the settled one: its reads
    // have ended or are ending, and the answer it is about to give is the abort
    // that made its last waiting caller leave — so a caller that cancelled
    // nothing of its own would be refused for somebody else's abandonment and
    // its own question would go unasked. The three reads reject a turn after
    // they are aborted, and that flight settles after that, so an arrival in
    // this window is an ordinary request rather than a race with the settle
    // below: one reader's abandonment is not another reader's answer.
    if (inflight && !inflight.settled && !inflight.control.signal.aborted) {
      const lease = leased(inflight, observed);
      return waiting(lease.signal, inflight.named);
    }
    // One controller per flight, and not one held for the server. A flight whose
    // last waiting caller walked away is ended by aborting its own controller,
    // and a signal held for the server instead is that aborted one for every
    // discovery after it: the listing, the catalogue and the docs would all fail
    // before they were sent, so the models hook, `refresh()` and a request for a
    // model the last list did not have would answer with that abort for the life
    // of the process rather than with the list.
    const flight = { control: new AbortController(), settled: false, named: null };
    inflight = flight;
    const lease = leased(flight, observed);
    const named = reading(flight.control.signal);
    flight.named = named;
    const settled = () => {
      // Set before the releases below: a release reads this flag to tell a
      // flight that has finished its reads from one still running.
      flight.settled = true;
      // Every caller waiting on this flight has now heard its answer — the
      // failure of the reads settles this the same way — so none of them is
      // waiting any more, and the leases go with the flight they were taken on.
      // Its own leases, and only its own: a flight the last caller walked away
      // from is aborted and settles a turn later, and the flight that replaced
      // it can hold leases of its own by then, so releasing those here would
      // hand on the first flight's abandonment to callers who never asked for
      // it — the same refusal the join guard above exists to prevent.
      for (const held of [...leases]) if (held.flight === flight) held.release();
    };
    named.then(settled, settled);
    return waiting(lease.signal, named);
  }

  // The one gate in front of the reads, and the reason it is here rather than
  // at each caller: every path that can start a discovery goes through this
  // function — a request for a model the last list did not have, the `models()`
  // hook a host calls when it opens its model chooser, and `refresh()` — so a
  // budget stated once cannot be spent by one path and bypassed by another. The
  // hook used to call the reads directly, and every open of the chooser was a
  // full round of discovery however recently the last one ran.
  //
  // A failed ask sets `listedAt` too (see `reading`), so a host whose listing
  // cannot be read waits out the same interval as one whose listing can.
  //
  // `force` is for the one caller that is asking on purpose: `refresh()`.
  async function discover(signal, { force = false } = {}) {
    if (!force && Date.now() - listedAt < RELIST_AFTER) return known;
    return shared(signal);
  }

  async function reading(signal) {
    const headers = { authorization: "Bearer public", "x-opencode-client": "cli" };
    const [listing, catalog, docs] = await Promise.allSettled([
      readRemote(`${baseURL}/models`, true, headers, signal),
      readRemote(catalogURL, true, undefined, signal),
      readRemote(docsURL, false, undefined, signal),
    ]);
    signal?.throwIfAborted();
    let partial = false;
    if (catalog.status === "fulfilled" && catalog.value?.opencode?.models) {
      metadata = catalog.value.opencode;
    } else {
      partial = true;
    }
    if (docs.status === "fulfilled" && Object.keys(parseProtocolDocs(docs.value)).length) {
      // The snapshot is the floor, not a rival: the docs say what they say and
      // the snapshot only fills what they no longer name.
      protocols = { ...bootstrapProtocols, ...parseProtocolDocs(docs.value) };
    } else {
      partial = true;
    }
    if (listing.status !== "fulfilled" || !Array.isArray(listing.value?.data)) {
      listedAt = Date.now();
      const fallback = { ...known };
      fallback[Symbol.for("magpie.fellBack")] = true;
      return fallback;
    }
    const ids = listing.value.data.map((item) => item.id);
    const discovered = buildModels(ids, metadata, protocols, baseURL);
    if (partial) {
      // Preserve previously verified models only while they remain in the live catalog.
      //
      // "The catalogue describes it" is read here as it is read in models.mjs:
      // a row that is not a description describes nothing, whatever it is. The
      // catalogue writes `null` for a row it could not fill in, and `null` is
      // falsy, so the truthiness this used to test happened to answer the same
      // way for that one shape — but `"junk"` and `7` are not descriptions
      // either and are truthy, and they were read as if they were.
      //
      // An array is named as well as an object, because `typeof []` is
      // `"object"` and the row shape the catalogue must never write is exactly
      // the one a bare `typeof` check waves through: read as a description, the
      // model it describes is not kept, which is a model silently disappearing
      // for a catalogue row that could not be filled in.
      //
      // A row that is not a description is the same fact as no row at all:
      // `buildModels` has already resolved the id without it (through the docs,
      // or the `-free` rule), so what is preserved here is a model this plugin
      // verified before, and holding it back because the catalogue wrote a row
      // it could not fill in would be the same silent disappearance the `-free`
      // rule exists to prevent.
      //
      // The entry kept is read as an object for the same reason: `known` only
      // ever holds maps this plugin built, so anything else there is a shape
      // this loop cannot reason about, and keeping it would carry it onward as
      // a model. Judged rather than assumed, because the cost of being wrong is
      // paid by a host on a hook it is waiting for.
      //
      // All three reads are own-property reads (`Object.hasOwn`), the same rule
      // models.mjs and limits.mjs read their maps by. `known`, `protocols`,
      // `discovered` and the catalogue's own map are all plain objects keyed by
      // ids that arrived from upstream, so a name that is not a key at all —
      // `toString` and the rest of `Object.prototype` — reads as a *value*
      // through the prototype chain: `protocols["toString"]` is a function, so
      // `!protocols[id]` was false and the entry was skipped for an id no
      // catalogue ever described. What is under a name nobody wrote is what the
      // prototype has, and it belongs to no model.
      //
      // `buildModels` skips `"__proto__"` before any of this, so the write below
      // is unreachable for that id today. It is written safely anyway: this
      // branch's job is to put a model in the map, and a `map[id] = value` for
      // that id is the prototype setter rather than a write — a guard in another
      // module is not the place this write's safety is decided.
      for (const id of ids) {
        const kept = known[id];
        if (
          !Object.hasOwn(discovered, id) &&
          !describesModel(catalogueRow(metadata, id)) &&
          !Object.hasOwn(protocols, id) &&
          Object.hasOwn(known, id) &&
          describesModel(kept)
        ) {
          own(discovered, id, kept);
        }
      }
      // Deliberately not said as fallen back. Zen's own list was read, and what
      // it lists is what gets offered; said as a fallback, magpie keeps the last
      // list it read in full instead, and a host that cannot reach the catalogue
      // or the docs — GitHub's raw host, from mainland China — would never see a
      // model Zen made free since (yetone/magpie#2385). A listing that could not
      // be read is still said so, above, because then this really is the last
      // list there was.
    }
    known = discovered;
    listedAt = Date.now();
    return discovered;
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "OpenCode Zen Free",
        npm: SDK.chat,
        api: baseURL,
        models: configModels(known),
      };
    },
    auth: {
      provider: PROVIDER,
      icon: "https://opencode.ai/favicon-v3.ico",
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: "Zen 免费访问（密钥填 public；个人 key 请加到内置的 OpenCode Zen）",
          placeholder: "public",
          async authorize() {
            return { type: "success", key: "public" };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        requirePublic(auth);
        return {
          baseURL,
          apiKey: "public",
          async fetch(input, init) {
            requirePublic(await getAuth());
            const request = new Request(input, init);
            const protocol = Object.keys(PATHS).find(
              (key) => request.url === `${baseURL}${PATHS[key]}`,
            );
            if (!protocol || request.method !== "POST")
              throw new Error("Unsupported Zen endpoint or method");
            request.signal.throwIfAborted();
            const body = await request.json();
            if (!body || typeof body !== "object" || Array.isArray(body))
              throw new Error("Expected a JSON request object");
            if (!Object.hasOwn(known, body.model) && Date.now() - listedAt >= RELIST_AFTER) {
              await discover(request.signal);
            }
            const model = Object.hasOwn(known, body.model) ? known[body.model] : undefined;
            if (!model) {
              // Zen no longer gives it free, or never did: said as a model
              // not served, so the caller sets this model aside and not the
              // account, whose other free models are still served.
              const free = Object.keys(known).sort().join(", ");
              const name = typeof body.model === "string" ? body.model : "";
              return new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "not_found_error",
                    message: `Model ${name} is not available as an OpenCode Zen free model now. Free models: ${free || "none"}.`,
                  },
                }),
                { status: 404, headers: { "content-type": "application/json" } },
              );
            }
            if (model.api.npm !== SDK[protocol]) {
              throw new Error(
                "Model is not an available free model for this protocol. Refresh the model list.",
              );
            }
            const streaming = body.stream === true;
            body.stream = true;
            const toolPolicy = normalizeTools(body, protocol);
            if (protocol === "chat")
              body.stream_options = { ...body.stream_options, include_usage: true };
            // Adding a header here is the easiest way to break this plugin: Zen
            // takes a request for one generation of OpenCode or the other, and a
            // header belonging to neither is as good as saying so. The names are
            // outboundHeaders', which is also what the gate asks Zen with.
            const given = request.headers;
            const session = sessionID(given, body);
            const project = _input?.project;
            const headers = outboundHeaders({
              session,
              // The generation the tools in this request say, which is the one
              // normalizeTools has already decided: deciding it twice is how a
              // User-Agent and a body come to describe different generations.
              agent: agentForRequest(protocol, toolPolicy.generation, given),
              protocol,
              given,
              project:
                given.get("x-opencode-project") ||
                (project?.vcs === "git" && project.id ? project.id : "global"),
            });
            const response = await fetch(request.url, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
              redirect: "error",
            });
            // A refusal is the one place this route states its own window, and
            // it has to be read before explain() replaces the body. See
            // limits.mjs: an under-declared window is never refused, it is just
            // quietly never used.
            //
            // A response body can only be read once, so what the limits reader
            // took is handed on as the response the rest of the path works with
            // (see `relayed`): never the upstream's own headers over bytes this
            // package wrote again, and never a prefix presented as the whole
            // reply. A response the reader did not consume is used as it arrived.
            const observed = await observeRouteStatement(body.model, response, undefined, {
              // The caller's own cancellation reaches this read as well: a host
              // that has given up is not waiting for a number out of a refusal.
              signal: request.signal,
            });
            const answered = relayed(response, observed);
            const guarded = await guardToolResponse(
              explain(observed?.text ?? null, answered, toolPolicy),
              protocol,
              toolPolicy,
              { endCutShort: streaming },
            );
            return streaming ? guarded : collapseResponse(guarded, protocol);
          },
        };
      },
      async usage() {
        return { plan: "OpenCode Zen Free", windows: [] };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        requirePublic(auth);
        // Asked without a signal, and deliberately: the hook has none to give,
        // and passing `undefined` on as one would read as a caller that cancels
        // nothing — `leased` takes it as "no way out", which is what this call
        // has. Whether it reads at all is `discover()`'s decision, so a host
        // that opens its model chooser twice in a minute is given the list read
        // the first time instead of a second round of upstream reads.
        return discover();
      },
    },
    // Read the list again now, whatever RELIST_AFTER says: the way for a host
    // (and for a test) to ask for the listing on purpose, rather than having to
    // spend a request on a model the last list did not have to get one. It
    // skips the budget and nothing else — it goes through the same single
    // flight, so a refresh asked for while a discovery is already running waits
    // for that answer instead of reading beside it.
    async refresh() {
      return discover(undefined, { force: true });
    },
    async "chat.headers"(input, output) {
      if (![PROVIDER, `${PROVIDER}-plugin`].includes(input.model?.providerID) || !input.sessionID)
        return;
      // The pair Zen wants, both present and equal (see outboundHeaders). This
      // hook is the one place where the host is asked to carry them, and it asks
      // for these two only: x-session-affinity and x-session-id are in OpenCode's
      // own header set upstream but are not needed, and measured 2026-10-15 two
      // headers of that set together are refused where either one alone answers
      // (tkhs101#100 follow-up).
      output.headers["x-opencode-session"] = input.sessionID;
      output.headers["x-opencode-session-id"] = input.sessionID;
    },
  };
}

export default { id: PROVIDER, server };

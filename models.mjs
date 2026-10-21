import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LIMITS, limitOverrides } from "./limits.mjs";

export const PROVIDER = "opencode-zen-free";
export const SDK = {
  chat: "@ai-sdk/openai-compatible",
  responses: "@ai-sdk/openai",
  anthropic: "@ai-sdk/anthropic",
};

// The endpoint each table row names, as this file's names for them. A row that
// names one outside this set is not a protocol this plugin can ask.
const PROTOCOLS = {
  "chat/completions": "chat",
  responses: "responses",
  messages: "anthropic",
  systemone: "systemone",
};

// The same four endpoints, as the pattern that finds one of them inside a
// cell. The endpoint is looked for in the cell rather than at a fixed place in
// the row, because a table that gains a column moves the cell it was in — and
// a parser that knows one position reads the whole table as empty, which is
// how a responses-only model ends up asked at /chat/completions.
const ENDPOINT = /\/v1\/(chat\/completions|responses|messages|systemone)\b/;

// A model id, as the shape one is written in. Zen's ids are letters, digits,
// dots, dashes and underscores; a cell that is anything else — a display name
// with spaces in it, a sentence — is not an id this plugin can ask for.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// A note this file makes goes to a sink a host installs, or to stderr when the
// environment asks for it — the same arrangement limits.mjs uses for its own
// notes, and for the same reason: the runtime modules of this plugin do not
// print, because a line on every discovery is a chatty error path of its own.
//
// The docs parse is the one place here where a failure has no other trace: a
// table whose shape changed leaves every model on the snapshot's protocol, and
// a model the docs name as /v1/responses is then asked at /chat/completions and
// fails upstream with an error the host cannot explain. Nothing downstream can
// tell that apart from "the docs say nothing", so the parse says it here.
export const MODELS_DEBUG_ENV = "OPENCODE_ZEN_FREE_MODELS_DEBUG";
let diagnostic = null;

// Install the sink these notes are handed to, and return the one it replaced
// (null when there was none) so a caller can put back what it found.
export function modelDiagnostics(sink) {
  const previous = diagnostic;
  diagnostic = typeof sink === "function" ? sink : null;
  return previous;
}

function note(entry) {
  try {
    if (diagnostic) diagnostic(entry);
    else if (globalThis.process?.env?.[MODELS_DEBUG_ENV])
      console.warn(`[opencode-zen-freex] ${entry}`);
  } catch {
    // A note is not worth a failed discovery.
  }
}

// The id a row names, as the shape one is written in: plain, in backticks, or
// as the label of a link. A cell that is none of those is not an id, and a row
// that does not name one is left out rather than guessed at.
function modelId(cell) {
  const text = String(cell ?? "").replace(/`/g, "").trim();
  const linked = /^\[([^\]]+)\]\([^)]*\)$/.exec(text);
  const id = (linked ? linked[1] : text).trim();
  return MODEL_ID.test(id) ? id : undefined;
}

// What is wrong with a document that was read and could not be read, in one
// line: what broke, and what to do about it. A document with rows and no
// endpoint in any of them is a table whose shape changed — the parse is what
// is out of date, not the document — and a document with no rows at all is not
// the table this file reads at all. A document with at least one endpoint is
// fine, however many of its rows are about something else: a pricing row names
// no endpoint, and an endpoint outside the four is not one this plugin asks.
function parseNote(document, rows, matched) {
  if (matched > 0) return undefined;
  if (rows === 0)
    return (
      `the protocol docs document has no table row in it (${document.length} characters): ` +
      "every model is left on the snapshot's protocol — check that the docs URL still serves the models table"
    );
  return (
    `the protocol docs table has ${rows} rows and none of them names an endpoint this plugin asks ` +
    "(/v1/chat/completions, /v1/responses, /v1/messages, /v1/systemone): the table's shape changed " +
    "and every model is left on the snapshot's protocol"
  );
}

// What a read of the protocol docs found: the protocols it names, the table
// rows it saw, and the rows an endpoint could be read out of. The counts are
// the difference between "the docs say nothing" and "the docs were read and
// this file could not read them" — the first is a fact about the document, the
// second a fact about this parser, and only the second is a failure to say.
export function parseProtocolDocsReport(text) {
  const protocols = {};
  const document = String(text ?? "");
  let rows = 0;
  let matched = 0;
  for (const line of document.split("\n")) {
    const row = line.trim();
    if (!row.startsWith("|")) continue;
    rows += 1;
    const cells = row.split("|").map((cell) => cell.trim());
    const at = cells.findIndex((cell) => ENDPOINT.test(cell));
    // The id is the cell before the endpoint, not the second cell of the row:
    // a table that gains a column — or loses one, or renames one — still says
    // which id it is talking about right before it says which endpoint that id
    // is asked at.
    if (at < 1) continue;
    const id = modelId(cells[at - 1]);
    if (!id) continue;
    protocols[id] = PROTOCOLS[ENDPOINT.exec(cells[at])[1]];
    matched += 1;
  }
  return { protocols, rows, matched, note: parseNote(document, rows, matched) };
}

// The protocols the docs name, and a note when they name none: a parse that
// fails silently is the failure this pair exists to end, so the note is made
// here, where the document was read, rather than in the caller that cannot
// tell an empty answer from an unreadable document.
export function parseProtocolDocs(text) {
  const report = parseProtocolDocsReport(text);
  if (report.note) note(report.note);
  return report.protocols;
}

// Which protocol a package name speaks, as this file's names for them. The
// package is a string, and the catalogue writes other things as well: a
// number, a boolean, an object. `npm?.` covers the two shapes that are not
// there at all and nothing else, so `npm.includes` on a number was a
// TypeError — and that throw left `sdkProtocol` → `protocolFor` →
// `buildModels` → the discovery that called it, so one dirty row upstream
// took every free model with it. That is the failure the rest of this file is
// written to prevent, and this field was the one that had no guard.
//
// A package that is not a string names no protocol this plugin asks, which is
// the same fact the `-free` rule below is for: the id is offered on its own
// name, at the provider's own protocol, rather than dropped.
function sdkProtocol(npm) {
  if (typeof npm !== "string") return undefined;
  if (npm.includes("anthropic")) return "anthropic";
  if (npm === SDK.responses) return "responses";
  if (npm.includes("openai-compatible")) return "chat";
}

// Whether a value the catalogue wrote is a description of a model, as opposed to
// a row it could not fill in. `null` is the shape the catalogue uses for the
// latter, and an array is the same fact: `typeof []` is `"object"`, but the
// catalogue writes one row per model and a list is not a row — every axis a
// description carries is absent from it, so reading one as a description reads
// nothing as something.
//
// The same test, by rule, as `provider.mjs`'s own `describesModel` — each file
// keeps its own name for it, and this comment is where the two names are tied
// together. The reader there decides whether a row may stand in for a model, and
// the two sides deciding differently about one row is a model whose fate depends
// on which file looked at it. This one is this file's own — the two are kept in
// step by their comments and their tests, not by a shared export, so neither
// file's public surface grows for the other's sake.
//
// Exported nowhere, deliberately: a test asks about the rule through the models
// it produces, which is the thing the rule is for.
function isDescription(row) {
  return typeof row === "object" && row !== null && !Array.isArray(row);
}

// Set, and not merely present: the catalogue writes both a missing date and an
// explicit null, and neither retires a model. A blank string is not a date
// either — see `isSet` below, which is the same rule stated for the two axes
// the retirement checks read.
const hasValue = (value) => value !== null && value !== undefined;

// Whether what the catalogue wrote is a container — a list, an object, a
// function — rather than the single value these fields are. A status is a word
// and a date is a date; `["2026-01-01"]` is neither, and `String` writes a list
// as one non-empty string, so a field nobody filled in passed the "does it say
// something" test below and retired a model: it left the offered list with
// nothing in the table and nothing in a note to say why, which is the silent
// loss every shape rule in this file exists to prevent. `typeof null` is
// `"object"`, so the null `hasValue` refuses on its own account is refused here
// as well.
const isContainer = (value) => typeof value === "object" || typeof value === "function";

// A status has to say something to be one. The catalogue writes an empty string
// as well as a null, and either one used to stand in front of the `lifecycle`
// that does retire the model, so a model retired through `lifecycle` kept being
// offered. A status that is set — "active" included — is still read as itself.
//
// The shape of what was written is part of "says something": a list or an object
// is not a status and not a date, and reading one as either is how a field that
// states nothing retired a model. `hasValue` is left as it is — "was anything
// written here at all" and "does what was written say something" are two rules,
// and only this one is about the shape of the answer.
const isSet = (value) => hasValue(value) && !isContainer(value) && String(value).trim() !== "";

// A status ends a model when it says the model is gone: "retired" and
// "disabled" are endings. "deprecated" is not one — it says the catalogue
// expects the model to go, and what decides whether it is still there is the
// list Zen serves, which discovery already reads: measured 2026-10-16,
// `muse-spark-1.2-contributor-free` is marked deprecated in the catalogue while
// Zen lists it and the free tier answers a request for it through this plugin,
// so reading that status as an ending hid a model that was being served.
// The two readings below take a catalogue row's *fields* — `deprecated`,
// `status`, `lifecycle`, the two date axes, `cost` — and read them directly,
// where the own-property rule stated further down is about a map read by a key
// an upstream chose. The difference is what can collide: a key can be named
// `toString` by a listing, while a field name here is written by this file and
// the row is what `JSON.parse` built, so the only thing that puts another value
// under one is a prototype polluted process-wide — which is not a shape this
// file can tell from the real thing, and not one it pretends to guard against.
const ENDED = ["retired", "disabled"];

function isRetired(model) {
  return (
    model.deprecated === true ||
    ENDED.includes(isSet(model.status) ? model.status : model.lifecycle) ||
    // Read through `isSet`, not `hasValue`: a blank `deprecated_at` is the empty
    // string the catalogue writes for a date it does not have, and reading it as
    // a date retired a model that was still on offer. An effective date is an
    // ending whatever the status beside it says.
    isSet(model.deprecated_at) ||
    isSet(model.retirement_date)
  );
}

export function isFree(id, model = {}) {
  return (
    !isRetired(model) && (/-free$/i.test(id) || (model.cost?.input === 0 && model.cost?.output === 0))
  );
}

// Whether an id names itself free — Zen names them "-free" — which is all this
// can know about one that neither the catalogue nor the docs describe yet: Zen
// made it free after they were last written, or they could not be read. Such a
// model is asked the way OpenCode asks a model with no package of its own,
// through the provider's own (openai-compatible, and so chat), so a new free
// model is offered the hour Zen lists it rather than the hour the catalogue
// catches up. An id that does not call itself free still needs the catalogue's
// word (a paid one, or a zero-cost one Zen never named).
//
// The same question `isFree` asks, and answered the same way: case-insensitive.
// Asked case-sensitively, an id like `new-model-FREE` passed the free gate above
// and then found no protocol here, so it was dropped at the `SDK` lookup below —
// silently, which is the one outcome the fallback exists to prevent.
function listedFree(id) {
  return /-free$/i.test(id);
}

// Which protocol a model is asked at, in the order the answer is trusted: the
// console docs' own endpoint first, then the package the catalogue gives the
// model (or its provider), and last the provider's own protocol for an id that
// names itself free and neither of those describes. Nothing here is a guess at
// an endpoint — the fallback is openai-compatible, which is what the provider
// speaks. A protocol outside `SDK` leaves the model out below rather than
// sending it somewhere it is not served: `systemone` and a model the catalogue
// drops do not appear.
function protocolFor(id, model, raw, provider, protocols) {
  // Own properties only. `protocols` is a plain object, so `protocols["toString"]`
  // is a truthy function — the model would be dropped for naming a protocol
  // outside `SDK` instead of being resolved from the catalogue or its `-free`
  // name, and `protocols["__proto__"]` would be an inherited protocol nobody
  // wrote. What the docs actually say about an id is an own property or nothing.
  if (Object.hasOwn(protocols, id)) return protocols[id];
  // The catalogue resolving to no protocol is not the same fact for both of the
  // branches below, and they are read in that order for it.
  //
  // A catalogue entry whose package maps to no protocol is one this plugin
  // cannot ask as the catalogue describes it — the "half-described" id, where
  // the entry exists and its `npm` names a package `SDK` has never heard of.
  // That is the same hole the `-free` fallback exists for, and it used to be the
  // one shape the fallback could not reach: the entry was there, so `raw` was
  // truthy, so the fallback was skipped and the id was dropped silently — while
  // the very same id with no catalogue entry at all was offered.
  //
  // An id whose protocol *was* resolved — by the docs, to a name inside
  // `PROTOCOLS` that this plugin has no SDK for, `systemone` above all — is a
  // different fact and never falls through to the guess: the docs have said
  // what this id speaks, and it is not something this plugin asks. That name
  // comes back from the lookup above, so it never reaches this branch at all;
  // what a package that maps to nothing answers is `undefined`, which is what
  // keeps "no protocol could be read here" apart from "this id is not one this
  // plugin asks".
  const catalogProtocol = raw ? sdkProtocol(model.provider?.npm ?? provider.npm) : undefined;
  if (catalogProtocol !== undefined) return catalogProtocol;
  if (listedFree(id)) return sdkProtocol(provider.npm) ?? "chat";
  return undefined;
}

const modalities = (values) =>
  Object.fromEntries(
    ["text", "image", "audio", "video", "pdf"].map((name) => [
      name,
      Array.isArray(values) && values.includes(name),
    ]),
  );

// A window is a positive whole number of tokens. The catalogue writes an
// explicit `null` — and an empty string, and a zero — for an axis it does not
// have, and every one of those used to be copied over the 32768/4096 defaults by
// the spread below, so the host was handed `context: null` as the model's window.
const usable = (value) => Number.isSafeInteger(value) && value > 0;

// The axes a host reads a model's size from, and the only ones this file
// copies. The catalogue writes what it writes into `limit`, and it may write
// an axis nobody named: a `max_input` beside the `input` this file knows, or
// a name from a schema this plugin has never heard of. The row is checked for
// being an object, but its keys were not checked, so every one of them was
// copied — and a limit map is the one object a host plans a prompt from, so an
// axis nobody reads is not a smaller thing there: it is a number the host
// cannot interpret, in the map it interprets.
//
// The three are the ones the evidence below is written in: `limits.mjs` reads
// and writes the same three, and so does the host's own `context_window` and
// `max_input_tokens`.
const KNOWN_AXES = new Set(["context", "input", "output"]);

// The limit the model is offered with, from the axes that are usable: the
// defaults first, then the catalogue's own numbers, then what the plugin has
// evidence for — each level only contributing axes it can actually state.
//
// Exported, because this is the pair the plugin puts on the wire and the
// maintenance tool that reports on limits has to compare against the same one:
// a second copy of the defaults and the "an axis has to be a usable whole
// number" rule is a second answer to drift. The table is a parameter so a
// caller can hand in its own — the shipped one is the default.
export function limitFor(id, declared, canonical, table = LIMITS) {
  const limit = { context: 32768, output: 4096 };
  // An axis map has to be one, by the same rule the row is read by. `limit` is
  // an object of named axes, and `Object.entries` reads a list as its indices:
  // a row whose `limit` was `[111, 222]` handed the host
  // `{0: 111, 1: 222, context: 32768, output: 4096}` — axes no catalogue named,
  // on the one object a host plans a prompt from. The evidence lookup is handed
  // the same map, so neither level can read an axis off a shape that has none.
  const axes = isDescription(declared) ? declared : {};
  for (const [axis, value] of Object.entries(axes))
    if (KNOWN_AXES.has(axis) && usable(value)) limit[axis] = value;
  // `canonical` is the id for the same weights, which is the only name
  // models.dev publishes a row under: a free id is one provider's alias and the
  // second opinion is matched by weights, not by the name this route gave it.
  for (const [axis, value] of Object.entries(limitOverrides(id, axes, table, undefined, undefined, undefined, undefined, canonical)))
    // The same rule the catalogue loop above states, asked of the second source
    // as well: a table is data this file did not observe for itself, and a
    // shipped or caller-supplied entry that says `null`, `0` or a negative for
    // an axis states no window. Only a usable number becomes one.
    if (KNOWN_AXES.has(axis) && usable(value)) limit[axis] = value;
  return limit;
}

export function buildModels(ids, provider, protocols, baseURL) {
  const result = {};
  for (const id of ids) {
    // `__proto__` is skipped where the id is first known to be a string: it can
    // never be an entry in the catalogue's own map, since on a plain object the
    // write side of it is the prototype. The own-property read below leaves it
    // unresolved for that same reason, so this is the redundant half of a pair —
    // kept because it states the rule at the point the rule is about.
    if (typeof id !== "string" || !id || id === "__proto__") continue;
    // The catalogue's own entry for the id, not whatever Object.prototype has
    // under that name: `models?.["toString"]` is a function, and reading it as a
    // description of the model would invent a protocol for an id nothing
    // describes. An id with no entry here is one the catalogue has not caught up
    // with, which the `-free` rule below is for.
    const catalogue = provider.models ?? {};
    // ...and an entry that is not a description describes nothing either, so it
    // is left unresolved exactly like a missing one instead of being carried out
    // of this loop as a description. `null` is the shape the catalogue writes
    // for a row it could not fill in, and a list is the same fact one step
    // harder to see — see `isDescription` above, which is the rule both sides of
    // the tree read a row by. The other side is `provider.mjs`'s
    // `describesModel`, asked of the same row on its partial-catalogue path
    // while it decides which models to preserve, and the two answering
    // differently is a model whose fate depends on which file looked at it. One
    // dirty row upstream must not be the whole list: a model is not a thing
    // worth failing discovery over, and the `-free` name is already this file's
    // rule for an id the catalogue cannot speak for.
    //
    // Skipped rather than reported, and the difference matters: what a skipped
    // row costs is a model the catalogue itself could not describe — no
    // protocol, no limits, no capabilities — and the models that are described
    // are still offered, which is the outcome this file exists for. A row this
    // malformed is also visible where it is made: it is the catalogue's own
    // data, upstream of discovery — and the note this file does have a sink
    // for is the other failure, the one nothing downstream can see: the docs
    // table above, read into nothing.
    const listed = Object.hasOwn(catalogue, id) ? catalogue[id] : undefined;
    const raw = isDescription(listed) ? listed : undefined;
    const model = raw ?? {};
    const protocol = protocolFor(id, model, raw, provider, protocols);
    if (!isFree(id, model) || !Object.hasOwn(SDK, protocol)) continue;
    // The two axes a host reads a model's abilities from, by the rule the
    // efforts below are read by and for the same reason: `??` covers a field the
    // catalogue left out and nothing else, so a word, a number or an object
    // written there was taken for a list and `input.some(...)` threw out of
    // `buildModels` — taking every free model with it, which is the failure the
    // row rule above exists to prevent. A shape that is not a list is read as
    // the field's own default, which is what a field nothing was written about
    // is read as: text-only, the one thing a model here is known to read. The
    // whole field written as a word or a list already read that way through
    // `?.`, and still does.
    const input = Array.isArray(model.modalities?.input) ? model.modalities.input : ["text"];
    const output = Array.isArray(model.modalities?.output) ? model.modalities.output : ["text"];
    // The efforts a model offers, from the list the catalogue writes them in.
    // `?? []` covers a list the catalogue left out and nothing else, and a wrong
    // shape here does not read as a wrong value but ends the whole call:
    // `.filter` is not a function on an object or a string, and `option.type` on
    // a `null` element is a TypeError — either one threw out of `buildModels`, so
    // one dirty row upstream took discovery down with it, which is the failure
    // the row rule above exists to prevent. A list that is not a list, and an
    // element that is not a description, are read as no efforts: the model is
    // still offered, without the variants nobody could state.
    const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
    const efforts = options
      .filter((option) => isDescription(option) && option.type === "effort")
      .flatMap((option) => (Array.isArray(option.values) ? option.values : []));
    result[id] = {
      id,
      providerID: PROVIDER,
      name: model.name ?? id,
      api: { id, url: baseURL, npm: SDK[protocol] },
      limit: limitFor(id, model.limit, model.canonical_model_id),
      capabilities: {
        temperature: model.temperature ?? true,
        reasoning: model.reasoning ?? false,
        attachment: model.attachment ?? input.some((name) => name !== "text"),
        toolcall: model.tool_call ?? true,
        input: modalities(input),
        output: modalities(output),
        interleaved: model.interleaved ?? false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      variants: Object.fromEntries(efforts.map((effort) => [effort, { reasoningEffort: effort }])),
      options: {},
      headers: {},
      status: model.status ?? "active",
      release_date: model.release_date ?? "",
      free: true,
    };
  }
  return result;
}

// What each free model is asked at, from OpenCode's console docs
// (services/www/src/docs/content/console/models.mdx) on 2026-10-15: used for
// a listed model when the docs can't be read, so the catalog or the docs
// being out of reach never leaves a listed free model out. Jev is a
// SystemOne decision model, not one to chat with.
export const bootstrapProtocols = {
  "big-pickle": "chat",
  "space-bunny-free": "chat",
  "cat-jam-free": "chat",
  "longcat-2.5-preview-free": "chat",
  "step-5-preview-free": "chat",
  "mimo-v2.6-flash-free": "chat",
  "nemotron-3.5-lightning-free": "chat",
  "muse-spark-1.3-contributor-free": "responses",
  "jev-1.13-free": "systemone",
  // The free tier's list on 2026-10-16, when these five appeared: the four chat
  // ones and the responses one below, whose paid twin the docs table names.
  "deepseek-v4.1-flash-free": "chat",
  "glm-5.3-flash-free": "chat",
  "ll-alpha-free": "chat",
  "nemotron-3.5-super-vl-free": "chat",
  "muse-spark-1.2-contributor-free": "responses",
};

// Offline bootstrap metadata from the OpenCode catalog, 2026-10-06; the free
// models listed since added on 2026-10-15, and the ids the tier was serving on
// 2026-10-16 added then. A host that reaches nothing on its first run offers
// these; the first discovery replaces the list.
export const bootstrapProvider = {
  npm: SDK.chat,
  models: {
    "cat-jam-free": {
      name: "Cat Jam Free",
      cost: { input: 0, output: 0 },
      limit: { context: 262144, output: 131072 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    },
    "step-5-preview-free": {
      name: "Step 5 Preview Free",
      cost: { input: 0, output: 0 },
      limit: { context: 1000000, input: 1000000, output: 65536 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      modalities: { input: ["text", "image", "video"], output: ["text"] },
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
    },
    "longcat-2.5-preview-free": {
      name: "LongCat 2.5 Preview Free",
      cost: { input: 0, output: 0 },
      limit: { context: 1000000, output: 131072 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      modalities: { input: ["text", "image"], output: ["text"] },
    },
    "mimo-v2.6-flash-free": {
      name: "MiMo-V2.6-Flash Free",
      cost: { input: 0, output: 0 },
      limit: { context: 200000, output: 32000 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
    },
    "nemotron-3.5-lightning-free": {
      name: "Nemotron 3.5 Lightning Free",
      cost: { input: 0, output: 0 },
      limit: { context: 262144, output: 262144 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
    },
    "big-pickle": {
      name: "Big Pickle",
      cost: { input: 0, output: 0 },
      limit: { context: 200000, input: 160000, output: 32000 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
    },
    "space-bunny-free": {
      name: "Space Bunny Free",
      cost: { input: 0, output: 0 },
      limit: { context: 1048576, input: 524288, output: 524288 },
      reasoning: true,
      tool_call: true,
    },
    "muse-spark-1.3-contributor-free": {
      name: "Muse Spark 1.3 Free",
      cost: { input: 0, output: 0 },
      provider: { npm: SDK.responses },
      limit: { context: 1048576, output: 131072 },
      reasoning: true,
      tool_call: true,
      modalities: { input: ["text", "image", "video", "pdf", "audio"], output: ["text"] },
      reasoning_options: [
        { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] },
      ],
    },
    // The free ids the tier was serving on 2026-10-16 and this snapshot did not
    // carry. Their numbers are the catalogue's, as every other entry here is —
    // `limits.mjs` is what corrects the ones the catalogue under-reports, and it
    // carries entries for two of these.
    "deepseek-v4.1-flash-free": {
      name: "DeepSeek V4.1 Flash Free",
      cost: { input: 0, output: 0 },
      limit: { context: 200000, output: 32000 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    },
    "glm-5.3-flash-free": {
      name: "GLM-5.3-Flash Free",
      cost: { input: 0, output: 0 },
      limit: { context: 200000, output: 32000 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      modalities: { input: ["text", "image", "video", "pdf"], output: ["text"] },
      reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
    },
    "ll-alpha-free": {
      name: "LL Alpha Free",
      cost: { input: 0, output: 0 },
      limit: { context: 262144, output: 65536 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      modalities: { input: ["text"], output: ["text"] },
      reasoning_options: [
        { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
      ],
    },
    "nemotron-3.5-super-vl-free": {
      name: "Nemotron 3.5 Super VL Free",
      cost: { input: 0, output: 0 },
      limit: { context: 1048576, output: 131072 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning_options: [
        { type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh"] },
      ],
    },
    "muse-spark-1.2-contributor-free": {
      name: "Muse Spark 1.2 Free",
      cost: { input: 0, output: 0 },
      provider: { npm: SDK.responses },
      limit: { context: 1048576, output: 131072 },
      reasoning: true,
      tool_call: true,
      modalities: { input: ["text", "image", "video", "pdf", "audio"], output: ["text"] },
      reasoning_options: [
        { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] },
      ],
    },
  },
};

export function configModels(models) {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [
      id,
      {
        id,
        name: model.name,
        provider: { npm: model.api.npm, api: model.api.url },
        limit: model.limit,
        reasoning: model.capabilities.reasoning,
        tool_call: model.capabilities.toolcall,
        attachment: model.capabilities.attachment,
        modalities: {
          input: Object.keys(model.capabilities.input).filter(
            (key) => model.capabilities.input[key],
          ),
          output: Object.keys(model.capabilities.output).filter(
            (key) => model.capabilities.output[key],
          ),
        },
        cost: { input: 0, output: 0 },
        variants: model.variants,
        free: true,
      },
    ]),
  );
}

// ---- what a discovery read leaves for the next process ---------------------
//
// A discovery round that reached the route is worth remembering: the free tier
// moves, a restart otherwise begins with the bootstrap table, and the first
// request after it pays for a listing the previous process already read. The
// cache is an input to discovery, not a second source of truth: a missing,
// unreadable or malformed file answers no measurement, and discovery asks the
// route exactly as it did before this file existed.
//
// Nothing here may fail a request. A file that cannot be written is a cache that
// is not remembered; a file that cannot be read is a listing that has to be
// fetched again. Both are silent by design, and both are bounded: the file is
// read under one ceiling and written through a temporary beside it, so a crash
// between the write and the rename leaves the old file whole rather than a
// half-written listing.
export const DISCOVERY_CACHE_ENV = "OPENCODE_ZEN_FREE_DISCOVERY_CACHE";
// The version is bumped with any change to the rows this build accepts, not
// only to the document's shape. A v1 cache can hold a row written before
// `cachedModel` required `capabilities`, and a reader that filters such a row
// out keeps a listing that silently lost a model — the version check is what
// turns that into "fetch it again" instead.
const DISCOVERY_CACHE_VERSION = 2;
// A cache is a listing, not a measurement, so the limit is larger than the
// state file's: what it bounds is how much a request path can be asked to read
// from a file it did not write.
const DISCOVERY_CACHE_LIMIT = 8 * 1024 * 1024;
const DISCOVERY_PROTOCOLS = new Set(["chat", "responses", "anthropic"]);
// An ISO date or date-time. `Date.parse` accepts shapes that are not ISO, so
// the pattern is what decides that the value is the kind of string the cache
// writes; the parse is what rejects a date the calendar cannot hold.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/;

// Where the last discovery is remembered. The explicit path wins; the
// environment names one next; an empty string is the documented way to keep
// discovery in memory only. Otherwise the platform's cache directory, which is
// the same rule limits.mjs states for its own state, under this plugin's
// directory and a file of its own.
export function discoveryCachePath(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) return explicit === "" ? undefined : explicit;
  const named = env?.[DISCOVERY_CACHE_ENV];
  if (typeof named === "string") return named === "" ? undefined : named;
  const home = homedir();
  const base = env?.LOCALAPPDATA || env?.XDG_CACHE_HOME || (home ? join(home, ".cache") : "");
  return base ? join(base, "opencode-zen-freex", "discovery.json") : undefined;
}

function isIsoDate(value) {
  return (
    typeof value === "string" &&
    ISO_DATE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

// The date the cache states is stored as ISO text. A caller that already has a
// `Date` (or the millisecond number discovery keeps today) is accepted and
// normalized, so the file has one spelling of the time whatever the caller
// started with.
function listedAtISO(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return isIsoDate(value) ? value : undefined;
}

// The model records this file wrote. A row that is not a description is not a
// model (the same rule buildModels reads a catalogue row by), and `__proto__`
// can never be an id a listing names because the write side of it is the
// prototype. Everything else is kept as it was written: the cache is a copy of
// the provider's own records, not a second reading of them.
//
// An object is not yet a model record. `provider.mjs` reads `api.npm` off every
// row before a request can be sent, and `limit`/`capabilities` off the same row
// while listing; a hand-edited or truncated row that keeps `{ id }` and loses
// those would turn a bad cache into a runtime TypeError on the request path.
// The fields required here are the ones the record cannot be served without;
// everything else stays as written.
function cachedModel(id, row) {
  return (
    isDescription(row) &&
    row.id === id &&
    isDescription(row.api) &&
    typeof row.api.npm === "string" &&
    typeof row.api.url === "string" &&
    isDescription(row.limit) &&
    // The same rule, for the fields `configModels` reads after discovery hands
    // the record on: it takes `reasoning` and the two modality maps off
    // `capabilities`, and `Object.keys(undefined)` on a row that kept only
    // `{ id, api, limit }` is a TypeError on the listing path. A cache this
    // build wrote may not become a throw where it is read.
    isDescription(row.capabilities) &&
    isDescription(row.capabilities.input) &&
    isDescription(row.capabilities.output)
  );
}

function cachedModels(models) {
  const out = {};
  for (const [id, row] of Object.entries(models)) {
    if (typeof id !== "string" || !id || id === "__proto__") continue;
    if (!cachedModel(id, row)) continue;
    out[id] = row;
  }
  return out;
}

// The protocol map is filtered, not trusted: a protocol this build cannot ask
// is not made true by being in a cache. A valid entry is kept even when the
// model map has no row for it — the provider's protocol map also carries the
// bootstrap entries for ids the last listing did not offer, and dropping those
// here would make the cache a narrower map than the one it is a copy of.
function cachedProtocols(protocols) {
  const out = {};
  for (const [id, protocol] of Object.entries(protocols)) {
    if (id === "__proto__") continue;
    if (!DISCOVERY_PROTOCOLS.has(protocol)) continue;
    out[id] = protocol;
  }
  return out;
}

// One read of at most `buffer.length` bytes from the start of a file, and the
// count it answered with. A file larger than the buffer is not read past it: the
// caller allocates one byte more than its ceiling, so the extra byte is what
// says "there was more" without asking how much. A `read` on a regular file may
// answer with fewer bytes than asked for, so the loop is what makes the count
// the file's rather than one system call's.
// Exported so the bound is pinned by a test: the cache's stat refuses an oversized file first.
export async function readAtMost(file, buffer) {
  const handle = await open(file, "r");
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset;
  } finally {
    await handle.close();
  }
}

// Read the last discovery. A missing file, a bad JSON document, a foreign
// version, a date that is not one, and a map that is not a map all answer the
// same way: no cache. The call never throws; discovery can always ask the
// route.
export async function readDiscoveryCache(file) {
  if (!file) return undefined;
  try {
    // What the ceiling bounds is how much a request path can be asked to read
    // from a file it did not write, so it is a bound on the read and not on a
    // size read before one. `stat` first is what refuses a path that is not a
    // regular file, and its size is what avoids opening a file already known to
    // be too large; neither is the guarantee — a file can grow between the stat
    // and the read, and a procfs-style file reports a size of 0 whatever it
    // holds. The read itself asks for one byte past the ceiling, so a file that
    // grew is refused by the answer rather than buffered whole.
    //
    // `size` is bytes and the text length below is characters: the read is the
    // I/O bound, the length after it is the parse bound, so both stay.
    const info = await stat(file);
    if (!info.isFile() || info.size > DISCOVERY_CACHE_LIMIT) return undefined;
    const buffer = Buffer.allocUnsafe(DISCOVERY_CACHE_LIMIT + 1);
    const read = await readAtMost(file, buffer);
    if (read > DISCOVERY_CACHE_LIMIT) return undefined;
    const text = buffer.subarray(0, read).toString("utf8");
    if (text.length > DISCOVERY_CACHE_LIMIT) return undefined;
    const parsed = JSON.parse(text);
    if (!isDescription(parsed) || parsed.version !== DISCOVERY_CACHE_VERSION) return undefined;
    if (!isDescription(parsed.models) || !isDescription(parsed.protocols)) return undefined;
    if (!isIsoDate(parsed.listedAt)) return undefined;
    const models = cachedModels(parsed.models);
    return {
      models,
      protocols: cachedProtocols(parsed.protocols),
      listedAt: parsed.listedAt,
    };
  } catch {
    return undefined;
  }
}

// Remember a discovery. The write is best-effort: a caller that cannot write
// the cache is told so, and discovery carries on. The temporary is named per
// write (this process's pid plus a counter), so two writes inside one process
// cannot truncate each other's file, and it is removed when the rename fails so
// a failed write leaves no `.tmp` for the next run to mistake for state.
let discoverySaveSequence = 0;

export async function writeDiscoveryCache(file, cache) {
  if (!file || !isDescription(cache)) return false;
  const { models, protocols } = cache;
  if (!isDescription(models) || !isDescription(protocols)) return false;
  const listedAt = listedAtISO(cache.listedAt);
  if (!listedAt) return false;
  let temporary;
  try {
    const body = `${JSON.stringify(
      { version: DISCOVERY_CACHE_VERSION, models, protocols, listedAt },
      null,
      2,
    )}\n`;
    await mkdir(dirname(file), { recursive: true });
    temporary = `${file}.${globalThis.process?.pid ?? 0}.${discoverySaveSequence++}.tmp`;
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    return true;
  } catch {
    if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

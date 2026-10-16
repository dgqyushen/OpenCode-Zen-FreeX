// Zen's catalogue is where a model's limits are declared from, and for some
// free ids it under-reports them. A free id and its paid twin are the same
// upstream model — x-opencode-upstream-model-id answers
// "deepseek/deepseek-v4.1-flash" whichever of the two is asked for — and only
// the paid one is declared at what that model can actually do.
//
// A limit the host believes is acted on. The window decides when a
// conversation is compacted and whether a request is worth sending at all; the
// output cap is sent as max_tokens on every request. So an under-reported limit
// is not the conservative choice, it is a wrong one nobody can see: a window
// that is too small is never refused, it is just quietly never used, and an
// output cap that is too small cuts replies off with a finish reason that looks
// like the model's own decision.
//
// Only evidence moves a value here, and evidence is sorted:
//
//   route       the route's own refusal, in its own words
//   route-twin  what this route declares for the same upstream model
//   vendor      the model vendor's published page
//   witnessed   a generation somebody watched finish
//
// Being accepted is not evidence. Zen answers 200 to max_tokens 2000000 under a
// short prompt, so a value that is accepted says something about the request
// and nothing about what the model writes. A route or route-twin value may set
// any number; a vendor or witnessed one may only raise, because lowering a
// limit on weaker evidence invents a restriction nobody asked for.
//
// Every axis carries the catalogue value it was measured against. A catalogue
// that moves voids that axis rather than leaving a stale number behind, and a
// refusal that names a different window while the plugin is running corrects it
// for the rest of the process (see observeRouteStatement).
export const LIMITS = {
  "deepseek-v4.1-flash-free": {
    context: {
      value: 1048576,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-15",
      samples: "1,048,507 tokens served; 1,048,707 and 1,060,000 refused 4/4",
      how: "a prompt sized just over the window; Zen's own 400 answers \"This model's maximum context length is 1048576 tokens. However, you requested 1422278 tokens (1038278 in the messages, 384000 in the completion).\"",
    },
    output: {
      value: 384000,
      source: "route-twin",
      declaredAt: 32000,
      measured: "2026-10-15",
      samples: "one reply of 306,880 completion tokens, finish=stop; nothing above it observed",
      how: "deepseek-v4.1-flash, the paid id serving the same upstream model, is declared 384000 in this same catalogue; DeepSeek's own page says 384K, which is 393216 read as binary K",
    },
  },
  "mimo-v2.6-flash-free": {
    context: {
      value: 1048576,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-15",
      samples: "an 850,249 token prompt served, its needle echoed back; a prompt just over the window refused 400",
      how: "a different upstream from the DeepSeek ids, and it says so in its own words: \"This endpoint's maximum context length is 1048576 tokens. However, you requested about 1496523 tokens (1295079 of text input, 1444 of tool input, 200000 in the output).\"",
    },
    output: {
      value: 131072,
      source: "vendor",
      declaredAt: 32000,
      measured: "2026-10-15",
      samples: "nothing above 32000 watched on this route; that same refusal came back with the requested 200000 unclamped",
      how: "Xiaomi's own entry for mimo-v2.6-flash, api.xiaomimimo.com and its China token plan, declares 1048576/131072, as do DeepInfra and nan; this route declares 32000 for the free id and states no completion ceiling of its own",
    },
  },
  "big-pickle": {
    output: {
      value: 131072,
      source: "route",
      declaredAt: 32000,
      measured: "2026-10-15",
      samples: "the endpoint refused the request asking for 200000 and named its own ceiling; nothing watched above 32000",
      how: "\"max_tokens is too large: 200000. This model supports at most 131072 completion tokens, whereas you provided 200000.\" — an upstream that validates the requested ceiling and states its own. No context entry: this id is the same upstream model as mimo-v2.6-flash-free (x-opencode-upstream-model-id answers mimo-v2.6-flash) on a different endpoint, and two endpoints of one model are not one window — the attempt to measure this one answered 200 with an empty body, which is not an answer, so that axis stays with the catalogue.",
    },
  },
  "nemotron-3.5-lightning-free": {
    context: {
      value: 1000000,
      source: "route",
      declaredAt: 262144,
      measured: "2026-10-15",
      samples: "a refusal that named the window, which is what `bun run limits:audit` asks for; nothing near the wall has been served yet",
      how: "\"This endpoint's maximum context length is 1000000 tokens. However, you requested about …\" — read from the refusal the audit provoked by asking for more completion tokens than the window leaves, on the same upstream that words it as the mimo entry above. The catalogue declares 262144 for this id.",
    },
  },
  "longcat-2.5-preview-free": {
    output: {
      value: 262144,
      source: "route",
      declaredAt: 131072,
      measured: "2026-10-15",
      samples: "the ceiling named by a refusal, from the same audit run; nothing above 131072 watched on this route",
      how: "\"Upstream request failed: [invalid_parameter] 参数校验失败: /max_tokens: 1000000 is not less or equal to 262144\" — the second wording namedOutputCap reads, where the ceiling is the number max_tokens has to stay under. Its context needs nothing: the catalogue's 1000000 is what that same refusal calls the endpoint's window.",
    },
  },
};

// "This model's maximum context length is 1048576 tokens. However, you
// requested 1422278 tokens (1038278 in the messages, 384000 in the
// completion)." — the route's own words, and the only sentence seen on this
// route that states a window. A second upstream phrases the same fact as "This
// endpoint's maximum context length is ...", with the request broken into text
// input, tool input and output; both are the route naming its own window, and
// its "requested about" figure is a rough one (chars, not tokens) rather than
// the count a served request reports in `usage.prompt_tokens`. A generic 400
// says nothing attributable and is left alone; §7 of the measured notes has a
// context overflow and an invalid parameter answering with byte-identical 400s
// on another Zen model.
const NAMED_CONTEXT = /maximum context length is (\d+) tokens/i;

// "max_tokens is too large: 200000. This model supports at most 131072 completion
// tokens, whereas you provided 200000." — an upstream that validates the ceiling
// it was asked for and names its own, which is the only sentence seen on this
// route that states a completion ceiling at all. It is worth knowing that the
// DeepSeek upstream does not validate: `max_tokens: 2000000` under a short prompt
// answers 200 there, so silence from this one says nothing about a model, and a
// request that is served is not evidence of a ceiling either way.
const NAMED_OUTPUT = [
  /supports at most (\d+) completion tokens/i,
  // "/max_tokens: 1000000 is not less or equal to 262144" — LongCat's wording for
  // the same fact, where the ceiling is the number it has to stay under.
  /max_tokens:?\s*\d+\s+is not less or equal to\s+(\d+)/i,
];

// Names a refusal made while this process is running, by model id. Not
// persisted: the same kind of fact as LIMITS, only newer, so a restart falls
// back to what was measured last.
const OBSERVED = new Map();
const OBSERVED_OUTPUT = new Map();

// Two decisions this file makes leave no trace of themselves: a live value
// taken from a refusal is applied past the staleness guard and past the
// raise-only rule, and an entry the catalogue has moved past is void in a way
// that reads exactly like an axis nobody ever measured. Neither is worth a line
// while the plugin is working — an error path that chats is its own kind of
// failure — so both are only reported when they are asked for: a host hands in
// a sink with `limitDiagnostics`, or sets this variable and reads stderr.
// Nothing a note does may reach a request: not the sink, not what it prints.
export const LIMITS_DEBUG_ENV = "OPENCODE_ZEN_FREE_LIMITS_DEBUG";
let diagnostic = null;

// Install the sink these notes are handed to, and return the one it replaced
// (null when there was none) so a caller can put back what it found.
export function limitDiagnostics(sink) {
  const previous = diagnostic;
  diagnostic = typeof sink === "function" ? sink : null;
  return previous;
}

function note(entry) {
  try {
    if (diagnostic) diagnostic(entry);
    else if (globalThis.process?.env?.[LIMITS_DEBUG_ENV])
      console.warn(`[opencode-zen-freex] ${describe(entry)}`);
  } catch {
    // A note is not worth a failed request.
  }
}

function describe({ kind, id, axis, value, measuredAgainst, declared }) {
  if (kind === "route-statement")
    return `${id} ${axis}=${value} — named by a refusal this process saw, so it is applied as it stands (the catalogue declares ${declared === undefined ? "nothing for this axis" : declared})`;
  return `${id} ${axis}=${value} was measured against a catalogue that declared ${measuredAgainst}, and this one declares ${declared === undefined ? "nothing for this axis" : declared}: not applied`;
}

// The window a refusal names, or undefined when the body says nothing
// attributable. Exported for the tests and for anyone reading a capture.
export function namedContextWindow(text) {
  return namedFrom([NAMED_CONTEXT], text)?.value;
}

// The completion ceiling a refusal names, or undefined. Same rule as the window:
// the body has to name the parameter and a number, or it says nothing. Two
// wordings state it, and one that matches but names no usable number — "supports
// at most 0 completion tokens" — is not an answer; the next wording may be.
export function namedOutputCap(text) {
  return namedFrom(NAMED_OUTPUT, text)?.value;
}

// The first of `patterns` that names a usable number, with the match it was read
// from. The match and the number have to be the same one: a caller that guards a
// match and then reads its number elsewhere is judging one sentence and
// returning another.
function namedFrom(patterns, text) {
  const subject = typeof text === "string" ? text : "";
  for (const pattern of patterns) {
    const match = pattern.exec(subject);
    const value = numberFrom(match);
    if (value !== undefined) return { match, value };
  }
  return undefined;
}

// The number a match names, or undefined when it names nothing usable: a
// sentence about a parameter that happens to mention zero names no ceiling.
function numberFrom(match) {
  if (!match) return undefined;
  const tokens = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

// Read at most `limit` characters of a response without buffering the rest:
// this is an error path on a request whose caller is waiting, so a body that is
// not small is dropped as soon as the part that is read is in hand. Returns the
// text, and whether the read stopped because the body ended (`ended`) or because
// the budget was reached (`over`).
//
// It reads the response's own body, not a copy of it. `response.clone()` tees a
// body, and cancelling one branch of a tee settles only once the other branch is
// drained or cancelled — which for the caller's path is never, because the
// sibling branch is read later, after this returns. A clone here hangs the whole
// request on any refusal larger than the budget that arrives in more than one
// read (measured: a 7 KB 400 in 1400-character chunks never settles, and an
// abort does not unwedge it). The body is read once and the bytes go back to
// the caller, so nothing needs a second copy.
//
// The read is bounded in time as well as in size, because a body can stall as
// well as be large. Measured: a 403 whose `content-length` promised 999 bytes
// and delivered 120 left `read()` pending for good, which hung the request just
// as surely as the clone did — an upstream that dies mid-body, or a proxy that
// pads a length, is the same shape. `signal` is the caller's own cancellation;
// without one the budget below is all the wait this evidence is worth, since a
// number out of a refusal that is not arriving is not worth a caller's turn.
//
// A body that fails halfway is still worth what was read of it, and a read that
// throws is not an error about the request: the callers of this are error paths
// themselves.
const READ_DEADLINE_MS = 3000;

export async function readBoundedText(response, limit = 4096, { signal } = {}) {
  let reader;
  try {
    reader = response?.body?.getReader?.();
  } catch {
    // A body somebody else is holding cannot be read, and nothing of it was
    // read: what came back is not the whole of a body, and says so.
    return { text: "", ended: false, over: true };
  }
  // A response with no stream has no body to read and none to buffer — which is
  // why the fallback that read one whole is gone: the only responses that
  // reached it were body-less, and a body-less response's text is empty either
  // way.
  if (!reader) return { text: "", ended: true, over: false };
  const deadline = AbortSignal.timeout(READ_DEADLINE_MS);
  const bound = signal ? AbortSignal.any([signal, deadline]) : deadline;
  // The wait ending is this read's to remember, not the reader's: cancelling a
  // stream resolves its pending `read()` as done, so a body cut short by the
  // deadline would come back looking like one that ended — and a number at the
  // end of it like a whole one. Measured before this flag existed: a stalled
  // refusal whose last characters were `...is not less or equal to 2621`, out of
  // `262144`, was stored and applied as a completion ceiling.
  let cut = false;
  const abort = () => {
    // The wait is over and the bytes already read are all this evidence is
    // going to be; stop pulling on a body that is not answering.
    cut = true;
    reader.cancel().catch(() => {});
  };
  if (bound.aborted) abort();
  else bound.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  let ended = false;
  try {
    // The loop runs while the budget has room for one more character, so a body
    // that lands exactly on the budget still gets the read that says it ended,
    // and one that goes on is caught by the buffer stopping a character past it.
    while (text.length <= limit) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      // At most one character past the budget: enough to know the body went on,
      // and the rest of the chunk is dropped rather than materialised.
      text += decoder.decode(value, { stream: true }).slice(0, limit + 1 - text.length);
    }
  } catch {
    // Keep what was read; a failed read names nothing new. A read that was
    // cancelled by the deadline lands here too, which is the point of it.
  }
  bound.removeEventListener("abort", abort);
  // A read the wait cut short saw no end of body, whatever the cancelled reader
  // said about it.
  if (cut) ended = false;
  // The reader is this function's to release, and the body is abandoned rather
  // than left open: the caller has what it needs and will not read on.
  //
  // The cancel is deliberately not awaited. It stops the upstream either way,
  // but the promise it returns settles only once the source reacts — and this
  // path is an error body on a request whose caller is waiting. A body that
  // never ends (a stalled upstream, or headers promising more bytes than the
  // response delivers: measured, a 403 with `content-length: 999` over a 120-byte
  // body) would leave the await pending for good, which is the same hang this
  // function was rewritten to remove. Nothing downstream reads this body again,
  // so its release is nobody's to wait for.
  reader.cancel().catch(() => {});
  // `over` is the read having stopped before the body did — the budget reached,
  // or the read failed, or the deadline passing — which is the only honest
  // source for "this may be cut".
  return { text, ended, over: !ended };
}

// Read a refusal for the names it makes about this model's limits. Only non-2xx
// responses are read, and only the first `limit` characters of one.
//
// A response body can only be read once, and the response handed in is treated
// as read once this returns: the bytes come back as `text` so that a caller
// which has to keep them (provider.mjs rebuilds the message a user reads) can
// do so without a second read of a body that no longer exists.
//
// `cut` says the read stopped at the budget rather than at the end of the body.
// It is the read that says so, not the length of what was read: a body whose
// first read lands exactly on the budget leaves `text.length === limit` while
// the stream is still going, and a number sliced there (`262144` read as
// `2621`) must not be taken for a limit the route stated.
//
// Returns undefined only when nothing was read — a response that is not a
// refusal, or one with no body to read — and otherwise whichever axes the text
// named, with that text alongside them. An axis the body did not name is
// undefined; a body that named nothing still comes back, because a caller that
// has to hand it on has nowhere else to get it from.
export async function observeRouteStatement(id, response, limit = 4096, { signal } = {}) {
  try {
    if (typeof id !== "string" || !id || response?.ok !== false) return undefined;
    // A response with no body was not read and is not consumed: the caller
    // still holds the one it had, and undefined says so.
    if (response.body == null) return undefined;
    const { text, over } = await readBoundedText(response, limit, { signal });
    const { context, output } = namedAxes(text, limit, over);
    if (context !== undefined) OBSERVED.set(id, context);
    if (output !== undefined) OBSERVED_OUTPUT.set(id, output);
    return { context, output, text };
  } catch {
    return undefined;
  }
}

// How close to the end of what was read a match has to end before a truncated
// body makes it unusable. A number ending inside this margin of the last
// character read may have had digits past it — `2621` where the body said
// `262144` — and a smaller limit that looks like a real one is the one failure
// this guard exists to prevent. Numbers further back are inside the buffer
// entirely and are read as they stand.
const CUT_MARGIN = 8;

// The axes the first `limit` characters of `text` name. `cut` says the read
// stopped at the budget with the body going on, so a match ending at the margin
// may have been a longer number: that axis is left unread rather than reported a
// digit short. Each axis is read from the match its number came from, so the
// match the guard judges and the number that is returned cannot be two answers.
function namedAxes(text, limit, cut) {
  const head = text.slice(0, limit);
  const context = namedFrom([NAMED_CONTEXT], head);
  const output = namedFrom(NAMED_OUTPUT, head);
  const onCut = (found) =>
    cut && Boolean(found) && found.match.index + found.match[0].length >= head.length - CUT_MARGIN;
  return {
    context: onCut(context) ? undefined : context?.value,
    output: onCut(output) ? undefined : output?.value,
  };
}

const ROUTE_TIERS = new Set(["route", "route-twin"]);

// What this plugin declares for a model instead of what the catalogue says, as
// a plain object to spread over the catalogue's own limit. Empty when there is
// no evidence, when the evidence was measured against a different catalogue, or
// when it would change nothing.
export function limitOverrides(
  id,
  declared = {},
  table = LIMITS,
  observed = OBSERVED,
  observedOutput = OBSERVED_OUTPUT,
) {
  const overrides = {};
  // A record has to be this table's own. `table[id]` otherwise answers out of
  // Object.prototype for `toString` and the rest, and out of whatever prototype
  // an object handed in as `table` carries — evidence for a model nobody
  // declared, from a table that never named it.
  const record = table && Object.hasOwn(table, id) ? table[id] : undefined;
  for (const axis of ["context", "output"]) {
    const declaredValue = declared?.[axis];
    const entry = record?.[axis];
    const live = (axis === "context" ? observed : observedOutput)?.get(id);
    // A route statement made while this process was running is the same tier as
    // the table and newer than it, so it is taken as it stands. Everything else
    // has to have been measured against the catalogue in front of us now: the
    // value it was measured against has to exist and still be the declaration,
    // and one that names no such value was measured against nothing.
    let value;
    if (live !== undefined) {
      value = live;
    } else if (entry && declaredValue !== undefined && entry.declaredAt === declaredValue) {
      value = entry.value;
    } else if (entry) {
      // Measured against a catalogue that has moved, or against an axis the
      // catalogue no longer declares. Its value is void, and saying so is the
      // whole point of the note: otherwise this is indistinguishable from a
      // model nothing was ever measured for.
      note({
        kind: "catalogue-drift",
        id,
        axis,
        value: entry.value,
        measuredAgainst: entry.declaredAt,
        declared: declaredValue,
      });
    }
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0) continue;
    if (value === declaredValue) continue;
    // Weaker evidence may only raise, and that holds for the table alone: a live
    // refusal is the route itself and is taken as it stands, entry or no entry.
    if (
      live === undefined &&
      entry &&
      !ROUTE_TIERS.has(entry.source) &&
      Number.isSafeInteger(declaredValue) &&
      value < declaredValue
    )
      continue;
    overrides[axis] = value;
    // A live value is the one override taken past the staleness guard and past
    // the raise-only rule, so it is the one nobody can account for afterwards:
    // say what was applied and what it stands in for.
    if (live !== undefined) note({ kind: "route-statement", id, axis, value, declared: declaredValue });
  }
  return overrides;
}

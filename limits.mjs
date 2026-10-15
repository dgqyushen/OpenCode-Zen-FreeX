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

// Windows named by a refusal while this process is running, by model id. Not
// persisted: it is the same kind of fact as LIMITS, only newer, and a restart
// falls back to what was measured last.
const OBSERVED = new Map();

// The window a refusal names, or undefined when the body says nothing
// attributable. Exported for the tests and for anyone reading a capture.
export function namedContextWindow(text) {
  const match = NAMED_CONTEXT.exec(typeof text === "string" ? text : "");
  if (!match) return undefined;
  const tokens = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

// Read a refusal for a window it names. Only non-2xx responses are read, and
// only the first `limit` characters of one: this is an error path on the
// request's way to a caller that is waiting, so it must never be able to fail a
// request, change a response, or buffer a body that is not small.
export async function observeRouteStatement(id, response, limit = 4096) {
  try {
    if (typeof id !== "string" || !id || response?.ok !== false) return undefined;
    const text = await response
      .clone()
      .text()
      .catch(() => "");
    const tokens = namedContextWindow(text.slice(0, limit));
    if (tokens !== undefined) OBSERVED.set(id, tokens);
    return tokens;
  } catch {
    return undefined;
  }
}

const ROUTE_TIERS = new Set(["route", "route-twin"]);

// What this plugin declares for a model instead of what the catalogue says, as
// a plain object to spread over the catalogue's own limit. Empty when there is
// no evidence, when the evidence was measured against a different catalogue, or
// when it would change nothing.
export function limitOverrides(id, declared = {}, table = LIMITS, observed = OBSERVED) {
  const overrides = {};
  const record = table?.[id];
  const live = observed?.get(id);
  for (const axis of ["context", "output"]) {
    const declaredValue = declared?.[axis];
    const entry = record?.[axis];
    // A route statement made while this process was running is the same tier as
    // the table and newer than it, so it is taken as it stands. Everything else
    // has to have been measured against the catalogue in front of us now.
    const value =
      axis === "context" && live !== undefined
        ? live
        : entry && entry.declaredAt === declaredValue
          ? entry.value
          : undefined;
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0) continue;
    if (value === declaredValue) continue;
    if (entry && !ROUTE_TIERS.has(entry.source) && Number.isSafeInteger(declaredValue) && value < declaredValue)
      continue;
    overrides[axis] = value;
  }
  return overrides;
}

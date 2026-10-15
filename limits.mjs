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

// The window a refusal names, or undefined when the body says nothing
// attributable. Exported for the tests and for anyone reading a capture.
export function namedContextWindow(text) {
  return namedNumber(NAMED_CONTEXT, text);
}

// The completion ceiling a refusal names, or undefined. Same rule as the window:
// the body has to name the parameter and a number, or it says nothing.
export function namedOutputCap(text) {
  for (const pattern of NAMED_OUTPUT) {
    const value = namedNumber(pattern, text);
    if (value !== undefined) return value;
  }
  return undefined;
}

function namedNumber(pattern, text) {
  const match = pattern.exec(typeof text === "string" ? text : "");
  if (!match) return undefined;
  const tokens = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

// Read a refusal for the names it makes about this model's limits. Only non-2xx
// responses are read, and only the first `limit` characters of one: this is an
// error path on the request's way to a caller that is waiting, so it must never
// be able to fail a request, change a response, or buffer a body that is not
// small. A number the read cut in half names nothing either, since half of one
// is a smaller limit that looks like a whole one. Returns undefined when the
// body names nothing attributable, otherwise whichever axes it named.
export async function observeRouteStatement(id, response, limit = 4096) {
  try {
    if (typeof id !== "string" || !id || response?.ok !== false) return undefined;
    const text = await readPrefix(response, limit);
    // `readPrefix` stops at `limit`, so the last character read may be the first
    // half of a longer number. Both words this reads are numbers inside prose —
    // the window's ends in the literal "tokens", but the second ceiling wording
    // ends with the digits it captured, so `/max_tokens: 1000000 is not less or
    // equal to 2621` carved out of 262144 reads as a ceiling Zen stated. Live
    // values are taken as they stand, past the staleness check and the guard
    // below, so that half a number would become the applied max_tokens. A match
    // that runs up to the cut is therefore not evidence, on either axis: asking
    // again over one character less only finds the same number one digit
    // shorter, and reading the rest of the body is what this path must not do.
    const { context, output } = namedAxes(text, limit, text.length > limit);
    if (context === undefined && output === undefined) return undefined;
    if (context !== undefined) OBSERVED.set(id, context);
    if (output !== undefined) OBSERVED_OUTPUT.set(id, output);
    return { context, output };
  } catch {
    return undefined;
  }
}

// Read at most `limit` characters of a refusal without buffering the rest: this
// is an error path on a request whose caller is waiting, so a body that is not
// small is dropped as soon as the part that is read is in hand.
async function readPrefix(response, limit) {
  const body = response.clone().body;
  if (typeof body?.getReader !== "function") return response.clone().text().catch(() => "");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A body that fails halfway is still worth what was read of it.
  }
  await reader.cancel().catch(() => {});
  return text;
}

// The axes the first `limit` characters of `text` name. `cut` says the body went
// on past that point, so a match ending on the last character read may have been
// a longer number: that axis is left unread rather than reported a digit short.
function namedAxes(text, limit, cut) {
  const head = text.slice(0, limit);
  const contextMatch = NAMED_CONTEXT.exec(head);
  const outputMatch = NAMED_OUTPUT.map((pattern) => pattern.exec(head)).find(Boolean);
  const onCut = (match) => cut && Boolean(match) && match.index + match[0].length >= limit;
  return {
    context: onCut(contextMatch) ? undefined : namedContextWindow(head),
    output: onCut(outputMatch) ? undefined : namedOutputCap(head),
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
  const record = table?.[id];
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
  }
  return overrides;
}

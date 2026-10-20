import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
// The input axis is the third, and it fails the same way one layer out. A host
// that plans what to send reads it as the room a prompt has; a host that shows a
// model's window reads it as the window itself — measured 2026-10-16, magpie's
// `context_window` and `max_input_tokens` both follow `limit.input` when one is
// declared. So an input axis that under-reports is not only never used, it is
// what a user is shown as the model's size.
//
// Only evidence moves a value here, and evidence is sorted:
//   route       the route's own answer about its own limit: the words of a
//               refusal, or what its own service demonstrates
//   route-twin  what this route declares for the same upstream model
//   route-sweep what the scheduled sweep measured against this same route and
//               checked in beside this file as `limits-observed.json`: the same
//               bracket the route tier records, taken by machine rather than by
//               hand, and the tier that answers for a model this file has never
//               named — which is what a model Zen made free this morning is
//   vendor      the model vendor's published page
//   witnessed   a generation somebody watched finish
//
// The hand-kept table still has the first word for an id it names, because the
// samples and the reasoning are beside its number. The sweep has the last word
// for the ids and axes it does not: a window nobody measured is a window every
// host gets wrong, and waiting for somebody to write a table entry by hand is
// how a new model stays wrong for a week. A sweep says nothing about the output
// axis — it asks no completion for anything — so that axis is still answered by
// the table and the catalogue alone.
//
// Being accepted is not evidence. Zen answers 200 to max_tokens 2000000 under a
// short prompt, so a value that is accepted says something about the request
// and nothing about what the model writes. A route, route-twin or route-sweep
// value may set any number; a vendor or witnessed one may only raise, because
// lowering a limit on weaker evidence invents a restriction nobody asked for.
// A sweep that found no wall is in the same position: making the largest
// prompt it served into a declaration would turn "nothing refused this" into
// "this is the ceiling", so a wall the sweep never hit may only raise too.
//
// Every axis carries the catalogue value it was measured against. A catalogue
// that moves voids that axis rather than leaving a stale number behind, and a
// refusal that names a different window while the plugin is running corrects it
// for the rest of the process (see observeRouteStatement).
export const LIMITS = {
  // The window that used to be here was 1048576, measured on 2026-10-15 from a
  // refusal that named it. On 2026-10-19 the route refused 1,050,000-token
  // prompts and stopped naming anything: past a wall of about 326,700 tokens the
  // answer is 400 `context_length_exceeded` — "Your request resulted in more
  // tokens than this model's maximum context length allows. Please reduce the
  // length of the messages or run compaction." — and there is no number in that
  // sentence to read. What replaced it is a bracket, measured in characters
  // because a refused request reports no `usage.prompt_tokens`: 1,522,400
  // characters of filler were served and counted 326,702 tokens, 1,522,600 was
  // refused three times out of three, and six sessions of 250,413-token prompts
  // were all served. 326000 is the last served point rounded down rather than a
  // figure the route stated — a host has to stop below a wall it can never quite
  // touch, and the wall itself was just demonstrated: 326,750 is refused, so
  // that number cannot be the budget. The margin is also about the endpoints:
  // the same day, 254,196- and 279,095-token requests from a host were refused
  // in the same words while a 331,989-token request was served, so an endpoint
  // that says no sooner can be reached at any size above the catalogue's 200000.
  // The catalogue remains the fallback if this entry is ever voided, and it is
  // the one window Zen itself states.
  //
  // The output axis is untouched, and the route is less forthcoming about it than
  // it was: over 393216 it answered "Invalid max_tokens value, the valid range of
  // max_tokens is [1, 393216]", which is the only sentence seen anywhere on this
  // route that states a completion ceiling as a range, and asking for 1000000
  // later the same day was answered 200 instead. 384000 stays what it was — a
  // figure from the paid twin, which that sentence did not contradict.
  "deepseek-v4.1-flash-free": {
    context: {
      value: 326000,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-19",
      samples: "326,702 tokens served (1,522,400 characters); 1,522,600 characters (about 326,745 tokens) refused 3/3 with context_length_exceeded, as was 1,522,800 and 1,050,000 tokens; 250,413 served from six different sessions. The same day, 254,196- and 279,095-token requests were refused while a 331,989-token one was served, so not every endpoint behind this id draws the wall in the same place. A second sweep the same day served 1,000,000 characters (215,178 tokens) and refused 1,600,000 and 2,800,000, which places the wall in the same region without narrowing it.",
      how: "the route's own enforcement, found by bracketing because its refusal names no number; 326000 is the largest served sample (326,702) rounded down, with room for a host's count to differ from the route's, and not a figure the route ever stated. 326,750 was asked three times and refused three times, so the wall itself cannot be the declared budget. The 1048576 measured on 2026-10-15 is withdrawn: the route that stated it now refuses prompts a third that size.",
    },
    output: {
      value: 384000,
      source: "route-twin",
      declaredAt: 32000,
      measured: "2026-10-15",
      samples: "one reply of 306,880 completion tokens, finish=stop; nothing above it observed. The `[1, 393216]` sentence below did not reproduce on a 2026-10-19 re-ask, which was answered 200, so nothing on this route confirms or contradicts 384000 today",
      how: "deepseek-v4.1-flash, the paid id serving the same upstream model, is declared 384000 in this same catalogue; DeepSeek's own page says 384K, which is 393216 read as binary K",
    },
  },
  "mimo-v2.6-flash-free": {
    context: {
      value: 343000,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-19",
      samples: "343,131 tokens served (1,600,000 characters, counted by the route); 1,900,000 characters (about 407,725 tokens) refused with context_length_exceeded, as were 2,200,000 and 2,800,000 characters. The window the route stated on 2026-10-15 — 1048576, in a refusal that named it — was not reached then either: an 850,249-token prompt was served that day and a prompt of about 1,496,523 tokens was refused.",
      how: "the route's own enforcement, found by bracketing, and 343,000 is the largest served sample rounded down so that a host's count may differ from the route's. The 1048576 this entry used to carry is withdrawn: a prompt of about 408,000 tokens is refused now, less than half of it, which is the same way deepseek-v4.1-flash-free's stated million went. The exact position of the wall between 343,131 and about 407,725 tokens is not known — the sweep stopped at the first refusal — and the figure declared sits under both.",
    },
    output: {
      value: 131072,
      source: "vendor",
      declaredAt: 32000,
      measured: "2026-10-15",
      samples: "nothing above 32000 watched on this route; that same refusal came back with the requested 200000 unclamped, and a 2026-10-19 ask for max_tokens 1000000 was answered rather than refused, so this route states no completion ceiling for this id at all",
      how: "Xiaomi's own entry for mimo-v2.6-flash, api.xiaomimimo.com and its China token plan, declares 1048576/131072, as do DeepInfra and nan; this route declares 32000 for the free id and states no completion ceiling of its own",
    },
  },
  "big-pickle": {
    context: {
      value: 343000,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-19",
      samples: "343,131 tokens served (1,600,000 characters, counted by the route, and identical to mimo-v2.6-flash-free at every shared size); 1,900,000, 2,200,000 and 2,800,000 characters all refused with context_length_exceeded. The first ask at 1,600,000 characters answered 400 with no code field at all, and that same request was then served — one endpoint declining a prompt the next one took.",
      how: "the route's own enforcement, found by bracketing; 343,000 is the largest served sample rounded down so that a host's count may differ from the route's. This entry used to say the axis was left to the catalogue because the one attempt to measure it answered 200 with an empty body, which is not an answer: a 2026-10-19 sweep did measure it, and the catalogue's 200000 is a third of what the route serves.",
    },
    output: {
      value: 131072,
      source: "route",
      declaredAt: 32000,
      measured: "2026-10-15",
      samples: "the endpoint refused the request asking for 200000 and named its own ceiling; nothing watched above 32000. Re-asked with max_tokens 1000000 on 2026-10-19 and named the same 131072, so the number holds",
      how: "\"max_tokens is too large: 200000. This model supports at most 131072 completion tokens, whereas you provided 200000.\" — an upstream that validates the requested ceiling and states its own. This id is the same upstream model as mimo-v2.6-flash-free (x-opencode-upstream-model-id answers mimo-v2.6-flash) on a different endpoint, which is why the two share their measurements above and are still measured apart.",
    },
    // The catalogue declares `input: 160000` for this id, and a prompt of
    // 343,131 tokens was served on 2026-10-19 — a prompt more than twice it, so
    // the declaration is falsified rather than merely small. It matters more than
    // a stale number usually does, because `input` is the axis a gateway reads as
    // the prompt budget: magpie answers `context_window` with the smaller of
    // `context` and `input`, so with 160000 left in place this model was offered
    // a 160000-token window to every host behind it no matter what `context`
    // said. Measured the same way as the window above and from the same sweep.
    input: {
      value: 343000,
      source: "route",
      declaredAt: 160000,
      measured: "2026-10-19",
      samples: "343,131 tokens served (1,600,000 characters), against a declared input of 160000 — more than twice the declaration, which no margin accounts for",
      how: "the prompt the route was measured to serve, which is the same bracket as the context entry above and is what an input axis can be: this route never names an input cap in a refusal, so nothing here is a figure it stated. Declared at the window rather than at the sample, so a host planning a prompt from it and a host planning from the context are told the same thing — the precedent space-bunny-free set when its own input was found to be half of what it serves.",
    },
  },
  "nemotron-3.5-lightning-free": {
    context: {
      value: 1000000,
      source: "route",
      declaredAt: 262144,
      measured: "2026-10-20",
      samples: "a refusal that named the window on 2026-10-15, which is what `bun run limits:audit` asks for; and on 2026-10-20 a prompt of 974,358 tokens was SERVED (`usage.prompt_tokens`), against a catalogue that declares 262144 — so the named million is not a ceiling the pasted round number merely claims, it is a scale the route demonstrably serves at nearly 3.7 times the declaration",
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
  // The two the free tier added on 2026-10-16, each measured the day it was
  // noticed. Both under-report in the catalogue the same way the older entries
  // do, and both were checked on every axis: nothing below is what a refusal
  // happened to say, it is all that was asked.
  "ll-alpha-free": {
    output: {
      value: 262144,
      source: "route",
      declaredAt: 65536,
      measured: "2026-10-16",
      samples: "max_completion_tokens 1000000 and 300000 both refused, each naming 262144; nothing above 65536 watched — the ceiling is the route's own number, four times what the catalogue declares",
      how: "\"Upstream request failed: [400] max_completion_tokens is too large: 300000.This model supports at most 262144 completion tokens.\" — the ceiling is the number the sentence names. Its context needs nothing: the same day's refusal, \"The input (341480 tokens) is longer than the model's context length (262144 tokens).\", is the window the catalogue already declares.",
    },
  },
  "glm-5.3-flash-free": {
    context: {
      value: 311000,
      source: "route",
      declaredAt: 200000,
      measured: "2026-10-20",
      samples: "311,109 tokens served (1,450,000 characters, counted by the route) and 279,086 before it (1,300,000 characters), both answered from; 1,600,000 characters (about 343,348 tokens) refused with context_length_exceeded, as was 2,800,000 characters. The 232,685-token prompt served on 2026-10-16 still fits inside what is declared here. On 2026-10-20 this id's UPSTREAM was failing intermittently, and the measurement of that afternoon is not to be read as a wall: a request of 547,384 characters was answered while one of 540,983 was refused, which no wall can do, and the bracket that made of it (floor 136973 over ceiling 135381) pinned the declaration at a third of this entry. Asked again the same day it behaved like a wall: 60,000 words (211,050 tokens) served, and 90,000 words (about 318,000 tokens) refused six times out of six with 'Your request resulted in more tokens than this model's maximum context length allows'.",
      how: "the route's own enforcement, found by bracketing, and 311,000 is the largest served sample rounded down so that a host's count may differ from the route's. The twin-derived 1000000 this entry used to carry is withdrawn: a prompt of about 343,000 tokens is refused, so the paid id's window is not one this endpoint serves. The wall's exact position between 311,109 and about 343,348 tokens is not known — the sweep stopped at the first refusal. The 2026-10-20 instability is the reason the run's own bracket is not evidence: a refusal under a size the route served is the endpoint's opinion, not the wall's, and both the plugin and the sweep now refuse to read it as one. When this id's upstream is failing, a measurement of it says something about the upstream and not about the window.",
    },
    output: {
      value: 131072,
      source: "route-twin",
      declaredAt: 32000,
      measured: "2026-10-16",
      samples: "max_tokens 4000000 was accepted with no refusal at all, which is the DeepSeek upstream's shape: silence here is not evidence of a ceiling either way, and nothing above 32000 was watched",
      how: "the same paid twin declares 131072 on this axis",
    },
  },
  // The catalogue calls this model a 1M-context model and writes 1000000 — the
  // decimal million. The wall behind it is the binary one, and the gap between
  // them is 48,576 tokens a host would never be allowed to use: 1,048,092 was
  // served and counted by the route, which is 1,048,576 minus a few hundred
  // tokens of message overhead, while 1,082,359 was refused. So this is the same
  // wall `beam-free` and the other 1048576 ids sit behind, and the catalogue's
  // round number is the one value on this route measured to be under-reporting
  // by more than the route's own envelope costs.
  //
  // Nothing was declared over it: 1048092 is the largest size served, rounded
  // down, not the wall itself. The refusal names no number, so the wall is only
  // known to lie between that sample and the first refusal, and a host that
  // builds to the top of its window is refused at the same size as a host that
  // builds to nothing. 1040000 keeps the last thousand tokens — about the
  // overhead of a message envelope, measured at 484 tokens here — as room for a
  // host that counts differently from the route.
  "minimax-m3.1-flash-free": {
    context: {
      value: 1048576,
      source: "models.dev",
      declaredAt: 1000000,
      measured: "2026-10-20",
      samples: "1,048,092 tokens served (counted by `usage.prompt_tokens`, bisected from 274,375 words at 3.936 tokens/word); 1,082,359 tokens refused. Earlier the same day 1,046,141 was served and 1,046,764 refused, so the wall moves by a few hundred tokens with the envelope and sits just under 1048576 rather than at the 1000000 the catalogue writes.",
      how: "the catalogue writes 1000000, the decimal million, and the wall behind it is the binary 1048576. models.dev declares 1048576 for this canonical model — llmgateway/minimax-m3.1-flash and llmgateway-providers are the only two of nineteen entries that say so, against seventeen that repeat the catalogue's 1000000 — and the bisection above agrees with those two and with nothing else. Declared at the wall rather than under it: a host deducts its own envelope, and this route's is measured at about 484 tokens, which 1048576 covers.",
    },
    output: {
      value: 512000,
      source: "route-twin",
      declaredAt: 512000,
      measured: "2026-10-20",
      samples: "nothing watched above 32000 on this id; the catalogue declares 512000 and no refusal was asked for it",
      how: "the catalogue declares 512000 for this same free id, which is the one completion ceiling this route states for it. Left at the declaration rather than lowered: nothing here measured it, and lowering a ceiling on no evidence cuts replies off.",
    },
  },
  "beam-free": {
    context: {
      value: 1048576,
      source: "models.dev",
      declaredAt: 1048576,
      measured: "2026-10-20",
      samples: "1,048,361 tokens served (counted by `usage.prompt_tokens`, bisected from 255,000 words at 4.193 tokens/word); 1,071,887 tokens refused. The served sample lands within 215 tokens of the binary 1048576, so this is the binary wall and the catalogue's 1048576 is already the right scale here.",
      how: "the route's own enforcement, found by bisection because its refusal states no number. The catalogue declares 1048576 and the route serves 1,048,361, so the declaration is correct in scale and only wants the envelope's room: 1048000 is the largest served sample rounded down. This entry exists so the sweep does not have to rediscover a wall that is the catalogue's own number.",
    },
    output: {
      value: 131072,
      source: "vendor",
      declaredAt: 131072,
      measured: "2026-10-20",
      samples: "nothing above 32000 watched on this route",
      how: "the catalogue declares 131072 for this id; nothing here measured it, and the axis is left as declared.",
    },
  },
  // Measured the day a host's window for this id was reported half its size.
  // Only the input axis moves: the window and the ceiling are what this route
  // declares, and what was served agrees with both.
  "space-bunny-free": {
    input: {
      value: 1048576,
      source: "route",
      declaredAt: 524288,
      measured: "2026-10-16",
      samples: "prompts of 535,110, 935,110 and 979,550 tokens served whole, each with the needle at the end of it echoed back and each counted by `usage.prompt_tokens`, so the declared 524288 is already known to be small; a prompt placed over the window was refused 400, in words that name nothing",
      how: "the catalogue's 524288 is its own `context − output` (1048576 − 524288) read as a cap, and this route does not enforce it: the samples above run from just past the declared cap to nearly twice it, served whole, and the wall is the 1048576-token window this same catalogue declares for this id. A host that shows the input axis shows the window — magpie's `context_window` and `max_input_tokens` are both this field when one is declared — so a derivation left here is a wrong window on screen.",
    },
  },
};

// "This model's maximum context length is 1048576 tokens. However, you
// requested 1422278 tokens (1038278 in the messages, 384000 in the
// completion)." — the route's own words, and the sentence seen most often on
// this route that states a window. A second upstream phrases the same fact as
// "This endpoint's maximum context length is ...", with the request broken into
// text input, tool input and output; both are the route naming its own window,
// and its "requested about" figure is a rough one (chars, not tokens) rather
// than the count a served request reports in `usage.prompt_tokens`. A generic
// 400 says nothing attributable and is left alone; §7 of the measured notes has
// a context overflow and an invalid parameter answering with byte-identical 400s
// on another Zen model.
//
// A third wording states the same fact as a parenthetical, and was missed until
// it was measured: "The input (341480 tokens) is longer than the model's context
// length (262144 tokens)." (`ll-alpha-free`, 2026-10-16). It names the same
// number in the same sentence, so it is read the same way — a window this file
// does not read is a window the plugin keeps under-declaring, which is the one
// failure it exists to remove.
const NAMED_CONTEXT = [
  /maximum context length is (\d+) tokens/id,
  /context length \((\d+) tokens?\)/id,
];

// "max_tokens is too large: 200000. This model supports at most 131072 completion
// tokens, whereas you provided 200000." — an upstream that validates the ceiling
// it was asked for and names its own, which is the only sentence seen on this
// route that states a completion ceiling at all. It is worth knowing that the
// DeepSeek upstream does not validate: `max_tokens: 2000000` under a short prompt
// answers 200 there, so silence from this one says nothing about a model, and a
// request that is served is not evidence of a ceiling either way.
const NAMED_OUTPUT = [
  /supports at most (\d+) completion tokens/id,
  // "/max_tokens: 1000000 is not less or equal to 262144" — LongCat's wording for
  // the same fact, where the ceiling is the number it has to stay under.
  /max_tokens:?\s*\d+\s+is not less or equal to\s+(\d+)/id,
  // "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]" —
  // the DeepSeek upstream's wording, and the only sentence seen on this route
  // that states a completion ceiling as a range. The upper end is the ceiling:
  // the number the route says it accepts up to, which is what a declaration of
  // this axis has to stay inside. It is not a sentence to rely on: measured
  // 2026-10-19, and asking for 1000000 later the same day was answered 200 rather
  // than refused, so the route states this ceiling on some endpoints and not
  // others. The pattern stays because reading it costs nothing when it does not
  // appear, and a ceiling the route does state is the one number on this axis
  // that does not have to be guessed at.
  /valid range of max_tokens is \[\s*\d+\s*,\s*(\d+)\s*\]/id,
];

// Names a refusal made while this process is running, by model id. Not
// persisted: the same kind of fact as LIMITS, only newer, so a restart falls
// back to what was measured last.
const OBSERVED = new Map();
const OBSERVED_OUTPUT = new Map();

// The two maps above as a caller can hold them, and a way to put them back where
// they were found. They are module state on purpose — a refusal this process saw
// is the route speaking, and it outranks the shipped table for as long as the
// process runs — but one process is not always one conversation: a second reader
// of this module, a test run above all, has to be able to answer from the table
// it shipped with rather than from evidence the first reader happened to
// collect. Called with nothing it answers with the pair as they stand; called
// with a pair it makes that pair the state and answers with what it replaced, so
// the caller can put the first one back in a `finally`. The shape is
// `limitDiagnostics`'s, which returns the sink it replaced for the same reason.
export function limitObservations(restore) {
  const previous = { context: new Map(OBSERVED), output: new Map(OBSERVED_OUTPUT) };
  if (restore !== undefined) {
    for (const [map, entries] of [
      [OBSERVED, restore.context],
      [OBSERVED_OUTPUT, restore.output],
    ]) {
      map.clear();
      for (const [id, value] of entries ?? []) map.set(id, value);
    }
  }
  return previous;
}

// ---- the wall the route enforces, learned from the traffic it serves -------
//
// Everything above this line is a measurement somebody took by hand and wrote
// down. That does not scale: the wall this route enforces moved under one id on
// 2026-10-19, and the only reason it was noticed is that a conversation filled
// the window and every request after it was refused. The same wall sits in front
// of every offered model, it is not the number the catalogue publishes, and it
// moves without notice.
//
// So each model gets a bracket, kept while the plugin runs and carried across
// restarts in one small file, and the bracket is moved only by what the route
// itself answers:
//
//   floor   the largest request the route is known to have SERVED, read from the
//           characters of the request that was sent through one estimate, in the
//           same units as `ceil` below: a bracket whose ends were read through
//           different estimates would be two numbers about two scales.
//   ceil    the smallest request the route is known to have REFUSED, in those
//           same units. It is the bound the declaration may not cross, which is
//           what stops a search from asking for a size already turned down.
//   ceiling what this file declares to the host, and the one number a host acts
//           on: it compacts a conversation at it and decides what is worth
//           sending at all.
//   step    how far above the proven floor the declaration is willing to go. It
//           doubles every time the host is seen to have filled the declaration,
//           and halves on every refusal, which is the whole of the search: each
//           refusal narrows the bracket, and the overshoot that caused it is
//           half the size of the one before.
//
// Nothing here sends a request of its own. Every observation is a request the
// host was already making, which is why this can be on by default: the cost of a
// wrong guess is one refused turn, and the step halving is what makes those
// refusals both rarer and smaller. A model nothing is asked of is never probed
// at all, and its declaration is exactly what the table and the catalogue said.
//
// The host sees a learned ceiling at its next list rebuild — the start, an hour
// later, or a `refresh()` — which is also what keeps this from being a loop: the
// bracket moves on the traffic the host sends against the declaration it was
// given, not on the declaration it is being given now.
//
// One estimate, used at both ends of the bracket, because a floor and a ceiling
// read through different estimates are two numbers about different scales and
// the search between them would be searching a scale nobody declared in. What
// keeps this honest is the structure around it — the step halving on every
// refusal, the bound a refusal puts under the declaration, and the refusal
// budget that ends the search — and not the precision of a character count.
//
// It is deliberately script-aware: a window declared from a Latin ratio alone
// would come out at a third of the real one for a wall of Chinese text, which is
// the silent under-declaration this file exists to remove.
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const SCAN_LIMIT = 32 * 1024 * 1024;
const CJK_TOKENS_PER_CHAR = 0.7;
// The characters one token covers, measured against the route's own
// `usage.prompt_tokens` on the bodies a host actually sends — 3.938, 4.015 and
// 4.034 on conversations of 12,546, 60,796 and 292,396 tokens, so 3.996.
//
// The 4.66 this replaces was not wrong, it was answering a different question.
// Measured against the sweep's repeated filler text it is exact: the nine models
// in `limits-observed.json` come back at 4.65 to 4.68 characters per token,
// averaging 4.666. That is the ratio for `The quick brown fox` repeated, which
// tokenises far better than a coding conversation — same words, no JSON, no
// tool-call ids, no punctuation between fragments. Applied to real traffic it read
// the prompt about 14% short: the three points above came back at 0.845, 0.862 and
// 0.866 of the route's count, and a floor read 14% short is a window declared 14%
// short, which is the one direction this file exists to stop.
//
// The sweep itself never calls `estimateTokens` — it asks the route and reads
// `prompt_tokens` — so the two ratios cannot be confused again: this one belongs to
// a bracket learned while a host is running, and the table's numbers are the
// route's own count.
const LATIN_CHARS_PER_TOKEN = 3.996;

// The tokens a request's own text holds. An estimate, and used as one: the route
// counts tokens with a tokenizer this plugin does not have, so every size below is
// read from characters through the ratios above. The sweep does not use this at
// all — it asks the route and reads `prompt_tokens` — so the table's numbers are
// the route's own count, while a bracket learned while a host is running is
// measured with this. Aligning the two is what this ratio is for.
export function estimateTokens(text) {
  const { cjk, other } = scriptCount(text);
  return Math.round(cjk * CJK_TOKENS_PER_CHAR + other / LATIN_CHARS_PER_TOKEN);
}

function scriptCount(text) {
  if (typeof text !== "string" || text === "") return { cjk: 0, other: 0 };
  const scan = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  // A string with no CJK at all — nearly every request to this route — is
  // answered without walking it, which is what keeps this cheap on a prompt of
  // several megabytes. `test` bails at the first match, so the walk below only
  // happens for text that really holds one.
  if (!CJK.test(scan)) return { cjk: 0, other: scan.length };
  let cjk = 0;
  for (let at = 0; at < scan.length; at += 1) {
    const code = scan.charCodeAt(at);
    if (code >= 0x2e80 && code <= 0xd7ff) cjk += 1;
  }
  return { cjk, other: scan.length - cjk };
}

// Every character of a request body this file can see, as one string, so that a
// caller with a parsed body does not have to know which protocol wrote it. Only
// strings are counted; a number, a flag or a nested object contributes nothing,
// which makes this a floor on the request's real size — the one direction that
// cannot turn a small request into a large claim. Exported for the provider,
// which has the body in hand before it sends anything.
//
// The budget is counted in characters, and that is the whole of a repair: it
// used to count strings, at 4096 of them, and a chat body holds one string per
// role, per content, per tool-call id, per tool name and per tool arguments. A
// long conversation therefore stopped being read at a point that had nothing to
// do with its size, and what came back was a floor on a floor — a body of
// 1,012,508 characters was estimated at 44,181 tokens against a true 217,276,
// because the walk gave up after the four-thousandth string. The estimate is a
// bracket's unit, so an under-read there is not a rounding error: it is a wall
// learned at a fifth of the size the route actually saw, and the declaration
// built on it lands below a size the route has already served. Counting
// characters makes the cut a bound on the quantity being estimated, which is
// what `SCAN_LIMIT` already is for the CJK scan below.
export function requestText(body, budget = SCAN_LIMIT) {
  const parts = [];
  let seen = 0;
  const walk = (value, depth) => {
    if (seen >= budget || depth > 12) return;
    if (typeof value === "string") {
      parts.push(value);
      seen += value.length;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value && typeof value === "object")
      for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(body, 0);
  return parts.join("");
}

// The size of one request, as the observers below take it.
export function requestSize(body) {
  return { tokens: estimateTokens(requestText(body)) };
}

// Which scale `requestSize` measures in. A bracket is a pair of numbers this file
// took from that scale, so a record is only evidence while the scale that produced
// it is the scale still in use: the estimator once counted strings instead of
// characters and under-read a long conversation to a fifth of its size, which put
// a floor and a ceiling on a deflated scale and then bounded a window measured on
// the right one. A record carrying another number was measured by a different
// instrument and says nothing about this one.
//
// The number moves whenever the estimate changes meaning, and a record that
// disagrees is dropped rather than repaired: the floor is the largest size the
// route was seen to serve AS THIS FILE COUNTED IT, and there is nothing to salvage
// from a count whose unit was wrong.
export const ESTIMATE_SCALE = 2;

// The brackets, by model id, as this process has them. A Map like the two
// observation maps above, for the same reason: what a route answered about one
// model is that model's, and a caller has to be able to read and replace the
// whole of the state — a test above all, whose assertions would otherwise depend
// on the order requests happened to be made in.
const BRACKETS = new Map();

// The state as a caller can hold it, and a way to put it back, in the shape
// `limitObservations` uses. Called with nothing it answers with a copy of the
// records as they stand; called with a Map it makes that map the state and
// answers with what it replaced. The records are copied rather than shared, so a
// caller that puts one back cannot be surprised by the observer that ran in
// between: a record is the one mutable thing in this file.
export function limitAdaptivity(restore) {
  const previous = new Map();
  for (const [id, record] of BRACKETS) previous.set(id, { ...record });
  if (restore !== undefined) {
    BRACKETS.clear();
    for (const [id, record] of restore ?? [])
      if (isUsableId(id) && record && typeof record === "object") BRACKETS.set(id, { ...record });
  }
  return previous;
}

// One record, copied, or undefined when this model has never been observed.
// Copied for the same reason `limitAdaptivity` copies: the caller reads a
// bracket, and a bracket it can mutate is a bracket the next request reads back.
export function limitBracket(id, brackets = BRACKETS) {
  const record = brackets && typeof brackets.get === "function" ? brackets.get(id) : undefined;
  return record && typeof record === "object" ? { ...record } : undefined;
}

// What this file declares for a model because the route taught it something.
// A record answers with the ceiling it holds — the observers are the only thing
// that moves one, so reading a bracket never raises a declaration the search did
// not decide on: a refusal that put the ceiling back at the floor would be undone
// by the next model list otherwise, which is how a search turns into a loop. A
// record with no ceiling yet derives one from its seed. A model with no record
// answers with nothing, and keeps every tier above this one.
function adoptedCeiling(id, seeded, brackets) {
  const record = brackets && typeof brackets.get === "function" ? brackets.get(id) : undefined;
  if (!record || typeof record !== "object") return undefined;
  if (!usable(record.ceiling)) record.ceiling = derivedCeiling(record, seeded);
  // The floor binds a ceiling that was never derived here as well. A record is
  // not always born in this process: it is read back from a state file, or handed
  // in by a caller, and one written by a version whose bound was not clamped
  // carries the inversion in the field this function answers with. Deriving only
  // when the ceiling is unusable means such a record is republished as it stands,
  // for as long as nothing raises it — which is exactly the case a host is in
  // before it sends its first request, and the case it stays in once the refusal
  // budget is spent and the raise path is closed. Clamping on the way out is what
  // makes the invariant hold for a record this process did not compute, and it
  // repairs the record as it goes, so the next save writes the corrected number
  // rather than the one that was read.
  const floor = usable(record.floor) ? record.floor : 0;
  if (usable(record.ceiling) && record.ceiling < floor) record.ceiling = floor;
  return record.ceiling;
}

// The declaration a record comes to, from what the route proved and what the
// caller would have said anyway. The upper bound is the whole point of `ceil`: a
// refusal puts a size under it, and this stops the search from ever declaring
// one the route has already turned down. A record whose own numbers are not
// usable — a state file somebody edited, a version that wrote another shape —
// falls back to the seed rather than to a guess.
function derivedCeiling(record, seeded) {
  const seed =
    Number.isSafeInteger(seeded) && seeded > 0
      ? seeded
      : Number.isSafeInteger(record?.seededFrom) && record.seededFrom > 0
        ? record.seededFrom
        : undefined;
  const cap = Math.max(seed ?? 0, maxWindow());
  const floor = usable(record?.floor) ? record.floor : 0;
  const step = usable(record?.step) ? record.step : seedStep(seed);
  const ceil = usable(record?.ceil) ? record.ceil : undefined;
  // A record with neither a seed nor anything the route proved has nothing to
  // declare: answering `cap` would invent a window out of a constant.
  if (seed === undefined && floor === 0) return undefined;
  const base = Math.max(floor + step, seed ?? 0, usable(record?.ceiling) ? record.ceiling : 0);
  // The bound a refusal puts under the declaration. A window the route named is
  // its own number and may be declared as it stands; one this file estimated is
  // a character count, so it is stepped under rather than sat on — declaring the
  // exact size that was just refused is how a search turns into a loop.
  const margin = ceil === undefined || record?.exact === true ? undefined : Math.floor(ceil * (1 - REFUSAL_MARGIN));
  const bound =
    ceil === undefined
      ? cap
      : record?.exact === true
        ? Math.min(ceil, cap)
        : Math.min(margin, cap);
  // A margin that is a fraction of `ceil` is not a margin at all when the bracket
  // is narrow: 2% of a refused size 4000 tokens above the floor is 80 tokens below
  // it, so the bound is on the wrong side of the floor and the clamp below pins the
  // declaration AT the floor for good. The search then reports no progress however
  // many times the host fills it — the VPS bracket of floor 326000 / ceil 330000
  // never moved, while a 60,000-token bracket climbed 91% of its own span. That is
  // a capability cap with no evidence behind it: the route refused 330000, not
  // 326001, and nothing was ever asked between them.
  //
  // So where the margin lands at or under the floor and the bracket is still open,
  // the next size is the midpoint of the interval instead. Every served midpoint
  // raises the floor without spending a refusal, and every refused one halves what
  // is left, so the declaration climbs to within a sixteenth of the span inside the
  // refusal budget — which is what `ceil` is for. The margin rule keeps every case
  // it already answered: it is only displaced where it produced no movement at all.
  const wedge = floor > 0 && ceil !== undefined && ceil > floor + 1 && (bound ?? 0) <= floor;
  if (wedge) return Math.min(Math.max(floor + 1, floor + Math.ceil((ceil - floor) / 2)), cap);
  // The declaration may never sit below the largest size the route is known to
  // have SERVED. That is not a preference about margins: `floor` is a request the
  // route answered, so a declaration under it is a number contradicted by the
  // evidence that produced it, and the host compacts a conversation it could have
  // sent. It is reachable because `bound` is a function of `ceil` alone, and a
  // refusal 227 tokens above the floor puts `ceil * (1 - REFUSAL_MARGIN)` below
  // it: the VPS on 2026-10-19 held floor 228286, ceil 228513 and declared 223942,
  // which is 223942 = floor(228513 * 0.98). It was also permanent, because the
  // un-refusal guard needs `floor >= ceil` (228286 >= 228513 is false), so the
  // refusal that drew the bound was never voided, and every later raise re-derived
  // the same bound — four raises in a row came back to 223942. Clamping here is
  // what makes the bracket an interval by construction rather than by luck.
  return Math.max(floor, Math.max(1, Math.min(base, Math.max(bound, 1))));
}

const usable = (value) => Number.isSafeInteger(value) && value > 0;

function maxWindow(env = globalThis.process?.env) {
  const named = Number.parseInt(env?.[MAX_WINDOW_ENV] ?? "", 10);
  return Number.isSafeInteger(named) && named > 0 ? named : DEFAULT_MAX_WINDOW;
}

function seedStep(seeded) {
  const base = usable(seeded) ? seeded : DEFAULT_MAX_WINDOW;
  return Math.max(MIN_STEP, Math.floor(base * STEP_SEED_RATIO));
}

function stepMax(seeded) {
  const base = usable(seeded) ? seeded : DEFAULT_MAX_WINDOW;
  return Math.max(MIN_STEP * 4, Math.floor(base * STEP_MAX_RATIO));
}

// Whether a raise is allowed at all right now. A probe costs a turn when it
// overshoots, so they are spaced: one per model per cooldown, whichever way the
// last one went. A model the host is working in does not need a window found to
// the token, and one it is not working in is not probed at all — a raise needs
// the host to have filled the declaration, which is the only demand signal there
// is.
function raisesAllowed(record, now) {
  const last = Number.isFinite(record?.raisedAt) ? record.raisedAt : 0;
  return now - last >= raiseCooldown();
}

function raiseCooldown(env = globalThis.process?.env) {
  const named = Number.parseInt(env?.[RAISE_COOLDOWN_ENV] ?? "", 10);
  return Number.isSafeInteger(named) && named >= 0 ? named : RAISE_COOLDOWN_MS;
}

function recordFor(brackets, id, seeded, now) {
  const held = brackets.get(id);
  if (held && typeof held === "object") return held;
  const record = {
    floor: 0,
    ceil: undefined,
    exact: false,
    ceiling: usable(seeded) ? seeded : undefined,
    step: seedStep(seeded),
    scale: ESTIMATE_SCALE,
    refusals: 0,
    seen: 0,
    // The largest request that had been carried when the last raise happened, so a
    // second raise can ask whether anything has been asked of the declaration since
    // the first one moved it. Seeded at zero: a model nothing has asked anything of
    // has nothing to pay a raise with either.
    raisedAtSeen: 0,
    seededFrom: usable(seeded) ? seeded : undefined,
    raisedAt: 0,
    refusedAt: 0,
    seenAt: now,
  };
  brackets.set(id, record);
  return record;
}

// A request the route served. Its size is a fact about the floor and nothing
// else: a 200 says the prompt fitted, not that the window is exactly this large.
// The raise is the interesting half — the host filling the declaration is the
// only evidence there is that it wants more room, and without it a bracket would
// freeze at whatever the table said.
export function observeServedRequest(id, size, seeded, brackets = BRACKETS, now = Date.now()) {
  if (!isUsableId(id) || !brackets || typeof brackets.set !== "function") return undefined;
  const floor = usable(size?.tokens) ? size.tokens : 0;
  if (floor === 0) return undefined;
  const record = recordFor(brackets, id, seeded, now);
  if (floor > record.floor) record.floor = floor;
  if (floor > record.seen) record.seen = floor;
  record.seenAt = now;
  // A size the route served at or above one it turned down voids that refusal.
  // Refusing and then serving the identical request is something this route does:
  // on 2026-10-19 big-pickle answered a 1,600,000-character prompt with a 400
  // that named no code and then served the same request, counting 343,131 tokens,
  // and nemotron-3.5-super-vl-free answered two asks with a 500 before serving
  // all three sizes. A bound drawn by an endpoint that was about to fail is not
  // the wall's, and left in place it is permanent — `ceil` only ever comes down,
  // so the declaration could never climb back over a size the route had in fact
  // served. The refusal it cost is given back with it, because the budget in
  // MAX_REFUSALS is for refusals this file still believes.
  //
  // A window the route named in its own words is left alone: that is the route
  // stating a limit, not one endpoint misbehaving, and the same sweep found every
  // named number it re-asked hold still.
  if (!record.exact && usable(record.ceil) && floor >= record.ceil) {
    const was = record.ceil;
    record.ceil = undefined;
    // Counted after the give-back, the way `observeRefusedRequest` counts after
    // the increment: the line says how many refusals this model has cost, and a
    // number that includes the one being handed back would say one more than
    // stands.
    if (record.refusals > 0) record.refusals -= 1;
    note({ kind: "wall-unrefused", id, value: was, served: floor, refusals: record.refusals });
  }
  const ceiling = usable(record.ceiling) ? record.ceiling : seeded;
  // A raise has to be paid for by demand the host has shown SINCE the last one.
  // `seen` is the largest request this model has carried, so it stands still while
  // the host keeps sending the same conversation: comparing it against a ceiling
  // that a previous raise just moved is comparing old evidence to a new question.
  // The VPS shape makes it concrete — a host whose real demand was 326000 against a
  // wall at 330000 got the declaration lifted to 358600 and then to 391200 on two
  // consecutive rounds with no new request behind either, so the host built to
  // 391200, was refused, and spent the refusal budget on a size nothing had asked
  // for. Four rounds of that exhausted all four refusals and left the declaration
  // at 326000 for good, 4000 tokens under a wall it had already been told about.
  //
  // A raise is therefore allowed only when the largest request has grown past what
  // it was when the last raise happened. A host that never fills the declaration is
  // never guessed at, which is the same rule that keeps an idle model from being
  // probed at all.
  if (
    record.refusals < MAX_REFUSALS &&
    usable(ceiling) &&
    record.seen >= ceiling * RAISE_AT &&
    record.seen > (usable(record.raisedAtSeen) ? record.raisedAtSeen : 0) &&
    raisesAllowed(record, now)
  ) {
    const was = ceiling;
    record.step = Math.min(Math.max(record.step * 2, record.step + MIN_STEP), stepMax(seeded));
    record.raisedAt = now;
    record.raisedAtSeen = record.seen;
    record.ceiling = derivedCeiling(record, seeded);
    if (record.ceiling !== was)
      note({
        kind: "wall-raised",
        id,
        value: record.ceiling,
        was,
        floor: record.seen,
        step: record.step,
      });
  }
  scheduleSave();
  return { ...record };
}

// A request the route refused. The refusal is the upper bound, and the
// declaration goes back to what the route is known to have served: the size it
// just turned down is not a size to declare again, and a step that overshot is
// halved before the next one. A refusal that named a window states the wall
// itself, which is better than any bracket and replaces it.
export function observeRefusedRequest(
  id,
  size,
  seeded,
  brackets = BRACKETS,
  now = Date.now(),
  named,
) {
  if (!isUsableId(id) || !brackets || typeof brackets.set !== "function") return undefined;
  const ceil = usable(size?.tokens) ? size.tokens : 0;
  if (ceil === 0 && !usable(named)) return undefined;
  const record = recordFor(brackets, id, seeded, now);
  // A refusal UNDER the largest size the route is known to have served is not a
  // bound. It cannot be one: a wall refuses what is above it and serves what is
  // below, so a refusal under a served size is the endpoint's opinion rather than
  // the wall's. Measured 2026-10-20 on `glm-5.3-flash-free`, whose upstream was
  // failing intermittently: a request of 547,384 characters was answered and one
  // of 540,983 was refused — an inversion no wall produces, and the bracket it
  // made (floor 136973 over ceiling 135381) is what the declaration was then
  // pinned to, at a third of the window the table holds and a size the same
  // route served forty thousand tokens above.
  //
  // So the refusal is void: it draws no bound, it does not spend the refusal
  // budget, and it does not reset the raise cooldown. The floor is a size the
  // route answered, and it is the strongest thing this file knows; a refusal
  // under it is noise by definition. This is the mirror of what a serve at or
  // above the ceiling already does, and it is the same rule the sweep's own
  // reduction has always applied — only the running plugin did not have it.
  if (ceil > 0 && record.floor > 0 && ceil < record.floor) {
    note({ kind: "wall-refusal-under-floor", id, refused: ceil, floor: record.floor });
    return { ...record };
  }
  record.refusals += 1;
  record.refusedAt = now;
  record.raisedAt = now;
  record.step = Math.max(Math.floor(record.step / 2), MIN_STEP);
  if (ceil > 0 && (record.ceil === undefined || ceil < record.ceil)) record.ceil = ceil;
  if (usable(named)) {
    // The route named the window in its own words: an exact number outranks
    // everything here, including the floor, and it is also the refusal bound.
    record.ceiling = named;
    record.ceil = Math.min(record.ceil ?? named, named);
    record.exact = true;
    record.seededFrom = usable(seeded) ? seeded : record.seededFrom;
  } else {
    // Back to the largest size the route is known to have served. A refusal is
    // evidence that what was declared is too big, and the floor is the only
    // number that is evidence of the opposite; the next raise, a halved step
    // above it and not before the cooldown, is what climbs back. A model with no
    // served request yet has no floor, and its declaration is derived from the
    // bound the refusal just put under it.
    //
    // `derivedCeiling` is never below the floor, so the smaller of the two is the
    // floor itself; it is written out rather than assumed because this is the one
    // line that used to sink the declaration under a size the route had served.
    // See the note on that clamp: a refusal 227 tokens above the floor put the
    // declaration 4344 tokens under it, permanently.
    const derived = derivedCeiling(record, seeded);
    record.ceiling =
      record.floor > 0 && usable(derived) ? Math.min(record.floor, derived) : derived;
  }
  note({
    kind: "wall-refused",
    id,
    value: record.ceiling,
    refused: ceil,
    named: usable(named) ? named : undefined,
    refusals: record.refusals,
  });
  scheduleSave();
  return { ...record };
}

const isUsableId = (id) => typeof id === "string" && id !== "";

// ---- what survives a restart ----------------------------------------------
//
// A bracket that is forgotten on every restart is a bracket that is re-learned
// by being refused again, which is the cost this whole section exists to avoid.
// So the state is one small JSON file: no directory walking, no per-model files,
// nothing that has to be cleaned up by hand. It is written atomically — a
// temporary file beside it and a rename over it — because a half-written state
// file is worse than none: it would be read as a bracket somebody measured.
//
// Nothing here may fail a request. A file that cannot be written is a bracket
// that is not remembered; a file that cannot be read is a model with no history.
// Both are silent by design, and both are visible when the diagnostics sink is
// installed.
export const LIMITS_STATE_ENV = "OPENCODE_ZEN_FREE_LIMITS_STATE";
export const LIMITS_SNAPSHOT_ENV = "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT";
export const MAX_WINDOW_ENV = "OPENCODE_ZEN_FREE_MAX_WINDOW";
export const RAISE_COOLDOWN_ENV = "OPENCODE_ZEN_FREE_LIMITS_COOLDOWN_MS";
const DEFAULT_MAX_WINDOW = 1_048_576;
const RAISE_AT = 0.9;
const RAISE_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_STEP = 1024;
const STEP_SEED_RATIO = 0.05;
const STEP_MAX_RATIO = 0.25;
// How many refusals one model may cost before the search stops. Every raise is
// a size the route has not been asked for yet, so an overshoot is a refused turn
// the user pays for; four of them, each half the size of the last, bracket the
// wall to a fraction of a per cent and then the declaration stops moving. A
// budget rather than a rule about precision, because what it bounds is the cost
// to somebody's conversation and not the quality of the bracket.
const MAX_REFUSALS = 4;
const REFUSAL_MARGIN = 0.02;
const STATE_VERSION = 1;
const STATE_ENTRIES = 500;
const STATE_LIMIT = 256 * 1024;
const SAVE_DEBOUNCE_MS = 5000;

// Where the sweep writes what it measured, and how much of it is worth reading.
// The file is checked in beside this module, so the path is this module's own
// directory rather than anything the environment has to say; the ceiling is the
// same one the state file is read under, and for the same reason — it is read by
// a request path that must not be talked into a large read.
const DEFAULT_SNAPSHOT_URL = new URL("./limits-observed.json", import.meta.url);
const SNAPSHOT_LIMIT = 256 * 1024;

// What a served sample is floored to before it is declared. The route counts the
// prompt it was sent and the host counts the prompt it is planning, and the two
// never agree exactly; a whole thousand is the margin the table's own entries
// were rounded by, so a sweep value and a hand-written one are the same kind of
// number.
const SNAPSHOT_STEP = 1000;

// Where the state is kept: whatever the environment names, an empty string
// meaning "keep it in memory only", and otherwise one file in the cache
// directory this platform uses. `homedir` is the one of these that exists
// everywhere, so it is the last fallback rather than the first.
export function limitStatePath(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) return explicit;
  const named = env?.[LIMITS_STATE_ENV];
  if (typeof named === "string") return named;
  const home = homedir();
  const base = env?.LOCALAPPDATA || env?.XDG_CACHE_HOME || (home ? join(home, ".cache") : "");
  return base ? join(base, "opencode-zen-freex", "limits.json") : "";
}

let stateLoads = new Map();
let saveTimer = null;

// Read the state, once per file. Answers whether anything was read; a missing
// file, an unreadable one and one holding another shape all answer the same way,
// because they all mean the same thing: this process starts with what the table
// says. Keyed by the file rather than remembered once, so a caller that names a
// path of its own — a test, or a host keeping its state somewhere else — is not
// answered with the result of somebody else's read.
export async function loadLimitState(file = limitStatePath()) {
  if (!file) return false;
  const held = stateLoads.get(file);
  if (held) return held;
  const load = (async () => {
    try {
      const text = await readFile(file, { encoding: "utf8" });
      if (typeof text !== "string" || text.length > STATE_LIMIT) return false;
      const parsed = JSON.parse(text);
      const models = parsed?.models;
      if (!models || typeof models !== "object" || parsed?.version !== STATE_VERSION) return false;
      let read = 0;
      for (const id of Object.keys(models).slice(0, STATE_ENTRIES)) {
        if (!isUsableId(id) || read >= STATE_ENTRIES) continue;
        const record = readRecord(models[id]);
        if (!record) continue;
        if (!BRACKETS.has(id)) BRACKETS.set(id, record);
        read += 1;
      }
      return read > 0;
    } catch {
      return false;
    }
  })();
  stateLoads.set(file, load);
  return load;
}

// A record as it can be trusted: own values, integers of the right sign, and
// nothing else carried in. A state file is a file, and one that has been edited
// by hand, truncated by a full disk or written by another version is not
// evidence about a model until every field has been checked.
function readRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  // A record measured on another scale is not this record. The floor and the
  // ceiling are token counts this file produced, so a file written by an
  // estimator that counted something else holds numbers about a different
  // quantity: a floor of 228286 taken while a long conversation was read to a
  // fifth of its length is not a size the route was shown to serve on the scale
  // used now. Dropping it leaves the model with the table's own number, which is
  // the measurement the sweep made on this scale, instead of bounding it with a
  // count whose unit was wrong.
  if (raw.scale !== ESTIMATE_SCALE) return undefined;
  const floor = usable(raw.floor) ? raw.floor : 0;
  const ceiling = usable(raw.ceiling) ? raw.ceiling : undefined;
  if (!floor && ceiling === undefined) return undefined;
  const record = { floor, ceiling };
  record.ceil = usable(raw.ceil) ? raw.ceil : undefined;
  record.exact = raw.exact === true;
  record.step = usable(raw.step) ? raw.step : seedStep(ceiling);
  record.scale = ESTIMATE_SCALE;
  record.refusals = Number.isSafeInteger(raw.refusals) && raw.refusals >= 0 ? raw.refusals : 0;
  record.raisedAtSeen = usable(raw.raisedAtSeen) ? raw.raisedAtSeen : 0;
  record.seen = usable(raw.seen) ? raw.seen : 0;
  record.seededFrom = usable(raw.seededFrom) ? raw.seededFrom : ceiling;
  record.raisedAt = Number.isFinite(raw.raisedAt) ? raw.raisedAt : 0;
  record.refusedAt = Number.isFinite(raw.refusedAt) ? raw.refusedAt : 0;
  record.seenAt = Number.isFinite(raw.seenAt) ? raw.seenAt : 0;
  return record;
}

// Write the state, at most once per debounce window: a bracket moves on a
// request, and a request is not a reason to write a file. The write is
// deliberately not awaited by anyone — a request that has already been answered
// must not wait for a disk — and a failure is dropped rather than raised.
function scheduleSave() {
  if (saveTimer) return;
  const wait = saveDebounce();
  if (wait === 0) {
    void saveLimitState();
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveLimitState();
  }, wait);
  saveTimer?.unref?.();
}

function saveDebounce(env = globalThis.process?.env) {
  const named = Number.parseInt(env?.[`${LIMITS_STATE_ENV}_DEBOUNCE_MS`] ?? "", 10);
  return Number.isSafeInteger(named) && named >= 0 ? named : SAVE_DEBOUNCE_MS;
}

// The file this process would write, as JSON. Exported so a test can hold the
// bytes rather than the file, and so a caller that writes its own state has one
// shape to write.
export function limitStateJSON(brackets = BRACKETS) {
  const models = {};
  let written = 0;
  for (const [id, record] of brackets) {
    if (!isUsableId(id) || written >= STATE_ENTRIES) continue;
    const row = {
      floor: usable(record.floor) ? record.floor : 0,
      ceiling: usable(record.ceiling) ? record.ceiling : undefined,
      step: usable(record.step) ? record.step : undefined,
      scale: ESTIMATE_SCALE,
      refusals: Number.isSafeInteger(record.refusals) ? record.refusals : 0,
      raisedAtSeen: usable(record.raisedAtSeen) ? record.raisedAtSeen : 0,
      seen: usable(record.seen) ? record.seen : 0,
      seededFrom: usable(record.seededFrom) ? record.seededFrom : undefined,
      raisedAt: Number.isFinite(record.raisedAt) ? record.raisedAt : 0,
      refusedAt: Number.isFinite(record.refusedAt) ? record.refusedAt : 0,
      seenAt: Number.isFinite(record.seenAt) ? record.seenAt : 0,
    };
    if (usable(record.ceil)) row.ceil = record.ceil;
    if (record.exact === true) row.exact = true;
    models[id] = row;
    written += 1;
  }
  return JSON.stringify({ version: STATE_VERSION, models });
}

export async function saveLimitState(file = limitStatePath(), brackets = BRACKETS) {
  if (!file || brackets.size === 0) return false;
  try {
    const text = limitStateJSON(brackets);
    if (text.length > STATE_LIMIT) return false;
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8" });
    await rename(temporary, file);
    return true;
  } catch {
    return false;
  }
}

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

function describe({ kind, id, axis, value, measuredAgainst, declared, was, floor, step, refused, named, served, refusals, wall, at }) {
  if (kind === "route-statement")
    return `${id} ${axis}=${value} — named by a refusal this process saw, so it is applied as it stands (the catalogue declares ${declared === undefined ? "nothing for this axis" : declared})`;
  if (kind === "sweep-statement")
    return `${id} ${axis}=${value} — measured by the scheduled sweep (${wall === undefined ? "wall not recorded" : wall}${at === undefined ? "" : `, ${at}`}), so it is applied as it stands (the catalogue declares ${declared === undefined ? "nothing for this axis" : declared})`;
  if (kind === "wall-raised")
    return `${id} context=${value} — up from ${was}: the host filled ${floor} of it and the route served that, so the declaration is probing ${step} further`;
  if (kind === "wall-refused")
    return `${id} context=${value} — back under the wall: the route refused a request of about ${refused} tokens${named === undefined ? "" : ` and named a window of ${named}`}, ${refusals} refused so far`;
  if (kind === "wall-unrefused")
    return `${id} context — the refusal of about ${value} tokens is dropped: the route went on to serve ${served}, which that bound had ruled out, and the refusal it cost is given back (${refusals} refused so far)`;
  return `${id} ${axis}=${value} was measured against a catalogue that declared ${measuredAgainst}, and this one declares ${declared === undefined ? "nothing for this axis" : declared}: not applied`;
}

// The window a refusal names, or undefined when the body says nothing
// attributable. Exported for the tests and for anyone reading a capture.
export function namedContextWindow(text) {
  return namedFrom(NAMED_CONTEXT, text)?.value;
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
  // `262144`, was stored and applied as a completion ceiling. It is set twice:
  // here, where the wait is over, and in the loop below, where a cut lands
  // inside a character and the half of it is dropped rather than kept.
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
      // and the rest of the chunk is dropped rather than materialised. The cut
      // is a code-unit cut, so it has to be moved off a surrogate pair: a
      // character outside the basic plane — an emoji, a rare ideograph, anything
      // above U+FFFF — is two code units, and keeping the high half on its own
      // leaves the text ending in half a character, which `String.length` counts
      // as one and which a caller repeating this body has no way to render. The
      // half is dropped rather than completed — the character it belongs to is
      // past the budget either way, and reading a character further to keep a
      // whole one is exactly the promise this loop does not make — and the read
      // remembers that it did not keep everything it read: a character the body
      // held is missing from `text`, so this is not the whole body however the
      // stream ends. That is `cut`'s own meaning, and the one place it is set
      // outside the wait being over.
      const decoded = decoder.decode(value, { stream: true });
      let taken = Math.min(decoded.length, limit + 1 - text.length);
      const last = decoded.charCodeAt(taken - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        taken -= 1;
        cut = true;
      }
      text += decoded.slice(0, taken);
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
  // the read failed, the deadline passing, or a character the cut broke in half
  // and this read did not keep — which is the only honest source for "this may
  // be cut".
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
// `ended` is the read's own answer to "is this the whole body?": true when the
// body was read to its end, false when the budget, the deadline or a failed
// read stopped it short — a read that got nothing at all included, which is the
// same answer for a different reason. A caller that hands these bytes on has to
// know which of the two it holds: a prefix presented as the whole reply is a
// lie the caller cannot see, and the bytes cannot be gone back for, since this
// read is the body's one reader.
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
    // still holds the one it had, and undefined says so. Written out rather
    // than left to a loose comparison, which the project's rules do not allow
    // and which would also answer for a body that is not one of these two.
    if (response.body === null || response.body === undefined) return undefined;
    const { text, over, ended } = await readBoundedText(response, limit, { signal });
    const { context, output } = namedAxes(text, limit, over);
    if (context !== undefined) OBSERVED.set(id, context);
    if (output !== undefined) OBSERVED_OUTPUT.set(id, output);
    return { context, output, text, ended };
  } catch {
    return undefined;
  }
}

// Where the number a match named ends, in the text it was matched against. The
// `d` flag is what makes this exact: `NAMED_CONTEXT` and the first
// `NAMED_OUTPUT` run on past the digits (" completion tokens"), so judging the
// cut by the match's own end threw away numbers that were provably whole — the
// digits ended well before the read did, with text after them that the greedy
// `(\d+)` had refused to consume.
function digitsEnd(found) {
  const at = found?.match?.indices?.[1]?.[1];
  // The match's own end is the conservative answer when the pattern cannot say
  // where the digits are: it drops a whole number rather than reading a cut one,
  // which is the direction this guard has to fail in.
  return Number.isSafeInteger(at) ? at : found.match.index + found.match[0].length;
}

// The axes the first `limit` characters of `text` name. `cut` says the read
// stopped before the body did, so a number whose own digits reach the last
// character read may have had digits past it: that axis is left unread rather
// than reported a digit short. Any character after the digits inside the head
// proves the number ended, since a greedy `\d+` would have taken it — only
// digits touching the boundary are ambiguous. Each axis is read from the match
// its number came from, so the match the guard judges and the number that is
// returned cannot be two answers.
export function namedAxes(text, limit, cut) {
  const head = text.slice(0, limit);
  const context = namedFrom(NAMED_CONTEXT, head);
  const output = namedFrom(NAMED_OUTPUT, head);
  const onCut = (found) => cut && found !== undefined && digitsEnd(found) >= head.length;
  return {
    context: onCut(context) ? undefined : context?.value,
    output: onCut(output) ? undefined : output?.value,
  };
}

// Which axis a refusal is about, or none at all. This route answers a 400 with a
// body for everything it does not like, and only some of those say anything
// about a size: a rate limit, a gateway fault, and a 400 about a parameter this
// route did not accept all arrive the same way. Feeding one of those to the
// bracket lowers a declaration over a fault that had nothing to do with length,
// and it spends part of a refusal budget that is four refusals deep.
//
// So the axis is read from what the refusal says. A number it names decides it
// first, because a numbered sentence is the route stating a limit and cannot be
// anything else. A refusal that names no number is read from its own words, and
// the unnamed too-long refusal this route sends most often is in those words:
// `context_length_exceeded`, and a sentence about the maximum context length the
// request went past. A refusal about `max_tokens` is the other axis, and one
// that says neither — `invalid request`, an empty body, a 500 — is about no axis
// and moves nothing.
//
// Only 400 and 413 can be about size. A 5xx is the endpoint failing rather than
// the request being long, which is not a distinction to guess at: on 2026-10-19
// nemotron-3.5-super-vl-free answered 500 to two asks and then served the
// identical requests, and a 500 read as a refusal would have declared that model
// a third smaller than it is. A 401 or a 429 says nothing about the request that
// was sent at all.
const SIZE_STATUS = new Set([400, 413]);
const CONTEXT_TALK = [
  /context length/i,
  /context_length_exceeded/i,
  /token count exceeds/i,
  /reduce the length of the messages/i,
  /prompt is too long/i,
  /messages are too long/i,
  /exceeds the maximum/i,
  // "invalid params, context window exceeds limit (2013)" — the same refusal in
  // the route's other words, measured 2026-10-20 on `minimax-m3.1-flash-free`
  // and `beam-free`, and it was missing here: a 400 that names no number and
  // says none of the sentences above read as about no axis at all, so the
  // plugin did not learn a wall the route had just named in the only words it
  // used, and the sweep — which counted every 400 as a bound — learned it
  // anyway. The two disagreed about the same event, and the one that was wrong
  // about it was the careful one.
  /context window exceeds/i,
];
const OUTPUT_TALK = [/max_tokens/i, /completion tokens/i];

export function refusalAxis(status, text, axes = {}) {
  const named = axes && typeof axes === "object" ? axes : {};
  if (usable(named.context)) return "context";
  if (usable(named.output)) return "output";
  if (!SIZE_STATUS.has(status)) return undefined;
  const said = typeof text === "string" ? text : "";
  if (CONTEXT_TALK.some((pattern) => pattern.test(said))) return "context";
  if (OUTPUT_TALK.some((pattern) => pattern.test(said))) return "output";
  return undefined;
}

const ROUTE_TIERS = new Set(["route", "route-twin", "route-sweep"]);

// The tier a measured wall is published under, and the wording the diagnostics
// sink uses for it.
const SWEEP_SOURCE = "route-sweep";

// Where the last sweep's measurements are read from: whatever the environment
// names, and otherwise the file the sweep writes beside this module. Returned as
// a path rather than read here, so a caller that names one of its own — a test,
// a host keeping the file somewhere else — is answered with its own file.
export function limitsSnapshotPath(explicit, env = globalThis.process?.env) {
  if (explicit !== undefined) return explicit;
  const named = env?.[LIMITS_SNAPSHOT_ENV];
  if (typeof named === "string") return named;
  return fileURLToPath(DEFAULT_SNAPSHOT_URL);
}

// The measurements, one read per file and never a second one: the file is an
// input that changes when somebody commits a run's result, not while a process
// serves requests, and re-reading it on every model list would be a syscall per
// listing for an answer that cannot have moved.
const wallReads = new Map();

// What the sweep measured, as the context axis may use it. One entry per id that
// has a served sample: the largest prompt the route was watched to serve, floored
// to a whole thousand so a host whose count differs from the route's is still
// under it — the same rounding, and for the same reason, as the values in the
// table above.
//
// `settles` is whether the sweep hit the wall at the number: a bracketed wall had
// something bigger refused, so the sample is a point the wall is known to sit
// above and the axis can be answered with it either way. A wall the sweep never
// hit is a floor — the route served this much and said nothing about the rest —
// and a floor under the declaration says nothing about the declaration, so it may
// only raise.
//
// A missing file, an unreadable one and one holding another shape all answer the
// same way — no measurement — because they all mean the same thing: this build
// declares what its table and its catalogue say and nothing else. Nothing here
// may fail a request, so nothing here throws.
export function measuredWalls(file) {
  const path = limitsSnapshotPath(file);
  if (!path) return new Map();
  const held = wallReads.get(path);
  if (held !== undefined) return held;
  const walls = new Map();
  wallReads.set(path, walls);
  try {
    const text = readFileSync(path, { encoding: "utf8" });
    if (typeof text !== "string" || text.length > SNAPSHOT_LIMIT) return walls;
    const models = JSON.parse(text)?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return walls;
    for (const [id, row] of Object.entries(models)) {
      if (!isUsableId(id)) continue;
      const wall = typeof row?.wall === "string" ? row.wall : undefined;
      const at = typeof row?.at === "string" ? row.at : undefined;
      // A window the route stated in its own words answers the axis outright: it is
      // the route's own number, not a bracketed floor, so it settles the axis and
      // needs no rounding down. This is the strongest evidence any tier here has,
      // and the sweep keeps it beside the bracket it also measured.
      const named = row?.named;
      if (usable(named)) {
        walls.set(id, { value: named, settles: true, wall: "named", at });
        continue;
      }
      const tokens = row?.servedTokens;
      if (!usable(tokens)) continue;
      const value = Math.floor(tokens / SNAPSHOT_STEP) * SNAPSHOT_STEP;
      if (!usable(value)) continue;
      walls.set(id, { value, settles: wall === "bracketed", wall, at });
    }
  } catch {
    // No measurement is not a failure: it is a build that declares what it says.
  }
  return walls;
}

// ---- models.dev as a second opinion -----------------------------------------
//
// The catalogue is not the only place a free id's window is written down.
// models.dev republishes the same records — same schema, same
// `canonical_model_id`, in practice the same upstream of the catalogue — across
// several hundred providers, and it is the only cross-provider view of a model
// that exists without asking the model.
//
// It is not an oracle. It has one failure the catalogue shares and one it does
// not. The shared one is rounding: MiniMax's own entry says a "1M context
// window" and writes 1000000, the decimal million, for a wall that is 1048576
// — seventeen of the nineteen entries for that canonical model repeat it, and
// only llmgateway says 1048576. Taking a majority vote over that population is
// therefore the wrong aggregation and the reason this reads the MAXIMUM: a
// provider that under-states a window costs its own users the difference, and
// one that over-states it is refused at the top of its window, so among
// providers claiming to serve the same weights the largest declaration is the
// one that is trying to use all of it.
//
// What it is used for is one rule, and only for the ids the catalogue already
// declares at a million or more: those are exactly the ids whose declaration is
// a round number that no measurement here has falsified, and the largest
// models.dev figure for the same canonical model says what scale that round
// number was meant in. It never lowers a declaration, and an id the catalogue
// declares under a million is left to measurement — `MODELS_DEV_MIN` is where
// that line is, and the reason is that a big claim is checkable by one refused
// request while a small one is only checkable by climbing to it.
export const MODELS_DEV_MIN = 1_000_000;

// The declarations, by canonical model id, as a caller can hold them. Filled by
// `modelsDevClaims` from a document a caller fetched, so nothing here reaches
// the network: a plugin that blocked a model list on a third party would be
// slower for everybody and wrong for anybody behind a firewall.
const MODELS_DEV = new Map();
// What a canonical id is claimed at, and by whom, for diagnostics.
const MODELS_DEV_BY = new Map();

// Reads a models.dev document into the two maps above. Returns how many models
// it saw two or more claims for, which is the number worth logging: a model one
// provider describes says nothing a catalogue would not.
export function modelsDevClaims(document) {
  MODELS_DEV.clear();
  MODELS_DEV_BY.clear();
  let contested = 0;
  for (const [provider, entry] of Object.entries(document?.providers ?? document ?? {})) {
    const models = entry?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [modelId, model] of Object.entries(models)) {
      const canonical = typeof model?.canonical_model_id === "string" ? model.canonical_model_id : undefined;
      // A row with no canonical id is about one provider's own alias and cannot
      // be matched to the catalogue's id for the same weights, so it is not read.
      if (!canonical) continue;
      const context = model?.limit?.context;
      if (!usable(context)) continue;
      const held = MODELS_DEV.get(canonical);
      if (held === undefined) {
        MODELS_DEV.set(canonical, context);
        MODELS_DEV_BY.set(canonical, `${provider}/${modelId}`);
        continue;
      }
      if (context > held) {
        MODELS_DEV.set(canonical, context);
        MODELS_DEV_BY.set(canonical, `${provider}/${modelId}`);
      }
    }
  }
  for (const canonical of MODELS_DEV.keys())
    if ((MODELS_DEV_BY.get(canonical) ?? "").split("/").length > 1) contested += 1;
  return { models: MODELS_DEV.size, contested };
}

export function modelsDevLimit(canonical) {
  return typeof canonical === "string" ? MODELS_DEV.get(canonical) : undefined;
}

export function modelsDevSource(canonical) {
  return typeof canonical === "string" ? MODELS_DEV_BY.get(canonical) : undefined;
}

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
  brackets = BRACKETS,
  walls = measuredWalls(),
  canonical,
) {
  const overrides = {};
  // A record has to be this table's own. `table[id]` otherwise answers out of
  // Object.prototype for `toString` and the rest, and out of whatever prototype
  // an object handed in as `table` carries — evidence for a model nobody
  // declared, from a table that never named it.
  const record = table && Object.hasOwn(table, id) ? table[id] : undefined;
  // What the sweep measured for this id, once: it answers the context axis, and
  // it answers the input axis through the window rather than beside it, so both
  // readings have to be the same one.
  const measuredWall = walls?.get?.(id);
  // The window this id is published with before anything is observed live, and
  // whether the sweep is what decided it. The input axis is the second half of
  // the same answer: magpie answers `context_window` and `max_input_tokens` from
  // `limit.input` when it is declared, and shows the smaller of the two axes, so
  // an input left at a catalogue number the route has outgrown is not a second
  // opinion — it is what the model's size appears to be. 160000 was on screen
  // for a model serving 343000 exactly that way.
  const contextEntry = record && Object.hasOwn(record, "context") ? record.context : undefined;
  const contextDeclared = declared && Object.hasOwn(declared, "context") ? declared.context : undefined;
  const contextApplies =
    contextEntry !== undefined && contextDeclared !== undefined && contextEntry.declaredAt === contextDeclared;
  const settledWindow = settledFor(contextApplies, contextEntry, contextDeclared, measuredWall);
  // A window this process was told about is the strongest thing this axis has, and
  // it is what the input axis follows like any other measured window: a route that
  // names its window while the plugin runs must not have that answer shown as a
  // smaller catalogue input instead. A window a refusal named is taken as it
  // stands here as everywhere else, so the live value is not re-derived from the
  // catalogue — it replaces the settled one for this purpose.
  const liveWindow = observed?.get?.(id);
  const window = usable(liveWindow) ? { value: liveWindow, source: "route" } : settledWindow;
  for (const axis of ["context", "input", "output"]) {
    // Own property, like the table lookup two lines up: `declared` is handed in
    // by a caller, and a `context` inherited from a custom prototype — or from a
    // polluted `Object.prototype` — would otherwise be read as a declaration the
    // catalogue never made, feeding the staleness compare and the raise-only
    // check with a number nobody declared.
    const declaredValue = declared && Object.hasOwn(declared, axis) ? declared[axis] : undefined;
    // Own property, the same rule as the two lines around it. Read through the
    // prototype, an axis the record merely inherits — from a table built with
    // `Object.create`, or from a polluted `Object.prototype` — read exactly like
    // a measurement: it passed the guard below, because the guard is about the
    // declaration and not about the record, and it then took an override past
    // the staleness check and past the raise-only rule.
    const entry = record && Object.hasOwn(record, axis) ? record[axis] : undefined;
    // Only the axes a refusal names have a live form — a window and a
    // completion ceiling. An input axis is answered from the table alone: the
    // refusals this route sends name the window that bounds it, never an input
    // cap of its own, so there is nothing to observe into it.
    const live =
      (axis === "context" ? observed : axis === "output" ? observedOutput : undefined)?.get(id);
    // A route statement made while this process was running is the same tier as
    // the table and newer than it, so it is taken as it stands. Everything else
    // has to have been measured against the catalogue in front of us now: the
    // value it was measured against has to exist and still be the declaration,
    // and one that names no such value was measured against nothing.
    //
    // The bracket the route taught this process comes before the table, not
    // after it: a record exists only because a request was served or refused,
    // which makes it evidence about the wall as it is enforced now, while the
    // table is a measurement of the same axis taken earlier. A record is seeded
    // from the settled value below when it is created, so the table still has the
    // first word — it just does not have the last one. A model nothing has been
    // asked of has no record, and its axes are the settled ones and nothing else.
    const applies = entry !== undefined && declaredValue !== undefined && entry.declaredAt === declaredValue;
    let settled = settledFor(applies, entry, declaredValue, axis === "context" ? measuredWall : undefined);
    // The input axis has no measurement of its own to take: what the route served
    // was a prompt, and the window is how this file states that. So where the
    // window is a measured one — from the table, from the sweep, or named by a
    // refusal while this process runs — an input the catalogue declares under it is
    // raised to it. That is the precedent the table set by hand for
    // space-bunny-free and big-pickle, and the only place those two axes can
    // disagree in a way that shows: magpie reads `context_window` from the smaller
    // of them, so an input left behind is a model drawn smaller than it is, and a
    // window the route just named is drawn as the catalogue's input instead.
    // 160000 was on screen for a model serving 343000 exactly that way.
    //
    // Raised and never lowered, and only where the catalogue declares one: with no
    // input declared, magpie's own fallback already reads the window, and where
    // the table names this axis the entry has its own samples. Both of those are
    // answers this file would only be restating.
    if (axis === "input" && settled.source === undefined && usable(declaredValue) && window.source !== undefined)
      settled = {
        value: Math.max(declaredValue, window.value),
        source: window.source,
        measured: window.measured,
      };
    const seeded = settled.value;
    const adopted = axis === "context" ? adoptedCeiling(id, seeded, brackets) : undefined;
    // A second opinion on the scale of a round number, and only there: the
    // catalogue declares this axis at a million or more, nothing here has
    // measured it, and models.dev publishes a figure for the same canonical
    // model. `MODELS_DEV_MIN` is the line because a big claim is falsifiable by
    // one refused request while a small one is only falsifiable by climbing to
    // it — and every id under the line is measured instead, which is what the
    // sweep is for. It never lowers anything: `value < declaredValue` falls to
    // the raise-only rule below like any other weak tier.
    // `settled.source === undefined` was in this guard and is not any more: it
    // meant "no table entry and no sweep", which excluded the very ids this
    // half is for. A table entry for a million-token id is a MEASUREMENT of the
    // wall, and the second opinion is about the SCALE its round number was
    // written in — the two are not rivals, and the entry `minimax` now carries
    // says `models.dev` for exactly that reason. What still outranks it is
    // evidence about this route: a live refusal, or a bracket the route drew.
    // What a claim may still be beaten by is evidence about THIS route: a live
    // refusal, or a size the route is known to have refused. `adopted` is
    // neither — it is the bracket this process learned, seeded from the
    // catalogue's own number, so before the route has said anything about a
    // million-token id it IS that number (1000000 here) and would pin the answer
    // there for ever. It is taken as a floor for the claim instead.
    let secondOpinion;
    if (
      axis === "context" &&
      live === undefined &&
      Number.isSafeInteger(declaredValue) &&
      declaredValue >= MODELS_DEV_MIN
    ) {
      const claimed = modelsDevLimit(canonical);
      const floor = usable(adopted) ? adopted : 0;
      if (usable(claimed) && claimed > Math.max(declaredValue, floor)) {
        secondOpinion = { value: claimed, source: "models.dev" };
      }
    }
    let value;
    let source = settled.source;
    if (live !== undefined) {
      value = live;
      // Live is the route answering about itself, so it stands whatever tier the
      // axis was answered from a moment ago.
      source = "route";
    } else if (adopted !== undefined) {
      // A claim that beat the adopted bracket is the value; the bracket only
      // wins when it is the larger of the two.
      value = secondOpinion && secondOpinion.value > adopted ? secondOpinion.value : adopted;
      if (secondOpinion && secondOpinion.value > adopted) source = secondOpinion.source;
    } else {
      // The second opinion raises the settled value rather than replacing it: a
      // table entry that measured 1,048,092 and a claim of 1,048,576 agree, and
      // a claim BELOW a measurement must not pull the measurement down.
      value = secondOpinion ? Math.max(settled.value, secondOpinion.value) : settled.value;
      if (secondOpinion && secondOpinion.value > settled.value) source = secondOpinion.source;
      if (entry && !applies) {
        // Measured against a catalogue that has moved, or against an axis the
        // catalogue no longer declares. Its value is void, and saying so is the
        // whole point of the note: otherwise this is indistinguishable from a
        // model nothing was ever measured for. The note says nothing about what
        // replaced it, which is the sweep's own note below when that is what did.
        note({
          kind: "catalogue-drift",
          id,
          axis,
          value: entry.value,
          measuredAgainst: entry.declaredAt,
          declared: declaredValue,
        });
      }
    }
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0) continue;
    if (value === declaredValue) continue;
    // Weaker evidence may only raise. Live is the route itself, a bracket was put
    // under the declaration by the route answering, and a tier that is neither of
    // those has to be on its own entry: this is what keeps a vendor's page, a
    // watched generation, and a floor the sweep found but never hit from narrowing
    // a window somebody else measured.
    if (
      live === undefined &&
      adopted === undefined &&
      source !== undefined &&
      !ROUTE_TIERS.has(source) &&
      Number.isSafeInteger(declaredValue) &&
      value < declaredValue
    )
      continue;
    overrides[axis] = value;
    // A live value is the one override taken past the staleness guard and past
    // the raise-only rule, so it is the one nobody can account for afterwards:
    // say what was applied and what it stands in for. A sweep value can be taken
    // past both as well, so it says where it came from.
    if (live !== undefined) note({ kind: "route-statement", id, axis, value, declared: declaredValue });
    else if (source === SWEEP_SOURCE && adopted === undefined)
      note({
        kind: "sweep-statement",
        id,
        axis,
        value,
        declared: declaredValue,
        wall: settled.measured?.wall,
        at: settled.measured?.at,
      });
  }
  return overrides;
}

// What the caller would have declared for this axis with no bracket in play: the
// shipped entry when it still applies, else what the sweep measured, and the
// catalogue's own number when neither answers. It is the seed a record is created
// from, and the value a search that has not moved yet derives from — never a
// second opinion about a record that already has one.
//
// `applies` is decided by the caller rather than compared again here: the loop
// that hands this the entry is the same loop that has to say whether an entry it
// is not using was measured against a catalogue that moved, and one comparison
// answering both questions is one comparison that cannot disagree with itself.
function settledFor(applies, entry, declaredValue, measured) {
  if (applies) return { value: entry.value, source: entry.source };
  if (measured !== undefined && (measured.settles || !usable(declaredValue) || measured.value > declaredValue))
    return { value: measured.value, source: SWEEP_SOURCE, measured };
  return { value: declaredValue, source: undefined };
}

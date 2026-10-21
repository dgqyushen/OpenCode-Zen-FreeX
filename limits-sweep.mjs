// Bracket one model's prompt wall in characters, on the live route.
//
//   bun limits-sweep.mjs <model-id> [<model-id> ...]
//   bun limits-sweep.mjs --json <model-id>        one line of JSON, for a workflow
//
// Why this is a file and not a shell history. The walls in `limits.mjs` were
// measured by hand, one id and one afternoon at a time, and every one of them was
// measured differently: a different set of sizes, a different rule for what
// counted as a refusal, and no record of any of it. What this route has since
// taught is that those differences matter, so the rules are written down here and
// applied the same way by everyone, and by the scheduled workflow that runs it.
//
// The rules, all of them learned the hard way on 2026-10-19:
//
//   * A prompt is bracketed in characters, not in tokens, because a refused
//     request reports no `usage.prompt_tokens` — there is no measurement in a
//     refusal, only a size. A served request does report the route's own count,
//     which is what the bracket is reported against.
//
//   * A single refusal is not a wall. This route answered a 1,600,000-character
//     prompt with a 400 and then served the identical request, and it answered
//     two asks with a 500 before serving all three sizes. So every refusal is
//     asked again, once, and one that is followed by a served answer is void.
//
//   * A refusal that could not be asked again is not a wall either. The second
//     ask costs budget, and a run whose budget ran out between the two answers,
//     or whose confirmation failed outright, has one refusal and no proof it
//     reproduces — so that refusal is recorded as `unconfirmed` and the
//     reduction below does not count it.
//
//   * Only a 400 or a 413 can be a size refusal. Those are the statuses this
//     route uses to say the prompt is too long; a 429, a 5xx or a transport
//     error says nothing about the request that was sent, even when its body
//     quotes a context length. Reading one as a wall is how a rate limit
//     becomes a smaller window, so such an answer is an error and never a
//     verdict.
//
//   * An error is retried only when it is transient: 408, 429, 500, 502, 503 and
//     504, or a transport failure that carries no status at all. Retrying a 400
//     about an invalid parameter spends two more requests on an answer that will
//     not change, and a refusal carrying a transient status is retried and then
//     downgraded to an error — an endpoint that never stopped failing has not
//     confirmed anything.
//
//   * A wall needs two refused sizes behind it. One refusal proves one endpoint
//     said no; two prove the prompt is past something this model enforces. A
//     bracket that could not get a second refused size is not a wall and is
//     labelled for what it is: `single-refusal` with the one size that was
//     refused, `openEnded` with the largest size that was served when nothing was
//     refused at all. Nothing is declared from either beyond the floor underneath
//     it, so a reader treats both the same way — only `bracketed` settles an
//     axis.
//
//   * A model is not gone because a request failed. When nothing was served and
//     nothing was refused, one more question is whether the route said the MODEL
//     itself is gone: a 404 or a 410, or an answer whose own wording names the
//     model as not found, unavailable, retired or no longer there. Only then is
//     the result marked `unavailable`, and the mark is an observation rather than
//     a switch — nothing in this file hides, disables or drops a model. A 429, a
//     5xx, a timeout, a transport failure, an auth rejection or a malformed
//     answer is not a liveness verdict at all: it says the run could not ask,
//     which is a question for the next run, not a finding about the model.
//
//   * The budget is fourteen requests per model, first pass included. It is
//     counted in REQUESTS rather than in questions: an answer that had to be
//     retried twice spent three of them, and the budget is what the shared free
//     credential sees. The budget check and the reported `spent` are therefore
//     charged what `ask` says it sent, and the asks left in the budget cap the
//     last answer's retries so the run cannot cross the ceiling. This is
//     somebody's quota and somebody's refused turn, and a sweep that runs
//     unattended must not be able to spend without a ceiling.
//
// What this does not do: write `limits.mjs`. A measurement becomes a table entry
// through a person reading the output, because a bracket produced by a scheduled
// job and committed without anyone looking is a number nobody has ever checked —
// and the table is what every host behind this plugin plans a conversation from.

import { profileFor } from "./core-tools.mjs";
import { CATALOG } from "./provider.mjs";
import { baseFrom, entryVerdict, namesNoScript } from "./limits-audit.mjs";
import { MODELS_DEV_MIN, namedAxes, readBoundedText, refusalAxis } from "./limits.mjs";
import { chatRequest } from "./tools-smoke.mjs";

const GENERATION = process.env.ZEN_GENERATION ?? "1.x";

// The base is parsed when a request is built, not while this module is
// evaluated. `limits-watch.mjs` imports this file, and a malformed
// `ZEN_BASE_URL` used to throw on the `const BASE = ...` line — so a `--check`
// or `--status` run that asks nothing died with a stack trace about an import.
// Asked for here, the same failure lands in `once`'s own try and becomes an
// error answer for the one ask it belongs to.
function baseURL() {
  return baseFrom(process.env.ZEN_BASE_URL);
}

// The sizes the first pass asks. The second one is where this route's walls have
// actually been found — deepseek's is about 326,700 tokens, which is around
// 1,520,000 characters — and the outer ones are wide enough that a model with no
// wall in reach is reported as such instead of being chased upwards.
//
// The top rung is 5,200,000 characters because a declaration of 1,048,576 tokens
// needs about 4,190,000 of them to be tested at all (at this route's ~3.996
// characters per token), and five ids in the current catalogue declare exactly
// that.
//
// The ladder used to stop at 4,200,000, which is about 1,050,500 tokens: 2,000
// tokens ABOVE the binary wall. That looks like enough to find a million-token
// wall and was not, for a reason that is arithmetic rather than luck. A wall is
// only *bracketed* once a size is refused ABOVE a size that was served, and the
// top rung was accepted by every 1,048,576-token id on the route — so the run
// reported `openEnded` and the snapshot kept the largest size it had actually
// served. `minimax-m3.1-flash-free` carried 898,459 tokens against a wall
// measured by hand at 1,048,092; `beam-free`, `nemotron-3.5-super-vl-free`,
// `nemotron-3.5-lightning-free` and `space-bunny-free` all sat at 599k or fewer.
// The one number this sweep exists to produce was under-reported for every large
// id on the route, and nothing in the run said so: `openEnded` reads as "no wall
// in reach", which is exactly what a wall one rung up looks like.
//
// 5,200,000 characters is about 1,301,300 tokens, which clears the whole class
// of 1,048,576 ids instead of sitting inside it, and stays under the largest
// declaration the catalogue makes for a free id. A model whose wall is genuinely
// above it still reports `openEnded` — now for a reason that is true.
export const SIZES = [1_000_000, 1_600_000, 2_800_000, 4_200_000, 5_200_000];

// The rung BELOW the ladder, and the one that decides whether a model with a
// small window can be measured at all.
//
// This sweep measures the ids the catalogue declares below a million — the big
// ones are answered from models.dev and are not asked about — and those are
// exactly the ids whose walls are small. The ladder's own bottom rung of
// 1,000,000 characters is about 250,000 tokens, which sits ABOVE the window of
// a model like `glm-5.3-flash-free` (311,000) and far above a model with a
// 128,000-token window; and a refusal at the bottom rung stops the climb,
// because there is nothing served underneath it to narrow between. So the
// ladder began one rung too high to bracket any window but the largest.
//
// One small rung below the ladder fixes that, and it costs exactly one
// request: the narrowing always runs between the largest SERVED size and the
// smallest refused one, so a rung below every wall does not widen the interval
// it narrows. 200,000 characters is about 50,000 tokens, which every model
// measured here serves.
export const FIRST_SIZE = 200_000;
// The ladder as it is walked, bottom rung first.
export const LADDER = [FIRST_SIZE, ...SIZES];
// A reply is cut off after this many tokens: the question is whether the prompt
// was accepted, and the answer to that arrives before the first token does.
const ASK_TOKENS = 16;
// The bytes of a body that are read. A refusal is short; a served answer is read
// to the end for its `usage`, which `ASK_TOKENS` keeps small.
const READ_BUDGET = 256 * 1024;
// Between requests, so a sweep is not the thing that gets the shared free
// credential rate-limited for everyone.
const PACE_MS = 5000;
// Per model, first pass included. The ladder costs three and confirming a refusal
// costs one, so what is left for narrowing is this minus those: six left two, and
// a (1,000,000 .. 1,600,000) bracket needs five to close to `NARROW_TO`. The budget
// was therefore the other half of why no bracket was ever narrowed — raising it is
// what lets the repaired loop reach the wall rather than stop a third short of it.
//
// Fourteen, because the ladder now has a fifth rung and the bracket it produces
// for a million-token id is wide: (4,200,000 .. 5,200,000) is a quarter of the
// asked size, which needs seven bisections to close to `NARROW_TO`. Five rungs,
// one confirmation, seven bisections and one refused midpoint along the way is
// fourteen. The alternative — a narrower ladder around a million — would have to
// know which ids are large before measuring them, which is the thing being
// measured.
export const BUDGET = 14;
// How close a bracket is worth closing to, as a fraction of the refused size. The
// declared floor is within this of the wall once the loop stops, and a host cannot
// act on a difference this small: the margin the plugin declares under a measured
// wall is the same order. Asking past it spends the shared free credential on a
// number that would not change any declaration.
export const NARROW_TO = 0.02;
// A failure that is about the request being unanswerable rather than about its
// size: retried, never counted. Exported so the tests count the attempts the rule
// actually makes rather than restating them.
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
export const RETRIES = 2;
const RETRY_WAIT_MS = 10000;
// A status that says the MODEL is gone: the route was reached and the model it
// was asked about is not there. These are the only statuses that are a liveness
// verdict on their own — a 400 about a bad parameter is not, and no 5xx is.
const GONE_STATUS = new Set([404, 410]);
// A status that says the RUN could not ask rather than that the model is gone:
// a rate limit, a server fault, a timeout, an auth rejection. None of these is a
// liveness verdict whatever its body happens to say, because the next run may
// well be answered — and calling a model gone over one is the mistake this
// classification exists to avoid.
const NEVER_A_LIVENESS_VERDICT = (status) =>
  status === undefined || status === 401 || status === 403 || status === 408 || status === 429 || (status >= 500 && status <= 599);
// The wording an answer uses when it names the MODEL as gone itself. It is the
// second way a route says a model is unavailable, for the upstreams that answer
// 400 with a sentence rather than a 404.
const MODEL_GONE = /model.*(?:not found|unavailable|retired|no longer)/i;

const SENTENCE = "The quick brown fox jumps over the lazy dog while the calm river runs past the old mill. ";
const promptOf = (chars) => SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The count the route reported for the prompt, or undefined when it reported
// none.
//
// The count is in the route's own bytes, and the route's own bytes are not
// always compact: Python's `json.dumps` — and several OpenAI-compatible
// gateways — write `"prompt_tokens": 215178` with a space after the colon. A
// pattern that does not allow the space reads that serve as "no usage count
// came back", and the count is what the floor is made of: the whole bracket
// degrades without it.
//
// Exported so the pattern can be pinned against the shapes a gateway writes,
// without a served request.
export function promptTokens(text) {
  const tokens = Number.parseInt(/"prompt_tokens"\s*:\s*(\d+)/.exec(text)?.[1] ?? "", 10);
  return Number.isSafeInteger(tokens) ? tokens : undefined;
}

// The window a refusal named, read through limits.mjs's cut-aware reader.
//
// The reader is the plugin's own, so the sweep and the running plugin agree on
// what a named window looks like — `nemotron-3.5-lightning-free` answers with
// "This endpoint's maximum context length is 1000000 tokens", which the sweep
// used to keep only as an opaque `says` string while it went on bisecting
// toward a number the route had already given it.
//
// `over` is the read's own answer to whether it stopped before the body did,
// and it goes with the text because it is the difference between a number the
// route stated and a number the read cut in half: a refusal body that ends
// mid-number (`maximum context length is 104857`, cut from `1048576`) read
// without it becomes the route's stated window, and a stated window outranks
// every bracket and carries no margin — so a truncated digit would become the
// declared wall. `limits-audit.mjs` reads the same body through the same two
// arguments, and the two have to agree about what a stated window is.
//
// Exported so the rule can be pinned without a live refusal.
export function namedWindow(text, over) {
  return namedAxes(text, READ_BUDGET, over).context;
}

// What one non-2xx answer says about the size of the prompt.
//
// Only a 400 or a 413 is about the size. `refusalAxis` reads a named window
// before it looks at the status, so a 429 or a 500 whose body happens to name a
// context length would be classified as a size refusal — and `named` would ride
// along, so `tally` would publish the number as a wall the route "stated". The
// file's own rule is the opposite: a failure that is not about size — a rate
// limit, a 5xx, a transport error — is never a verdict. `limits.mjs` restricts
// size refusals to 400/413 for the same reason, and the sweep and the running
// plugin have to agree about what a refusal is.
//
// Exported so the status gate can be pinned without a live refusal.
export function classifyFailure(chars, status, text, over) {
  const sizeStatus = status === 400 || status === 413;
  // `namedWindow` is only asked under a status that can be about size. The reader
  // does not know about statuses, so handing it a 429 body is what let a stated
  // number outrank the status rule in the first place.
  const named = sizeStatus ? namedWindow(text, over) : undefined;
  // The reader is the plugin's own `refusalAxis`, so the sweep and the running
  // plugin agree about what a refusal is: a numbered sentence first, then the
  // wording, and a failure about no axis at all moves nothing.
  const axis = refusalAxis(status, text, named ? { context: named } : {});
  if (axis !== "context") {
    return { chars, kind: "error", status, says: text.slice(0, 400) };
  }
  return { chars, kind: "refused", status, named, says: text.slice(0, 400) };
}

// One request. The answer is reduced to what a bracket needs: whether the prompt
// was served, the route's own count when it was, and the words it used when it
// was not.
async function once(model, chars) {
  // The profile is asked for here rather than at module scope: a typo in
  // `ZEN_GENERATION` used to throw during evaluation and take the whole sweep —
  // and every importer — down before one answer could be reported. It is a
  // failure of the run's configuration rather than of this size, so it is
  // answered once and marked: every size of every model would get the same
  // sentence, and walking the ladder to say it fourteen times spends the run on
  // a condition no request can change.
  let profile;
  try {
    profile = profileFor(GENERATION);
  } catch (error) {
    return { chars, kind: "error", config: true, says: error?.message ?? String(error) };
  }
  let response;
  try {
    const { headers, body } = chatRequest({
      model,
      generation: GENERATION,
      profile,
      names: [...profile.required],
      maxTokens: ASK_TOKENS,
      messages: [{ role: "user", content: promptOf(chars) }],
    });
    response = await fetch(`${baseURL()}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (error) {
    return { chars, kind: "error", says: error?.message ?? String(error) };
  }
  if (response.ok) {
    // The whole body, not a bounded read: the count is in the last chunk of the
    // stream and nowhere else, and `ASK_TOKENS` keeps the reply that precedes it
    // to a handful of tokens.
    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      return { chars, kind: "error", says: error?.message ?? String(error) };
    }
    // The count is in the route's own bytes, and the route's own bytes are not
    // always compact — `promptTokens` says which shapes, and why a missed count
    // costs the whole bracket.
    const tokens = promptTokens(text);
    return tokens === undefined
      ? { chars, kind: "served", tokens: undefined, says: "served, but no usage count came back" }
      : { chars, kind: "served", tokens };
  }
  const { text, over } = await readBoundedText(response, READ_BUDGET).catch(() => ({ text: "", over: true }));
  // A non-2xx answer is classified in one place, `classifyFailure`, which is
  // where the status rule is written. The read's own `over` goes with the text,
  // so a number the read cut in half is not read as a window the route stated —
  // `namedWindow` says why.
  return classifyFailure(chars, response.status, text, over);
}

// `once` with the retry rule. The result carries the number of HTTP requests the
// answer cost, which is what the budget is charged: one step can send up to
// `RETRIES + 1` requests, and a sweep that reported asks would under-report what
// the shared free credential actually saw.
//
// Only a transient answer is retried: a 408, 429, 500, 502, 503 or 504, or a
// transport failure that carries no status at all. A permanent 400 about an
// invalid parameter answers the same way however many times it is asked, so it
// is asked once. A refusal that carries a transient status is retried with the
// rest and then downgraded to an error: an endpoint that never stopped failing
// has confirmed nothing, and `tally` cannot count what is not a refusal.
//
// `maxRequests` is what was left of the budget when the ask began. The sweep caps
// the last answer's retries with it, so a run whose ceiling is one request away
// cannot spend two more on a retry. `request` and `wait` are injected by the
// tests, which have no route to ask and no ten seconds to wait.
export async function ask(model, chars, log = () => {}, { request = once, wait = sleep, maxRequests = RETRIES + 1 } = {}) {
  const tries = Math.max(1, Math.min(maxRequests, RETRIES + 1));
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const result = await request(model, chars);
    const requests = attempt + 1;
    // A configuration failure is not a transport one. It carries no status, so
    // the rule below would read it as "the network may come back" and spend the
    // retries on it — two more attempts and two waits of ten seconds for an
    // answer no attempt can change, charged to the budget as if the route had
    // been asked. It is returned as it was asked.
    if (result.config) return { ...result, requests };
    const transient = result.kind === "error" && result.status === undefined ? true : TRANSIENT.has(result.status);
    if (!transient) return { ...result, requests };
    const why = result.kind === "error" ? result.says : `HTTP ${result.status}`;
    if (attempt === tries - 1) {
      // A failure that is not about the size of the prompt is never a verdict: a
      // refusal carrying a transient status comes back as an error, so `tally`
      // cannot count it as a wall.
      return result.kind === "refused" ? { ...result, kind: "error", requests } : { ...result, requests };
    }
    log(`    ${chars} chars: ${why} — asking again in ${RETRY_WAIT_MS / 1000}s`);
    await wait(RETRY_WAIT_MS);
  }
  return undefined;
}

// What the requests so far say about the wall, read fresh after every one of
// them rather than accumulated: a size that was refused and then served is void,
// and a running total would have to unpick itself in three places to say so.
// Exported for the tests: the reduction is the whole of the rule for what counts
// as a bound, and a case that could only check it through six live requests would
// not be checking it.
export function tally(asked) {
  const served = asked.filter((one) => one.kind === "served");
  const refused = asked.filter((one) => one.kind === "refused");
  // The floor is the largest size the route SERVED, whether or not it counted
  // the prompt: a 200 without a `usage` count still proves the prompt fitted,
  // and the size that fitted is the size that was asked. Counting only the
  // sizes that came with a count left a route that serves without one with no
  // floor at all — and a floor is what the narrowing runs on and what the
  // ladder's stop used to be gated on, so the bracket lost both: two refusals
  // then read as a ceiling with nothing under it, and the ladder went on
  // asking sizes above a refusal whose answer was already known.
  const servedChars = served.reduce((best, one) => (best === undefined || one.chars > best ? one.chars : best), undefined);
  // The count is a different answer, and it is what a declaration is made of, so
  // it has to belong to the size reported as the floor. It is read from the asks
  // at that floor: a count the route gave for a SMALLER prompt proves the smaller
  // prompt fitted, not this one, and publishing it as the window is the "window
  // too small, quietly never used" failure this file exists to prevent. A floor
  // whose serve carried no count carries no number to declare — declaring
  // nothing is better than declaring the count of a smaller prompt.
  const servedTokens = served
    .filter((one) => one.chars === servedChars && Number.isSafeInteger(one.tokens))
    .reduce((best, one) => (best === undefined || one.tokens > best ? one.tokens : best), undefined);
  // A refusal below the largest served size says nothing about the wall above it:
  // this route refuses prompts it then serves, so only a refusal of something
  // bigger than everything served is a candidate for the bound.
  const over = refused.filter((one) => servedChars === undefined || one.chars > servedChars);
  const refusedSizes = [...new Set(over.map((one) => one.chars))].sort((a, b) => a - b);
  // The window a refusal named, if any of them did. This is the route stating its
  // own limit, which outranks anything bracketed: a named number needs no bisection
  // and carries no margin. Read from the refusals above the served size, so a
  // refusal of something the route went on to serve cannot name the wall.
  const named = over.reduce(
    (best, one) => (Number.isSafeInteger(one.named) && one.named > 0 && (best === undefined || one.named < best) ? one.named : best),
    undefined,
  );
  return { servedChars, servedTokens, refusedSizes, refused: over, named };
}

// The next size to ask, or undefined when the bracket is as tight as the budget
// or the precision rule allows. Separated from the loop that spends it so the rule
// can be checked against a known wall without six live requests: the loop itself
// was wrong for as long as it existed and no test could see it, because the only
// thing exported was the reduction.
//
// `NARROW_TO` is a fraction of the refused size, so the rule is about the gap that
// would still be left rather than a fixed number of requests: a 1,600,000-character
// bracket needs six bisections to close to 2%, while a bracket already inside that
// stops at once and costs nothing.
export function nextAsk(bracket, spent) {
  if (spent >= BUDGET) return undefined;
  // A named window leaves nothing to narrow: the route said what it is, and every
  // further ask would be a request spent re-deriving a number already given.
  if (Number.isSafeInteger(bracket?.named)) return undefined;
  const low = bracket?.servedChars;
  const high = bracket?.refusedSizes?.[0];
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) return undefined;
  if (high - low <= high * NARROW_TO) return undefined;
  const mid = Math.floor((low + high) / 2);
  return mid > low && mid < high ? mid : undefined;
}

// What the answers so far say about the wall, in the four shapes a result can
// have. Named, bracketed, one refusal or none — and each says something
// different about where the wall is, so the words are picked in one place
// rather than through a chain of ternaries at the call site.
//
//   named           the route stated its own window; nothing is left to narrow
//   bracketed       two refused sizes above a served one — the weakest evidence
//                   this file accepts for a wall, and the only shape that
//                   settles an axis
//   single-refusal  one refused size and nothing under it: a hole in the
//                   bracket, reported as what it is
//   openEnded       nothing was refused: the wall is above everything asked
//
// Exported so the tests can pin the four shapes without six live requests.
export function verdictOf(bracket) {
  if (bracket?.named !== undefined) return "named";
  const refused = bracket?.refusedSizes?.length ?? 0;
  if (refused >= 2) return "bracketed";
  if (refused === 1) return "single-refusal";
  return "openEnded";
}

// Whether the ladder goes on to the next rung after this answer.
//
// A refusal the route reproduced is the wall being under the size that was just
// asked, so every larger rung is refused too and asking one spends the shared
// credential on an answer already in hand. The floor is what the narrowing
// runs on, not what the stop needs: the climb used to want a served floor as
// well, and a model whose first rung failed was asked 2,800,000, 4,200,000 and
// 5,200,000 characters for answers it already had.
//
// A failure is not a refusal and does not end the climb: it says nothing about
// the size of the prompt, and the next rung is still worth asking.
//
// Exported so the rule can be pinned without six live requests — the climb is
// what spends the quota, so the rule that ends it is worth a case of its own.
export function climbGoesOn(result) {
  return result !== undefined && result.kind !== "refused";
}

// Whether a result says the route was asked about that model at all.
//
// A model the route served or refused is a model the run learned something
// about; a model whose every request failed is a model the route could not be
// asked about, and nothing about it is known. The verdict cannot answer this:
// `openEnded` is what a run in which every request failed comes back as, because
// nothing was served and nothing was refused, so reading it as a sign of life
// made a run that never got an answer look like a model with no wall in reach.
//
// Exported because the question is asked of one model as well as of a run: the
// survey writes a row per measured id, and a row for a model the route never
// answered says "no wall in reach" about a run that got no answer at all — and
// marks the id as measured, so it is never asked again.
//
// The refusal is read from `refusedChars` or from `refusedSizes[0]`: a `sweep`
// result carries the first refused size as a scalar, while the exported
// `tally` reduction carries only the list. A caller that hands this a
// tally-shaped result must not be told the run learned nothing when a size was
// in fact refused — that would make `exitCodeFor` exit 1 for a run that
// measured a wall.
export function learnedAbout(result) {
  const present = (value) => value !== undefined && value !== null;
  const refused = present(result?.refusedChars) ? result.refusedChars : result?.refusedSizes?.[0];
  return present(result?.servedChars) || present(refused);
}

// The exit code of a run, which says what the run learned and nothing else.
//
// A run of nothing but models the route could not be asked about has learned
// nothing at all — which is what the workflow has to be able to tell apart
// from "no walls found".
//
// An empty result set is not a failure: every id was answered from models.dev
// and none of them was asked, so nothing failed and nothing was learned.
//
// Exported so the rule can be pinned without a run.
export function exitCodeFor(results) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) return 0;
  return list.some(learnedAbout) ? 0 : 1;
}

// The sentence an answer used to say the model is gone, or undefined.
//
// It is kept as a sentence rather than as the whole body because it is reported
// on a snapshot row and read by a person: the first sentence that matches is the
// one that says why, and 160 characters is enough for it.
function goneSentence(text) {
  const said = String(text ?? "");
  const sentence = said.split(/(?<=[.!?])\s+|\r?\n+/).find((one) => MODEL_GONE.test(one));
  return (sentence ?? said).trim().slice(0, 160);
}

// Whether the answers of one run prove that the MODEL itself is gone, and in
// what words the route said so.
//
// The rule, and only this rule, makes a result `unavailable`:
//
//   * at least one answer was asked for, and every answer is an error. One serve
//     or one refusal is an answer about the model and settles that it exists,
//     whatever else failed — `learnedAbout` is the same rule, and this is not a
//     second opinion about it.
//   * every error is about the model being gone rather than about the run: a 404
//     or a 410 says it by status, and any other status says it by wording
//     (`MODEL_GONE`). The transient, transport and auth statuses never say it: a
//     429, a 5xx, a timeout or a rejected key is the route or the run failing,
//     and the next run may be answered. A malformed answer names no model at all,
//     so it cannot claim one is gone either.
//
// Returns `{ unavailable: true }` plus `unavailableSays` when a body matched the
// wording, and undefined otherwise. Exported so the rule can be pinned without a
// single request, the way `tally` and `learnedAbout` are.
export function unavailabilityOf(asked) {
  const list = Array.isArray(asked) ? asked : [];
  // A run that asked nothing learned nothing about liveness either: not asking
  // is not the route saying the model is gone.
  if (list.length === 0) return undefined;
  // One serve or one refusal is an answer about the model itself, so the model is
  // there and whatever else failed cannot make it unavailable.
  if (list.some((one) => one?.kind !== "error")) return undefined;
  let says;
  for (const one of list) {
    const status = one?.status;
    const said = typeof one?.says === "string" ? one.says : "";
    if (GONE_STATUS.has(status)) {
      // A 404/410 is the route naming the model itself; its wording is kept when
      // it also names the model, so the result can say why.
      if (says === undefined && MODEL_GONE.test(said)) says = said;
      continue;
    }
    // The run could not ask, so it cannot call the model gone — whatever the body
    // happens to contain. This is the case the classification exists to exclude:
    // a rate limit or a bad hour at the upstream is not a retired model.
    if (NEVER_A_LIVENESS_VERDICT(status)) return undefined;
    if (!MODEL_GONE.test(said)) return undefined;
    if (says === undefined) says = said;
  }
  return says === undefined ? { unavailable: true } : { unavailable: true, unavailableSays: goneSentence(says) };
}

// The bracket for one model. `spent` and `asked` are reported so a reader can see
// how much of the budget a result cost, and what it was spent on.
//
// Exported, with the request and the pacing injectable, because the loop is where
// the rules that spend the shared credential are decided — a refusal is confirmed
// once, and a step is charged every request it sent — and neither can be checked
// through live requests. The default request is `ask`; a test that has no route
// and no five seconds to wait names its own.
export async function sweep(
  model,
  log = () => {},
  { request = (id, chars, options) => ask(id, chars, log, options), pause = sleep } = {},
) {
  let spent = 0;
  const asked = [];
  const step = async (chars) => {
    if (spent >= BUDGET) return undefined;
    if (spent > 0) await pause(PACE_MS);
    // The budget is charged the requests the ask actually sent: an answer that
    // needed two retries spent three of them, and counting the question would
    // report a third of what the shared free credential saw. What is left of the
    // budget also caps this ask's retries, so the last answer cannot cross the
    // ceiling by retrying.
    const result = await request(model, chars, { maxRequests: BUDGET - spent });
    if (result === undefined) return undefined;
    spent += result.requests ?? 1;
    asked.push(result);
    // One outcome per answer, written as cases instead of a chain of ternaries:
    // the three shapes are the vocabulary of every log line below, and reading
    // them one per branch is what keeps the words and the kinds from drifting.
    let outcome;
    if (result.kind === "served") outcome = `served, ${result.tokens ?? "?"} tokens`;
    else if (result.kind === "refused") outcome = `refused, HTTP ${result.status}`;
    else outcome = `failed, ${result.says}`;
    log(`    ${String(chars).padStart(9)} chars: ${outcome}`);
    return result;
  };

  // A size is asked, and a refusal is asked a second time before it counts: this
  // route answered a 1,600,000-character prompt with a 400 and then served the
  // identical request, so one refusal is an endpoint's opinion.
  const believe = async (chars) => {
    const first = await step(chars);
    if (first === undefined || first.kind !== "refused") return first;
    const again = await step(chars);
    // A confirmation that was never made — the budget ran out between the two
    // asks — or that failed is not a confirmation. One refusal is not a wall, so
    // it is kept as `unconfirmed` rather than `refused`: the reduction below
    // cannot count it, and the result says plainly that the route answered once.
    if (again === undefined || again.kind === "error") {
      log(`    ${chars} chars: the refusal could not be confirmed, so it is not counted`);
      first.kind = "unconfirmed";
      return first;
    }
    if (again.kind !== "served") return first;
    log(`    ${chars} chars: the refusal did not reproduce, so it is void`);
    first.kind = "served";
    first.tokens = again.tokens;
    // The second answer is the same request twice over; it is not a second point.
    asked.splice(asked.indexOf(again), 1);
    return first;
  };

  // The first pass: the rungs in order, asking only downward once a wall has been
  // found below. A rung above a confirmed refusal is a request whose answer is
  // already known — the wall is under the size that was just refused, so every
  // larger rung is refused too, and asking it spends the shared credential on a
  // foregone conclusion. Widening the ladder to reach a million made that waste
  // grow with it: a model walled at 1,600,000 would also have been asked 2,800,000
  // and 4,200,000, four more requests for an answer already in hand.
  //
  // The refusal is what ends the climb, and it ends it whether or not something
  // was served underneath it: a floor is what the narrowing runs on, not what
  // the stop needs. The climb used to want both, and a model whose first rung
  // failed — or was served without a count — went on to be asked 2,800,000,
  // 4,200,000 and 5,200,000 characters, three multi-megabyte requests for an
  // answer the route had already given.
  for (const chars of LADDER) {
    const result = await believe(chars);
    // A failure of the run's own configuration is the same answer at every
    // size: the ladder ends here, so the report says it once instead of
    // fourteen times and the run does not look like fourteen route answers.
    if (result?.config) {
      log("    this is a configuration failure, so no other size would answer differently");
      break;
    }
    // `believe` asks the identical request again and voids a refusal the route
    // did not reproduce, so a refusal that reaches this line is one the route
    // answered twice.
    if (!climbGoesOn(result)) break;
  }

  // Narrowing. The bound this file can declare is the largest size SERVED, so what
  // a bracket is worth is the distance between that and the smallest refusal — not
  // how many refusals were collected. The three ladder sizes already produce two
  // refusals whenever the wall is under the top rung (1,600,000 and 2,800,000), so
  // counting refusals stopped this loop on entry and no bracket was ever narrowed:
  // every size in the shipped snapshot is a ladder point and never a midpoint, and
  // `deepseek` was left reporting a floor of 215,000 against a wall this route is
  // measured to serve at 326,702 — a third of the window lost, on the one number
  // the whole sweep exists to produce.
  //
  // The loop therefore runs on the gap. While the budget holds and the interval is
  // wider than `NARROW_TO` of the refused size, it asks the midpoint of (served,
  // refused): a served midpoint raises the floor without spending a refusal, and a
  // refused one halves what is left, so each step buys up to half of the gap.
  //
  // An ask that moved nothing is not asked again: the same midpoint coming back
  // means the bracket did not change, and the request bought nothing at all. It
  // used to happen — a serve that carried no usage count raised no floor, so the
  // midpoint came back identical and the loop asked it again and again until the
  // budget was gone.
  let lastAsked = undefined;
  for (;;) {
    const now = tally(asked);
    const next = nextAsk(now, spent);
    if (next === undefined || next === lastAsked) break;
    lastAsked = next;
    const result = await believe(next);
    if (result === undefined || result.kind === "error") break;
  }

  const now = tally(asked);
  return {
    model,
    spent,
    // Liveness, only when the run can tell it: every answer was an error and every
    // one of them said the MODEL itself is gone. The keys are omitted otherwise,
    // so a result with a serve, a refusal, a transient failure or no ask at all
    // keeps exactly the shape it had — a reader that does not know this field
    // cannot be told a model is gone by a rate limit. It is an observation, not a
    // switch: nothing here hides, disables or drops a model.
    ...(unavailabilityOf(asked) ?? {}),
    servedTokens: now.servedTokens ?? null,
    servedChars: now.servedChars ?? null,
    refusedChars: now.refusedSizes[0] ?? null,
    refusedSizes: now.refusedSizes,
    // The window the route stated in its own words, when one of its refusals named
    // it. A named number is the route's own answer and is reported beside the
    // bracket rather than instead of it: a reader that only wants a floor still has
    // one, and a reader that wants the wall gets the number the route gave instead
    // of a bisection toward it.
    named: now.named ?? null,
    // Two refused sizes behind a served one is the weakest evidence this file
    // accepts for a wall. One is a bracket with a hole in it and is reported as
    // such rather than smoothed into a wall, and none is a model whose wall is
    // above everything that was asked. The four shapes are named in one place —
    // `verdictOf` — so the words a result carries and the words a reader is
    // given cannot be two answers.
    wall: verdictOf(now),
    says: [...new Set(now.refused.map((one) => one.says).filter((said) => said !== ""))].slice(0, 2),
    asked: asked.map((one) => ({
      chars: one.chars,
      kind: one.kind,
      tokens: one.tokens ?? null,
      status: one.status ?? null,
    })),
  };
}

// The ids this file is allowed to measure, and the ones it is not.
//
// A model the catalogue declares at a million or more is answered from
// models.dev — the largest entry any provider declares for the same canonical
// model — and is not measured here. Only an id the catalogue declares BELOW a
// million is measured, because only there can a measurement change the
// answer. The rule is enforced here as well as in the caller that picks the
// ids, because this is where the requests are made: a run that asked
// `minimax-m3.1-flash-free` and `beam-free` on 2026-10-20 spent eleven
// megabytes of prompts to learn the 1,048,576 the catalogue's own catalogue
// already said.
//
// The catalogue is read once for the whole run and a model it does not declare
// a window for is measured: there is no declaration to be large, so there is
// nothing for models.dev to correct.
export async function measurableIds(models, { catalog, fetchCatalog } = {}) {
  if (catalog === undefined && fetchCatalog) {
    try {
      const document = await fetchCatalog();
      catalog = document?.opencode?.models ?? {};
    } catch {
      // A catalogue that cannot be read is not a reason to measure the ids
      // that models.dev answers: without it, no id is known to be one of them,
      // and the run is what it would have been before this rule.
      catalog = {};
    }
  }
  const declared = new Map();
  for (const [id, row] of Object.entries(catalog ?? {})) {
    const context = row?.limit?.context;
    if (Number.isSafeInteger(context) && context > 0) declared.set(id, context);
  }
  const out = { measured: [], answeredElsewhere: [] };
  for (const id of models) {
    const context = declared.get(id);
    if (context !== undefined && context >= MODELS_DEV_MIN) out.answeredElsewhere.push(id);
    else out.measured.push(id);
  }
  return out;
}

export async function sweepModels(models, log = () => {}) {
  const results = [];
  for (const model of models) {
    log(`${model}`);
    results.push(await sweep(model, log));
  }
  return results;
}

// `--json` is what the workflow reads: one line, so a log full of pacing lines
// cannot be mistaken for the result.
//
// Whether this file was run is asked in one place and answered three ways.
// `import.meta.main` is the direct answer and the one Bun gives, but it arrived
// in Node 22.18 and nothing before that has it, so `entryVerdict` falls back to
// process.argv[1]. An answer it cannot settle is not a reason to exit 0:
// nothing was measured, and saying so with a failure is the only answer that
// cannot be mistaken for a run that asked — unless no script was named at all,
// which is `node -e` or an import from another program: nothing can be run
// from here, so the message and the exit code would be about an import that
// never asked for a sweep and can turn a host's run into a failure.
const main = typeof import.meta.main === "boolean" ? import.meta.main : undefined;
const entry = entryVerdict({ main, url: import.meta.url, argv: process.argv });
if (entry === undefined && !namesNoScript(process.argv)) {
  console.error(
    "limits sweep — could not tell whether this file was run or imported, so nothing was measured: neither import.meta.main nor process.argv[1] named an entry point. Run it with `bun run limits:sweep`.",
  );
  process.exitCode = 1;
}

if (entry === true) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const models = args.filter((arg) => !arg.startsWith("--"));
  if (models.length === 0) {
    console.error("usage: bun limits-sweep.mjs [--json] <model-id> [<model-id> ...]");
    // `process.exitCode` rather than `process.exit`: stderr to a pipe is written
    // asynchronously, and `process.exit` can cut the sentence above off before
    // it is out. The code is the same either way — nothing is measured after
    // this line — so the whole entry point sets codes and lets the process end
    // on its own.
    process.exitCode = 2;
  } else {
    // The rule, enforced where the requests are made: an id the catalogue
    // declares at a million or more is answered from models.dev and is not
    // measured, whoever asked for it.
    const catalogueURL = process.env.ZEN_CATALOG_URL ?? CATALOG;
    const { measured, answeredElsewhere } = await measurableIds(models, {
      fetchCatalog: async () => {
        const response = await fetch(catalogueURL, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      },
    });
    if (answeredElsewhere.length > 0) {
      console.error(
        `not measured, because the catalogue declares them at a million or more and models.dev answers those: ${answeredElsewhere.join(", ")}`,
      );
    }
    const results = await sweepModels(measured, json ? () => {} : (line) => console.log(line));
    if (json) console.log(JSON.stringify(results));
    else
      for (const result of results) {
        console.log("");
        console.log(`  ${result.model}`);
        console.log(`    served      ${result.servedTokens ?? "-"} tokens (${result.servedChars ?? "-"} characters)`);
        console.log(`    refused at  ${result.refusedChars ?? "-"} characters ${result.refusedSizes.length > 1 ? `(and ${result.refusedSizes.slice(1).join(", ")})` : ""}`);
        console.log(`    verdict     ${result.wall}, ${result.spent} of ${BUDGET} requests spent`);
      }
    // What the run learned, and what it says about the route. A model the route
    // served or refused is a model the run learned something about; a model
    // whose every request failed is a model the route could not be asked about,
    // and a run of nothing but those has learned nothing at all — which is
    // what the workflow has to be able to tell apart from "no walls found".
    //
    // The verdict alone cannot answer that, which is what this line used to
    // get wrong: `openEnded` is what a run in which every request failed comes
    // back as, because nothing was served and nothing was refused, so reading
    // it as a sign of life made a run that never got an answer exit 0 — the
    // opposite of what the sentence above it says.
    if (results.length > 0 && exitCodeFor(results) !== 0)
      console.error(
        `nothing was learned about any of these models: the route was asked and answered none of them, so this run says nothing about their windows.`,
      );
    // `process.exitCode` rather than `process.exit`: stdout to a pipe is
    // written asynchronously, and the JSON line above is what the workflow
    // reads — `process.exit` can cut it off.
    process.exitCode = exitCodeFor(results);
  }
}

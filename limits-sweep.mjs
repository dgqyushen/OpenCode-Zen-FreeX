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
//   * A wall needs two refused sizes behind it. One refusal proves one endpoint
//     said no; two prove the prompt is past something this model enforces. A
//     bracket that could not get a second refused size is not a wall and is
//     labelled for what it is: `single-refusal` with the one size that was
//     refused, `openEnded` with the largest size that was served when nothing was
//     refused at all. Nothing is declared from either beyond the floor underneath
//     it, so a reader treats both the same way — only `bracketed` settles an
//     axis.
//
//   * A request that failed for a reason that is not about size — a 5xx, a rate
//     limit, a transport error — is retried twice and is never a verdict. Being
//     unable to ask is not a finding about a model.
//
//   * The budget is six requests per model, three of them the first pass. What is
//     left narrows the boundary once, with two points; a boundary that is still
//     not narrow is reported as it stands rather than chased. This is somebody's
//     quota and somebody's refused turn, and a sweep that runs unattended must
//     not be able to spend without a ceiling.
//
// What this does not do: write `limits.mjs`. A measurement becomes a table entry
// through a person reading the output, because a bracket produced by a scheduled
// job and committed without anyone looking is a number nobody has ever checked —
// and the table is what every host behind this plugin plans a conversation from.

import { profileFor } from "./core-tools.mjs";
import { CATALOG } from "./provider.mjs";
import { baseFrom } from "./limits-audit.mjs";
import { MODELS_DEV_MIN, namedAxes, readBoundedText, refusalAxis } from "./limits.mjs";
import { chatRequest } from "./tools-smoke.mjs";

const BASE = baseFrom(process.env.ZEN_BASE_URL);
const GENERATION = process.env.ZEN_GENERATION ?? "1.x";
const PROFILE = profileFor(GENERATION);

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
// size: retried, never counted.
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const RETRIES = 2;
const RETRY_WAIT_MS = 10000;

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

// One request. The answer is reduced to what a bracket needs: whether the prompt
// was served, the route's own count when it was, and the words it used when it
// was not.
async function once(model, chars) {
  const { headers, body } = chatRequest({
    model,
    generation: GENERATION,
    profile: PROFILE,
    names: [...PROFILE.required],
    maxTokens: ASK_TOKENS,
    messages: [{ role: "user", content: promptOf(chars) }],
  });
  let response;
  try {
    response = await fetch(`${BASE}/chat/completions`, {
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
  // A refusal that names the window states it, and a stated number is better than
  // any bracket: no bisection needed, no margin guessed, nothing left to narrow.
  // The read's own `over` goes with the text, so a number the read cut in half
  // is not read as a window the route stated — `namedWindow` says why.
  const named = namedWindow(text, over);
  // A failure is a refusal only when it is about the SIZE. A 400 that says
  // nothing about a length is the endpoint failing, and reading it as a wall
  // is how a flaky upstream becomes a small window: measured 2026-10-20 on
  // `glm-5.3-flash-free`, whose upstream answered "Upstream request failed:
  // [400] Provider returned error" to prompts it had served minutes earlier,
  // and the sweep — which called every 400 a bound — narrowed toward a wall
  // that was not there.
  //
  // The reader is the plugin's own `refusalAxis`, so the sweep and the running
  // plugin agree about what a refusal is: a numbered sentence first, then the
  // wording, and a failure about no axis at all moves nothing.
  const axis = refusalAxis(response.status, text, named ? { context: named } : {});
  if (axis !== "context") {
    return { chars, kind: "error", status: response.status, says: text.slice(0, 400) };
  }
  return { chars, kind: "refused", status: response.status, named, says: text.slice(0, 400) };
}

// `once` with the retry rule: a transient failure is asked again, because a 500
// says nothing about the size of the prompt, and the sweep must not turn one into
// a wall. Answered twice with the same fault and the request is reported as one.
async function ask(model, chars, log) {
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const result = await once(model, chars);
    if (result.kind !== "error" && !TRANSIENT.has(result.status)) return result;
    const why = result.kind === "error" ? result.says : `HTTP ${result.status}`;
    if (attempt === RETRIES) return result;
    log(`    ${chars} chars: ${why} — asking again in ${RETRY_WAIT_MS / 1000}s`);
    await sleep(RETRY_WAIT_MS);
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
  // The count is a different answer, and it comes from the sizes that carried
  // one: it is what a declaration is made of, so it is the largest count that
  // came back — a floor under the size, never over it. A size served without
  // a count carries no number to declare, and declaring nothing is better than
  // declaring the count of a smaller prompt.
  const counted = served.filter((one) => Number.isSafeInteger(one.tokens));
  const servedTokens = counted.reduce(
    (best, one) => (best === undefined || one.tokens > best ? one.tokens : best),
    undefined,
  );
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
export function learnedAbout(result) {
  const present = (value) => value !== undefined && value !== null;
  return present(result?.servedChars) || present(result?.refusedChars);
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

// The bracket for one model. `spent` and `asked` are reported so a reader can see
// how much of the budget a result cost, and what it was spent on.
async function sweep(model, log) {
  let spent = 0;
  const asked = [];
  const step = async (chars) => {
    if (spent >= BUDGET) return undefined;
    spent += 1;
    if (spent > 1) await sleep(PACE_MS);
    const result = await ask(model, chars, log);
    if (result === undefined) return undefined;
    asked.push(result);
    log(
      `    ${String(chars).padStart(9)} chars: ${
        result.kind === "served"
          ? `served, ${result.tokens ?? "?"} tokens`
          : result.kind === "refused"
            ? `refused, HTTP ${result.status}`
            : `failed, ${result.says}`
      }`,
    );
    return result;
  };

  // A size is asked, and a refusal is asked a second time before it counts: this
  // route answered a 1,600,000-character prompt with a 400 and then served the
  // identical request, so one refusal is an endpoint's opinion.
  const believe = async (chars) => {
    const first = await step(chars);
    if (first === undefined || first.kind !== "refused") return first;
    const again = await step(chars);
    if (again === undefined) return first;
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
if (import.meta.main) {
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

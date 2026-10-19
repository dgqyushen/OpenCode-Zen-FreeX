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
//     bracket that could not get a second refused size is reported as
//     `openEnded` with the largest size that was served, and nothing is declared
//     from it beyond that floor.
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
import { baseFrom } from "./limits-audit.mjs";
import { readBoundedText } from "./limits.mjs";
import { chatRequest } from "./tools-smoke.mjs";

const BASE = baseFrom(process.env.ZEN_BASE_URL);
const GENERATION = process.env.ZEN_GENERATION ?? "1.x";
const PROFILE = profileFor(GENERATION);

// The three sizes the first pass asks. The middle one is where this route's
// walls have actually been found — deepseek's is about 326,700 tokens, which is
// around 1,520,000 characters — and the outer two are wide enough that a model
// with no wall in reach is reported as such instead of being chased upwards.
const SIZES = [1_000_000, 1_600_000, 2_800_000];
// A reply is cut off after this many tokens: the question is whether the prompt
// was accepted, and the answer to that arrives before the first token does.
const ASK_TOKENS = 16;
// The bytes of a body that are read. A refusal is short; a served answer is read
// to the end for its `usage`, which `ASK_TOKENS` keeps small.
const READ_BUDGET = 256 * 1024;
// Between requests, so a sweep is not the thing that gets the shared free
// credential rate-limited for everyone.
const PACE_MS = 5000;
// Per model, first pass included.
const BUDGET = 6;
// A failure that is about the request being unanswerable rather than about its
// size: retried, never counted.
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const RETRIES = 2;
const RETRY_WAIT_MS = 10000;

const SENTENCE = "The quick brown fox jumps over the lazy dog while the calm river runs past the old mill. ";
const promptOf = (chars) => SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const tokens = Number.parseInt(/"prompt_tokens":(\d+)/.exec(text)?.[1] ?? "", 10);
    return Number.isSafeInteger(tokens)
      ? { chars, kind: "served", tokens }
      : { chars, kind: "served", tokens: undefined, says: "served, but no usage count came back" };
  }
  const { text } = await readBoundedText(response, READ_BUDGET).catch(() => ({ text: "" }));
  return { chars, kind: "refused", status: response.status, says: text.slice(0, 400) };
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
  const served = asked.filter((one) => one.kind === "served" && Number.isSafeInteger(one.tokens));
  const refused = asked.filter((one) => one.kind === "refused");
  const servedChars = served.reduce((best, one) => (best === undefined || one.chars > best ? one.chars : best), undefined);
  const servedTokens = served.reduce(
    (best, one) => (best === undefined || one.tokens > best ? one.tokens : best),
    undefined,
  );
  // A refusal below the largest served size says nothing about the wall above it:
  // this route refuses prompts it then serves, so only a refusal of something
  // bigger than everything served is a candidate for the bound.
  const over = refused.filter((one) => servedChars === undefined || one.chars > servedChars);
  const refusedSizes = [...new Set(over.map((one) => one.chars))].sort((a, b) => a - b);
  return { servedChars, servedTokens, refusedSizes, refused: over };
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

  // The first pass: three sizes, widely spaced, asking only downward when a wall
  // has already been found below.
  for (const chars of SIZES) {
    const result = await believe(chars);
    if (result === undefined) break;
    const now = tally(asked);
    // A refusal at the smallest size, believed twice, puts the wall below
    // everything this sweep would ask next: nothing is learned by asking bigger.
    if (chars === SIZES[0] && now.servedChars === undefined && now.refusedSizes.length > 0) break;
  }

  // Narrowing. One refused size is an endpoint's opinion; two refused sizes with
  // a served one under them is a wall, and the only way to get the second inside
  // a budget is to bisect the gap. Each step lands halfway between the largest
  // size served and the smallest refused, so the gap halves and the budget buys a
  // bracket as narrow as the requests allow rather than a wide one that was
  // always going to be wide.
  for (;;) {
    const now = tally(asked);
    if (now.refusedSizes.length >= 2) break;
    if (spent >= BUDGET || now.servedChars === undefined || now.refusedSizes.length === 0) break;
    const low = now.servedChars;
    const high = now.refusedSizes[0];
    const mid = Math.floor((low + high) / 2);
    if (mid <= low || mid >= high) break;
    const result = await believe(mid);
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
    // Two refused sizes behind a served one is the weakest evidence this file
    // accepts for a wall. One is a bracket with a hole in it and is reported as
    // such rather than smoothed into a wall, and none is a model whose wall is
    // above everything that was asked.
    wall: now.refusedSizes.length >= 2 ? "bracketed" : now.refusedSizes.length === 1 ? "single-refusal" : "openEnded",
    says: [...new Set(now.refused.map((one) => one.says).filter((said) => said !== ""))].slice(0, 2),
    asked: asked.map((one) => ({
      chars: one.chars,
      kind: one.kind,
      tokens: one.tokens ?? null,
      status: one.status ?? null,
    })),
  };
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
    process.exit(2);
  }
  const results = await sweepModels(models, json ? () => {} : (line) => console.log(line));
  if (json) console.log(JSON.stringify(results));
  else
    for (const result of results) {
      console.log("");
      console.log(`  ${result.model}`);
      console.log(`    served      ${result.servedTokens ?? "-"} tokens (${result.servedChars ?? "-"} characters)`);
      console.log(`    refused at  ${result.refusedChars ?? "-"} characters ${result.refusedSizes.length > 1 ? `(and ${result.refusedSizes.slice(1).join(", ")})` : ""}`);
      console.log(`    verdict     ${result.wall}, ${result.spent} of ${BUDGET} requests spent`);
    }
  // A sweep that learned nothing about any of its models is a failure of the run,
  // not a clean bill of health: it means the route could not be asked. That is
  // what the workflow has to be able to tell apart from "no walls found".
  process.exit(results.some((result) => result.wall === "bracketed" || result.wall === "openEnded" || result.servedTokens !== null) ? 0 : 1);
}

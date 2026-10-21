// What the bracket rules are, checked where they are decided rather than through
// six live requests.
//
// `limits-sweep.mjs` asks the route questions that cost megabytes and, when it
// overshoots, a refused turn that somebody pays for. That makes the rules it
// applies — what counts as a bound, when a refusal is void, which failures are
// asked again, when a model may be called gone — the part most worth pinning,
// and the part a live run cannot check cheaply or repeatably. `tally` is the
// reduction most of them pass through, and `sweep`/`ask` take an injected
// request, so the rules that spend the budget, confirm a refusal and classify a
// liveness answer can be run without a route at all.
import assert from "node:assert/strict";
import test from "node:test";

const subject = import("./limits-sweep.mjs").catch((error) => {
  assert.fail(`limits-sweep.mjs failed to load: ${error?.message ?? error}`);
});

const served = (chars, tokens) => ({ chars, kind: "served", tokens });
const refused = (chars, status = 400) => ({ chars, kind: "refused", status, says: "context_length_exceeded" });
const failure = (status, says) => ({ kind: "error", status, says });

// Drive one sweep against a scripted route: `answers` is one entry per ask, and
// the last entry is repeated when the ladder asks more times than the script has
// answers. `ask` is bypassed, so each entry is exactly one ask — the unit the
// liveness rule reads — and nothing leaves the process.
const sweepAnswers = async (answers, model = "scripted-free") => {
  const { sweep } = await subject;
  let calls = 0;
  const request = (id, chars) => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    return { chars, ...(typeof answer === "function" ? answer(chars) : answer) };
  };
  return sweep(model, () => {}, { request, pause: async () => {} });
};

test("a served size is a floor and a larger refused size is the bound", async () => {
  const { tally } = await subject;
  const bracket = tally([served(1000000, 215000), served(1600000, 343131), refused(2200000), refused(2800000)]);
  assert.equal(bracket.servedTokens, 343131, "the largest served count is the floor");
  assert.equal(bracket.servedChars, 1600000);
  assert.deepEqual(bracket.refusedSizes, [2200000, 2800000], "both refused sizes, narrowest first");
});

test("a refusal below the largest served size is not a bound", async () => {
  const { tally } = await subject;
  // This is the shape this route actually produces: an endpoint refuses a prompt
  // the next one serves. Read as a bound it would draw the wall in the middle of
  // sizes the route had already accepted.
  const bracket = tally([served(1600000, 343131), refused(1000000), refused(1200000)]);
  assert.equal(bracket.servedTokens, 343131);
  assert.deepEqual(bracket.refusedSizes, [], "a refusal of something smaller than what was served says nothing");
});

test("a served size with no usage count is a floor, and carries no number to declare", async () => {
  const { tally } = await subject;
  // A 200 that carries no `prompt_tokens` proves the prompt fitted, and the
  // size that fitted is the size that was asked — so the bracket has a floor
  // under it. What it has not got is a count, and a count is what a
  // declaration is made of.
  //
  // Counting only the sizes that came with a count left the bracket with no
  // floor at all, and the floor is what the narrowing runs on and what the
  // ladder's stop was gated on: two refusals then read as a ceiling with
  // nothing under it — one of the shapes the rules say must not settle an
  // axis — and the ladder went on asking sizes above a refusal whose answer
  // was already known.
  const bracket = tally([served(1600000, undefined), refused(2200000), refused(2800000)]);
  assert.equal(bracket.servedChars, 1600000, "the size that fitted is the floor of the bracket");
  assert.equal(bracket.servedTokens, undefined, "and there is no count to declare from it");
  assert.deepEqual(bracket.refusedSizes, [2200000, 2800000], "both refusals are above everything served");
  // A count that did come back is only a declaration if it belongs to the floor.
  // Here it does not: 215,178 belongs to the 1,000,000-character ask, while the
  // 1,600,000-character ask — the size that is actually reported as served — came
  // back without one. Declaring the smaller count as the window is the "window
  // too small, quietly never used" failure this file exists to prevent, so the
  // pair is not mixed and no count is declared.
  const counted = tally([served(1000000, 215178), served(1600000, undefined)]);
  assert.equal(counted.servedChars, 1600000, "the largest size served is the floor");
  assert.equal(counted.servedTokens, undefined, "a count from a smaller prompt is not the floor's count");
  // The count that belongs to the floor is the one declared.
  const atFloor = tally([served(1000000, undefined), served(1600000, 343131)]);
  assert.equal(atFloor.servedChars, 1600000);
  assert.equal(atFloor.servedTokens, 343131, "the count read at the reported floor is the number to declare");
});

test("the same size refused twice is one refused size, not two", async () => {
  const { tally } = await subject;
  // The second ask is the rule that a refusal has to reproduce. Counting it as a
  // second point would let a bracket call itself confirmed on one size.
  const bracket = tally([served(1600000, 343131), refused(2200000), refused(2200000), refused(2800000)]);
  assert.deepEqual(bracket.refusedSizes, [2200000, 2800000]);
  assert.equal(bracket.refusedSizes.length, 2);
});

test("a void refusal is a served size, and the point it was voided by is not a second one", async () => {
  const { LADDER, sweep } = await subject;
  // What the sweep does when the identical request that was refused is then
  // served: the first answer becomes `served`, and the second answer — the same
  // request twice — is dropped rather than counted again. Driving `sweep` rather
  // than `tally` is the point: the voiding happens inside the loop, and a
  // reduction that only ever sees the loop's output cannot check it.
  let calls = 0;
  const request = (model, chars) => {
    calls += 1;
    // The bottom rung is the route's flip-flop: refused once, served on the
    // identical ask. Every other rung is served, so the run has a floor and no
    // wall at all.
    if (chars === LADDER[0] && calls === 1)
      return { chars, kind: "refused", status: 400, says: "context_length_exceeded" };
    return { chars, kind: "served", tokens: Math.round(chars / 4) };
  };
  const result = await sweep("void-free", () => {}, { request, pause: async () => {} });
  const atBottom = result.asked.filter((one) => one.chars === LADDER[0]);
  assert.equal(calls, LADDER.length + 1, "the voided refusal was asked twice and every other rung once");
  assert.equal(atBottom.length, 1, "the answer the refusal was voided by is not a second point");
  assert.equal(atBottom[0].kind, "served", "the voided refusal is the serve that replaced it");
  assert.equal(atBottom[0].tokens, Math.round(LADDER[0] / 4), "and it carries the second answer's count");
  assert.ok(!result.asked.some((one) => one.kind === "refused"), "no refusal survives the run");
  assert.deepEqual(result.refusedSizes, []);
  assert.equal(result.wall, "openEnded");
});

test("a bracket is narrowed on its gap, not on how many refusals it collected", async () => {
  const { BUDGET, nextAsk, tally } = await subject;
  // The three ladder sizes produce two refusals whenever the wall is under the top
  // rung, and the narrowing loop used to stop on exactly that count. It therefore
  // stopped on entry, and no bracket was ever widened past its second rung: the
  // shipped snapshot held `deepseek` at a floor of 215,000 against a wall this
  // route serves at 326,702, a third of the window lost.
  const ladder = tally([served(1000000, 215178), refused(1600000), refused(2800000)]);
  assert.deepEqual(ladder.refusedSizes, [1600000, 2800000], "the ladder already holds two refusals");
  const first = nextAsk(ladder, 3);
  assert.equal(first, 1300000, "and it still asks the midpoint of (served, refused)");
  // Asking is what raises the floor: a served midpoint replaces the 1,000,000 with
  // itself, and the next ask lands between it and the refusal.
  const raised = tally([served(1300000, 279223), refused(1600000), refused(2800000)]);
  assert.equal(nextAsk(raised, 4), 1450000, "the gap halves, so the asks converge on the wall");
  // The rule runs on the budget as well: with the budget spent nothing more is
  // asked, however wide the bracket still is.
  assert.equal(nextAsk(ladder, BUDGET), undefined, "a spent budget asks nothing");
  // And a bracket already inside the precision rule costs nothing: this is what
  // keeps a model that was asked once from being asked six times.
  const tight = tally([served(1600000, 343131), refused(1620000)]);
  assert.equal(nextAsk(tight, 0), undefined, "a bracket inside NARROW_TO needs no further ask");
  // A bracket with no refused size above the floor has no interval to halve.
  assert.equal(nextAsk(tally([served(2800000, 598923)]), 1), undefined, "no refusal, nothing to narrow");
  assert.equal(nextAsk(tally([refused(1000000)]), 1), undefined, "no served floor, nothing to narrow");
});

test("the budget is enough to narrow the widest bracket the ladder produces", async () => {
  const { BUDGET, NARROW_TO, nextAsk, tally } = await subject;
  // The budget and the loop are two halves of one rule: a repaired loop with too
  // small a budget still stops short of the wall, which is exactly what happened
  // when the loop was fixed at BUDGET 6 and the declared floor only reached 279,223
  // of a 326,702-token wall. What the ladder leaves to narrow is its two lower
  // rungs, 1,000,000 and 1,600,000, minus the three ladder asks and one refusal
  // confirmation.
  const LADDER = [1_000_000, 1_600_000, 2_800_000];
  const spentOnLadder = LADDER.length + 1;
  // Bisect the widest bracket the ladder can leave, with the wall just under the
  // second rung, and count what it takes to satisfy the precision rule.
  const wall = 1_522_400;
  let asked = [
    { chars: LADDER[0], kind: "served", tokens: 215178 },
    { chars: LADDER[1], kind: "refused" },
    { chars: LADDER[2], kind: "refused" },
  ];
  let spent = spentOnLadder;
  let bracket = tally(asked);
  while (true) {
    const next = nextAsk(bracket, spent);
    if (next === undefined) break;
    spent += 1;
    asked = [
      ...[...new Set(bracket.refusedSizes)].map((chars) => ({ chars, kind: "refused" })),
      { chars: bracket.servedChars, kind: "served", tokens: 1 },
      { chars: next, kind: next <= wall ? "served" : "refused", tokens: next <= wall ? 1 : undefined },
    ];
    bracket = tally(asked);
  }
  assert.ok(
    bracket.servedChars / wall > 1 - NARROW_TO * 2,
    `the floor lands within the precision rule of the wall, got ${bracket.servedChars} against ${wall}`,
  );
  assert.ok(
    spent <= BUDGET,
    `and BUDGET (${BUDGET}) is enough to get there, which took ${spent} requests`,
  );
});

test("the ladder reaches the largest window the catalogue declares", async () => {
  const { BUDGET, NARROW_TO, SIZES } = await subject;
  // A declaration is only testable if the ladder can ask for it. `nemotron` is
  // declared 1,000,000 tokens, which at the route's own ratio of 3.996 characters
  // per token needs 3,996,000 characters; the ladder topped out at 2,800,000 and
  // therefore could neither confirm nor refute the million, so a catalogue that
  // over-declared there kept over-declaring and every host paid for it in refusals.
  const CHARS_PER_TOKEN = 3.996;
  const largestDeclared = 1_000_000;
  const top = Math.max(...SIZES);
  assert.ok(
    top >= largestDeclared * CHARS_PER_TOKEN,
    `the top rung (${top}) must reach a ${largestDeclared}-token declaration, which needs ${Math.round(largestDeclared * CHARS_PER_TOKEN)} characters`,
  );
  // And the rungs are ordered, so the first pass never asks a smaller size after a
  // larger one and the stop-on-a-low-refusal rule keeps working.
  for (let at = 1; at < SIZES.length; at += 1)
    assert.ok(SIZES[at] > SIZES[at - 1], `rung ${at} is larger than the one before it`);
  // The budget still covers the widest bracket the extra rung can leave.
  const spentOnLadder = SIZES.length + 1;
  let far = SIZES[SIZES.length - 1];
  let near = SIZES[SIZES.length - 2];
  let needed = 0;
  while (far - near > far * NARROW_TO) {
    near = Math.floor((near + far) / 2);
    needed += 1;
  }
  assert.ok(
    spentOnLadder + needed <= BUDGET,
    `the ladder (${spentOnLadder}) plus the bisections the widest rung leaves (${needed}) must fit BUDGET (${BUDGET})`,
  );
});

test("a window the route named is read from the refusal instead of bisected", async () => {
  const { namedWindow } = await subject;
  const { nextAsk, tally } = await subject;
  // `nemotron-3.5-lightning-free` answers a too-large prompt with its own number:
  // "This endpoint's maximum context length is 1000000 tokens." The sweep used to
  // keep that only as an opaque `says` string and go on bisecting toward a number
  // the route had already given it.
  const refusal =
    '{"error":{"type":"server_error","message":"Upstream request failed: [400] This endpoint\'s ' +
    'maximum context length is 1000000 tokens. However, you requested about 1052632 tokens ' +
    '(1048576 of text input, 1444 of tool input, 16 in the output)."}}';
  // Read through the sweep's own reader, the one that decides at run time, so
  // the case pins the budget and the cut flag as the sweep uses them.
  assert.equal(namedWindow(refusal, false), 1000000, "the reader takes the number the route stated");
  // Read through the same reduction the sweep uses, it survives as `named` and is
  // the smallest one stated above the served size.
  const bracket = tally([
    { chars: 2_800_000, kind: "served", tokens: 599561 },
    { chars: 4_200_000, kind: "refused", status: 400, named: 1000000, says: refusal },
  ]);
  assert.equal(bracket.named, 1000000);
  // And a named window ends the narrowing: there is nothing left to bisect toward.
  assert.equal(nextAsk(bracket, 0), undefined, "a stated window needs no midpoint");
  // A refusal that names nothing contributes nothing, so a generic 400 cannot
  // become a window.
  const generic = tally([
    { chars: 1_000_000, kind: "served", tokens: 215178 },
    { chars: 1_600_000, kind: "refused", status: 400, says: "context_length_exceeded" },
  ]);
  assert.equal(generic.named, undefined, "a refusal that names no number names no window");
  // And a refusal below the served size cannot name the wall, by the same rule that
  // keeps it out of the bracket.
  const below = tally([
    { chars: 1_600_000, kind: "served", tokens: 343131 },
    { chars: 1_000_000, kind: "refused", status: 400, named: 999999 },
  ]);
  assert.equal(below.named, undefined, "a refusal the route went on to serve names nothing");
});

// A failure is a refusal only when it is about the SIZE. The sweep used to call
// every 400 a bound, so an upstream that fails intermittently became a small
// window — measured 2026-10-20 on `glm-5.3-flash-free`, whose upstream answered
// "Upstream request failed: [400] Provider returned error" to prompts it had
// served minutes earlier.
test("a failure that is not about a size is not a refusal", async () => {
  const { tally } = await subject;
  // What the sweep now records for each kind of answer.
  const asked = [
    { chars: 1_000_000, kind: "served", tokens: 215_041 },
    { chars: 1_600_000, kind: "error", status: 400, says: "Upstream request failed: [400] Provider returned error" },
  ];
  const counted = tally(asked);
  assert.equal(counted.servedChars, 1_000_000, "the serve is what it was");
  assert.deepEqual(counted.refusedSizes, [], "an upstream fault is not a bound");
  assert.equal(counted.refused.length, 0, "and it is not a refusal to narrow toward");
});

test("a refusal about the window is still a bound", async () => {
  const { tally } = await subject;
  const asked = [
    { chars: 1_000_000, kind: "served", tokens: 215_041 },
    { chars: 1_600_000, kind: "refused", status: 400, says: "Your request resulted in more tokens than this model's maximum context length allows." },
  ];
  const counted = tally(asked);
  assert.deepEqual(counted.refusedSizes, [1_600_000], "a refusal about a size is a bound");
  assert.equal(counted.refused.length, 1);
});

// Only a 400 or a 413 is about the size of the prompt. The refusal reader reads
// a named window before it looks at the status, so without a gate a 429 or a 500
// whose body happens to quote "maximum context length is N tokens" is classified
// as a size refusal — and the number rides along as a wall the route "stated",
// which is the route's own number and outranks any bracket.
test("a failure that is not a 400 or 413 is never a size refusal, even when its body names a window", async () => {
  const { classifyFailure } = await subject;
  const body = '{"error":{"message":"This endpoint\'s maximum context length is 1000000 tokens"}}';
  const limited = classifyFailure(1_000_000, 429, body, false);
  assert.equal(limited.kind, "error", "a rate limit is not a wall");
  assert.equal(limited.named, undefined, "and it does not carry the number as a stated window");
  // The same sentence on a 400 is exactly the refusal the route means.
  const refusal = classifyFailure(1_000_000, 400, body, false);
  assert.equal(refusal.kind, "refused");
  assert.equal(refusal.named, 1_000_000, "the number the route stated is still read from a size status");
  // A 500 that talks about context length but names no number is about no axis
  // at all, and a 413 is the other size status.
  assert.equal(classifyFailure(1_000_000, 500, "context length exceeded", false).kind, "error");
  assert.equal(classifyFailure(1_000_000, 413, "prompt is too long", false).kind, "refused");
});

// The retry rule, which is the other half of "a failure is never a verdict".
// Retrying a permanent 400 spends two more requests on an answer that will not
// change; keeping a transient refusal after its retries lets `tally` count a
// rate limit as a wall.
test("a permanent error is asked once, and only a transient one is asked again", async () => {
  const { RETRIES, ask } = await subject;
  const wait = async () => {};
  let calls = 0;
  const permanent = () => {
    calls += 1;
    return { chars: 1_000_000, kind: "error", status: 400, says: "invalid request: bad parameter" };
  };
  const onceOnly = await ask("m", 1_000_000, () => {}, { request: permanent, wait });
  assert.equal(calls, 1, "a permanent 400 answers the same however often it is asked, so it is asked once");
  assert.equal(onceOnly.kind, "error");
  assert.equal(onceOnly.requests, 1, "and the ask reports the one request it sent");
  // A transport failure carries no status at all, so it may be the network
  // rather than the route and is asked again until the last attempt.
  calls = 0;
  const transport = () => {
    calls += 1;
    return calls < RETRIES + 1
      ? { chars: 1_000_000, kind: "error", says: "fetch failed" }
      : { chars: 1_000_000, kind: "served", tokens: 250_000 };
  };
  const recovered = await ask("m", 1_000_000, () => {}, { request: transport, wait });
  assert.equal(calls, RETRIES + 1, "a transport failure is asked again");
  assert.equal(recovered.kind, "served");
  assert.equal(recovered.requests, RETRIES + 1, "and the requests it took are reported");
});

test("a transient refusal is retried and then reported as an error, never a wall", async () => {
  const { RETRIES, ask, tally } = await subject;
  let calls = 0;
  const request = () => {
    calls += 1;
    return { chars: 1_600_000, kind: "refused", status: 429, says: "rate limited" };
  };
  const out = await ask("m", 1_600_000, () => {}, { request, wait: async () => {} });
  assert.equal(calls, RETRIES + 1, "a rate limit says nothing about the request, so it is asked again");
  assert.equal(out.kind, "error", "the last answer is an error rather than the refusal that survived its retries");
  assert.equal(out.requests, RETRIES + 1);
  assert.deepEqual(tally([out]).refusedSizes, [], "so the reduction cannot turn a rate limit into a wall");
  // A refusal that is about the size is not retried: the identical second ask is
  // the confirmation `believe` makes, not this rule's.
  calls = 0;
  const size = () => {
    calls += 1;
    return { chars: 1_600_000, kind: "refused", status: 400, says: "context_length_exceeded" };
  };
  const kept = await ask("m", 1_600_000, () => {}, { request: size, wait: async () => {} });
  assert.equal(calls, 1, "a 400 refusal is asked once");
  assert.equal(kept.kind, "refused");
});

// A refusal is confirmed by asking the same size again. A confirmation that was
// never made (the budget ran out between the two asks) or that failed (the
// second ask was a 5xx) is not a second refusal, so the first one is not a wall.
test("a confirmation the budget never paid for is not a confirmation", async () => {
  const { BUDGET, LADDER, RETRIES, sweep } = await subject;
  // Spend all but one request on the rungs before the refusal: the first answers
  // cost the three requests a retried answer can cost, and the last of them is
  // whatever the budget has left. The refusal itself costs one, taking the run to
  // the ceiling, so the identical second ask is never made.
  const perAnswer = [];
  for (let left = BUDGET - 1; left > 0; ) {
    const requests = Math.min(RETRIES + 1, left);
    perAnswer.push(requests);
    left -= requests;
  }
  assert.ok(perAnswer.length <= LADDER.length - 1, "the fixture leaves the refused rung last in the ladder");
  let calls = 0;
  let answered = 0;
  const request = (model, chars) => {
    calls += 1;
    if (answered < perAnswer.length) {
      const requests = perAnswer[answered];
      answered += 1;
      return { chars, kind: "served", tokens: Math.round(chars / 4), requests };
    }
    return { chars, kind: "refused", status: 400, says: "context_length_exceeded", requests: 1 };
  };
  const result = await sweep("spent-free", () => {}, { request, pause: async () => {} });
  assert.equal(result.spent, BUDGET, "the serves plus the refusal spent the whole budget");
  assert.equal(calls, perAnswer.length + 1, "the confirmation at the last rung was never asked for");
  const last = result.asked[result.asked.length - 1];
  assert.equal(last.chars, LADDER[perAnswer.length]);
  assert.equal(last.kind, "unconfirmed", "a refusal nobody could ask again is not counted");
  assert.deepEqual(result.refusedSizes, []);
  assert.equal(result.wall, "openEnded", "and it cannot become a wall");
});

test("a confirmation that failed is not a confirmation", async () => {
  const { LADDER, RETRIES, sweep } = await subject;
  let calls = 0;
  const request = (model, chars) => {
    calls += 1;
    if (chars === LADDER[0] && calls === 1)
      return { chars, kind: "refused", status: 400, says: "context_length_exceeded", requests: 1 };
    if (chars === LADDER[0])
      // What `ask` returns for a 500 that survived its retries: an error, and
      // the three requests it cost.
      return { chars, kind: "error", status: 500, says: "upstream failed", requests: RETRIES + 1 };
    return { chars, kind: "served", tokens: Math.round(chars / 4), requests: 1 };
  };
  const result = await sweep("flaky-free", () => {}, { request, pause: async () => {} });
  assert.equal(calls, 2 + (LADDER.length - 1), "the bottom rung was asked twice and every other rung once");
  const bottom = result.asked.filter((one) => one.chars === LADDER[0]);
  assert.equal(bottom.length, 2);
  assert.equal(bottom[0].kind, "unconfirmed", "the refusal whose confirmation failed is not counted");
  assert.equal(bottom[1].kind, "error");
  assert.deepEqual(result.refusedSizes, [], "one failed confirmation is not one refusal, let alone a wall");
  assert.equal(result.wall, "openEnded");
  assert.equal(
    result.spent,
    1 + (RETRIES + 1) + (LADDER.length - 1),
    "and the failed confirmation is charged every request it sent",
  );
});

// The budget is what the shared free credential sees, which is requests rather
// than questions: an answer that needed a retry spent two of them for one step.
test("the budget is charged the requests a step sent, not the question it asked", async () => {
  const { BUDGET, LADDER, ask, sweep } = await subject;
  let calls = 0;
  const inner = (model, chars) => {
    calls += 1;
    // The first ask needs one retry: a 500, then a serve.
    if (calls === 1) return { chars, kind: "error", status: 500, says: "upstream failed" };
    return { chars, kind: "served", tokens: Math.round(chars / 4) };
  };
  const request = (model, chars, options) =>
    ask(model, chars, () => {}, { ...options, request: inner, wait: async () => {} });
  const result = await sweep("retried-free", () => {}, { request, pause: async () => {} });
  // One retried answer (two requests) plus one request for each of the other five
  // rungs: seven requests for six questions.
  assert.equal(calls, LADDER.length + 1, "the retry is a real request");
  assert.equal(result.spent, LADDER.length + 1, "and it is what the run reports it spent");
  assert.ok(result.spent <= BUDGET, "which is still inside the ceiling");
});

test("a run of transient failures cannot spend past the budget", async () => {
  const { BUDGET, LADDER, ask, sweep } = await subject;
  let calls = 0;
  const inner = (model, chars) => {
    calls += 1;
    return { chars, kind: "error", status: 503, says: "upstream failed" };
  };
  const request = (model, chars, options) =>
    ask(model, chars, () => {}, { ...options, request: inner, wait: async () => {} });
  const result = await sweep("down-free", () => {}, { request, pause: async () => {} });
  assert.ok(calls <= BUDGET, `a run cannot send more than the budget in requests, sent ${calls}`);
  assert.equal(result.spent, calls, "and it reports every request it sent");
  assert.ok(calls > LADDER.length, "the retries were charged, not counted as one per question");
  assert.equal(result.wall, "openEnded");
});

// Liveness. The sweep already asks the route, so whether the model still exists
// is a question it can answer without one more request — but only when the route
// itself said the model is gone and nothing answered for it. A model is not
// retired by a bad hour at the upstream, and the mark is an observation, not a
// switch: nothing here hides or disables a model.
test("a run whose every answer is a 404 names the model unavailable", async () => {
  const { LADDER } = await subject;
  const result = await sweepAnswers([failure(404, '{"error":{"message":"model scripted-free not found"}}')]);
  assert.equal(result.unavailable, true, "the route reached the model endpoint and said the model is not there");
  assert.equal(result.unavailableSays, '{"error":{"message":"model scripted-free not found"}}', "with the words it used");
  assert.equal(result.asked.length, LADDER.length, "every rung was attempted and every one failed the same way");
  assert.deepEqual(result.refusedSizes, [], "and a 404 is not a wall");
  assert.equal(result.wall, "openEnded");
});

test("a 500 among the answers is not a liveness verdict", async () => {
  const result = await sweepAnswers([failure(404, "model not found"), failure(500, "upstream failed")]);
  assert.equal(result.unavailable, undefined, "one bad hour at the upstream keeps the model alive");
  assert.ok(!Object.hasOwn(result, "unavailable"), "and the field is absent, not false");
});

test("a 410, or wording that names the model, is unavailable with the sentence it used", async () => {
  const long = `The model scripted-free was retired on 2026-10-01 ${"and ".repeat(80)}it is not coming back.`;
  const result = await sweepAnswers([failure(410, long)]);
  assert.equal(result.unavailable, true, "410 is the route saying the model is gone");
  assert.match(result.unavailableSays, /retired/, "the sentence the route used is reported");
  assert.ok(result.unavailableSays.length <= 160, "and truncated for a snapshot row");
  // A 400 that says the model is gone is the same answer in the route's other
  // words: 404/410 are not the only way an upstream retires a model.
  const worded = await sweepAnswers([failure(400, "This model is no longer available; contact support.")]);
  assert.equal(worded.unavailable, true);
  assert.match(worded.unavailableSays, /no longer available/);
});

test("a run that was served is never unavailable", async () => {
  const result = await sweepAnswers([{ kind: "served", tokens: 50_000 }]);
  assert.equal(result.unavailable, undefined);
  assert.ok(!Object.hasOwn(result, "unavailable"), "the result keeps its old shape when the model is alive");
  assert.equal(result.wall, "openEnded");
});

test("a rate limit, a timeout, an auth failure or a malformed answer is not a liveness verdict", async () => {
  // Each of these bodies matches the model-gone wording on purpose: the status
  // decides first, and none of these statuses says the model itself is gone.
  const limited = await sweepAnswers([failure(429, "the model is temporarily unavailable; try again")]);
  assert.equal(limited.unavailable, undefined, "a 429 is the run, not the model");
  const fault = await sweepAnswers([failure(503, "model backend unavailable")]);
  assert.equal(fault.unavailable, undefined, "a 5xx is the run, not the model");
  const timeout = await sweepAnswers([{ kind: "error", says: "model backend unavailable: fetch failed" }]);
  assert.equal(timeout.unavailable, undefined, "a transport failure carries no status and says nothing about the model");
  const auth = await sweepAnswers([failure(403, "model unavailable for this key")]);
  assert.equal(auth.unavailable, undefined, "a key that cannot ask is not a retired model");
  const shape = await sweepAnswers([failure(400, "invalid request: bad parameter")]);
  assert.equal(shape.unavailable, undefined, "a malformed answer names no model at all");
});

test("one concrete answer about the model is not unavailable, whatever else failed", async () => {
  // A 404 first, then a refusal the route reproduced: the refusal is the route
  // answering about the size, so the model exists and the run also has a wall.
  const result = await sweepAnswers([
    failure(404, "model not found"),
    { kind: "refused", status: 400, says: "context_length_exceeded" },
    { kind: "refused", status: 400, says: "context_length_exceeded" },
  ]);
  assert.equal(result.unavailable, undefined);
  assert.equal(result.wall, "single-refusal", "the refusal still counts as what it is");
});

test("unavailability needs an answer, and every answer to agree", async () => {
  const { unavailabilityOf } = await subject;
  assert.equal(unavailabilityOf([]), undefined, "not asking is not the route saying the model is gone");
  assert.equal(unavailabilityOf([{ kind: "unconfirmed", status: 400 }]), undefined, "an unconfirmed refusal is an answer");
  assert.equal(unavailabilityOf([{ kind: "served" }, { kind: "error", status: 404 }]), undefined);
  assert.equal(
    unavailabilityOf([
      { kind: "error", status: 404 },
      { kind: "error", status: 410 },
    ]).unavailable,
    true,
  );
  // A pure 404 with a body that names no model is still the model being gone, but
  // there is no matching sentence to report.
  const bare = unavailabilityOf([{ kind: "error", status: 404, says: "not here" }]);
  assert.equal(bare.unavailable, true);
  assert.ok(!Object.hasOwn(bare, "unavailableSays"));
  // The sentence reported is the first one that names the model, not the first
  // sentence of the body.
  const sentences = unavailabilityOf([
    { kind: "error", status: 404, says: "the gateway answered. The model has retired. model unavailable." },
  ]);
  assert.equal(sentences.unavailableSays, "The model has retired.", "the first matching sentence is the one reported");
});

// The rule, enforced where the requests are made: an id the catalogue declares
// at a million or more is answered from models.dev and is not measured, whoever
// asked for it. The run of 2026-10-20 asked three such ids and spent eleven
// megabytes of prompts to learn what the catalogue already said.
test("a million-token id is not measured, and the caller is told which", async () => {
  const { measurableIds } = await subject;
  const out = await measurableIds(["big-free", "small-free"], {
    catalog: {
      "big-free": { limit: { context: 1_000_000 } },
      "small-free": { limit: { context: 262_144 } },
    },
  });
  assert.deepEqual(out.answeredElsewhere, ["big-free"]);
  assert.deepEqual(out.measured, ["small-free"]);
});

test("an id the catalogue does not declare a window for is measured", async () => {
  const { measurableIds } = await subject;
  const out = await measurableIds(["undeclared-free"], { catalog: {} });
  assert.deepEqual(out.answeredElsewhere, []);
  assert.deepEqual(out.measured, ["undeclared-free"]);
});

test("a catalogue that cannot be read does not change what is measured", async () => {
  const { measurableIds } = await subject;
  const out = await measurableIds(["some-free"], {
    fetchCatalog: async () => {
      throw new Error("the network is down");
    },
  });
  assert.deepEqual(out.answeredElsewhere, [], "no catalogue is no declaration to be large");
  assert.deepEqual(out.measured, ["some-free"]);
});

// The ladder's bottom rung sat above the window of every model this sweep
// measures now, and a refusal at the bottom rung stops the climb: there is
// nothing served underneath it to narrow between. So a model with a window of
// a few hundred thousand tokens could never be bracketed at all.
test("the ladder has a rung below the smallest window measured here", async () => {
  const { LADDER, FIRST_SIZE } = await subject;
  assert.ok(FIRST_SIZE < 1_000_000, "the bottom rung is below the ladder's own first size");
  assert.equal(LADDER[0], FIRST_SIZE);
  // And it is low enough to be served by a model whose wall is a sixth of a
  // million tokens — 200,000 characters is about 50,000.
  assert.ok(FIRST_SIZE / 4 < 262_144, "so a model declared at 262,144 has a rung it can serve");
});

// The climb is what spends the shared credential, so the rule that ends it is
// worth a case of its own. A refusal the route reproduced is the wall being
// under the size that was just asked, so every larger rung is refused too and
// asking one buys an answer already in hand.
test("the ladder stops at a confirmed refusal, whether or not anything was served under it", async () => {
  const { climbGoesOn } = await subject;
  // The floor is what the narrowing runs on, not what the stop needs. The
  // climb used to want a served floor as well, so a model whose first rung
  // failed — or was served without a count — went on to be asked 2,800,000,
  // 4,200,000 and 5,200,000 characters: three multi-megabyte requests for an
  // answer the route had already given.
  assert.equal(climbGoesOn({ kind: "refused" }), false, "a refusal the route reproduced ends the climb");
  assert.equal(climbGoesOn({ kind: "served" }), true, "a served size lets the climb go on");
  assert.equal(climbGoesOn({ kind: "error" }), true, "a failure says nothing about the size of the prompt");
  assert.equal(climbGoesOn(undefined), false, "and an ask that did not happen ends the climb");
});

// The four shapes a result can have, and the words they are given. A named
// window settles the axis on its own, a bracket needs two refused sizes above
// a served one, one refusal is a hole in the bracket and none is a wall above
// everything that was asked.
test("the verdict is named in one place, and the four shapes are what they say", async () => {
  const { verdictOf } = await subject;
  assert.equal(verdictOf({ named: 1000000, refusedSizes: [4200000] }), "named", "the route stated its own window");
  assert.equal(verdictOf({ refusedSizes: [1600000, 2800000] }), "bracketed", "two refused sizes above a served one");
  assert.equal(verdictOf({ refusedSizes: [1600000] }), "single-refusal", "one refusal is a bracket with a hole in it");
  assert.equal(verdictOf({ refusedSizes: [] }), "openEnded", "no refusal is a wall above everything asked");
});

// The exit code is what the workflow reads, and it has to say what happened.
// The verdict cannot: a run in which every request failed comes back as
// `openEnded` for every model, because nothing was served and nothing was
// refused — so reading it as a sign of life made a run that never got an
// answer exit 0, the opposite of what the comment above that line says.
test("a run that learned nothing is a failure of the run, and the exit code says so", async () => {
  const { exitCodeFor, learnedAbout } = await subject;
  const nothingLearned = {
    model: "some-free",
    wall: "openEnded",
    servedTokens: null,
    servedChars: null,
    refusedChars: null,
    refusedSizes: [],
  };
  assert.equal(exitCodeFor([nothingLearned]), 1, "the route could not be asked about any of its models");
  // A model the route served is a model the run learned something about, even
  // where no wall was found: "no walls found" is an answer, not an outage.
  assert.equal(
    exitCodeFor([{ ...nothingLearned, servedChars: 5200000, servedTokens: 1301300 }]),
    0,
    "a model the route served is learned about",
  );
  // And a model the route refused is learned about too: the route answered,
  // whatever it answered.
  assert.equal(exitCodeFor([{ ...nothingLearned, refusedChars: 1600000 }]), 0, "a model the route refused is learned about");
  // Nothing was asked at all — every id answered from models.dev — is not a
  // failure: nothing failed, and nothing was learned either.
  assert.equal(exitCodeFor([]), 0, "an empty result set is not a broken run");
  // The same question, asked of one model: the survey writes a row per measured
  // id, and a row for a model the route never answered says "no wall in reach"
  // about a run that got no answer at all — and marks the id as measured, so
  // it is never asked again.
  assert.equal(learnedAbout(nothingLearned), false, "a model the route never answered is not learned about");
  assert.equal(learnedAbout({ ...nothingLearned, servedChars: 5200000 }), true, "a model it served is");
  assert.equal(learnedAbout({ ...nothingLearned, refusedChars: 1600000 }), true, "and a model it refused is too");
  // The refusal also arrives as the head of `refusedSizes` when the caller holds
  // a `tally` result rather than a `sweep` result. Reading only the scalar would
  // report a run that measured a wall as a run that learned nothing, and
  // `exitCodeFor` would exit 1 for it.
  assert.equal(learnedAbout({ servedChars: undefined, refusedSizes: [1600000] }), true, "a tally-shaped refusal is learned about");
  assert.equal(exitCodeFor([{ servedChars: undefined, refusedSizes: [1600000] }]), 0, "and the run's exit code says so");
  // A model the route served without a count is learned about as well: the
  // size that fitted is the measurement, and the count is what is missing.
  assert.equal(
    learnedAbout({ ...nothingLearned, servedChars: 200000, servedTokens: null }),
    true,
    "a serve without a usage count is still a serve",
  );
});

// A window the route states is the strongest answer this sweep gets, so a
// number the read cut in half must not become one. The read's own `over` is
// what says the body went on past what was read.
test("a number the read cut mid-digits is not a window the route stated", async () => {
  const { namedWindow } = await subject;
  const { namedAxes } = await import("./limits.mjs");
  // A stated window outranks every bracket and carries no margin, so a number
  // the read cut in half (`104857` cut from `1048576`) would become the declared
  // wall. `namedWindow` is the sweep's reader, and it returns only the context
  // axis — whose patterns all have " tokens" after the digits, so a context
  // number can never end at the read head and the cut rule cannot be shown
  // there. The output axis is the one that can end on its own number, and the
  // rule is shared, so the case is pinned where it can fire.
  const output = "max_tokens: 1000000 is not less or equal to 262144";
  assert.equal(
    namedAxes(output, output.length, true).output,
    undefined,
    "the digits reach the read head, so they may have continued: no stated ceiling",
  );
  assert.equal(namedAxes(output, output.length, false).output, 262144, "the same body read whole is the route's own number");
  // A character after the digits inside the head proves they ended, even when
  // the read stopped before the body did: `262144.` is not a prefix of a longer
  // number.
  const withText = `${output}.`;
  assert.equal(namedAxes(withText, withText.length, true).output, 262144, "text after the digits proves the number whole");
  // And the sweep's own context reader still takes a whole body's number.
  const context = "This endpoint's maximum context length is 1048576 tokens";
  assert.equal(namedWindow(context, false), 1048576);
});

// The count is in the route's own bytes, and the route's own bytes are not
// always compact: Python's `json.dumps` — and several OpenAI-compatible
// gateways — write `"prompt_tokens": 215178` with a space after the colon.
test("the count is read from the route's own bytes, compact or not", async () => {
  const { promptTokens } = await subject;
  // A serve whose count is missed reads as "served, but no usage count came
  // back", and the count is what the floor is made of: the whole bracket
  // degrades without it.
  assert.equal(promptTokens('{"usage":{"prompt_tokens": 215178}}'), 215178, "a space after the colon is still the count");
  assert.equal(promptTokens('{"usage":{"prompt_tokens":215178}}'), 215178, "and the compact form is too");
  assert.equal(promptTokens('{"usage":{"completion_tokens":12}}'), undefined, "a body with no count says nothing");
});

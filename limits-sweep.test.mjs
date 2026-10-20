// What the bracket rules are, checked where they are decided rather than through
// six live requests.
//
// `limits-sweep.mjs` asks the route questions that cost megabytes and, when it
// overshoots, a refused turn that somebody pays for. That makes the rules it
// applies — what counts as a bound, when a refusal is void — the part most worth
// pinning, and the part a live run cannot check cheaply or repeatably. `tally` is
// the reduction all of them pass through, so it is where the cases are.
import assert from "node:assert/strict";
import test from "node:test";

const subject = import("./limits-sweep.mjs").catch((error) => {
  assert.fail(`limits-sweep.mjs failed to load: ${error?.message ?? error}`);
});

const served = (chars, tokens) => ({ chars, kind: "served", tokens });
const refused = (chars, status = 400) => ({ chars, kind: "refused", status, says: "context_length_exceeded" });

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
  // A count that did come back is still the number a declaration is made of,
  // and it is read from the size it belongs to: the two are separate answers
  // about separate asks, and the count is the smaller of the two here — a
  // floor under the size, never over it.
  const counted = tally([served(1000000, 215178), served(1600000, undefined)]);
  assert.equal(counted.servedChars, 1600000, "the largest size served is the floor");
  assert.equal(counted.servedTokens, 215178, "and the count is the largest one that came back");
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
  const { tally } = await subject;
  // What the sweep does when the identical request that was refused is then
  // served: the first answer becomes `served`, and the second answer — the same
  // request twice — is dropped rather than counted again.
  const bracket = tally([served(1600000, 343131), served(1900000, 407000)]);
  assert.equal(bracket.servedTokens, 407000);
  assert.deepEqual(bracket.refusedSizes, []);
});

test("a bracket is narrowed on its gap, not on how many refusals it collected", async () => {
  const { BUDGET, NARROW_TO, nextAsk, tally } = await subject;
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
  const { namedAxes } = await import("./limits.mjs");
  const { nextAsk, tally } = await subject;
  // `nemotron-3.5-lightning-free` answers a too-large prompt with its own number:
  // "This endpoint's maximum context length is 1000000 tokens." The sweep used to
  // keep that only as an opaque `says` string and go on bisecting toward a number
  // the route had already given it.
  const refusal =
    '{"error":{"type":"server_error","message":"Upstream request failed: [400] This endpoint\'s ' +
    'maximum context length is 1000000 tokens. However, you requested about 1052632 tokens ' +
    '(1048576 of text input, 1444 of tool input, 16 in the output)."}}';
  assert.equal(namedAxes(refusal).context, 1000000, "the reader takes the number the route stated");
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
test("a refusal body cut mid-number names no window", async () => {
  const { namedWindow } = await subject;
  // The read stopped before the body did, so the digits may have continued:
  // `104857` may be `1048576`. A stated window outranks every bracket and
  // carries no margin, so a truncated number would become the declared wall.
  const cut = "This endpoint's maximum context length is 104857";
  assert.equal(namedWindow(cut, true), undefined, "a number the read cut is not a window the route stated");
  assert.equal(namedWindow(`${cut}6 tokens`, false), 1048576, "the same body read whole is the route's own number");
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

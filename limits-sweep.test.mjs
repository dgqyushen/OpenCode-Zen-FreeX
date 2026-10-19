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

test("a served size with no usage count is not a floor", async () => {
  const { tally } = await subject;
  // A 200 that carries no `prompt_tokens` proves the prompt fitted and says
  // nothing about how big it was: there is no number in it to declare.
  const bracket = tally([served(1600000, undefined), refused(2200000), refused(2800000)]);
  assert.equal(bracket.servedTokens, undefined);
  assert.equal(bracket.servedChars, undefined);
  assert.deepEqual(bracket.refusedSizes, [2200000, 2800000], "with nothing served, every refusal is above everything");
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

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

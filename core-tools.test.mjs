import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { PROFILES, agentFor, generationOf } from "./core-tools.mjs";

// `core-tools.mjs` reads its capture once, at import, which is exactly what the
// failure paths below are about: they cannot be driven from here, because the
// real module is already loaded (and has to stay loadable for every other test).
// Each of those cases imports a copy from a scratch directory instead, so the
// copy resolves its own fingerprint.json beside it. `os.tmpdir()` is the
// platform's /tmp: nothing here is ever written inside the project's tree.
const MODULE = readFileSync(new URL("./core-tools.mjs", import.meta.url), "utf8");
const CAPTURE = readFileSync(new URL("./fingerprint.json", import.meta.url), "utf8");

// A loader for a scratch copy in a fresh directory. Passing no fingerprint is
// the missing-file case; the directory is removed when the test ends.
function scratch(t, fingerprint) {
  const dir = mkdtempSync(join(tmpdir(), "zenfree-core-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "core-tools.mjs"), MODULE);
  if (fingerprint !== undefined) writeFileSync(join(dir, "fingerprint.json"), fingerprint);
  return () => import(pathToFileURL(join(dir, "core-tools.mjs")).href);
}

// The failure an action threw, asserted rather than assumed: a call that returns
// is a failure of the test, not a value to compare a message against.
function thrown(act) {
  try {
    act();
  } catch (error) {
    return error;
  }
  return assert.fail("expected the call to throw");
}

test("a scratch copy with the project's own capture reads it back", async (t) => {
  const { PROFILES: copied } = await scratch(t, CAPTURE)();
  assert.deepEqual(Object.keys(copied).sort(), Object.keys(PROFILES).sort());
});

// The failure this replaces is a bare ENOENT out of whichever module imported
// this one, which reads as that module being broken. The file to fix and the
// command that writes it are what a reader needs, and the original error is kept
// as the cause so it is still there to read.
test("a missing capture names the file and the remedy, keeping the cause", async (t) => {
  const failure = await scratch(t, undefined)().then(
    () => assert.fail("importing a copy with no capture must fail"),
    (error) => error,
  );
  assert.match(failure.message, /fingerprint\.json/);
  assert.match(failure.message, /bun run capture/);
  assert.equal(failure.cause?.code, "ENOENT");
});

test("a corrupt capture is named the same way, with the parse error as the cause", async (t) => {
  const failure = await scratch(t, "{ not json")().then(
    () => assert.fail("importing a copy with a corrupt capture must fail"),
    (error) => error,
  );
  assert.match(failure.message, /fingerprint\.json/);
  assert.match(failure.message, /bun run capture/);
  assert.ok(failure.cause instanceof SyntaxError, "the parse error is kept as the cause");
});

// A capture that lost every profile cannot tell one generation from another, so
// it fails at import rather than at the first request. Which generations a
// capture holds is not checked here: capture.mjs writes profiles[generation],
// so the keys are data and a differently named generation must still load.
test("a capture that carries no profile at all fails at import", async (t) => {
  for (const [what, body] of [
    ["no profiles key", "{}"],
    ["an empty profile map", '{"profiles":{}}'],
    ["a profile list", '{"profiles":[]}'],
    ["a null capture", "null"],
  ]) {
    const failure = await scratch(t, body)().then(
      () => assert.fail(`${what}: importing must fail`),
      (error) => error,
    );
    assert.match(failure.message, /fingerprint\.json/, what);
    assert.match(failure.message, /bun run capture/, what);
  }
});

// A caller can genuinely ask for a generation that was never captured, and
// `undefined` is what `generationOf` returns for a body whose tools name
// neither, which provider.mjs defaults itself. What has to be named is the
// generation that was asked for and the ones the capture holds — not a
// TypeError on the `.agent` of `undefined`, which says neither.
test("an uncaptured generation is named, with the profiles the capture holds", () => {
  for (const generation of [undefined, "3.x", "constructor", "toString"]) {
    const failure = thrown(() => agentFor(generation));
    assert.ok(
      failure.message.includes(JSON.stringify(generation)),
      `the message names ${JSON.stringify(generation)}: ${failure.message}`,
    );
    for (const key of Object.keys(PROFILES))
      assert.ok(failure.message.includes(key), `the message names the ${key} profile`);
    assert.ok(
      !(failure instanceof TypeError),
      "a miss names itself rather than failing on undefined",
    );
  }
});

// Only a per-protocol generation composes its User-Agent out of a
// provider-utils version, and a protocol the capture did not observe used to be
// interpolated as the literal `undefined` — a malformed fingerprint sent to Zen,
// which answers with something that says nothing about where it came from.
test("a protocol with no captured provider-utils is named", () => {
  const entry = Object.entries(PROFILES).find(([, profile]) => profile.agent.providerUtils);
  assert.ok(entry, "the capture is expected to hold a per-protocol profile");
  const [generation, profile] = entry;
  for (const protocol of ["systemone", "constructor", "toString"]) {
    const failure = thrown(() => agentFor(generation, protocol));
    assert.ok(
      failure.message.includes(JSON.stringify(protocol)),
      "the protocol that was asked for",
    );
    assert.ok(
      failure.message.includes(JSON.stringify(generation)),
      "the generation it was asked of",
    );
    for (const captured of Object.keys(profile.agent.providerUtils))
      assert.ok(failure.message.includes(captured), `the message names the captured ${captured}`);
  }
});

// The control for the two above: a protocol the capture did observe still
// composes the User-Agent the capture describes, unchanged.
test("a captured protocol still composes its own User-Agent", () => {
  const entry = Object.entries(PROFILES).find(([, profile]) => profile.agent.providerUtils);
  assert.ok(entry, "the capture is expected to hold a per-protocol profile");
  const [generation, profile] = entry;
  for (const [protocol, version] of Object.entries(profile.agent.providerUtils)) {
    assert.equal(
      agentFor(generation, protocol),
      `opencode/${profile.agent.opencode} ai-sdk/provider-utils/${version} ${profile.agent.runtime}`,
    );
  }
});

// A generation named something other than the two this package knows is data,
// not a mistake: capture.mjs writes profiles[generation], and the import-time
// check asks only that a profile map is there. A profile that is empty is then
// named where it is used — the `.agent` of it used to be a TypeError about
// undefined, exactly like the miss above.
test("a differently named generation loads, and an empty profile is named", async (t) => {
  const { agentFor: copied } = await scratch(t, '{"profiles":{"9.x":{}}}')();
  const failure = thrown(() => copied("9.x"));
  assert.match(failure.message, /9\.x/);
  assert.match(failure.message, /bun run capture/);
});

// The other branch: a generation whose agent carries no provider-utils composes
// a release User-Agent, and it must keep doing so whatever protocol is asked
// for — the protocol is not consulted there, and asking for one the capture has
// no provider-utils for must not change what that branch sends.
test("a generation without provider-utils keeps its release User-Agent", () => {
  const entry = Object.entries(PROFILES).find(([, profile]) => !profile.agent.providerUtils);
  assert.ok(entry, "the capture is expected to hold a release-shaped profile");
  const [generation, { agent }] = entry;
  const expected = `opencode/${agent.channel}/${agent.opencode}/${agent.client}`;
  assert.equal(agentFor(generation), expected);
  assert.equal(agentFor(generation, "systemone"), expected);
});

// Tool names move far less often than descriptions do, which is what this reads.
// Both shapes of a tool are accepted because a host may send either: the
// OpenAI-shaped `{ function: { name } }` and a bare `{ name }`.
test("generationOf tells the generation by tool name", () => {
  assert.equal(generationOf([{ type: "function", function: { name: "shell" } }]), "2.x");
  assert.equal(generationOf([{ type: "function", function: { name: "bash" } }]), "1.x");
  // both names at once belongs to the 2.x shape the gate asks about
  assert.equal(generationOf([{ function: { name: "bash" } }, { name: "shell" }]), "2.x");
  // the alternate shape, named at the top level
  assert.equal(generationOf([{ name: "shell" }]), "2.x");
  assert.equal(generationOf([{ name: "bash" }]), "1.x");
  // neither name: `read` is in both generations, so it tells them apart no better
  // than a tool Zen has never heard of
  assert.equal(generationOf([{ function: { name: "read" } }]), undefined);
  assert.equal(generationOf([{ name: "webfetch" }]), undefined);
});

// `undefined` is a normal answer — it says no generation was recognised, and the
// callers apply their own default (`provider.mjs`: `generationOf(tools) ??
// DEFAULT_GENERATION`). The body is client-supplied, so `tools` can be any shape
// at all: one that is not an array of tools is the same answer as an empty array
// rather than a TypeError out of `.map`.
test("generationOf answers undefined for a body that is not a list of tools", () => {
  for (const tools of [undefined, null, {}, { tools: [] }, "bash", 5, true]) {
    assert.equal(generationOf(tools), undefined, `tools: ${JSON.stringify(tools)}`);
  }
  for (const tools of [[], [null], [5], ["bash"], [{}], [{ function: {} }]]) {
    assert.equal(generationOf(tools), undefined, `tools: ${JSON.stringify(tools)}`);
  }
});

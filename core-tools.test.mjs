import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The module's one remedy, read out of the source read above rather than
// respelled here. Every failure below has to carry it, and reading it from the
// place that writes it is what makes a reworded remedy a change to core-tools.mjs
// alone — the claim the module's own comment makes about the constant, which used
// to be false here: the command was written out again at each of the three places
// that assert it, so a rename of it failed six cases at once instead of one. The
// shape read is pinned by the case below, because reading source text needs a
// shape to read, and a remedy that stopped being one double-quoted constant would
// otherwise leave the cases below matching a string nothing writes any more.
const REMEDY = /^const REMEDY = "([^"]+)";$/m.exec(MODULE)?.[1];

// A loader for a scratch copy in a fresh directory. Passing no fingerprint is
// the missing-file case, `true` is a directory standing where the file should
// be (the unreadable one), and the directory is removed when the test ends.
function scratch(t, fingerprint) {
  const dir = mkdtempSync(join(tmpdir(), "zenfree-core-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "core-tools.mjs"), MODULE);
  if (fingerprint === true) mkdirSync(join(dir, "fingerprint.json"));
  else if (fingerprint !== undefined) writeFileSync(join(dir, "fingerprint.json"), fingerprint);
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

// Every import-time failure names the file to fix and the command that writes it.
// The remedy half comes from the module's own source, read once above, so the
// three cases below assert one string rather than three copies of it.
function assertCaptureFailure(failure, what) {
  assert.match(failure.message, /fingerprint\.json/, what);
  assertNamesRemedy(failure, what);
}

// The remedy a failure has to carry, and nothing else: the message reads
// `core-tools: <what went wrong> — <remedy>`, and this is the half after the dash.
function assertNamesRemedy(failure, what = "the failure") {
  assert.ok(failure.message.includes(REMEDY), `${what}: the message carries the remedy`);
}

// Every generation whose agent is composed per protocol, with its captured
// provider-utils. The cases around it all need the same scan, and the guard is
// what makes it mean something: `assert.ok(entries.length)` alone accepts a
// profile whose provider-utils was captured as `{}`, and the loops below then
// iterate zero times — the per-protocol composition would never be exercised,
// and this file would go green without checking it. The predicate is guarded
// because a profile without an `agent`, or one that is not an object at all, is a
// shape the module deliberately accepts and loads — the empty-profile case below
// pins the first, the `9.x: null` scan case the second — so it must miss here
// rather than throw a TypeError out of the scan. The scan runs inside cases about
// something else, which would then report a failure of their own instead of the
// shape they are about.
//
// All of them, not the first: a capture may carry a second per-protocol
// generation, and `find` answered with whichever one came first in the file —
// the other was never asked about, and a case that says it pins "the
// per-protocol branch" would go green having looked at one of two. Which
// generations the capture holds is data, so the scan is over the data. The map
// itself is a parameter because a profile that is not an object is a shape the
// shipped capture does not carry, so pinning the miss needs a scratch copy to
// supply one.
function perProtocolProfiles(profiles = PROFILES) {
  const entries = Object.entries(profiles).filter(
    ([, profile]) => profile?.agent?.providerUtils,
  );
  assert.ok(entries.length, "the capture is expected to hold a per-protocol profile");
  return entries.map(([generation, profile]) => {
    const protocols = Object.keys(profile.agent.providerUtils);
    assert.ok(protocols.length, `${generation}: with at least one protocol in it`);
    return { generation, profile, protocols };
  });
}

// The generation whose agent is the release shape, which composes its
// User-Agent out of channel/version/client instead of a provider-utils version.
// Its predicate is guarded for the reason the scan above is, and takes the map it
// reads for the same reason: a profile that is not an object has to be missed
// here rather than throw out of a `find` the cases using it depend on.
function releaseProfile(profiles = PROFILES) {
  const entry = Object.entries(profiles).find(
    ([, profile]) => profile?.agent && !profile.agent.providerUtils,
  );
  assert.ok(entry, "the capture is expected to hold a release-shaped profile");
  return entry;
}

// The two things the remedy read above depends on, asserted as a case of its own
// so that either one failing names itself and leaves the rest of the file running:
// the constant's shape, because that is what makes the read possible at all, and
// the command it names, because that is the half of the remedy a reader acts on.
// The command is pinned here rather than in each of the three assertions below, so
// a rename is one case to read instead of six failures to interpret.
test("the module's remedy is one constant, and still names the command it sends you to", () => {
  assert.ok(REMEDY, "core-tools.mjs spells its remedy as one double-quoted constant");
  assert.match(
    REMEDY,
    /bun run capture/,
    "the remedy names the command that writes the capture",
  );
});

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
  assertCaptureFailure(failure);
  assert.match(failure.message, /missing/, "an absent file is what is wrong with it");
  assert.equal(failure.cause?.code, "ENOENT");
});

test("a corrupt capture is named the same way, with the parse error as the cause", async (t) => {
  const failure = await scratch(t, "{ not json")().then(
    () => assert.fail("importing a copy with a corrupt capture must fail"),
    (error) => error,
  );
  assertCaptureFailure(failure);
  assert.match(failure.message, /invalid JSON/, "the parse failure is what is wrong with it");
  assert.ok(failure.cause instanceof SyntaxError, "the parse error is kept as the cause");
});

// A capture that cannot be read at all is neither absent nor corrupt, and the
// remedy (`bun run capture`, which writes the file) cannot fix a permissions
// problem. A directory standing where the capture belongs is the one such case
// a test can build on every platform: `readFileSync` of a directory is EISDIR
// wherever it runs — on Windows too, where the access-denied a directory open
// raises is reported as EISDIR rather than EACCES — and the fixture is a
// directory rather than a file with the read bit taken away precisely so that
// the code it produces is not the platform's to choose.
test("an unreadable capture is not reported as missing or invalid JSON", async (t) => {
  const failure = await scratch(t, true)().then(
    () => assert.fail("importing a copy whose capture cannot be read must fail"),
    (error) => error,
  );
  assertCaptureFailure(failure);
  assert.doesNotMatch(failure.message, /missing/, "the file is there, it just cannot be read");
  assert.doesNotMatch(failure.message, /invalid JSON/, "nothing was parsed, so nothing was invalid");
  // EISDIR and nothing else, because the code below pins the same thing: the
  // regex used to accept EACCES and EPERM as well, which is a different claim —
  // it passed on a message naming a permission problem while the assertion under
  // it demanded the code this fixture always produces. One fixture, one code, so
  // the message and the cause are one claim.
  assert.match(failure.message, /EISDIR/, "the cause's own code is passed on");
  assert.equal(failure.cause?.code, "EISDIR");
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
    assertCaptureFailure(failure, what);
  }
});

// A caller can genuinely ask for a generation that was never captured, and
// `undefined` is what `generationOf` returns for a body whose tools name
// neither, which provider.mjs defaults itself. What has to be named is the
// generation that was asked for and the ones the capture holds — not a
// TypeError on the `.agent` of `undefined`, which says neither. The remedy is
// asserted as well, because this throw used to be one of the two in the module
// that composed its own message without it, and a case that only reads the
// diagnosis would let it drift back.
test("an uncaptured generation is named, with the profiles the capture holds", () => {
  for (const generation of [undefined, "3.x", "constructor", "toString"]) {
    const failure = thrown(() => agentFor(generation));
    assert.ok(
      failure.message.includes(JSON.stringify(generation)),
      `the message names ${JSON.stringify(generation)}: ${failure.message}`,
    );
    for (const key of Object.keys(PROFILES))
      assert.ok(failure.message.includes(key), `the message names the ${key} profile`);
    assertNamesRemedy(failure, JSON.stringify(generation));
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
// The lookup itself is exported, because the same mistake is reachable from
// outside this file: `provider.mjs` reads a profile's `tools` on two paths of
// its own, and indexing `PROFILES[...]` there answered `undefined` for a
// generation the capture does not hold, failing on `.tools` with a TypeError
// that names nothing — where the message below names the capture to fix.
test("the profile lookup is exported, and a miss names the generation", async () => {
  const { profileFor } = await import("./core-tools.mjs");
  assert.equal(profileFor("1.x"), PROFILES["1.x"]);
  assert.throws(() => profileFor("9.x"), /no profile for generation "9\.x"/);
});

test("a protocol with no captured provider-utils is named", () => {
  for (const { generation, protocols } of perProtocolProfiles()) {
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
      for (const captured of protocols)
        assert.ok(failure.message.includes(captured), `the message names the captured ${captured}`);
      // The second of the module's two throws that used to compose its own
      // message without the shared remedy, pinned for the same reason.
      assertNamesRemedy(failure, `${generation}/${protocol}`);
    }
  }
});

// The control for the two above: a protocol the capture did observe still
// composes the User-Agent the capture describes, unchanged.
test("a captured protocol still composes its own User-Agent", () => {
  for (const { generation, profile, protocols } of perProtocolProfiles()) {
    for (const protocol of protocols) {
      assert.equal(
        agentFor(generation, protocol),
        `opencode/${profile.agent.opencode} ai-sdk/provider-utils/${profile.agent.providerUtils[protocol]} ${profile.agent.runtime}`,
      );
    }
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
  assertNamesRemedy(failure);
});

// The other branch: a generation whose agent carries no provider-utils composes
// a release User-Agent, and it must keep doing so whatever protocol is asked
// for — the protocol is not consulted there, and asking for one the capture has
// no provider-utils for must not change what that branch sends.
test("a generation without provider-utils keeps its release User-Agent", () => {
  const [generation, { agent }] = releaseProfile();
  const expected = `opencode/${agent.channel}/${agent.opencode}/${agent.client}`;
  assert.equal(agentFor(generation), expected);
  assert.equal(agentFor(generation, "systemone"), expected);
});

// The release branch is selected by the *absence* of provider-utils, so the
// three fields it interpolates are the whole of what it sends: one missing or
// mistyped used to compose `opencode/undefined/1.19.0/undefined`, and Zen
// answers a header like that with a refusal saying nothing about the capture.
test("a release profile that does not fill in its User-Agent is named", async (t) => {
  for (const [what, agent] of [
    ["an absent channel", { opencode: "2.0.29", client: "cli" }],
    ["a blank channel", { channel: "", opencode: "2.0.29", client: "cli" }],
    ["a numeric channel", { channel: 5, opencode: "2.0.29", client: "cli" }],
    ["no client", { channel: "latest", opencode: "2.0.29" }],
    ["no opencode version", { channel: "latest", client: "cli" }],
  ]) {
    const { agentFor: copied } = await scratch(t, JSON.stringify({ profiles: { "9.x": { agent } } }))();
    const failure = thrown(() => copied("9.x"));
    assert.ok(failure.message.includes("9.x"), `${what}: names the generation`);
    assert.doesNotMatch(failure.message, /opencode\/(undefined|null|5)\//, what);
    assert.doesNotMatch(failure.message, /\/undefined$/, what);
  }
});

// Same gap on the per-protocol branch: `Object.hasOwn` proves the protocol key
// is there, not that its version is a usable string, and `agent.runtime` was
// interpolated with no check at all.
test("a per-protocol profile with a field that is not a string is named", async (t) => {
  for (const [what, agent] of [
    [
      "a null version",
      { opencode: "1.19.0", providerUtils: { chat: null }, runtime: "runtime/bun/1.3.14" },
    ],
    [
      "a blank version",
      { opencode: "1.19.0", providerUtils: { chat: "" }, runtime: "runtime/bun/1.3.14" },
    ],
    [
      "no runtime",
      { opencode: "1.19.0", providerUtils: { chat: "4.0.23" } },
    ],
    [
      "a provider-utils that is not a table",
      { opencode: "1.19.0", providerUtils: "4.0.23", runtime: "runtime/bun/1.3.14" },
    ],
  ]) {
    const { agentFor: copied } = await scratch(t, JSON.stringify({ profiles: { "9.x": { agent } } }))();
    const failure = thrown(() => copied("9.x", "chat"));
    assert.ok(failure.message.includes("9.x"), `${what}: names the generation`);
    assert.doesNotMatch(failure.message, /provider-utils\/(null|undefined)/, what);
    assert.doesNotMatch(failure.message, /\sundefined$/, what);
  }
});

// The structural check on `provider-utils` has to be as strict as the two above
// it — the profile map and the profile — which both refuse a list as well as
// null. An empty list is truthy, so it is not read as the release shape, and it
// used to pass the object check and die at the lookup below with a message
// naming an empty set of protocols: `it holds ` and then nothing, because
// `Object.keys([])` is empty. A list cannot be a table of protocol versions, so
// it is refused where the field is read instead.
test("a provider-utils that is a list is refused where it is read", async (t) => {
  const { agentFor: copied } = await scratch(
    t,
    JSON.stringify({
      profiles: {
        "9.x": {
          agent: { opencode: "1.19.0", providerUtils: [], runtime: "runtime/bun/1.3.14" },
        },
      },
    }),
  )();
  const failure = thrown(() => copied("9.x", "chat"));
  assert.match(failure.message, /9\.x/, "names the generation");
  assert.match(failure.message, /has no per-protocol provider-utils/, "says what is wrong");
  assert.doesNotMatch(failure.message, /it holds $/, "nothing is named after `it holds`");
});

// A profile that is not an object is a shape the import-time check accepts and
// `profileFor` refuses where it is used, so both scans have to miss it the way
// they miss a profile with no `agent`: reading `.agent` off null used to throw a
// TypeError out of a scan that runs inside cases about something else. The
// release shape is in the same capture because the second scan only means
// something when it still finds one.
test("a capture holding a profile that is not an object is missed by both scans", async (t) => {
  const { PROFILES: copied } = await scratch(
    t,
    JSON.stringify({
      profiles: {
        "9.x": null,
        "1.x": {
          agent: {
            opencode: "1.19.0",
            providerUtils: { chat: "4.0.23" },
            runtime: "runtime/bun/1.3.14",
          },
        },
        "2.x": { agent: { channel: "latest", opencode: "2.0.29", client: "cli" } },
      },
    }),
  )();
  const entries = perProtocolProfiles(copied);
  assert.deepEqual(
    entries.map(({ generation }) => generation),
    ["1.x"],
    "the per-protocol profile is still found, and the null one is missed",
  );
  assert.equal(releaseProfile(copied)[0], "2.x", "the release profile is still found");
});

// Ownership of the key is only half of "the capture holds this generation": a
// truncated or hand-edited capture can own it with a value that is not a profile
// at all, and `Object.hasOwn` alone used to hand that back so the caller's
// `.agent` threw the anonymous TypeError this function exists to prevent.
test("a profile that is not an object is named rather than read", async (t) => {
  for (const value of [null, 5, "1.x", [], true]) {
    const { agentFor: copied } = await scratch(
      t,
      JSON.stringify({ profiles: { "9.x": value } }),
    )();
    const failure = thrown(() => copied("9.x"));
    assert.ok(failure instanceof Error, `${JSON.stringify(value)}: an Error, not a TypeError`);
    assert.ok(!(failure instanceof TypeError), `${JSON.stringify(value)}: not the anonymous one`);
    assert.match(failure.message, /9\.x/, `${JSON.stringify(value)}: names the generation`);
    assert.match(failure.message, /not an object/, `${JSON.stringify(value)}: says what is wrong`);
    assertNamesRemedy(failure, JSON.stringify(value));
  }
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

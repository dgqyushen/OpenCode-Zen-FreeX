import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capture, drySummary, fingerprintTarget, invokedDirectly, report } from "./capture.mjs";

// The capture itself may not be run here: a real run starts a server and writes
// a fingerprint. So the two halves either side of that run are driven directly —
// `capture` with a child the test ends by hand, and `report` with a request the
// test builds and a **scratch** fingerprint.
//
// The isolation this file keeps is about writes, and the header said otherwise:
// nothing here writes the capture this repository ships, and every fingerprint a
// case writes to is a file in a temporary directory. The shipped capture *is*
// read — once, for the agent and the required list the fixtures are built from —
// because a run built on this test's own guesses would compare against something
// the real file does not say. Reading it cannot change it, and the one path that
// could (`report`) is handed the scratch path by every case that reaches it.

// The shipped capture, read from the repository. `report` compares a run against
// this, so a case that wants a particular comparison asks for it through the
// request; the fixture is only ever the file the result would be written to. It
// is read here and nowhere else, which is what keeps the read in one place a
// reader can check against the claim above.
const SHIPPED = JSON.parse(readFileSync(join(import.meta.dir, "fingerprint.json"), "utf8")).profiles["1.x"];

const NAMES = ["bash", "glob", "grep", "read"];
const SCHEMA = { type: "object", properties: { path: { type: "string" } } };
// Short enough that KEEP never cuts it and carrying no words NEUTRALISE rewrites,
// so the wording a request carries is the wording that is captured.
const DESCRIPTION = "Read a file from the local filesystem and return its contents as text. ".repeat(3);
// The three-part 1.x User-Agent the shipped profile was captured from, which is
// what makes a run built on it a run with no agent change at all.
const AGENT = `opencode/${SHIPPED.agent.opencode} ai-sdk/provider-utils/${SHIPPED.agent.providerUtils.chat} ${SHIPPED.agent.runtime}`;

// A fingerprint of this test's own, inside a temporary directory: the shipped
// agent and required list, and whatever tools the case names. It is the file a
// write would land in — which is the point, since the repository's own must never
// be that file.
function scratchFingerprint({ names = NAMES, agent = SHIPPED.agent, required = SHIPPED.required } = {}) {
  const root = mkdtempSync(join(tmpdir(), "zen-capture-"));
  const path = join(root, "fingerprint.json");
  const tools = Object.fromEntries(
    names.map((name) => [name, { name, description: DESCRIPTION, parameters: SCHEMA }]),
  );
  writeFileSync(
    path,
    JSON.stringify({ _note: "fixture", profiles: { "1.x": { agent, required: [...required], tools } } }, null, 2),
  );
  return {
    path,
    read: () => JSON.parse(readFileSync(path, "utf8")),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function toolFor(name, extra = {}) {
  return { type: "function", function: { name, description: DESCRIPTION, parameters: SCHEMA, ...extra } };
}

// A scratch fingerprint carrying the wording this repository ships, for the cases
// whose subject is *not* a moved tool: a comparison against the shipped profile
// finds nothing to report only if the fixture stores exactly what the shipped one
// does, wording and all. `scratchFingerprint` writes this test's own short
// description instead, so the stored tools are replaced with the shipped ones.
//
// The store-and-rewrite was written out in full in each case that needed it, and
// a case that changed one half of the pair without the other would compare a
// fixture nobody meant to build. It is one fixture, so it is built once.
function shippedWording({ required = SHIPPED.required } = {}) {
  const names = Object.keys(SHIPPED.tools);
  const scratch = scratchFingerprint({ names, required: [...required] });
  const stored = scratch.read();
  stored.profiles["1.x"].tools = Object.fromEntries(names.map((name) => [name, SHIPPED.tools[name]]));
  writeFileSync(scratch.path, JSON.stringify(stored, null, 2));
  return scratch;
}

// The body of a request carrying the given tools, so the only difference between
// two cases is the one each is about.
function bodyFor(tools, overrides = {}) {
  return {
    model: "big-pickle",
    messages: [{ role: "user", content: "hi" }],
    tools,
    stream: true,
    ...overrides,
  };
}

function requestFor(body, agent = AGENT) {
  return { agent, body: JSON.stringify(body) };
}

const toolsOf = (names) => names.map((name) => toolFor(name));

// A child the test drives. `on` and `kill` are what `capture` uses, so the
// handlers a real run registers are the ones registered here, and `emit` fires
// one the way the runtime would.
function fakeChild() {
  const handlers = {};
  return {
    spawn: () => ({
      kill: () => {},
      on: (event, fn) => {
        handlers[event] = fn;
      },
    }),
    emit: (event, ...args) => handlers[event]?.(...args),
  };
}

// `report` ends in process.exit for every path a case pins, so the exit is
// stubbed and the lines it printed are collected. The stub is not where a
// subprocess would end; it is how the branch is read.
//
// `watchTimers`, when a case asks for it, spies on `setTimeout` so a watchdog
// `capture` arms can be seen at all — a real 120 s wait cannot be waited out
// inside a test. The handle a case is handed is what makes the answer belong to
// this run rather than to the process: the spy records every handle armed while
// it is installed, `armed()` returns the ones armed since the last call and
// marks them seen, `cleared()` asks about those handles by identity, and
// `uncleared()` names the ones still pending so a failure says which. A case
// that asserts on how many timers exist in the process is asserting on whatever
// else happened to be running; one that asserts on the handles taken between two
// points of its own path is asserting on the path.
function offline(body, { watchTimers = false } = {}) {
  const exit = process.exit;
  const log = console.log;
  const error = console.error;
  const setTimer = globalThis.setTimeout;
  const clearTimer = globalThis.clearTimeout;
  const lines = [];
  let code;
  const armedWhileWatching = [];
  let watched = [];
  process.exit = (value) => {
    code = value;
    throw new Error(`process.exit(${value})`);
  };
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  if (watchTimers) {
    globalThis.setTimeout = (fn, ms, ...rest) => {
      // `setTimer`, not `globalThis.setTimeout`: the spy has replaced the global,
      // and calling it back would be the spy calling itself.
      const handle = setTimer(fn, ms, ...rest);
      armedWhileWatching.push(Object.assign(handle, { cleared: false, seen: false }));
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      if (handle) handle.cleared = true;
      return clearTimer(handle);
    };
  }
  // The handles armed while the spy was installed and not yet claimed by a call
  // to `armed()`. The claim is a flag on each handle rather than a saved index:
  // a handle armed after the last `armed()` was armed by this path too, and an
  // index would have to be trusted to have been read at the right moment, where
  // a flag is the handle saying so itself.
  const since = () => armedWhileWatching.filter((handle) => !handle.seen);
  return {
    lines,
    get code() {
      return code;
    },
    // From here on, the handles this returns are this path's and nothing else's:
    // whatever was armed before the call belongs to whoever else is running, and
    // is neither counted nor required to have been cleared by this body. The
    // handles are marked seen as they are handed back, so a second call reads a
    // second window rather than the same one twice — which is what the assertion
    // at the end of the case would otherwise be doing, reading a constant.
    armed: () => {
      watched = since();
      for (const handle of watched) handle.seen = true;
      return watched;
    },
    // How many timers this path has armed since the last `armed()`. This is the
    // window's count, not the process's: a timer armed before the window, or one
    // already claimed by an earlier call, is not this body's to answer for.
    armedCount: () => since().length,
    // The window's handles that are still pending. The empty array is the answer
    // a case asserts, and the names in it are what a failure prints.
    uncleared: () => [...since(), ...watched].filter((handle) => !handle.cleared),
    cleared: () => [...since(), ...watched].every((handle) => handle.cleared),
    run: async () => {
      try {
        await body();
      } catch (cause) {
        // The stub ends the branch by throwing: `process.exit` does not return
        // either, so a run that walks into it does not walk past it. Anything
        // else is a real failure and is handed on.
        if (!/^process\.exit\(/.test(cause?.message ?? "")) throw cause;
      } finally {
        process.exit = exit;
        console.log = log;
        console.error = error;
        if (watchTimers) {
          globalThis.setTimeout = setTimer;
          globalThis.clearTimeout = clearTimer;
        }
      }
    },
  };
}

test("a --fingerprint value that is another flag is not a path", () => {
  // The one decision in this file that sends a write somewhere: a value that is
  // itself an option reads as a file named `--dry`, and where a capture is
  // written must not be decided by a typo. A missing value and a flag-shaped
  // one both fall back to the default, and the environment still wins only when
  // the flag named nothing usable.
  const fallback = join(import.meta.dir, "fingerprint.json");
  const argv = (...rest) => ["bun", "capture.mjs", ...rest];
  assert.equal(fingerprintTarget(argv("--fingerprint", "/tmp/x.json"), {}), "/tmp/x.json");
  assert.equal(fingerprintTarget(argv("--fingerprint", "--dry"), {}), fallback);
  assert.equal(fingerprintTarget(argv("--fingerprint"), {}), fallback);
  assert.equal(fingerprintTarget(argv(), {}), fallback);
  assert.equal(
    fingerprintTarget(argv("--fingerprint", "--dry"), { CAPTURE_FINGERPRINT: "/tmp/env.json" }),
    "/tmp/env.json",
    "an environment value is still read when the flag named nothing",
  );
  assert.equal(
    fingerprintTarget(argv(), { CAPTURE_FINGERPRINT: "" }),
    fallback,
    "an exported-but-empty variable names nothing, so the default stands",
  );
});

test("--fingerprint=<path> is read, not silently ignored", () => {
  // The space-separated form was the only one read, so `=` matched no argv
  // element, the flag fell back to the default, and the write landed on the
  // repository's own fingerprint.json — the one outcome the flag exists to
  // prevent, arrived at without a word. Both spellings name the same thing.
  const fallback = join(import.meta.dir, "fingerprint.json");
  const argv = (...rest) => ["bun", "capture.mjs", ...rest];
  assert.equal(fingerprintTarget(argv("--fingerprint=/tmp/x.json"), {}), "/tmp/x.json");
  // An `=` with nothing after it names nothing, exactly as the bare flag does.
  assert.equal(fingerprintTarget(argv("--fingerprint="), {}), fallback);
  assert.equal(
    fingerprintTarget(argv("--fingerprint="), { CAPTURE_FINGERPRINT: "/tmp/env.json" }),
    "/tmp/env.json",
    "an environment value is still read when the inline form named nothing",
  );
  // Both spellings at once is a command line that says two things; the `=` form
  // is the more specific of them and is the one read.
  assert.equal(fingerprintTarget(argv("--fingerprint=/tmp/inline.json", "--fingerprint", "/tmp/space.json"), {}), "/tmp/inline.json");
  assert.equal(fingerprintTarget(argv("--fingerprint", "/tmp/space.json", "--fingerprint=/tmp/inline.json"), {}), "/tmp/inline.json");
});

test("the guard that keeps an import from running the capture", () => {
  // This process imported the file rather than running it, which is what this
  // guard is for. Before it, importing capture.mjs started a server and rewrote
  // the shipped fingerprint — so the file could not be tested at all.
  //
  // What this case proves is the `false` half of the guard, and it is worth
  // being exact about the other half: `invokedDirectly()` is `import.meta.main`
  // under every runtime this repository runs on, and that flag is a property of
  // how the process was started. The `true` half — the same file reached by
  // `bun capture.mjs` — cannot be produced from inside a process that imported
  // it, and asking for it here would mean running the entry point, which starts
  // a server and captures a fingerprint. It is covered by the script being used
  // rather than by this file; what would close it is a child process spawned to
  // run and report, which is the Lead's call rather than a case this file can
  // write. The `false` half is still the one that matters for isolation: if it
  // ever became `true` in a test process, every case below would start a server.
  assert.equal(invokedDirectly(), false);
});

test("a child a signal killed is a failed run, not exit 0", async () => {
  // A signal exit leaves a null code. `value ?? 0` read that as a clean exit,
  // which is what let an aborted run walk into the compare and write path.
  const run = fakeChild();
  const pending = capture("probe", run.spawn);
  run.emit("exit", null, "SIGKILL");
  const { code, ran } = await pending;
  assert.equal(ran, false, "a signal exit is a failed run");
  assert.equal(code, 1, "and its code is non-zero");
});

test("a Ctrl-C is a failed run too, and it is the handler that says so", async () => {
  // The other way `ran` goes false, and the one no exit code carries: the
  // handler that takes the child down with the interrupt. It is the listener
  // this module registered that is called, not the whole process's — the case
  // used to reach it with `process.emit("SIGINT")`, which runs every listener
  // the process holds and here happened to be none others. A leaked handler was
  // therefore invisible: with `once` on SIGTERM left armed, the file still
  // reported 18 pass / 0 fail.
  //
  // `process.once` is spied on only long enough to take the function out again,
  // which is what makes calling the listener under test possible without a
  // signal and without `process.emit`. The listener is unregistered immediately
  // in `finally` — on the same `process.off` the module's own settle path uses —
  // so the process this file runs in is left as it was found, and the counts
  // below are the proof of that rather than a claim about it.
  const run = fakeChild();
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const once = process.once;
  const off = process.off;
  const registered = [];
  process.once = function (event, fn) {
    registered.push({ event, fn });
    return once.call(this, event, fn);
  };
  let pending;
  try {
    pending = capture("probe", run.spawn);
  } finally {
    process.once = once;
  }
  try {
    // Both handlers, found by the event they were registered for: what is under
    // test is the one for SIGINT, and asserting both were registered is what
    // says the isolation below is about the right two listeners.
    const listener = registered.find(({ event }) => event === "SIGINT");
    assert.notEqual(listener, undefined, "the capture must register a SIGINT handler");
    listener.fn();
    const { code, ran } = await pending;
    assert.equal(ran, false, "an interrupted run is a failed run");
    assert.equal(code, 1, "and its code is non-zero");
  } finally {
    for (const { event, fn } of registered) off.call(process, event, fn);
  }
  assert.deepEqual(
    [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
    before,
    "the settle path must have taken both handlers off again, and this case must leave the"
      + " process as it found it",
  );
});

test("a clean exit is reported as itself", async () => {
  const run = fakeChild();
  const pending = capture("probe", run.spawn);
  run.emit("exit", 0, null);
  assert.deepEqual(await pending, { code: 0, ran: true });
});

test("a child that could not be started is a failed run", async () => {
  const run = fakeChild();
  const pending = capture("probe", run.spawn);
  run.emit("error", new Error("ENOENT"));
  assert.deepEqual(await pending, { code: 1, ran: false });
});

test("a spawn failure takes the watchdog and the signal handlers with it", async () => {
  // The `error` path settled the promise and nothing else: the 120 s watchdog
  // stayed pending, so it would later log an ending for a child that never
  // started, and both `process.once` handlers stayed armed, so they would swallow
  // a Ctrl-C. `setTimeout` is spied on rather than trusted to be noticed: what is
  // asked is whether the handler this module armed was cleared, which a real
  // 120 s wait cannot answer inside a test either way.
  const run = fakeChild();
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let watched;
  const captureRun = offline(async () => {
    // Taken after the capture is started and before it is settled, so what is
    // handed back is this path's own watchdog and nothing else. A window opened
    // before `capture` runs could only ever be empty, and an assertion reading it
    // could not fail — which is what the old `watched.length === 0` was. The
    // handles are claimed here rather than counted, so the assertions after the
    // body read the timer this path armed rather than however many timers the
    // process happened to be holding.
    const pending = capture("probe", run.spawn);
    watched = captureRun.armed();
    run.emit("error", new Error("ENOENT"));
    assert.deepEqual(await pending, { code: 1, ran: false });
  }, { watchTimers: true });
  await captureRun.run();
  // The handles, not a count: this is the watchdog by identity, so the case reads
  // what it claims to read. `cleared()` used to carry a `watched` clause that
  // could not fail — `watched` was only ever assigned a fresh empty array — while
  // the count it did read was of every timer in the process.
  assert.equal(watched.length, 1, "the spawn failure arms exactly the watchdog");
  assert.deepEqual(
    captureRun.uncleared(),
    [],
    "the spawn failure must clear the watchdog it armed, and leave no other timer pending",
  );
  assert.equal(captureRun.cleared(), true, "and the spawn failure must clear it");
  assert.deepEqual(
    [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
    before,
    "a spawn failure must leave no signal handler armed",
  );
});

test("the signal handlers are dropped once the child is gone", async () => {
  // A `process.once` that has not fired stays armed, and settling an already
  // settled promise is a no-op: a Ctrl-C during the write phase would be
  // swallowed rather than end the script. The watchdog is asked about here too:
  // an exit is the other way this promise is settled, and the timer that would
  // outlive it is the same one.
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const run = fakeChild();
  let watched;
  const captureRun = offline(async () => {
    // Claimed between starting the capture and settling it: the watchdog is
    // armed by the `capture` call itself, so a window opened before that call
    // holds nothing and an assertion reading it holds nothing either.
    const pending = capture("probe", run.spawn);
    watched = captureRun.armed();
    run.emit("exit", 0, null);
    assert.deepEqual(await pending, { code: 0, ran: true });
  }, { watchTimers: true });
  await captureRun.run();
  assert.equal(watched.length, 1, "the exit path arms one watchdog");
  assert.deepEqual(captureRun.uncleared(), [], "and the exit path must leave no timer pending");
  assert.equal(captureRun.cleared(), true, "and the exit path must clear it");
  assert.deepEqual(
    [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
    before,
    "the exit path must not leave the handlers armed",
  );
});

test("a required name that arrived without a description is refused as that, not as one this OpenCode stopped sending", async () => {
  // Two defects in one path. First: `tools` only holds names that arrived with a
  // non-empty description, so reading `missing` off it reported a tool that *was*
  // sent as one this OpenCode no longer sends. Second, and open until the check
  // below existed: such a name passed the `sent` test and was then written into
  // `required`, naming a tool the written `tools` does not carry — the shape
  // `bun run check:gate` refuses, produced by the tool that keeps that file
  // honest. `grep` is sent with no description; `bash`, `glob` and `read` are
  // captured normally.
  const scratch = scratchFingerprint();
  const before = JSON.stringify(scratch.read());
  const captureRun = offline(() =>
    report({
      request: requestFor(
        bodyFor([toolFor("bash"), toolFor("glob"), toolFor("read"), toolFor("grep", { description: "" })]),
      ),
      code: 0,
      fingerprint: scratch.path,
    }),
  );
  try {
    await captureRun.run();
    const said = captureRun.lines.join("\n  ");
    assert.equal(captureRun.code, 1, `an uncapturable required tool must refuse:\n  ${said}`);
    assert.equal(
      captureRun.lines.some((line) => line.includes("no longer sends")),
      false,
      `a tool that was sent must not be reported as one this OpenCode stopped sending:\n  ${said}`,
    );
    assert.equal(
      captureRun.lines.some((line) => line.includes("grep") && line.includes("without a description")),
      true,
      `the refusal has to name the tool and what is wrong with it:\n  ${said}`,
    );
    assert.equal(JSON.stringify(scratch.read()), before, "a refused capture must not write");
  } finally {
    scratch.remove();
  }
});

test("the anthropic shape is refused for what it is, before the per-tool schema check", async () => {
  // The input_schema refusal used to sit after the per-tool loop, which exits
  // first with "carries no parameter schema" — so the intentional diagnosis was
  // unreachable. `read` is in the anthropic shape and `grep` carries no schema
  // at all: whichever message comes back names which check ran first.
  const scratch = scratchFingerprint();
  const captureRun = offline(() =>
    report({
      request: requestFor(
        bodyFor([toolFor("read", { parameters: undefined, input_schema: SCHEMA }), toolFor("grep", { parameters: undefined })]),
      ),
      code: 0,
      fingerprint: scratch.path,
    }),
  );
  try {
    await captureRun.run();
  } finally {
    scratch.remove();
  }
  assert.equal(captureRun.code, 1);
  assert.equal(
    captureRun.lines.some((line) => line.includes("parameter schema")),
    false,
    `the per-tool loop must not get there first:\n  ${captureRun.lines.join("\n  ")}`,
  );
  assert.equal(
    captureRun.lines.some((line) => line.includes("anthropic shape")),
    true,
    `the anthropic refusal must be the one printed:\n  ${captureRun.lines.join("\n  ")}`,
  );
});

test("a --dry report names the agent whenever it moved, required list or not", async () => {
  // The ternary that built this summary was dead, and what replaced it dropped
  // "the agent" whenever the required list had also changed. That guard is only
  // reached when the required list did *not* move, so the run that pins it has to
  // be one where the list stood still — and which list moved is not something a
  // fixture gets to choose. `report` compares against the capture this process
  // imported (`PROFILES`, capture.mjs:291), and the list it captures is the
  // `REQUIRED` literal in capture.mjs, so the two agree for every run that is not
  // a hand-edited fingerprint changing under a stale module: a stored list that
  // differs from the request is a list that *already* disagreed with `REQUIRED`,
  // and it is still written back over. The case that used to stand here put
  // `write` and `edit` in the fixture and called that "the list moved too", which
  // it never was — the fixture's tools were the short ones, every tool read
  // CHANGED, and the summary was the agent alone. So this is the honest version
  // of the same claim: nothing but the agent moved, and it is still named.
  const names = Object.keys(SHIPPED.tools);
  const scratch = shippedWording();
  const captureRun = offline(() =>
    report({
      request: requestFor(
        bodyFor(names.map((name) => ({ type: "function", function: SHIPPED.tools[name] }))),
        "opencode/1.99.0 ai-sdk/provider-utils/9.9.9 runtime/bun/9.9.9",
      ),
      code: 0,
      fingerprint: scratch.path,
      dry: true,
    }),
  );
  try {
    await captureRun.run();
  } finally {
    scratch.remove();
  }
  assert.equal(captureRun.code, 1, "a change under --dry exits non-zero");
  const summary = captureRun.lines.filter((line) => line.includes("would change"));
  assert.equal(summary.length, 1, `one summary line expected:\n  ${captureRun.lines.join("\n  ")}`);
  // No count: every tool was compared and matched, and the agent is named on its
  // own rather than beside a number that would have to be zero. The summary
  // carries a leading newline, which is why this is read trimmed.
  assert.equal(
    summary[0].trim(),
    "the agent would change. Nothing written (--dry).",
    `nothing but the agent moved, and the agent has to be named:\n  ${captureRun.lines.join("\n  ")}`,
  );
  assert.equal(
    captureRun.lines.some((line) => line.startsWith("  bash") && line.includes("CHANGED")),
    false,
    `the shipped wording must compare equal, or this case is about a moved tool:\n  ${captureRun.lines.join("\n  ")}`,
  );
  assert.equal(
    captureRun.lines.some((line) => line.includes("wrote")),
    false,
    "--dry must not say it wrote",
  );
});

test("the --dry summary names the agent beside a change count when both moved", () => {
  // The run above reaches the summary with a count of zero, and a count of zero
  // is the one case where "the agent" stands alone. The case the old guard was
  // about — a count *and* a moved agent, so "the agent" has to be said beside the
  // count — cannot be driven through `report` from a fixture, and the reason is
  // structural rather than a gap in this file: `report` compares against the
  // capture this process imported (`PROFILES`), while the list it captures and
  // writes back is the `REQUIRED` literal in capture.mjs, so the two are the same
  // list by construction and `requiredChanged` is false for every run. The guard
  // `agentChanged && !requiredChanged` therefore decides exactly what
  // `agentChanged` decides, which makes re-injecting it a behaviour-equivalent
  // mutation of `report` that no fixture can catch — not a case this test is
  // failing to build. `changed` is the half that does vary, and the pair that
  // matters is pinned here instead, directly: a count with the agent dropped from
  // beside it is what "1 change(s) would change." is, a report that never names
  // the one thing whose move it cannot count.
  assert.deepEqual(
    drySummary({ changed: 3, agentChanged: true }),
    ["3 change(s)", "the agent"],
    "a count and a moved agent are two things and both are said",
  );
  assert.deepEqual(drySummary({ changed: 0, agentChanged: true }), ["the agent"]);
  assert.deepEqual(drySummary({ changed: 3, agentChanged: false }), ["3 change(s)"]);
  assert.deepEqual(drySummary({ changed: 0, agentChanged: false }), []);
});

test("a --dry run writes nothing", async () => {
  const scratch = scratchFingerprint();
  const before = JSON.stringify(scratch.read());
  const captureRun = offline(() =>
    report({
      request: requestFor(bodyFor(toolsOf(NAMES)), "opencode/1.99.0 ai-sdk/provider-utils/9.9.9 runtime/bun/9.9.9"),
      code: 0,
      fingerprint: scratch.path,
      dry: true,
    }),
  );
  try {
    await captureRun.run();
    assert.equal(captureRun.code, 1);
    assert.equal(JSON.stringify(scratch.read()), before, "--dry must not write");
  } finally {
    scratch.remove();
  }
});

test("an unchanged capture exits 0 and writes nothing", async () => {
  // Every tool the shipped profile carries, with the shipped wording, and the
  // shipped agent: there is nothing for the comparison to find. The exit path is
  // the point — 0 means the write below it is never reached.
  const names = Object.keys(SHIPPED.tools);
  const scratch = shippedWording();
  const before = JSON.stringify(scratch.read());
  const request = requestFor(bodyFor(names.map((name) => ({ type: "function", function: SHIPPED.tools[name] }))));
  const same = offline(() => report({ request, code: 0, fingerprint: scratch.path }));
  try {
    await same.run();
    assert.equal(same.code, 0, `nothing changed expected:\n  ${same.lines.join("\n  ")}`);
    assert.equal(
      same.lines.some((line) => line.includes("wrote")),
      false,
      "an unchanged capture must not write",
    );
    assert.equal(JSON.stringify(scratch.read()), before, "an unchanged capture must not write");
  } finally {
    scratch.remove();
  }
});

test("a changed capture writes the scratch fingerprint, and only there", async () => {
  // The one path that writes at all: a tool whose wording moved. It is the
  // repository's own fingerprint that must never be the target, which is why
  // `report` takes the path and this case hands it the scratch one.
  const scratch = scratchFingerprint();
  const wording = "A different wording for this tool, long enough to be read. ".repeat(4);
  const captureRun = offline(() =>
    report({
      request: requestFor(bodyFor(NAMES.map((name) => toolFor(name, { description: wording })))),
      code: 0,
      fingerprint: scratch.path,
    }),
  );
  try {
    await captureRun.run();
    assert.equal(
      captureRun.lines.some((line) => line.includes("wrote")),
      true,
      `the write must be reported:\n  ${captureRun.lines.join("\n  ")}`,
    );
    assert.equal(scratch.read().profiles["1.x"].tools.read.description, wording.slice(0, 1200), "the scratch file got the capture");
    // Nothing is left beside the target: the temporary the write went through is
    // the one a rename consumes, so an interrupted run can never be picked up by
    // the next one as a half-written capture.
    assert.equal(existsSync(`${scratch.path}.tmp`), false, "the write must not leave its temporary behind");
  } finally {
    scratch.remove();
  }
});

test("a write that cannot land leaves the target alone and cleans up after itself", async () => {
  // The write goes to `${fingerprint}.tmp` and is renamed over the target, so a
  // run that cannot write fails on a file nobody reads. This is what that looks
  // like: a directory sits where the temporary would go, so the write raises —
  // and the shipped capture is byte-for-byte what it was. Writing in place would
  // have opened the target itself, which is the truncation this pins against.
  const scratch = scratchFingerprint();
  const wording = "A different wording for this tool, long enough to be read. ".repeat(4);
  const before = readFileSync(scratch.path, "utf8");
  mkdirSync(`${scratch.path}.tmp`);
  const captureRun = offline(() =>
    report({
      request: requestFor(bodyFor(NAMES.map((name) => toolFor(name, { description: wording })))),
      code: 0,
      fingerprint: scratch.path,
    }),
  );
  let raised;
  let after;
  try {
    try {
      await captureRun.run();
    } catch (cause) {
      raised = cause;
    }
    // Read before the directory goes: what the target holds afterwards is the
    // whole point of this case.
    after = readFileSync(scratch.path, "utf8");
  } finally {
    scratch.remove();
  }
  assert.notEqual(raised, undefined, "a write that cannot be made must be raised, not swallowed");
  // The error has to be the one that says why the capture was not written. The
  // cleanup of the temp path runs on this same path and cannot succeed here — a
  // directory is what the write failed on — so `rmSync` raises ERR_FS_EISDIR,
  // and letting that replace the write's error is how this path used to report a
  // cleanup failure as the reason a capture was not written. Both codes come out
  // of the same EISDIR an unwritable directory produces; they are not the same
  // error, and only the first one names what has to be moved out of the way.
  assert.equal(raised?.code, "EISDIR", `the write's own error must arrive: ${raised?.message}`);
  assert.notEqual(raised?.code, "ERR_FS_EISDIR", "the cleanup's error must not be the one raised");
  assert.ok(
    raised?.message.includes(`${scratch.path}.tmp`),
    `the write error names the path it could not write: ${raised?.message}`,
  );
  // The cleanup did fail, and that is said rather than raised: a temp file left
  // behind is worth a line, and the next run reading it as its own capture is the
  // thing the line is about.
  assert.equal(
    captureRun.lines.some((line) => line.includes("could not remove") && line.includes(`${scratch.path}.tmp`)),
    true,
    `a cleanup that could not run has to be reported, not raised:\n  ${captureRun.lines.join("\n  ")}`,
  );
  assert.equal(after, before, "the target must be exactly what it was");
  assert.equal(
    captureRun.lines.some((line) => line.includes("wrote")),
    false,
    "a failed write must not be reported as a write",
  );
});

test("a failed write with nothing to clean up says nothing about cleanup", async () => {
  // The control for the case above: a temp path that is a stale regular file
  // instead of a directory. The removal succeeds, so the run must not report a
  // cleanup it did not fail — a line here would be a false one.
  const scratch = scratchFingerprint();
  const wording = "A different wording for this tool, long enough to be read. ".repeat(4);
  writeFileSync(`${scratch.path}.tmp`, "a half-written capture from a run that was interrupted");
  const captureRun = offline(() =>
    report({
      request: requestFor(bodyFor(NAMES.map((name) => toolFor(name, { description: wording })))),
      code: 0,
      fingerprint: scratch.path,
    }),
  );
  let raised;
  let stored;
  try {
    try {
      await captureRun.run();
    } catch (cause) {
      raised = cause;
    }
    assert.equal(
      captureRun.lines.some((line) => line.includes("could not remove")),
      false,
      `nothing failed to be removed here:\n  ${captureRun.lines.join("\n  ")}`,
    );
    // A stale temp file is not what stops a write: it is overwritten. The case
    // above is the one where the write cannot land, and the two must not read
    // alike.
    assert.equal(raised, undefined, `a stale temp file does not stop the write: ${raised?.message}`);
    stored = scratch.read().profiles["1.x"].tools.read.description;
  } finally {
    scratch.remove();
  }
  assert.equal(stored, wording.slice(0, 1200), "the capture landed over the stale temporary");
});

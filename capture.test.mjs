import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capture, fingerprintTarget, invokedDirectly, report } from "./capture.mjs";

// The capture itself may not be run here: a real run starts a server and writes
// a fingerprint. So the two halves either side of that run are driven directly —
// `capture` with a child the test ends by hand, and `report` with a request the
// test builds and a **scratch** fingerprint. Nothing here reads or writes the one
// this repository ships: `report` takes the path it works on, and every fixture
// below is a file in a temporary directory.

// The shipped capture, read from the repository. `report` compares a run against
// this, so a case that wants a particular comparison asks for it through the
// request; the fixture is only ever the file the result would be written to.
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
function offline(body) {
  const exit = process.exit;
  const log = console.log;
  const error = console.error;
  const lines = [];
  let code;
  process.exit = (value) => {
    code = value;
    throw new Error(`process.exit(${value})`);
  };
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  return {
    lines,
    get code() {
      return code;
    },
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

test("the guard that keeps an import from running the capture", () => {
  // This process imported the file rather than running it, which is what this
  // guard is for. Before it, importing capture.mjs started a server and rewrote
  // the shipped fingerprint — so the file could not be tested at all.
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
  // handler that takes the child down with the interrupt. Emitted rather than
  // delivered — `process.emit` runs the listeners this module installed and
  // signals nothing — and it is a `once`, so it is off again before the next
  // case runs.
  const run = fakeChild();
  const pending = capture("probe", run.spawn);
  process.emit("SIGINT");
  const { code, ran } = await pending;
  assert.equal(ran, false, "an interrupted run is a failed run");
  assert.equal(code, 1, "and its code is non-zero");
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

test("the signal handlers are dropped once the child is gone", async () => {
  // A `process.once` that has not fired stays armed, and settling an already
  // settled promise is a no-op: a Ctrl-C during the write phase would be
  // swallowed rather than end the script.
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const run = fakeChild();
  const pending = capture("probe", run.spawn);
  run.emit("exit", 0, null);
  assert.deepEqual(await pending, { code: 0, ran: true });
  assert.deepEqual(
    [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
    before,
    "the exit path must not leave the handlers armed",
  );
});

test("a required name that arrived without a description is not a name this OpenCode stopped sending", async () => {
  // `tools` only holds names that arrived with a non-empty description, so
  // reading `missing` off it reported a tool that *was* sent as one this
  // OpenCode no longer sends. `read` has a description here and is captured;
  // `grep` is sent with none, which is the case the fix is about.
  const scratch = scratchFingerprint();
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
  } finally {
    scratch.remove();
  }
  // It did not exit at the missing check: the capture got past it, and what it
  // then made of the wording is not what this pins.
  assert.equal(
    captureRun.lines.some((line) => line.includes("no longer sends")),
    false,
    `a tool that was sent must not be reported as one this OpenCode stopped sending:\n  ${captureRun.lines.join("\n  ")}`,
  );
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
  // The ternary that built this summary was dead, and the guard on the line
  // above it dropped "the agent" whenever the required list had also changed: a
  // run where both moved reported the change count alone. The stored required
  // list carries two names this request does not, so the list moved too.
  const scratch = scratchFingerprint({ required: [...SHIPPED.required, "write", "edit"] });
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
  } finally {
    scratch.remove();
  }
  assert.equal(captureRun.code, 1, "a change under --dry exits non-zero");
  const summary = captureRun.lines.filter((line) => line.includes("would change"));
  assert.equal(summary.length, 1, `one summary line expected:\n  ${captureRun.lines.join("\n  ")}`);
  assert.match(summary[0], /change\(s\) and the agent would change\. Nothing written \(--dry\)\./);
  assert.equal(
    captureRun.lines.some((line) => line.includes("wrote")),
    false,
    "--dry must not say it wrote",
  );
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
  const scratch = scratchFingerprint({ names });
  const stored = scratch.read();
  stored.profiles["1.x"].tools = Object.fromEntries(names.map((name) => [name, SHIPPED.tools[name]]));
  writeFileSync(scratch.path, JSON.stringify(stored, null, 2));
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
  } finally {
    scratch.remove();
  }
});

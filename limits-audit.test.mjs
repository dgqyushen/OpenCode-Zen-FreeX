import assert from "node:assert/strict";
import test from "node:test";

const subject = import("./limits-audit.mjs").catch((error) => {
  assert.fail(`limits-audit.mjs failed to load: ${error?.message ?? error}`);
});

// A lookup that lands on nothing must say which id had no line rather than fail
// inside assert.match with "undefined is not an argument of type string".
function lineFor(lines, id) {
  const line = lines.find((candidate) => candidate.startsWith(id));
  assert.notEqual(line, undefined, `no finding line for ${id} in:\n  ${lines.join("\n  ")}`);
  return line;
}

const catalog = {
  "deepseek-v4.1-flash-free": {
    cost: { input: 0, output: 0 },
    limit: { context: 200000, output: 32000 },
  },
  "mimo-v2.6-flash-free": { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } },
  "big-pickle": { cost: { input: 0, output: 0 }, limit: { context: 200000, input: 160000, output: 32000 } },
  paid: { cost: { input: 3, output: 10 }, limit: { context: 1000000, output: 384000 } },
};

test("the audit asks about the ids the listing offers, not every id the catalogue calls free", async () => {
  const { offeredIds } = await subject;
  assert.equal(typeof offeredIds, "function", "the audit must be implemented");
  // `brand-new-free` is in no catalogue and is still offered, because its id says
  // so; `not-in-the-catalogue` is offered by nobody including itself; and an id
  // the snapshot calls SystemOne is not offered, whatever its name says. The
  // snapshot is handed in so this case says what it knows instead of riding on
  // what the shipped one happens to classify these ids as.
  assert.deepEqual(
    offeredIds(
      [
        "deepseek-v4.1-flash-free",
        "paid",
        "not-in-the-catalogue",
        "big-pickle",
        "brand-new-free",
        "jev-1.13-free",
      ],
      catalog,
      { "jev-1.13-free": "systemone" },
    ),
    ["deepseek-v4.1-flash-free", "big-pickle", "brand-new-free"],
  );
  // the deepEqual above pins the listing's order, which is the order the table
  // prints in, so the guarantee is stated here rather than left implicit
  assert.deepEqual(offeredIds(["b-free", "a-free"], {}, {}), ["b-free", "a-free"]);
  // a snapshot can be handed in, so a test says what it knows without depending
  // on what the shipped one happens to carry
  assert.deepEqual(offeredIds(["x-free"], {}, { "x-free": "systemone" }), []);
  assert.deepEqual(offeredIds(["x-free"], {}, { "x-free": "chat" }), ["x-free"]);
  // a listing entry the catalogue marks retired is not offered by the plugin
  // either, so auditing it would report a model nobody can pick
  for (const model of [
    { status: "deprecated", cost: { input: 0, output: 0 } },
    { retirement_date: "2026-10-01", cost: { input: 0, output: 0 } },
  ]) {
    assert.deepEqual(offeredIds(["dead-free"], { "dead-free": model }), [], JSON.stringify(model));
  }
});

test("ids are grouped by the upstream model the route names, and one that names none is left out", async () => {
  const { groupByUpstream } = await subject;
  const groups = groupByUpstream([
    { id: "a", upstream: "mimo-v2.6-flash" },
    { id: "b", upstream: "mimo-v2.6-flash" },
    { id: "c", upstream: undefined },
  ]);
  assert.deepEqual([...groups.keys()], ["mimo-v2.6-flash"]);
  assert.deepEqual(
    groups.get("mimo-v2.6-flash").map((row) => row.id),
    ["a", "b"],
  );
});

test("a ceiling the route names is a candidate, and one it agrees with is not", async () => {
  const { findings } = await subject;
  const lines = findings([
    { id: "big-pickle", declared: { context: 200000, output: 32000 }, status: 200, ceiling: 131072 },
    {
      id: "mimo-v2.6-flash-free",
      declared: { context: 1048576, output: 131072 },
      status: 200,
      ceiling: 131072,
    },
    {
      id: "fledge-alpha-free",
      declared: { context: 1048576, output: 131072 },
      status: 410,
      says: "Model fledge-alpha-free has been deprecated.",
    },
  ]);
  const pickle = lines.filter((line) => line.startsWith("big-pickle:"));
  assert.equal(pickle.length, 1);
  assert.match(pickle[0], /names a ceiling of 131072 .*declares 32000/);
  assert.equal(lines.filter((line) => line.startsWith("mimo-v2.6-flash-free:")).length, 0);
  assert.match(
    lineFor(lines, "fledge-alpha-free"),
    /HTTP 410 — Model fledge-alpha-free has been deprecated\./,
  );
});

test("a 400 the audit provoked is not a candidate, and the ones it cannot explain are", async () => {
  const { findings, protocolScoped } = await subject;
  const rows = [
    // asked for too much on purpose and told the window, which the catalogue agrees with
    { id: "provoked-free", declared: { context: 1000000, output: 65536 }, status: 400, window: 1000000, says: "" },
    { id: "silent-free", declared: { context: 262144, output: 32000 }, status: 400, says: "invalid request" },
    { id: "dead-free", declared: { context: 262144, output: 32000 }, status: 410, says: "Model has been deprecated." },
    {
      id: "wrong-shape-free",
      declared: { context: 1048576, output: 131072 },
      status: 400,
      says: "Model does not support this protocol.",
    },
    // the word "format" is not a protocol: a request refused for its format was
    // asked and refused, and must not vanish from the candidates
    { id: "bad-format-free", declared: { context: 262144, output: 32000 }, status: 400, says: "invalid request format" },
  ];
  const lines = findings(rows);
  assert.equal(lines.filter((line) => line.startsWith("provoked-free")).length, 0);
  assert.match(lineFor(lines, "silent-free"), /HTTP 400 — invalid request/);
  assert.match(lineFor(lines, "dead-free"), /HTTP 410 — Model has been deprecated\./);
  // a model that speaks another protocol is said once, beside the ids that were
  // not asked, and never sits in this list as a finding
  assert.equal(lines.filter((line) => line.startsWith("wrong-shape-free")).length, 0);
  assert.equal(protocolScoped(rows.at(-2)), true);
  assert.match(lineFor(lines, "bad-format-free"), /HTTP 400 — invalid request format/);
  // the heuristic has to answer no for a row that names no other shape, or every
  // HTTP error would be suppressed by it
  assert.equal(protocolScoped(rows.at(-1)), false);
  assert.equal(protocolScoped({ says: "" }), false);
  assert.equal(protocolScoped({ says: "max_tokens is too large: 200000." }), false);
  // a status 0 is a question that was never answered, and being unable to ask is
  // not a finding about limits: only the table says what happened to that id
  assert.deepEqual(findings([{ id: "timeout-free", declared: {}, status: 0, says: "aborted due to timeout" }]), []);
});

test("one upstream model declared twice, unlike, makes the smaller declaration the candidate", async () => {
  const { findings } = await subject;
  const rows = [
    { id: "big-pickle", declared: { context: 200000, output: 32000 }, status: 200, upstream: "mimo-v2.6-flash" },
    {
      id: "mimo-v2.6-flash-free",
      declared: { context: 1048576, output: 131072 },
      status: 200,
      upstream: "mimo-v2.6-flash",
    },
  ];
  const lines = findings(rows);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^big-pickle: declared 200000\/32000, and mimo-v2\.6-flash is also served as mimo-v2\.6-flash-free \(1048576\/131072\)$/,
  );
  // an id limits.mjs already carries evidence for is said once, not raised again
  assert.deepEqual(findings(rows, new Set(["big-pickle"])), []);
});

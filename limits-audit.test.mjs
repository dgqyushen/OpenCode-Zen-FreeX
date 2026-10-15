import assert from "node:assert/strict";
import test from "node:test";

const subject = import("./limits-audit.mjs").catch(() => ({}));

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
  assert.deepEqual(
    offeredIds(["deepseek-v4.1-flash-free", "paid", "not-in-the-catalogue", "big-pickle"], catalog),
    ["deepseek-v4.1-flash-free", "big-pickle"],
  );
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
    lines.find((line) => line.startsWith("fledge")),
    /HTTP 410 — Model fledge-alpha-free has been deprecated\./,
  );
});

test("a 400 the audit provoked is not a candidate, and the ones it cannot explain are", async () => {
  const { findings } = await subject;
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
  ];
  const lines = findings(rows);
  assert.equal(lines.filter((line) => line.startsWith("provoked-free")).length, 0);
  assert.match(lines.find((line) => line.startsWith("silent-free")), /HTTP 400 — invalid request/);
  assert.match(lines.find((line) => line.startsWith("dead-free")), /HTTP 410 — Model has been deprecated\./);
  assert.match(lines.find((line) => line.startsWith("wrong-shape-free")), /does not speak the chat shape/);
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

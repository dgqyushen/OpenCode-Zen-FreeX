// The scheduled survey's decisions, checked without a route and without a file.
//
// `limits-watch.mjs` exists to answer one question on a timer: which offered ids
// have never been measured, and which have stopped being offered. Both answers
// come from comparing two lists, so the route and the snapshot are handed in here
// rather than reached for — a case that had to ask Zen to find out whether it had
// found the right ids would be testing Zen.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const subject = import("./limits-watch.mjs").catch((error) => {
  assert.fail(`limits-watch.mjs failed to load: ${error?.message ?? error}`);
});

// A route that offers what a case names, and a catalogue that calls them free.
const route = (ids) => async (url) =>
  url.endsWith("/models")
    ? { data: ids.map((id) => ({ id })) }
    : { opencode: { models: Object.fromEntries(ids.map((id) => [id, { name: id }])) } };

const measured = (ids) => ({ models: Object.fromEntries(ids.map((id) => [id, { wall: "openEnded" }])) });

test("an id offered and never measured is the one a run measures", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: route(["known-free", "fresh-free"]),
    read: async () => measured(["known-free"]),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return ids.map((id) => ({ model: id, servedTokens: 1, servedChars: 1000, refusedChars: null, refusedSizes: [], wall: "openEnded" }));
    },
  });
  assert.deepEqual(state.added, ["fresh-free"]);
  assert.deepEqual(state.measured, ["known-free"]);
  assert.deepEqual(swept, ["fresh-free"], "the id with a measurement behind it is not asked again");
  assert.equal(state.snapshot.models["fresh-free"].wall, "openEnded", "and the result is kept");
  assert.equal(state.snapshot.models["known-free"].wall, "openEnded", "beside what was already there");
});

test("without --sweep a run plans and asks nothing", async () => {
  const { watch } = await subject;
  let swept = false;
  const state = await watch({
    fetchJSON: route(["fresh-free"]),
    read: async () => measured([]),
    sweepModels: async () => {
      swept = true;
      return [];
    },
  });
  assert.deepEqual(state.added, ["fresh-free"]);
  assert.equal(swept, false, "a report is not a measurement");
  assert.deepEqual(state.snapshot.models, {}, "and it moves nothing");
});

test("--all re-measures what is already measured", async () => {
  const { watch } = await subject;
  const swept = [];
  await watch({
    sweep: true,
    all: true,
    fetchJSON: route(["a-free", "b-free"]),
    read: async () => measured(["a-free"]),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(swept, ["a-free", "b-free"], "every offered id, measured or not");
});

test("an id that is no longer offered is said, and kept out of the way", async () => {
  const { watch } = await subject;
  const state = await watch({ fetchJSON: route(["a-free"]), read: async () => measured(["a-free", "gone-free"]) });
  assert.deepEqual(state.gone, ["gone-free"]);
  assert.deepEqual(state.offered, ["a-free"]);
  // The snapshot keeps it: an id the route stops offering today can be offered
  // again, and forgetting the measurement would make that cost a second sweep.
  assert.ok(Object.hasOwn(state.snapshot.models, "gone-free"));
});

test("a snapshot is written sorted, and read back whole", async () => {
  const { readSnapshot, writeSnapshot } = await subject;
  const file = join(tmpdir(), `zen-observed-${process.pid}-${Date.now()}.json`);
  try {
    const body = await writeSnapshot({ models: { "z-free": { wall: "openEnded" }, "a-free": { wall: "openEnded" } } }, file);
    assert.ok(existsSync(file));
    assert.ok(body.indexOf("a-free") < body.indexOf("z-free"), "sorted, so a diff is the ids that changed");
    const read = await readSnapshot(file);
    assert.deepEqual(Object.keys(read.models), ["a-free", "z-free"]);
  } finally {
    rmSync(file, { force: true });
  }
});

test("a snapshot that is missing, or is not one, is no snapshot", async () => {
  const { readSnapshot } = await subject;
  const missing = join(tmpdir(), `zen-observed-${process.pid}-missing-${Date.now()}.json`);
  assert.deepEqual(await readSnapshot(missing), { models: {} }, "a first run has nothing to compare against");
  // A file somebody edited into a list, or into a shape with no models in it, is
  // read as no measurement rather than as a measurement of nothing — the
  // difference decides whether every offered id gets swept or none does.
  const file = join(tmpdir(), `zen-observed-${process.pid}-junk-${Date.now()}.json`);
  try {
    for (const body of ["[]", '{"models":[]}', '{"models":null}', "not json at all"]) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, body, "utf8");
      assert.deepEqual(await readSnapshot(file), { models: {} }, body);
    }
  } finally {
    rmSync(file, { force: true });
  }
});

// The second thing a timer has to notice, and the one it used to miss for ever:
// an id whose wall was never found. `openEnded` means the top rung was SERVED, so
// the run has no bracket — and for a 1,048,576-token id under a ladder that
// stopped at 4,200,000 characters, that was true while the snapshot said 898,459
// against a wall of 1,048,092. Such a model is measured again on the timer, but
// only while the catalogue still declares more than the snapshot ever served.
const catalogued = (ids, declared) => async (url) =>
  url.endsWith("/models")
    ? { data: ids.map((id) => ({ id })) }
    : {
        opencode: {
          models: Object.fromEntries(ids.map((id) => [id, { name: id, limit: { context: declared[id] } }])),
        },
      };

const measuredWith = (entries) => async () => ({
  models: Object.fromEntries(
    Object.entries(entries).map(([id, v]) => [id, { wall: "openEnded", ...v }]),
  ),
});

test("an open-ended id the catalogue declares more for is measured again", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: catalogued(["small-free"], { "small-free": 262_144 }),
    read: measuredWith({ "small-free": { servedTokens: 100_000 } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.suspicion, ["small-free"]);
  assert.deepEqual(swept, ["small-free"], "100,000 against a declared 262,144 is a wall never found");
});

test("an id already served to its declaration is not asked again", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: catalogued(["served-free"], { "served-free": 262_144 }),
    read: measuredWith({ "served-free": { servedTokens: 250_000 } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.suspicion, []);
  assert.deepEqual(swept, [], "within a tenth of the declaration is a host counting differently");
});

test("a bracketed wall is already known, so it is not suspected", async () => {
  const { watch } = await subject;
  const swept = [];
  await watch({
    sweep: true,
    fetchJSON: catalogued(["walled-free"], { "walled-free": 262_144 }),
    read: measuredWith({ "walled-free": { servedTokens: 100_000, wall: "bracketed" } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(swept, [], "a wall this run already has is not a wall to look for again");
});

// The rule that decides what is measured at all: an id the catalogue declares
// at a million or more is answered from models.dev — the largest entry any
// provider declares for the same canonical model — and is not measured. Only an
// id the catalogue declares BELOW a million is measured, because only there can
// a measurement change the answer.
//
// The run of 2026-10-20 asked `minimax-m3.1-flash-free` and `beam-free` and
// `nemotron-3.5-super-vl-free` — ids whose value models.dev already answers —
// and spent eleven megabytes of prompts and half an hour of runner time to
// learn the 1,048,576 the catalogue already said.
test("an id the catalogue declares at a million is not measured", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    all: true,
    fetchJSON: catalogued(["big-free", "small-free"], { "big-free": 1_000_000, "small-free": 262_144 }),
    read: measuredWith({ "big-free": { servedTokens: 898_459 } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.answeredElsewhere, ["big-free"], "the catalogue declares it at a million");
  assert.deepEqual(swept, ["small-free"], "so only the one below the line is measured");
});

test("the open-ended state does not bring a million-token id back into measurement", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: catalogued(["big-free"], { "big-free": 1_048_576 }),
    read: measuredWith({ "big-free": { servedTokens: 898_459 } }),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.suspicion, [], "an open-ended id is not a candidate while models.dev answers it");
  assert.deepEqual(swept, [], "and it is not asked about");
});

// A row for an id that is answered from models.dev is a row about a window
// nobody asked about, and it is the row that makes the next run think the
// model is still a candidate — `openEnded` is what the suspicion rule reads.
test("a row for an id models.dev answers is dropped from the snapshot", async () => {
  const { watch } = await subject;
  const state = await watch({
    sweep: false,
    fetchJSON: catalogued(["big-free", "small-free"], { "big-free": 1_000_000, "small-free": 262_144 }),
    read: measuredWith({ "big-free": { servedTokens: 898_459 }, "small-free": { servedTokens: 215_041 } }),
    sweepModels: async () => [],
  });
  assert.deepEqual(Object.keys(state.snapshot.models), ["small-free"], "only what the sweep measured is kept");
});

// The rule holds for an id the catalogue does not declare a window for: there is
// no declaration to be large, so there is nothing for models.dev to correct,
// and it is measured.
test("an id the catalogue does not declare a window for is measured", async () => {
  const { watch } = await subject;
  const swept = [];
  const state = await watch({
    sweep: true,
    fetchJSON: catalogued(["undeclared-free"], { "undeclared-free": undefined }),
    read: measuredWith({}),
    sweepModels: async (ids) => {
      swept.push(...ids);
      return [];
    },
  });
  assert.deepEqual(state.answeredElsewhere, []);
  assert.deepEqual(swept, ["undeclared-free"]);
});

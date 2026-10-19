// What the free tier is offering now, against what was last measured, and what
// to do about the difference.
//
//   bun limits-watch.mjs            report the diff and the plan, ask nothing
//   bun limits-watch.mjs --sweep    also measure every id that needs it
//   bun limits-watch.mjs --write    fold what was measured into the snapshot
//
// This is the scheduled half of the survey `limits-sweep.mjs` performs. The
// sweep answers "how big is this model's prompt wall"; this answers the questions
// a calendar can ask: is anything being offered that nobody has measured, has
// anything that was measured stopped being offered, and is any id's declared
// window no longer what the route states about it.
//
// What is automated here, and what is not. Setting `--write` writes
// `limits-observed.json`, the record of what the last run measured. It does not
// write `limits.mjs`, because the table is what every host behind this plugin
// plans a conversation from, and a number that a scheduled job committed without
// anyone reading it is a number nobody has ever checked. The workflow opens a
// pull request with the measurement in its body; a person decides what the table
// says.
//
// The snapshot is also what keeps the cost bounded. Without it, every run would
// have to re-measure everything to know what changed, which is nine models and
// up to six megabyte-sized requests each. With it, a run measures the ids that
// are new or gone, and nothing else.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./provider.mjs";
import { baseFrom, offeredIds } from "./limits-audit.mjs";
import { sweepModels as sweepThem } from "./limits-sweep.mjs";

const BASE = baseFrom(process.env.ZEN_BASE_URL);
const SNAPSHOT = fileURLToPath(new URL("./limits-observed.json", import.meta.url));

async function getJSON(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

// The snapshot as it stands. A missing or unreadable file is no snapshot rather
// than a failure: the first run has nothing to compare against, and every id it
// sees is new, which is exactly what it should say.
export async function readSnapshot(file = SNAPSHOT) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const models = parsed?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return { models: {} };
    return { models };
  } catch {
    return { models: {} };
  }
}

// What a sweep result is worth keeping. `asked` and `spent` are dropped: they are
// the receipt for one run's budget, and a snapshot that grew by every request ever
// made would stop being a thing a person can read.
const kept = ({ servedTokens, servedChars, refusedChars, refusedSizes, wall }) => ({
  servedTokens,
  servedChars,
  refusedChars,
  refusedSizes,
  wall,
});

// The run. Everything it decides is returned rather than printed, so the same
// answers can be a console report, a pull request body or a test.
export async function watch({
  sweep = false,
  all = false,
  log = () => {},
  at = new Date().toISOString().slice(0, 10),
  // Injected rather than reached for, so a case can drive this without a route and
  // without a file: what is being tested is which ids it decides to measure, and
  // that is a question about two lists.
  fetchJSON = getJSON,
  read = readSnapshot,
  sweepModels = sweepThem,
} = {}) {
  const [listing, catalog] = await Promise.all([fetchJSON(`${BASE}/models`), fetchJSON(CATALOG)]);
  const models = catalog?.opencode?.models ?? {};
  const offered = offeredIds(
    (Array.isArray(listing?.data) ? listing.data : []).map((entry) => entry?.id).filter(Boolean),
    models,
  );
  const snapshot = await read();
  const measured = snapshot.models ?? {};
  const added = offered.filter((id) => !Object.hasOwn(measured, id));
  const keptOver = offered.filter((id) => Object.hasOwn(measured, id));
  const gone = Object.keys(measured).filter((id) => !offered.includes(id));
  // An id that is offered and has no snapshot entry is the one thing a scheduled
  // run has to measure: nothing else here knows whether a model it has never seen
  // has a wall, and a wall nobody measured is a window every host gets wrong.
  // `--all` re-measures everything, which is what a person asking for a fresh
  // reading of a model whose wall has moved wants, and what nobody wants to pay
  // for on a timer.
  const targets = sweep ? (all ? offered : added) : [];
  log(`${BASE}`);
  log(`${offered.length} free ids offered, ${keptOver.length} measured before, ${added.length} not`);
  if (added.length > 0) log(`  new: ${added.join(", ")}`);
  if (gone.length > 0) log(`  no longer offered: ${gone.join(", ")}`);
  if (all && sweep) log(`  --all: re-measuring all ${offered.length}`);
  const results = targets.length > 0 ? await sweepModels(targets, log) : [];
  const next = { ...measured };
  for (const result of results) next[result.model] = { ...kept(result), at };
  return { base: BASE, offered, added, gone, measured: keptOver, results, snapshot: { models: next } };
}

export async function writeSnapshot(state, file = SNAPSHOT) {
  // Sorted, so a diff is the ids that changed and not the order the route
  // happened to list them in.
  const models = Object.fromEntries(Object.entries(state.models ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body = `${JSON.stringify({ version: 1, models }, null, 2)}\n`;
  await writeFile(file, body, "utf8");
  return body;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const state = await watch({
    sweep: args.includes("--sweep"),
    all: args.includes("--all"),
    log: (line) => console.log(line),
  });
  for (const result of state.results) {
    console.log("");
    console.log(`  ${result.model} — ${result.wall}, ${result.spent} requests`);
    console.log(`    served   ${result.servedTokens ?? "-"} tokens at ${result.servedChars ?? "-"} characters`);
    console.log(`    refused  ${result.refusedChars ?? "-"} characters`);
    for (const said of result.says) console.log(`    said     ${said.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  if (args.includes("--write")) {
    await writeSnapshot(state.snapshot);
    console.log(`\nwrote ${Object.keys(state.snapshot.models).length} ids to limits-observed.json`);
  } else console.log("\nnothing written; --write folds what was measured into the snapshot");
  // A run that reached the route has answered its question even when it found
  // nothing to do. One that could not reach it has not, and the workflow has to
  // be able to tell those apart.
  process.exit(state.offered.length > 0 ? 0 : 1);
}

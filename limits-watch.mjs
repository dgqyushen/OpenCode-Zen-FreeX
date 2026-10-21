// What the free tier is offering now, against what was last measured, and what
// to do about the difference.
//
//   bun limits-watch.mjs            report the diff and the plan, ask nothing
//   bun limits-watch.mjs --sweep    also measure every id that needs it
//   bun limits-watch.mjs --write    fold what was measured into the snapshot
//   bun limits-watch.mjs --check    say whether a snapshot is one the plugin can read
//   bun limits-watch.mjs --status   report the snapshot's freshness and health, ask nothing
//
// Exit codes, which are how the workflow tells the three answers apart:
//   0  the route was reached and offered at least one free id
//   1  the route, the catalogue or the snapshot could not be read or written
//   2  the route was reached and offered no free id at all
//
// 1 is "could not ask" and 2 is "asked, and the answer was nothing": an empty
// listing is not an outage, so 2 may be reported as reached with nothing to
// publish rather than as a dead route. `--check` keeps its own 0/1 — it asks
// nothing, so "not reached" is not one of its answers.
//
// `--status` is the third read-only mode, and its codes are its own because the
// question is different: 0 when the snapshot is readable, valid and fresh, 1
// when it cannot be read at all (missing, unreadable, not JSON), and 2 when it
// was read and is degraded (invalid, stale, empty, or a measurement says a model
// is unavailable). It stats the file, never asks the network and never writes;
// `--json` makes the report one machine-readable line.
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
//
// The one rule that asks about an id that was measured before is the one that
// suspects a wall was never found, and it is bounded twice: by the age of the
// row, so a wall that has not moved is not paid for again every hour, and by
// the catalogue, so an id models.dev answers is not asked about at all.

import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./provider.mjs";
import { baseFrom, entryVerdict, namesNoScript, offeredIds } from "./limits-audit.mjs";
import { learnedAbout, sweepModels as sweepThem } from "./limits-sweep.mjs";
import { MODELS_DEV_MIN } from "./limits.mjs";

// The base is parsed when a run asks for it, not while this module is
// evaluated. `--check` and `--status` ask nothing, and a malformed
// `ZEN_BASE_URL` used to throw on the `const BASE = ...` line before the entry
// point's own try/catch — a snapshot that was perfectly readable could not be
// checked because a variable the check never uses was wrong.
function baseURL() {
  return baseFrom(process.env.ZEN_BASE_URL);
}

const SNAPSHOT = fileURLToPath(new URL("./limits-observed.json", import.meta.url));
// The version of the snapshot this file writes, and the only one it reads. A
// file carrying another one was written by a rule this file does not know, and
// a row under it is not a measurement this file may compare against.
const SNAPSHOT_VERSION = 1;
// A day in milliseconds, which is the unit the age of a row is counted in.
const DAY = 86400000;

// The catalogue's own URL, which an operator may point at a mirror or at a
// fixture. The same variable `limits-audit.mjs` and `limits-sweep.mjs` read, so
// a deployment that named one does not get the production catalogue here — and
// with it the production declaration behind the decision of what to measure,
// which is the decision this file exists to make. It was read out of
// provider.mjs's own constant, which no deployment can name at all, so the two
// siblings and this file could be pointed at different catalogues at once.
//
// Exported for the reason `baseFrom` is: a constant would only show the answer
// for one spelling of the environment.
export function catalogUrl(env = process.env) {
  return env.ZEN_CATALOG_URL ?? CATALOG;
}

const CATALOG_URL = catalogUrl();

// The units of the numbers a row carries, written beside the rows.
//
// A row counts the same window twice, in two units: `named` is a number of
// TOKENS — the route's own statement of its window — while `servedChars`,
// `refusedChars` and `refusedSizes` are numbers of CHARACTERS, which is what
// the sweep asks with. The same 1M window therefore appears in one row as
// 1,000,000 and as about 4,000,000, and a reader who takes one for the other
// is wrong by a factor of four.
//
// The names cannot change — `limits.mjs` and `limits-sweep.mjs` read this file
// — so the units are stated here instead of in the names. It is a key of its
// own and not a model: `models` holds the measurements and nothing else, so a
// reader that walks it never meets this, and a reader that wants the units
// reads them from here rather than from the shape of a name. A snapshot
// written before this key existed is read exactly as before, because the key is
// only ever written and never required.
const UNITS = {
  servedTokens: "tokens",
  servedChars: "characters",
  refusedChars: "characters",
  refusedSizes: "characters",
  named: "tokens",
  at: "date, YYYY-MM-DD",
  // The day the sweep last heard the route call the model gone. Optional like
  // the row field itself, but a file that carries it has to say what it is: a
  // date read as a number is a measurement nobody can read.
  unavailable: "date, YYYY-MM-DD",
};

// What the file has to say its numbers are, for the check below to accept.
//
// Written out here rather than read from the file, because a check that reads
// the file's own declaration of what its numbers mean checks that the file
// agrees with itself, which is not the same as checking that it is right. The
// two lists are held together by a test — a snapshot this file wrote has to
// pass this check — so a change to one of them without the other is a red
// suite rather than a file nobody can read.
const EXPECTED_UNITS = {
  servedTokens: "tokens",
  servedChars: "characters",
  refusedChars: "characters",
  refusedSizes: "characters",
  named: "tokens",
  at: "date, YYYY-MM-DD",
};
// A unit for a field the file may carry but does not have to: `unavailable` is
// written only when the sweep has seen a model gone, and a snapshot made before
// the field existed must still be readable by this version. It is checked when
// the file names it, and a file that carries the row field without the unit is
// not made to fail for a field the previous version could not write.
const OPTIONAL_UNITS = {
  unavailable: "date, YYYY-MM-DD",
};

// The walls a row may say, which are the sweep's own labels: `limits-sweep.mjs`
// calls a wall "bracketed" when two refused sizes sit behind a served one,
// "single-refusal" when one does, "openEnded" when none does, and "named" when
// the route stated its window in its own words.
//
// These are the labels `limits.mjs` reads the other side of: a "bracketed" or a
// "named" wall settles an axis, and every other label is a floor. A row that
// says another label is a row nothing can be read out of.
const WALLS = ["bracketed", "single-refusal", "openEnded", "named"];

// The bounds a measurement has to sit inside to be one this file may publish.
//
// `--check` is the gate on an unattended merge, and until these existed it asked
// only that a number be a positive safe integer: a `servedTokens` of
// 9,000,000,000 passed the shape check and was merged into main, where
// `limits.mjs` reads it as a window and publishes it to every host. The bounds
// are deliberately generous — the largest window this route is known to serve is
// 1,048,576 tokens, and the character ladder that measures it stops around 4.2
// million characters — so they exist to catch a unit error or a runaway probe,
// not to second-guess a measurement.
const MAX_SERVED_TOKENS = 4_000_000;
const MAX_MEASURED_CHARS = 32_000_000;
// A token is at least one character for every script this route takes, so a row
// whose token count is more than twice its character count is a row about two
// different things. The slack is the message envelope: a `usage.prompt_tokens`
// count covers the body a character count may not. This is the cross-unit bound
// the shape check lacked, and it is what a servedTokens/servedChars row from two
// runs fails.
const MAX_TOKENS_PER_CHAR = 2;
const TOKEN_CHAR_SLACK = 4096;

// How old a row has to be before the suspicion rule may ask about it again.
//
// The rule has no other bound, and a row whose wall was never found is asked
// about on every scheduled tick — up to fourteen requests and several megabytes
// of prompt each — so without a bound the same question is paid for every hour
// for ever, which is the cost the snapshot exists to keep away.
//
// A week, because what the answer depends on does not change hourly. The
// ladder is the same on every run, so a wall that has not moved is answered the
// same way every hour; what can change is the catalogue's number and the
// route's own build, and neither of those is an hourly event. A week is long
// enough for either to have happened and short enough that a wall which moved
// is still noticed inside the same month.
export const SUSPECT_AFTER_DAYS = 7;

// How old the snapshot file itself may be before `--status` calls it stale, in
// seconds. Two hours: the scheduled run is hourly and a snapshot that missed one
// tick is worth saying out loud, while a run that is a few minutes late (a busy
// runner, a retried job) is not. `--stale-after <seconds>` overrides it.
//
// Exported so a test and a workflow read the same default rather than each
// pinning its own copy of the number.
export const STATUS_STALE_AFTER_SECONDS = 7200;

// How recently a row's `unavailable` day has to have been written for `--status`
// to report the model as unavailable. The field is a day the route was last seen
// refusing the model as gone; an old day is history rather than a current
// outage, and treating it as current forever would make a single bad hour
// permanent. A week, the same bound the suspicion rule uses for a measurement:
// the two answers are about the same kind of staleness.
const UNAVAILABLE_RECENT_DAYS = SUSPECT_AFTER_DAYS;

// How old a row is, in whole days, from the last day it was asked about to the
// day of this run. Both are the run's own dates — the row carries the day it was
// written and the run carries the day it is writing — so the age is a whole
// number of days rather than "some time yesterday", and a test can drive it.
//
// There are two such days on a row. `at` is the day the measurement was taken,
// and `tried` is the day the id was last asked about when the attempt learned
// nothing new. The later of the two is the one the age is counted from: a row
// whose sweep came back empty is still a row with a measurement in it, and
// without `tried` the seven-day bound would read `at` and the id would be swept
// again on every hourly tick — up to fourteen requests and several megabytes of
// prompt each — for a question whose answer has not changed.
//
// A row with neither day has no age: the answer is undefined rather than zero,
// because a row nobody dated is not a row measured today.
function dayNumber(value) {
  if (typeof value !== "string") return undefined;
  const day = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(day) ? undefined : day;
}

function ageInDays(row, today) {
  if (today === undefined) return undefined;
  const measured = dayNumber(row?.at);
  const tried = dayNumber(row?.tried);
  // The later of the two days, written as cases: a row can carry either, both
  // or neither, and a nested ternary here reads as one question when it is
  // really three. The values are unchanged.
  let day;
  if (measured === undefined) day = tried;
  else if (tried === undefined) day = measured;
  else day = Math.max(measured, tried);
  if (day === undefined) return undefined;
  return Math.floor((today - day) / DAY);
}

async function getJSON(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

// The snapshot as it stands. A missing or unreadable file is no snapshot rather
// than a failure: the first run has nothing to compare against, and every id it
// sees is new, which is exactly what it should say.
//
// A file this file did not write is no snapshot either, and that is the same
// answer on purpose. A version this file does not know, a `models` that is not
// an object, and a row that is not a measurement all mean one thing: there is
// nothing here to compare against. The difference is not cosmetic — it decides
// whether every offered id gets swept or none of them does.
//
// The rows are checked because `added` is decided by the id being in the table:
// a row that is not a measurement still marks its id as measured, so that id is
// never swept again, and the bad row is written straight back out by
// `writeSnapshot`, which makes the corruption permanent. This file is one a
// person may edit by hand, and `limits.mjs` reads the same file with the same
// care about what a row means — it skips a row it cannot read.
export async function readSnapshot(file = SNAPSHOT) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed?.version !== SNAPSHOT_VERSION) return { models: {} };
    const models = parsed?.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return { models: {} };
    // A null-prototype map, because an id comes out of a file a person may edit
    // by hand: assigning a row under the key `__proto__` on a plain object walks
    // `Object.prototype`'s setter and sets the map's prototype instead of adding
    // a row. The row would then be lost — `Object.hasOwn(measured, "__proto__")`
    // false, so the id stays "new" and is re-swept every run — and the prototype
    // would be a row-shaped object every later lookup reads through.
    const rows = Object.create(null);
    for (const [id, row] of Object.entries(models)) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      // The label decides whether the row is a measurement, and the label itself
      // has to be one this file — and `limits.mjs` — knows. A row whose wall is
      // `"bracketedt"` (a typo, or a label a newer sweep adds) is kept by the
      // shape check but is not a measurement: `added` is decided by the id being
      // in the table, so that id would never be swept again, and the bad row
      // would be written straight back out. `checkSnapshot` is the other reader
      // of these labels, and the two lists are the same one held here.
      if (typeof row.wall !== "string" || !WALLS.includes(row.wall)) continue;
      rows[id] = row;
    }
    return { models: rows };
  } catch {
    return { models: {} };
  }
}

// What a sweep result is worth keeping. `asked` and `spent` are dropped: they are
// the receipt for one run's budget, and a snapshot that grew by every request ever
// made would stop being a thing a person can read.
const kept = ({ servedTokens, servedChars, refusedChars, refusedSizes, wall, named }) => ({
  servedTokens,
  servedChars,
  refusedChars,
  refusedSizes,
  wall,
  // A window the route named in its own words, when one of its refusals stated it.
  // Kept because it outranks every bracket below it: `limits.mjs` reads this field
  // to answer the axis as the route stated it rather than as the sweep narrowed it,
  // and a named number dropped here would be a number the plugin never sees.
  ...(Number.isSafeInteger(named) ? { named } : {}),
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
  // Parsed once: the base the models are fetched from, the one the log names and
  // the one the report carries are then one value, and a malformed
  // `ZEN_BASE_URL` is one failure at the start of the run rather than one per
  // place it happened to be read.
  const base = baseURL();
  const [listing, catalog] = await Promise.all([fetchJSON(`${base}/models`), fetchJSON(CATALOG_URL)]);
  const models = catalog?.opencode?.models ?? {};
  const offered = offeredIds(
    (Array.isArray(listing?.data) ? listing.data : []).map((entry) => entry?.id).filter(Boolean),
    models,
  );
  const snapshot = await read();
  const measured = snapshot.models ?? {};
  // The rule that decides what is measured at all, and it is a rule about the
  // CATALOGUE's number rather than about the model's size: an id the catalogue
  // declares at a million or more is answered from models.dev — the largest
  // entry any provider declares for the same canonical model — and is not
  // measured. Only an id the catalogue declares BELOW a million is measured
  // here, because only there does a measurement change the answer: the
  // catalogue under-reports the small ones by a factor of three, and the big
  // ones' real window is the binary million whatever the decimal one says.
  //
  // Measuring the big ones was not harmless. On 2026-10-20 the sweep asked
  // `minimax-m3.1-flash-free` and `beam-free` and `nemotron-3.5-super-vl-free`
  // — ids whose value models.dev already answers — and spent eleven megabytes
  // of prompts and half an hour of runner time to learn what the catalogue
  // already said: 1,048,576. The run also made a mess of the snapshot, which
  // then looked like evidence about a window nobody had asked about.
  //
  // So the exclusion is by declaration, not by outcome, and it holds for every
  // way into this file: a new id, a suspect one, and `--all` alike.
  const declaredOf = (id) => {
    const declared = models?.[id]?.limit?.context;
    return Number.isSafeInteger(declared) && declared > 0 ? declared : undefined;
  };
  // The ids whose window models.dev answers, and which are therefore not asked
  // about at all. An id the catalogue does not declare a window for is NOT one
  // of these: there is no declaration to be large, so there is nothing for
  // models.dev to correct, and it is measured.
  const answeredElsewhere = offered.filter((id) => {
    const declared = declaredOf(id);
    return declared !== undefined && declared >= MODELS_DEV_MIN;
  });
  const measurable = offered.filter((id) => !answeredElsewhere.includes(id));
  // An id that is offered and has no snapshot entry is the one thing a scheduled
  // run has to measure: nothing else here knows whether a model it has never seen
  // has a wall, and a wall nobody measured is a window every host gets wrong.
  //
  // An id models.dev answers is not one of them, and it never could be: such an
  // id is not measured at all, so the snapshot holds no row for it — the run
  // below drops those rows, unless one of them carries a window the route
  // named — and counting it as "new" therefore made every run report work that
  // will never happen. `minimax-m3.1-flash-free`, `beam-free` and
  // `nemotron-3.5-super-vl-free` were named as new on every single run, and the
  // pull request body is built from this list, so the report always claimed a
  // measurement that was never going to be taken.
  const added = offered.filter((id) => !Object.hasOwn(measured, id) && !answeredElsewhere.includes(id));
  const keptOver = offered.filter((id) => Object.hasOwn(measured, id));
  const gone = Object.keys(measured).filter((id) => !offered.includes(id));
  // The day this run is writing, which is the clock the age of a row is counted
  // against. The run's own date rather than the wall clock, so the two ends of
  // the comparison are the same kind of number.
  const parsedToday = Date.parse(`${at}T00:00:00Z`);
  const today = Number.isNaN(parsedToday) ? undefined : parsedToday;
  // A wall the catalogue's own number does not reach is a wall this sweep has
  // to find, and only among the ids it is allowed to measure.
  const suspicion = measurable.filter((id) => {
    const entry = measured[id];
    if (entry?.wall !== "openEnded") return false;
    const declared = declaredOf(id);
    const served = entry?.servedTokens;
    if (!Number.isSafeInteger(declared) || !Number.isSafeInteger(served)) return false;
    // A tenth of the declared window: a count that differs by less than that is
    // a host counting differently, not a wall.
    if (served >= declared * 0.9) return false;
    // And how old the row is. This rule has no other bound, so without the date
    // it is paid for on every scheduled tick — up to fourteen requests and
    // several megabytes of prompt for a question whose answer does not change,
    // because the ladder is the same on every run. The row carries the day it
    // was measured, and `tried` when a later run asked and learned nothing; the
    // later of the two is when the id was last asked about.
    const age = ageInDays(entry, today);
    // A row with no day on it is asked once: its age is unknown, and the
    // measurement — or the empty attempt, which writes `tried` — dates it, so
    // the bound holds from then on.
    if (age !== undefined && age < SUSPECT_AFTER_DAYS) return false;
    return true;
  });
  // `--all` re-measures everything that may be measured, which is what a person
  // asking for a fresh reading of a model's wall wants, and what nobody wants
  // to pay for on a timer.
  const targets = sweep ? (all ? measurable : [...new Set([...added.filter((id) => measurable.includes(id)), ...suspicion])]) : [];
  log(`${base}`);
  log(`${offered.length} free ids offered, ${keptOver.length} measured before, ${added.length} not`);
  if (added.length > 0) log(`  new: ${added.join(", ")}`);
  if (answeredElsewhere.length > 0)
    log(`  answered from models.dev, so not measured: ${answeredElsewhere.join(", ")}`);
  if (suspicion.length > 0 && sweep && !all)
    log(`  open-ended but under-declared, so measured again: ${suspicion.join(", ")}`);
  if (gone.length > 0) log(`  no longer offered: ${gone.join(", ")}`);
  if (all && sweep) log(`  --all: re-measuring all ${targets.length} that may be measured`);
  const results = targets.length > 0 ? await sweepModels(targets, log) : [];
  // The rows this run will write, as a null-prototype map: an id comes from the
  // route and from a file a person may edit by hand, and `next["__proto__"]` on a
  // plain object would set the map's prototype instead of adding a row. JSON
  // output is unchanged — a null-prototype object serialises exactly like a
  // plain one — and the snapshot keeps being an object in the file.
  const next = Object.assign(Object.create(null), measured);
  // A result the run learned nothing about is not a measurement, and it must
  // not become a row.
  //
  // A row that says "no wall in reach" about a run that never got an answer is
  // a row about nothing, and writing it costs twice: it overwrites an earlier
  // good measurement — the wall that was found last week is replaced by a row
  // that says the wall was never reached — and it marks the id as measured for
  // ever, because `added` is decided by the id being in the table. The id is
  // then never asked again and the wall nobody found stays unfound.
  //
  // The rule is the sweep's own: a model the route served or refused is a
  // model the run learned something about, and a model whose every request
  // failed is a model the route could not be asked about. `learnedAbout` is
  // where the sweep says it, and it is asked here rather than the rule being
  // copied — the same rule the sweep's own exit code is built on.
  //
  // Such an attempt still has to leave a trace, or the age bound cannot see it:
  // a row left with its old `at` is a row that has been "measured" seven days
  // ago for ever, so an `openEnded` id the route will not answer is swept again
  // on every hourly tick. The measurement is not rewritten — that is the rule
  // above — but the day the id was last asked about is, in `tried`, which
  // `ageInDays` prefers over `at`. A new id with no row cannot carry one without
  // also being marked as measured for ever, so it gets none: it is retried every
  // run until the route answers it, which is what `added` means.
  //
  // A result the sweep could positively say is gone adds a second day,
  // `unavailable`: every answer of that run was an error and every one of them
  // named the model as missing, retired or no longer there (the sweep's own
  // `unavailabilityOf` rule, so this is not a second opinion about the route).
  // It is written only onto a row that already exists — a new id still gets no
  // measurement — and it is history, not a switch: nothing here hides, disables
  // or reroutes the model, and a later served or refused answer replaces the row
  // with one that no longer carries it. `tried` stays beside it because the
  // attempt is still the day the age is counted from.
  //
  // The sentence the route used is reported on its own line: a pull request body
  // is built from this report, and "the route says the model is gone, in these
  // words" is the thing a person needs to see before believing a row without a
  // measurement.
  const unlearned = [];
  for (const result of results) {
    if (!learnedAbout(result)) {
      unlearned.push(result.model);
      const held = next[result.model];
      if (held)
        next[result.model] = {
          ...held,
          tried: at,
          ...(result.unavailable === true ? { unavailable: at } : {}),
        };
      if (result.unavailable === true) {
        const said = typeof result.unavailableSays === "string" ? result.unavailableSays.trim() : "";
        log(`  unavailable: ${result.model}${said === "" ? "" : ` — ${said}`}`);
      }
      continue;
    }
    // A measurement that answered is a row about a route that is serving the
    // model now. `kept` builds the row from scratch, so a stale `unavailable`
    // from an earlier failed run cannot survive it — the model is no longer
    // known to be gone, and saying otherwise would keep a recovered id marked
    // for ever.
    next[result.model] = { ...kept(result), at };
  }
  if (unlearned.length > 0)
    log(`  learned nothing, so no measurement was written: ${unlearned.join(", ")}`);
  // A row for an id that is answered from models.dev is a row about a window
  // nobody asked about, and it is the row that makes the next run think the
  // model is still a candidate: `openEnded` is what the suspicion rule reads.
  // So the rows of the ids that are not measured are dropped rather than kept —
  // the snapshot then holds what the sweep knows, which is the walls it went and
  // found.
  //
  // The rule is applied to every row by what the catalogue declares, not only to
  // the ids the route is offering today: `space-bunny-free` was retired by the
  // route, its row was left behind, and it was declared at 1,048,576, so it is
  // one of the ids models.dev answers and it has no row either.
  //
  // Two things this rule may not do, and used to do both.
  //
  // It may not be silent. A row that disappeared left no trace: not in the log,
  // not in what the run returned, and not in anything a pull request body could
  // explain, so the diff simply lost a measurement and the run said nothing at
  // all about losing it. The ids that were dropped are named.
  //
  // And it may not drop a row that carries a window the route stated in its own
  // words. A `named` number is the route's own answer, and `limits.mjs` reads
  // that field to settle an axis outright — a `named` row settles it, a
  // bracketed one only raises — so a row dropped here is a window the plugin
  // never sees, which is what the comment on `kept` above says about it. A
  // vendor raising a declaration over a million does not un-state what the
  // route said about itself, and `longcat-2.5-preview-free` (declared at
  // 1,000,000) is the row that would have been lost by it.
  const dropped = [];
  for (const id of Object.keys(next)) {
    const declared = declaredOf(id);
    if (declared === undefined || declared < MODELS_DEV_MIN) continue;
    if (Number.isSafeInteger(next[id]?.named)) continue;
    dropped.push(id);
    delete next[id];
  }
  if (dropped.length > 0)
    log(`  dropped from the snapshot, because models.dev answers them: ${dropped.join(", ")}`);
  return {
    base, offered, added, gone, suspicion, answeredElsewhere, dropped, unlearned,
    measured: keptOver, results, snapshot: { models: next },
  };
}

export async function writeSnapshot(state, file = SNAPSHOT) {
  // Sorted, so a diff is the ids that changed and not the order the route
  // happened to list them in.
  const models = Object.fromEntries(Object.entries(state.models ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  const body = `${JSON.stringify({ version: SNAPSHOT_VERSION, _units: UNITS, models }, null, 2)}\n`;
  // Written beside the file and renamed over it, which is atomic on the same
  // file system. `writeFile` truncates the target first, so a crash, a full
  // disk or a signal between the truncate and the write left
  // `limits-observed.json` empty or half written — and that file is not only
  // this script's state: `limits.mjs` reads it on the model-list path, caches
  // the answer per path, and answers with an empty map when the JSON does not
  // parse, so a half-written snapshot silently stripped every measured wall
  // from the running plugin until it was restarted, and the cache kept that
  // answer. `limits.mjs`'s own state file and `capture.mjs`'s fingerprint are
  // written the same way, for the same reason.
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, body, "utf8");
    await rename(temporary, file);
  } catch (cause) {
    // A write that failed leaves its temporary where nothing reads it, and the
    // next run would find it stale: a snapshot that could not be written is not
    // one to be picked up later. The cleanup is best-effort and reports its own
    // failure rather than raising it — what sits at the temporary path when the
    // write failed is exactly what the write failed on, and a cleanup error
    // would send the reader after the wrong one. The error that says why the
    // snapshot was not written is the one that has to arrive.
    try {
      await rm(temporary, { force: true });
    } catch (cleanup) {
      console.error(
        `could not remove ${temporary} (${cleanup?.code ?? cleanup?.message ?? cleanup}); it is left behind`,
      );
    }
    throw cause;
  }
  return body;
}

// What is wrong with a row, said one line at a time. A row that is not a
// measurement is a row nothing can be read out of, and the lines say which id
// it is and why it does not count.
function rowProblems(id, row) {
  const problems = [];
  const say = (why) => problems.push(`${id}: ${why}`);
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    say("the row is not a measurement");
    return problems;
  }
  // The wall, and the label it has to be one of.
  const wall = row.wall;
  if (typeof wall !== "string" || !WALLS.includes(wall)) {
    say(`the wall is ${JSON.stringify(wall)}, and the walls a row may say are ${WALLS.join(", ")}`);
  }
  // The numbers. A number in a row is a whole number of tokens or of
  // characters, and a row that has none of a thing says so with a null rather
  // than with a zero: a zero is a measurement of nothing. Each number also has
  // an upper bound, because this check is the gate on an unattended merge and a
  // runaway probe is otherwise a shape the gate accepts.
  const bounds = {
    servedTokens: MAX_SERVED_TOKENS,
    servedChars: MAX_MEASURED_CHARS,
    refusedChars: MAX_MEASURED_CHARS,
  };
  for (const [key, bound] of Object.entries(bounds)) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      say(`\`${key}\` is ${JSON.stringify(value)}, and a number in a row is a whole number of tokens or characters`);
      continue;
    }
    if (value > bound) {
      say(`\`${key}\` is ${value}, and no measurement here is above ${bound}`);
    }
  }
  // The two units are about the same request, so they have to agree: a body of
  // 400,000 characters does not carry a million tokens. A row that says it does
  // was built from two different runs — or two different units — and neither
  // number can be trusted as a window.
  if (
    Number.isSafeInteger(row.servedTokens) &&
    row.servedTokens > 0 &&
    Number.isSafeInteger(row.servedChars) &&
    row.servedChars > 0 &&
    row.servedTokens > row.servedChars * MAX_TOKENS_PER_CHAR + TOKEN_CHAR_SLACK
  ) {
    say(`\`servedTokens\` is ${row.servedTokens} against \`servedChars\` ${row.servedChars}, and a prompt of that many characters does not hold that many tokens`);
  }
  if (row.named !== undefined) {
    if (!Number.isSafeInteger(row.named) || row.named <= 0) {
      say(`\`named\` is ${JSON.stringify(row.named)}, and a window the route named is a whole number of tokens`);
    } else if (row.named > MAX_SERVED_TOKENS) {
      say(`\`named\` is ${row.named}, and no window the route names here is above ${MAX_SERVED_TOKENS} tokens`);
    }
  }
  // The sizes that were refused, in the order they were refused.
  const sizes = row.refusedSizes;
  if (sizes !== undefined) {
    if (!Array.isArray(sizes)) {
      say(`\`refusedSizes\` is ${JSON.stringify(sizes)}, and it is the list of sizes that were refused`);
    } else {
      for (const size of sizes) {
        if (!Number.isSafeInteger(size) || size <= 0) {
          say(`\`refusedSizes\` holds ${JSON.stringify(size)}, and a size is a whole number of characters`);
        } else if (size > MAX_MEASURED_CHARS) {
          say(`\`refusedSizes\` holds ${size}, and no measurement here is above ${MAX_MEASURED_CHARS} characters`);
        }
      }
      for (let index = 1; index < sizes.length; index += 1) {
        if (sizes[index - 1] >= sizes[index]) {
          say(`\`refusedSizes\` is out of order: ${sizes[index - 1]} is followed by ${sizes[index]}`);
        }
      }
    }
  }
  // The size that was refused first and the size the row names must be one
  // size: the sweep writes the first of the list, and a row that names another
  // one names a refusal it does not carry.
  const first = Array.isArray(sizes) && sizes.length > 0 ? sizes[0] : undefined;
  if (first === undefined) {
    if (row.refusedChars !== undefined && row.refusedChars !== null) {
      say(`\`refusedChars\` is ${JSON.stringify(row.refusedChars)} and no size was refused, so the row names a size it does not carry`);
    }
  } else if (row.refusedChars !== first) {
    say(`\`refusedChars\` is ${JSON.stringify(row.refusedChars)} and the first size refused is ${first}, so the row names two different sizes`);
  }
  // The label and the evidence behind it. The sweep's own rule: a wall needs
  // two refused sizes behind a served one, one refusal is a single-refusal and
  // no refusal at all is a model whose wall was never reached.
  const refused = Array.isArray(sizes) ? sizes.length : 0;
  if (wall === "openEnded" && refused > 0) {
    say(`the wall is "openEnded" and ${refused} size(s) were refused, and a wall that was refused is not one that was never reached`);
  }
  if (wall === "single-refusal" && refused !== 1) {
    say(`the wall is "single-refusal" and ${refused} size(s) were refused, and a single refusal is one size`);
  }
  if (wall === "bracketed" && refused < 2) {
    say(`the wall is "bracketed" and ${refused} size(s) were refused, and a wall needs two refused sizes behind a served one`);
  }
  // A window the route named is the wall: the sweep calls the row "named" when
  // one of its refusals stated the window, and names the row nothing when none
  // did. A row that says one and holds the other is a row about nothing.
  if (wall === "named" && !Number.isSafeInteger(row.named)) {
    say('the wall is "named" and no window was named, so the row settles an axis with nothing in it');
  }
  if (Number.isSafeInteger(row.named) && wall !== "named") {
    say(`the row names a window of ${row.named} and the wall is ${JSON.stringify(wall)}, and a named window is the wall`);
  }
  // The day the row was measured.
  const day = row.at;
  const read = typeof day === "string" ? Date.parse(`${day}T00:00:00Z`) : Number.NaN;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(read)) {
    say(`the date is ${JSON.stringify(day)}, and it is the day the row was measured, as YYYY-MM-DD`);
  } else if (new Date(read).toISOString().slice(0, 10) !== day) {
    say(`the date is ${JSON.stringify(day)}, and there is no such day`);
  }
  // The day the id was last asked about and learned nothing, when a later run
  // has tried. It is optional — a row written before the field existed has none,
  // and a row whose sweep answered has no reason for one — but a value the file
  // does carry is a day of the same shape as `at`: `ageInDays` reads it to hold
  // the seven-day bound on a measurement that could not be renewed.
  if (row.tried !== undefined) {
    const tried = row.tried;
    const triedRead = typeof tried === "string" ? Date.parse(`${tried}T00:00:00Z`) : Number.NaN;
    if (typeof tried !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(tried) || Number.isNaN(triedRead)) {
      say(`\`tried\` is ${JSON.stringify(tried)}, and it is the day the id was last asked, as YYYY-MM-DD`);
    } else if (new Date(triedRead).toISOString().slice(0, 10) !== tried) {
      say(`\`tried\` is ${JSON.stringify(tried)}, and there is no such day`);
    }
  }
  // The day the route last said the model itself is gone, when the sweep heard
  // it. Optional like `tried` — a row the route answered has no reason for one —
  // but a value the file does carry is a day of the same shape: it is history a
  // report reads, and a date nobody can read is not one.
  if (row.unavailable !== undefined) {
    const unavailable = row.unavailable;
    const unavailableRead =
      typeof unavailable === "string" ? Date.parse(`${unavailable}T00:00:00Z`) : Number.NaN;
    if (
      typeof unavailable !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(unavailable) ||
      Number.isNaN(unavailableRead)
    ) {
      say(`\`unavailable\` is ${JSON.stringify(unavailable)}, and it is the day the route last called the model gone, as YYYY-MM-DD`);
    } else if (new Date(unavailableRead).toISOString().slice(0, 10) !== unavailable) {
      say(`\`unavailable\` is ${JSON.stringify(unavailable)}, and there is no such day`);
    }
  }
  return problems;
}

// What is wrong with a snapshot, said one line at a time. A snapshot that is
// right has no lines at all.
//
// The file is the plugin's own input at run time: `limits.mjs` reads it on the
// model-list path and answers with what it holds, so a file that is not what
// the plugin can read is a window every host gets wrong. That is why this
// exists: the workflow publishes the file without a person reading it, and the
// run that publishes it is not the run that would notice.
export function checkSnapshot(snapshot) {
  const problems = [];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return ["the file is not a snapshot: it is not a JSON object"];
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    problems.push(`the version is ${JSON.stringify(snapshot.version)}, and this file reads ${SNAPSHOT_VERSION}`);
  }
  const models = snapshot.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    return [...problems, "the file holds no `models` object, so it holds no measurement"];
  }
  // The units the file states. A file that states none cannot be read by
  // somebody who was not there, and a file that states them wrongly is worse:
  // it is a file that says a number of characters is a number of tokens.
  const units = snapshot._units;
  if (!units || typeof units !== "object" || Array.isArray(units)) {
    problems.push("the file does not say what unit its numbers are in, and a number without a unit is a number nobody can read");
  } else {
    for (const [key, unit] of Object.entries(EXPECTED_UNITS)) {
      if (units[key] !== unit) {
        problems.push(`the file says \`${key}\` is ${JSON.stringify(units[key])}, and it is ${unit}`);
      }
    }
    for (const [key, unit] of Object.entries(OPTIONAL_UNITS)) {
      if (units[key] !== undefined && units[key] !== unit) {
        problems.push(`the file says \`${key}\` is ${JSON.stringify(units[key])}, and it is ${unit}`);
      }
    }
  }
  for (const [id, row] of Object.entries(models)) problems.push(...rowProblems(id, row));
  return problems;
}

// The check as a file is read: a file that cannot be read, a file that is not
// JSON and a file that is read and is wrong are three different answers, and
// the third is the only one that says anything about a row.
//
// `why` is which of the three it is: "unreadable", "not-json" or "bad".
export async function checkSnapshotFile(file = SNAPSHOT) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return {
      ok: false,
      why: "unreadable",
      problems: [`the snapshot could not be read: ${error?.message ?? error}`],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, why: "not-json", problems: [`the snapshot is not JSON: ${error?.message ?? error}`] };
  }
  const problems = checkSnapshot(parsed);
  return { ok: problems.length === 0, why: problems.length === 0 ? "ok" : "bad", problems };
}

// A day a row names, or undefined when what it says is not a day. `--status`
// reads R4b's optional `unavailable` field and must not throw on a hand-edited
// row: a value that is not a day is no evidence that the model is unavailable,
// so it is ignored rather than reported. The round-trip is the same real-day
// rule `rowProblems` applies to `at`, and the reason is the same: `Date.parse`
// accepts a string that ISO then rewrites, and a row edited into `2026-13-40`
// must not read as a day.
function unavailableDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = dayNumber(value);
  if (parsed === undefined) return undefined;
  return new Date(parsed).toISOString().slice(0, 10) === value ? value : undefined;
}

// The snapshot's freshness and health, as one answer a person or a workflow can
// read. This is a read-only question: `stat` and `readFile` are the only things
// it touches, never the network and never the file's contents; `now` is an
// argument so a case can age a file without waiting, and `staleAfter` is the
// same kind of argument because the right bound belongs to whoever is watching.
//
// The report is the JSON shape the workflow reads, and `exitCode` is the code
// the entry point sets: 1 when the file cannot be read at all (missing,
// unreadable, not JSON), 2 when it was read and is degraded, 0 when it is
// healthy. The distinction is the same one the watch run draws — "could not
// ask" and "asked, and the answer was nothing" are different answers — and 2 is
// the degraded answer here rather than the watch run's "no free ids".
export async function statusSnapshot(
  file = SNAPSHOT,
  { staleAfter = STATUS_STALE_AFTER_SECONDS, now = Date.now() } = {},
) {
  const at = Number.isFinite(now) ? now : Date.now();
  const report = {
    snapshotPath: file,
    generatedAt: null,
    ageSeconds: null,
    staleAfterSeconds: staleAfter,
    stale: false,
    models: 0,
    rows: [],
    issues: [],
  };
  const fatal = (code, message) => {
    report.issues.push({ code, message });
    return { report, exitCode: 1 };
  };
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    // A file that is not there and one that cannot be stat'ed are both "could
    // not read", but they are not the same sentence to the person who has to
    // fix it: a first run expects the first and needs no alarm, an EACCES on a
    // file that exists is a permissions problem.
    return error?.code === "ENOENT"
      ? fatal("snapshot_missing", `the snapshot does not exist: ${file}`)
      : fatal("snapshot_unreadable", `the snapshot could not be read: ${error?.message ?? error}`);
  }
  report.generatedAt = new Date(info.mtimeMs).toISOString();
  report.ageSeconds = Math.max(0, Math.floor((at - info.mtimeMs) / 1000));
  report.stale = report.ageSeconds > staleAfter;
  // The validation is `--check`'s own, so a file `--status` calls readable is a
  // file the gate would have published: one reader for "what the plugin reads".
  const check = await checkSnapshotFile(file);
  if (check.why === "unreadable") return fatal("snapshot_unreadable", check.problems.join("; "));
  if (check.why === "not-json") return fatal("snapshot_not_json", check.problems.join("; "));
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    // The file changed between the check and this read, or it was readable to
    // one call and not the other: the same two answers as above, named the same
    // way, rather than a stack trace out of a report.
    return fatal("snapshot_unreadable", `the snapshot could not be read a second time: ${error?.message ?? error}`);
  }
  if (report.stale)
    report.issues.push({
      code: "snapshot_stale",
      message: `the snapshot was written ${report.ageSeconds}s ago, and the bound is ${staleAfter}s`,
    });
  if (check.why === "bad")
    for (const problem of check.problems)
      report.issues.push({ code: "snapshot_invalid", message: problem });
  const models =
    parsed?.models && typeof parsed.models === "object" && !Array.isArray(parsed.models)
      ? parsed.models
      : {};
  const ids = Object.keys(models).sort();
  report.models = ids.length;
  if (ids.length === 0)
    report.issues.push({
      code: "no_measurements",
      message: "the snapshot holds no model rows, so it measures nothing",
    });
  // The day the age of a row is counted against. It is the run's own date, the
  // same clock `watch()` uses, so a status report and a scheduled run agree on
  // what "seven days old" means.
  const today = dayNumber(new Date(at).toISOString().slice(0, 10));
  for (const id of ids) {
    const row = models[id];
    // A row that is not a row is already a `snapshot_invalid` problem; there is
    // nothing here to report about it without inventing a shape.
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const ageDays = ageInDays(row, today);
    const staleRow = Number.isSafeInteger(ageDays) && ageDays > SUSPECT_AFTER_DAYS;
    const unavailableAt = unavailableDay(row.unavailable);
    const entry = {
      id,
      wall: typeof row.wall === "string" ? row.wall : null,
      at: typeof row.at === "string" ? row.at : null,
      tried: typeof row.tried === "string" ? row.tried : null,
      ageDays: Number.isSafeInteger(ageDays) ? ageDays : null,
      stale: staleRow,
    };
    if (unavailableAt !== undefined) {
      // The field is surfaced whether or not it is recent; only a recent day is
      // an outage to report. An old one is the history of a model that came
      // back, and the row's own measurement is what says it is being served now.
      entry.unavailableAt = unavailableAt;
      const unavailableDays = Math.floor((today - dayNumber(unavailableAt)) / DAY);
      if (unavailableDays >= 0 && unavailableDays <= UNAVAILABLE_RECENT_DAYS)
        report.issues.push({
          code: "model_unavailable",
          message: `${id}: the route last refused it as gone on ${unavailableAt}`,
        });
    }
    if (staleRow)
      report.issues.push({
        code: "row_stale",
        message: `${id}: the measurement is ${ageDays} days old, older than ${SUSPECT_AFTER_DAYS}`,
      });
    report.rows.push(entry);
  }
  return { report, exitCode: report.issues.length === 0 ? 0 : 2 };
}

// The file and the freshness bound `--status` was asked for. It is a separate
// reader from `--check`'s because `--stale-after` takes a value, and the first
// non-flag argument cannot be taken for the file without knowing that: the
// number after the flag is not a snapshot path. `--stale-after=SECONDS` is read
// too, and a value that is not a whole number of seconds leaves the default in
// place rather than turning the status run into an argument error. Such a value
// is also left in the argument list: it may be the positional snapshot, and
// consuming it here is the silent other-file report described at the loop.
function statusArguments(args) {
  let staleAfter = STATUS_STALE_AFTER_SECONDS;
  // A whole number of seconds or nothing: `parseInt` reads the `2026` out of
  // `2026-10-21.json`, so a leading number was enough to consume a snapshot path
  // as the flag's value — the file then never reached the positional list and
  // the run reported on the default snapshot instead of the one it was handed.
  const seconds = (text) => {
    if (!/^\d+$/.test(text)) return undefined;
    const value = Number.parseInt(text, 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const positional = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at];
    if (arg === "--stale-after") {
      const value = seconds(args[at + 1] ?? "");
      // Only a real value is consumed. Stepping over the next token regardless
      // is what made `--status --stale-after file.json` silently report on the
      // default snapshot: the path was eaten as the flag's value and never
      // reached the positional list, so the run looked successful about a file
      // nobody named. Left in place, the token is read as the positional
      // snapshot, and if it is not one the run fails and names it.
      if (value !== undefined) {
        staleAfter = value;
        at += 1;
      }
      continue;
    }
    if (arg.startsWith("--stale-after=")) {
      const value = seconds(arg.slice("--stale-after=".length));
      if (value !== undefined) staleAfter = value;
      continue;
    }
    if (arg.startsWith("--")) continue;
    positional.push(arg);
  }
  return { file: positional[0] ?? SNAPSHOT, staleAfter };
}

// The human half of `--status`: what a person reading a terminal needs, in the
// same voice as the rest of this file's log lines. The JSON half is the report
// itself, printed by the entry point.
function printStatus(report) {
  console.log(`limits watch — ${report.snapshotPath}`);
  if (report.generatedAt === null) {
    console.log("  no snapshot to date, so there is nothing to age or bound");
  } else {
    console.log(
      `  written ${report.generatedAt} (${report.ageSeconds}s old); ${report.stale ? "STALE" : "fresh"} against a bound of ${report.staleAfterSeconds}s`,
    );
  }
  console.log(`  ${report.models} model row(s)`);
  for (const row of report.rows) {
    const facts = [row.wall ?? "no wall", row.at === null ? "undated" : `measured ${row.at}`];
    if (row.ageDays !== null) facts.push(`${row.ageDays} day(s) ago`);
    if (row.unavailableAt !== undefined) facts.push(`unavailable since ${row.unavailableAt}`);
    if (row.stale) facts.push("stale");
    console.log(`    ${row.id}: ${facts.join(", ")}`);
  }
  if (report.issues.length === 0) {
    console.log("  snapshot is healthy");
    return;
  }
  console.log(`  ${report.issues.length} issue(s):`);
  for (const issue of report.issues) console.log(`    ${issue.code}: ${issue.message}`);
}

// Whether this file was run is asked in one place and answered three ways, as
// in `limits-sweep.mjs`: `import.meta.main` is the direct answer and the one
// Bun gives, and `entryVerdict` falls back to process.argv[1] for the Node
// releases before 22.18 that have no such flag. An answer it cannot settle is
// not a reason to exit 0 — a `--check` that silently did nothing would report
// success about a snapshot nobody read — so it is said and the run fails. The
// one exception is a process that named no script at all — `node -e`, a REPL,
// an import from another program — where nothing can be run from here and the
// failure would be about an import that never asked to watch anything.
const main = typeof import.meta.main === "boolean" ? import.meta.main : undefined;
const entry = entryVerdict({ main, url: import.meta.url, argv: process.argv });
if (entry === undefined && !namesNoScript(process.argv)) {
  console.error(
    "limits watch — could not tell whether this file was run or imported, so nothing was asked: neither import.meta.main nor process.argv[1] named an entry point. Run it with `bun run limits:watch`.",
  );
  process.exitCode = 1;
}

if (entry === true) {
  const args = process.argv.slice(2);
  // `--check` is a gate on a file that is about to be published, so it asks
  // nothing and writes nothing: it reads a snapshot and says whether it is
  // what the plugin will read when it starts. It is a mode of its own — a run
  // with `--check` never reaches the route and never writes.
  //
  //   bun limits-watch.mjs --check [file]
  //
  // The file is the first argument that is not a flag, and it is
  // `limits-observed.json` beside this file when there is none.
  if (args.includes("--check")) {
    const named = args.find((arg) => !arg.startsWith("--"));
    const file = named ?? SNAPSHOT;
    const report = await checkSnapshotFile(file);
    if (report.ok) {
      console.log(`limits watch — ${file} is a snapshot the plugin can read`);
    } else {
      console.error(
        report.why === "unreadable"
          ? `limits watch — ${file} could not be read:`
          : report.why === "not-json"
            ? `limits watch — ${file} is not JSON:`
            : `limits watch — ${file} is not what the plugin will read:`,
      );
      for (const problem of report.problems) console.error(`  ${problem}`);
      console.error("Fix the file, or let a run write it again with `bun limits-watch.mjs --write`.");
      process.exitCode = 1;
    }
  } else if (args.includes("--status")) {
    // The other read-only mode: a report about the snapshot rather than a gate
    // on it. It asks nothing and writes nothing, so a host or a workflow can run
    // it against the operator's own file without a route or a publisher.
    //
    //   bun limits-watch.mjs --status [--json] [--stale-after SECONDS] [file]
    //
    // The file follows `--check`'s rule — the first argument that is not a flag
    // — with the one difference `--stale-after` forces: its value is skipped, so
    // a bound of 60 is not mistaken for a path.
    const { file, staleAfter } = statusArguments(args);
    const { report, exitCode } = await statusSnapshot(file, { staleAfter });
    if (args.includes("--json")) console.log(JSON.stringify(report));
    else printStatus(report);
    // The code is set rather than exited on for the same reason the watch run's
    // is: a report written to a pipe must be out before the process ends, or the
    // consumer sees an empty line and the wrong exit code's worth of nothing.
    process.exitCode = exitCode;
  } else {
    try {
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
      // Three answers, three codes (documented at the top of this file). A run
      // that reached the route and was offered ids answered its question, and so
      // did one that was offered none: the second is not an outage, and giving
      // it the code of a route that could not be asked hides the one fact the
      // workflow needs — 2 means "asked, and there is nothing to publish". The
      // code is set rather than exited on, because stdout to a pipe is written
      // asynchronously and `process.exit` can cut the report off before it is out
      // — and the report is the pull request body.
      process.exitCode = state.offered.length > 0 ? 0 : 2;
    } catch (error) {
      // Being unable to ask is not a finding about limits, so it is a sentence
      // and an exit code rather than a stack trace about a fetch that failed: a
      // route that answers 500, a name that does not resolve, a catalogue that
      // cannot be read and a snapshot that cannot be written all stop here, and
      // the exit code is the one the workflow reads to tell "reached the route"
      // from "could not reach it". `limits-audit.mjs` says the same thing the
      // same way.
      console.error(`\nlimits watch — unable to read the route or the catalogue: ${error?.message ?? error}`);
      console.error("The route or the catalogue could not be read. Check the network and ZEN_BASE_URL, then ask again.");
      process.exitCode = 1;
    }
  }
}

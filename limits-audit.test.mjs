import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unsupportedError } from "./tools-smoke.mjs";

// The subject is imported by each test rather than at file load. The module
// decides at evaluation whether it was run or imported, and throws when it
// cannot tell, so a load failure has to land on the test that awaited it rather
// than become a rejected promise nobody handles until the runner trips over it.
const subject = () => import("./limits-audit.mjs");

// A lookup that lands on nothing must say which id had no line rather than fail
// inside assert.match with "undefined is not an argument of type string". The
// `id:` form matters: a prefix match without the delimiter finds the line of
// `dead-free-2` when asked for `dead-free` and certifies the wrong id.
function lineFor(lines, id) {
  const line = lines.find((candidate) => candidate.startsWith(`${id}:`));
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
  const { offeredIds } = await subject();
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
  // "names itself free" is asked the way models.mjs asks it, case-insensitively.
  // Spelled `/-free$/` here it was case-sensitive, so an id the plugin offers —
  // `buildModels` reads its name with `/i` — was audited by nobody at all, and
  // the run said so in no line: the id simply was not in the set.
  for (const id of ["Foo-Free", "Foo-FREE", "foo-Free", "FOO-FREE"]) {
    assert.deepEqual(offeredIds([id], {}), [id], `${id} names itself free whatever its case`);
  }
  // an id that does not end in `-free` is not offered on its name, whatever its
  // case: the rule is the name's shape and not a broad match on "free"
  assert.deepEqual(offeredIds(["Foo-Free-Tier", "free-Foo", "Foo"], {}), []);
  // and the catalogue's own rule is the same one, so an id the catalogue retires
  // stays out however it spells its name
  assert.deepEqual(
    offeredIds(["Gone-Free"], { "Gone-Free": { lifecycle: "retired", cost: { input: 0, output: 0 } } }),
    [],
  );
  // a snapshot can be handed in, so a test says what it knows without depending
  // on what the shipped one happens to carry
  assert.deepEqual(offeredIds(["x-free"], {}, { "x-free": "systemone" }), []);
  assert.deepEqual(offeredIds(["x-free"], {}, { "x-free": "chat" }), ["x-free"]);
  // An id named after a member of `Object.prototype` is a name, not a protocol.
  // `snapshot?.[id]` answered `toString` out of the prototype — a function — and
  // the `SDK` lookup for it found nothing, so the id was dropped before the
  // catalogue's own free row was ever read: a model the plugin offers that no
  // audit spoke for, and a line that said nothing about why. The catalogue
  // describes every one of these as free, so nothing but the id's own name
  // stands between them and being offered.
  const prototypeNames = ["toString", "valueOf", "constructor", "__proto__", "hasOwnProperty"];
  const freeRow = { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } };
  const described = Object.fromEntries(prototypeNames.map((id) => [id, freeRow]));
  assert.deepEqual(
    offeredIds(prototypeNames, described, {}),
    prototypeNames,
    "a free id whose name is a prototype member is still an id the plugin offers",
  );
  // a listing entry the catalogue marks retired is not offered by the plugin
  // either, so auditing it would report a model nobody can pick
  for (const model of [
    { lifecycle: "retired", cost: { input: 0, output: 0 } },
    { retirement_date: "2026-10-01", cost: { input: 0, output: 0 } },
  ]) {
    assert.deepEqual(offeredIds(["dead-free"], { "dead-free": model }), [], JSON.stringify(model));
  }
  // ...and the status that is a warning rather than an ending is audited, because
  // the plugin offers it: `muse-spark-1.2-contributor-free` was marked deprecated
  // and answered a free-tier request on 2026-10-16, so a model with this status
  // is one an audit still has to speak for.
  assert.deepEqual(
    offeredIds(["warning-free"], { "warning-free": { status: "deprecated", cost: { input: 0, output: 0 } } }),
    ["warning-free"],
  );
});

test("ids are grouped by the upstream model the route names, and one that names none is left out", async () => {
  const { groupByUpstream } = await subject();
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
  const { findings } = await subject();
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
  assert.equal(
    pickle[0],
    "big-pickle: the route names a ceiling of 131072 completion tokens, the catalogue declares 32000",
  );
  assert.equal(lines.filter((line) => line.startsWith("mimo-v2.6-flash-free:")).length, 0);
  assert.equal(lineFor(lines, "fledge-alpha-free"), "fledge-alpha-free: HTTP 410 — Model fledge-alpha-free has been deprecated.");
});

test("the line that names the catalogue prints the catalogue's own number, not the plugin's", async () => {
  const { findings, withEffective } = await subject();
  // `deepseek-v4.1-flash-free` is declared 200000/32000 in the catalogue, with
  // its output raised to 384000 by limits.mjs, so a row carrying both pairs is
  // where the two numbers can be confused. The candidate lines say "the
  // catalogue declares X", which is the catalogue's own pair; they used to read
  // `judgement(row)`, the effective one, and so printed limits.mjs's override as
  // the catalogue's number for every id the table does not already cover.
  const rowFor = (extra) =>
    withEffective({
      id: "deepseek-v4.1-flash-free",
      declared: { context: 200000, output: 32000 },
      status: 400,
      upstream: "deepseek-v4.1-flash-free",
      ...extra,
    });
  // the route named the plugin's own number: the catalogue's is still what the
  // line has to print, and 384000 must not come back as the catalogue's
  assert.deepEqual(findings([rowFor({ ceiling: 384000 })]), [
    "deepseek-v4.1-flash-free: the route names a ceiling of 384000 completion tokens, the catalogue declares 32000",
  ]);
  assert.deepEqual(findings([rowFor({ window: 1048576 })]), [
    "deepseek-v4.1-flash-free: a refusal named a window of 1048576, the catalogue declares 200000",
  ]);
  // A route statement the catalogue already declares is not a candidate. Judged
  // against the overridden pair it was one, printed as "the route names a
  // ceiling of 32000 …, the catalogue declares 384000" — both halves of the
  // sentence wrong at once, which is what this pins.
  assert.deepEqual(findings([rowFor({ ceiling: 32000, window: 200000 })]), []);
});

test("a 400 the audit provoked is not a candidate, and the ones it cannot explain are", async () => {
  const { findings, protocolScoped } = await subject();
  const rows = [
    // asked for too much on purpose and told the window, which the catalogue agrees with
    { id: "provoked-free", declared: { context: 1000000, output: 65536 }, status: 400, window: 1000000, says: "" },
    // a refusal that named a window the catalogue does not declare: the one
    // branch of `findings` that a row agreeing with its declaration never reaches
    { id: "narrow-free", declared: { context: 200000, output: 32000 }, status: 400, window: 1048576, says: "" },
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
  const rowFor = (id) => rows.find((row) => row.id === id);
  const lines = findings(rows);
  // Anchored on the delimiter, as the rest of this file is: a bare prefix also
  // matches a longer id that shares it, so the assertion would be talking about a
  // row it never meant to. `lineFor` below says the same thing positively.
  assert.equal(lines.filter((line) => line.startsWith("provoked-free:")).length, 0);
  assert.equal(lineFor(lines, "narrow-free"), "narrow-free: a refusal named a window of 1048576, the catalogue declares 200000");
  assert.equal(lineFor(lines, "silent-free"), "silent-free: HTTP 400 — invalid request");
  assert.equal(lineFor(lines, "dead-free"), "dead-free: HTTP 410 — Model has been deprecated.");
  // a model that speaks another protocol is said once, beside the ids that were
  // not asked, and never sits in this list as a finding. The rows are named, not
  // counted from the end: appending one must not retarget these assertions.
  assert.equal(lines.filter((line) => line.startsWith("wrong-shape-free:")).length, 0);
  // and the anchor is what makes that a statement about this id: a sibling whose
  // id merely starts with the same string is a different row, and the bare-prefix
  // form of this assertion used to trip on it
  const sibling = findings([...rows, { id: "provoked-free-2", declared: {}, status: 410, says: "gone" }]);
  assert.equal(sibling.filter((line) => line.startsWith("provoked-free:")).length, 0);
  assert.equal(lineFor(sibling, "provoked-free-2"), "provoked-free-2: HTTP 410 — gone");
  assert.equal(protocolScoped(rowFor("wrong-shape-free")), true);
  assert.equal(lineFor(lines, "bad-format-free"), "bad-format-free: HTTP 400 — invalid request format");
  // the heuristic has to answer no for a row that names no other shape, or every
  // HTTP error would be suppressed by it
  assert.equal(protocolScoped(rowFor("bad-format-free")), false);
  assert.equal(protocolScoped({ says: "" }), false);
  assert.equal(protocolScoped({ says: "max_tokens is too large: 200000." }), false);
  // a status 0 is a question that was never answered, and being unable to ask is
  // not a finding about limits: only the table says what happened to that id
  assert.deepEqual(findings([{ id: "timeout-free", declared: {}, status: 0, says: "aborted due to timeout" }]), []);
});

test("a shape word alone is an ordinary refusal; protocol wording is a shape refusal", async () => {
  const { protocolScoped } = await subject();
  // The bare words belong to ordinary refusals about the request's own content:
  // this audit asked these questions and was refused, so the ids belong in the
  // candidate list. Dropping them was a silent false negative in the one list
  // the tool exists to produce.
  assert.equal(protocolScoped({ says: "messages: at least one message is required" }), false);
  assert.equal(protocolScoped({ says: "too many messages in the request" }), false);
  assert.equal(protocolScoped({ says: "the responses field must be an array" }), false);
  assert.equal(protocolScoped({ says: "invalid request format" }), false);
  // naming the vendor is not naming another shape either: an ordinary refusal
  // that happens to come through Anthropic is still an ordinary refusal
  assert.equal(protocolScoped({ says: "Anthropic API error: invalid request format" }), false);
  // a shape word tied to protocol, endpoint or api wording is the route saying
  // another shape is what this id speaks, which this audit cannot ask with
  assert.equal(protocolScoped({ says: "Model does not support this protocol." }), true);
  assert.equal(protocolScoped({ says: "This model speaks the messages protocol." }), true);
  assert.equal(protocolScoped({ says: "Use the /v1/messages endpoint for this model." }), true);
  assert.equal(protocolScoped({ says: "responses api required" }), true);
  assert.equal(protocolScoped({ says: "Anthropic Messages API error" }), true);
});

test("one upstream model declared twice, unlike, makes the smaller declaration the candidate", async () => {
  const { findings } = await subject();
  // Rows as a run builds them, with the pair the plugin declares for each id.
  // These two are the ids that used to be this case's own example and are no
  // longer unlike: a 2026-10-19 sweep measured both at 343000/131072, so the
  // under-declaration this list existed to find between them is gone, and what
  // is left to test is the rule — the smaller declaration of two ids on one
  // upstream is the candidate.
  const rows = [
    { id: "big-pickle", declared: { context: 200000, output: 32000 }, status: 200, upstream: "mimo-v2.6-flash" },
    {
      id: "mimo-v2.6-flash-free",
      declared: { context: 343000, output: 131072 },
      status: 200,
      upstream: "mimo-v2.6-flash",
    },
  ];
  const lines = findings(rows);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^big-pickle: declared 200000\/32000, and mimo-v2\.6-flash is also served as mimo-v2\.6-flash-free \(343000\/131072\)$/,
  );
  // an id limits.mjs already carries evidence for is said once, not raised
  // again — and the table carries it per axis, so the covered set says which
  // axes: `big-pickle` carries a context entry and an output entry, so both of
  // its axes are settled and it is not raised.
  assert.deepEqual(findings(rows, new Set(["big-pickle:context", "big-pickle:output"])), []);
});

// The table is per axis and not per id: `ll-alpha-free` and
// `longcat-2.5-preview-free` carry an output entry and no context entry,
// `nemotron-3.5-lightning-free` carries a context entry and no output entry,
// and `space-bunny-free` carries an input entry only. An id the table covers on
// one axis is still open on the other, so a window the route names for it is
// new information — the finding this list exists to surface — and the covered
// set used to drop the whole row for it, without a word.
test("evidence for one axis is not evidence for another, so an open axis is still read", async () => {
  const { coveredAxes, findings } = await subject();
  const covered = coveredAxes();
  assert.equal(covered.has("ll-alpha-free:output"), true, "the table carries its output");
  assert.equal(covered.has("ll-alpha-free:context"), false, "and no context entry, so its window is open");
  assert.equal(covered.has("nemotron-3.5-lightning-free:context"), true, "and it carries a context entry");
  assert.equal(
    covered.has("nemotron-3.5-lightning-free:output"),
    false,
    "so its completion ceiling is open",
  );
  // The window the route names is raised: the catalogue declares another
  // number, and the table says nothing about this axis.
  assert.deepEqual(
    findings(
      [
        {
          id: "ll-alpha-free",
          declared: { context: 200000, output: 32000 },
          status: 400,
          window: 1048576,
          says: "",
        },
      ],
      covered,
    ),
    ["ll-alpha-free: a refusal named a window of 1048576, the catalogue declares 200000"],
  );
  // ...and the axis the table does carry is not raised again.
  assert.deepEqual(
    findings(
      [
        {
          id: "ll-alpha-free",
          declared: { context: 200000, output: 32000 },
          status: 400,
          ceiling: 131072,
          says: "",
        },
      ],
      covered,
    ),
    [],
    "the output axis is settled by the table, so it is not a question",
  );
  // An id the table settles on both axes is not asked for again at all.
  assert.deepEqual(
    findings(
      [
        {
          id: "deepseek-v4.1-flash-free",
          declared: { context: 200000, output: 32000 },
          status: 400,
          window: 1048576,
          ceiling: 131072,
          says: "",
        },
      ],
      covered,
    ),
    [],
    "both axes are settled, so the row is not read",
  );
});

// A model that does not speak the shape this audit asks with is said once,
// beside the ids that were not asked, and it must not sit in the candidate list
// — neither as a limit it never stated nor as a status line. The check used to
// come after the two comparisons, so a refusal that named another shape and
// also mentioned a number was reported as a ceiling or a window the route never
// stated, and the run counted it as answered.
test("a refusal for the id's shape is not a finding about limits, whatever number it names", async () => {
  const { findings, protocolScoped } = await subject();
  const row = {
    id: "other-shape-free",
    declared: { context: 200000, output: 32000 },
    status: 400,
    window: 1048576,
    ceiling: 131072,
    says: "This model speaks the messages protocol; its maximum context length is 1048576 tokens.",
  };
  assert.equal(protocolScoped(row), true, "the row names another shape");
  assert.deepEqual(findings([row]), [], "and it is not a finding about limits");
  // The same row with nothing named in it is the same answer: it was refused
  // for its shape, and that is said once, beside the ids that were not asked.
  assert.deepEqual(findings([{ ...row, window: undefined, ceiling: undefined }]), []);
});

test("a row refused for its shape is never also an under-declaration candidate", async () => {
  const { findings } = await subject();
  // The refused row still carries the upstream id the route answered with, but
  // it was asked the chat shape and said no, so its pair is not something the
  // route confirmed. Here it is the larger declaration in the group: measuring
  // the sibling against it would raise an under-declaration candidate off a row
  // that was never really asked, which is why the comparison is among the rows
  // this audit could speak for.
  const rows = [
    {
      id: "wrong-shape-free",
      declared: { context: 1048576, output: 131072 },
      status: 400,
      says: "Model does not support this protocol.",
      upstream: "mimo-v2.6-flash",
    },
    { id: "small-free", declared: { context: 200000, output: 32000 }, status: 200, upstream: "mimo-v2.6-flash" },
  ];
  assert.deepEqual(findings(rows), []);
  // the same two ids, both spoken for, and the smaller declaration is the
  // candidate again — so the silence above is the shape, not the group
  const asked = rows.map((row) => ({ ...row, status: 200, says: "" }));
  assert.deepEqual(findings(asked), [
    "small-free: declared 200000/32000, and mimo-v2.6-flash is also served as wrong-shape-free (1048576/131072)",
  ]);
});

test("the run/import question answers true, false, or an honest nothing", async () => {
  const { entryVerdict } = await subject();
  const here = new URL("./limits-audit.mjs", import.meta.url);
  const path = fileURLToPath(here);
  const other = fileURLToPath(import.meta.url);
  // the runtime's own flag is the direct answer, used as given and never second
  // guessed by the argv comparison
  assert.equal(entryVerdict({ main: true, url: here.href, argv: ["node", path] }), true);
  assert.equal(entryVerdict({ main: false, url: here.href, argv: ["node", path] }), false);
  assert.equal(entryVerdict({ main: false, url: here.href, argv: ["node", other] }), false);
  // a runtime without the flag falls back to argv[1], which names this file
  assert.equal(entryVerdict({ main: undefined, url: here.href, argv: ["node", path] }), true);
  // and a different file that exists is a different file
  assert.equal(entryVerdict({ main: undefined, url: here.href, argv: ["node", other] }), false);
  // no entry point named at all: there is nothing to compare against, and
  // "false" would be the confident silence that asks nothing and exits 0
  assert.equal(entryVerdict({ main: undefined, url: here.href, argv: ["node"] }), undefined);
  // a module that is not a file has no path to compare with argv[1]
  assert.equal(entryVerdict({ main: undefined, url: "data:text/javascript,", argv: ["node", path] }), undefined);
  // a realpath that cannot be read leaves the question open rather than
  // answering "different file": ENOENT here is not evidence about the import
  assert.equal(
    entryVerdict({ main: undefined, url: here.href, argv: ["node", join(tmpdir(), "limits-audit-not-here.mjs")] }),
    undefined,
  );
});

// The two cases below are about a file system that makes links, and the third is
// about the one that does not: when the fixture cannot be built the case has to
// be skipped, not reported as a pass. It was reported as a pass — the link call
// failed, a `console.error` was written where nobody looks, and the `return`
// jumped over every assertion — so a host that cannot make a junction certified
// a behaviour nothing had exercised. The branch is written once here, both cases
// take it, and what the runner was told is asserted by the case below: a report
// that is not a skip fails whether it is a `console.error` or a bare `return`.
//
// The answer has to be this function's own, because the two link calls cannot
// give one: `fs.symlinkSync` and `fs.linkSync` return `undefined` on success, so
// a caller reading `make()`'s value as "did this host make the link?" read a
// junction that was built as a host that will not build one — and both cases
// returned before their first assertion on every host, which is the
// report-without-verifying this pair of cases exists to prevent. `true` is the
// only answer that means the fixture was built; whether the link is really there
// is what the cases' own `statSync` assertions say.
//
// Which errors may become that skip is not decided here either: it is
// `unsupportedError`, imported from the module that ships, because a rule that
// lives only in a test file is a copy of a policy nobody applies. This function
// used to skip on EVERY error — including `EINVAL` and `EXDEV`, the two codes
// that mean the fixture itself is wrong — so a broken fixture reported a pass it
// never earned.
function linked(t, make, what) {
  try {
    make();
    return true;
  } catch (error) {
    // A host that will not make a link — an unprivileged Windows account, a
    // file system with no links — cannot be asked this question at all.
    const unsupported = unsupportedError(error);
    if (!unsupported) throw error;
    t.skip(`this host will not make ${what}: ${unsupported.message}`);
    return undefined;
  }
}

test("a junction naming this file is this file, not a different one", async (t) => {
  const { entryVerdict } = await subject();
  const real = fileURLToPath(new URL("./limits-audit.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "limits-audit-"));
  const link = join(dir, "linked");
  if (linked(t, () => symlinkSync(dirname(real), link, "junction"), "a junction") === undefined) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  // The fixture has to exist before it can prove anything: a link call that
  // answers without making one would fail below for a reason that is not the
  // module's, so it is said here as the fixture it is.
  assert.equal(statSync(link).isDirectory(), true, `the junction at ${link} has to exist`);
  try {
    const through = join(link, basename(real));
    // The module's own URL is the real path while argv[1] keeps the junction's
    // spelling, which is how the two spellings of one file arise in practice. A
    // raw string comparison answers "different file" here — "asked nothing,
    // exit 0" — which is the failure this function exists to prevent.
    assert.equal(entryVerdict({ main: undefined, url: pathToFileURL(through).href, argv: ["node", through] }), true);
    assert.equal(entryVerdict({ main: undefined, url: pathToFileURL(real).href, argv: ["node", through] }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two names for one file are one file, hard link or not", async (t) => {
  const { entryVerdict } = await subject();
  const dir = mkdtempSync(join(tmpdir(), "limits-audit-link-"));
  try {
    const one = join(dir, "one.mjs");
    const two = join(dir, "two.mjs");
    writeFileSync(one, "// one file, two names\n");
    if (linked(t, () => linkSync(one, two), "a hard link") === undefined) return;
    // ...and a link that was called for and is not there is a failed fixture
    // rather than an answer about anything.
    assert.equal(statSync(two).isFile(), true, `the hard link at ${two} has to exist`);
    // A hard link has no target to resolve, so realpath keeps the two names and
    // only file identity can say they are one file. A comparison that stopped at
    // the realpath would answer "different file" — "asked nothing, exit 0".
    assert.equal(entryVerdict({ main: undefined, url: pathToFileURL(one).href, argv: ["node", two] }), true);
    assert.equal(entryVerdict({ main: undefined, url: pathToFileURL(two).href, argv: ["node", one] }), true);
    // two files that are really two have different identities, and that is the
    // one case this may answer `false`
    const other = join(dir, "other.mjs");
    writeFileSync(other, "// a different file\n");
    assert.equal(entryVerdict({ main: undefined, url: pathToFileURL(one).href, argv: ["node", other] }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The third case, and the one the two above cannot state: what the runner is
// told when the fixture cannot be built. `linked` is called with a linking call
// that cannot succeed — the only way to reach that branch on a host that makes
// links — and the report it makes is what is asserted. A `console.error` here
// fails this case, and so does a `return` that reports nothing.
test("a fixture this host cannot build is skipped, never reported as a pass", async () => {
  const { entryVerdict } = await subject();
  const real = fileURLToPath(new URL("./limits-audit.mjs", import.meta.url));
  const asked = {};
  const reason = linked(
    { skip: (why) => (asked.reason = why) },
    () => {
      const error = new Error("EPERM: a symlink could not be created on this host");
      error.code = "EPERM";
      throw error;
    },
    "a junction",
  );
  assert.equal(reason, undefined, "nothing comes back for a fixture that was not built");
  assert.match(
    asked.reason,
    /^this host will not make a junction: EPERM: a symlink could not be created on this host$/,
    "the runner has to be told, in the words the junction case uses",
  );
  // ...and the answer a skipped case must not be mistaken for: with no entry
  // point named, the question stays open rather than answering "not this file",
  // which is the `false` that means "asked nothing, exit 0".
  assert.equal(entryVerdict({ main: undefined, url: pathToFileURL(real).href, argv: ["node"] }), undefined);
});

test("a fixture that is wrong is a failure here too, and never a skip", () => {
  // `linked` used to turn EVERY error into a skip, so a fixture that passed the
  // wrong arguments — EINVAL — or one that split itself across volumes — EXDEV
  // — reported a pass it never earned and read exactly like a host that cannot
  // make links. The codes that may become a skip are the shipped module's
  // decision (`unsupportedError`, imported above), and these two are not among
  // them.
  const asked = {};
  const t = { skip: (why) => (asked.reason = why) };
  for (const code of ["EINVAL", "EXDEV"]) {
    assert.throws(
      () =>
        linked(
          t,
          () => {
            const error = new Error(`${code}: the fixture is wrong`);
            error.code = code;
            throw error;
          },
          "a hard link",
        ),
      new RegExp(code),
      `${code} is a broken fixture, and it has to fail the case`,
    );
    assert.equal(asked.reason, undefined, `${code} must not become a skip`);
  }
});

test("an identity the file system will not give leaves the question open", async () => {
  const { sameFile } = await subject();
  const here = fileURLToPath(new URL("./limits-audit.mjs", import.meta.url));
  const other = fileURLToPath(import.meta.url);
  // `stat` is handed in because these are the identities this host cannot make:
  // an `ino` of 0 is a file system saying it has no identity to give, and a stat
  // that throws is one that cannot answer at all. Neither may become the `false`
  // that means "this file was not run".
  assert.equal(sameFile(here, other, () => ({ dev: 1n, ino: 2n })), true);
  assert.equal(sameFile(here, other, (at) => ({ dev: 1n, ino: at === here ? 2n : 3n })), false);
  assert.equal(sameFile(here, other, (at) => ({ dev: 1n, ino: at === here ? 2n : 0n })), undefined);
  assert.equal(
    sameFile(here, other, () => {
      throw new Error("ENOENT: the identity cannot be read");
    }),
    undefined,
  );
  // and with the file system's own answer, two different files really are two
  assert.equal(sameFile(here, other), false);
});

// A body as the network delivers it: one the platform owns, handing over a chunk
// per read. `pulled` is how much of the body the reader took and `released` says
// whether the rest was cancelled rather than left open — the two facts the
// retired test asserted about a reader it had built itself, now said by the
// stream the module really reads.
function streamOf(chunks, status = 400) {
  const seen = { pulled: 0, released: false };
  const body = new ReadableStream({
    pull(controller) {
      if (seen.pulled === chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[seen.pulled]);
      seen.pulled += 1;
    },
    cancel() {
      seen.released = true;
    },
  });
  return { seen, response: new Response(body, { status }) };
}

// The same bytes in pieces of `size`, for a body whose statement has to sit a
// known distance past the budget.
function pieces(bytes, size) {
  const out = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

// `streamOf` above hands out a body that ends. These are the two ways a body
// stops a read WITHOUT ending: one that hands over its bytes and then never
// answers again (`stall` — what limits.mjs's own 3 s deadline on the body is
// for, and the shape a connection dying mid-body takes), and one that fails
// outright (`fail`). Both leave the reader holding a prefix and its own flag
// saying the read stopped before the body did — the pair a length rule cannot
// tell apart from a body that ran past the budget.
//
// The stall waits on a promise this fixture owns rather than on one that can
// never settle: the reader's `cancel()` resolves it, so the fixture ends when
// the code under test gives up on it. A fixture whose `pull` never settles is
// indistinguishable from a read that hung, and leaves the stream — and the
// promise — behind for the life of the process; this one is over as soon as the
// read releases it, which is what `released` and `settled` below are for.
function unterminated(chunks, { stop, status = 400 }) {
  const seen = { pulled: 0, released: false, settled: false };
  let release;
  const body = new ReadableStream({
    pull(controller) {
      if (seen.pulled === chunks.length) {
        if (stop === "stall")
          return new Promise((resolve) => {
            release = () => {
              seen.settled = true;
              resolve();
            };
          });
        controller.error(new Error("the body failed before the budget"));
        return;
      }
      controller.enqueue(chunks[seen.pulled]);
      seen.pulled += 1;
    },
    cancel() {
      seen.released = true;
      release?.();
    },
  });
  return { seen, response: new Response(body, { status }) };
}

// `ask()` builds and sends its own request, so the one thing a test can hand it
// is the answer it gets back. `fetch` is swapped for one case and put back in
// `finally`: every test file of this run shares the process, so the global goes
// back as soon as the case is answered.
//
// A queue that runs out is the one fact this helper knows and its caller does
// not, so it is said here rather than left to the shape of a row. `ask()`
// catches everything a request can throw — that is what keeps one broken id from
// ending the run — so a bare `assert.ok` inside the stub was absorbed into a
// `status: 0` row, and a case that reached for an answer that was not queued
// went on to assert against whatever the row happened to be. What is thrown
// instead is named, and the caller checks for it after the run has finished:
// a shortfall is then this case's own failure and not an upstream error it
// mistook for one.
const EXHAUSTED = "fetch was called with no answer left in this case's queue";

async function answering(responses, run) {
  const real = globalThis.fetch;
  const sent = [];
  let shortfall = null;
  const stub = async (url, options) => {
    sent.push({ url: String(url), method: options?.method });
    if (!responses.length) {
      shortfall = new Error(`${EXHAUSTED} — after ${sent.length} call${sent.length === 1 ? "" : "s"}`);
      throw shortfall;
    }
    return responses.shift();
  };
  let result;
  try {
    // The patch goes on inside the `try` that takes it off. `fetch` is
    // process-global, and an assignment made outside the restore's own guard
    // outlives a failure between the two and becomes the process's fetch.
    globalThis.fetch = stub;
    result = await run();
  } finally {
    globalThis.fetch = real;
  }
  // Read after the run, because `ask()` would have caught anything thrown
  // inside it: a row built from this failure is not the run's answer about a
  // model, and a case that went on to assert against one proves nothing.
  assert.equal(shortfall, null, shortfall?.message ?? "");
  return { result, sent };
}

// The names `run()` asks with, from the same capture the module reads: `ask()`
// refuses a name the profile does not carry, so a test that passed names of its
// own would be asking as a caller this audit never is.
async function askingNames() {
  const { PROFILES } = await import("./core-tools.mjs");
  const generation = process.env.ZEN_GENERATION ?? "1.x";
  assert.ok(Object.hasOwn(PROFILES, generation), `the capture carries no ${generation} profile`);
  return [...PROFILES[generation].required];
}

const REFUSAL_SAYS = "漢 max_tokens is too large: 1000000. This model supports at most 131072 completion tokens.";
const REFUSAL_BODY = JSON.stringify({ error: { message: REFUSAL_SAYS } });

// The reader this used to test was a hand-built object that never said
// `done: true`, which is a body no response has. The reader is limits.mjs's now,
// so what is tested is the path `ask()` really takes — a response, a stream the
// platform owns, and the text that comes back out of it — and the two things the
// audit needs from it: a refusal arriving over several reads is decoded whole,
// and the budget is counted in characters rather than in bytes.
test("a refusal is read through ask()'s own reader, cut at the character budget and no further", async () => {
  const { ask, READ_BUDGET } = await subject();
  const names = await askingNames();
  const encoder = new TextEncoder();

  // The refusal's own text carries a three-byte character, and its bytes are
  // split across three reads. A reader that decoded each chunk on its own would
  // answer with replacement characters, so the quoted message — the one thing
  // this path exists to bring back — would not be the refusal's own words.
  const whole = encoder.encode(REFUSAL_BODY);
  const at = whole.indexOf(encoder.encode("漢")[0]);
  assert.ok(at > 0, "the fixture has to carry the multi-byte character");
  const split = await answering(
    [streamOf([whole.subarray(0, at + 1), whole.subarray(at + 1, at + 2), whole.subarray(at + 2)]).response],
    () => ask("split-free", names),
  );
  assert.equal(split.result.status, 400);
  assert.equal(split.result.ceiling, 131072, "a ceiling behind a character split across reads is still read");
  assert.equal(split.result.says, REFUSAL_SAYS, "and the refusal is handed back whole, not as replacement characters");

  // The refusal sits past the budget in bytes and inside it in characters: 1500
  // three-byte characters put it there, in a single read. The retired reader
  // compared `value.byteLength` against a budget it counted in characters
  // (measured: a 64-character budget stopped after 192 bytes of a 3-byte-per-
  // character body), so it cut this body at the byte budget — around character
  // 1365 — and the ceiling below was never read at all. The budget is the
  // module's own exported constant, not a literal: pinned to 4096 here, this
  // fixture would go on passing and go on meaning nothing the moment the
  // constant moved.
  const wide = "漢".repeat(1500) + REFUSAL_BODY;
  assert.ok(wide.length < READ_BUDGET, "the fixture has to be inside the character budget");
  assert.ok(encoder.encode(wide).length > READ_BUDGET, "and past the byte budget the retired reader cut at");
  const wideAnswer = await answering([streamOf([encoder.encode(wide)]).response], () => ask("wide-free", names));
  assert.equal(wideAnswer.result.ceiling, 131072, "the budget is characters, so the refusal is reached");
  assert.equal(wideAnswer.result.says, REFUSAL_SAYS);

  // A body that goes on past the budget: the refusal at its head is read, a
  // statement in its tail is not, and the rest is released rather than drained.
  const long = REFUSAL_BODY + "漢".repeat(5000) + " maximum context length is 999999 tokens. " + "漢".repeat(5000);
  const chunks = pieces(encoder.encode(long), 900);
  const past = streamOf(chunks);
  const pastAnswer = await answering([past.response], () => ask("long-free", names));
  assert.equal(pastAnswer.result.ceiling, 131072, "what is inside the budget is read");
  assert.equal(pastAnswer.result.window, undefined, "a window named past the budget is not read");
  assert.equal(past.seen.released, true, "the rest of the body is released rather than left open");
  assert.ok(
    past.seen.pulled < chunks.length,
    `the body must not be drained into the buffer (read ${past.seen.pulled} of ${chunks.length} chunks)`,
  );

  // Each case is one ask through ask()'s own path: a POST to the endpoint the
  // audit asks, not a helper called beside it.
  const sent = [...split.sent, ...wideAnswer.sent, ...pastAnswer.sent];
  assert.equal(sent.length, 3);
  for (const request of sent) {
    assert.equal(request.method, "POST");
    assert.match(request.url, /\/chat\/completions$/);
  }
});

// A 200 is the model's own prose, not a limit, so `ask()` reads it only far
// enough to stop the answer and then drops the reader. A change that read a
// served body to its end, or read one for a number, shows up here.
test("a 200 is read only far enough to stop the answer, and names no limit", async () => {
  const { ask } = await subject();
  const names = await askingNames();
  const prose = "Sure. " + "x".repeat(50_000) + " This model supports at most 262144 completion tokens.";
  const chunks = pieces(new TextEncoder().encode(prose), 1000);
  const served = streamOf(chunks, 200);
  const { result } = await answering([served.response], () => ask("answered-free", names));
  assert.equal(result.status, 200);
  assert.equal(result.ceiling, undefined, "a served body is not read for a ceiling");
  assert.equal(result.window, undefined);
  assert.equal(result.says, "");
  assert.equal(served.seen.released, true, "the answer is dropped rather than drained");
  assert.ok(
    served.seen.pulled < chunks.length,
    `the answer must not be read to its end (read ${served.seen.pulled} of ${chunks.length} chunks)`,
  );
});

// These rows are what a maintainer hand-edits LIMITS from, so a number the
// budget cut in half must not come back as a ceiling: it would be written into
// the table as a measurement nobody made. `readBoundedText` says whether it
// stopped before the body did, and limits.mjs's own cut-aware reader — the one
// `observeRouteStatement` uses — is what the audit asks now.
test("a number the budget cut short declares no limit, and the same number inside it does", async () => {
  const { ask, READ_BUDGET } = await subject();
  const names = await askingNames();
  const encoder = new TextEncoder();
  // The module's own budget, not a literal that agrees with it today: every case
  // below is about where the read stops, so a fixture built around a number this
  // file repeats would go on passing while testing nothing the audit does.
  const budget = READ_BUDGET;

  // A body whose `marker` ends on character `at` of the read, with a tail behind
  // it so the read stops at the budget rather than at the end of the body.
  const endingAt = (marker, at) =>
    "x".repeat(at - marker.length) + marker + " and the body goes on past the budget " + "y".repeat(3000);
  const asked = async (id, body) => {
    const chunks = pieces(encoder.encode(body), 1000);
    const stream = streamOf(chunks);
    const { result } = await answering([stream.response], () => ask(id, names));
    // the fixture says something about a cut read only if the read really was
    // cut: the body has to go on past where the reader stopped
    assert.equal(stream.seen.released, true, `${id}: the read has to stop and release the rest`);
    assert.ok(stream.seen.pulled < chunks.length, `${id}: the body has to go on past the budget`);
    return result;
  };

  // LongCat's wording ends with its ceiling, which is the one shape whose digits
  // can land exactly on the last character read: "…is not less or equal to
  // 262144", read as far as "…262144", may have had digits the budget cut off.
  const ceiling = "max_tokens: 1000000 is not less or equal to 262144";
  assert.equal(
    (await asked("cut-ceiling-free", endingAt(ceiling, budget))).ceiling,
    undefined,
    "a ceiling whose digits end on the cut is not a ceiling the route stated",
  );
  assert.equal(
    (await asked("whole-ceiling-free", endingAt(ceiling, budget - 1))).ceiling,
    262144,
    "the same wording one character inside the budget is a whole number and is read",
  );

  // The window wordings carry words after their digits, so their sentence has to
  // be complete inside the budget: the axes are read from the first `limit`
  // characters, and the one character past it is kept only to say the body went
  // on. A sentence that completes only on that extra character was not inside
  // the budget this audit declared, and is not a window the route named.
  const window = "maximum context length is 1048576 tokens";
  assert.equal(
    (await asked("cut-window-free", endingAt(window, budget + 1))).window,
    undefined,
    "a window sentence that only completes on the character past the budget is not read",
  );
  assert.equal(
    (await asked("whole-window-free", endingAt(window, budget))).window,
    1048576,
    "the same sentence complete inside the budget names its window",
  );
});

// The read's own cut flag, against the length rule it replaced. The test above
// always hands the reader a body that goes ON past the budget, and in that shape
// the two rules agree: the text is at least as long as the budget, so
// `text.length >= READ_BUDGET` and the reader's `over` are both true, and neither
// test can tell which one the audit asked. The shape that tells them apart is a
// read stopped SHORT of the budget — by the deadline, or by a body that fails —
// whose text happens to end on a number. `over` is true there because the read
// stopped before the body did; the length rule is false because the body never
// reached the budget. The real tree answers `undefined`, because the digits may
// have been cut and a number read a digit short is a measurement nobody made;
// the length rule answers the number as if the route had stated it. Measured:
// with `namedAxes(text, READ_BUDGET, text.length >= READ_BUDGET)` at
// limits-audit.mjs:267 the whole suite stayed green, so it is this case the file
// was missing.
test(
  "a read stopped short of the budget names no limit, even when its last characters are a number",
  { timeout: 15_000 },
  async () => {
    const { ask, READ_BUDGET } = await subject();
    const names = await askingNames();
    const encoder = new TextEncoder();
    const budget = READ_BUDGET;

    // LongCat's wording ends with its ceiling, so a read that stopped inside the
    // body can be holding a whole-looking number. Two things below say the read
    // is that kind of read rather than one the budget cut: the fixture is far
    // inside the budget, so the budget is not what stopped it, and the stream
    // says whether it was still open when the read gave up.
    const wording = "Upstream request failed: max_tokens: 1000000 is not less or equal to 2621";
    assert.ok(wording.length < budget, `the fixture has to be inside the budget (${wording.length})`);
    assert.match(wording, /\d$/, "the fixture has to end on the digits of its number");

    // Stopped by the module's own deadline: the body hands over the wording and
    // then never answers again. This is the shape the verifier measured — the
    // reader gave up mid-body with the digits already in hand, so nothing about
    // the length of what it read says the number was cut, and only the read's own
    // flag does.
    const stalled = unterminated([encoder.encode(wording)], { stop: "stall" });
    const stalledAnswer = await answering([stalled.response], () => ask("stalled-short-free", names));
    assert.equal(stalledAnswer.result.status, 400);
    assert.equal(
      stalled.seen.released,
      true,
      "the read has to give up on the wait rather than read the body to its end",
    );
    assert.equal(
      stalled.seen.settled,
      true,
      "and the fixture's own wait is over, because the read released it: a body that can never settle cannot be told from a read that hung",
    );
    assert.equal(
      stalledAnswer.result.says,
      wording,
      "the whole wording was in hand, so the length rule sees it as whole and the read's flag does not",
    );
    assert.equal(
      stalledAnswer.result.ceiling,
      undefined,
      "a number at the end of a read that stopped short is not a ceiling the route stated",
    );

    // The same disagreement from the other stop, and at no cost in time: a body
    // that fails instead of stalling. Same text in hand, same answer.
    const failed = unterminated([encoder.encode(wording)], { stop: "fail" });
    const failedAnswer = await answering([failed.response], () => ask("failed-short-free", names));
    assert.equal(failedAnswer.result.says, wording, "the whole wording was in hand here too");
    assert.equal(
      failedAnswer.result.ceiling,
      undefined,
      "a failed read names no ceiling either",
    );

    // One character further is the same case stated plainly: the digits really
    // were cut, and the number in hand is a whole number to the pattern and a
    // prefix of the route's own to a reader that knows the read stopped.
    const cutDigits = wording.slice(0, -1);
    assert.match(cutDigits, /\d$/, "this fixture ends inside the number");
    const cutAnswer = await answering(
      [unterminated([encoder.encode(cutDigits)], { stop: "fail" }).response],
      () => ask("cut-digits-free", names),
    );
    assert.equal(cutAnswer.result.says, cutDigits, "the digits that arrived are what the read holds");
    assert.equal(
      cutAnswer.result.ceiling,
      undefined,
      "and a number whose digits were cut is not a ceiling",
    );

    // The window axis for the same stopped shape. Said plainly: this half does
    // NOT distinguish the length rule from `over`. Both context wordings carry a
    // word after their digits (" tokens"), so the sentence has to be complete
    // inside the read for the pattern to match at all, and a read that stopped
    // inside the sentence names no window under either rule. It is here because
    // the shape is worth stating for both axes, not because it catches that
    // mutant — the ceiling assertions above are what do.
    const sentence = "maximum context length is 1048576 toke";
    assert.ok(sentence.length < budget, "the fixture has to be inside the budget");
    const cutSentence = unterminated([encoder.encode(sentence)], { stop: "fail" });
    const windowAnswer = await answering([cutSentence.response], () => ask("cut-sentence-free", names));
    assert.equal(
      windowAnswer.result.says,
      sentence,
      "the sentence the read stopped inside is what it holds",
    );
    assert.equal(
      windowAnswer.result.window,
      undefined,
      "a context sentence the read stopped inside names no window",
    );
  },
);

test("a request that cannot be built is that id's own row, not the end of the run", async () => {
  const { ask } = await subject();
  // A name in `required` with no entry in that profile's `tools` makes
  // `chatRequest` throw. Built outside the guard, that rejected the whole
  // `Promise.all` batch: the audit asked nothing, and the entry point printed
  // "unable to ask … check the network" — a broken fingerprint reported as a
  // transport failure. Inside it, the id gets its own status-0 row. Nothing is
  // sent: the request is refused before it exists.
  const answer = await ask("any-free", ["no-such-tool-in-any-profile"]);
  assert.equal(answer.status, 0);
  assert.match(answer.says, /has no tool named "no-such-tool-in-any-profile" in fingerprint\.json/);
  assert.equal(answer.upstream, undefined);
  assert.equal(answer.ceiling, undefined);
});

// What a fixture that ran out of answers is not: a row about a model. `ask()`
// catches everything a request can throw — that is what keeps one broken id from
// ending the run — so a helper that only *reported* the shortfall had it
// absorbed into a `status: 0` row and read back as an upstream error, which is
// the one thing a shortfall is not. `answering` names it and hands it on, and
// this is that promise: a case whose queue runs dry hears `EXHAUSTED` and not a
// row, so it cannot go on to assert against a status it never made.
test("an answer queue that runs dry is not a row about a model", async () => {
  const { ask } = await subject();
  const names = await askingNames();
  const { result } = await answering([], () => ask("nothing-queued-free", names)).then(
    (answered) => ({ result: answered }),
    (error) => {
      assert.match(error.message, /fetch was called with no answer left in this case's queue/);
      return { result: undefined };
    },
  );
  assert.equal(result, undefined, "the shortfall has to come back as itself, not as a row");
});

// The same shortfall through the whole helper, which is where the earlier shape
// of this test lived: two answers queued for one ask. The row the second ask
// built was `status: 0` with the shortfall's sentence in `says` — a transport
// error the run never had — and a case that asserted on the first row went on
// regardless. Read here as the failure it is.
test("a case that queued fewer answers than it was asked for fails on the shortfall", async () => {
  const { ask } = await subject();
  const names = await askingNames();
  const queued = [streamOf([new TextEncoder().encode(REFUSAL_BODY)]).response];
  await assert.rejects(
    () => answering(queued, () => Promise.all([ask("one-free", names), ask("two-free", names)])),
    { message: /fetch was called with no answer left/ },
    "a fixture that ran dry is the case's failure, not the second id's status",
  );
});

test("the pair a row is judged by is the plugin's, not the catalogue's under it", async () => {
  const { withEffective } = await subject();
  // `mimo-v2.6-flash-free` is declared 200000/32000 in the catalogue and
  // 375000/131072 by limits.mjs. The row has to carry the second pair, or the
  // table would print one number and the findings would compare another.
  const row = withEffective({
    id: "mimo-v2.6-flash-free",
    declared: { context: 200000, output: 32000 },
    status: 200,
  });
  assert.deepEqual(row.declared, { context: 200000, output: 32000 }, "the catalogue's own pair stays readable");
  assert.deepEqual(row.effective, { context: 375000, output: 131072 });
  // An id with no evidence is judged by its catalogue pair unchanged.
  const plain = withEffective({ id: "nothing-measured-free", declared: { context: 1000, output: 100 }, status: 200 });
  assert.deepEqual(plain.effective, { context: 1000, output: 100 });
});

test("a sibling is measured against the pair the plugin declares, not the catalogue's", async () => {
  const { findings, withEffective } = await subject();
  // Both rows share an upstream and the catalogue lists both at 200000/32000, so
  // a comparison over `declared` sees one pair, skips the group, and never raises
  // the sibling. The plugin's own pair is what the table prints and what a
  // sibling has to be measured against: 375000/131072 against 200000/32000 is
  // the under-declaration this list exists to find.
  const rows = [
    withEffective({ id: "mimo-v2.6-flash-free", declared: { context: 200000, output: 32000 }, status: 200, upstream: "up" }),
    withEffective({ id: "sibling-free", declared: { context: 200000, output: 32000 }, status: 200, upstream: "up" }),
  ];
  assert.deepEqual(findings(rows), [
    "sibling-free: declared 200000/32000, and up is also served as mimo-v2.6-flash-free (375000/131072)",
  ]);
  // and the pair printed beside it is the plugin's too, so the line cannot
  // contradict the table it sits under
  assert.equal(
    findings([rows[1], rows[0]]).some((line) => line.includes("(200000/32000)")),
    false,
  );
});

// A whole run, driven end to end: the listing, the catalogue, ask() and the exit
// code. The cases below are the ones the helpers beside them cannot state — the
// summary is written by `run` and the exit code is `run`'s own answer, so a test
// that reached only `findings` or `ask` could not say whether the two agree, and
// that agreement is the whole of finding F6.

// `run` prints; a test asserts on what it prints, so the writes are collected
// rather than left in the runner's output. Console is process-global, and every
// file of this run shares the process, so it goes back as soon as the case is
// answered.
async function captured(runIt) {
  const real = console.log;
  const lines = [];
  try {
    // As in `answering`: the patch is applied inside the `try` that restores it,
    // because console is process-global and every file of this run shares it.
    console.log = (...parts) => lines.push(parts.join(" "));
    await runIt();
    return lines;
  } finally {
    console.log = real;
  }
}

// Two prices the run asks about, and the free bodies it gets back. Ids no other
// case uses, so nothing here can be read off another case's row.
const RUN_IDS = ["audit-run-a-free", "audit-run-b-free"];
const RUN_CATALOG = {
  opencode: {
    models: {
      "audit-run-a-free": { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } },
      "audit-run-b-free": { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } },
    },
  },
};
// One run, with `fetch` and `console.log` injected, and the exit code read as
// the run left it. The code is process-global too: a case that leaves it at 1
// would fail the run the tests themselves live in, so what it was is put back
// before this returns and the answer is carried out separately. Both globals are
// patched inside the `try` that restores them, for the reason `answering` gives.
//
// The listing and the catalogue are parameters so a case can say what it knows
// about an id the shared fixture above does not carry; nothing else about the
// run changes.
async function auditRun(answers, run, { ids = RUN_IDS, catalog = RUN_CATALOG } = {}) {
  const real = globalThis.fetch;
  const realCode = process.exitCode;
  const sent = [];
  let stray = null;
  const stub = async (url, options = {}) => {
    const target = String(url);
    sent.push({ url: target, method: options.method });
    if (options.method !== "POST") {
      const body = target.endsWith("/models") ? { data: ids.map((id) => ({ id })) } : catalog;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // The id is a field of the request, not part of its path: the route names
    // one endpoint and the model travels in the body. Read from the bytes `ask`
    // really sent, so a case cannot answer for an id it was not asked about.
    const body = JSON.parse(String(options.body ?? "{}"));
    const id = ids.find((candidate) => candidate === body.model);
    if (id === undefined) {
      // Recorded for the read after the run, not asserted here: `ask()` catches
      // everything a request can throw — that is what keeps one broken id from
      // ending the run — so an `assert` in this position was absorbed into the
      // row as its `says`, and the case went on with a request it never queued
      // sitting in the run as a `status: 0` row about a model. `answering` above
      // states the same rule for a queue that runs dry.
      stray = new Error(`a request this run was not expected to make: ${target} ${body.model}`);
      throw stray;
    }
    const answer = answers[id];
    if (!answer) throw new Error("connection refused");
    return new Response(answer.body ?? REFUSAL_BODY, {
      status: answer.status ?? 400,
      headers: answer.headers ?? {},
    });
  };
  let lines;
  let code;
  try {
    globalThis.fetch = stub;
    lines = await captured(() => run());
    // read before the restore below, which is the last thing this helper does
    code = process.exitCode;
  } finally {
    globalThis.fetch = real;
    process.exitCode = realCode;
  }
  // Read after the run, for the reason above: a row built from this failure is
  // not the run's answer about a model, and a case that went on to assert
  // against one proves nothing about the request it never queued.
  assert.equal(stray, null, stray?.message ?? "");
  return { lines, sent, code };
}

// The one finding F6 is: a run where every id was refused, and every refusal
// named the ceiling it was refused for. That is the audit doing its job — the
// header says the exit code is about whether an id answered, and a refusal that
// states a limit is this tool's positive result — yet the run counted only
// `status === 200`, so it printed its candidate lines and then said "Nothing
// answered, so this says nothing about limits" and exited 1. The summary
// contradicted the table above it and both contradicted the rule at the top of
// the file. The exit code is asserted exactly, not merely for "not 1": a run
// that never said anything is a worse answer than either.
test("a run whose every id was refused with a limit named is a run that answered", async () => {
  const { run } = await subject();
  const { lines, sent, code } = await auditRun({ "audit-run-a-free": {}, "audit-run-b-free": {} }, run);
  const printed = lines.join("\n");
  // the run did happen: two asks, each a POST to the endpoint the audit asks
  assert.equal(sent.filter((request) => request.method === "POST").length, 2);
  for (const request of sent.filter((entry) => entry.method === "POST"))
    assert.match(request.url, /\/chat\/completions$/);
  // and what it printed is the candidate each refusal is worth
  assert.match(
    printed,
    /audit-run-a-free: the route names a ceiling of 131072 completion tokens, the catalogue declares 32000/,
  );
  // the two halves of the answer have to agree: a summary that says nothing was
  // learned, printed under a table of candidates, is the contradiction
  assert.equal(printed.includes("Nothing answered"), false, printed);
  assert.equal(printed.includes("says nothing about limits"), false, printed);
  assert.equal(code, 0, `the exit code has to say an id answered\n${printed}`);
});

// The other side of the same rule, which must not change: a run that reached
// nothing has learned nothing about limits, says so, and exits non-zero. The
// summary and the message are asserted word for word, because they are what the
// rule change had to leave alone.
test("a run that reached nothing still says so and exits non-zero", async () => {
  const { run } = await subject();
  const { lines, sent, code } = await auditRun({}, run);
  const printed = lines.join("\n");
  assert.equal(sent.filter((request) => request.method === "POST").length, 2, "the asks were made and failed");
  for (const id of RUN_IDS) assert.match(printed, new RegExp(`${id}\\s`), printed);
  assert.match(printed, /0 candidates:/);
  assert.match(printed, /Nothing answered, so this says nothing about limits\. Check the network or ZEN_BASE_URL and ask again\./);
  assert.equal(code, 1, `a run that answered nothing must not exit 0\n${printed}`);
});

// A refusal that names no limit is the third case, and it belongs with the
// second: a 400 whose words are about the request's own content is a question
// this audit asked and was refused, but it is no answer about a limit. Counted
// as one — by counting `says`, which every refusal carries — this run would exit
// 0, and the "nothing answered" sentence would be gone from a run that really
// did learn nothing.
test("a refusal that names no limit is not an answer about limits", async () => {
  const { run } = await subject();
  const body = '{"error":{"message":"invalid request"}}';
  const { lines, code } = await auditRun({ "audit-run-a-free": { body }, "audit-run-b-free": { body } }, run);
  const printed = lines.join("\n");
  // the refusal's own words reached the table, so the id really was refused and
  // the run really read what it said
  assert.equal(printed.includes("invalid request"), true, printed);
  // ...and none of that is a limit, so the run answered nothing
  assert.match(printed, /Nothing answered, so this says nothing about limits/);
  assert.equal(code, 1, `a refusal that states no limit answers nothing\n${printed}`);
});

// What the stub above must not do with a request it did not expect. `ask()`
// catches everything a request can throw — one broken id must not end the run —
// so an `assert` written where the stub answers was absorbed into the row as its
// `says`: the case went on with a request it had never queued sitting in the run
// as a `status: 0` row about a model, and only the counts at the end could have
// caught it. The diagnosis has to survive the run instead, which is what this
// asks for: an ask for an id outside the fixture, read as the case's own failure.
test("a request the run did not expect is the case's own failure, with its diagnosis", async () => {
  const { ask } = await subject();
  const names = await askingNames();
  const error = await auditRun({}, () => ask("stray-model-free", names)).then(
    () => null,
    (thrown) => thrown,
  );
  // Read through the rejection rather than `assert.rejects`, because what this
  // case has to say is what the failure says: an object handed to `assert.rejects`
  // is compared key by key, and the `message` of an `AssertionError` — the one a
  // failed `assert` inside the helper throws — is not compared as a pattern.
  assert.notEqual(
    error,
    null,
    "the helper returned normally: the request nothing queued was absorbed into a status: 0 row",
  );
  assert.match(
    error?.message ?? "",
    /^a request this run was not expected to make: .*stray-model-free/,
    "the failure has to name the request nothing queued",
  );
});

// An offered id named after a member of `Object.prototype` is an id, not a
// protocol. `bootstrapProtocols[id]` answered `constructor` out of the prototype
// — a function — so `run` read the id as one the snapshot places on a protocol
// this audit does not speak: it printed the id under "not asked, this audit asks
// the chat shape only", with a function for a protocol, and never asked it. The
// catalogue describes this id as free, so the audit is the only thing that
// speaks for it, and a name is not a reason to stop.
test("a free id named after Object.prototype is asked, not read as a protocol", async () => {
  const { run } = await subject();
  const id = "constructor";
  const row = { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } };
  const catalog = { opencode: { models: { [id]: row } } };
  const { lines, sent, code } = await auditRun({ [id]: {} }, run, { ids: [id], catalog });
  const printed = lines.join("\n");
  assert.equal(
    sent.filter((request) => request.method === "POST").length,
    1,
    `the audit has to ask the id it offers\n${printed}`,
  );
  assert.equal(printed.includes("not asked"), false, printed);
  assert.match(
    printed,
    /the route names a ceiling of 131072 completion tokens, the catalogue declares 32000/,
    printed,
  );
  assert.equal(code, 0, printed);
});

// What the run counts as free in the catalogue is models.mjs's own answer — the
// same one `offeredIds` reads — and not a match on the word. `/free/i` matched
// anywhere, so a paid id called `free-tier-model` was counted, and a `gone-free`
// the catalogue has retired was counted too: the line said the catalogue still
// describes models the plugin has stopped offering, which is exactly the drift
// between the two sets that this line exists to make visible.
test("the catalogue count is read with the same free rule the offered set is", async () => {
  const { run } = await subject();
  const catalog = {
    opencode: {
      models: {
        "audit-run-a-free": { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } },
        "free-tier-model": { cost: { input: 3, output: 10 }, limit: { context: 1000000, output: 384000 } },
        "gone-free": { lifecycle: "retired", cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } },
      },
    },
  };
  const { lines } = await auditRun({ "audit-run-a-free": {} }, run, {
    ids: ["audit-run-a-free"],
    catalog,
  });
  const printed = lines.join("\n");
  assert.match(
    printed,
    /the catalogue still describes 1\b/,
    "a paid id whose name contains free, and a retired free id, are not free ids the catalogue describes",
  );
});

// The base URL a deployment sets is a variable, and a trailing slash is what
// people write. Every URL this file builds is the base plus a path, so a base
// left with its slash asks for `//models` and `//chat/completions`: a route that
// does not answer those leaves the audit printing "the route or the catalogue
// could not be read … check the network and ZEN_BASE_URL" about a slash, and the
// operator checks their network. The rule is read as itself here, because the
// constant that uses it is fixed at load and would only ever answer for one
// spelling. `undefined` is the environment variable nobody set, which has to
// come back as the shipped base rather than as the string "undefined" — and an
// exported `ZEN_BASE_URL=` is the same fact written as an empty string.
test("a base URL with a trailing slash does not become a doubled path", async () => {
  const { baseFrom } = await subject();
  const { DEFAULT_BASE } = await import("./provider.mjs");
  assert.equal(typeof baseFrom, "function", "the base's own rule has to be stated where it can be asked about");
  assert.equal(baseFrom("https://opencode.ai/inference/v1/"), "https://opencode.ai/inference/v1");
  assert.equal(baseFrom("https://opencode.ai/inference/v1///"), "https://opencode.ai/inference/v1");
  assert.equal(baseFrom("https://opencode.ai/inference/v1"), "https://opencode.ai/inference/v1");
  assert.equal(baseFrom(undefined), DEFAULT_BASE, "nothing set is the shipped base, not the word");
  // `??` reads either of these as set, and the base used to become the empty
  // string: every URL below it then a relative path, fetched from nowhere and
  // reported as a network or catalogue failure about a variable nobody set.
  assert.equal(baseFrom(""), DEFAULT_BASE, "an empty base is no base at all");
  assert.equal(baseFrom("   "), DEFAULT_BASE, "and neither is one that names nothing but whitespace");
  assert.equal(`${baseFrom("")}/models`, `${DEFAULT_BASE}/models`, "the URL built from it is still absolute");
  // Whitespace around a base is a typo, not a different host. The trimmed text
  // is what is used, so the trailing-slash strip fires and the URL built from
  // it is the one the operator meant — the raw text used to keep its spaces,
  // and the audit fetched `https://host/%20/models`, which is a 404 reported as
  // "the route or the catalogue could not be read … check the network".
  assert.equal(
    baseFrom("  https://opencode.ai/inference/v1/  "),
    "https://opencode.ai/inference/v1",
    "a base written with spaces around it is the base without them",
  );
  // The rest of provider.mjs's `httpURL` rule, which this base has to answer
  // too: a base carrying credentials, a query or a fragment is refused there,
  // and pasted into the middle of a URL here it fails the same unexplained
  // way. It is refused in a sentence of its own, rather than becoming a URL
  // that cannot be fetched.
  for (const value of [
    "https://user:pass@opencode.ai/inference/v1",
    "https://opencode.ai/inference/v1?key=1",
    "https://opencode.ai/inference/v1#section",
  ])
    assert.throws(
      () => baseFrom(value),
      /ZEN_BASE_URL/,
      `${value} names no base this tool can use, and says so`,
    );
  // And a base that is not a URL at all says so, rather than becoming a
  // relative path fetched from nowhere.
  assert.throws(() => baseFrom("opencode.ai/inference/v1"), /ZEN_BASE_URL is not a URL/);
  // and the reason the rule exists, in the URLs this file really builds
  for (const value of ["https://opencode.ai/inference/v1/", "https://opencode.ai/inference/v1"]) {
    const models = `${baseFrom(value)}/models`;
    const asked = `${baseFrom(value)}/chat/completions`;
    assert.equal(models, "https://opencode.ai/inference/v1/models", models);
    assert.equal(asked, "https://opencode.ai/inference/v1/chat/completions", asked);
    assert.equal(models.slice(models.indexOf("://") + 3).includes("//"), false, models);
  }
});

// The catalogue writes `null` for a row it could not fill in. `offeredIds` has
// always answered a missing row with the id's own name; the count of what the
// catalogue describes passed the row straight to `isFree`, whose `isRetired(null)`
// threw there — before the first id was asked — and the entry point reported the
// whole audit as an unreadable route. A row that names itself free is offered by
// its name and counted; a row that does not is simply not free.
test("a catalogue row written as null does not end the audit's own count", async () => {
  const { run } = await subject();
  const catalog = JSON.parse(JSON.stringify(RUN_CATALOG));
  catalog.opencode.models["null-row"] = null;
  catalog.opencode.models["null-row-free"] = null;
  const { lines, code } = await auditRun(
    { "audit-run-a-free": {}, "audit-run-b-free": {} },
    run,
    { catalog },
  );
  const printed = lines.join("\n");
  // Two fixture ids name themselves free; the null row that does not is not
  // counted, and the null row that does is — the same fallback `offeredIds` reads.
  assert.match(
    printed,
    /2 free ids are offered; the catalogue still describes 3/,
    `the count has to survive a null row:\n${printed}`,
  );
  assert.equal(code, 0, `the run answered, so a null row must not change the exit code:\n${printed}`);
});

// The fallback row the catch builds has to be a row like any other. Without
// `effective`, the print loop read `effective.context` and threw, turning one
// failed id into the end of the table — and without the catalogue's `declared`,
// the sibling note printed `undefined`. `rowLine` is the loop, exported so both
// halves can be asked about without making `withEffective` fail on demand.
test("a row that could not be built is printed like every other row", async () => {
  const { failedRow, rowLine } = await subject();
  const row = failedRow({
    id: "failed-row-free",
    catalogue: { limit: { context: 200000, output: 32000 }, canonical_model_id: "weights" },
    answer: { status: 0, says: "the upstream said no" },
    error: new Error("could not resolve the pair"),
  });
  assert.deepEqual(row.declared, { context: 200000, output: 32000 }, "the catalogue's pair is kept");
  assert.equal(row.canonical, "weights", "and so is the name the second opinion is looked up by");
  assert.deepEqual(row.effective, {}, "nothing was resolved, so the plugin's column stays empty");
  assert.equal(
    row.says,
    "the upstream said no (row: could not resolve the pair)",
    "the route's sentence is kept, and the bookkeeping reason is said beside it",
  );

  const line = rowLine(row);
  assert.match(line, /^! failed-row-free/, line);
  assert.match(line, /—\/—/, `an unresolved pair prints as dashes:\n${line}`);
  assert.match(line, /\(catalogue 200000\/32000\)/, `and the catalogue's pair is still shown:\n${line}`);
  assert.match(line, /could not resolve the pair/, line);

  // The tolerance itself: a row with neither pair at all — the shape a failure
  // before any bookkeeping leaves — is one line of dashes, not a TypeError.
  const bare = rowLine({ id: "bare-free", status: 0, says: "nothing was built" });
  assert.match(bare, /^! bare-free/, bare);
  assert.match(bare, /—\/—/, bare);
  assert.match(bare, /nothing was built/, bare);
});

// A malformed `ZEN_BASE_URL` used to throw while the module was being evaluated,
// before the entry point's own `try/catch`: the operator got a stack trace about
// an import instead of the sentence that names the variable. The base is parsed
// when the run asks for it now, so the entry reports it and sets exit code 1.
// A subprocess, because the throw was in module evaluation; no request is made
// — the base fails before the listing is fetched.
test("a malformed ZEN_BASE_URL is the entry point's sentence, not an import stack", () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const run = spawnSync(process.execPath, ["limits-audit.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ZEN_BASE_URL: "ftp://opencode.ai/inference/v1" },
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.status, 1, `a base that cannot be used is a failed run:\n${output}`);
  assert.match(output, /unable to ask/, `the entry point has to say it could not ask:\n${output}`);
  assert.match(output, /ZEN_BASE_URL/, `and name the variable that is wrong:\n${output}`);
  assert.equal(/\n\s+at /.test(output), false, `the report is a sentence, not a stack trace:\n${output}`);
});

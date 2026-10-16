import assert from "node:assert/strict";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  assert.equal(lines.filter((line) => line.startsWith("provoked-free")).length, 0);
  assert.equal(lineFor(lines, "narrow-free"), "narrow-free: a refusal named a window of 1048576, the catalogue declares 200000");
  assert.equal(lineFor(lines, "silent-free"), "silent-free: HTTP 400 — invalid request");
  assert.equal(lineFor(lines, "dead-free"), "dead-free: HTTP 410 — Model has been deprecated.");
  // a model that speaks another protocol is said once, beside the ids that were
  // not asked, and never sits in this list as a finding. The rows are named, not
  // counted from the end: appending one must not retarget these assertions.
  assert.equal(lines.filter((line) => line.startsWith("wrong-shape-free")).length, 0);
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

test("a junction naming this file is this file, not a different one", async () => {
  const { entryVerdict } = await subject();
  const real = fileURLToPath(new URL("./limits-audit.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "limits-audit-"));
  const link = join(dir, "linked");
  try {
    symlinkSync(dirname(real), link, "junction");
  } catch (error) {
    // A host that will not make a link still has to run the rest of this file.
    rmSync(dir, { recursive: true, force: true });
    console.error(`skipped the junction case: ${error?.message ?? error}`);
    return;
  }
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

test("two names for one file are one file, hard link or not", async () => {
  const { entryVerdict } = await subject();
  const dir = mkdtempSync(join(tmpdir(), "limits-audit-link-"));
  try {
    const one = join(dir, "one.mjs");
    const two = join(dir, "two.mjs");
    writeFileSync(one, "// one file, two names\n");
    try {
      linkSync(one, two);
    } catch (error) {
      // A file system that will not make a hard link still has to run the rest
      // of this file.
      console.error(`skipped the hard-link case: ${error?.message ?? error}`);
      return;
    }
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

test("a refusal is read to the budget and no further, and the reader is released", async () => {
  const { readPrefix } = await subject();
  const encoder = new TextEncoder();
  const body = (chunk) => {
    const seen = { read: 0, cancelled: false };
    return {
      seen,
      response: {
        body: {
          getReader: () => ({
            read: async () => {
              seen.read += 1;
              return { value: chunk, done: false };
            },
            cancel: async () => {
              seen.cancelled = true;
            },
          }),
        },
      },
    };
  };
  // a body that goes on for ever: the read has to stop at the budget, whatever
  // is still waiting behind it
  const many = body(encoder.encode("x".repeat(1024)));
  assert.equal((await readPrefix(many.response, 4096)).length, 4096);
  assert.equal(many.seen.read, 4);
  assert.equal(many.seen.cancelled, true);
  // one chunk can be the whole body, and decoding it whole would materialise the
  // megabytes this path exists to avoid: only what the budget still wants is read
  const huge = body(encoder.encode("y".repeat(1_000_000)));
  const cut = await readPrefix(huge.response, 64);
  assert.equal(cut.length, 64);
  assert.equal(huge.seen.read, 1);
  assert.equal(huge.seen.cancelled, true);
  // a body with no reader to cancel is small by construction and still bounded
  assert.equal(await readPrefix({ body: null, text: async () => "z".repeat(100) }, 10), "z".repeat(10));
});

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
  // `deepseek-v4.1-flash-free` is declared 200000/32000 in the catalogue and
  // 1048576/384000 by limits.mjs, so a row carrying both pairs is where the two
  // numbers can be confused. The candidate lines say "the catalogue declares X",
  // which is the catalogue's own pair; they used to read `judgement(row)`, the
  // effective one, and so printed limits.mjs's override as the catalogue's
  // number for every id the table does not already cover.
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
function unterminated(chunks, { stop, status = 400 }) {
  const seen = { pulled: 0, released: false };
  const body = new ReadableStream({
    pull(controller) {
      if (seen.pulled === chunks.length) {
        if (stop === "stall") return new Promise(() => {});
        controller.error(new Error("the body failed before the budget"));
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

// `ask()` builds and sends its own request, so the one thing a test can hand it
// is the answer it gets back. `fetch` is swapped for one case and put back in
// `finally`: every test file of this run shares the process, so the global goes
// back as soon as the case is answered.
async function answering(responses, run) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), method: options?.method });
    assert.ok(responses.length, "ask() asked more often than this case queued answers");
    return responses.shift();
  };
  try {
    return { result: await run(), sent };
  } finally {
    globalThis.fetch = real;
  }
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
  const { ask } = await subject();
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

  // The refusal sits past 4096 bytes and inside 4096 characters: 1500 three-byte
  // characters put it there, in a single read. The retired reader compared
  // `value.byteLength` against a budget it counted in characters (measured: a
  // 64-character budget stopped after 192 bytes of a 3-byte-per-character body),
  // so it cut this body at 4096 bytes — around character 1365 — and the ceiling
  // below was never read at all.
  const wide = "漢".repeat(1500) + REFUSAL_BODY;
  assert.ok(wide.length < 4096, "the fixture has to be inside the character budget");
  assert.ok(encoder.encode(wide).length > 4096, "and past the byte budget the retired reader cut at");
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
  const { ask } = await subject();
  const names = await askingNames();
  const encoder = new TextEncoder();
  const budget = 4096;

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
    const { ask } = await subject();
    const names = await askingNames();
    const encoder = new TextEncoder();
    const budget = 4096;

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

test("the pair a row is judged by is the plugin's, not the catalogue's under it", async () => {
  const { withEffective } = await subject();
  // `deepseek-v4.1-flash-free` is declared 200000/32000 in the catalogue and
  // 1048576/384000 by limits.mjs. The row has to carry the second pair, or the
  // table would print one number and the findings would compare another.
  const row = withEffective({
    id: "deepseek-v4.1-flash-free",
    declared: { context: 200000, output: 32000 },
    status: 200,
  });
  assert.deepEqual(row.declared, { context: 200000, output: 32000 }, "the catalogue's own pair stays readable");
  assert.equal(row.effective.context, 1048576);
  assert.equal(row.effective.output, 384000);
  // An id with no evidence is judged by its catalogue pair unchanged.
  const plain = withEffective({ id: "nothing-measured-free", declared: { context: 1000, output: 100 }, status: 200 });
  assert.deepEqual(plain.effective, { context: 1000, output: 100 });
});

test("a sibling is measured against the pair the plugin declares, not the catalogue's", async () => {
  const { findings, withEffective } = await subject();
  // Both rows share an upstream and the catalogue lists both at 200000/32000, so
  // a comparison over `declared` sees one pair, skips the group, and never raises
  // the sibling. The plugin's own pair is what the table prints and what a
  // sibling has to be measured against: 1048576/384000 against 200000/32000 is
  // the under-declaration this list exists to find.
  const rows = [
    withEffective({ id: "deepseek-v4.1-flash-free", declared: { context: 200000, output: 32000 }, status: 200, upstream: "up" }),
    withEffective({ id: "sibling-free", declared: { context: 200000, output: 32000 }, status: 200, upstream: "up" }),
  ];
  assert.deepEqual(findings(rows), [
    "sibling-free: declared 200000/32000, and up is also served as deepseek-v4.1-flash-free (1048576/384000)",
  ]);
  // and the pair printed beside it is the plugin's too, so the line cannot
  // contradict the table it sits under
  assert.equal(
    findings([rows[1], rows[0]]).some((line) => line.includes("(200000/32000)")),
    false,
  );
});

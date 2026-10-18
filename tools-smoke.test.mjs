import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  check,
  fileIdentity,
  isEntryPoint,
  refusedSummary,
  requestFor,
} from "./tools-smoke.mjs";
import { agentFor } from "./core-tools.mjs";

// The question "was this file run, or is it being imported" is what stands
// between the gate asking Zen and the gate reporting success without asking, so
// every answer it can give is pinned here. `isEntryPoint` takes both sides as
// arguments, which is why a junction, a hard link and an entry that is gone can
// be pinned in this process instead of spawned in another one. Nothing here
// reaches the network: no request is sent and no fetch is called.

const gate = new URL("./tools-smoke.mjs", import.meta.url);

// One scratch directory per test, and the whole of its life in one place: a test
// added later cannot forget the cleanup, and the layout is changed once. Both
// bodies here are async, so the helper awaits — a `withScratch` that did not
// would hand the directory back while the body was still using it and let a
// later `rm` race it.
async function withScratch(body) {
  const root = mkdtempSync(join(tmpdir(), "tools-smoke-"));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The errors a host gives when it cannot make a link at all — no privilege for a
// symlink, a file system without hard links, a Windows that has neither — as
// opposed to an error this fixture made by mistake. Only these may become a
// skip; anything else has to fail, because a case that silently does nothing is
// a case that reports success without checking.
//
// `EINVAL` was in this list and is not any more, because it is the one code here
// that a mistake in the fixture can produce. Neither `link` nor `symlink` lists
// EINVAL among its errors — a file system that cannot make links answers ENOSYS,
// ENOTSUP or EPERM — while an invalid argument is exactly what EINVAL means, so
// the code that says "this host cannot do it" is also the code that says "these
// arguments are wrong". Read as unsupported, a fixture that passed the wrong
// arguments would skip instead of failing, and a skipped case is one that reports
// success without checking anything.
//
// `EXDEV` was in this list for the same wrong reason, and it is the more
// dangerous of the two to leave in, because it is the code most likely to arrive
// from a genuinely broken fixture. It means the two paths are on different mounts
// or volumes — a statement about where the fixture put its files, not about what
// the host can do. No host can hard-link across a volume, so a fixture whose two
// halves landed on different drives would be skipped as "this host cannot make
// links" on a host that makes them perfectly well: a broken fixture reporting
// success having checked nothing. It is in the failure list below, and `EXDEV`
// must stay out of this one.
//
// The codes that are left are the ones a host with no links to give answers
// with; nothing else may become a skip.
const UNSUPPORTED = ["EPERM", "EACCES", "ENOSYS", "ENOTSUP"];

function unsupportedError(error) {
  return UNSUPPORTED.includes(error?.code) ? error : undefined;
}

test("the file that was run is that file, and a different file is not", () => {
  // The spelling the loader resolves to, handed back as argv[1].
  assert.equal(isEntryPoint({ argv1: fileURLToPath(gate), moduleUrl: gate.href }), true);
  // A relative spelling is the same file: argv[1] is absolutized against the
  // working directory, and `resolve` here does the same.
  assert.equal(
    isEntryPoint({ argv1: relative(process.cwd(), fileURLToPath(gate)), moduleUrl: gate.href }),
    true,
  );
  // A different file that exists is a different file, and that is the one answer
  // this may give `false` to.
  assert.equal(isEntryPoint({ argv1: fileURLToPath(gate), moduleUrl: import.meta.url }), false);
});

test("a junction naming the file that was run is still that file", async (t) => {
  await withScratch(async (root) => {
    const target = join(root, "target");
    mkdirSync(target);
    const module = join(target, "mod.mjs");
    writeFileSync(module, "");
    const link = join(root, "link");
    try {
      // On Windows this is the link a run is actually reached through: a
      // directory junction needs no administrator rights where a file symlink
      // does.
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const unsupported = unsupportedError(error);
      // A host that will not make this link cannot ask this question. The skip
      // has to reach the runner: `console.error` is not a skip signal, and the
      // case would otherwise be reported as a pass it never earned — while this
      // and the hard link below are the only things that tell a `true` reached
      // through two spellings from the `false` that asks nothing and exits 0.
      if (unsupported) {
        t.skip(`this host cannot make the junction: ${unsupported.message}`);
        return;
      }
      throw error;
    }
    // What the loader hands the module is the resolved target while argv[1]
    // keeps the junction's spelling: two strings that differ while this is still
    // the file that was run. Comparing them raw answers "not this file", which is
    // a gate that asks nothing and exits 0.
    assert.equal(
      isEntryPoint({ argv1: join(link, "mod.mjs"), moduleUrl: pathToFileURL(module).href }),
      true,
    );
  });
});

test("a hard link naming the file that was run is still that file", async (t) => {
  await withScratch(async (root) => {
    const module = join(root, "mod.mjs");
    writeFileSync(module, "");
    const hard = join(root, "hard.mjs");
    try {
      linkSync(module, hard);
    } catch (error) {
      const unsupported = unsupportedError(error);
      // A file system without hard links cannot be asked this question; the
      // junction above still covers the two-spellings-of-one-file case.
      if (unsupported) {
        t.skip(`this host cannot make the hard link: ${unsupported.message}`);
        return;
      }
      throw error;
    }
    // A hard link has no target for realpath to resolve, so the two paths stay
    // different strings and only the file's identity says they are one file.
    // Both files are in the same scratch directory, so that identity is readable
    // on any host that made the link at all: `fileIdentity` answers `undefined`
    // only for an inode of 0, and the case below pins that reading directly
    // rather than leaving it to a host this suite cannot conjure.
    assert.equal(
      isEntryPoint({ argv1: hard, moduleUrl: pathToFileURL(module).href }),
      true,
    );
  });
});

test("an identity the file system will not report is left open, not called a different file", () => {
  // The other answer the hard-link branch can give. `isEntryPoint` reads an
  // identity from both sides and answers `undefined` — never `false` — when
  // either read is missing, because `false` is the answer that makes the gate ask
  // nothing and exit 0. A host that reports an inode of 0 for a real file cannot
  // be produced here on demand and `node:fs` cannot be substituted for it (the
  // namespace is not configurable under Bun), so the rule that decides it is
  // called with the numbers instead: this is the half of the hard-link case that
  // the live one cannot reach, and it is the half that must never read as "a
  // different file".
  assert.equal(fileIdentity({ dev: 1n, ino: 0n }), undefined, "an inode of 0 is no identity to give");
  assert.equal(fileIdentity({ dev: 1n, ino: 0n }) === undefined, true);
  // And the reading that does identify a file, so the two are not one answer.
  assert.equal(fileIdentity({ dev: 1n, ino: 42n }), "1:42");
  assert.equal(fileIdentity({ dev: 2n, ino: 42n }), "2:42", "the device is part of the identity");
  assert.notEqual(fileIdentity({ dev: 1n, ino: 42n }), fileIdentity({ dev: 2n, ino: 42n }));
  // The real files this process can see report one, which is what makes the
  // hard-link case above execute its assertion rather than fall through it.
  assert.notEqual(
    fileIdentity(statSync(fileURLToPath(import.meta.url), { bigint: true })),
    undefined,
    "this host reports inodes, so the hard-link case is not skipped for this reason",
  );
});

test("a different file that exists is a different file", async () => {
  await withScratch(async (root) => {
    const one = join(root, "one.mjs");
    const other = join(root, "other.mjs");
    writeFileSync(one, "");
    writeFileSync(other, "");
    assert.equal(
      isEntryPoint({ argv1: one, moduleUrl: pathToFileURL(other).href }),
      false,
    );
  });
});

test("a broken fixture throws instead of skipping, through the same catch the link cases use", async (t) => {
  // A fixture's own mistake, driven through the same `try`/`catch`/`throw` the two
  // link cases are built on: a source file that was never written, which this
  // platform answers ENOENT for. `unsupportedError` does not call that
  // unsupported, so it is thrown — which is the whole point, since a fixture whose
  // mistake skipped would report a pass it never earned and would read exactly
  // like a host that cannot make links. The classification above is what decides
  // it; this is that decision arriving at the runner as a failure rather than
  // being swallowed.
  await withScratch(async (root) => {
    const missing = join(root, "never-written.mjs");
    const link = join(root, "hard.mjs");
    assert.throws(
      () => {
        try {
          linkSync(missing, link);
        } catch (error) {
          const unsupported = unsupportedError(error);
          if (unsupported) {
            t.skip(`this host cannot make the hard link: ${unsupported.message}`);
            return;
          }
          throw error;
        }
        // Only reachable if the link was made from a source that was never
        // written, which is the fixture being wrong in a way this cannot name.
        assert.fail("linking a file that does not exist must raise, and it did not");
      },
      /ENOENT/,
      "a fixture's own mistake has to reach the runner as a failure",
    );
  });
});

test("the skip list holds the codes a host without links answers with, and nothing else", () => {
  // The rule itself, read off the list — not an observation of a host that could
  // not make a link. Nothing in this file has ever seen a skip: this machine makes
  // symlinks, junctions and hard links, so the branch that skips has never run
  // here and a name claiming otherwise would be the same kind of overclaim as an
  // assertion that holds for the wrong reason. What is checked is the
  // classification `unsupportedError` applies, which is what decides whether a
  // link failure becomes a skip or a failure: a host with no links to give answers
  // with one of these codes, and everything else — EINVAL included, which is how
  // the fixture's own argument mistakes arrive — has to fail the case. The
  // `undefined` and code-less entries are the same answer for the same reason:
  // nothing about them says the host cannot do it.
  for (const code of ["EPERM", "EACCES", "ENOSYS", "ENOTSUP"])
    assert.equal(unsupportedError({ code })?.code, code, `${code} is a code that may become a skip`);
  for (const error of [
    { code: "EINVAL", message: "invalid argument" },
    // The cross-device code, which is a statement about where the fixture put
    // its files rather than about the host: two paths on different volumes cannot
    // be hard-linked anywhere, so this arriving here is a fixture that split
    // itself across volumes. Skipping it would report a pass for a case whose
    // fixture never worked, which is what the comment above the list is about.
    { code: "EXDEV", message: "cross-device link" },
    { code: "ENOENT", message: "no such file or directory" },
    { code: "EEXIST", message: "file already exists" },
    { code: "ERR_INVALID_ARG_VALUE", message: "Symlink type must be one of ..." },
    { message: "an error with no code at all" },
    undefined,
  ])
    assert.equal(
      unsupportedError(error),
      undefined,
      `${JSON.stringify(error?.code ?? error)} must fail the case, not skip it`,
    );
});

test("no entry point named at all is not a run of this file", () => {
  // `node -e`, a REPL, a worker: nothing was named as a script, so there is no
  // run for this module to be part of. This is the state the gate has always
  // answered `false` to, and it stays `false`.
  assert.equal(isEntryPoint({ argv1: undefined, moduleUrl: gate.href }), false);
});

test("a question that cannot be answered is left open, never answered no", async () => {
  await withScratch(async (root) => {
    const module = join(root, "mod.mjs");
    writeFileSync(module, "");
    // An entry that is gone: realpath throws ENOENT, and `false` here would be
    // the confident silence that asks nothing and exits 0.
    assert.equal(
      isEntryPoint({
        argv1: join(root, "gone", "mod.mjs"),
        moduleUrl: pathToFileURL(module).href,
      }),
      undefined,
    );
    // A module URL that names nothing on disk is the same kind of nothing.
    assert.equal(isEntryPoint({ argv1: module, moduleUrl: "data:text/javascript," }), undefined);
  });
});

test("a name in required with no tool behind it is refused when the request is built", () => {
  // Why the gate has a `malformed` verdict at all: the request cannot be built,
  // so nothing is asked about the fingerprint and the file it came from is what
  // has to change. Sending it anyway is what used to blame the wording for a
  // tool entry the profile never carried.
  const profile = { tools: { read: { name: "read" } } };
  assert.throws(
    () => requestFor("2.x", profile, ["read", "shell"]),
    /2\.x has no tool named "shell" in fingerprint\.json/,
  );
});

test("the gate asks with the body the plugin sends, not a shape of its own", () => {
  // The gate's own header says its tools come from the same `required` the plugin
  // stands in, "so this cannot report on a shape the plugin does not send". Only
  // the throwing path was pinned, so a dropped wrapper, a reordered list or a
  // deduplicated one would leave the gate reporting on wording Zen never received
  // while every test stayed green.
  const profile = {
    agent: { opencode: "2.0.29", channel: "latest", client: "cli" },
    tools: { read: { name: "read", description: "r" }, shell: { name: "shell", description: "s" } },
  };
  const { headers, body } = requestFor("2.x", profile, ["shell", "read"]);
  // One `{ type: "function", function: tool }` per name, in the order asked for.
  assert.deepEqual(
    body.tools,
    [
      { type: "function", function: profile.tools.shell },
      { type: "function", function: profile.tools.read },
    ],
    "the gate must send each named tool once, wrapped and in order",
  );
  assert.equal(body.stream, true, "the gate asks for a stream, as the plugin does");
  assert.equal(body.model, process.env.ZEN_CHECK_MODEL ?? "space-bunny-free");
  // And the headers are the plugin's own, which is the other half of the claim.
  assert.equal(headers.get("user-agent"), agentFor("2.x"));
  assert.equal(headers.get("accept"), "*/*");
});

test("every answer the gate reads is let go of, not left dangling", async () => {
  // Why this case exists: the success path used to return on `response.ok`
  // without reading or releasing the body, so the gate held a connection open for
  // a verdict it already had — provider.mjs releases the body of a response it
  // does not read, and this path did not. `fetch` is stubbed rather than asked,
  // and the real `Response` class is kept: an unread body has to be released by
  // the code under test, and a fake body would only prove the fake was called.
  //
  // `check` is called the way the fan-out calls it, with a profile and a name
  // list, so what is pinned is the gate's own path and not a copy of it.
  const box = (body, message = "nope") => {
    let cancels = 0;
    let reads = 0;
    Object.defineProperty(body, "body", {
      configurable: true,
      value: {
        cancel: () => {
          cancels++;
          return Promise.resolve();
        },
      },
    });
    body.text = () => {
      reads++;
      return Promise.resolve('{"error":{"message":' + JSON.stringify(message) + "}}");
    };
    return { response: body, tally: () => ({ cancels, reads }) };
  };
  const profile = { tools: { read: { name: "read", description: "r" } } };
  const ask = async (answer) => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      if (answer.throws) throw new Error(answer.throws);
      return answer.box.response;
    };
    try {
      const result = await check("1.x", profile, "floor", () => ["read"]);
      return { result, tally: answer.box.tally() };
    } finally {
      globalThis.fetch = original;
    }
  };

  const served = box(new Response("", { status: 200 }));
  const answered = await ask({ box: served });
  assert.equal(answered.result.verdict, "answered");
  assert.deepEqual(
    answered.tally,
    { cancels: 1, reads: 0 },
    "an answered body is released without being read",
  );

  // A 426 is the other answer whose detail owes the body nothing: Zen wanting a
  // newer OpenCode is said by the status, and the sentence the verdict carries is
  // written here rather than quoted from the response. It is released the same
  // way, and for the same reason, as the answered one.
  const moved = box(new Response("", { status: 426 }));
  const superseded = await ask({ box: moved });
  assert.equal(superseded.result.verdict, "superseded");
  assert.equal(superseded.result.detail, "Zen wants a newer OpenCode than this profile claims");
  assert.deepEqual(
    superseded.tally,
    { cancels: 1, reads: 0 },
    "a superseded body is released without being read",
  );

  for (const [status, verdict] of [[403, "refused"], [500, "failed"]]) {
    const released = box(new Response("", { status }));
    const other = await ask({ box: released });
    assert.equal(other.result.verdict, verdict, `HTTP ${status} is ${verdict}`);
    assert.deepEqual(
      other.tally,
      { cancels: 0, reads: 1 },
      "a body carrying the refusal is consumed exactly once, by the read that explains it",
    );
  }

  // The detail a refusal carries, and the empty message that used to build one
  // ending in a bare colon and a space — a detail that reads as a message that
  // was cut off rather than as the absent one it is. The quantifier requires the
  // message to say something, so an empty one is the same answer as no message
  // at all. The body is the same in every other respect, so the difference is
  // the message and nothing else.
  const said = box(new Response("", { status: 403 }), "stale fingerprint");
  const named = await ask({ box: said });
  assert.equal(named.result.detail, "HTTP 403: stale fingerprint");
  const empty = box(new Response("", { status: 403 }), "");
  const blank = await ask({ box: empty });
  assert.equal(
    blank.result.detail,
    "HTTP 403",
    "an empty message must not be reported as a message",
  );

  const lost = box(new Response("", { status: 403 }));
  const unreachable = await ask({ box: lost, throws: "the network is down" });
  assert.equal(unreachable.result.verdict, "unreachable");
  assert.deepEqual(
    unreachable.tally,
    { cancels: 0, reads: 0 },
    "a request that never arrived has no body to release",
  );
});

test("a summary names what the rows actually said, never a refusal that did not happen", () => {
  // The exit-0 branch was taken whenever fewer floors were served than asked,
  // which also covers a floor that came back `unreachable`: an
  // [answered, unreachable] run read "Some are refused", pointing the reader at
  // the wording and at `capture` when the network was the problem. The same
  // wording is built here from the verdicts the rows carry.
  const mixed = refusedSummary({ served: 1, total: 2, unbuilt: [], unserved: ["unreachable"] });
  assert.match(mixed, /1 not served/);
  assert.equal(/refused/.test(mixed), false, `an unreachable floor is not a refusal: ${mixed}`);
  // Both kinds are counted as what they were.
  const both = refusedSummary({ served: 1, total: 3, unbuilt: [], unserved: ["refused", "unreachable"] });
  assert.match(both, /1 refused, 1 not served/);
  // A request that could not be built was never asked, and is said that way —
  // outside "of N", which is the floors something was asked of. `total` is
  // ignored: the denominator is counted from the rows, because the number a
  // caller passes can be one the sentence cannot use. The unbuilt list holds
  // rows, not verdict words: the gate hands over what its fan-out produced, so
  // the shape here is the shape a real run passes and not an abbreviation only
  // this sentence accepts.
  const never = {
    generation: "1.x",
    shape: "floor",
    verdict: "malformed",
    detail: "floor: no tool",
  };
  const malformed = refusedSummary({
    served: 1,
    total: 3,
    unbuilt: [never],
    unserved: ["refused", "unreachable"],
  });
  assert.match(malformed, /1 served, 1 refused, 1 not served of 4 asked, 1 never asked/);
  assert.match(malformed, /fingerprint\.json has to gain/);
  // The closing sentence claims every generation this plugin knows is served,
  // and that is only what the rows said when every floor was asked. Here one was
  // never asked, so the run proves the plugin works — the claim it may make —
  // and says nothing about the generation nothing was asked of.
  assert.match(malformed, /^At least one generation was served/, malformed);
  assert.equal(
    /still has a generation Zen will serve/.test(malformed),
    false,
    `a generation that was never asked cannot be said to work: ${malformed}`,
  );
  // And the claim is made where it is true: every floor asked and answered.
  const all = refusedSummary({ served: 2, unbuilt: [], unserved: [] });
  assert.match(
    all,
    /^At least one generation works, so the plugin still has a generation Zen will serve\./,
  );
  assert.match(all, /2 served of 2\./);
  // Nothing served: the all-refused reading is only for rows that really were.
  assert.match(
    refusedSummary({ served: 0, total: 2, unbuilt: [], unserved: ["refused", "superseded"] }),
    /Zen has moved past every generation/,
  );
  assert.match(
    refusedSummary({ served: 0, total: 1, unbuilt: [], unserved: ["unreachable"] }),
    /could not be reached at all/,
  );
  // A 5xx is not a verdict on the fingerprint, and must not be said as one.
  assert.match(
    refusedSummary({ served: 0, total: 1, unbuilt: [], unserved: ["failed"] }),
    /none of them with a verdict on the fingerprint/,
  );
});

test("a floor that was never asked is named once, not as a refusal as well", () => {
  // The two call sites disagreed about which verdicts `unserved` held. The one
  // taken when at least one floor was answered passed the malformed floor
  // through, so a run of one malformed floor and one answered one printed "1 not
  // served, 1 never asked of 2": one floor, two verdicts, and a denominator that
  // counted a request nothing was ever asked of. Both arguments are passed here
  // exactly as that call site built them — the malformed row in `unbuilt` *and*
  // its verdict in `unserved` — because that is the input the sentence has to
  // survive.
  const row = { generation: "1.x", shape: "floor", verdict: "malformed", detail: "floor: no tool" };
  const mixed = refusedSummary({ served: 1, unbuilt: [row], unserved: ["malformed"] });
  assert.match(mixed, /1 served of 2 asked, 1 never asked/, mixed);
  assert.equal(
    /\bnot served\b|\brefused\b/.test(mixed),
    false,
    `nothing was refused in this run, so nothing may be said as refused: ${mixed}`,
  );
  assert.equal(
    (mixed.match(/never asked/g) ?? []).length,
    1,
    `the malformed floor is one floor and gets one name: ${mixed}`,
  );

  // The other half of the same run: a floor that really was refused keeps its
  // name, and the malformed one is still only "never asked" — never both.
  const refusedToo = refusedSummary({ served: 0, unbuilt: [row], unserved: ["refused", "malformed"] });
  assert.match(refusedToo, /1\/2 floor requests were never asked/, refusedToo);
  assert.equal(
    (refusedToo.match(/never asked/g) ?? []).length,
    1,
    `a malformed floor must not also be counted as another name: ${refusedToo}`,
  );
  assert.equal(
    /\brefused\b/.test(refusedToo),
    false,
    `the refused floor was not asked about either, so the run still says nothing about the fingerprint: ${refusedToo}`,
  );

  // With a floor answered, the refused one is named as refused and the malformed
  // one as never asked: two floors, two names, three numbers that add up.
  const servedToo = refusedSummary({ served: 1, unbuilt: [row], unserved: ["refused", "malformed"] });
  assert.match(servedToo, /1 served, 1 refused of 3 asked, 1 never asked/, servedToo);
  assert.equal(
    (servedToo.match(/never asked/g) ?? []).length,
    1,
    `the malformed floor gets one name: ${servedToo}`,
  );

  // Nothing was unbuilt, so nothing may be said to have been unasked: a summary
  // that reaches for the phrase anyway names a floor no row reported.
  const clean = refusedSummary({ served: 1, unserved: ["unreachable"] });
  assert.equal(/never asked/.test(clean), false, clean);
});

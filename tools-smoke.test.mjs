import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryPoint, refusedSummary, requestFor } from "./tools-smoke.mjs";
import { PROFILES, agentFor } from "./core-tools.mjs";

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
const UNSUPPORTED = ["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EXDEV", "EINVAL"];

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
    assert.equal(
      isEntryPoint({ argv1: hard, moduleUrl: pathToFileURL(module).href }),
      true,
    );
  });
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
  // A request that could not be built was never asked, and is said that way.
  const malformed = refusedSummary({ served: 1, total: 3, unbuilt: ["x"], unserved: ["refused", "unreachable"] });
  assert.match(malformed, /1 refused, 1 not served, 1 never asked/);
  assert.match(malformed, /fingerprint\.json has to gain/);
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

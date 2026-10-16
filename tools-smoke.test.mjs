import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryPoint, requestFor } from "./tools-smoke.mjs";

// The question "was this file run, or is it being imported" is what stands
// between the gate asking Zen and the gate reporting success without asking, so
// every answer it can give is pinned here. `isEntryPoint` takes both sides as
// arguments, which is why a junction, a hard link and an entry that is gone can
// be pinned in this process instead of spawned in another one. Nothing here
// reaches the network: no request is sent and no fetch is called.

const gate = new URL("./tools-smoke.mjs", import.meta.url);

// One scratch directory per test. A junction's target is made inside the same
// directory rather than pointed at this tree, so even a delete that followed a
// link could only reach the fixture.
function scratch() {
  return mkdtempSync(join(tmpdir(), "tools-smoke-"));
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

test("a junction naming the file that was run is still that file", () => {
  const root = scratch();
  try {
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
      console.error(`skipped the junction case: ${error?.message ?? error}`);
      return;
    }
    // What the loader hands the module is the resolved target while argv[1]
    // keeps the junction's spelling: two strings that differ while this is still
    // the file that was run. Comparing them raw answers "not this file", which is
    // a gate that asks nothing and exits 0.
    assert.equal(
      isEntryPoint({ argv1: join(link, "mod.mjs"), moduleUrl: pathToFileURL(module).href }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hard link naming the file that was run is still that file", () => {
  const root = scratch();
  try {
    const module = join(root, "mod.mjs");
    writeFileSync(module, "");
    const hard = join(root, "hard.mjs");
    try {
      linkSync(module, hard);
    } catch (error) {
      // A filesystem without hard links cannot be asked this question; the
      // junction above still covers the two-spellings-of-one-file case.
      console.error(`skipped the hard link case: ${error?.message ?? error}`);
      return;
    }
    // A hard link has no target for realpath to resolve, so the two paths stay
    // different strings and only the file's identity says they are one file.
    assert.equal(isEntryPoint({ argv1: hard, moduleUrl: pathToFileURL(module).href }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a different file that exists is a different file", () => {
  const root = scratch();
  try {
    const one = join(root, "one.mjs");
    const other = join(root, "other.mjs");
    writeFileSync(one, "");
    writeFileSync(other, "");
    assert.equal(isEntryPoint({ argv1: one, moduleUrl: pathToFileURL(other).href }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no entry point named at all is not a run of this file", () => {
  // `node -e`, a REPL, a worker: nothing was named as a script, so there is no
  // run for this module to be part of. This is the state the gate has always
  // answered `false` to, and it stays `false`.
  assert.equal(isEntryPoint({ argv1: undefined, moduleUrl: gate.href }), false);
});

test("a question that cannot be answered is left open, never answered no", () => {
  const root = scratch();
  try {
    const module = join(root, "mod.mjs");
    writeFileSync(module, "");
    // An entry that is gone: realpath throws ENOENT, and `false` here would be
    // the confident silence that asks nothing and exits 0.
    assert.equal(
      isEntryPoint({ argv1: join(root, "gone", "mod.mjs"), moduleUrl: pathToFileURL(module).href }),
      undefined,
    );
    // A module URL that names nothing on disk is the same kind of nothing.
    assert.equal(isEntryPoint({ argv1: module, moduleUrl: "data:text/javascript," }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

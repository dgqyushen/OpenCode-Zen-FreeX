// The Bun this repository runs at, asserted from one place.
//
// Three things name it: the `packageManager` field in package.json, the
// `BUN_VERSION` environment value both workflows pin, and the `bun` that is
// actually on PATH. Nothing else compares them, so an upgrade on one side
// alone would leave the suite and the gate running on a Bun the project no
// longer declares, and nothing would fail.
//
// The version is compared in each of the three places, not the spelling of the
// field: the manager the field names is checked apart from the version after
// its `@`, so the check does not rest on the field reading exactly `bun@<pin>`
// while claiming to be about the version alone.
//
// The field is read with Bun rather than the runner image's `node`, so the
// step that holds the run to one runtime is not itself run by an undeclared
// third one.
//
// Usage: bun assert-bun-version.mjs <version>
//
// This is a maintenance tool: a host never loads it, so it is not part of the
// published tarball.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = new URL("./package.json", import.meta.url);
const expected = process.argv[2];

if (!expected) {
  console.error("usage: bun assert-bun-version.mjs <version>");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(fileURLToPath(here), "utf8"));
const field = manifest?.packageManager;

// The manager is named apart from the version, so a field that names another
// manager is told apart from one that names this manager with the wrong
// version. The two are different mistakes and the message says which.
const manager = typeof field === "string" ? field.split("@")[0] : undefined;
const declared = typeof field === "string" ? field.split("@")[1] : undefined;

if (manager !== "bun") {
  console.error(
    `package.json declares ${JSON.stringify(field ?? null)}, which does not name the Bun this workflow pins; declare it as bun@${expected}.`,
  );
  process.exit(1);
}
if (declared !== expected) {
  console.error(
    `package.json declares Bun ${declared} while this workflow pins ${expected}; bump both together.`,
  );
  process.exit(1);
}

// The version that is actually on PATH: the pin and the version `setup-bun`
// resolved were otherwise never compared, and a mismatch would leave the
// report describing a runtime the project does not declare.
const actual = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "";

if (actual !== expected) {
  console.error(
    `package.json declares Bun ${declared} and this workflow pins ${expected}, but the Bun that just ran is ${actual}; bump both together.`,
  );
  process.exit(1);
}

console.log(`Bun ${actual} is the one package.json declares.`);

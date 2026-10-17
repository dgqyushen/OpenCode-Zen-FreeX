// Asks Zen which of the client generations this package still speaks.
//
// The gate moved more than once in a day, and nothing short of asking it says
// so: a stale fingerprint does not look different from a working one until a
// user is refused. This is the check to run before a release, and whenever a
// report comes in that the free tier answers 403.
//
//   bun run check:gate
//
// Each profile is asked twice, because the plugin sends two shapes and Zen
// does not answer them alike:
//
//   floor  the names in `required`, which is what the plugin stands in for a
//          host that is not OpenCode and has none of these tools by name. This
//          is the shape the plugin exists to send, so it is the one that
//          decides the answer.
//   full   every tool the profile carries, which is what a host that is
//          OpenCode itself sends. It is reported for what it says about a
//          wording that has gone stale, and does not decide the exit code.
//
// Asking only the full shape hid a real gap: `read` alone is served and
// everything but `read` is refused, so a Zen that started insisting on another
// name would leave the full shape passing while the shape the plugin actually
// sends was refused.
//
// Every request here is built by the plugin itself: the header names come from
// provider.mjs's outboundHeaders and the tools from the same `required` the
// plugin stands in, so this cannot report on a shape the plugin does not send.
// A copy of the headers is what it used to ask with, and that copy had drifted -
// it was missing `accept` - with nothing failing on it.
//
// Each request is reported as:
//
//   answered   Zen served the request; this shape is current
//   refused    Zen did not recognise this generation (403)
//   superseded Zen wants a newer OpenCode than the one this profile claims (426)
//   failed     Zen answered something other than 403: the request was made, and
//              what came back is not a verdict on the fingerprint
//   malformed  the request could not be built, because a name in `required` has
//              no entry in that profile's `tools`: nothing was asked about the
//              fingerprint, and fingerprint.json is what has to change
//   unreachable the free tier could not be asked at all
//
// Exit code is 0 when at least one generation's floor is answered. A generation
// being refused is not a failure while another still works, and `malformed` is
// not an answer either: it is a defect in fingerprint.json, and the gate names
// that instead of sending the reader to the network.

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILES, agentFor } from "./core-tools.mjs";
import { DEFAULT_BASE, opencodeID, outboundHeaders } from "./provider.mjs";

// The endpoint, from the one place that owns it: a copy here was a second answer
// that drifted the moment the endpoint moved — this gate would probe the old host
// and report `unreachable` while the plugin asked the new one. The trailing
// slashes are stripped because the plugin puts the value through `httpURL`, which
// does the same: `ZEN_BASE_URL=https://…/v1/` must not become `//chat/completions`.
const BASE = (process.env.ZEN_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
const MODEL = process.env.ZEN_CHECK_MODEL ?? "space-bunny-free";

// A session id of the shape OpenCode makes, since that is part of what is asked.
// It is provider.mjs's own `opencodeID` rather than a copy of it: the id is one
// of the things Zen judges, and a second implementation of it is a second thing
// to keep right.
function sessionID() {
  return opencodeID("ses", true);
}

// Zen gives the same sentence whichever part of a request failed to look like
// OpenCode, so it is worth printing: a refusal that arrives with no message at
// all reads as something other than a stale fingerprint.
function says(text) {
  const match = text.match(/"message"\s*:\s*"([^"]{0,120})"/);
  return match ? `: ${match[1]}` : "";
}

// The request a shape is asked with. It is its own function so index.test.mjs
// can hold it against the request the plugin was observed to send, offline, and
// so limits-audit.mjs asks with the same shape this gate does instead of a copy
// of it — a copy is what drifted before (it was missing `accept`).
export function requestFor(generation, profile, names) {
  return chatRequest({ model: MODEL, generation, profile, names, maxTokens: 40 });
}

export function chatRequest({ model, generation, profile, names, maxTokens = 40, messages }) {
  return {
    headers: outboundHeaders({
      session: sessionID(),
      agent: agentFor(generation),
      project: "global",
      protocol: "chat",
    }),
    body: {
      model,
      messages: messages ?? [{ role: "user", content: "hi" }],
      // A name in `required` that the profile does not carry is a broken
      // fingerprint, not a request to ask Zen with: without this it is sent as
      // `{"type":"function"}`, Zen refuses it as malformed, and the gate blames
      // the wording instead of the file it came from.
      tools: names.map((name) => {
        const tool = profile.tools[name];
        if (!tool) throw new Error(`${generation} has no tool named "${name}" in fingerprint.json`);
        return { type: "function", function: tool };
      }),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
    },
  };
}

// A request that could not be built at all: a name in `required` with no entry
// in that profile's `tools`, or a profile that cannot even name its shapes. It
// is reported as a verdict rather than thrown, because one broken profile must
// not silence the report — the other generations still have to be asked, and
// what is wrong with this one is a file rather than a service.
function malformed(generation, shape, error) {
  return { generation, shape, verdict: "malformed", detail: `${shape}: ${error.message}` };
}

// `namesOf` is a function because naming the tools is part of building the
// request, and building it is what the guarded region is for: a profile that
// names a tool it does not carry is this generation+shape's verdict rather than
// a rejection into the fan-out that would leave every other generation unasked.
async function check(generation, profile, shape, namesOf) {
  let request;
  try {
    request = requestFor(generation, profile, namesOf());
  } catch (error) {
    return malformed(generation, shape, error);
  }
  const { headers, body } = request;
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    // The status is the verdict; the body only ever explains one. Reading it
    // first made a 200 whose body was cut — a reset mid-stream, or the 30s
    // timeout firing while it was still arriving — look like `unreachable`,
    // "the free tier could not be reached at all", for a request Zen had
    // answered. Nothing is read on the success path either: a body nobody reads
    // is a body nobody has to receive.
    if (response.ok)
      return { generation, shape, verdict: "answered", detail: `as ${headers.get("user-agent")}` };
    if (response.status === 426)
      return {
        generation,
        shape,
        verdict: "superseded",
        detail: "Zen wants a newer OpenCode than this profile claims",
      };
    // A body that cannot be read leaves the status standing: a 403 whose body
    // was lost is still a 403, and `says` has nothing to add to it.
    const text = await response.text().catch(() => "");
    // Only a 403 is the answer this gate reads: Zen quoting the fingerprint
    // back. A 5xx, a 429 or a 401 says something about the service or the way
    // it was asked, and reading any of them as "the fingerprint is stale" sends
    // the reader to `capture` over a problem capturing cannot fix.
    if (response.status === 403)
      return { generation, shape, verdict: "refused", detail: `HTTP 403${says(text)}` };
    return { generation, shape, verdict: "failed", detail: `HTTP ${response.status}${says(text)}` };
  } catch (error) {
    return { generation, shape, verdict: "unreachable", detail: error.message };
  }
}

// Whether this module is the file that was run rather than one the tests
// import. `import.meta.main` is the direct answer and the one Bun gives, but it
// arrived in Node 22.18 and nothing before that has it — and a gate that cannot
// tell whether it was run is a gate that reports success without asking.
function invokedDirectly() {
  // `typeof` rather than `??`: a runtime without the property throws on the
  // member access itself, where there is nothing to fall back from.
  if (typeof import.meta.main === "boolean") return import.meta.main;
  // The runtime gave no answer, so the paths have to. Both sides are arguments
  // to `isEntryPoint` below, which is where the question is actually decided.
  return isEntryPoint({ argv1: process.argv[1], moduleUrl: import.meta.url });
}

/**
 * Whether `moduleUrl` is the file `argv1` named: `true` it was run, `false` it
 * was not, `undefined` that could not be told. Both sides are arguments so
 * tools-smoke.test.mjs can pin the shapes that would otherwise need a second
 * process — a junction, a hard link, an entry that is gone — against the same
 * code a real run takes rather than a copy of it.
 *
 * The invariant this file exists to protect is that no path through it asks
 * nothing and exits 0, which is a gate reporting success without asking. So
 * `false` is only for a *proven* different file, and everything this cannot
 * settle is `undefined`, which prints the message and exits non-zero: an
 * uncertain answer must never be read as "this file was not run".
 */
export function isEntryPoint({ argv1, moduleUrl }) {
  // Nothing was named as a script, so there is no run for this module to be
  // part of: this is `node -e` or a REPL importing it, which is the one case
  // where asking nothing is the right answer.
  if (argv1 === undefined) return false;

  let self;
  let run;
  try {
    self = resolve(fileURLToPath(moduleUrl));
    run = resolve(argv1);
  } catch {
    // A module URL that names nothing on disk (`data:`, an eval), or an entry
    // that is not a path at all: there is nothing to compare.
    return undefined;
  }
  if (self === run) return true;

  // A path is a spelling, and one file has several. `import.meta.url` is already
  // resolved by the loader while `argv[1]` is whatever was typed, so a symlink
  // or a Windows directory junction arrives here as two different strings while
  // this is still the file that was run. Comparing what both point at is what
  // tells a junction from a test import.
  let resolved;
  try {
    resolved = [realpathSync(self), realpathSync(run)];
  } catch {
    // Either path could not be resolved — an entry that is gone, a URL that is
    // not a file — so which file was run is not a question this can answer.
    return undefined;
  }
  if (resolved[0] === resolved[1]) return true;

  // Two names for one file that realpath cannot join: a hard link has no target
  // to resolve, so it stays two paths on disk. File identity is what is left to
  // tell it from a different file, and it is only read when both sides report
  // one: an `ino` of 0 is a filesystem saying it has no identity to give (some
  // FUSE and network mounts), and comparing those would call two different files
  // one file — a `true` that makes an import ask Zen. Where the identity cannot
  // be read at all, the question stays open rather than answered "different
  // file", because after this branch a differing realpath is not proof either.
  const identity = (at) => {
    const stats = statSync(at, { bigint: true });
    return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
  };
  let ids;
  try {
    ids = [identity(self), identity(run)];
  } catch {
    return undefined;
  }
  if (ids[0] === undefined || ids[1] === undefined) return undefined;
  return ids[0] === ids[1];
}

// Only a run asks Zen. index.test.mjs imports this module to hold its request
// against the plugin's, and an import must not reach the network. That import is
// the only way past this line that asks nothing: a run is `true`, and anything
// this could not settle (`undefined`) exits above rather than reaching it.
const entry = invokedDirectly();
if (entry === undefined) {
  console.error(
    "Could not tell whether this file was run or imported, so nothing was asked: neither import.meta.main nor process.argv[1] named an entry point. Run it with `bun run check:gate`.",
  );
  process.exit(1);
}

// The one-line summary of a run in which the floor was not served everywhere it
// was asked. `served` is how many floors were answered, `unbuilt` how many could
// not be built, and `unserved` the verdicts of the rest — which are *not* all
// refusals: a floor can come back `unreachable` or `failed`, and calling those
// refused is what pointed the reader at the wording, and at `capture`, over an
// outage. Exported so a test can pin the wording without asking Zen.
//
// A `malformed` verdict belongs to `unbuilt` and nowhere else. A floor whose
// request could not be built was never asked, so it is not one of the verdicts
// to count, and `total` here is the number of floors something was actually
// asked of: a `total` that counted the unasked ones made the one-line summary
// name a single floor twice — `1 not served, 1 never asked of 2` for a run with
// one malformed floor and one answered one — which is two names for one row and
// a denominator that does not add up. The rows still print every floor and say
// which is which; this is the sentence that counts them.
export function refusedSummary({ served, unbuilt = [], unserved = [] }) {
  // The two call sites below used to disagree about which verdicts `unserved`
  // held — one left `malformed` out, the other passed it straight through — so
  // the split is made here, from the rows the caller has, rather than trusted to
  // two places that can drift apart. A caller cannot mis-count a malformed floor
  // into the refusals if the only list that carries verdicts has none in it.
  const verdicts = unserved.filter((verdict) => verdict !== "malformed");
  // Asked floors are the denominator: the ones that came back with a verdict and
  // the ones that could not be built. Anything else was never asked, and asking
  // nothing is not a way to be not served.
  const total = served + verdicts.length + unbuilt.length;
  if (!served) {
    // Being unable to ask is not an answer. Saying the fingerprint has gone stale
    // when nothing was reached sends the reader to `capture` over a dead network.
    // Only 403 and 426 are Zen answering about the fingerprint at all: a 5xx or a
    // 429 was answered by something that never judged it, and counting those as a
    // verdict would blame the wording for an outage.
    //
    // Only the floor decides the exit code, so only the floor is read here: the
    // `full` shape is reported, not asked on behalf of the plugin, and letting a
    // stray 5xx on one turn a clean all-refused run into "check the network"
    // points the reader at an outage the deciding shape never reported.
    const fingerprint = (verdict) => verdict === "refused" || verdict === "superseded";
    if (unbuilt.length) {
      // A request that could not be built was never asked, so nothing about the
      // network applies to it: the name in `required` with no tool behind it is
      // in fingerprint.json, and so is the fix.
      return `${unbuilt.length}/${total} floor requests were never asked: a name in \`required\` has no entry in that profile's \`tools\`, and the malformed lines above name them. Fix fingerprint.json before reading anything else here — a request that could not be built is not a network problem.`;
    }
    if (verdicts.every(fingerprint)) {
      return "None of them. Zen has moved past every generation this plugin knows; the tool wording in core-tools.mjs needs capturing again from a current OpenCode.";
    }
    if (verdicts.some(fingerprint)) {
      return "Some of the floor requests were answered about the fingerprint and some were not, which is not a fact about the fingerprint either way. Check the network or ZEN_BASE_URL and ask again.";
    }
    if (!verdicts.some((verdict) => verdict === "unreachable")) {
      return "Zen answered every floor request, but none of them with a verdict on the fingerprint, so this says nothing about it. Check the service or ZEN_BASE_URL and ask again.";
    }
    return "The free tier could not be reached at all, so this says nothing about the fingerprint. Check the network or ZEN_BASE_URL and ask again.";
  }
  // At least one generation works, so the rest are reported by what they
  // actually were: only the ones Zen refused are called refused. `served` is
  // named so the parts add up to the denominator on the page, and the unasked
  // floors are kept outside it: "of N" is the floors something was asked of, and
  // a request that could not be built is not one of them. Counting it in made a
  // single floor appear on both sides of the sentence.
  const refused = verdicts.filter((verdict) => verdict === "refused" || verdict === "superseded").length;
  const other = verdicts.length - refused;
  const what = [
    served ? `${served} served` : null,
    refused ? `${refused} refused` : null,
    other ? `${other} not served` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const asked = unbuilt.length ? `${what} of ${total} asked, ` : `${what} of ${total}.`;
  const malformed = unbuilt.length
    ? `${unbuilt.length} never asked: the malformed lines above name what fingerprint.json has to gain before those can be asked.`
    : "";
  return `At least one generation works, so the plugin still has a generation Zen will serve. ${asked}${malformed}`;
}

if (entry) {
  // Each request is independent and every result is printed in order, so the
  // profiles are asked at once and, within each profile, so are its two shapes:
  // awaiting the floor before its own full pushed that full request back by
  // whatever the floor spent, up to its 30s timeout.
  const results = (
    await Promise.all(
      Object.entries(PROFILES).map(async ([generation, profile]) => {
        // Both are started before either is awaited, and the array keeps the
        // printed order floor then full. `check` reports its own failures, so
        // neither promise can reject out of this fan-out.
        return Promise.all([
          check(generation, profile, "floor", () => [...profile.required]),
          check(generation, profile, "full", () => Object.keys(profile.tools)),
        ]);
      }),
    )
  ).flat();

  const width = Math.max(...results.map((result) => result.generation.length));
  for (const result of results)
    console.log(
      `${result.shape.padEnd(6)}${result.verdict.padEnd(12)} ${result.generation.padEnd(width)}  ${result.detail}`,
    );

  const floor = results.filter((result) => result.shape === "floor");
  const served = floor.filter((result) => result.verdict === "answered");
  // A floor request that could not be built was never asked, so it is not one of
  // the refusals the summary talks about, and it is the one outcome whose fix is
  // in `fingerprint.json` rather than in the network or the wording.
  const unbuilt = floor.filter((result) => result.verdict === "malformed");
  console.log(`\n${served.length}/${floor.length} generations serve a host that is not OpenCode at ${BASE}`);

  // A generation whose full shape is served while its floor is not is the case
  // this gate was widened to see: the plugin would work for a host bringing its
  // own OpenCode tools and be refused for the host it was written for. A floor
  // that was never asked says nothing about that, and its own line says why.
  for (const result of floor) {
    if (result.verdict === "answered" || result.verdict === "malformed") continue;
    const full = results.find(
      (other) => other.generation === result.generation && other.shape === "full",
    );
    if (full?.verdict === "answered")
      console.log(
        `${result.generation} answers the full OpenCode shape but not the tools the plugin stands in: a host that has none of them by name will be refused.`,
      );
  }

  if (!served.length) {
    console.log(
      refusedSummary({
        served: 0,
        // No `total`: the summary counts the floors something was asked of from
        // the rows it is handed, so there is no second place for this run to work
        // out a denominator and get it different from the other call site's.
        unbuilt,
        unserved: floor.filter((result) => result.verdict !== "malformed").map((result) => result.verdict),
      }),
    );
    process.exitCode = 1;
  } else if (served.length < floor.length) {
    // Reached when a floor was not answered, which a malformed one is: the exit
    // code is still decided by the served floors alone, so a run whose one
    // working generation answered and whose other floor has a name missing from
    // its `tools` prints this line and no longer calls that floor refused.
    console.log(
      refusedSummary({
        served: served.length,
        unbuilt,
        unserved: floor.filter((result) => result.verdict !== "answered").map((result) => result.verdict),
      }),
    );
  }
}
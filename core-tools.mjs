// Which generation of OpenCode's request Zen's free tier will serve.
//
// Zen accepts a request only when the whole of it belongs to one generation:
// the User-Agent, the header set and the tools have to agree. Two generations
// are known to be current, and which one applies is the host's to decide:
//
//   1.x   bash, glob, grep, read  -  User-Agent opencode/<v> ai-sdk/provider-utils/<v> runtime/bun/<v>
//   2.x   shell, read             -  User-Agent opencode/<channel>/<version>/<client>
//
// Within a generation, the tools named in `read` are compared against Zen's own
// copy of OpenCode's, and the ones in `required` have to be there. Their data
// lives in fingerprint.json, which is a capture of a real OpenCode rather than
// anything written by hand; `bun run capture` takes a new one, and
// `bun run check:gate` says whether Zen still accepts it.
//
// The descriptions there are the opening of OpenCode's, since that is the part
// Zen reads, with the capture host's scratch directory and OS banner replaced
// because those belong to the machine the capture ran on.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CAPTURE = new URL("./fingerprint.json", import.meta.url);

// The one remedy every failure below points at, written once: only a capture
// writes this file, so a message that names a command instead of the file to fix
// would have to be edited in three places the day that command is renamed.
const REMEDY = "run `bun run capture` to write a new one";

// Every failure in this module is the same shape — what could not be read or
// used, then the remedy — so the wording lives in one place and each throw names
// only its own half.
function captureError(what) {
  return `core-tools: ${what} — ${REMEDY}`;
}

// Read once, here, because every answer in this module comes out of it. Guarded
// because the failure this replaces is a bare ENOENT or SyntaxError thrown out of
// whichever module imported this one, which reads as *that* module being broken
// and never names the file to fix. The remedy is the same whatever went wrong,
// but the diagnosis is not: an unreadable file (EACCES, EISDIR, a directory
// where a file should be) is neither missing nor invalid JSON, and saying it is
// sends the reader to a command that cannot fix a permission problem.
function readProfiles() {
  let captured;
  try {
    captured = JSON.parse(readFileSync(CAPTURE, "utf8"));
  } catch (error) {
    const reason =
      error.code === "ENOENT"
        ? "missing"
        : error instanceof SyntaxError
          ? "invalid JSON"
          : `could not be read (${error.code ?? error.message})`;
    throw new Error(
      captureError(`the capture at ${fileURLToPath(CAPTURE)} is ${reason}`),
      { cause: error },
    );
  }
  // An object carrying a non-empty map of profiles, and nothing more specific:
  // which generations those are is the capture's to say — capture.mjs writes
  // next.profiles[generation] — so the keys are never named here. A capture that
  // lost every profile cannot tell one generation from another and fails now
  // rather than at the first request.
  const profiles = captured?.profiles;
  if (
    typeof profiles !== "object" ||
    profiles === null ||
    Array.isArray(profiles) ||
    !Object.keys(profiles).length
  ) {
    throw new Error(
      captureError(`the capture at ${fileURLToPath(CAPTURE)} has no profiles`),
      { cause: captured },
    );
  }
  return profiles;
}

export const PROFILES = readProfiles();

/**
 * The generation a request belongs to, told by the tools it carries. Tool names
 * move far less often than descriptions do, so this survives a rewording that a
 * pinned User-Agent would not.
 *
 * `undefined` is a normal return: it says neither generation's names were there,
 * and the callers default it themselves (`provider.mjs` uses `?? DEFAULT_GENERATION`).
 * A body whose `tools` is not an array is the same answer as an empty one — the
 * body is client-supplied, so it can carry any shape at all, and "no generation
 * recognised" is the only honest reading of one that is not a list of tools.
 */
export function generationOf(tools) {
  const names = new Set(
    (Array.isArray(tools) ? tools : []).map((tool) => tool?.function?.name ?? tool?.name),
  );
  if (names.has("shell")) return "2.x";
  if (names.has("bash")) return "1.x";
  return undefined;
}

// The profile a generation was captured into, or an Error naming both what was
// asked for and what the capture holds. Ownership rather than truthiness: a
// plain object answers `constructor` and `toString` out of Object.prototype, so
// `PROFILES[generation]` alone would hand back a function and then fail on its
// `.agent` with a TypeError that names nothing. Ownership of the key is half of
// it — a capture holding `{"1.x": null}` owns the key and still has no profile,
// and the `.agent` of that is the same unnamed TypeError.
function profileFor(generation) {
  if (!Object.hasOwn(PROFILES, generation)) {
    throw new Error(
      `core-tools: no profile for generation ${JSON.stringify(generation)}; ` +
        `the capture holds ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  const profile = PROFILES[generation];
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new Error(
      captureError(
        `the ${JSON.stringify(generation)} profile in the capture is not an object`,
      ),
    );
  }
  return profile;
}

// A field interpolated into the User-Agent has to be a string with something in
// it: each one is read by Zen, and a missing or mistyped one used to compose
// `opencode/undefined/1.19.0/undefined` — a header that gets a refusal saying
// nothing about the capture it came out of. `Object.hasOwn` alone would only
// prove the key is there: `{"chat": null}` and `{"chat": ""}` both compose a
// version of `null`.
const filledIn = (value) => typeof value === "string" && value !== "";

/**
 * The User-Agent that generation of OpenCode sends, for a protocol. Each
 * protocol's ai-sdk package bundles its own provider-utils, so 1.x differs by
 * protocol and 2.x does not.
 */
export function agentFor(generation, protocol = "chat") {
  const agent = profileFor(generation).agent;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) {
    throw new Error(
      captureError(`the ${JSON.stringify(generation)} profile in the capture has no agent`),
    );
  }
  // The release shape carries no provider-utils at all, and is composed the same
  // way whatever protocol was asked for.
  if (!agent.providerUtils) {
    if (![agent.channel, agent.opencode, agent.client].every(filledIn)) {
      throw new Error(
        captureError(
          `the ${JSON.stringify(generation)} profile in the capture is not a release agent`,
        ),
      );
    }
    return `opencode/${agent.channel}/${agent.opencode}/${agent.client}`;
  }
  if (typeof agent.providerUtils !== "object" || agent.providerUtils === null) {
    throw new Error(
      captureError(
        `the ${JSON.stringify(generation)} profile in the capture has no per-protocol provider-utils`,
      ),
    );
  }
  // `?? "undefined"` used to be interpolated here for a protocol the capture has
  // no provider-utils for, and a prototype member (`toString`) as the version.
  // Zen reads this header, so a malformed one is rejected upstream with an error
  // that says nothing about where it came from; name the miss instead.
  if (!Object.hasOwn(agent.providerUtils, protocol)) {
    throw new Error(
      `core-tools: generation ${JSON.stringify(generation)} composes its User-Agent ` +
        `per protocol, and the capture has no provider-utils for ${JSON.stringify(protocol)}; ` +
        `it holds ${Object.keys(agent.providerUtils).join(", ")}`,
    );
  }
  if (!filledIn(agent.providerUtils[protocol]) || !filledIn(agent.opencode) || !filledIn(agent.runtime)) {
    throw new Error(
      captureError(
        `the ${JSON.stringify(generation)} profile in the capture does not fill in every field of ` +
          `its ${JSON.stringify(protocol)} User-Agent`,
      ),
    );
  }
  return `opencode/${agent.opencode} ai-sdk/provider-utils/${agent.providerUtils[protocol]} ${agent.runtime}`;
}

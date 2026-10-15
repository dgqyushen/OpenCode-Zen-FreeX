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

const captured = JSON.parse(readFileSync(new URL("./fingerprint.json", import.meta.url), "utf8"));

export const PROFILES = captured.profiles;

/** The names Zen reads the wording of, for a generation. */
const readNames = (generation) => Object.keys(PROFILES[generation].tools);

/**
 * The generation a request belongs to, told by the tools it carries. Tool names
 * move far less often than descriptions do, so this survives a rewording that a
 * pinned User-Agent would not.
 */
export function generationOf(tools) {
  const names = new Set((tools ?? []).map((tool) => tool?.function?.name ?? tool?.name));
  if (names.has("shell")) return "2.x";
  if (names.has("bash")) return "1.x";
  return undefined;
}

/**
 * The User-Agent that generation of OpenCode sends, for a protocol. Each
 * protocol's ai-sdk package bundles its own provider-utils, so 1.x differs by
 * protocol and 2.x does not.
 */
export function agentFor(generation, protocol = "chat") {
  const agent = PROFILES[generation].agent;
  return agent.providerUtils
    ? `opencode/${agent.opencode} ai-sdk/provider-utils/${agent.providerUtils[protocol]} ${agent.runtime}`
    : `opencode/${agent.channel}/${agent.opencode}/${agent.client}`;
}

export { readNames };
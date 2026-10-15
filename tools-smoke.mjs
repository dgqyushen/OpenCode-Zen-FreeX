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
//   unreachable the free tier could not be asked at all
//
// Exit code is 0 when at least one generation's floor is answered. A generation
// being refused is not a failure while another still works.

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PROFILES, agentFor } from "./core-tools.mjs";
import { outboundHeaders } from "./provider.mjs";

const BASE = process.env.ZEN_BASE_URL ?? "https://opencode.ai/inference/v1";
const MODEL = process.env.ZEN_CHECK_MODEL ?? "space-bunny-free";
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// A session id of the shape OpenCode makes, since that is part of what is asked.
let stamp = 0;
let counter = 0;
function sessionID() {
  const now = Date.now();
  if (now !== stamp) {
    stamp = now;
    counter = 0;
  }
  counter++;
  const value = (~(BigInt(now) * 0x1000n + BigInt(counter))) & 0xffffffffffffn;
  let tail = "";
  for (const byte of randomBytes(14)) tail += ALPHABET[byte % 62];
  return `ses_${value.toString(16).padStart(12, "0")}${tail}`;
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

async function check(generation, profile, shape, names) {
  const { headers, body } = requestFor(generation, profile, names);
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    if (response.ok)
      return { generation, shape, verdict: "answered", detail: `as ${headers.get("user-agent")}` };
    if (response.status === 426)
      return {
        generation,
        shape,
        verdict: "superseded",
        detail: "Zen wants a newer OpenCode than this profile claims",
      };
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
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return undefined;
  }
}

// Only a run asks Zen. index.test.mjs imports this module to hold its request
// against the plugin's, and an import must not reach the network.
const entry = invokedDirectly();
if (entry === undefined) {
  console.error(
    "Could not tell whether this file was run or imported, so nothing was asked: neither import.meta.main nor process.argv[1] named an entry point. Run it with `bun run check:gate`.",
  );
  process.exit(1);
}

if (entry) {
  // Each request is independent and every result is printed in order, so the
  // two shapes of every profile are asked at once rather than one abort's
  // worth of waiting after another.
  const results = (
    await Promise.all(
      Object.entries(PROFILES).map(async ([generation, profile]) => [
        await check(generation, profile, "floor", [...profile.required]),
        await check(generation, profile, "full", Object.keys(profile.tools)),
      ]),
    )
  ).flat();

  const width = Math.max(...results.map((result) => result.generation.length));
  for (const result of results)
    console.log(
      `${result.shape.padEnd(6)}${result.verdict.padEnd(12)} ${result.generation.padEnd(width)}  ${result.detail}`,
    );

  const floor = results.filter((result) => result.shape === "floor");
  const served = floor.filter((result) => result.verdict === "answered");
  console.log(`\n${served.length}/${floor.length} generations serve a host that is not OpenCode at ${BASE}`);

  // A generation whose full shape is served while its floor is not is the case
  // this gate was widened to see: the plugin would work for a host bringing its
  // own OpenCode tools and be refused for the host it was written for.
  for (const result of floor) {
    if (result.verdict === "answered") continue;
    const full = results.find(
      (other) => other.generation === result.generation && other.shape === "full",
    );
    if (full?.verdict === "answered")
      console.log(
        `${result.generation} answers the full OpenCode shape but not the tools the plugin stands in: a host that has none of them by name will be refused.`,
      );
  }

  if (!served.length) {
    // Being unable to ask is not an answer. Saying the fingerprint has gone stale
    // when nothing was reached sends the reader to `capture` over a dead network.
    // Only 403 and 426 are Zen answering about the fingerprint at all: a 5xx or a
    // 429 was answered by something that never judged it, and counting those as a
    // verdict would blame the wording for an outage.
    const answered = (result) => ["refused", "superseded"].includes(result.verdict);
    const unreached = results.filter((result) => result.verdict === "unreachable");
    if (results.every(answered)) {
      console.log(
        "None of them. Zen has moved past every generation this plugin knows; the tool wording in core-tools.mjs needs capturing again from a current OpenCode.",
      );
    } else if (results.some(answered)) {
      console.log(
        "Some of this run was answered about the fingerprint and some of it was not, which is not a fact about the fingerprint either way. Check the network or ZEN_BASE_URL and ask again.",
      );
    } else if (!unreached.length) {
      console.log(
        "Zen answered every request, but none of them with a verdict on the fingerprint, so this says nothing about it. Check the service or ZEN_BASE_URL and ask again.",
      );
    } else {
      console.log(
        "The free tier could not be reached at all, so this says nothing about the fingerprint. Check the network or ZEN_BASE_URL and ask again.",
      );
    }
    process.exitCode = 1;
  } else if (served.length < floor.length) {
    console.log("Some are refused but at least one works, so the plugin still has a generation Zen will serve.");
  }
}
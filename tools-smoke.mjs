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
//   unreachable the free tier could not be asked at all
//
// Exit code is 0 when at least one generation's floor is answered. A generation
// being refused is not a failure while another still works.

import { randomBytes } from "node:crypto";
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
// can hold it against the request the plugin was observed to send, offline.
export function requestFor(generation, profile, names) {
  return {
    headers: outboundHeaders({
      session: sessionID(),
      agent: agentFor(generation),
      project: "global",
      protocol: "chat",
    }),
    body: {
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      tools: names.map((name) => ({ type: "function", function: profile.tools[name] })),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 40,
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
    return { generation, shape, verdict: "refused", detail: `HTTP ${response.status}${says(text)}` };
  } catch (error) {
    return { generation, shape, verdict: "unreachable", detail: error.message };
  }
}

// Only a run asks Zen. index.test.mjs imports this module to hold its request
// against the plugin's, and an import must not reach the network.
if (import.meta.main) {
  const results = [];
  for (const [generation, profile] of Object.entries(PROFILES)) {
    results.push(await check(generation, profile, "floor", [...profile.required]));
    results.push(await check(generation, profile, "full", Object.keys(profile.tools)));
  }

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
    if (results.every((result) => result.verdict === "unreachable")) {
      console.log(
        "The free tier could not be reached at all, so this says nothing about the fingerprint. Check the network or ZEN_BASE_URL and ask again.",
      );
    } else {
      console.log(
        "None of them. Zen has moved past every generation this plugin knows; the tool wording in core-tools.mjs needs capturing again from a current OpenCode.",
      );
    }
    process.exitCode = 1;
  } else if (served.length < floor.length) {
    console.log("Some are refused but at least one works, so the plugin still has a generation Zen will serve.");
  }
}
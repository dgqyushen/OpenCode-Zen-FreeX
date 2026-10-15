// Asks Zen which of the client generations this package still speaks.
//
// The gate moved more than once in a day, and nothing short of asking it says
// so: a stale fingerprint does not look different from a working one until a
// user is refused. This is the check to run before a release, and whenever a
// report comes in that the free tier answers 403.
//
//   bun run check:gate
//
// It sends one request per profile, using the wording and User-Agent that
// profile carries, and reports each as:
//
//   answered   Zen served the request; this profile is current
//   refused    Zen did not recognise this generation (403)
//   superseded Zen wants a newer OpenCode than the one this profile claims (426)
//   unreachable the free tier could not be asked at all
//
// Exit code is 0 only when every profile is answered. One profile being
// refused is not a failure while the other still works.

import { randomBytes } from "node:crypto";
import { PROFILES, agentFor } from "./core-tools.mjs";

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

async function check(generation, profile) {
  const session = sessionID();
  const headers = {
    authorization: "Bearer public",
    "content-type": "application/json",
    "user-agent": agentFor(generation),
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-session": session,
    "x-opencode-session-id": session,
  };
  const tools = Object.values(profile.tools).map((tool) => ({ type: "function", function: tool }));
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    tools,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 40,
  };
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    await response.text();
    if (response.ok) return { generation, verdict: "answered", detail: `as ${headers["user-agent"]}` };
    if (response.status === 426) return { generation, verdict: "superseded", detail: "Zen wants a newer OpenCode than this profile claims" };
    return { generation, verdict: "refused", detail: `HTTP ${response.status}` };
  } catch (error) {
    return { generation, verdict: "unreachable", detail: error.message };
  }
}

const results = [];
for (const [generation, profile] of Object.entries(PROFILES)) results.push(await check(generation, profile));

const width = Math.max(...results.map((result) => result.generation.length));
for (const result of results)
  console.log(`${result.verdict.padEnd(12)} ${result.generation.padEnd(width)}  ${result.detail}`);

const answered = results.filter((result) => result.verdict === "answered");
console.log(`\n${answered.length}/${results.length} profiles answered at ${BASE}`);
if (!answered.length) {
  console.log(
    "None of them. Zen has moved past every generation this plugin knows; the tool wording in core-tools.mjs needs capturing again from a current OpenCode.",
  );
  process.exitCode = 1;
} else if (answered.length < results.length) {
  console.log("Some are refused but at least one works, so the plugin still has a generation Zen will serve.");
}
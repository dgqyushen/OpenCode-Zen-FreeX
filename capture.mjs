// Recaptures fingerprint.json from a real OpenCode.
//
// The free tier reads the wording of the tools it knows by name out of the
// request body and refuses the request when it differs from its own copy. That
// copy moves with OpenCode, so the one held here goes stale — and a stale copy
// looks exactly like a working one until somebody is refused. This is how a new
// one is taken, so that refreshing it is a command and not an archaeology
// exercise.
//
//   bun run capture            # writes fingerprint.json
//   bun run capture -- --dry   # reports what changed, writes nothing
//
// Needs opencode on PATH (https://opencode.ai) and bun. Nothing goes to Zen: the
// OpenCode under test is pointed at a server running here, and the request it
// makes is the thing being read.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILES } from "./core-tools.mjs";

const PORT = Number(process.env.CAPTURE_PORT ?? 8791);
const DRY = process.argv.includes("--dry");
const HERE = import.meta.dir;
const FINGERPRINT = join(HERE, "fingerprint.json");

// The names Zen reads, by generation: 2.x sends `shell` where 1.x sends `bash`
// and carries none of the others. Everything else a host declares is ignored.
const READ = {
  "1.x": ["bash", "glob", "grep", "read", "write", "edit"],
  "2.x": ["shell", "read"],
};

// The capture host's own scratch directory and OS banner belong to the machine
// the capture ran on, not to the tool. These are put back to something neutral
// so the capture is not tied to one machine.
const NEUTRALISE = [
  [/Be aware: OS: [^\n]*/g, "Be aware: OS: linux, Shell: bash"],
  [/Use `[^`]*` for temporary work outside the workspace\./g, "Use `/tmp` for temporary work outside the workspace."],
  [/Use `[A-Za-z]:\\[^`]*`/g, "Use `/tmp`"],
];
// Zen compares roughly the first 700 characters and ignores the rest; 1200
// leaves margin, and the tail is where a note to the model goes.
const KEEP = 1200;

const capturedPath = join(tmpdir(), `zen-capture-${process.pid}.json`);
// A run that was killed leaves its file behind and a PID comes round again, so
// this one is removed rather than read back as if it were this run's capture.
rmSync(capturedPath, { force: true });
// OpenCode makes more than one request (a short one for the title, then the
// real one). The one worth reading is the longest, since it is the one that
// carries the full toolset. It is kept here rather than written from the handler
// as it arrives: two requests in flight at once would both be writing this one
// file, and the writes interleave into it.
let longest = { agent: null, body: "" };
const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models"))
      return Response.json({ object: "list", data: [{ id: "big-pickle", object: "model", owned_by: "opencode" }] });
    const body = await request.text();
    if (body.length > longest.body.length) longest = { agent: request.headers.get("user-agent"), body };
    return new Response(
      [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"big-pickle","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

const home = mkdtempSync(join(tmpdir(), "zen-capture-home-"));
// Where OpenCode looks for its config is XDG_CONFIG_HOME/opencode, and the
// three XDG directories are pointed at `home` below.
const config = join(home, "config", "opencode", "opencode.json");
await Bun.write(
  config,
  JSON.stringify({ provider: { opencode: { options: { baseURL: `http://127.0.0.1:${PORT}/v1` } } } }),
);

console.log(`listening on 127.0.0.1:${PORT}, running opencode against it`);
let ran = true;
const code = await new Promise((done) => {
  const child = spawn("opencode", ["run", "-m", "opencode/big-pickle", "Say OK."], {
    env: {
      ...process.env,
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  child.on("error", () => {
    console.error("could not run opencode; install it from https://opencode.ai and put it on PATH");
    ran = false;
    done(1);
  });
  child.on("exit", (value) => done(value ?? 0));
});
server.stop(true);
if (!ran) process.exit(1);
// Written here, once nothing else can be writing it.
if (longest.body.length) await Bun.write(capturedPath, JSON.stringify(longest));

let request;
try {
  request = JSON.parse(readFileSync(capturedPath, "utf8"));
} catch {
  console.error("no request was captured; opencode did not reach the local server");
  process.exit(1);
}

let body;
try {
  body = JSON.parse(request.body);
} catch {
  console.error("the captured request body is not JSON; nothing to read");
  process.exit(1);
}

// Which generation this client is: the names it sends say so. It is read
// before the tools are, since the two generations do not send the same names
// and 2.x has to be recognised by `shell` rather than judged against 1.x's.
const names = new Set((body.tools ?? []).map((raw) => (raw.function ?? raw)?.name));
const generation = names.has("shell") ? "2.x" : "1.x";
const read = READ[generation];

const tools = {};
for (const raw of body.tools ?? []) {
  const tool = raw.function ?? raw;
  if (!tool?.name || !read.includes(tool.name) || !tool.description) continue;
  tools[tool.name] = {
    name: tool.name,
    description: NEUTRALISE.reduce((text, [find, to]) => text.replace(find, to), tool.description).slice(0, KEEP),
    parameters: tool.parameters,
  };
}

const missing = read.filter((name) => !tools[name]);
if (missing.length) {
  console.error(
    `the captured request has no ${missing.join(", ")}; this OpenCode no longer sends them, so it cannot be captured this way`,
  );
  process.exit(1);
}
for (const [name, tool] of Object.entries(tools))
  if (tool.description.length < 100) {
    console.error(`${name}'s description looks truncated (${tool.description.length} chars); not writing`);
    process.exit(1);
}

const required = generation === "2.x" ? ["shell", "read"] : ["bash", "glob", "grep", "read"];
const absent = required.filter((name) => !tools[name]);
if (absent.length) {
  console.error(`a ${generation} request must carry ${absent.join(", ")}, and the capture does not`);
  process.exit(1);
}

// Which protocol was captured, since each of 1.x's protocols bundles its own
// provider-utils and a capture must not overwrite the ones it did not observe.
// Anthropic is not one this can read: its tools carry `input_schema` where the
// other two carry `parameters`, so read as the chat one it would write every
// tool without its parameters and take the chat slot's provider-utils from an
// anthropic client. Refused rather than written.
if ((body.tools ?? []).some((raw) => (raw.function ?? raw)?.input_schema !== undefined)) {
  console.error("the captured request is in the anthropic shape, which this script cannot read; nothing written");
  process.exit(1);
}
const protocol = body.input !== undefined && body.messages === undefined ? "responses" : "chat";

console.log(`\nagent:  ${request.agent}`);
console.log(`tools:  ${Object.keys(tools).join(", ")}  (${generation}, ${protocol})`);
if (code !== 0) console.log(`(opencode exited ${code}; its request was still captured)`);

const agent = parseAgent(request.agent);
if (agent.providerUtils) agent.providerUtils = { ...PROFILES[generation]?.agent?.providerUtils, [protocol]: agent.providerUtils[protocol] };

const before = PROFILES[generation];
const agentChanged = JSON.stringify(before?.agent) !== JSON.stringify(agent);
let changed = 0;
for (const name of Object.keys(tools)) {
  if (JSON.stringify(before?.tools?.[name]) !== JSON.stringify(tools[name])) changed++;
  console.log(`  ${name.padEnd(6)} ${JSON.stringify(before?.tools?.[name]) === JSON.stringify(tools[name]) ? "unchanged" : "CHANGED"}  ${tools[name].description.length} chars`);
}
if (agent.providerUtils)
  console.log(`  agent  ${agentChanged ? "CHANGED" : "unchanged"}  ${protocol} provider-utils kept separate from the others`);

if (DRY) {
  const what = [changed ? `${changed} tool(s)` : null, agentChanged ? "the agent" : null].filter(Boolean);
  console.log(`\n${what.length ? `${what.join(" and ")} would change.` : "Nothing would change."} Nothing written (--dry).`);
  process.exit(what.length ? 1 : 0);
}

if (!changed && !agentChanged) {
  console.log("\nnothing changed.");
  process.exit(0);
}

const next = JSON.parse(readFileSync(FINGERPRINT, "utf8"));
next.profiles[generation] = { agent, required, tools };
await Bun.write(FINGERPRINT, JSON.stringify(next, null, 2) + "\n");
console.log(`\nwrote ${FINGERPRINT} for ${generation}. Now run \`bun run check:gate\` and commit if it passes.`);

// The User-Agent is stored the way agentFor() reads it back, which is not
// necessarily the same split the raw header used.
function parseAgent(agent) {
  const twoPart = /^opencode\/(\d[^ ]*) ai-sdk\/provider-utils\/(\S+) (\S+)$/.exec(agent ?? "");
  if (twoPart) {
    const [, opencode, providerUtils, runtime] = twoPart;
    return {
      opencode,
      providerUtils: { chat: providerUtils, responses: providerUtils, anthropic: providerUtils },
      runtime,
    };
  }
  const threePart = /^opencode\/([a-z]+)\/(\d[^/]*)\/([a-z-]+)$/.exec(agent ?? "");
  if (threePart) {
    const [, channel, opencode, client] = threePart;
    return { channel, opencode, client };
  }
  console.error(`\ncould not read \`${agent}\` as an OpenCode User-Agent; write PROFILES[${generation}].agent by hand`);
  process.exit(1);
}
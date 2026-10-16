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
//
// CAPTURE_PORT moves the loopback port, and CAPTURE_TIMEOUT_MS how long the
// child is given before it is ended.

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

// The ones a request of that generation has to carry, which is a subset of the
// names worth reading: `write` and `edit` are read when they are there and do
// not have to be, so a client that stopped sending them is not a capture to
// refuse. One list decides both, so the two cannot drift into disagreeing about
// the same name.
const REQUIRED = {
  "1.x": ["bash", "glob", "grep", "read"],
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

// How long the child is given to make its request. `opencode run` can sit on a
// prompt or a stalled connection, and this script would then hold the mock
// server and the temporary config open until somebody noticed: an instrument
// that waits for ever reads as one that is working.
const CHILD_TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS ?? 120_000);

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
    try {
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
    } catch (cause) {
      // A client that aborts mid-request rejects inside this handler, and an
      // unhandled rejection here would end the run with a stack trace instead
      // of the sentence below. The body is not this script's to keep.
      console.error(`the capture server could not read a request: ${cause?.message ?? cause}`);
      return new Response("", { status: 400 });
    }
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
  const timer = setTimeout(() => {
    console.error(`opencode did not finish within ${CHILD_TIMEOUT_MS} ms; ending it`);
    child.kill("SIGKILL");
  }, CHILD_TIMEOUT_MS);
  // Ctrl-C has to take the child with it: nothing else would end it, and the
  // next run would find the port still held.
  const interrupted = (signal) => () => {
    child.kill(signal);
    done(1);
  };
  process.once("SIGINT", interrupted("SIGINT"));
  process.once("SIGTERM", interrupted("SIGTERM"));
  child.on("error", () => {
    console.error("could not run opencode; install it from https://opencode.ai and put it on PATH");
    ran = false;
    done(1);
  });
  child.on("exit", (value) => {
    clearTimeout(timer);
    done(value ?? 0);
  });
});
// Stopping is awaited, and the snapshot is taken after it: the handler is
// async, so a body still being read could otherwise replace `longest` after the
// capture had already been serialised — which is exactly what the comment above
// that state claims cannot happen.
await server.stop(true);
const captured = { ...longest };
// Removed before the exit paths below, not after the capture: a run that could
// not capture anything is exactly the one that used to leave its temporary home
// behind, since the exits above this line are the ones a failure takes. The
// synchronous form is deliberate: `rm` from `node:fs` is the callback one, so
// awaiting it silently did nothing and left a directory behind every run.
try {
  rmSync(home, { recursive: true, force: true });
} catch (cause) {
  console.error(`could not remove ${home}: ${cause?.message ?? cause}`);
}
if (!ran) process.exit(1);
if (captured.body.length) await Bun.write(capturedPath, JSON.stringify(captured));

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

// A name this generation has to carry that the request does not carry at all:
// this OpenCode no longer sends it, so the capture cannot be taken this way.
const required = REQUIRED[generation];
const missing = required.filter((name) => !tools[name]);
if (missing.length) {
  console.error(
    `the captured request has no ${missing.join(", ")}; this OpenCode no longer sends them, so it cannot be captured this way`,
  );
  process.exit(1);
}
for (const [name, tool] of Object.entries(tools)) {
  if (tool.description.length < 100) {
    console.error(`${name}'s description looks truncated (${tool.description.length} chars); not writing`);
    process.exit(1);
  }
  // Every tool a request carries has a schema, and a capture that keeps the
  // wording without it writes a tool that Zen then compares against a request
  // which has one. Only the anthropic shape is refused below, so a third shape
  // would otherwise reach here as a tool with no parameters at all — which
  // JSON.stringify drops from the written file in silence.
  if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
    console.error(`${name} carries no parameter schema this script can read; not writing`);
    process.exit(1);
  }
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
// The whole profile is compared, not only the tools the new capture happens to
// carry: the write below replaces `{ agent, required, tools }` entire, so a tool
// that is no longer captured — or a `required` list that moved — is a change,
// and reading it as "nothing changed" would leave the file describing a request
// this OpenCode no longer makes.
const nextProfile = { agent, required, tools };
const same = (left, right) => JSON.stringify(order(left)) === JSON.stringify(order(right));
// Key order is not what is being captured: these objects come out of a parsed
// request body and out of a JSON file, and JSON.stringify is sensitive to the
// order they arrived in.
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, order(value[key])]));
}
const agentChanged = !same(before?.agent, agent);
const requiredChanged = !same(before?.required, required);
const removed = Object.keys(before?.tools ?? {}).filter((name) => !tools[name]);
let changed = removed.length + (requiredChanged ? 1 : 0);
for (const [name, tool] of Object.entries(tools)) {
  const moved = !same(before?.tools?.[name], tool);
  if (moved) changed++;
  console.log(`  ${name.padEnd(6)} ${moved ? "CHANGED" : "unchanged"}  ${tool.description.length} chars`);
}
for (const name of removed) console.log(`  ${name.padEnd(6)} GONE     (was in the stored profile, not in this capture)`);
if (requiredChanged)
  console.log(`  required  CHANGED  ${(before?.required ?? []).join(", ")} -> ${required.join(", ")}`);
if (agent.providerUtils)
  console.log(`  agent  ${agentChanged ? "CHANGED" : "unchanged"}  ${protocol} provider-utils kept separate from the others`);

if (DRY) {
  const what = [
    changed ? `${changed} change(s)` : null,
    !requiredChanged && agentChanged ? "the agent" : null,
  ].filter(Boolean);
  // `changed` already counts the required list when it moved, so the agent is
  // named only when it is the whole of what would change.
  const summary = !changed && agentChanged ? ["the agent"] : what;
  console.log(
    `\n${summary.length ? `${summary.join(" and ")} would change.` : "Nothing would change."} Nothing written (--dry).`,
  );
  process.exit(summary.length ? 1 : 0);
}

if (!changed && !agentChanged) {
  console.log("\nnothing changed.");
  process.exit(0);
}

// Read and written after a full capture run, so a failure here is late: it says
// what to fix rather than throwing a raw SyntaxError out of the last line.
let next;
try {
  next = JSON.parse(readFileSync(FINGERPRINT, "utf8"));
} catch (cause) {
  console.error(`could not read ${FINGERPRINT}: ${cause?.message ?? cause}`);
  process.exit(1);
}
if (!next || typeof next !== "object" || Array.isArray(next) || typeof next.profiles !== "object" || next.profiles === null) {
  console.error(`${FINGERPRINT} has no profiles object; not writing`);
  process.exit(1);
}
next.profiles[generation] = nextProfile;
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

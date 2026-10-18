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
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILES } from "./core-tools.mjs";

const PORT = Number(process.env.CAPTURE_PORT ?? 8791);
const HERE = import.meta.dir;
// Where the capture is written, which is this directory unless something else
// says so: `--fingerprint <path>`, `--fingerprint=<path>` and
// `CAPTURE_FINGERPRINT` exist so a test can point the write at a scratch file,
// since the alternative — importing this module and letting it write the real
// one — is what made it untestable. The flag wins over the environment, and both
// are resolved against the working directory the way a path on a command line
// usually is. Exported, with the argv and environment it reads as parameters, so
// the one decision that can send a write somewhere unexpected is a test's to pin
// rather than a reader's to trust.
const FINGERPRINT = resolve(fingerprintTarget());
export function fingerprintTarget(argv = process.argv, env = process.env) {
  // Both spellings a command line accepts for an option with a value. Reading
  // only the space-separated one was worse than a missing feature: `=` matched
  // no element, so the flag was ignored and the write landed on the shipped
  // fingerprint.json — the exact outcome the flag exists to prevent, arrived at
  // silently.
  const flag = argv.indexOf("--fingerprint");
  const inline = argv.find((arg) => arg.startsWith("--fingerprint="));
  // A value that is another flag is not a value: `--fingerprint --dry` would
  // otherwise resolve to a file named `--dry`, which reads as a missing path
  // rather than as the typo it is. It is also what an empty `--fingerprint=`
  // names. The default is the safe answer either way, since a mistake must not
  // be the thing that decides where a write goes.
  const value = inline !== undefined ? inline.slice("--fingerprint=".length) : flag === -1 ? undefined : argv[flag + 1];
  if (value && !value.startsWith("-")) return value;
  // `||` rather than `??` for the environment: an exported-but-empty variable
  // is not a path, and `resolve("")` is the working directory — a write aimed
  // at a directory fails, but a knob that reads as set while naming nothing is
  // worse than one that reads as unset.
  return env.CAPTURE_FINGERPRINT || join(HERE, "fingerprint.json");
}

// The names Zen reads, by generation: 2.x sends `shell` where 1.x sends `bash`
// and carries none of the others. Everything else a host declares is ignored.
const READ = {
  "1.x": ["bash", "glob", "grep", "read", "write", "edit"],
  "2.x": ["shell", "read"],
};

// The ones a request of that generation has to carry, which is a subset of the
// names worth reading: `write` and `edit` are read when they are there and do
// not have to be, so a client that stopped sending them is not a capture to
// refuse. The two lists are literals and cannot check each other, so the loop
// below refuses to run when they disagree about a name.
const REQUIRED = {
  "1.x": ["bash", "glob", "grep", "read"],
  "2.x": ["shell", "read"],
};

// A name that has to be there but is not in READ is a required tool this script
// would never read: the request carries it, `missing` never sees it, and the
// profile written below is short one name Zen reads. The two lists are separate
// literals — one says what is worth reading, the other what has to be — so they
// are held together here rather than by the comment above claiming they agree.
for (const [generation, names] of Object.entries(REQUIRED)) {
  const unread = names.filter((name) => !(READ[generation] ?? []).includes(name));
  if (unread.length)
    throw new Error(
      `capture: REQUIRED["${generation}"] names ${unread.join(", ")}, which READ["${generation}"] does not read`,
    );
}

// The capture host's own shell, scratch directory and OS banner belong to the
// machine the capture ran on, not to the tool. These are put back to something
// neutral so the capture is not tied to one machine.
//
// The shell's version is the one these can get wrong: opencode 1.19.0 words
// `bash`'s description after the host it runs on — "Executes a given Windows
// PowerShell (5.1) command…" on one machine, "PowerShell (7+)…" on another —
// and every one of those bytes is sent upstream, because Zen reads the wording
// out of the request. Measured 2026-10-16 on the same pinned release, both
// versions answered, so the difference was never Zen's to insist on; it was two
// machines disagreeing about a description that belongs to neither. The version
// is dropped, which is also the wording a run on any host converges to — a
// capture on Linux says "Shell: bash" and carries no such clause at all. What
// the neutral wording is worth is settled by `bun run check:gate`, not here.
const NEUTRALISE = [
  [/Be aware: OS: [^\n]*/g, "Be aware: OS: linux, Shell: bash"],
  [/Use `[^`]*` for temporary work outside the workspace\./g, "Use `/tmp` for temporary work outside the workspace."],
  [/Use `[A-Za-z]:\\[^`]*`/g, "Use `/tmp`"],
  [/\b(?:Windows )?PowerShell \(\d[^)]*\)/g, "PowerShell"],
];
// Zen compares roughly the first 700 characters and ignores the rest; 1200
// leaves margin, and the tail is where a note to the model goes.
const KEEP = 1200;

// How long the child is given to make its request. `opencode run` can sit on a
// prompt or a stalled connection, and this script would then hold the mock
// server and the temporary config open until somebody noticed: an instrument
// that waits for ever reads as one that is working.
const CHILD_TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS ?? 120_000);

// Whether this module is the file that was run rather than one the tests
// import. `import.meta.main` is the direct answer and the one Bun gives, but it
// arrived in Node 22.18 and nothing before that has it — and a script that
// cannot tell whether it was run is one a test cannot import: this file's
// evaluation path starts a server and rewrites fingerprint.json, so the helpers
// below are only testable behind this guard, and the guard is what keeps an
// import from taking that path. Exported so the guard itself is pinned by a test
// rather than trusted.
export function invokedDirectly() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  return resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
}

// The signal handlers are stored so the exit path can take them off again: a
// `process.once` that has already fired is gone, but one that has not would
// swallow a Ctrl-C pressed while the capture is being compared and written
// (settling an already settled promise is a no-op). The kill is the part that
// has to happen while the child is alive; after that the default handler is the
// one that should end the script.

// Run `opencode` against the local server and bring back what it sent, plus
// whether the run itself was a clean exit. `start` is a parameter so the tests
// can hand this a child they drive by hand and pin the one property that makes
// the exit code trustworthy: a child a signal killed exits with a null code,
// and that is a failure of the run rather than the 0 `value ?? 0` used to
// report — a killed run then went on to compare and rewrite fingerprint.json.
export async function capture(intro, start) {
  console.log(intro);
  // A signal is not an exit code: a child killed by the watchdog (SIGKILL) or
  // by a Ctrl-C leaves `value` null, and reading that as 0 is what let an
  // interrupted run reach the write below. One answer for the signals and the
  // error path both.
  return await new Promise((done) => {
    let ran = true;
    const child = start();
    const timer = setTimeout(() => {
      console.error(`opencode did not finish within ${CHILD_TIMEOUT_MS} ms; ending it`);
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    // What both endings have to do before they settle the promise: nothing else
    // is going to fire for this child, so the watchdog would later log an ending
    // for a run that already ended, and a `process.once` left armed swallows one
    // Ctrl-C. A spawn failure (`error`, ENOENT) ends here too — the path the
    // shipped script only survived because it happens to exit soon after.
    const settle = (code) => {
      clearTimeout(timer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      done({ code, ran });
    };
    // Ctrl-C has to take the child with it: nothing else would end it, and the
    // next run would find the port still held. It is also a failed run — the
    // request may never have been made — so it must not walk into the compare
    // and write path the way an exit-0 does.
    const interrupted = (signal) => () => {
      ran = false;
      child.kill(signal);
      settle(1);
    };
    const onInterrupt = interrupted("SIGINT");
    const onTerminate = interrupted("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    child.on("error", () => {
      console.error("could not run opencode; install it from https://opencode.ai and put it on PATH");
      ran = false;
      settle(1);
    });
    child.on("exit", (value, signal) => {
      if (signal) ran = false;
      settle(signal ? 1 : (value ?? 0));
    });
  });
}

// The comparison and the write, after a run worth reading. Split out so a test
// can drive it with a captured request instead of a real `opencode` — and with a
// scratch `fingerprint` rather than the shipped one, so pinning the write path
// cannot rewrite the file this repository keeps. `dry` is read here rather than
// at module load for the same reason: a test has to be able to ask for the dry
// report without a second process.
export function report({ request, code, fingerprint = FINGERPRINT, dry = process.argv.includes("--dry") }) {
  let body;
  try {
    body = JSON.parse(request.body);
  } catch {
    console.error("the captured request body is not JSON; nothing to read");
    process.exit(1);
  }

  // The shape is unpacked once, before anything asks a question of it: a tool
  // arrives either as `{ type, function: { … } }` or as the function object
  // itself, and `raw.function ?? raw` written out at each reading is one place
  // per reading that has to agree about which of the two arrived.
  const offered = (body.tools ?? []).map((raw) => raw?.function ?? raw);

  // Which generation this client is: the names it sends say so. It is read
  // before the tools are, since the two generations do not send the same names
  // and 2.x has to be recognised by `shell` rather than judged against 1.x's.
  const sent = new Set(offered.map((tool) => tool?.name));
  const generation = sent.has("shell") ? "2.x" : "1.x";
  const read = READ[generation];

  // Which protocol was captured, since each of 1.x's protocols bundles its own
  // provider-utils and a capture must not overwrite the ones it did not observe.
  // Anthropic is not one this can read: its tools carry `input_schema` where the
  // other two carry `parameters`, so read as the chat one it would write every
  // tool without its parameters and take the chat slot's provider-utils from an
  // anthropic client. Refused rather than written — and asked before the
  // per-tool loop below, which would otherwise refuse the same capture first
  // with "carries no parameter schema", a diagnosis about a schema that is there.
  if (offered.some((tool) => tool?.input_schema !== undefined)) {
    console.error("the captured request is in the anthropic shape, which this script cannot read; nothing written");
    process.exit(1);
  }
  const protocol = body.input !== undefined && body.messages === undefined ? "responses" : "chat";

  const tools = {};
  for (const tool of offered) {
    if (!tool?.name || !read.includes(tool.name) || !tool.description) continue;
    tools[tool.name] = {
      name: tool.name,
      description: NEUTRALISE.reduce((text, [find, to]) => text.replace(find, to), tool.description).slice(0, KEEP),
      parameters: tool.parameters,
    };
  }

  // A name this generation has to carry that the request does not carry at all:
  // this OpenCode no longer sends it, so the capture cannot be taken this way.
  // `sent` rather than `tools`, because `tools` only holds names that
  // arrived with a non-empty description — a required tool that is there and
  // carries no description would otherwise be reported as one this OpenCode
  // stopped sending.
  const required = REQUIRED[generation];
  const missing = required.filter((name) => !sent.has(name));
  if (missing.length) {
    console.error(
      `the captured request has no ${missing.join(", ")}; this OpenCode no longer sends them, so it cannot be captured this way`,
    );
    process.exit(1);
  }
  // The other half of the same question, and the one reading `sent` alone left
  // open: a required name that was sent but has no description to capture is in
  // `sent` and not in `tools`. Writing it into `required` would name a tool
  // the profile does not carry, which is the shape `bun run check:gate` refuses —
  // and the wording that would have said so is reported as GONE below, about a
  // tool that was sent. The two lists are held together here instead.
  const uncaptured = required.filter((name) => !tools[name]);
  if (uncaptured.length) {
    console.error(
      `the captured request carries ${uncaptured.join(", ")} without a description to capture; not writing`,
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
    // which has one. Only the anthropic shape is refused above, so a third shape
    // would otherwise reach here as a tool with no parameters at all — which
    // JSON.stringify drops from the written file in silence.
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      console.error(`${name} carries no parameter schema this script can read; not writing`);
      process.exit(1);
    }
  }

  console.log(`\nagent:  ${request.agent}`);
  console.log(`tools:  ${Object.keys(tools).join(", ")}  (${generation}, ${protocol})`);
  if (code !== 0) console.log(`(opencode exited ${code}; its request was still captured)`);

  const agent = parseAgent(request.agent, generation);
  if (agent.providerUtils) agent.providerUtils = { ...PROFILES[generation]?.agent?.providerUtils, [protocol]: agent.providerUtils[protocol] };

  const before = PROFILES[generation];
  // The whole profile is compared, not only the tools the new capture happens to
  // carry: the write below replaces `{ agent, required, tools }` entire, so a tool
  // that is no longer captured — or a `required` list that moved — is a change,
  // and reading it as "nothing changed" would leave the file describing a request
  // this OpenCode no longer makes.
  const nextProfile = { agent, required, tools };
  const same = (left, right) => JSON.stringify(order(left)) === JSON.stringify(order(right));
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

  if (dry) {
    // The agent is named whenever it moved, not only when it is the whole of
    // what moved: `changed` counts tools and the required list and never the
    // agent, so a run where the required list *and* the agent both changed used
    // to print the change count alone and leave the agent out of the report.
    const summary = drySummary({ changed, agentChanged });
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
    next = JSON.parse(readFileSync(fingerprint, "utf8"));
  } catch (cause) {
    console.error(`could not read ${fingerprint}: ${cause?.message ?? cause}`);
    process.exit(1);
  }
  if (!next || typeof next !== "object" || Array.isArray(next) || typeof next.profiles !== "object" || next.profiles === null) {
    console.error(`${fingerprint} has no profiles object; not writing`);
    process.exit(1);
  }
  next.profiles[generation] = nextProfile;
  // Written beside the target and renamed over it: a rename within one directory
  // is atomic, so the window in which an interruption can leave a half-written
  // file is the temp file's, not the shipped capture's. Writing in place left a
  // truncated fingerprint.json behind when the Ctrl-C these handlers exist for
  // arrived mid-write — and the remedy every consumer names is `bun run capture`,
  // the command that had just failed. The temp name is fixed and sits next to its
  // target, so it is on the same filesystem (a rename across devices is not
  // atomic, and here is not even allowed).
  const scratch = `${fingerprint}.tmp`;
  return Bun.write(scratch, JSON.stringify(next, null, 2) + "\n").then(
    () => {
      renameSync(scratch, fingerprint);
      console.log(
        `\nwrote ${fingerprint} for ${generation}. Now run \`bun run check:gate\` and commit if it passes.`,
      );
    },
    (cause) => {
      // A write that failed leaves its temp file where nothing reads it, and the
      // next run would find it stale: the capture that could not be written is
      // not one to be picked up later. The cleanup is therefore best-effort and
      // reports its own failure rather than raising it: `rmSync` throws for
      // anything but ENOENT, and what sits at the temp path when the write failed
      // is exactly what the write failed on — a directory raises ERR_FS_EISDIR,
      // which would replace the write error with a cleanup error and send the
      // reader after the wrong one. The error that says why the capture was not
      // written is the one that has to arrive.
      try {
        rmSync(scratch, { force: true });
      } catch (cleanup) {
        console.error(
          `could not remove ${scratch} (${cleanup?.code ?? cleanup?.message ?? cleanup}); it is left behind`,
        );
      }
      throw cause;
    },
  );
}

// The parts of the --dry sentence, in the order they are said: the change count
// when there is one, and "the agent" whenever the agent moved. The two are
// independent because `changed` never counts the agent — it is the tools and the
// required list — so a run where both moved has to say both, and a run where
// only the agent moved has a count of zero to say nothing about.
//
// `requiredChanged` is deliberately not a parameter, and the reason is worth
// stating because it looks like an omission. The summary used to be built inline
// under a guard reading `agentChanged && !requiredChanged`, and that guard cannot
// be reached from a run: `report` compares against the capture this process
// imported (`PROFILES`, above) while the list it captures and writes back is the
// `REQUIRED` literal in this file, so the two are the same list by construction
// and `requiredChanged` is false for every run that is not a hand-edited
// fingerprint changing under an already-loaded module. Re-injecting that guard is
// therefore a behaviour-equivalent mutation of `report`, not a hole in this
// file's coverage — no fixture can kill it, because the branch does not exist to
// be taken. What the guard decided is decided here instead, from the two booleans
// that do vary, and the pair that matters — a count *and* a moved agent — is
// pinned directly in capture.test.mjs rather than argued about through a run.
export function drySummary({ changed, agentChanged }) {
  return [changed ? `${changed} change(s)` : null, agentChanged ? "the agent" : null].filter(Boolean);
}

// Key order is not what is being captured: these objects come out of a parsed
// request body and out of a JSON file, and JSON.stringify is sensitive to the
// order they arrived in.
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, order(value[key])]));
}

// Where the capture goes, and the loopback server that reads the request the
// OpenCode under test makes. Only a run gets this far: `entry` above is false
// for an import, and the helpers this file exports are what the tests drive
// instead of a real `opencode`.
const entry = invokedDirectly();
if (entry) {
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

  const { code, ran } = await capture(
    `listening on 127.0.0.1:${PORT}, running opencode against it`,
    () =>
      spawn("opencode", ["run", "-m", "opencode/big-pickle", "Say OK."], {
        env: {
          ...process.env,
          XDG_DATA_HOME: join(home, "data"),
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_CACHE_HOME: join(home, "cache"),
        },
        stdio: ["ignore", "ignore", "inherit"],
      }),
  );
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
  // A run that was killed — the watchdog's SIGKILL, a Ctrl-C — is a failure
  // whatever code came back, and it must not reach the compare and write below:
  // that is how an aborted run used to rewrite fingerprint.json.
  if (!ran) process.exit(1);
  if (captured.body.length) await Bun.write(capturedPath, JSON.stringify(captured));

  let request;
  try {
    request = JSON.parse(readFileSync(capturedPath, "utf8"));
  } catch {
    console.error("no request was captured; opencode did not reach the local server");
    process.exit(1);
  }

  await report({ request, code });
}

// The User-Agent is stored the way agentFor() reads it back, which is not
// necessarily the same split the raw header used.
function parseAgent(agent, generation) {
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

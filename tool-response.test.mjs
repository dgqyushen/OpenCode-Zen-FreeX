import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BYTES, collapseResponse } from "./stream.mjs";
import { cutShortNote, droppedNote, guardToolResponse } from "./tool-response.mjs";

const encoder = new TextEncoder();
// The policy every test in this file guards against, at module scope so the
// loops that build the tests and the tests themselves share one value. A test
// body runs after module evaluation, so a `const` read from one is
// initialized by then whatever order the callbacks were registered in.
const policy = {
  declared: new Set(["Bash", "Read"]),
  injected: new Set(["bash", "read", "shell"]),
};
const protocols = ["chat", "responses", "anthropic"];
const event = (data, name) =>
  `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const terminal = (protocol) =>
  event(
    protocol === "chat"
      ? "[DONE]"
      : { type: protocol === "responses" ? "response.completed" : "message_stop" },
  );

for (const type of [
  "custom_tool_call",
  "computer_call",
  "local_shell_call",
  "shell_call",
  "mcp_call",
  "apply_patch_call",
]) {
  test(`Responses rejects unsupported ${type} in JSON and streaming snapshots`, async () => {
    const item = { type, name: "undeclared_command", call_id: "call1", input: "run" };
    const json = await guardToolResponse(Response.json({ output: [item] }), "responses", policy);
    assert.equal(json.status, 502);
    assertError("responses", await json.json(), false);
    for (const data of [
      { type: "response.output_item.added", item },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { output: [item] } },
    ]) {
      const response = await guardToolResponse(
        sse(event(data) + terminal("responses")),
        "responses",
        policy,
      );
      const text = await response.text();
      assert.doesNotMatch(text, /undeclared_command/);
      assertError("responses", parse(text)[0].data);
    }
  });
}
const chat = (delta, finish_reason = null, index = 0) => ({
  choices: [{ index, delta, finish_reason }],
});
const call = (name, index = 0, args = "{}") => ({
  index,
  id: `call-${index}`,
  type: "function",
  function: { name, arguments: args },
});
const tool = (protocol, name) =>
  protocol === "chat"
    ? call(name)
    : protocol === "responses"
      ? { type: "function_call", name, call_id: "call", arguments: "{}" }
      : { type: "tool_use", name, id: "call", input: {} };
function snapshot(protocol, names) {
  const tools = names.map((name) => tool(protocol, name));
  if (protocol === "chat")
    return { choices: [{ message: { role: "assistant", tool_calls: tools } }] };
  return protocol === "responses" ? { output: tools } : { type: "message", content: tools };
}
function streamSnapshot(protocol, names) {
  if (protocol === "chat")
    return chat({ tool_calls: names.map((name, index) => call(name, index)) }, "tool_calls");
  if (protocol === "responses")
    return { type: "response.completed", response: snapshot(protocol, names) };
  return { type: "message_start", message: snapshot(protocol, names) };
}
function namesIn(protocol, data) {
  if (protocol === "chat")
    return data.choices
      .flatMap((choice) => (choice.message ?? choice.delta)?.tool_calls ?? [])
      .map((value) => value.function.name);
  return (
    protocol === "responses" ? (data.response ?? data).output : (data.message ?? data).content
  ).map((value) => value.name);
}
// Every item shaped like a call, whichever kind it is: the three names the
// guard reads, and the shapes it rejects or replaces (custom_tool_call,
// local_shell_call, mcp_call, apply_patch_call, and whatever is added next).
// A leak assertion that only knew the three would not see the others.
const callShaped = (type) =>
  typeof type === "string" &&
  (type.endsWith("_call") || type === "tool_use" || type === "server_tool_use");
// The calls a reply (JSON, or every SSE frame's data) hands the agent, and
// the text it says.
function callsIn(protocol, values) {
  return values.flatMap((data) => {
    if (protocol === "chat")
      return (data.choices ?? [])
        .flatMap((choice) => (choice.message ?? choice.delta)?.tool_calls ?? [])
        .map((value) => value.function?.name);
    const items =
      protocol === "responses"
        ? [...((data.response ?? data).output ?? []), ...(data.item ? [data.item] : [])]
        : [
            ...((data.message ?? data).content ?? []),
            ...(data.content_block ? [data.content_block] : []),
          ];
    return items.filter((item) => callShaped(item.type)).map((item) => item.name);
  });
}
function textIn(protocol, values) {
  if (protocol === "chat")
    return values
      .flatMap((data) => data.choices ?? [])
      .map((choice) => (choice.message ?? choice.delta)?.content ?? "")
      .join("");
  // A stream's text is its deltas; a reply or snapshot's is its text parts.
  const deltas = values.filter((data) =>
    protocol === "responses"
      ? data.type === "response.output_text.delta"
      : data.type === "content_block_delta" && data.delta?.type === "text_delta",
  );
  if (deltas.length)
    return deltas.map((data) => (protocol === "responses" ? data.delta : data.delta.text)).join("");
  const snapshot = values
    .map((data) =>
      protocol === "responses" ? (data.response ?? data).output : (data.message ?? data).content,
    )
    .filter(Array.isArray)
    .at(-1);
  return (snapshot ?? [])
    .flatMap((item) =>
      protocol === "responses"
        ? item.type === "message"
          ? item.content.map((part) => part.text)
          : []
        : item.type === "text"
          ? [item.text]
          : [],
    )
    .join("");
}
const frameData = (text) =>
  parse(text)
    .map((frame) => frame.data)
    .filter((data) => data && data !== "[DONE]");
// One call streamed the way Zen streams it. Chat's is step-5-preview-free's
// own shape (2026-10-11): the name whole in the first delta with empty
// arguments, the arguments in pieces, and two tool_calls finishes.
function toolStream(protocol, name) {
  if (protocol === "chat") {
    const id = { id: "chatcmpl-1", model: "step-5-preview-free" };
    return (
      event({ ...id, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }) +
      event({
        ...id,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_773767abbc494d2a82872502",
                  type: "function",
                  function: { name, arguments: "" },
                },
              ],
            },
          },
        ],
      }) +
      ["", "{", '"command": "ls"', "}"]
        .map((part) =>
          event({
            ...id,
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] } },
            ],
          }),
        )
        .join("") +
      event({ ...id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      event({
        ...id,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }) +
      "data: [DONE]\n\n"
    );
  }
  if (protocol === "responses") {
    const item = { id: "fc_1", type: "function_call", call_id: "call_1", name, arguments: "" };
    const done = { ...item, arguments: '{"command":"ls"}', status: "completed" };
    const where = { item_id: "fc_1", output_index: 0 };
    return [
      { type: "response.created", response: { id: "r1", status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress" },
      },
      { type: "response.function_call_arguments.delta", ...where, delta: '{"command":' },
      { type: "response.function_call_arguments.delta", ...where, delta: '"ls"}' },
      { type: "response.function_call_arguments.done", ...where, arguments: '{"command":"ls"}' },
      { type: "response.output_item.done", output_index: 0, item: done },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [done] } },
    ]
      .map((value) => event(value, value.type))
      .join("");
  }
  return [
    {
      type: "message_start",
      message: { id: "m1", type: "message", role: "assistant", content: [] },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"ls"}' },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]
    .map((value) => event(value, value.type))
    .join("");
}
// An event no undeclared name can explain: a call of a kind the agent
// can't be handed, beside a declared one.
function badMixed(protocol) {
  if (protocol === "chat")
    return chat({ tool_calls: [call("Read"), { ...call("x", 1), type: "custom" }] }, "tool_calls");
  if (protocol === "responses")
    return {
      type: "response.completed",
      response: { output: [tool(protocol, "Read"), { type: "custom_tool_call", name: "x" }] },
    };
  return { type: "message_start", message: { content: [tool(protocol, "Read"), 5] } };
}
function parse(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r\n\r\n|\n\n|\r\r/)
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split(/\r\n|\r|\n/);
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return {
        name: lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim(),
        data: !data || data === "[DONE]" ? data : JSON.parse(data),
      };
    });
}
// The shape of a guard failure, and the code that says which failure it was:
// only a call of no tool the agent has is an undeclared one.
function assertError(protocol, data, stream = true, code = "upstream_error") {
  if (protocol === "chat") assert.equal(data.error.type, "upstream_error");
  if (protocol === "responses") {
    if (stream) {
      assert.equal(data.type, "error");
      assert.equal(data.code, code);
    } else {
      assert.equal(data.error.type, "upstream_error");
      assert.equal(data.error.code, code);
    }
  }
  if (protocol === "anthropic") {
    assert.equal(data.type, "error");
    assert.equal(data.error.type, "api_error");
  }
  assert.equal(typeof (data.message ?? data.error?.message), "string");
}
// The shape of a reply that dropped a call, whichever protocol and whichever
// path built it: no error in the reply, exactly the calls it kept, the note
// standing in for the one it left out, and no trace of the dropped name in
// the bytes. Written once, so a change to the note's text or to what counts
// as a call cannot leave the suites disagreeing about the same behaviour.
// The leak check is over the whole value on purpose: callsIn reads the call
// shapes it knows, so a call of another kind would be a leak it cannot see.
function assertOnlyDropped(protocol, values, name, kept) {
  assert.ok(!values.some((data) => data.type === "error" || data.error));
  assert.deepEqual(callsIn(protocol, values), kept);
  assert.equal(textIn(protocol, values), droppedNote(name));
  assert.ok(!JSON.stringify(values).includes(`"${name}"`), `${name} leaked in the reply`);
}
// A stream that never ends on its own is waited on with a budget: a hang is
// then reported as one instead of stalling the run. A loaded machine can push
// a real read past any fixed number, so the budget is per call and generous.
async function withTimeout(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("stream waited for EOF")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
// One factory for every upstream mock below: a Response whose body is a
// stream built from `pull`, the chunks it handed out counted, and the way a
// test pushes into it. The scaffolding is written once, so a fix to it applies
// to all of the mocks at once. There is no `close` here: every caller ends its
// stream from inside `pull`, and a member nothing calls is one the next reader
// has to prove dead before touching this.
function upstream(
  pull,
  { cancel = () => {}, headers = {}, status = 200, highWaterMark = 1 } = {},
) {
  let controller;
  let pulls = 0;
  const response = new Response(
    new ReadableStream(
      {
        start(value) {
          controller = value;
        },
        pull(value) {
          pulls++;
          return pull(value, pulls);
        },
        cancel,
      },
      { highWaterMark },
    ),
    { status, headers: { "content-type": "text/event-stream", ...headers } },
  );
  return {
    response,
    pulls: () => pulls,
    push: (value) => controller.enqueue(encoder.encode(value)),
  };
}
function sse(text, { chunkSize = 31, headers = {}, status = 200 } = {}) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return upstream(
    (controller) => {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    { status, headers },
  ).response;
}
function openSource(text, cancel = () => {}) {
  let first = true;
  return upstream(
    (controller) => {
      if (!first) return;
      first = false;
      controller.enqueue(encoder.encode(text));
    },
    { cancel, highWaterMark: 0 },
  );
}
// A chunked upstream the guard has to stop reading itself: it hands out
// `bytes` in `chunkSize` pieces, then leaves the stream open. `pulls` is how
// many chunks it took to be stopped.
function chunkedStream(bytes, { chunkSize = bytes.length, cancel = () => {} } = {}) {
  let offset = 0;
  return upstream(
    (controller) => {
      if (offset === bytes.length) return;
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    { cancel, highWaterMark: 0 },
  );
}
// The same, for an upstream that never runs out: `chunk` is the bytes of
// every pull, or a function of the pull count when the payload has to differ
// each time.
function endlessStream(chunk, { cancel = () => {} } = {}) {
  const next = typeof chunk === "function" ? chunk : () => chunk;
  return upstream((controller, pulls) => controller.enqueue(next(pulls - 1)), {
    cancel,
    highWaterMark: 0,
  });
}
// A body whose read fails while the body itself stays alive. The guard uses
// nothing of one but read/cancel/releaseLock, and a real stream errors itself
// when its read rejects — where a cancel is a no-op against the error already
// stored — so this is the only way to see whether that failure cancels what
// is left of the body or only releases it (#47).
function failingBody(cause, cancel = () => {}) {
  const handle = { cancellations: [], released: false };
  handle.response = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader: () => ({
        read: () => Promise.reject(cause),
        cancel: (reason) => {
          handle.cancellations.push(reason);
          return cancel(reason);
        },
        releaseLock: () => {
          handle.released = true;
        },
      }),
    },
  };
  return handle;
}

for (const protocol of protocols) {
  test(`${protocol}: JSON maps injected casing and retains declared names`, async () => {
    for (const names of [
      ["bash", "read"],
      ["Bash", "Read"],
    ]) {
      const result = await guardToolResponse(
        Response.json(snapshot(protocol, names)),
        protocol,
        policy,
      );
      assert.equal(result.status, 200);
      assert.deepEqual(namesIn(protocol, await result.json()), ["Bash", "Read"]);
    }
  });

  test(`${protocol}: JSON leaves out unknown, non-injected, ambiguous and semantic aliases, and says so (#76)`, async () => {
    for (const [name, rules] of [
      ["unknown", policy],
      ["shell", policy],
      ["bash", { declared: new Set(["Read", "Bash", "BASH"]), injected: new Set(["bash"]) }],
      [
        "todowrite",
        { declared: new Set(["Read", "todo_write", "todo-write"]), injected: new Set() },
      ],
      ["bash", { declared: new Set(["Read"]), injected: new Set(["bash"]) }],
    ]) {
      const response = await guardToolResponse(
        Response.json(snapshot(protocol, ["Read", name])),
        protocol,
        rules,
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assertOnlyDropped(protocol, [body], name, ["Read"]);
    }
  });

  // #76, tkhs101's table of 2026-10-10: the names step-5-preview-free
  // called that DSH has no tool for, and no spelling of one either. Each
  // failed the whole turn; each is now left out with the turn going on.
  //
  // The last is the table's own spelling, doubled "cat" and all, kept
  // verbatim rather than "fixed": it names a different server than the
  // declared mcp__netcatty-external__list_hosts, and that is what the table
  // recorded — a name with no spelling of a declared tool. The near miss
  // beside it (that same server, a tool it does not have) is the test below.
  const tableRules = {
    declared: new Set([
      "bash",
      "read",
      "edit",
      "glob",
      "grep",
      "write",
      "todo_write",
      "mcp__netcatty-external__list_hosts",
    ]),
    injected: new Set(),
  };
  test(`${protocol}: the names from #76's table are left out, not failed on`, async () => {
    for (const name of ["bedit", "bcp", "ash", "mcp__netcatcatty__unused"]) {
      const json = await guardToolResponse(
        Response.json(snapshot(protocol, ["bash", name])),
        protocol,
        tableRules,
      );
      assert.equal(json.status, 200);
      assertOnlyDropped(protocol, [await json.json()], name, ["bash"]);
      // Not named `upstream`: that is this file's own `upstream(...)` factory, and
      // this loop holds the bytes to read, not the thing that makes them.
      for (const bytes of [
        event(streamSnapshot(protocol, [name])) + terminal(protocol),
        toolStream(protocol, name),
      ]) {
        const streamed = await guardToolResponse(sse(bytes), protocol, tableRules);
        assert.equal(streamed.status, 200);
        const values = frameData(await streamed.text());
        assertOnlyDropped(protocol, values, name, []);
        assert.doesNotMatch(JSON.stringify(values), /"(?:tool_calls|tool_use|function_call)"/);
      }
    }
  });

  // The near miss the table's mangled name cannot cover: the declared server,
  // with a tool it does not have. A call is folded whole — case and
  // separators only — so sharing a server prefix is never enough to answer it
  // with another tool's name.
  test(`${protocol}: a tool the declared server does not have is left out, not matched by prefix`, async () => {
    const name = "mcp__netcatty-external__unused";
    const json = await guardToolResponse(
      Response.json(snapshot(protocol, ["bash", name])),
      protocol,
      tableRules,
    );
    assert.equal(json.status, 200);
    assertOnlyDropped(protocol, [await json.json()], name, ["bash"]);
    const streamed = await guardToolResponse(
      sse(event(streamSnapshot(protocol, [name])) + terminal(protocol)),
      protocol,
      tableRules,
    );
    assert.equal(streamed.status, 200);
    assertOnlyDropped(protocol, frameData(await streamed.text()), name, []);
  });

  // #76: DSH declares all five core tools (so nothing is injected) and
  // todo_write; step-5-preview-free opens with OpenCode's todowrite.
  test(`${protocol}: an OpenCode tool name is given the agent's own spelling of it (#76)`, async () => {
    const rules = {
      declared: new Set([
        "bash",
        "read",
        "edit",
        "glob",
        "grep",
        "write",
        "todo_write",
        "web_fetch",
        "TodoRead",
      ]),
      injected: new Set(),
    };
    for (const [asked, given] of [
      ["todowrite", "todo_write"],
      ["webfetch", "web_fetch"],
      ["todoread", "TodoRead"],
      ["BASH", "bash"],
    ]) {
      const json = await guardToolResponse(
        Response.json(snapshot(protocol, [asked])),
        protocol,
        rules,
      );
      assert.equal(json.status, 200);
      assert.deepEqual(namesIn(protocol, await json.json()), [given]);
      const streamed = await guardToolResponse(
        sse(event(streamSnapshot(protocol, [asked])) + terminal(protocol)),
        protocol,
        rules,
      );
      const frames = parse(await streamed.text()).filter(
        (frame) => frame.data && frame.data !== "[DONE]",
      );
      assert.deepEqual(namesIn(protocol, frames[0].data), [given]);
    }
  });

  test(`${protocol}: a call left out is named in the reply's text (#76)`, async () => {
    const json = await guardToolResponse(
      Response.json(snapshot(protocol, ["subagent"])),
      protocol,
      policy,
    );
    assert.equal(textIn(protocol, [await json.json()]), droppedNote("subagent"));
    const streamed = await guardToolResponse(
      sse(event(streamSnapshot(protocol, ["subagent"])) + terminal(protocol)),
      protocol,
      policy,
    );
    assert.equal(textIn(protocol, frameData(await streamed.text())), droppedNote("subagent"));
    assert.equal(
      droppedNote("x".repeat(300)),
      `(The model called a tool this agent doesn't have: "${"x".repeat(128)}". The call was left out.)`,
    );
    assert.equal(
      droppedNote(""),
      "(The model called a tool without a name. The call was left out.)",
    );
  });

  test(`${protocol}: exact matches win over ambiguous casing`, async () => {
    const rules = { declared: new Set(["bash", "Bash"]), injected: new Set(["bash"]) };
    const result = await guardToolResponse(
      Response.json(snapshot(protocol, ["bash"])),
      protocol,
      rules,
    );
    assert.deepEqual(namesIn(protocol, await result.json()), ["bash"]);
  });

  test(`${protocol}: SSE maps injected casing and retains declared names`, async () => {
    for (const names of [
      ["bash", "read"],
      ["Bash", "Read"],
    ]) {
      const result = await guardToolResponse(
        sse(event(streamSnapshot(protocol, names)) + terminal(protocol)),
        protocol,
        policy,
      );
      assert.equal(result.status, 200);
      const frames = parse(await result.text()).filter(
        (frame) => frame.data && frame.data !== "[DONE]",
      );
      const tools = frames.find(
        (frame) =>
          protocol !== "chat" || frame.data.choices?.some((choice) => choice.delta?.tool_calls),
      );
      assert.deepEqual(namesIn(protocol, tools.data), ["Bash", "Read"]);
      assert.ok(!frames.some((frame) => frame.name === "error" || frame.data.error));
    }
  });

  test(`${protocol}: bad mixed SSE snapshot never leaks a tool and cancels immediately`, async () => {
    let cancelled = false;
    const source = openSource(
      event(badMixed(protocol)) + event({ sentinel: "must not escape" }),
      () => {
        cancelled = true;
      },
    );
    const result = await guardToolResponse(source.response, protocol, policy);
    const frames = parse(await withTimeout(result.text()));
    assert.equal(frames.length, 1);
    assertError(protocol, frames[0].data);
    if (protocol !== "chat") assert.equal(frames[0].name, "error");
    assert.equal(cancelled, true);
    assert.equal(source.response.body.locked, false);
  });

  test(`${protocol}: a mixed SSE snapshot hands on the declared call and leaves out the rest (#76)`, async () => {
    for (const name of ["unknown", "shell", "todowrite"]) {
      const result = await guardToolResponse(
        sse(event(streamSnapshot(protocol, ["Read", name])) + terminal(protocol)),
        protocol,
        policy,
      );
      const values = frameData(await result.text());
      assertOnlyDropped(protocol, values, name, ["Read"]);
    }
  });

  test(`${protocol}: upstream SSE errors pass through byte-for-byte and cancel open streams`, async () => {
    const errors =
      protocol === "responses"
        ? [
            {
              type: "response.failed",
              response: {
                status: "failed",
                error: { code: "rate_limit_exceeded", message: "slow down 中文🙂" },
              },
            },
            { type: "error", code: "rate_limit_exceeded", message: "slow down 中文🙂" },
            { response: { status: "failed", error: { code: "server_error", message: "failed" } } },
          ]
        : protocol === "anthropic"
          ? [{ type: "error", error: { type: "overloaded_error", message: "busy 中文🙂" } }]
          : [
              {
                error: {
                  code: "rate_limit_exceeded",
                  type: "rate_limit_error",
                  message: "slow down 中文🙂",
                  param: null,
                },
              },
            ];
    const rawFrames = errors.map(
      (data) =>
        `\uFEFF: upstream\r\nid: err-7\r\nretry: 200\r\ndata: {\r\ndata: ${JSON.stringify(data).slice(1)}\r\n\r\n`,
    );
    if (protocol === "responses") {
      rawFrames.push(
        event({ response: { error: { code: "rate_limit_exceeded" } } }, "response.failed"),
      );
    }
    rawFrames.push(
      "\uFEFFevent:error\r\ndata: not JSON 中文🙂\r\ndata: second line\r\n\r\n",
      "event: error\ndata: {broken\n\n",
      "event: error\ndata: [DONE]\n\n",
      "event: error\n\n",
    );
    for (const raw of rawFrames) {
      for (const newline of ["\r\n", "\n", "\r"]) {
        const text = raw.replace(/\r\n|\n/g, newline);
        const bytes = encoder.encode(text);
        for (const chunkSize of [1, 2, 7, bytes.length - 1, bytes.length + 1024]) {
          let cancellations = 0;
          const trailing = encoder.encode(event(streamSnapshot(protocol, ["unknown"])));
          const all = new Uint8Array(bytes.length + trailing.length);
          all.set(bytes);
          all.set(trailing, bytes.length);
          const source = chunkedStream(all, {
            chunkSize,
            cancel: () => {
              cancellations++;
            },
          });
          const result = await guardToolResponse(source.response, protocol, policy);
          // One guard run per chunk size in this loop, on a machine that may
          // be running the 32 MiB tests beside it: more headroom than the
          // default budget, so a slow read is not reported as a hang.
          const actual = new Uint8Array(await withTimeout(result.arrayBuffer(), 15_000));
          assert.deepEqual(actual, bytes);
          assert.equal(cancellations, 1);
          assert.equal(source.response.body.locked, false);
          // The chunks the frame was read in, plus at most the one more a CR
          // at a chunk's end makes the reader look ahead for.
          const expected = Math.ceil(bytes.length / chunkSize);
          assert.ok(
            source.pulls() <= expected + 1,
            `read ${source.pulls()} chunks for ${expected} chunks of bytes`,
          );
        }
        // The open-stream half is skipped for CR-only endings, and this is
        // why: the parser has to see the byte after a lone CR to know the
        // frame ended (feed() looks one past it), and a source with
        // highWaterMark 0 that is never pulled again cannot supply it — the
        // guard would wait for an EOF that never comes (reproduced: it hung
        // until the 5 s budget). The chunked half above closes its stream and
        // so covers CR.
        if (newline === "\r") continue;
        let cancelled = false;
        const source = openSource(text, () => {
          cancelled = true;
        });
        const result = await guardToolResponse(source.response, protocol, policy);
        assert.deepEqual(new Uint8Array(await withTimeout(result.arrayBuffer())), bytes);
        assert.equal(cancelled, true);
        assert.equal(source.pulls(), 1);
      }
    }
  });

  test(`${protocol}: upstream SSE errors preserve cancellation failures`, async () => {
    for (const asynchronous of [false, true]) {
      const cause = new DOMException("cancel failed", "AbortError");
      const source = openSource(event("not JSON", "error"), () => {
        if (asynchronous) return Promise.reject(cause);
        throw cause;
      });
      const result = await guardToolResponse(source.response, protocol, policy);
      await assert.rejects(withTimeout(result.arrayBuffer()), (error) => error === cause);
      assert.equal(source.response.body.locked, false);
      assert.equal(source.pulls(), 1);
    }
  });

  test(`${protocol}: HTTP failures return the original unread response`, async () => {
    const source = sse(event(streamSnapshot(protocol, ["unknown"])), { status: 429 });
    assert.equal(await guardToolResponse(source, protocol, policy), source);
    assert.equal(source.bodyUsed, false);
  });

  test(`${protocol}: JSON and SSE remove stale entity headers, retain request metadata`, async () => {
    const headers = {
      "content-length": "42",
      "content-encoding": "gzip",
      "transfer-encoding": "chunked",
      "content-md5": "md5",
      etag: 'W/"stream"',
      "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
      "retry-after": "30",
      "x-request-id": "req",
    };
    for (const source of [
      Response.json(snapshot(protocol, ["bash"]), { headers }),
      sse(event(streamSnapshot(protocol, ["bash"])) + terminal(protocol), { headers }),
    ]) {
      const result = await guardToolResponse(source, protocol, policy);
      // What described the upstream's own bytes cannot describe a body this
      // guard may have written again, whichever path wrote it.
      for (const name of [
        "content-length",
        "content-encoding",
        "transfer-encoding",
        "content-md5",
        "etag",
        "last-modified",
      ])
        assert.equal(result.headers.get(name), null, name);
      assert.equal(result.headers.get("retry-after"), "30");
      assert.equal(result.headers.get("x-request-id"), "req");
      await result.text();
    }
  });

  test(`${protocol}: truncated streams emit a protocol error`, async () => {
    for (const text of ["", event({ harmless: true }), 'data: {"unfinished":']) {
      const result = await guardToolResponse(sse(text), protocol, policy);
      assertError(protocol, parse(await result.text()).at(-1).data);
    }
  });

  test(`${protocol}: downstream cancellation propagates its reason without pre-reading`, async () => {
    const reason = new Error("client stopped");
    let received;
    const source = openSource(event({ harmless: true }), (value) => {
      received = value;
    });
    const result = await guardToolResponse(source.response, protocol, policy);
    assert.equal(source.pulls(), 0);
    await result.body.cancel(reason);
    assert.equal(received, reason);
    assert.equal(source.pulls(), 0);
    assert.equal(source.response.body.locked, false);
  });

  test(`${protocol}: transport read failures preserve the original exception`, async () => {
    const cause = new DOMException("upstream aborted", "AbortError");
    const source = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(cause);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const result = await guardToolResponse(source, protocol, policy);
    await assert.rejects(result.text(), (error) => error === cause);
    assert.equal(source.body.locked, false);
  });

  test(`${protocol}: a transport failure cancels the body rather than only releasing it (#47)`, async () => {
    const cause = new TypeError("terminated");
    const body = failingBody(cause);
    const result = await guardToolResponse(body.response, protocol, policy);
    await assert.rejects(result.text(), (error) => error === cause);
    // The release alone left what was left of the body writing into a socket
    // nobody reads; the cancel is what stops it, and it carries the failure.
    assert.deepEqual(body.cancellations, [cause]);
    assert.equal(body.released, true);
  });

  test(`${protocol}: a failing cancel does not replace the transport error (#47)`, async () => {
    const cause = new TypeError("terminated");
    const body = failingBody(cause, () => {
      throw new Error("cancel failed");
    });
    const result = await guardToolResponse(body.response, protocol, policy);
    await assert.rejects(result.text(), (error) => error === cause);
    assert.equal(body.released, true);
  });

  test(`${protocol}: cancel failures propagate rather than being swallowed`, async () => {
    const cause = new Error("cancel failed");
    for (const badTool of [false, true]) {
      const source = openSource(event(badMixed(protocol)), () => {
        throw cause;
      });
      const result = await guardToolResponse(source.response, protocol, policy);
      await assert.rejects(
        badTool ? result.text() : result.body.cancel("stop"),
        (error) => error === cause,
      );
      assert.equal(source.response.body.locked, false);
    }
  });

  test(`${protocol}: malformed JSON is a protocol-shaped 502`, async () => {
    const result = await guardToolResponse(
      new Response("{broken", { headers: { "content-type": "application/json" } }),
      protocol,
      policy,
    );
    assert.equal(result.status, 502);
    assertError(protocol, await result.json(), false);
  });
}

test("an unsupported protocol is refused before the upstream's status is read (#48)", async () => {
  // The check used to sit behind the !response.ok return, so the same caller
  // mistake was a TypeError over a 200 and an untouched upstream error over a
  // 500: the upstream's status decided whether the mistake was reported.
  for (const status of [200, 500]) {
    await assert.rejects(
      guardToolResponse(Response.json({}, { status }), "bogus", policy),
      (error) => error instanceof TypeError && /Unsupported protocol/.test(error.message),
    );
  }
});

// The names the guard reads the policy for. `new Set(undefined)` does not
// throw — it answers an empty set — so a field that was renamed, or a policy
// built by mistake, used to turn every call of every reply into "a tool this
// agent doesn't have": chat lost every tool call, and Responses and Messages
// calls were rewritten into explanation text, with nothing thrown and nothing
// logged to say why. A policy the guard cannot read is a caller's mistake and
// is refused by name — the same rule, and the same place, as the protocol
// above: before the upstream's status decides whether it is reported.
test("a policy whose declared field cannot be read is refused by name", async () => {
  const rejected = [
    ["a policy with no declared field", {}],
    ["no policy at all", undefined],
    ["a null declared field", { declared: null }],
    ["a declared field that is a string", { declared: "Bash" }],
    ["a declared field that is an object", { declared: { Bash: true } }],
    ["an array holding something that is not a name", { declared: ["Bash", 7] }],
    ["a Set holding something that is not a name", { declared: new Set(["Bash", null]) }],
  ];
  for (const [what, bad] of rejected) {
    for (const status of [200, 500]) {
      await assert.rejects(
        guardToolResponse(Response.json({}, { status }), "chat", bad),
        (error) =>
          error instanceof TypeError &&
          !error.code &&
          /policy\.declared/.test(error.message),
        `${what} was read as a policy of no tools`,
      );
    }
  }
  // The two shapes it does read: what this package's own producer builds, and
  // an array of names — and the guard works the same with either.
  for (const declared of [new Set(["Bash"]), ["Bash"]]) {
    const result = await guardToolResponse(
      Response.json({
        choices: [
          { message: { tool_calls: [{ type: "function", id: "c1", function: { name: "bash", arguments: "{}" } }] } },
        ],
      }),
      "chat",
      { declared },
    );
    assert.equal(result.status, 200);
    assert.equal((await result.json()).choices[0].message.tool_calls[0].function.name, "Bash");
  }
});

// An item id stands in for the item, so two calls left out of one reply that
// arrived without ids cannot be handed the same one: a Responses client keys
// by it, and the streamed path suppresses arguments by it (#49).
test("Responses: dropped calls without ids are replaced by items with distinct ids", async () => {
  const output = ["one", "two"].map((name) => ({ type: "function_call", name, arguments: "{}" }));
  const json = await guardToolResponse(Response.json({ output }), "responses", policy);
  assert.equal(json.status, 200);
  const items = (await json.json()).output;
  assert.deepEqual(
    items.map((item) => item.content[0].text),
    [droppedNote("one"), droppedNote("two")],
  );
  assert.equal(new Set(items.map((item) => item.id)).size, 2, "two items shared one id");
  const streamed = await guardToolResponse(
    sse(
      event({ type: "response.output_item.added", output_index: 0, item: output[0] }) +
        event({ type: "response.output_item.added", output_index: 1, item: output[1] }) +
        event({ type: "response.completed", response: { output } }, "response.completed"),
    ),
    "responses",
    policy,
  );
  assert.equal(streamed.status, 200);
  const added = frameData(await streamed.text()).filter(
    (data) => data.type === "response.output_item.added",
  );
  assert.equal(new Set(added.map((data) => data.item.id)).size, 2, "two added items shared one id");
});

// One call is replaced more than once — the frame that opens it, the frame that
// closes it, and the copy inside the terminal response's output — and a client
// keys an item by its id. A counter that gave every replacement a fresh id made
// one call into several items and left the arguments frames of it unmatched: the
// call's place in the reply is the same in all three, so that is what the
// invented id names.
test("Responses: one dropped call keeps one id across its added, done and terminal copies", async () => {
  const call = { type: "function_call", name: "nonexistent", arguments: "{}" };
  const streamed = await guardToolResponse(
    sse(
      event({ type: "response.output_item.added", output_index: 0, item: call }) +
        event({ type: "response.output_item.done", output_index: 0, item: call }) +
        event({ type: "response.completed", response: { output: [call] } }, "response.completed"),
    ),
    "responses",
    policy,
  );
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  const replaced = data
    .filter(
      (value) =>
        value.type === "response.output_item.added" ||
        value.type === "response.output_item.done",
    )
    .map((value) => value.item.id);
  // Not named `terminal`: this file's `terminal(protocol)` helper is the module's
  // own, and a frame called by the same name would have hidden it from here on.
  const terminalFrame = data.find((value) => value.type === "response.completed");
  assert.equal(replaced.length, 2, "both item frames are answered");
  assert.equal(new Set(replaced).size, 1, "one call became several items");
  assert.equal(
    terminalFrame.response.output[0].id,
    replaced[0],
    "and the terminal's copy is that same item",
  );
});

// Both arms invent ids within one reply, so they cannot share a word: a counter
// that reached another call's index handed two unrelated calls the same item —
// the failure the counter itself exists to prevent — and a client that keys by
// id then reads one call's arguments as the other's.
test("Responses: a call the reply places nowhere never shares an id with a placed one", async () => {
  const placed = Array.from({ length: 64 }, (_, index) => ({
    type: "function_call",
    name: `nonexistent-${index}`,
    arguments: "{}",
  }));
  const response = await guardToolResponse(
    Response.json({
      item: { type: "function_call", name: "nonexistent-placeless", arguments: "{}" },
      output: placed,
    }),
    "responses",
    policy,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const ids = [body.item, ...body.output].map((item) => item.id);
  assert.equal(ids.length, placed.length + 1);
  assert.equal(
    new Set(ids).size,
    ids.length,
    `two dropped calls shared an id: ${ids.filter((id, at) => ids.indexOf(id) !== at).join(", ")}`,
  );
  assert.match(
    body.item.id,
    /^msg_anon_\d+$/,
    "the placeless call is the counter's, under a word of its own",
  );
});

// The id an item is keyed by has to be the same one every time the same call
// is replaced, and the frames of the reply are all the guard has to tell one
// call from another: a stream that carries no output_index and no item id
// leaves the place of each call to the order it opens them in. A counter per
// rewrite made one dropped call three items to the client — its added frame,
// its done frame and the terminal's copy of it each answered a different id —
// and left the call's arguments frames, which name an item the reply never
// opened an item for, forwarded to describe an item that was replaced.
// Collapsing the same bytes for a client that reads no stream then refused
// them ("an unknown item without an output index") where the streaming client
// was given a reply, so the two paths disagreed about the same upstream.
test("Responses: a dropped call the frames place nowhere answers one id, in both paths", async () => {
  const call = { type: "function_call", name: "nonexistent", arguments: "" };
  const text =
    event({ type: "response.output_item.added", item: call }) +
    event({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a"' }) +
    event({
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      arguments: '{"a":1}',
    }) +
    event({ type: "response.output_item.done", item: { ...call, arguments: '{"a":1}' } }) +
    event(
      { type: "response.completed", response: { status: "completed", output: [{ ...call, arguments: '{"a":1}' }] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  const items = [
    ...data.filter((value) => value.item).map((value) => value.item),
    ...(data.find((value) => value.type === "response.completed")?.response.output ?? []),
  ];
  assert.equal(new Set(items.map((item) => item.id)).size, 1, "one call became several items");
  assert.equal(items[0].id, items[1].id, "the done frame answers the added frame's id");
  assert.ok(
    !data.some((value) => value.type?.startsWith("response.function_call_arguments")),
    "the arguments of a call that was left out reached the client",
  );
  assert.deepEqual(callsIn("responses", data), []);
  assert.equal(textIn("responses", data), droppedNote("nonexistent"));
  // The bytes the same upstream sent, collapsed for a client that reads no
  // stream: a reply saying the call was left out, not a 502 about an item.
  const collapsed = await collapseResponse(
    await guardToolResponse(sse(text), "responses", policy),
    "responses",
  );
  assert.equal(collapsed.status, 200);
  const body = await collapsed.json();
  assert.equal(body.output.length, 1);
  assert.equal(body.output[0].content[0].text, droppedNote("nonexistent"));
});

// The other side of that rule: a call the reply named nowhere is not the only
// item a stream can hold, and the frames of one the agent does have must not
// be swallowed with it — a frame naming an item the reply did name on an item
// of its own belongs to that item. The frames of the call that was left out
// are left out with it (they used to be forwarded, describing an item the
// client was told was replaced by a note).
test("Responses: a placeless call's arguments are left out with it, and one the agent has keeps its own", async () => {
  const kept = { type: "function_call", name: "bash", arguments: "" };
  const text =
    event({ type: "response.output_item.added", item: { type: "function_call", name: "nonexistent", arguments: "" } }) +
    event({ type: "response.function_call_arguments.delta", item_id: "fc_dropped", delta: "{}" }) +
    event({ type: "response.output_item.added", item: kept }) +
    event({ type: "response.function_call_arguments.delta", item_id: "fc_kept", delta: '{"command":"ls"}' }) +
    event({ type: "response.function_call_arguments.done", item_id: "fc_kept", arguments: '{"command":"ls"}' }) +
    event({ type: "response.output_item.done", item: kept }) +
    event({ type: "response.completed", response: { status: "completed", output: [kept] } }, "response.completed");
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  const forwarded = data.filter((value) =>
    value.type?.startsWith("response.function_call_arguments"),
  );
  assert.deepEqual(
    forwarded.map((value) => value.item_id),
    ["fc_kept", "fc_kept"],
    "the kept call's arguments frames were left out with another call",
  );
  // The kept call is copied into its added frame, its done frame and the
  // terminal response, so its name is read once per copy; the call left out
  // is named nowhere but in the note.
  assert.deepEqual([...new Set(callsIn("responses", data))], ["Bash"]);
  assert.ok(!JSON.stringify(data).includes('"nonexistent"'), "the dropped call leaked");
});

// F2 (review, v0.2.16): the suppression above matched a call left out by the
// output_index its own frame gave or by an invented id, and the arguments
// frames of the measured route carry neither — the item is numbered, and the
// frames after it name it by an id. Those frames went to the client, telling
// it about an item it had been told was replaced by a note, and the guard's
// own bytes could not be read back at all: the collapse path took the frame
// for one naming an unknown item without an index and refused the whole reply
// (502), where the upstream's own bytes are a 200. Every word the call is
// named by is what its frames are matched by now, and a declared call beside
// it keeps every one of its own.
test("Responses: a dropped call that gave an index keeps its arguments frames out, in both paths", async () => {
  const dropped = { type: "function_call", call_id: "call_x", name: "nonexistent", arguments: "" };
  const kept = { id: "fc_2", type: "function_call", call_id: "call_2", name: "bash", arguments: "" };
  const completed = (item, extra) => ({ ...item, arguments: extra, status: "completed" });
  const text =
    event(
      { type: "response.output_item.added", output_index: 0, item: { ...dropped, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "call_x", delta: '{"a"' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.function_call_arguments.done", item_id: "call_x", arguments: '{"a":1}' },
      "response.function_call_arguments.done",
    ) +
    event(
      { type: "response.output_item.added", output_index: 1, item: { ...kept, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "fc_2", output_index: 1, delta: '{"command":' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.function_call_arguments.done", item_id: "fc_2", output_index: 1, arguments: '{"command":"ls"}' },
      "response.function_call_arguments.done",
    ) +
    event({ type: "response.output_item.done", output_index: 0, item: completed(dropped, '{"a":1}') }) +
    event({ type: "response.output_item.done", output_index: 1, item: completed(kept, '{"command":"ls"}') }) +
    event(
      {
        type: "response.completed",
        response: { id: "r1", status: "completed", output: [completed(dropped, '{"a":1}'), completed(kept, '{"command":"ls"}')] },
      },
      "response.completed",
    );
  // The same bytes upstream, collapsed for a client that reads no stream: a
  // reply, not a refusal.
  assert.equal((await collapseResponse(sse(text), "responses")).status, 200);
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  // (c) no frame describes the call that was replaced by a note, and (d) the
  // declared call's arguments are all there.
  assert.deepEqual(
    data
      .filter((value) => value.type?.startsWith("response.function_call_arguments"))
      .map((value) => value.item_id),
    ["fc_2", "fc_2"],
    "a call left out kept its arguments frames, or a kept call lost its own",
  );
  // The words the client is handed: the note item's invented id, and the kept
  // call's own. The dropped call's call_id is nowhere on its own — the frames
  // that named it are the ones that were left out.
  assert.deepEqual(
    [
      ...new Set([
        ...data.flatMap((value) => (value.item_id !== undefined ? [value.item_id] : [])),
        ...data.filter((value) => value.item).map((value) => value.item.id),
        ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
          (item) => item.id,
        ),
      ]),
    ].sort(),
    ["fc_2", "msg_call_x"],
  );
  assert.equal(textIn("responses", data), droppedNote("nonexistent"));
  // (b) The guard's own bytes, read back: the same reply, not the 502 they
  // were refused with, and the same items the stream handed the client.
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200);
  const items = (await collapsed.json()).output.map((item) => `${item.id}:${item.type}`).sort();
  const handed = [
    ...new Set([
      ...data.filter((value) => value.item).map((value) => `${value.item.id}:${value.item.type}`),
      ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
        (item) => `${item.id}:${item.type}`,
      ),
    ]),
  ].sort();
  assert.deepEqual(items, handed, "the streamed reply and its collapsed copy disagree");
  assert.deepEqual(items, ["fc_2:function_call", "msg_call_x:message"]);
});

// The other half of that shape: the frame that opens the call can carry
// nothing at all to name it by, and the id only turns up on the arguments
// frames and the frame that closes it. Those frames name an item the reply
// names nowhere else, and the stream inside the call is what says whose they
// are. The call answers one id throughout — the id its opening frame was
// replaced by, which is what the client already has.
test("Responses: a dropped call its frames name nowhere else answers the one id it was given", async () => {
  const bare = { type: "function_call", name: "nonexistent", arguments: "" };
  const named = { ...bare, id: "fc_9", arguments: '{"a":1}', status: "completed" };
  const text =
    event(
      { type: "response.output_item.added", output_index: 0, item: { ...bare, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "fc_9", delta: '{"a"' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.function_call_arguments.done", item_id: "fc_9", arguments: '{"a":1}' },
      "response.function_call_arguments.done",
    ) +
    event({ type: "response.output_item.done", output_index: 0, item: named }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [named] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  assert.deepEqual(
    data.filter((value) => value.type?.startsWith("response.function_call_arguments")).map((v) => v.item_id),
    [],
    "the arguments of a call that was left out reached the client",
  );
  const ids = [
    ...data.filter((value) => value.item).map((value) => value.item.id),
    ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
      (item) => item.id,
    ),
  ];
  assert.deepEqual(ids, ["msg_dropped_0", "msg_dropped_0", "msg_dropped_0"]);
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200);
  assert.deepEqual(
    (await collapsed.json()).output.map((item) => item.id),
    ["msg_dropped_0"],
  );
});

// The difference the suppression above makes: an id the reply later names on
// an item of its own is that item's, whatever a call left out was named by
// before it. A kept call whose arguments frames name the id it was opened
// with keeps them, though a call left out of the same reply answered the same
// word.
test("Responses: a kept call's arguments survive an id a dropped call was named by", async () => {
  const dropped = { type: "function_call", call_id: "shared", name: "nonexistent", arguments: "" };
  const kept = { id: "shared", type: "function_call", call_id: "call_2", name: "bash", arguments: "" };
  const text =
    event(
      { type: "response.output_item.added", output_index: 0, item: { ...dropped, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "shared", delta: '{"a"' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.output_item.added", output_index: 1, item: { ...kept, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event(
      { type: "response.function_call_arguments.delta", item_id: "shared", delta: '{"command":' },
      "response.function_call_arguments.delta",
    ) +
    event(
      { type: "response.function_call_arguments.done", item_id: "shared", arguments: '{"command":"ls"}' },
      "response.function_call_arguments.done",
    ) +
    event({ type: "response.output_item.done", output_index: 1, item: { ...kept, arguments: '{"command":"ls"}', status: "completed" } }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [{ ...kept, arguments: '{"command":"ls"}', status: "completed" }] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  assert.deepEqual(
    data
      .filter((value) => value.type?.startsWith("response.function_call_arguments"))
      .map((value) => [value.type.replace("response.function_call_arguments.", ""), value.item_id]),
    [
      ["delta", "shared"],
      ["done", "shared"],
    ],
    "the kept call's arguments were left out with another call",
  );
});

// F4 (review, v0.2.16): "" is not a name. `identified` read a call_id of ""
// as an identity, so the call was not given a place, while inPlaceOf's
// `call_id ?? …` read the same "" as present — and two such calls of one
// reply became the one item `msg_`, with their arguments frames matching
// neither. The three places that ask whether a call has an identity ask it
// the same way now: a non-empty string, or nothing.
test('Responses: two calls with a call_id of "" are two items, not one', async () => {
  const output = ["one", "two"].map((name) => ({
    type: "function_call",
    call_id: "",
    name,
    arguments: "{}",
  }));
  const json = await guardToolResponse(Response.json({ output }), "responses", policy);
  assert.equal(json.status, 200);
  const items = (await json.json()).output;
  assert.deepEqual(
    items.map((item) => item.content[0].text),
    [droppedNote("one"), droppedNote("two")],
  );
  assert.deepEqual(
    items.map((item) => item.id),
    ["msg_dropped_0", "msg_dropped_1"],
    "an empty call_id named nothing, yet the two calls became one item",
  );
  // The streamed shape: the calls are placeless (nothing names them), so each
  // answers a token of its own, and the arguments frames naming "" are left
  // out with them rather than describing the notes in their place.
  const bare = (name) => ({ type: "function_call", call_id: "", name, arguments: "" });
  const text =
    event({ type: "response.output_item.added", item: bare("one") }, "response.output_item.added") +
    event({ type: "response.function_call_arguments.delta", item_id: "", delta: "{}" }, "response.function_call_arguments.delta") +
    event({ type: "response.output_item.added", item: bare("two") }, "response.output_item.added") +
    event({ type: "response.function_call_arguments.done", item_id: "", arguments: "{}" }, "response.function_call_arguments.done") +
    event({ type: "response.output_item.done", item: bare("two") }) +
    event({ type: "response.output_item.done", item: bare("one") }) +
    event(
      { type: "response.completed", response: { status: "completed", output: [bare("one"), bare("two")] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const data = frameData(await streamed.text());
  const ids = [
    ...data.filter((value) => value.item).map((value) => value.item.id),
    ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
      (item) => item.id,
    ),
  ];
  assert.equal(new Set(ids).size, 2, `two calls shared one item: ${ids.join(", ")}`);
  assert.deepEqual(
    data.filter((value) => value.type?.startsWith("response.function_call_arguments")).map((v) => v.item_id),
    [],
    "the arguments frames of the calls left out reached the client",
  );
});

// The same call read the other way round: a call_id of null was never an
// identity, and two of those calls were two items already. It is what the
// empty string has to read like, so the two shapes are pinned side by side.
test("Responses: two calls with a call_id of null are two items, as they always were", async () => {
  const output = ["one", "two"].map((name) => ({
    type: "function_call",
    call_id: null,
    name,
    arguments: "{}",
  }));
  const response = await guardToolResponse(Response.json({ output }), "responses", policy);
  assert.equal(response.status, 200);
  const items = (await response.json()).output;
  assert.deepEqual(
    items.map((item) => item.id),
    ["msg_dropped_0", "msg_dropped_1"],
  );
  const collapsed = await collapseResponse(Response.json({ output }), "responses");
  assert.equal(collapsed.status, 200);
});

// F5 (review, v0.2.16): one call is replaced more than once — the frame that
// opens it, the frame that closes it, and the copy inside the terminal
// response — and a client keys an item by the id it was handed. The measured
// route names the call only partway through: the added frame carries no id,
// and the done frame and the terminal's copy carry one. Answering that id
// where the call's place had already answered a token made one call two items
// to the client. The id a stream has answered for a call is what every later
// copy of it answers.
test("Responses: a dropped call answers one id, though a later copy carries its own", async () => {
  const opened = { type: "function_call", name: "nonexistent", arguments: "" };
  const named = { ...opened, id: "fc_1", call_id: "call_1", arguments: '{"a":1}', status: "completed" };
  const text =
    event(
      { type: "response.output_item.added", item: { ...opened, status: "in_progress" } },
      "response.output_item.added",
    ) +
    event({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a"' }, "response.function_call_arguments.delta") +
    event({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"a":1}' }, "response.function_call_arguments.done") +
    event({ type: "response.output_item.done", item: named }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [named] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  const ids = [
    ...data.filter((value) => value.item).map((value) => value.item.id),
    ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
      (item) => item.id,
    ),
  ];
  assert.equal(ids.length, 3, "the added frame, the done frame and the terminal's copy");
  assert.equal(new Set(ids).size, 1, `one call became ${new Set(ids).size} items: ${ids.join(", ")}`);
  assert.match(ids[0], /^msg_anon_\d+$/, "the id the frames answered is the one kept");
  // And the guard's own bytes read back as the same item, not as two.
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200);
  assert.deepEqual(
    (await collapsed.json()).output.map((item) => item.id),
    [ids[0]],
  );
});

// task-11, residual 2: a dropped call with nothing to place it by, and then a
// call the reply numbered. The note the guard puts in the first one's place is
// an item of its own with no index, and the collapse path's "next free slot"
// gave it the very slot the numbered call then claimed: the streaming client
// was told the call had been left out, the client that reads no stream never
// heard of it. The bytes the guard answers with are a reply to both, which is
// the invariant this file's every rewrite is measured against.
test("Responses: a dropped placeless call beside a numbered one is one reply to both clients", async () => {
  const dropped = { type: "function_call", id: "d1", name: "bedit", arguments: "" };
  const kept = { id: "k1", type: "function_call", name: "bash", arguments: "" };
  const text =
    event({ type: "response.output_item.added", item: { ...dropped, status: "in_progress" } }) +
    event({ type: "response.function_call_arguments.delta", item_id: "d1", delta: '{"x":3}' }) +
    event({ type: "response.function_call_arguments.done", item_id: "d1", arguments: '{"x":3}' }) +
    event({ type: "response.output_item.done", item: { ...dropped, arguments: '{"x":3}', status: "completed" } }) +
    event({ type: "response.output_item.added", output_index: 0, item: { ...kept, arguments: "", status: "in_progress" } }) +
    event({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "k1", delta: '{"k":1}' }) +
    event({ type: "response.function_call_arguments.done", output_index: 0, item_id: "k1", arguments: '{"k":1}' }) +
    event({ type: "response.output_item.done", output_index: 0, item: { ...kept, arguments: '{"k":1}', status: "completed" } }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200, "the guard's own bytes are not a reply");
  const items = (await collapsed.json()).output;
  assert.equal(items.length, 2, "the note and the declared call are two items, not one");
  assert.deepEqual(
    items.map((item) => (item.type === "message" ? "message" : `${item.id}:${item.type}`)).sort(),
    ["k1:function_call", "message"],
  );
  // The note answers a token of the guard's own (its count is the process's,
  // so the shape is what is pinned here), and it is the text of the call that
  // was left out.
  assert.match(items.find((item) => item.type === "message").id, /^msg_anon_\d+$/);
  assert.equal(textIn("responses", data), droppedNote("bedit"), "the note reached the stream");
  assert.deepEqual(
    data
      .filter((value) => value.type?.startsWith("response.function_call_arguments"))
      .map((value) => [value.item_id, value.type.endsWith(".done") ? value.arguments : value.delta]),
    [
      ["k1", '{"k":1}'],
      ["k1", '{"k":1}'],
    ],
    "the declared call's arguments, or a call left out kept its own",
  );
});

// task-11, residual 3: one id, two items — the kept call is named X by the
// reply, and so is the call the guard leaves out. The dropped call's frames
// describe an item that was replaced by a note, so they are left out in either
// order; the answer used to be read off two sets of words subtracted from each
// other, which made it depend on which call came first — the kept call's word
// let the dropped call's frames through when the kept call was the first one.
// It is read off the places the reply's items hold now. The note is the guard's
// own item and is named in the guard's own namespace, so the word the kept
// item holds names one item again, and both clients read the same reply.
test("Responses: one id on two items leaves the dropped call's frames out in both orders", async () => {
  const frames = (name, index, payload, argsShape) => {
    const where = argsShape === "both" ? { output_index: index, item_id: "X" } : { item_id: "X" };
    return [
      event({
        type: "response.output_item.added",
        output_index: index,
        item: { type: "function_call", id: "X", name, arguments: "" },
      }),
      event({ type: "response.function_call_arguments.delta", ...where, delta: payload }),
      event({ type: "response.function_call_arguments.done", ...where, arguments: payload }),
      event({
        type: "response.output_item.done",
        output_index: index,
        item: { type: "function_call", id: "X", name, arguments: payload, status: "completed" },
      }),
    ].join("");
  };
  const kept = frames("bash", 0, '{"k":1}', "both");
  const dropped = frames("bedit", 1, '{"d":1}', "item_id");
  const end = event(
    { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
    "response.completed",
  );
  for (const [what, text] of [
    ["the kept call first", kept + dropped + end],
    ["the dropped call first", dropped + kept + end],
  ]) {
    const streamed = await guardToolResponse(sse(text), "responses", policy);
    assert.equal(streamed.status, 200, what);
    const guarded = await streamed.text();
    const data = frameData(guarded);
    // The dropped call's frames carry its own payload and no place of their
    // own; the kept call's carry theirs and their place.
    assert.deepEqual(
      data
        .filter((value) => value.type?.startsWith("response.function_call_arguments"))
        .map((value) => [value.item_id, value.output_index, value.delta ?? value.arguments]),
      [
        ["X", 0, '{"k":1}'],
        ["X", 0, '{"k":1}'],
      ],
      `${what}: a call left out kept its arguments frames`,
    );
    assert.ok(
      !JSON.stringify(data).includes('"d":1'),
      `${what}: the dropped call's arguments reached the client`,
    );
    // The note does not take the word the kept item holds: one id, one item.
    const ids = [
      ...data.filter((value) => value.item).map((value) => value.item.id),
      ...(data.find((value) => value.type === "response.completed")?.response.output ?? []).map(
        (item) => item.id,
      ),
    ];
    assert.deepEqual([...new Set(ids)].sort(), ["X", "msg_dropped_1"], what);
    const collapsed = await collapseResponse(sse(guarded), "responses");
    assert.equal(collapsed.status, 200, `${what}: the guard's own bytes are not a reply`);
    assert.deepEqual(
      (await collapsed.json()).output.map((item) => `${item.id}:${item.type}`).sort(),
      ["X:function_call", "msg_dropped_1:message"],
      `${what}: the streamed reply and its collapsed copy disagree`,
    );
  }
});

// F5, second round: the frame that closes a call can carry nothing at all — no
// word of its own and no index — while the frame that opened it named the call
// by a call_id and gave it no index. Recognising the closing frame used to
// need a word in the opening frame, so it minted an id of its own: one call
// answered two ids, one of which no added frame had ever opened, and the
// guard's own bytes could not be collapsed (502 — the invariant F2 exists for).
// The entry a placeless call leaves in the stream is what says which call a
// frame with nothing to name it by belongs to, and it carries the id the guard
// answered for it, whichever word the opening frame had.
test("Responses: a dropped call whose closing frame carries nothing answers the id it opened with", async () => {
  const T = (output) =>
    event(
      {
        type: "response.completed",
        response: { id: "r1", status: "completed", ...(output === undefined ? {} : { output }) },
      },
      "response.completed",
    );
  const added = (item) => event({ type: "response.output_item.added", item });
  const done = (item) => event({ type: "response.output_item.done", item });
  const dropped = { type: "function_call", name: "bedit", arguments: '{"d":1}', status: "completed" };
  const shapes = {
    "named by a call_id": [
      added({ type: "function_call", call_id: "c1", name: "bedit", arguments: "" }),
      event({ type: "response.function_call_arguments.delta", item_id: "c1", delta: '{"d":1}' }),
      event({ type: "response.function_call_arguments.done", item_id: "c1", arguments: '{"d":1}' }),
      done(dropped),
      T([]),
    ],
    "named by an id, with the terminal's copy carrying nothing": [
      added({ type: "function_call", id: "i1", name: "bedit", arguments: "" }),
      event({ type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"d":1}' }),
      event({ type: "response.function_call_arguments.done", item_id: "i1", arguments: '{"d":1}' }),
      done(dropped),
      T([{ ...dropped }]),
    ],
    "beside a declared call": [
      added({ type: "function_call", call_id: "c1", name: "bedit", arguments: "" }),
      event({ type: "response.function_call_arguments.delta", item_id: "c1", delta: '{"d":1}' }),
      event({ type: "response.function_call_arguments.done", item_id: "c1", arguments: '{"d":1}' }),
      done(dropped),
      added({ type: "function_call", id: "k1", name: "bash", arguments: "" }),
      event({ type: "response.function_call_arguments.delta", item_id: "k1", delta: '{"k":1}' }),
      event({ type: "response.function_call_arguments.done", item_id: "k1", arguments: '{"k":1}' }),
      done({ type: "function_call", id: "k1", name: "bash", arguments: '{"k":1}', status: "completed" }),
      T([]),
    ],
  };
  for (const [what, text] of Object.entries(shapes)) {
    const streamed = await guardToolResponse(sse(text.join("")), "responses", policy);
    assert.equal(streamed.status, 200, what);
    const guarded = await streamed.text();
    const data = frameData(guarded);
    const replaced = data
      .filter((value) => value.item?.type === "message")
      .map((value) => value.item.id);
    assert.equal(replaced.length, 2, `${what}: the added frame and the done frame`);
    assert.equal(new Set(replaced).size, 1, `${what}: one call answered ${JSON.stringify(replaced)}`);
    // Every frame the guard's own item answers with names that same id, and
    // the terminal's copy of it does too.
    const named = [
      ...new Set(
        data
          .map((value) => value.item_id)
          .filter((id) => typeof id === "string" && id.startsWith("msg_")),
      ),
    ];
    const terminal = (data.find((value) => value.type === "response.completed")?.response.output ?? [])
      .filter((item) => item.type === "message")
      .map((item) => item.id);
    assert.deepEqual(named, [replaced[0]], what);
    for (const id of terminal) assert.equal(id, replaced[0], what);
    // And the bytes are a reply the collapse path reads back as that one item
    // (plus the declared call, where there is one).
    const collapsed = await collapseResponse(sse(guarded), "responses");
    assert.equal(collapsed.status, 200, `${what}: the guard's own bytes are not a reply`);
    const items = (await collapsed.json()).output;
    assert.equal(items.length, what === "beside a declared call" ? 2 : 1, what);
    assert.deepEqual(
      items.map((item) => [item.type, item.id]),
      what === "beside a declared call"
        ? [
            ["message", replaced[0]],
            ["function_call", "k1"],
          ]
        : [["message", replaced[0]]],
      what,
    );
  }
});

// Two items stating one output_index, one of them a call left out: the place
// cannot say whose arguments frame it is, and reading it alone swallowed the
// declared call's frames along with the dropped call's. The word the frame
// names is what is left to read, and a word the reply kept an item under is
// that item's.
test("Responses: two items stating one index leave the declared call its arguments", async () => {
  const text =
    event({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "d1", name: "bedit", arguments: "" } }) +
    event({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "d1", delta: '{"dropped":1}' }) +
    event({ type: "response.function_call_arguments.done", output_index: 1, item_id: "d1", arguments: '{"dropped":1}' }) +
    event({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "k1", name: "bash", arguments: "" } }) +
    event({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "k1", delta: '{"kept":1}' }) +
    event({ type: "response.function_call_arguments.done", output_index: 1, item_id: "k1", arguments: '{"kept":1}' }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  assert.deepEqual(
    data
      .filter((value) => value.type?.startsWith("response.function_call_arguments"))
      .map((value) => [value.item_id, value.output_index, value.delta ?? value.arguments]),
    [
      ["k1", 1, '{"kept":1}'],
      ["k1", 1, '{"kept":1}'],
    ],
    "the declared call's frames were left out with the call that shares its index",
  );
  assert.equal((await collapseResponse(sse(guarded), "responses")).status, 200);
});

// A reply at odds with itself about where one call sits: the frame that opens
// it gives no index and the frame that closes it gives one, or the other way
// round, or the two give two different ones. The guard answers the call one id
// and one place, because the copies leave the placing to the stream's own
// answer — the place the frame that opened the call was answered at — and the
// id they all answer is what the collapse path finds them by. Reading each
// copy's own index instead gave the streaming client one item and the client
// that reads no stream two, which is the split F2 exists to close.
test("Responses: a dropped call whose copies disagree about the place is one item to both clients", async () => {
  const dropped = { type: "function_call", call_id: "c9", name: "bedit", arguments: '{"d":1}', status: "completed" };
  const opened = (index) =>
    event({
      type: "response.output_item.added",
      ...(index === undefined ? {} : { output_index: index }),
      item: { type: "function_call", call_id: "c9", name: "bedit", arguments: "" },
    });
  const args = (handle, type) =>
    event({ type, ...handle, ...(type.endsWith(".delta") ? { delta: '{"d":1}' } : { arguments: '{"d":1}' }) });
  const shapes = {
    "the opening frame gives no index, the closing frame gives one": [
      opened(undefined),
      args({ item_id: "c9" }, "response.function_call_arguments.delta"),
      args({ item_id: "c9" }, "response.function_call_arguments.done"),
      event({ type: "response.output_item.done", output_index: 7, item: { ...dropped } }),
    ],
    "the opening frame gives one, the closing frame gives none": [
      opened(7),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.delta"),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.done"),
      event({ type: "response.output_item.done", item: { ...dropped } }),
    ],
    "the two frames give two different indices": [
      opened(7),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.delta"),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.done"),
      event({ type: "response.output_item.done", output_index: 9, item: { ...dropped } }),
    ],
    // The closing copy names nothing at all — no word of its own and no index —
    // so the call the stream is closing is the only thing left to read it by.
    "the opening frame gives one, the closing frame names nothing": [
      opened(7),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.delta"),
      args({ output_index: 7, item_id: "c9" }, "response.function_call_arguments.done"),
      event({
        type: "response.output_item.done",
        item: { type: "function_call", name: "bedit", arguments: '{"d":1}', status: "completed" },
      }),
    ],
  };
  for (const [what, frames] of Object.entries(shapes)) {
    const text =
      frames.join("") +
      event(
        { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
        "response.completed",
      );
    const streamed = await guardToolResponse(sse(text), "responses", policy);
    assert.equal(streamed.status, 200, what);
    const guarded = await streamed.text();
    const data = frameData(guarded);
    const replaced = data.filter((value) => value.item?.type === "message");
    assert.equal(replaced.length, 2, `${what}: the added frame and the done frame`);
    assert.deepEqual(
      replaced.map((value) => value.item.id),
      [replaced[0].item.id, replaced[0].item.id],
      `${what}: one call answered more than one id`,
    );
    assert.equal(replaced[1].output_index, undefined, `${what}: the closing copy kept a place of its own`);
    // One item to the streaming client, and one to the client that reads no
    // stream: the same item, by the same id.
    const streamedItems = new Set(replaced.map((value) => value.item.id));
    const collapsed = await collapseResponse(sse(guarded), "responses");
    assert.equal(collapsed.status, 200, `${what}: the guard's own bytes are not a reply`);
    const items = (await collapsed.json()).output;
    assert.equal(items.length, streamedItems.size, `${what}: a split between the two paths`);
    assert.deepEqual(
      items.map((item) => [item.type, item.id]),
      [["message", replaced[0].item.id]],
      what,
    );
  }
});

// The third word the suppression reads, pinned on its own: a frame that gives
// an index nothing in the reply holds, and names a word a call left out was
// named by. That index is the upstream's own numbering of a call the guard
// replaced with a note — it says nothing about any item the reply kept — and
// nothing else in the reply accounts for the frame, so it is left out with the
// call. Removing that rule let these frames through to the client, describing
// an item it had been told was replaced (the repo had no test that noticed).
test("Responses: a dropped call's frames are left out though they give an index nobody declared", async () => {
  const text =
    event({ type: "response.output_item.added", item: { type: "function_call", call_id: "c9", name: "bedit", arguments: "" } }) +
    event({ type: "response.function_call_arguments.delta", output_index: 7, item_id: "c9", delta: '{"d"' }) +
    event({ type: "response.function_call_arguments.done", output_index: 7, item_id: "c9", arguments: '{"d":1}' }) +
    event({ type: "response.output_item.done", item: { type: "function_call", call_id: "c9", name: "bedit", arguments: '{"d":1}', status: "completed" } }) +
    event(
      { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
      "response.completed",
    );
  const streamed = await guardToolResponse(sse(text), "responses", policy);
  assert.equal(streamed.status, 200);
  const guarded = await streamed.text();
  const data = frameData(guarded);
  assert.deepEqual(
    data.filter((value) => value.type?.startsWith("response.function_call_arguments")),
    [],
    "a call left out kept its arguments frames",
  );
  assert.equal(textIn("responses", data), droppedNote("bedit"));
  const collapsed = await collapseResponse(sse(guarded), "responses");
  assert.equal(collapsed.status, 200);
  assert.deepEqual(
    (await collapsed.json()).output.map((item) => [item.type, item.id]),
    [["message", "msg_c9"]],
  );
});

// [DONE] is the sentinel a Chat stream ends with, and a Responses or Messages
// stream may be handed one after it has reported its own terminal event — a
// gateway in front of the upstream appends it. That is an ending. Before the
// terminal event it claims an ending the protocol never reported, and the
// reply is refused. The collapse path reads the same bytes the same way (its
// half of this test is in stream.test.mjs).
test("a [DONE] marker is an ending only where the reply already ended", async () => {
  for (const protocol of ["responses", "anthropic"]) {
    // Named for the frame it is, not `terminal`: that name is this file's
    // `terminal(protocol)` helper, and this loop is inside the module it lives in.
    const terminalFrame =
      protocol === "responses"
        ? event(
            { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
            "response.completed",
          )
        : event({ type: "message_stop" }, "message_stop");
    const marker = "data: [DONE]\n\n";
    const good = await guardToolResponse(sse(terminalFrame + marker), protocol, policy);
    const out = await good.text();
    assert.equal(good.status, 200);
    assert.ok(out.endsWith(marker), "the marker is forwarded as it arrived");
    assert.ok(
      !parse(out).some((frame) => frame.data?.type === "error" || frame.data?.error),
      "an ending the protocol reported is not an error",
    );
    const bare = await guardToolResponse(sse(marker), protocol, policy);
    const frames = parse(await bare.text());
    assert.equal(frames.length, 1);
    assertError(protocol, frames[0].data);
    assert.equal(
      frames[0].data.message ?? frames[0].data.error.message,
      "Unexpected upstream completion marker",
    );
  }
});

// The contract both paths implement, pinned here for the path that streams to
// a client. The terminal marker still ends the reply where it stands and is
// still forwarded as it arrived; an event after it is not part of the reply —
// this path used to forward one the collapse path dropped, so the same
// upstream answered two different replies; and a failure after it still failed
// the turn, which is why the ignore sits below the error branch. The collapse
// path's half of this test is in stream.test.mjs.
test("an event after the terminal marker is ignored, and a failure after it is not", async () => {
  const cases = {
    chat: [
      event({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }),
      event("[DONE]"),
      event({ choices: [{ index: 0, delta: { content: "TAIL" } }] }),
    ],
    responses: [
      event({ type: "response.completed", response: { status: "completed", output: [] } }, "response.completed"),
      event({
        type: "response.output_text.delta",
        item_id: "m",
        output_index: 0,
        content_index: 0,
        delta: "TAIL",
      }),
    ],
    anthropic: [
      event({ type: "message_stop" }, "message_stop"),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "TAIL" } }),
    ],
  };
  for (const [protocol, frames] of Object.entries(cases)) {
    const result = await guardToolResponse(sse(frames.join("")), protocol, policy);
    assert.equal(result.status, 200);
    const out = await result.text();
    assert.doesNotMatch(out, /TAIL/, `${protocol}: an event after the terminal marker was forwarded`);
    assert.ok(
      out.includes(protocol === "chat" ? "data: [DONE]" : frames[0].trim()),
      `${protocol}: the terminal marker is forwarded as it arrived`,
    );
  }
  for (const [protocol, terminal] of [
    ["chat", event("[DONE]")],
    ["responses", event({ type: "response.completed", response: { output: [] } })],
    ["anthropic", event({ type: "message_stop" })],
  ]) {
    const result = await guardToolResponse(
      sse(terminal + event({ error: { message: "late error" } })),
      protocol,
      policy,
    );
    assert.match(
      JSON.stringify(frameData(await result.text())),
      /late error/,
      `${protocol}: a failure after the terminal marker was ignored too`,
    );
    // And a frame the guard cannot read at all is a failure either way, as it
    // was before the marker: ignoring the event after an ending must not
    // become reading a body nothing checked.
    const broken = await guardToolResponse(sse(terminal + "data: {broken\n\n"), protocol, policy);
    assert.match(JSON.stringify(frameData(await broken.text())), /Invalid JSON/);
  }
});

test("Responses codes a call of no declared tool as an undeclared one, and nothing else", async () => {
  // A call where a snapshot was expected, so it cannot be put in place of
  // by a note: the reply fails and says which failure it was.
  const bare = { type: "function_call", name: "unknown", call_id: "call1", arguments: "{}" };
  const undeclared = await guardToolResponse(Response.json(bare), "responses", policy);
  assert.equal(undeclared.status, 502);
  assertError("responses", await undeclared.json(), false, "undeclared_tool");
  // An upstream that failed, or a call of a kind the agent can't be handed,
  // is a failure of another sort.
  const malformed = await guardToolResponse(
    new Response("{broken", { headers: { "content-type": "application/json" } }),
    "responses",
    policy,
  );
  assertError("responses", await malformed.json(), false);
  const unsupported = await guardToolResponse(
    Response.json({ output: [{ type: "computer_call", name: "x", call_id: "call1" }] }),
    "responses",
    policy,
  );
  assertError("responses", await unsupported.json(), false);
});

test("chat: JSON checks every choice, legacy function_call and missing tool names", async () => {
  const result = await guardToolResponse(
    Response.json({ choices: [{ message: { function_call: { name: "read", arguments: "{}" } } }] }),
    "chat",
    policy,
  );
  assert.equal((await result.json()).choices[0].message.function_call.name, "Read");
  for (const [message, name] of [
    [{ function_call: { name: "unknown" } }, "unknown"],
    [{ tool_calls: [{ type: "function", function: {} }] }, undefined],
  ]) {
    const source = Response.json({
      choices: [
        { message: { content: "ok" } },
        {
          index: 1,
          message,
          finish_reason: message.function_call ? "function_call" : "tool_calls",
        },
      ],
    });
    const result = await guardToolResponse(source, "chat", policy);
    assert.equal(result.status, 200);
    const [first, second] = (await result.json()).choices;
    assert.deepEqual(first.message, { content: "ok" });
    assert.deepEqual(second.message, { content: droppedNote(name) });
    assert.equal(second.finish_reason, "stop");
  }
  const custom = Response.json({
    choices: [{ message: { tool_calls: [{ type: "custom", custom: { name: "unknown" } }] } }],
  });
  assert.equal((await guardToolResponse(custom, "chat", policy)).status, 502);
});

test("Responses: nested JSON responses and all streaming snapshots are checked", async () => {
  const nested = await guardToolResponse(
    Response.json({ response: { response: snapshot("responses", ["bash"]) } }),
    "responses",
    policy,
  );
  assert.equal((await nested.json()).response.response.output[0].name, "Bash");
  for (const type of [
    "response.output_item.added",
    "response.output_item.done",
    "response.created",
    "response.in_progress",
    "response.completed",
    "response.incomplete",
    "vendor.snapshot",
  ]) {
    for (const name of ["read", "unknown"]) {
      const data = type.includes("output_item")
        ? { type, item: tool("responses", name) }
        : { type, response: snapshot("responses", [name]) };
      const result = await guardToolResponse(
        sse(event(data, type) + terminal("responses")),
        "responses",
        policy,
      );
      const frames = parse(await result.text());
      if (name === "unknown") {
        const raw = frames.map((frame) => frame.data);
        assert.ok(!raw.some((data) => data.type === "error" || data.error));
        assert.deepEqual(callsIn("responses", raw), []);
        const message = raw[0].item ?? raw[0].response.output[0];
        assert.equal(message.type, "message");
        assert.equal(message.id, "msg_call");
        const said =
          type === "response.output_item.added"
            ? textIn("responses", raw)
            : message.content[0].text;
        assert.equal(said, droppedNote("unknown"));
      } else
        assert.equal(frames[0].data.item?.name ?? frames[0].data.response.output[0].name, "Read");
    }
  }
});

test("Anthropic: content_block_start, message_start and server_tool_use are guarded", async () => {
  for (const type of ["tool_use", "server_tool_use"]) {
    for (const name of ["bash", "unknown"]) {
      const block = { type, name, id: "t", input: {} };
      const json = await guardToolResponse(
        Response.json({ content: [block] }),
        "anthropic",
        policy,
      );
      assert.equal(json.status, 200);
      if (name === "unknown")
        assert.deepEqual((await json.json()).content, [{ type: "text", text: droppedNote(name) }]);
      for (const data of [
        { type: "content_block_start", index: 0, content_block: block },
        { type: "message_start", message: { content: [block] } },
      ]) {
        const response = await guardToolResponse(
          sse(event(data) + terminal("anthropic")),
          "anthropic",
          policy,
        );
        const frames = parse(await response.text());
        if (name === "unknown") {
          const values = frames.map((frame) => frame.data);
          assert.ok(!values.some((value) => value.type === "error"));
          assert.deepEqual(callsIn("anthropic", values), []);
          assert.equal(textIn("anthropic", values), droppedNote(name));
        } else
          assert.equal(
            frames[0].data.content_block?.name ?? frames[0].data.message.content[0].name,
            "Bash",
          );
      }
    }
  }
});

test("chat: buffers names and arguments by choice/index, including arguments before name", async () => {
  const values = [
    chat({
      tool_calls: [
        { index: 1, function: { arguments: '{"x":' } },
        { index: 0, id: "first", type: "function", function: { name: "ba", arguments: "{}" } },
      ],
    }),
    chat({ tool_calls: [{ index: 0, function: { name: "re", arguments: "{}" } }] }, null, 1),
    chat({
      content: "你好",
      tool_calls: [
        { index: 1, id: "second", type: "function", function: { name: "re", arguments: "1}" } },
        { index: 0, function: { name: "sh" } },
      ],
    }),
    chat({ tool_calls: [{ index: 0, function: { name: "ad" } }] }, "tool_calls", 1),
    chat({ tool_calls: [{ index: 1, function: { name: "ad" } }] }, "tool_calls"),
  ];
  const result = await guardToolResponse(
    sse(values.map((value) => event(value)).join("") + terminal("chat"), { chunkSize: 1 }),
    "chat",
    policy,
  );
  const choices = parse(await result.text()).flatMap((frame) => frame.data.choices ?? []);
  const toolChoices = choices.filter((choice) => choice.delta?.tool_calls);
  assert.equal(toolChoices.length, 2);
  assert.deepEqual(toolChoices.find((choice) => choice.index === 0).delta.tool_calls, [
    { index: 0, id: "first", type: "function", function: { name: "Bash", arguments: "{}" } },
    { index: 1, id: "second", type: "function", function: { name: "Read", arguments: '{"x":1}' } },
  ]);
  assert.equal(
    toolChoices.find((choice) => choice.index === 1).delta.tool_calls[0].function.name,
    "Read",
  );
  assert.equal(
    choices
      .filter((choice) => choice.delta?.content)
      .map((choice) => choice.delta.content)
      .join(""),
    "你好",
  );
});

test("chat: legacy fragments flush at DONE, but truncated pending calls never escape", async () => {
  const prefix =
    event(chat({ function_call: { arguments: "{}" } })) +
    event(chat({ function_call: { name: "ba" } })) +
    event(chat({ function_call: { name: "sh" } }));
  const success = await guardToolResponse(sse(prefix + terminal("chat")), "chat", policy);
  const frames = parse(await success.text());
  const calls = frames
    .flatMap((frame) => frame.data.choices ?? [])
    .filter((choice) => choice.delta?.function_call);
  assert.deepEqual(
    calls.map((choice) => choice.delta.function_call),
    [{ name: "Bash", arguments: "{}" }],
  );
  const failure = await guardToolResponse(sse(prefix), "chat", policy);
  const failed = parse(await failure.text());
  assert.equal(failed.length, 1);
  assertError("chat", failed[0].data);
});

test("chat: text and usage flow immediately while tools wait, without reading the conversation", async () => {
  let cancelled = false;
  const text = event(chat({ content: "first", tool_calls: [call("ba")] }));
  const source = openSource(text, () => {
    cancelled = true;
  });
  const result = await guardToolResponse(source.response, "chat", policy);
  const reader = result.body.getReader();
  const first = await withTimeout(reader.read());
  const firstData = parse(new TextDecoder().decode(first.value))[0].data;
  assert.equal(firstData.choices[0].delta.content, "first");
  assert.equal(firstData.choices[0].delta.tool_calls, undefined);
  assert.equal(source.pulls(), 1);
  source.push(event({ choices: [], usage: { total_tokens: 12 } }));
  const usage = await withTimeout(reader.read());
  assert.equal(parse(new TextDecoder().decode(usage.value))[0].data.usage.total_tokens, 12);
  await reader.cancel("enough");
  assert.equal(cancelled, true);
});

test("chat: one chunk containing many text events still obeys downstream backpressure", async () => {
  let cancelled = false;
  const source = openSource(
    event(chat({ content: "one" })) +
      event(chat({ content: "two" })) +
      event(chat({ tool_calls: [{ ...call("unknown"), type: "custom" }] }, "tool_calls")),
    () => {
      cancelled = true;
    },
  );
  const result = await guardToolResponse(source.response, "chat", policy);
  const reader = result.body.getReader();
  assert.equal(
    parse(new TextDecoder().decode((await reader.read()).value))[0].data.choices[0].delta.content,
    "one",
  );
  assert.equal(cancelled, false);
  assert.equal(
    parse(new TextDecoder().decode((await reader.read()).value))[0].data.choices[0].delta.content,
    "two",
  );
  assert.equal(cancelled, false);
  assertError("chat", parse(new TextDecoder().decode((await reader.read()).value))[0].data);
  assert.equal(cancelled, true);
});

test("SSE handles UTF8, BOM, CRLF, CR-only, multiline data and arbitrary chunks", async () => {
  const raw =
    '\uFEFF: ping\r\nid: 7\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"中文🙂"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const text of [raw, raw.replaceAll("\r\n", "\r"), raw.replaceAll("\r\n", "\n")]) {
    for (const chunkSize of [1, 2, 3, 7, 1024]) {
      const result = await guardToolResponse(sse(text, { chunkSize }), "chat", policy);
      const frames = parse(await result.text());
      assert.equal(frames[0].data.choices[0].delta.content, "中文🙂");
      assert.equal(frames[1].data, "[DONE]");
    }
  }
});

test("ordinary events retain SSE metadata without buffering", async () => {
  for (const protocol of protocols) {
    const text = ': keepalive\nid: 8\nretry: 200\nevent: vendor.text\ndata: {"text":"hello"}\n\n';
    const source = openSource(text);
    const result = await guardToolResponse(source.response, protocol, policy);
    const reader = result.body.getReader();
    assert.equal(new TextDecoder().decode((await withTimeout(reader.read())).value), text);
    await reader.cancel();
  }
});

// 32+ MiB through the guard, like the CRLF test below: not held to bun's 5 s default
test("single SSE event limit is 32 MiB and cancels an unterminated upstream", { timeout: 60_000 }, async () => {
  let cancelled = false;
  const bytes = encoder.encode("x".repeat(1024 * 1024));
  const source = endlessStream(bytes, {
    cancel: () => {
      cancelled = true;
    },
  });
  const result = await guardToolResponse(source.response, "chat", policy);
  const frames = parse(await result.text());
  assertError("chat", frames[0].data);
  assert.match(frames[0].data.error.message, /32 MiB|limit/i);
  assert.equal(cancelled, true);
  // The 33rd chunk is the one that carries the count past the limit, and the
  // source queues nothing ahead of the reader.
  assert.ok(
    source.pulls() <= MAX_BYTES / bytes.length + 1,
    `pulled ${source.pulls()} chunks before the limit`,
  );
});

// 32+ MiB through the guard, like the CRLF test below: not held to bun's 5 s default
test("cumulative pending chat tools are limited across choices and calls", { timeout: 60_000 }, async () => {
  let cancelled = false;
  const argumentsChunk = "x".repeat(1024 * 1024);
  const source = endlessStream(
    (pulls) =>
      encoder.encode(
        event(chat({ tool_calls: [call("bash", pulls, argumentsChunk)] }, null, pulls % 2)),
      ),
    {
      cancel: () => {
        cancelled = true;
      },
    },
  );
  const result = await guardToolResponse(source.response, "chat", policy);
  const frames = parse(await result.text());
  assert.equal(frames.length, 1);
  assertError("chat", frames[0].data);
  assert.match(frames[0].data.error.message, /32 MiB|limit/i);
  assert.equal(cancelled, true);
  // Each event's arguments are charged whole, so the limit falls within a
  // chunk or two of 32 MiB of them, and the source queues nothing ahead.
  assert.ok(
    source.pulls() <= MAX_BYTES / argumentsChunk.length + 1,
    `pulled ${source.pulls()} chunks before the pending-tool limit`,
  );
});

// 32+ MiB through the guard, not held to bun's 5 s default: a reply that is
// not a stream is read through the same limit a streamed one's events are,
// and the body it abandons is cancelled rather than left writing into a
// socket nobody reads.
test("a non-streaming reply is read through the 32 MiB limit", { timeout: 60_000 }, async () => {
  const bytes = encoder.encode("x".repeat(1024 * 1024));
  let cancelled = 0;
  const source = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled++;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  const result = await guardToolResponse(source, "chat", policy);
  assert.equal(result.status, 502);
  assert.match((await result.json()).error.message, /32 MiB|limit/i);
  assert.equal(cancelled, 1);
  assert.equal(source.body.locked, false);
});

// A body abandoned without its cancel being awaited leaves an upstream writing
// into a socket nobody reads. A cancel that then fails must not stand in for
// what ended the read: the oversized body is the 502 this path promises, and an
// opaque transport error in its place is the failure [#4] was about — the
// caller cannot tell a limit from a dead connection, and the documented answer
// disappears. The cancel's own failure rides along as that error's cause, so
// nothing is swallowed, and the lock is released either way.
test("a cancel failure does not replace the 502 an oversized body becomes", async () => {
  const cause = new DOMException("cancel failed", "AbortError");
  const bytes = encoder.encode("x".repeat(1024 * 1024));
  const { response } = upstream((controller) => controller.enqueue(bytes), {
    headers: { "content-type": "application/json" },
    highWaterMark: 0,
    cancel() {
      throw cause;
    },
  });
  const result = await guardToolResponse(response, "chat", policy);
  assert.equal(result.status, 502, "the limit is still the answer, not the cancel");
  assert.match((await result.json()).error.message, /32 MiB|limit/i);
  assert.equal(response.body.locked, false);
});

test("chat: each pending choice is settled on its own, an unknown or missing final name left out", async () => {
  for (const ending of [
    terminal("chat"),
    event({
      choices: [
        { index: 0, delta: {}, finish_reason: "tool_calls" },
        { index: 1, delta: {}, finish_reason: "tool_calls" },
      ],
    }) + terminal("chat"),
  ]) {
    for (const name of ["unknown", ""]) {
      const text =
        event(chat({ tool_calls: [call("bash")] })) +
        event(chat({ tool_calls: [call(name)] }, null, 1)) +
        ending;
      const response = await guardToolResponse(sse(text), "chat", policy);
      const values = frameData(await response.text());
      assert.ok(!values.some((data) => data.error));
      const choices = values.flatMap((data) => data.choices ?? []);
      const of = (index) => choices.filter((choice) => choice.index === index);
      assert.deepEqual(callsIn("chat", [{ choices: of(0) }]), ["Bash"]);
      assert.deepEqual(callsIn("chat", [{ choices: of(1) }]), []);
      assert.equal(textIn("chat", [{ choices: of(1) }]), droppedNote(name));
      const finishes = (index) =>
        of(index)
          .map((choice) => choice.finish_reason)
          .filter(Boolean);
      if (ending !== terminal("chat")) {
        assert.deepEqual(finishes(0), ["tool_calls"]);
        assert.deepEqual(finishes(1), ["stop"]);
      }
    }
  }
});

test("chat: a choice whose every call was left out finishes as a stop, again and again (#76)", async () => {
  // step-5-preview-free sends its tool_calls finish twice, the second with
  // usage (seen 2026-10-11); neither may tell the agent to run a tool.
  const response = await guardToolResponse(sse(toolStream("chat", "bedit")), "chat", policy);
  const values = frameData(await response.text());
  const finishes = values
    .flatMap((data) => data.choices ?? [])
    .map((choice) => choice.finish_reason)
    .filter(Boolean);
  assert.deepEqual(finishes, ["stop", "stop"]);
  assert.equal(textIn("chat", values), droppedNote("bedit"));
  assert.ok(values.some((data) => data.usage?.completion_tokens === 5));
});

test("chat: a round whose only call was left out does not decide the round after it (#76)", async () => {
  // Round 1 calls a tool this agent has no name for and ends in tool use;
  // round 2, in the same stream, calls a declared one. The first round ends
  // as a plain stop (#76) — and the second is judged on its own, not on the
  // round before it: a client that keys execution off finish_reason never
  // runs a call published under "stop".
  const round = (name) => event(chat({ tool_calls: [call(name)] }, "tool_calls"));
  const two = await guardToolResponse(
    sse(round("bedit") + round("bash") + terminal("chat")),
    "chat",
    policy,
  );
  const choices = frameData(await two.text()).flatMap((data) => data.choices ?? []);
  assert.deepEqual(
    choices.map((choice) => choice.finish_reason),
    ["stop", "tool_calls"],
  );
  assert.deepEqual(callsIn("chat", [{ choices }]), ["Bash"]);
  assert.equal(textIn("chat", [{ choices }]), droppedNote("bedit"));
  // The control: the same round on its own, where nothing preceded it.
  const one = await guardToolResponse(sse(round("bash") + terminal("chat")), "chat", policy);
  assert.deepEqual(
    frameData(await one.text())
      .flatMap((data) => data.choices ?? [])
      .map((choice) => choice.finish_reason),
    ["tool_calls"],
  );
});

test("chat: buffered calls flushed at [DONE] say the turn ended in tool use", async () => {
  // The case this buffer exists for: an upstream that closes with [DONE]
  // before sending a finish chunk. A null finish_reason reads as no ending at
  // all, so the reason is derived from what the flush publishes.
  const flush = async (delta) => {
    const text = event(chat(delta)) + terminal("chat");
    const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
    return values.flatMap((data) => data.choices ?? [])[0];
  };
  const calls = await flush({ tool_calls: [call("bash")] });
  assert.equal(calls.finish_reason, "tool_calls");
  assert.deepEqual(
    calls.delta.tool_calls.map((value) => value.function.name),
    ["Bash"],
  );
  const legacy = await flush({ function_call: { name: "bash", arguments: "{}" } });
  assert.equal(legacy.finish_reason, "function_call");
  assert.equal(legacy.delta.function_call.name, "Bash");
  // A call of no declared tool is left out, and what is left is a plain stop.
  const dropped = await flush({ tool_calls: [call("bedit")] });
  assert.equal(dropped.finish_reason, "stop");
  assert.equal(dropped.delta.tool_calls, undefined);
  assert.equal(dropped.delta.content, droppedNote("bedit"));
});

// 2026-10-17, measured through this plugin: deepseek-v4.1-flash-free's reply
// named a call on its first frame and put `"id": null` on a continuation
// frame, and the flushed call reached its host id-less. dsh then keyed a
// tool/result record by the empty id — failing that turn ("toolCallId
// matching its tool source"), and the whole session on the next reload. What
// the first frame gave is not a later frame's to take away.
test("chat: a later frame's `\"id\": null` does not take the id the first frame gave", async () => {
  const first = { index: 0, id: "call-0", type: "function", function: { name: "bash", arguments: "" } };
  const continuation = { index: 0, id: null, function: { arguments: "{}" } };
  const text =
    event(chat({ tool_calls: [first] })) +
    event(chat({ tool_calls: [continuation] })) +
    terminal("chat");
  const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
  const calls = values
    .flatMap((data) => data.choices ?? [])
    .flatMap((choice) => choice.delta?.tool_calls ?? []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "call-0");
  assert.equal(calls[0].function.arguments, "{}", "the continuation still contributed");
});

// The other half of the same malformed shape: a reply that never names the
// call at all (the same flush carried `{"index":0,"id":null,"name":"bash"}`).
// OpenAI's shape requires an id, and a host that matches a result by it has
// nothing to match: a call that reaches the wire leaves with one — invented
// when the route gave none, and never shared between two calls of one reply.
test("chat: a call the route never named still leaves with an id of its own", async () => {
  const flush = async (deltas) => {
    const text = deltas.map((delta) => event(chat(delta))).join("") + terminal("chat");
    const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
    return values
      .flatMap((data) => data.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? []);
  };
  const [unnamed] = await flush([
    { tool_calls: [{ index: 0, id: null, type: "function", function: { name: "bash", arguments: "{}" } }] },
  ]);
  assert.equal(typeof unnamed.id, "string");
  assert.notEqual(unnamed.id, "");
  const both = await flush([
    {
      tool_calls: [
        { index: 0, type: "function", function: { name: "bash", arguments: "{}" } },
        { index: 1, type: "function", function: { name: "read", arguments: "{}" } },
      ],
    },
  ]);
  assert.equal(both.length, 2, "both calls kept");
  assert.notEqual(both[0].id, both[1].id, "two invented ids are two ids");
  for (const kept of both) assert.ok(typeof kept.id === "string" && kept.id !== "");
});

// The same rule where a whole message arrives at once instead of a stream.
test("chat: a call without an id gets one in a whole message too", async () => {
  const body = {
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [
            { index: 0, id: null, type: "function", function: { name: "bash", arguments: "{}" } },
          ],
        },
      },
    ],
  };
  const out = await (await guardToolResponse(Response.json(body), "chat", policy)).json();
  const kept = out.choices[0].message.tool_calls[0];
  assert.equal(kept.function.name, "Bash", "the rename still happens");
  assert.ok(typeof kept.id === "string" && kept.id !== "", "and the id is a name a result can carry");
});

// An invented id is only process-unique: the counter behind it is shared with
// every earlier reply, and the route names its own calls by ids of the same
// shape. A call left unnamed beside calls the reply did name could be handed
// one of their ids — two calls of one reply under one id, which is the failure
// the counter exists to prevent, and a host keys its tool results by the id.
// The ids the calls being flushed already carry are read first, and the
// invented one misses them all.
test("chat: an invented call id misses the ids the reply already placed", async () => {
  const flushChat = async (deltas) => {
    const text = deltas.map((delta) => event(chat(delta))).join("") + terminal("chat");
    const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
    return values
      .flatMap((data) => data.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? []);
  };
  const named = (id, index, name) => ({
    index,
    id,
    type: "function",
    function: { name, arguments: "{}" },
  });
  // A call the counter names tells the test what the counter is at: the next
  // invented id is the one after it, and the reply below is built to hold it.
  const probe = await flushChat([{ tool_calls: [named(null, 0, "bash")] }]);
  const last = Number(/(\d+)$/.exec(probe[0].id)?.[1]);
  assert.ok(Number.isSafeInteger(last), `an invented id is readable: ${probe[0].id}`);
  // Every id the counter can reach for a while, all of them the reply's own.
  const held = Array.from({ length: 32 }, (_, index) => `call_${last + index + 1}`);
  const flushed = await flushChat([
    { tool_calls: [...held.map((id, index) => named(id, index, "bash")), named(null, held.length, "read")] },
  ]);
  assert.equal(flushed.length, held.length + 1, "every call is kept");
  const ids = flushed.map((call) => call.id);
  assert.equal(new Set(ids).size, ids.length, `two calls shared an id: ${ids.join(", ")}`);
  const invented = ids.at(-1);
  assert.ok(
    !held.includes(invented),
    `the invented id ${invented} is one the reply already placed`,
  );
});

// A delta that carries `tool_calls: []` is not a call of anything: a gateway
// re-emitting the shape with a role-only delta sends one, and no call is
// being waited for. Reading it as a call opened a round with nothing in it —
// the choice's `ended` mark was dropped with it, so a later "tool_calls"
// finish stayed a tool use the client waits on forever, a choice the upstream
// never sent was flushed at [DONE], and a stream that then closed without the
// marker failed the whole turn "a tool call unfinished" while nothing was
// pending.
test("chat: an empty tool_calls delta is not a tool call", async () => {
  // The frame is the upstream's own and flows through as it came.
  const alone = frameData(
    await (await guardToolResponse(sse(event(chat({ tool_calls: [] })) + terminal("chat")), "chat", policy)).text(),
  );
  assert.deepEqual(alone, [{ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: null }] }]);
  // A choice whose every call was left out still ends as a plain stop, though
  // an empty delta arrives after it (#76).
  const text =
    event(chat({ content: "hi" })) +
    event(chat({ tool_calls: [call("nope")] })) +
    event(chat({}, "tool_calls")) +
    event(chat({ tool_calls: [] })) +
    event(chat({}, "tool_calls")) +
    terminal("chat");
  const values = frameData(await (await guardToolResponse(sse(text), "chat", policy)).text());
  assert.deepEqual(
    values.map((data) => {
      const choice = data.choices[0];
      return [choice.finish_reason, choice.delta?.tool_calls];
    }),
    [
      [null, undefined],
      ["stop", undefined],
      [null, []],
      ["stop", undefined],
    ],
    "the empty delta opened a round, or the choice's ending was lost with it",
  );
  // And a stream that closes without the marker after one blames the ending it
  // did not get, not a call that was never there.
  const cut = event(chat({ content: "hi" })) + event(chat({ tool_calls: [] }));
  const blamed = await (await guardToolResponse(sse(cut), "chat", policy)).text();
  assert.doesNotMatch(blamed, /a tool call unfinished/);
  assert.match(blamed, /ended without a completion marker/);
});

test("chat: the note follows the text the model wrote before its call", async () => {
  const text =
    event(chat({ content: "Fixing the stray heredoc marker." })) +
    event(chat({ tool_calls: [call("bedit")] }, "tool_calls")) +
    terminal("chat");
  const response = await guardToolResponse(sse(text), "chat", policy);
  assert.equal(
    textIn("chat", frameData(await response.text())),
    `Fixing the stray heredoc marker.\n\n${droppedNote("bedit")}`,
  );
});

test("chat: a call kept beside one left out is numbered from 0", async () => {
  const text =
    event(chat({ tool_calls: [call("bedit", 0), call("read", 1, '{"path":"a"}')] }, "tool_calls")) +
    terminal("chat");
  const response = await guardToolResponse(sse(text), "chat", policy);
  const values = frameData(await response.text());
  const calls = values
    .flatMap((data) => data.choices ?? [])
    .flatMap((c) => c.delta?.tool_calls ?? []);
  assert.deepEqual(calls, [
    {
      index: 0,
      id: "call-1",
      type: "function",
      function: { name: "Read", arguments: '{"path":"a"}' },
    },
  ]);
  const finishes = values.flatMap((data) => data.choices ?? []).map((c) => c.finish_reason);
  assert.ok(finishes.includes("tool_calls"));
});

// The other half of that rule: a fragment that names no index at all. It is
// read as the first call's — the collapse path reads it the same way, and a
// fragment that names no place has no other one to hold — so the two paths
// over one stream answer one reply. The guard's flush of the same bytes is
// what a client that streams gets, and the collapse of those bytes is what a
// client that does not gets.
test("chat: a fragment that names no index is read the same by both paths", async () => {
  const text =
    event(chat({ tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "Bash", arguments: "" } }] })) +
    event(chat({ tool_calls: [{ index: 1, id: "c1", type: "function", function: { name: "Read", arguments: "" } }] })) +
    event(chat({ tool_calls: [{ function: { arguments: '{"file":"a"}' } }] })) +
    event(chat({}, "tool_calls")) +
    terminal("chat");
  const streamed = await guardToolResponse(sse(text), "chat", policy);
  const guarded = await streamed.text();
  const calls = frameData(guarded)
    .flatMap((data) => data.choices ?? [])
    .flatMap((choice) => choice.delta?.tool_calls ?? [])
    .map((kept) => `${kept.function.name}${kept.function.arguments}`);
  assert.deepEqual(calls, ['Bash{"file":"a"}', "Read"]);
  const collapsed = await collapseResponse(sse(guarded), "chat");
  assert.equal(collapsed.status, 200);
  const body = await collapsed.json();
  assert.deepEqual(
    (body.choices[0].message.tool_calls ?? []).map(
      (kept) => `${kept.function.name}${kept.function.arguments}`,
    ),
    calls,
    "the streamed reply and its collapsed copy disagree about a fragment with no index",
  );
});

test("SSE: ambiguous injected names are left out in every protocol", async () => {
  const rules = { declared: new Set(["Bash", "BASH"]), injected: new Set(["bash"]) };
  for (const protocol of protocols) {
    const response = await guardToolResponse(
      sse(event(streamSnapshot(protocol, ["bash"])) + terminal(protocol)),
      protocol,
      rules,
    );
    const values = frameData(await response.text());
    assert.ok(!values.some((data) => data.type === "error" || data.error));
    assert.deepEqual(callsIn(protocol, values), []);
    assert.equal(textIn(protocol, values), droppedNote("bash"));
  }
});

test("Responses and Messages: a streamed call left out comes as text in its place", async () => {
  const responses = frameData(
    await (
      await guardToolResponse(sse(toolStream("responses", "bcp")), "responses", policy)
    ).text(),
  );
  assert.deepEqual(
    responses.map((data) => data.type),
    [
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  const note = droppedNote("bcp");
  // The note is the guard's own item, named in the guard's own namespace:
  // `msg_` and then the call_id the reply gave it (or the place it holds). It
  // used to take the id of the item it replaced verbatim — `fc_1` here — and a
  // reply that hands one word to two items then answered to that word for both
  // the note and the item it kept, which a client keying by id reads as one
  // item where the reply has two (task-11: the kept call and the dropped call
  // named by one id). Behind `msg_` the word cannot collide with an id of the
  // reply, and the note still answers one id in its item, its text frames and
  // the terminal's copy.
  const message = { type: "message", id: "msg_call_1", role: "assistant", status: "completed" };
  assert.deepEqual(responses[6].item, {
    ...message,
    content: [{ type: "output_text", text: note, annotations: [] }],
  });
  assert.deepEqual(responses[7].response.output, [responses[6].item]);
  for (const data of responses.slice(2, 6)) {
    assert.equal(data.item_id, "msg_call_1");
    assert.equal(data.output_index, 0);
  }
  const messages = frameData(
    await (
      await guardToolResponse(sse(toolStream("anthropic", "ash")), "anthropic", policy)
    ).text(),
  );
  assert.deepEqual(
    messages.map((data) => data.type),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.deepEqual(messages[1].content_block, { type: "text", text: "" });
  assert.deepEqual(messages[2].delta, { type: "text_delta", text: droppedNote("ash") });
  assert.equal(messages[4].delta.stop_reason, "end_turn");
});

test("Messages: a kept call keeps the tool_use stop beside one left out", async () => {
  const text = [
    {
      type: "message_start",
      message: { id: "m1", type: "message", role: "assistant", content: [] },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "a", name: "ash", input: {} },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "b", name: "bash", input: {} },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]
    .map((value) => event(value, value.type))
    .join("");
  const values = frameData(await (await guardToolResponse(sse(text), "anthropic", policy)).text());
  assert.deepEqual(callsIn("anthropic", values), ["Bash"]);
  assert.equal(values.find((data) => data.type === "message_delta").delta.stop_reason, "tool_use");
});

test("downstream cancellation interrupts a pending upstream read", async () => {
  for (const protocol of protocols) {
    let cancelReason;
    const source = openSource(event({ harmless: true }), (reason) => {
      cancelReason = reason;
    });
    const response = await guardToolResponse(source.response, protocol, policy);
    const reader = response.body.getReader();
    await reader.read();
    const waiting = reader.read();
    await Promise.resolve();
    await withTimeout(reader.cancel("abort now"));
    assert.equal((await withTimeout(waiting)).done, true);
    assert.equal(cancelReason, "abort now");
    assert.equal(source.response.body.locked, false);
  }
});

// 32+ MiB through the guard, like the CRLF test below: not held to bun's 5 s default
test("chat: completed tool buffers release their cumulative budget", { timeout: 60_000 }, async () => {
  let count = 0;
  const bytes = encoder.encode(
    event(chat({ tool_calls: [call("bash", 0, "x".repeat(1024 * 1024))] }, "tool_calls")),
  );
  const source = new Response(
    new ReadableStream({
      pull(controller) {
        if (count < 34) {
          count++;
          return controller.enqueue(bytes);
        }
        if (count++ === 34) return controller.enqueue(encoder.encode(terminal("chat")));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const response = await guardToolResponse(source, "chat", policy);
  const reader = response.body.getReader();
  let tools = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const data = parse(new TextDecoder().decode(value))[0].data;
    if (data === "[DONE]") continue;
    assert.equal(data.choices[0].delta.tool_calls[0].function.name, "Bash");
    tools++;
  }
  assert.equal(tools, 34);
});

// 64 MiB through the guard: seconds of work, more under load, so it isn't
// held to bun's 5 s default (it timed out on a machine at load 110)
test(
  "SSE event byte limit includes both bytes of CRLF even across chunks",
  { timeout: 60_000 },
  async () => {
    const prefix = 'data: {"text":"';
    const suffix = '"}\r\n\r\n';
    // A byte over the limit the guard names, whatever MAX_BYTES is: a literal
    // here would keep exercising the old boundary after a change to it.
    const text = prefix + "x".repeat(MAX_BYTES + 1 - prefix.length - suffix.length) + suffix;
    for (const chunkSize of [1024 * 1024, text.length - 1]) {
      const result = await guardToolResponse(sse(text, { chunkSize }), "chat", policy);
      const frames = parse(await result.text());
      assert.equal(frames.length, 1);
      assertError("chat", frames[0].data);
      assert.match(frames[0].data.error.message, /32 MiB|limit/i);
    }
  },
);

// 32+ MiB through the guard, like the CRLF test below: not held to bun's 5 s default
test("text streams larger than 32 MiB are not subject to the pending-tool limit", { timeout: 60_000 }, async () => {
  let count = 0;
  const bytes = encoder.encode(event(chat({ content: "x".repeat(1024 * 1024) })));
  const source = new Response(
    new ReadableStream({
      pull(controller) {
        // 34 chunks of a MiB each is what puts this stream past `MAX_BYTES`,
        // which the assertion below reads from that constant rather than from a
        // literal. If the constant ever grows past 34 MiB, this count is what
        // has to grow with it — growing the constant alone fails loudly instead
        // of quietly sending fewer bytes than the boundary and testing nothing.
        if (count < 34) {
          count++;
          return controller.enqueue(bytes);
        }
        if (count++ === 34) return controller.enqueue(encoder.encode(terminal("chat")));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const result = await guardToolResponse(source, "chat", policy);
  const reader = result.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    assert.ok(!new TextDecoder().decode(value).includes('"error"'));
  }
  // More than the limit the guard reads through, taken from the constant: a
  // literal here would keep passing against the old boundary after a change
  // to it.
  assert.ok(total > MAX_BYTES);
});

// #91: Zen closed space-bunny-free's Chat stream after these three frames,
// with no finish_reason, usage or [DONE] (the reporter's bytes).
const cutFrames =
  `data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"space-bunny-free","choices":[{"index":0,"delta":{"role":"assistant"}}],"usage":null}\n\n` +
  `data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"space-bunny-free","choices":[{"index":0,"delta":{"content":"Installed successfully and all"}}],"usage":null}\n\n` +
  `data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"space-bunny-free","choices":[{"index":0,"delta":{"content":" other plugins are intact."}}],"usage":null}\n\n`;
const streaming = { endCutShort: true };

test("chat: a stream cut short after its text ends as one, with a note and [DONE] (#91)", async () => {
  for (const chunkSize of [7, 31, 4096]) {
    const result = await guardToolResponse(sse(cutFrames, { chunkSize }), "chat", policy, streaming);
    const text = await result.text();
    assert.equal(result.status, 200);
    assert.ok(text.startsWith(cutFrames), "what was said goes on unchanged");
    assert.doesNotMatch(text, /"error"/);
    const frames = parse(text);
    assert.equal(frames.at(-1).data, "[DONE]");
    const end = frames.at(-2).data;
    assert.equal(end.id, "x2");
    assert.equal(end.model, "space-bunny-free");
    assert.deepEqual(end.choices, [
      { index: 0, delta: { content: `\n\n${cutShortNote}` }, finish_reason: "stop" },
    ]);
  }
});

// A choice that finished and then started another round is open again: the
// buffer judges a later round for the same choice on what that round holds, and
// the tracker has to agree. Latching the choice shut left a round opened
// afterwards, and cut short, with no note and no `finish_reason` at all — a bare
// `[DONE]` for a choice the client had already been told had stopped.
test("chat: a round opened after a choice finished is still ended by a cut (#91)", async () => {
  const text =
    event(chat({ role: "assistant", content: "one" })) +
    event(chat({}, "stop")) +
    event(chat({ content: "two" }));
  const result = await guardToolResponse(sse(text), "chat", policy, streaming);
  const frames = parse(await result.text());
  assert.equal(frames.at(-1).data, "[DONE]", "the cut is still reported as an ending");
  assert.deepEqual(
    frames.at(-2).data.choices,
    [{ index: 0, delta: { content: `\n\n${cutShortNote}` }, finish_reason: "stop" }],
    "the reopened choice gets the note",
  );
});

test("chat: a stream cut short in its reasoning ends as one too, the note its text (#91)", async () => {
  const text = event(chat({ role: "assistant" })) + event(chat({ reasoning_content: "Let me think" }));
  const result = await guardToolResponse(sse(text), "chat", policy, streaming);
  const frames = parse(await result.text());
  assert.equal(frames.at(-1).data, "[DONE]");
  assert.deepEqual(frames.at(-2).data.choices, [
    { index: 0, delta: { content: cutShortNote }, finish_reason: "stop" },
  ]);
});

test("chat: a stream whose every choice finished is only missing its [DONE] (#91)", async () => {
  const text = cutFrames + event(chat({}, "stop"));
  const result = await guardToolResponse(sse(text), "chat", policy, streaming);
  const out = await result.text();
  assert.equal(out, text + "data: [DONE]\n\n");
});

test("chat: a stream cut short still fails with a call pending, saying nothing, or not streamed (#91)", async () => {
  const cases = [
    [cutFrames + event(chat({ tool_calls: [call("bash", 0, '{"comm')] })), streaming, /tool call unfinished/],
    [event(chat({ role: "assistant" })), streaming, /1 event,/],
    ["", streaming, /0 events, 0 bytes/],
    [cutFrames, {}, /reply x2, 3 events, \d+ bytes/],
  ];
  for (const [text, options, detail] of cases) {
    const result = await guardToolResponse(sse(text), "chat", policy, options);
    const frames = parse(await result.text());
    assert.doesNotMatch(JSON.stringify(frames), /comm/);
    const data = frames.at(-1).data;
    assertError("chat", data);
    assert.match(data.error.message, /^Upstream SSE ended without a completion marker \(/);
    assert.match(data.error.message, detail);
  }
});

test("anthropic and responses: a stream cut short still fails, naming the reply (#91)", async () => {
  const cut = {
    anthropic:
      event({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [] } }, "message_start") +
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start") +
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Installed" } }, "content_block_delta"),
    responses:
      event({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }, "response.created") +
      event({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "Installed" }, "response.output_text.delta"),
  };
  for (const [protocol, text] of Object.entries(cut)) {
    const result = await guardToolResponse(sse(text), protocol, policy, streaming);
    const data = parse(await result.text()).at(-1).data;
    assertError(protocol, data);
    const message = protocol === "anthropic" ? data.error.message : data.message;
    assert.match(message, protocol === "anthropic" ? /reply msg_1/ : /reply resp_1/);
  }
});

test("a declared name of separators only is never handed another call (#76 follow-up)", async () => {
  const rules = { declared: new Set(["todo_write", "_"]) };
  for (const name of ["--", "-", "__"]) {
    const result = await guardToolResponse(
      Response.json(snapshot("chat", [name])),
      "chat",
      rules,
    );
    const data = await result.json();
    assert.deepEqual(callsIn("chat", [data]), []);
    assert.match(textIn("chat", [data]), /a tool this agent doesn't have/);
  }
  const exact = await guardToolResponse(Response.json(snapshot("chat", ["_"])), "chat", rules);
  assert.deepEqual(callsIn("chat", [await exact.json()]), ["_"]);
});

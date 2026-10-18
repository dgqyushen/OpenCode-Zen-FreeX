import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BYTES, collapseResponse } from "./stream.mjs";

const encoder = new TextEncoder();
// Generous enough that a slow machine still reports a real hang rather than
// a slow cancellation as one.
const LIVENESS_MS = 5000;
const event = (data, name) =>
  `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

function sse(text, { chunkSize = 23, headers = {}, status = 200 } = {}) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        const end = Math.min(offset + chunkSize, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    }),
    { status, headers: { "content-type": "text/event-stream; charset=utf-8", ...headers } },
  );
}

// An SSE source that never ends: `chunk` is the bytes of every pull, or a
// function of the pull count when the payload has to differ each time. The
// limit tests all hand out one chunk per pull and count how many it took to
// be stopped.
function endlessSse(chunk, { cancel = () => {} } = {}) {
  const next = typeof chunk === "function" ? chunk : () => chunk;
  let pulls = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(next(pulls - 1));
      },
      cancel,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  return { response, pulls: () => pulls };
}

async function collapseOpenStream(text, protocol, cancel = () => {}) {
  let controller;
  let cancelled = false;
  let timer;
  const bytes = encoder.encode(text);
  const response = new Response(
    new ReadableStream({
      start(source) {
        controller = source;
        source.enqueue(bytes.slice(0, -1));
        source.enqueue(bytes.slice(-1));
      },
      cancel() {
        cancelled = true;
        return cancel();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  try {
    const result = await Promise.race([
      collapseResponse(response, protocol),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("SSE error waited for EOF")), LIVENESS_MS);
      }),
    ]);
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
    return result;
  } finally {
    clearTimeout(timer);
    // Close unconditionally. When the timer wins, the collapse is still
    // waiting for EOF, and leaving the source open would keep the losing
    // promise — and its locked reader — pending for the rest of the run. A
    // source the collapse already cancelled throws from close(), and that
    // must not replace the error on its way out.
    try {
      controller.close();
    } catch {}
  }
}

async function json(text, protocol, options) {
  const response = await collapseResponse(sse(text, options), protocol);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  return response.json();
}

// The shape a collapsed upstream failure has, wherever one is asserted: the
// contract lives here once rather than in each test that reads it.
function assertProtocolError(body, protocol, message) {
  assert.equal(body.error.type, "upstream_error");
  if (message instanceof RegExp) assert.match(body.error.message, message);
  else assert.equal(body.error.message, message);
  if (protocol === "anthropic") assert.equal(body.type, "error");
  else {
    assert.equal(body.error.param, null);
    assert.equal(body.error.code, null);
  }
}

async function failure(text, protocol, pattern = /./) {
  const response = await collapseResponse(sse(text), protocol);
  assert.equal(response.status, 502);
  assertProtocolError(await response.json(), protocol, pattern);
}

test("chat preserves text, reasoning, indexed choices, tool arguments, usage and finish reasons", async () => {
  const text =
    [
      {
        id: "chat-1",
        object: "chat.completion.chunk",
        created: 123,
        model: "zen",
        system_fingerprint: "fp",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "你",
              reasoning_content: "想",
              tool_calls: [
                {
                  index: 1,
                  id: "call-b",
                  type: "function",
                  function: { name: "second", arguments: '{"b":' },
                },
                {
                  index: 0,
                  id: "call-a",
                  type: "function",
                  function: { name: "first", arguments: '{"a":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { index: 1, delta: { content: "other" }, finish_reason: "stop" },
          {
            index: 0,
            delta: {
              content: "好🙂",
              reasoning_content: "法",
              tool_calls: [
                { index: 0, function: { arguments: "1}" } },
                // The id on a continuation frame: this route puts `"id": null`
                // there (measured 2026-10-17), and it must not take call-b's
                // away.
                { index: 1, id: null, function: { arguments: "2}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 7,
          total_tokens: 17,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      },
    ]
      .map((value) => event(value))
      .join("") + event("[DONE]");
  const body = await json(text, "chat", { chunkSize: 1 });
  assert.equal(body.id, "chat-1");
  assert.equal(body.object, "chat.completion");
  assert.equal(body.created, 123);
  assert.equal(body.model, "zen");
  assert.equal(body.system_fingerprint, "fp");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, "你好🙂");
  assert.equal(body.choices[0].message.reasoning_content, "想法");
  assert.deepEqual(body.choices[0].message.tool_calls, [
    { id: "call-a", type: "function", function: { name: "first", arguments: '{"a":1}' } },
    { id: "call-b", type: "function", function: { name: "second", arguments: '{"b":2}' } },
  ]);
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[1].message.content, "other");
  assert.equal(body.choices[1].finish_reason, "stop");
  assert.deepEqual(body.usage, {
    prompt_tokens: 10,
    completion_tokens: 7,
    total_tokens: 17,
    completion_tokens_details: { reasoning_tokens: 3 },
  });
});

// A container that is not a list holds no entry to walk, and an entry that is
// not an object holds nothing to read — the rule the guard states (`list`,
// `object`) and the one this file already gives a malformed snapshot entry. A
// `choices` or `tool_calls` written as an object was walked anyway and threw "{}
// is not iterable", and a null entry threw "null is not an object": a 502
// carrying an internal TypeError on a reply whose other frames are sound, where
// the guard answers the same bytes. One stream answers one reply to a client
// that streams and one that does not.
test("chat skips a malformed choice or tool-call fragment instead of failing the stream", async () => {
  // A `choices` that is not a list holds no choice, and a choice that is not an
  // object holds no delta; the frames beside them are the reply either way.
  for (const [shape, choices] of [
    ["an object", {}],
    ["a string", "nope"],
    ["a list holding a null", [null]],
    ["a list holding a string", ["nope"]],
  ]) {
    const body = await json(
      event({ choices }) +
        event({ choices: [{ index: 0, delta: { content: "kept" } }] }) +
        event("[DONE]"),
      "chat",
    );
    assert.deepEqual(
      body.choices.map((choice) => choice.message.content),
      ["kept"],
      `${shape} where a list of choices belongs was read as a choice or failed the stream`,
    );
  }
  // Nor is a choice the reply holds the only thing a malformed entry can hide:
  // a `tool_calls` that is not a list holds no fragment, and one that is not an
  // object is not a fragment to place — read as one it opened a call with
  // nothing in it, which no upstream frame ever described.
  for (const [shape, toolCalls] of [
    ["an object", {}],
    ["a string", "nope"],
    ["a null", null],
    ["a number", 5],
  ]) {
    const body = await json(
      event({ choices: [{ index: 0, delta: { tool_calls: toolCalls } }] }) +
        event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        event("[DONE]"),
      "chat",
    );
    assert.deepEqual(
      body.choices[0].message.tool_calls,
      undefined,
      `${shape} where a list of tool calls belongs was read as a call or failed the stream`,
    );
  }
  // An entry that is not a fragment is skipped where it stands, and the
  // fragment beside it is placed as it always was.
  for (const malformed of [null, "nope", 7, []]) {
    const b = "bash";
    const body = await json(
      event({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                malformed,
                { id: "call_A", type: "function", function: { name: b, arguments: '{"a":1}' } },
              ],
            },
          },
        ],
      }) +
        event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        event("[DONE]"),
      "chat",
    );
    assert.deepEqual(
      body.choices[0].message.tool_calls.map((call) => [
        call.id,
        call.function.name,
        call.function.arguments,
      ]),
      [["call_A", "bash", '{"a":1}']],
      `${JSON.stringify(malformed)} beside a fragment was read as a call of its own`,
    );
  }
});

// The report fields a frame carries are read by shape too. Folding in a `usage`
// or a `logprobs` that is not an object invented keys for the client: a spread
// of a string answers its characters by index ({"0":"a","1":"b"}) in a field a
// host reads, and `Object.entries` over one answers them in `logprobs`. Neither
// is a report anybody wrote, and the reply goes on without one.
test("chat folds in a usage or logprobs report only when it is one", async () => {
  for (const [shape, value] of [
    ["a string", "abc"],
    ["a number", 5],
    ["a list", [1, 2]],
  ]) {
    const body = await json(
      event({ choices: [{ index: 0, logprobs: value, delta: { content: "hi" } }], usage: value }) +
        event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
        event("[DONE]"),
      "chat",
    );
    assert.equal(body.usage, undefined, `${shape} where a usage report belongs was folded in`);
    assert.equal(
      body.choices[0].logprobs,
      undefined,
      `${shape} where a logprobs report belongs was folded in`,
    );
  }
  // A report the frame does state is still folded in, key for key.
  const body = await json(
    event({
      choices: [{ index: 0, logprobs: { a: 1 }, delta: { content: "hi" } }],
      usage: { total_tokens: 3 },
    }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      event("[DONE]"),
    "chat",
  );
  assert.deepEqual(body.usage, { total_tokens: 3 });
  assert.deepEqual(body.choices[0].logprobs, { a: 1 });
});

// The other operand of the same merge. A frame's own report is read by shape
// (above), but a snapshot spread whole onto the body brings its `usage` in with
// every other field — a `message_start`'s message, a `response.created`'s
// response — and a terminal response is spread whole onto the answer. A string
// standing under `usage` there is spread into its characters by the next frame
// that folds a real report in ({"0":"a","1":"b","2":"c"}), and answered as
// itself when no frame follows: a report nobody wrote, in a field a host reads.
// A report that is not one states none, so the report the body already held
// stands, which is what a frame-level report that is not one leaves standing.
test("a snapshot's usage is folded in only when it is a report, on every path that copies one", async () => {
  const stop = event({ type: "message_stop" }, "message_stop");
  const start = (usage) =>
    event(
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
      "message_start",
    );
  const delta = (usage) =>
    event(
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
      "message_delta",
    );
  const created = (usage) =>
    event({
      type: "response.created",
      response: { id: "r1", status: "in_progress", output: [], usage },
    });
  const completed = (response, usage) =>
    event({
      type: "response.completed",
      response: { id: "r1", status: "completed", output: [], ...response },
      ...(usage === undefined ? {} : { usage }),
    });

  for (const [shape, usage] of [
    ["a string", "abc"],
    ["a number", 5],
    ["a list", [1, 2]],
  ]) {
    // A Messages start whose message carries one, with nothing to merge onto it.
    assert.equal(
      (await json(start(usage) + stop, "anthropic")).usage,
      undefined,
      `${shape} where a usage report belongs was copied onto the Messages body`,
    );
    // The same start with a real report behind it: the string is spread by the
    // merge that follows.
    assert.deepEqual(
      (await json(start(usage) + delta({ output_tokens: 3 }) + stop, "anthropic")).usage,
      { output_tokens: 3 },
      `${shape} from a message_start was spread by a later merge`,
    );
    // A Responses opening snapshot whose response carries one.
    assert.equal(
      (await json(created(usage) + completed(), "responses")).usage,
      undefined,
      `${shape} where a usage report belongs was copied onto the Responses body`,
    );
    assert.deepEqual(
      (await json(created(usage) + completed(undefined, { input_tokens: 2 }), "responses"))
        .usage,
      { input_tokens: 2 },
      `${shape} from a response.created was spread by a later merge`,
    );
    // Both in one frame: the snapshot's copy lands before the frame's own fold.
    assert.deepEqual(
      (await json(
        event({
          type: "response.created",
          response: { id: "r1", status: "in_progress", output: [], usage },
          usage: { input_tokens: 2 },
        }) + completed(),
        "responses",
      )).usage,
      { input_tokens: 2 },
      `${shape} from a response.created was spread by the frame's own report`,
    );
    // A terminal is spread whole onto the answer as well.
    assert.equal(
      (await json(completed({ usage }, undefined), "responses")).usage,
      undefined,
      `${shape} where a usage report belongs was copied from the terminal`,
    );
  }

  // A body that already holds a report keeps it: a repeated start or terminal
  // that states none of its own takes nothing away.
  assert.deepEqual(
    (await json(start({ input_tokens: 5 }) + delta({ output_tokens: 3 }) + start("abc") + stop, "anthropic"))
      .usage,
    { input_tokens: 5, output_tokens: 3 },
    "a malformed message_start took the accumulated report away",
  );
  assert.deepEqual(
    (await json(created({ input_tokens: 5 }) + completed({ usage: "abc" }), "responses")).usage,
    { input_tokens: 5 },
    "a malformed terminal report took the accumulated report away",
  );

  // And a report that is one is still copied and merges as it always did.
  assert.deepEqual(
    (await json(start({ input_tokens: 5 }) + delta({ output_tokens: 3 }) + stop, "anthropic")).usage,
    { input_tokens: 5, output_tokens: 3 },
  );
  assert.deepEqual(
    (await json(created({ input_tokens: 5 }) + completed(undefined, { output_tokens: 3 }), "responses"))
      .usage,
    { input_tokens: 5, output_tokens: 3 },
  );
  assert.deepEqual(
    (await json(completed({ usage: { output_tokens: 7 } }), "responses")).usage,
    { output_tokens: 7 },
  );
});

test("chat retains null content for tool-only replies and legacy function_call fragments", async () => {
  const body = await json(
    event({
      choices: [
        {
          index: 0,
          delta: { content: null, function_call: { name: "lookup", arguments: '{"x":' } },
        },
      ],
    }) +
      event({
        choices: [
          {
            index: 0,
            delta: { function_call: { arguments: "1}" } },
            finish_reason: "function_call",
          },
        ],
      }) +
      event("[DONE]"),
    "chat",
  );
  assert.equal(body.choices[0].message.content, null);
  assert.deepEqual(body.choices[0].message.function_call, { name: "lookup", arguments: '{"x":1}' });
});

// The Chat shape lets a fragment state no `index` at all, and the id a fragment
// carries is then the only fact telling one call from another. Read as the
// first slot whatever it carried, a reply's second call was merged into its
// first: `call_A` disappeared, its arguments were appended to `call_B`, and the
// client was told one call named "bashread" that no declared tool answers (D1).
// A fragment whose id an open call of this choice already answers is that call;
// any other id opens the next unused slot; a fragment with no usable id has
// nothing to place it by and is read as the first slot, which is the reading
// the guard gives it too (tool-response.mjs's `slotFor`, pinned from both paths
// by "a fragment that names no index is read the same by both paths").
test("chat places an index-less tool-call fragment by the id it carries, not by arrival", async () => {
  const fragment = (spec) => event({ choices: [{ index: 0, delta: { tool_calls: [spec] } }] });
  const opens = (id, name, args) => ({ id, type: "function", function: { name, arguments: args } });
  const finished =
    event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + event("[DONE]");
  const callsOf = (body) =>
    (body.choices[0].message.tool_calls ?? []).map((call) => [
      call.id,
      call.function.name,
      call.function.arguments,
    ]);

  // Two calls, neither fragment stating an index: each id names a call this
  // choice has not opened, so each takes the lowest slot no call holds.
  const opened = await json(
    fragment(opens("call_A", "bash", '{"a":1}')) +
      fragment(opens("call_B", "read", '{"b":2}')) +
      finished,
    "chat",
  );
  assert.deepEqual(
    callsOf(opened),
    [
      ["call_A", "bash", '{"a":1}'],
      ["call_B", "read", '{"b":2}'],
    ],
    "two calls whose fragments state no index were read as one",
  );

  // A fragment that echoes the id of a call already open is that call's, not a
  // second call: the same rule read on the frames that carry an index as well.
  const echoed = await json(
    fragment({ index: 0, ...opens("call_A", "bash", '{"a":') }) +
      fragment({ index: 1, ...opens("call_B", "read", '{"b":') }) +
      fragment({ id: "call_B", function: { arguments: "2}" } }) +
      finished,
    "chat",
  );
  assert.deepEqual(
    callsOf(echoed),
    [
      ["call_A", "bash", '{"a":'],
      ["call_B", "read", '{"b":2}'],
    ],
    "a fragment echoing an open call's id was read as a call of its own",
  );

  // A fragment with no usable id — absent, `null`, or `""` — has nothing to
  // place it by: it is read as the first slot, which is what the parity test
  // pins for the id-less shape both paths read.
  for (const [shape, id] of [
    ["no id at all", {}],
    ["a null id", { id: null }],
    ["an empty id", { id: "" }],
  ]) {
    const body = await json(
      fragment({ index: 0, ...opens("call_A", "bash", '{"a":') }) +
        fragment({ index: 1, ...opens("call_B", "read", '{"b":') }) +
        fragment({ ...id, function: { arguments: "1}" } }) +
        finished,
      "chat",
    );
    assert.deepEqual(
      callsOf(body),
      [
        ["call_A", "bash", '{"a":1}'],
        ["call_B", "read", '{"b":'],
      ],
      `${shape}: a fragment with nothing to place it by was not read as the first slot`,
    );
  }

  // A repeated `function.name` is not a second call: a name may be fragmented
  // across the frames of one call, so a fragment with no index, no id and a
  // name that has been read before still continues the first slot. The name the
  // fragments carry is appended like any other streamed text ("bashbash") — the
  // very shape a rule that split on a repeated name would answer as two calls.
  const repeated = await json(
    fragment({ index: 0, ...opens("call_A", "bash", '{"a":') }) +
      fragment({ function: { name: "bash", arguments: "1}" } }) +
      finished,
    "chat",
  );
  assert.deepEqual(
    callsOf(repeated),
    [["call_A", "bashbash", '{"a":1}']],
    "a repeated function name was read as a call of its own",
  );
});

test("chat merges logprobs as own properties, so an upstream __proto__ neither throws nor re-parents", async () => {
  // JSON.parse makes "__proto__" an own key where an object literal would set
  // a prototype, so these frames are written as bytes. Merging with [[Set]]
  // reached the inherited accessor instead: an array value spread
  // Object.prototype and threw "not iterable" — which dispatch turns into a
  // 502 on an otherwise valid stream — and an object value silently
  // re-parented the accumulated object, losing the key.
  const merge = (logprobs) =>
    `data: {"choices":[{"index":0,"delta":{"content":"a"},"logprobs":${logprobs}}]}\n\ndata: [DONE]\n\n`;
  const array = await json(merge('{"__proto__":["x"]}'), "chat");
  assert.equal(array.choices[0].message.content, "a");
  assert.deepEqual(array.choices[0].logprobs["__proto__"], ["x"]);
  // Read on the bytes. JSON.parse hands every object Object.prototype, so a
  // re-parented accumulated object reads back exactly like a sound one.
  const response = await collapseResponse(sse(merge('{"__proto__":{"polluted":true}}')), "chat");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"__proto__":\{"polluted":true\}/);
});

test("SSE supports BOM, comments, CRLF, multiple data lines and arbitrary byte boundaries", async () => {
  const text =
    '\uFEFF: keepalive\r\nid: 3\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"中文🙂"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const chunkSize of [1, 2, 3, 7, 64, 1024]) {
    const body = await json(text, "chat", { chunkSize });
    assert.equal(body.choices[0].message.content, "中文🙂");
  }
});

test("SSE supports CR-only line endings", async () => {
  const body = await json(
    (
      event({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }) +
      event("[DONE]")
    ).replaceAll("\n", "\r"),
    "chat",
    { chunkSize: 1 },
  );
  assert.equal(body.choices[0].message.content, "ok");
});

test("Responses uses the complete final response without replacing authoritative fields", async () => {
  const final = {
    id: "resp-1",
    object: "response",
    status: "completed",
    model: "zen",
    output: [
      {
        type: "message",
        id: "msg",
        role: "assistant",
        content: [{ type: "output_text", text: "final", annotations: [] }],
      },
      { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
      { type: "function_call", call_id: "call", name: "f", arguments: '{"a":1}' },
    ],
    usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
    metadata: { retained: true },
  };
  // A copy, so an implementation that rewrote the final response in place
  // cannot answer for itself.
  const expected = structuredClone(final);
  const body = await json(
    event({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "not final",
    }) + event({ type: "response.completed", response: final }, "response.completed"),
    "responses",
  );
  assert.deepEqual(body, expected);
});

test("Responses incomplete keeps the original response and its usage", async () => {
  const final = {
    id: "resp-limit",
    object: "response",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [],
    usage: { output_tokens: 20 },
  };
  // Taken before the collapse runs: a reply that rewrote final in place
  // would otherwise be compared against itself.
  const expected = structuredClone(final);
  assert.deepEqual(
    await json(event({ response: final }, "response.incomplete"), "responses"),
    expected,
  );
});

test("a terminal response that carries no output keeps what was streamed", async () => {
  // Measured through the whole pipeline: HTTP 200 with {"id":"resp_1",
  // "status":"completed"} returned exactly that — the streamed text gone, no
  // error, and nothing to tell it apart from a model that said nothing. A
  // terminal that does carry its output still comes back as it arrived (the
  // test above).
  for (const last of [
    { id: "resp_1", status: "completed" },
    { id: "resp_1", status: "completed", output: [] },
  ]) {
    const body = await json(
      event({ type: "response.created", response: { id: "resp_1", output: [] } }) +
        event({
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "m", type: "message", role: "assistant", content: [] },
        }) +
        event({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "hello",
        }) +
        event({ type: "response.completed", response: last }, "response.completed"),
      "responses",
    );
    assert.equal(body.id, "resp_1");
    assert.equal(body.status, "completed");
    assert.equal(body.output[0].content[0].text, "hello");
  }
});

test("a partial snapshot does not overwrite the content already accumulated", async () => {
  // A response.created that repeats beside the deltas it opened, carrying a
  // message that is still empty, and a message_start whose block has not been
  // filled in. Neither is a newer view of what the stream delivered, and
  // taking either would discard it.
  const responses = await json(
    event({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "kept",
    }) +
      event({
        type: "response.created",
        response: { id: "r", output: [{ id: "m", type: "message", content: [] }] },
      }) +
      event({ type: "response.completed", response: { id: "r", status: "completed", output: [] } }),
    "responses",
  );
  assert.equal(responses.output[0].content[0].text, "kept");
  const messages = await json(
    event(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "kept" } },
      "content_block_start",
    ) +
      event(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
        "content_block_delta",
      ) +
      event(
        { type: "message_start", message: { id: "m", content: [{ type: "text", text: "" }] } },
        "message_start",
      ) +
      event({ type: "message_stop" }, "message_stop"),
    "anthropic",
  );
  assert.equal(messages.content[0].text, "kept!");
});

test("Responses aggregates fallback text, reasoning, function arguments and usage", async () => {
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp-2",
        object: "response",
        model: "zen",
        status: "in_progress",
        output: [],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "m", type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello" },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: " world" },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "r", type: "reasoning", summary: [] },
    },
    {
      type: "response.reasoning_summary_part.added",
      output_index: 1,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 1,
      summary_index: 0,
      delta: "think",
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: { id: "f", type: "function_call", call_id: "call", name: "lookup", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"q":' },
    { type: "response.function_call_arguments.delta", output_index: 2, delta: '"x"}' },
    { type: "response.completed", usage: { input_tokens: 2, output_tokens: 4, total_tokens: 6 } },
  ];
  const body = await json(events.map((value) => event(value)).join(""), "responses");
  assert.equal(body.id, "resp-2");
  assert.equal(body.status, "completed");
  assert.equal(body.output[0].content[0].text, "hello world");
  assert.equal(body.output[1].summary[0].text, "think");
  assert.equal(body.output[2].arguments, '{"q":"x"}');
  assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 4, total_tokens: 6 });
});

// A terminal event is not the whole reply either. `apply` merges what that event
// carries at its own top level onto the accumulated body — `usage` above all,
// and `status`, `object`, `incomplete_details`, `finish_reason` — and answering
// with the terminal's `response` alone dropped them: the reply came back without
// the usage the same event had just stated.
test("Responses: a terminal carrying a whole response keeps the fields beside it", async () => {
  const text =
    event({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "hi",
    }) +
    event(
      {
        type: "response.completed",
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        response: {
          id: "resp-3",
          object: "response",
          status: "completed",
          output: [
            {
              id: "m",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "hi", annotations: [] }],
            },
          ],
        },
      },
      "response.completed",
    );
  const body = await json(text, "responses");
  assert.equal(body.id, "resp-3");
  assert.equal(body.output[0].content[0].text, "hi");
  assert.deepEqual(
    body.usage,
    { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    "the usage the terminal stated is part of the reply",
  );
});

// A gateway re-emitting an opening frame carries a part whose text is empty
// where the deltas have already filled the slot, and writing it in
// unconditionally discarded what had been delivered — the same
// partial-snapshot hazard the item guard above and `content_block_start` in the
// Messages accumulator exist for.
test("Responses: a re-emitted content part does not discard the text before it", async () => {
  const opening = {
    type: "response.content_part.added",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  };
  const text =
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "m", type: "message", role: "assistant", content: [] },
    }) +
    event(opening) +
    event({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "kept",
    }) +
    event(opening) +
    event(
      { type: "response.completed", response: { id: "r", object: "response", status: "completed", output: [] } },
      "response.completed",
    );
  const body = await json(text, "responses");
  assert.equal(body.output[0].content[0].text, "kept", "the re-emitted opening carried nothing");
});

// An `added` frame opens an item, so the id it names is new by definition — and
// a stream that never indexed its items, which `slot` above is written to
// tolerate, used to 502 on its very first item because the lookup demanded the
// item already be open. It takes the next free slot instead, and the frames that
// name it by id find it there.
test("Responses: an item frame that omits its output index still opens the item", async () => {
  const text =
    event({
      type: "response.output_item.added",
      item: { id: "f", type: "function_call", call_id: "call", name: "lookup", arguments: "" },
    }) +
    event({ type: "response.function_call_arguments.delta", item_id: "f", delta: '{"q":1}' }) +
    event(
      { type: "response.completed", response: { id: "r", object: "response", status: "completed", output: [] } },
      "response.completed",
    );
  const body = await json(text, "responses");
  assert.equal(body.output[0].arguments, '{"q":1}');
});

test("Responses done snapshots do not duplicate accumulated deltas", async () => {
  const item = {
    id: "f",
    type: "function_call",
    call_id: "call",
    name: "lookup",
    arguments: '{"a":1}',
    status: "completed",
  };
  // The snapshot the events carry, copied before the collapse: an
  // implementation that appended the deltas to it again would be mutating
  // the expected value along with its own.
  const expected = structuredClone(item);
  const body = await json(
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    }) +
      event({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"a":1}' }) +
      event({
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: '{"a":1}',
      }) +
      event({ type: "response.output_item.done", output_index: 0, item }) +
      event({ type: "response.completed" }),
    "responses",
  );
  assert.deepEqual(body.output, [expected]);
});

test("Responses reads a reasoning summary's done event from its own field", async () => {
  // A summary's whole text arrives in `summary`, not in the `text` that
  // response.reasoning_text.done carries. Reading `text` for a summary lost a
  // done event that had no delta before it (measured: the summary came back
  // empty while the delta-before-done shape looked right).
  const body = await json(
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "r", type: "reasoning", summary: [] },
    }) +
      event({
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "kept",
      }) +
      event({
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        summary_index: 1,
        summary: "thought",
      }) +
      event({ type: "response.completed" }),
    "responses",
  );
  assert.equal(body.output[0].summary[0].text, "kept");
  assert.equal(body.output[0].summary[1].text, "thought");
});

test("Responses finds an item snapshot's slot by item_id when output_index is missing", async () => {
  const body = await json(
    event({ type: "response.created", response: { id: "r", output: [] } }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "m", type: "message", role: "assistant", content: [] },
      }) +
      event({
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "f", type: "function_call", call_id: "call", name: "lookup", arguments: "" },
      }) +
      event({
        type: "response.output_item.done",
        item: {
          id: "f",
          type: "function_call",
          call_id: "call",
          name: "lookup",
          arguments: '{"a":1}',
        },
      }) +
      event({ type: "response.completed" }),
    "responses",
  );
  // The snapshot belongs to the item it names, not to whichever slot 0 held.
  assert.deepEqual(
    body.output.map((item) => item.id),
    ["m", "f"],
  );
  assert.equal(body.output[1].arguments, '{"a":1}');
  assert.deepEqual(body.output[0].content, []);
});

test("Responses refuses a frame that names an item the stream never opened", async () => {
  // An out-of-order (or dropped) output_item.added leaves a frame naming an
  // item no slot holds. Putting it in slot 0 merged it into the first item —
  // measured: a function_call at slot 0 came back carrying a message's text —
  // so it is an error instead. Only a frame that names nothing at all takes
  // slot 0, which is what a stream that never indexed its items means.
  await failure(
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "f",
        type: "function_call",
        call_id: "call",
        name: "lookup",
        arguments: "",
      },
    }) +
      event({
        type: "response.output_text.delta",
        item_id: "m",
        content_index: 0,
        delta: "LEAKED TEXT",
      }) +
      event({ type: "response.completed" }),
    "responses",
    /unknown item/,
  );
  // A frame that names an item the stream did open still finds it by id.
  const body = await json(
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "inner", type: "message", role: "assistant", content: [] },
    }) +
      event({
        type: "response.output_text.delta",
        item_id: "inner",
        content_index: 0,
        delta: "named",
      }) +
      event({ type: "response.completed" }),
    "responses",
  );
  assert.equal(body.output[0].content[0].text, "named");
});

// The same refusal must not refuse the reply this route actually sends: an
// item whose own frames carry no id at all, named from the frames after it
// on. The item the stream opened for the call is the one those frames name,
// so the id is adopted onto it and the call is one item of the reply — the
// id-less shape the streaming path (tool-response.mjs) rewrote the item ids
// for, and what the collapsed reply of the same bytes has to agree with.
test("Responses places a frame naming the one item the stream opened without an id", async () => {
  const call = { type: "function_call", name: "lookup", arguments: "" };
  const body = await json(
    event({ type: "response.output_item.added", item: call }) +
      event({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a"' }) +
      event({
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        arguments: '{"a":1}',
      }) +
      event({ type: "response.output_item.done", item: { ...call, arguments: '{"a":1}' } }) +
      event({ type: "response.completed" }),
    "responses",
  );
  assert.equal(body.output.length, 1, "one call is one item");
  assert.equal(body.output[0].id, "fc_1", "the id the frames name is the item's");
  assert.equal(body.output[0].arguments, '{"a":1}');

  // Two items of that kind, neither with an id, is still not something to
  // guess at: naming one of them says which of two it could be.
  await failure(
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", name: "one", arguments: "" },
    }) +
      event({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", name: "two", arguments: "" },
      }) +
      event({ type: "response.output_text.delta", item_id: "fc_1", content_index: 0, delta: "x" }) +
      event({ type: "response.completed" }),
    "responses",
    /unknown item/,
  );
});

// What a client reading the frames without this collapse sees: the items the
// output_item frames open, in the order the reply answers them. The invariant
// these tests read is that the same bytes describe the same items on both
// paths — the same count, the same order, each one the kind its own frames
// say it is. What the frames leave to the deltas (a call's arguments, a text
// block's text) is what this path accumulates, so it is not compared here.
//
// The placement rule is production's (stream.mjs's `finish()`, over the slots
// `locate` opened): an item that states an output_index sits there, and one
// that states none takes the lowest place no stated index claims, in the order
// the stream opened them. Counting arrival order instead put an unplaced item
// on a slot a stated index already held, so the helper read one item where the
// reply answered two.
function streamedItems(frames) {
  const held = new Map();
  const stated = new Set();
  for (const frame of frames) {
    if (frame?.type !== "response.output_item.added") continue;
    const item = frame.item ?? {};
    let at = frame.output_index;
    if (at !== undefined) stated.add(at);
    else if (item.id) at = [...held].find(([, value]) => value.id === item.id)?.[0];
    if (at === undefined) {
      at = 0;
      while (stated.has(at) || held.has(at)) at++;
    }
    held.set(at, item);
  }
  return [...held]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => ({ type: value.type }));
}

test("Responses keeps two items the upstream placed nowhere apart", async () => {
  // Two items with no output_index and no item id — the shape a stream that
  // never indexed its items sends. The second one used to land on slot 0 as
  // well, where `keep` read it as a partial view of the first and discarded
  // it: the streamed reply carried both calls while this path answered 200
  // with one of them.
  const message = { type: "message", role: "assistant", content: [] };
  const call = { type: "function_call", name: "lookup", arguments: "" };
  const frames = [
    { type: "response.output_item.added", item: message },
    // A call's frames, and a message's, carry no item id at all here, so the
    // item the stream opened is the one they are filling in.
    { type: "response.output_text.delta", item_id: "msg_a", content_index: 0, delta: "hello" },
    { type: "response.output_item.added", item: call },
    { type: "response.function_call_arguments.delta", item_id: "call_a", delta: '{"a"' },
    { type: "response.function_call_arguments.done", item_id: "call_a", arguments: '{"a":1}' },
    { type: "response.output_item.done", item: { ...call, id: "call_a", arguments: '{"a":1}' } },
    { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
  ];
  const body = await json(frames.map((value) => event(value)).join(""), "responses");
  assert.equal(body.output.length, 2, "two items placed nowhere are two items");
  assert.deepEqual(
    body.output.map((item) => item.type),
    ["message", "function_call"],
  );
  assert.equal(body.output[0].content[0].text, "hello");
  assert.equal(body.output[1].arguments, '{"a":1}');
  // Each item is the one its own frames named: the id-less opening frames
  // opened them, and the ids the frames after them carry are the ones they
  // took, so the streamed client and this reply name one item one way.
  assert.deepEqual(
    body.output.map((item) => item.id),
    ["msg_a", "call_a"],
  );
  // Neither item carries what the other's frames filled in.
  assert.equal(body.output[0].arguments, undefined, "the message took the call's arguments");
  assert.equal(body.output[1].content, undefined, "the call took the message's content");
  // The same bytes describe the same items on both paths: the streamed reply
  // opened these two, in this order, and the collapsed one holds these two.
  assert.deepEqual(
    body.output.map((item) => ({ type: item.type })),
    streamedItems(frames),
  );

  // Two of the same kind as well: the second opening frame opens an item
  // rather than continuing the one the first opened, and each id-less frame
  // goes on filling in the item the stream opened last.
  const second = await json(
    event({ type: "response.output_item.added", item: message }) +
      event({ type: "response.output_text.delta", item_id: "msg_a", content_index: 0, delta: "A" }) +
      event({ type: "response.output_item.added", item: message }) +
      event({ type: "response.output_text.delta", item_id: "msg_b", content_index: 0, delta: "B" }) +
      event({ type: "response.completed", response: { id: "r", status: "completed", output: [] } }),
    "responses",
  );
  assert.equal(second.output.length, 2, "two messages placed nowhere are two items");
  assert.deepEqual(
    second.output.map((item) => item.content[0].text),
    ["A", "B"],
    "the messages are in the order the stream opened them",
  );
});

test("Responses places a streamed item beside the indices the frames state, as the reply does", async () => {
  // An item the upstream placed nowhere has no place of its own, so it takes
  // the first place no stated index claims, and the reply answers it after the
  // item that kept index 0. The helper that reads what a streaming client sees
  // (`streamedItems`) used to count arrival order only, so the unplaced item
  // claimed slot 0 a second time and the streamed reply read as one item where
  // the collapsed reply answered two.
  const call = { type: "function_call", id: "call_1", name: "lookup", arguments: "" };
  const message = { type: "message", id: "msg_1", role: "assistant", content: [] };
  const frames = [
    { type: "response.output_item.added", output_index: 0, item: call },
    { type: "response.output_item.added", item: message },
    { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "note" },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: "call_1",
      arguments: '{"q":1}',
    },
    { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
  ];
  const body = await json(frames.map((value) => event(value)).join(""), "responses");
  assert.deepEqual(
    body.output.map((item) => item.type),
    ["function_call", "message"],
    "the unplaced item takes the place the stated index left free",
  );
  assert.equal(body.output[0].arguments, '{"q":1}');
  assert.equal(body.output[1].content[0].text, "note");
  assert.deepEqual(
    body.output.map((item) => ({ type: item.type })),
    streamedItems(frames),
    "the streamed reply and its collapsed copy disagree about where an item sits",
  );

  // The same two items the other way round: the unplaced one arrives first and
  // keeps the place no stated index claims, whoever the stated index belongs
  // to, and the item that stated one is answered in its own place.
  const reversed = [
    { type: "response.output_item.added", item: message },
    { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "note" },
    { type: "response.output_item.added", output_index: 1, item: { ...call, id: "call_2" } },
    {
      type: "response.function_call_arguments.done",
      output_index: 1,
      item_id: "call_2",
      arguments: '{"q":2}',
    },
    { type: "response.completed", response: { id: "r", status: "completed", output: [] } },
  ];
  const other = await json(reversed.map((value) => event(value)).join(""), "responses");
  assert.deepEqual(
    other.output.map((item) => ({ type: item.type })),
    streamedItems(reversed),
    "the two paths disagree when the unplaced item arrives before the placed one",
  );
  assert.deepEqual(
    other.output.map((item) => item.name ?? item.content[0].text),
    ["note", "lookup"],
  );
});

// The other half of the same hazard, and the one a stream is more likely to
// send: an item named by id alone (no output_index) and an item that states
// its own output_index. Both used to be told apart by one number — the item
// the id named was given the next free index, which the item stating
// `output_index: 0` then claimed as its own. `keep` read the second item as a
// newer view of the first, took it for the whole reply, and answered 200 with
// one item of the two wearing the other's id: a tool call silently gone, and
// the id of one call standing on another. An index the upstream states is a
// fact about its reply; an index this file infers is a guess, and a guess
// never displaces a fact.
test("Responses keeps an item named by id and an item stating its own index apart", async () => {
  const body = await json(
    event({
      type: "response.output_item.added",
      item: { type: "function_call", id: "call_a", name: "bash", arguments: '{"a":1}' },
    }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", name: "read", arguments: '{"b":2}' },
      }) +
      event({ type: "response.completed", response: { id: "r", status: "completed" } }),
    "responses",
  );
  assert.equal(body.output.length, 2, "a call named by id and a call stating index 0 are two calls");
  // The call that stated index 0 is placed at 0 and the one that stated nothing
  // takes the next place no index claims, so the reply reads in the order the
  // upstream placed its items rather than the order the frames arrived in.
  assert.deepEqual(
    body.output.map((item) => [item.id, item.name, item.arguments]),
    [
      [undefined, "read", '{"b":2}'],
      ["call_a", "bash", '{"a":1}'],
    ],
    "each call keeps its own identity and its own arguments",
  );
});

test("Responses opens an item for an index no item has stated, instead of displacing one", async () => {
  // Two calls the upstream placed nowhere, and a third that states index 0 —
  // the place neither of those took, because an item the upstream places
  // nowhere takes the first place no stated index claims rather than the number
  // that happens to equal its arrival order. All three reach the reply, and the
  // one the upstream placed is answered at its place.
  const body = await json(
    event({ type: "response.output_item.added", item: { type: "function_call", name: "bash", arguments: '{"one":1}' } }) +
      event({ type: "response.output_item.added", item: { type: "function_call", name: "read", arguments: '{"two":2}' } }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", name: "edit", arguments: '{"three":3}' },
      }) +
      event({ type: "response.completed", response: { id: "r", status: "completed" } }),
    "responses",
  );
  assert.equal(body.output.length, 3, "three calls opened are three calls answered");
  assert.deepEqual(
    body.output.map((item) => item.arguments),
    ['{"three":3}', '{"one":1}', '{"two":2}'],
    "the stated index keeps its place, the unplaced items fill the next ones",
  );
});

// The same collision with the identity and the frames a real reply carries:
// the call named by id is opened, its arguments are streamed to it, and the
// item claiming index 0 arrives between parts of that — the order measured on
// this route. The id and the arguments must both stay on the call they came
// from, and neither call may be dropped.
test("Responses does not hand a stated index another call's id or arguments", async () => {
  const body = await json(
    event({
      type: "response.output_item.added",
      item: { type: "function_call", id: "call_a", name: "bash", arguments: "" },
    }) +
      event({ type: "response.function_call_arguments.delta", item_id: "call_a", delta: '{"a"' }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", name: "read", arguments: '{"b":2}' },
      }) +
      event({ type: "response.function_call_arguments.delta", item_id: "call_a", delta: ":1}" }) +
      event({
        type: "response.output_item.done",
        item: { id: "call_a", type: "function_call", call_id: "call_a", name: "bash", arguments: '{"a":1}', status: "completed" },
      }) +
      event({ type: "response.completed", response: { id: "r", status: "completed" } }),
    "responses",
  );
  assert.equal(body.output.length, 2, "both calls are in the reply");
  assert.deepEqual(
    body.output.map((item) => [item.id, item.name, item.arguments]),
    [
      [undefined, "read", '{"b":2}'],
      ["call_a", "bash", '{"a":1}'],
    ],
    "the id and the arguments stay on the call they were streamed for",
  );
});

// An id that is `0`, `false` or `""` is not a name: a client cannot key an item
// by it, so two calls carrying the same one are two calls — the rule
// tool-response.mjs's identity() states, and the one this file reads a name by.
// Reading them as names in one place and as non-names in another resolved the
// second call to the first one's item, wrote the second call's arguments over
// the first's, and refused the reply with a 502 where the same shape without
// indexes answered 200 with two items.
test("Responses reads an id that names nothing as no id, however many calls carry it", async () => {
  for (const [label, id] of [
    ["zero", 0],
    ["false", false],
    ["the empty string", ""],
    ["null", null],
  ]) {
    for (const indexed of [true, false]) {
      const frames = [];
      for (const at of [0, 1])
        frames.push(
          {
            type: "response.output_item.added",
            ...(indexed ? { output_index: at } : {}),
            item: { type: "function_call", id, name: `fn${at}`, arguments: "" },
          },
          {
            type: "response.function_call_arguments.done",
            ...(indexed ? { output_index: at } : {}),
            arguments: `{"n":${at}}`,
          },
        );
      frames.push({
        type: "response.completed",
        response: { id: "r", status: "completed", output: [] },
      });
      const body = await json(frames.map((value) => event(value)).join(""), "responses");
      const where = `${label}${indexed ? ", each with its own index" : ", placed nowhere"}`;
      assert.equal(body.output.length, 2, `${where}: two calls are two items`);
      assert.deepEqual(
        body.output.map((item) => item.arguments),
        ['{"n":0}', '{"n":1}'],
        `${where}: neither call took the other's arguments`,
      );
      // The id an item was sent with is not the guard's to rewrite: whatever
      // the frame carried is what the reply answers, and it is the same on
      // both items. What changed is only how the frames are placed, so nothing
      // here is a name one item took from another.
      assert.deepEqual(
        body.output.map((item) => item.id),
        [id, id],
        `${where}: the reply answers the id the frame carried`,
      );
    }
  }
});

test("Responses answers two calls that share one id when each states its own index", async () => {
  // An upstream that spends one item id on two items is contradicting itself,
  // and the index each of them states is the fact this file can still tell them
  // apart by. Refusing the second one lost the whole reply — 502 where the same
  // bytes had already delivered two items to a streaming client — so the
  // second item opens, and the reply answers both, each with the id its own
  // frames carried. The call that names the id alone in its arguments frames
  // (the shape this route sends for an item it numbered) reaches the item that
  // took the name last, so each call keeps its own arguments.
  const twoCalls = (first, second) =>
    event({
      type: "response.output_item.added",
      output_index: first.index,
      item: { type: "function_call", id: "X", name: first.name, arguments: "" },
    }) +
    event({
      type: "response.function_call_arguments.delta",
      output_index: first.index,
      item_id: "X",
      delta: first.arguments,
    }) +
    event({
      type: "response.function_call_arguments.done",
      ...(first.namedOnly ? {} : { output_index: first.index }),
      item_id: "X",
      arguments: first.arguments,
    }) +
    event({
      type: "response.output_item.done",
      output_index: first.index,
      item: { type: "function_call", id: "X", name: first.name, arguments: first.arguments, status: "completed" },
    }) +
    event({
      type: "response.output_item.added",
      output_index: second.index,
      item: { type: "function_call", id: "X", name: second.name, arguments: "" },
    }) +
    event({
      type: "response.function_call_arguments.delta",
      ...(second.namedOnly ? {} : { output_index: second.index }),
      item_id: "X",
      delta: second.arguments,
    }) +
    event({
      type: "response.function_call_arguments.done",
      ...(second.namedOnly ? {} : { output_index: second.index }),
      item_id: "X",
      arguments: second.arguments,
    }) +
    event({
      type: "response.output_item.done",
      output_index: second.index,
      item: { type: "function_call", id: "X", name: second.name, arguments: second.arguments, status: "completed" },
    }) +
    event({ type: "response.completed", response: { id: "r", status: "completed", output: [] } });
  const bash = { name: "bash", index: 0, arguments: '{"k":1}', namedOnly: false };
  const bedit = { name: "bedit", index: 1, arguments: '{"d":1}', namedOnly: true };

  const first = await json(twoCalls(bash, bedit), "responses");
  assert.equal(first.output.length, 2, "two calls are two items");
  assert.deepEqual(
    first.output.map((item) => [item.id, item.name, item.arguments]),
    [
      ["X", "bash", '{"k":1}'],
      ["X", "bedit", '{"d":1}'],
    ],
    "each call answers its own name, arguments and the id its frames carried",
  );

  // The same two calls in the other order: the call naming the id alone opens
  // the reply, so nothing has taken the name when its frames arrive. Both
  // stated an index, so both are answered at the place they stated, whatever
  // order the frames arrived in.
  const second = await json(twoCalls(bedit, bash), "responses");
  assert.equal(second.output.length, 2, "two calls are two items in either order");
  assert.deepEqual(
    second.output.map((item) => [item.id, item.name, item.arguments]),
    [
      ["X", "bash", '{"k":1}'],
      ["X", "bedit", '{"d":1}'],
    ],
    "each call answers its own name, arguments and the id its frames carried",
  );
});

test("Responses still refuses a frame that names an item this stream never opened", async () => {
  // The allowance above is for a frame that states an index: that is a place in
  // the reply, so the item opens there whatever id it carries. A frame that
  // states nothing still has to name an item this stream opened — an id no
  // frame opened, or one of two items of the frame's kind that both answer to
  // no id, is still not something to guess at. Both halves are asserted here,
  // because the rule they share is the one this file must not lose while
  // answering the first.
  const opened = { type: "function_call", id: "call_a", name: "bash", arguments: "" };
  const body = await json(
    event({ type: "response.output_item.added", item: opened }) +
      event({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "call_a", name: "bedit", arguments: "" },
      }) +
      event({ type: "response.function_call_arguments.done", item_id: "call_a", arguments: '{"d":1}' }) +
      event({ type: "response.completed", response: { id: "r", status: "completed", output: [] } }),
    "responses",
  );
  assert.equal(body.output.length, 2, "the stated index opened the second call");
  assert.equal(body.output[1].arguments, '{"d":1}', "the id alone reached the item that took it last");
  assert.equal(body.output[0].arguments, "", "and left the first call's own arguments alone");

  // An id that no item opened, with no index to place it by.
  await failure(
    event({ type: "response.output_item.added", item: opened }) +
      event({ type: "response.function_call_arguments.done", item_id: "never_opened", arguments: "{}" }) +
      event({ type: "response.completed" }),
    "responses",
    /unknown item/,
  );
  // Two items of the frame's kind that both answer to no id: naming one of them
  // says which of two it could be.
  await failure(
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", name: "one", arguments: "" },
    }) +
      event({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", name: "two", arguments: "" },
      }) +
      event({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{}" }) +
      event({ type: "response.completed" }),
    "responses",
    /unknown item/,
  );
});

test("Responses answers the reply's items in the order the upstream placed them", async () => {
  // The output_index a frame states is where its item sits in the reply, and a
  // client that reads no stream has nothing but the array's order to read the
  // reply's order from. Answering the items in the order the frames arrived in
  // told that client a reply that said 1 then 2 was 2 then 1.
  const call = (index, name) =>
    event({
      type: "response.output_item.added",
      output_index: index,
      item: { type: "function_call", id: `call_${name}`, name, arguments: "" },
    }) +
    event({
      type: "response.function_call_arguments.done",
      output_index: index,
      item_id: `call_${name}`,
      arguments: `{"n":${index}}`,
    });
  const terminal = event({
    type: "response.completed",
    response: { id: "r", status: "completed", output: [] },
  });

  const swapped = await json(call(2, "one") + call(1, "two") + terminal, "responses");
  assert.deepEqual(
    swapped.output.map((item) => [item.name, item.arguments]),
    [
      ["two", '{"n":1}'],
      ["one", '{"n":2}'],
    ],
    "the item that stated index 1 is answered first, whatever its arrival order",
  );

  const inOrder = await json(call(1, "one") + call(2, "two") + terminal, "responses");
  assert.deepEqual(
    inOrder.output.map((item) => [item.name, item.arguments]),
    [
      ["one", '{"n":1}'],
      ["two", '{"n":2}'],
    ],
    "and the same two items in the same places when the stream agreed with itself",
  );

  // An item the upstream placed nowhere has no place of its own to read, so it
  // takes the first place no stated index claims — the reading this file's slots
  // gave by construction before they were split into a key space per fact: an
  // unplaced item sat at the next free number, an indexed one at its index.
  const mixed = await json(
    event({
      type: "response.output_item.added",
      item: { type: "message", id: "msg", role: "assistant", content: [] },
    }) +
      event({
        type: "response.output_text.delta",
        item_id: "msg",
        content_index: 0,
        delta: "note",
      }) +
      call(2, "two") +
      call(1, "one") +
      terminal,
    "responses",
  );
  assert.deepEqual(
    mixed.output.map((item) => item.name ?? item.content[0].text),
    ["note", "one", "two"],
    "the unplaced item fills the first free place, the stated indices keep theirs",
  );
});

// A Responses snapshot is the upstream's own view of an item, and a view that
// is not an object — a null in an output list, a string, a number, a list —
// stands in for none of them. Read as one it answered 502 with an internal
// TypeError ("null is not an object (evaluating 'value.id')"), or 200 with the
// null sitting among the reply's items; a string part beside a delta threw
// "Attempted to assign to readonly property". The Messages accumulator refuses
// the same shapes and answers the reply's other frames from what it has
// (isSnapshotObject); a stream whose other frames are sound is not failed for
// one the upstream never filled in.
test("Responses skips a snapshot entry that is not an item, instead of failing the stream", async () => {
  const text = (delta) =>
    event({ type: "response.output_text.delta", item_id: "m", content_index: 0, delta });
  const completed = event({
    type: "response.completed",
    // The terminal carries no output of its own, so the items the stream
    // accumulated are the reply and can be read one by one.
    response: { id: "r", status: "completed", output: [] },
  });

  // An output list the opening snapshot carries is the same fact as an
  // output_item frame: a snapshot that is not an item is skipped, and one that
  // is lands in its place. A null is the shape that failed the whole reply.
  for (const [shape, output, kept] of [
    ["a null", [null], []],
    [
      "a string, a number and a list",
      ["text", 7, []],
      [],
    ],
    [
      "a null beside an item",
      [null, { type: "function_call", id: "call_a", name: "lookup", arguments: "" }],
      ["function_call"],
    ],
  ]) {
    const body = await json(
      event({ type: "response.created", response: { id: "r", output } }) + completed,
      "responses",
    );
    assert.deepEqual(
      body.output.map((item) => item.type),
      kept,
      `${shape} in a created snapshot's output reached the reply`,
    );
  }

  // A part that is not a part is the same view: skipped, so the item keeps the
  // content the deltas delivered rather than answering with a null among it or
  // throwing when a later delta reads a field of it.
  for (const [shape, part] of [
    ["a null", null],
    ["a string", "hello"],
    ["a number", 7],
    ["a list", []],
  ]) {
    const body = await json(
      event({ type: "response.output_item.added", item: { type: "message", id: "m" } }) +
        event({ type: "response.content_part.added", item_id: "m", content_index: 0, part }) +
        text("kept") +
        completed,
      "responses",
    );
    assert.deepEqual(
      body.output[0].content,
      [{ type: "output_text", text: "kept", annotations: [] }],
      `${shape} as a content part was stored or discarded the text around it`,
    );
  }

  // A reasoning summary part is a part of the same kind, and the same rule:
  // the summary the frames carry stands, and no null is placed among it.
  for (const [shape, part] of [
    ["a null", null],
    ["a string", "considered"],
  ]) {
    const body = await json(
      event({ type: "response.output_item.added", item: { type: "reasoning", id: "rs" } }) +
        event({
          type: "response.reasoning_summary_text.delta",
          item_id: "rs",
          summary_index: 0,
          delta: "kept",
        }) +
        event({
          type: "response.reasoning_summary_part.added",
          item_id: "rs",
          summary_index: 0,
          part,
        }) +
        completed,
      "responses",
    );
    assert.deepEqual(
      body.output[0].summary,
      [{ type: "summary_text", text: "kept" }],
      `${shape} as a reasoning summary part was stored or discarded the summary around it`,
    );
  }

  // A terminal that carries no item of its own keeps the items the stream
  // accumulated, and the same reading decides what counts as one: a null entry
  // is not an item to answer with.
  const sound = await json(
    event({ type: "response.output_item.added", item: { type: "message", id: "m" } }) +
      text("kept") +
      event({ type: "response.completed", response: { id: "r", output: [null] } }),
    "responses",
  );
  assert.deepEqual(
    sound.output.map((item) => item.content[0].text),
    ["kept"],
    "a terminal's null entry was answered in place of the accumulated item",
  );

  // The same reading for the values a frame itself carries: an item frame whose
  // `item` is a string is not an item to store — it was echoed among the
  // reply's items — and a snapshot whose `response` is not a reply object is
  // not one to merge, the rule `isSnapshotObject` states for a snapshot of
  // anything (a null, a string or a list stands in for nothing).
  for (const [shape, item] of [
    ["a string", "text"],
    ["a number", 7],
    ["a list", []],
  ]) {
    const body = await json(
      event({ type: "response.output_item.added", item }) + completed,
      "responses",
    );
    assert.deepEqual(body.output, [], `${shape} where an item belongs reached the reply's items`);
  }
  for (const [shape, response] of [
    ["a string", "not a reply"],
    ["a list", ["not a reply"]],
  ]) {
    const body = await json(event({ type: "response.created", response }) + completed, "responses");
    assert.doesNotMatch(
      JSON.stringify(body),
      /not a reply/,
      `${shape} where a reply object belongs was merged onto the reply`,
    );
    assert.deepEqual(
      Object.keys(body).filter((key) => /^\d+$/.test(key)),
      [],
      `${shape}: the snapshot's own entries became keys of the reply`,
    );
    assert.deepEqual(body.output, []);
  }
});

// A frame that names a place is a statement about where its item sits, and one
// the stream has already placed answers that frame: the item is updated, not
// opened a second time. Opening a second one answered 200 with two entries
// carrying one id (fc1 twice) — a client keying calls by id reads one call
// where the upstream described two frames of it.
test("Responses updates the item a frame names when the stream already placed it", async () => {
  const call = { type: "function_call", id: "fc1", name: "lookup", arguments: "" };
  for (const [shape, opening] of [
    [
      "an opening snapshot that carries the item",
      event({ type: "response.created", response: { id: "r", output: [call] } }),
    ],
    [
      "an item frame that places it",
      event({ type: "response.output_item.added", output_index: 0, item: call }),
    ],
  ]) {
    const body = await json(
      opening +
        event({ type: "response.output_item.added", output_index: 0, item: { ...call } }) +
        event({
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "fc1",
          arguments: '{"q":1}',
        }) +
        event({ type: "response.completed", response: { id: "r", status: "completed", output: [] } }),
      "responses",
    );
    assert.equal(body.output.length, 1, `${shape}: one item became two entries`);
    assert.deepEqual(
      body.output.map((item) => item.id),
      ["fc1"],
      `${shape}: two entries share one id`,
    );
    assert.equal(body.output[0].arguments, '{"q":1}', `${shape}: the frame did not update its item`);
  }

  // The same statement in the other order — the frame that names the place
  // first, the snapshot carrying the item second — is one item as well.
  const call2 = { type: "function_call", id: "fc2", name: "lookup", arguments: "" };
  const ordered = await json(
    event({ type: "response.output_item.added", output_index: 0, item: { ...call2, arguments: "" } }) +
      event({ type: "response.created", response: { id: "r", output: [{ ...call2, arguments: '{"q":2}' }] } }) +
      event({ type: "response.completed", response: { id: "r", status: "completed", output: [] } }),
    "responses",
  );
  assert.equal(ordered.output.length, 1, "the snapshot opened a second entry for a placed item");
  assert.equal(ordered.output[0].arguments, '{"q":2}', "the snapshot did not update the placed item");
});

test("Responses answers one item when a snapshot's entry omits the index its frames state", async () => {
  // A snapshot entry that states no output_index of its own takes the place the
  // list gives it, and the frames that follow name that place. Read as the item
  // of no place at all it opened a second slot of its own, and the reply
  // answered 200 with the opening snapshot's copy and the frames' copy of one
  // call — two entries, one id, and one of them frozen at what the snapshot was
  // created with.
  const call = (id, name) => ({ type: "function_call", id, name, arguments: "" });
  for (const [shape, output] of [
    ["one entry", [call("fc1", "lookup")]],
    [
      "two entries",
      [call("fc1", "lookup"), call("fc2", "lookup")],
    ],
  ]) {
    const frames =
      event({ type: "response.created", response: { id: "r", output } }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: call("fc1", "lookup"),
      }) +
      event({
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "fc1",
        arguments: '{"q":1}',
      }) +
      (output.length > 1
        ? event({
            type: "response.output_item.added",
            output_index: 1,
            item: call("fc2", "lookup"),
          }) +
          event({
            type: "response.function_call_arguments.done",
            output_index: 1,
            item_id: "fc2",
            arguments: '{"q":2}',
          })
        : "") +
      event({ type: "response.completed", response: { id: "r", status: "completed", output: [] } });
    const body = await json(frames, "responses");
    assert.deepEqual(
      body.output.map((item) => item.id),
      output.map((item) => item.id),
      `${shape}: a snapshot entry that states no index was told from the frame naming its place`,
    );
    assert.deepEqual(
      body.output.map((item) => item.arguments),
      output.map((_, at) => `{"q":${at + 1}}`),
      `${shape}: the frames did not update the item the snapshot placed`,
    );
  }
});

test("Anthropic refuses a block snapshot that is not a block, instead of storing it", async () => {
  // A start whose content_block is null, a string, or not there at all is a
  // partial view of the block the deltas are filling in, and `carries` weighs
  // it as nothing — the same view a repeated empty start is. Stored as it
  // stood it answered 200 with a null among the content, and a string threw on
  // the first delta that read a field of it. Nothing to take hold of opens
  // nothing; a delta with no block above it is refused as it always was.
  const start = event(
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [] } },
    "message_start",
  );
  const stop = event({ type: "message_stop" }, "message_stop");
  for (const [shape, frame] of [
    ["null", { type: "content_block_start", index: 0, content_block: null }],
    ["a string", { type: "content_block_start", index: 0, content_block: "text" }],
    ["nothing at all", { type: "content_block_start", index: 0 }],
  ]) {
    const body = await json(
      start + event(frame, "content_block_start") + stop,
      "anthropic",
    );
    assert.deepEqual(body.content, [], `${shape}: a block snapshot that is not a block was stored`);
  }
  // A null beside a sound block does not take the sound one's place, or add
  // an entry of its own ahead of it.
  const beside = await json(
    start +
      event(
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "kept" } },
        "content_block_start",
      ) +
      event({ type: "content_block_start", index: 0, content_block: null }, "content_block_start") +
      stop,
    "anthropic",
  );
  assert.deepEqual(beside.content, [{ type: "text", text: "kept" }]);
  // What the deltas of an unusable start carry cannot be placed either, and
  // that is the answer a delta with no block has always had.
  const text =
    start +
    event({ type: "content_block_start", index: 0, content_block: null }, "content_block_start") +
    event(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      "content_block_delta",
    ) +
    stop;
  await failure(text, "anthropic", /without a content block/);
});

test("Anthropic takes a message_start's content only when it is a list of blocks", async () => {
  // `content` is the one key of a message_start that apply fills in itself,
  // and spreading the message onto the body let any value of it answer in the
  // blocks' place: a string threw where the blocks are read back, and an
  // object answered 200 with something that is not a list of blocks. A value
  // that is not a list says nothing about the reply, so the blocks the stream
  // accumulated stand.
  for (const [shape, content] of [
    ["a string", "nope"],
    ["a number", 7],
    ["an object", { type: "text", text: "x" }],
  ]) {
    const body = await json(
      event(
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", content } },
        "message_start",
      ) +
        event(
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "kept" } },
          "content_block_start",
        ) +
        event({ type: "message_stop" }, "message_stop"),
      "anthropic",
    );
    assert.deepEqual(
      body.content,
      [{ type: "text", text: "kept" }],
      `${shape}: the message_start's content replaced the blocks the stream filled in`,
    );
  }
});

test("Anthropic does not read a delta type off the prototype chain", async () => {
  // The table of delta types was an object literal read as `table[delta.type]`,
  // so a type of "toString", "constructor" or "valueOf" reached the member the
  // prototype chain holds there and the delta wrote the block a key of that
  // name — a key the delta never named, holding a function that
  // JSON.stringify then dropped. The block stands as it was, and the reply
  // says nothing about a type it does not know.
  const start = event(
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [] } },
    "message_start",
  );
  const stop = event({ type: "message_stop" }, "message_stop");
  for (const type of ["toString", "constructor", "valueOf"]) {
    const response = await collapseResponse(
      sse(
        start +
          event(
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "kept" } },
            "content_block_start",
          ) +
          event(
            { type: "content_block_delta", index: 0, delta: { type, text: "junk" } },
            "content_block_delta",
          ) +
          stop,
      ),
      "anthropic",
    );
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.deepEqual(
      JSON.parse(raw).content,
      [{ type: "text", text: "kept" }],
      `${type}: the block took a key its delta never named`,
    );
    // On the bytes as well: the key the prototype chain would have named is
    // not something this reply carries at all.
    assert.doesNotMatch(raw, /toString|constructor|valueOf/);
  }
  // A type the table does know still reaches its block.
  const known = await json(
    start +
      event(
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        "content_block_start",
      ) +
      event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } }, "content_block_delta") +
      event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }, "content_block_delta") +
      stop,
    "anthropic",
  );
  assert.equal(known.content[0].thinking, "想");
  assert.equal(known.content[0].signature, "sig");
});

test("Anthropic takes only the fields a message_delta may carry", async () => {
  // Object.assign copies with [[Set]] semantics, and JSON.parse makes
  // "__proto__" an own property: an upstream's delta re-parented the message
  // being accumulated, and any other key in it overwrote the message's own
  // id, role, type or content. The delta is written as bytes here because an
  // object literal's "__proto__" sets a prototype rather than a key.
  const text =
    event(
      {
        type: "message_start",
        message: { id: "m", type: "message", role: "assistant", content: [] },
      },
      "message_start",
    ) +
    event(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "kept" } },
      "content_block_start",
    ) +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"__proto__":{"polluted":true},"id":"replaced","role":"user","content":[{"type":"text","text":"replaced"}],"stop_reason":"end_turn","stop_sequence":"END"},"usage":{"output_tokens":3}}\n\n' +
    event({ type: "message_stop" }, "message_stop");
  const response = await collapseResponse(sse(text), "anthropic");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  // Read on the bytes, not on the parsed body. JSON.parse wires every object
  // to Object.prototype and makes "__proto__" an own property, so the
  // re-parenting this guards against reads back from a parsed body exactly
  // like a sound one: an assertion on the prototype could only fail for an
  // absurd body, never for the regression.
  const raw = await response.text();
  assert.doesNotMatch(raw, /__proto__|polluted/);
  const body = JSON.parse(raw);
  assert.equal(body.id, "m");
  assert.equal(body.role, "assistant");
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "kept");
  // What a message_delta is defined to carry is taken, and reaches the body.
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.stop_sequence, "END");
  assert.equal(body.usage.output_tokens, 3);
});

test("Anthropic keeps what a repeated empty content_block_start would discard", async () => {
  // A gateway may re-emit a block's opening frame beside the deltas it
  // opened. A text block opens with text: "", so an unconditional start
  // replaced the block the deltas had been filling and the reply lost it
  // while still answering 200 — the shape message_start's blocks already
  // refuse, for the same reason.
  const body = await json(
    event(
      {
        type: "message_start",
        message: { id: "m", type: "message", role: "assistant", content: [] },
      },
      "message_start",
    ) +
      event(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        "content_block_start",
      ) +
      event(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "kept" } },
        "content_block_delta",
      ) +
      event(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        "content_block_start",
      ) +
      event(
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        "content_block_start",
      ) +
      event(
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "thinking_delta", thinking: "想" },
        },
        "content_block_delta",
      ) +
      event(
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "signature_delta", signature: "sig" },
        },
        "content_block_delta",
      ) +
      event(
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        "content_block_start",
      ) +
      event(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " and more" } },
        "content_block_delta",
      ) +
      event({ type: "message_stop" }, "message_stop"),
    "anthropic",
  );
  assert.equal(body.content[0].text, "kept and more");
  assert.equal(body.content[1].thinking, "想");
  assert.equal(body.content[1].signature, "sig");
});

test("Anthropic preserves initial content, thinking, signatures, tool JSON, usage and stop reason", async () => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "zen",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 4 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "先", signature: "sig" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "nature" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "你" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "好🙂" } },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "tool", name: "lookup", input: {} },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"q":' },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '"中文"}' },
    },
    { type: "content_block_stop", index: 2 },
    {
      type: "content_block_start",
      index: 3,
      content_block: { type: "redacted_thinking", data: "opaque" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: "END" },
      usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
  ];
  const body = await json(events.map((value) => event(value, value.type)).join(""), "anthropic", {
    chunkSize: 1,
  });
  assert.equal(body.id, "msg-1");
  assert.deepEqual(body.content, [
    { type: "thinking", thinking: "先想", signature: "signature" },
    { type: "text", text: "你好🙂" },
    { type: "tool_use", id: "tool", name: "lookup", input: { q: "中文" } },
    { type: "redacted_thinking", data: "opaque" },
  ]);
  assert.deepEqual(body.usage, { input_tokens: 11, output_tokens: 9, cache_read_input_tokens: 4 });
  assert.equal(body.stop_reason, "tool_use");
  assert.equal(body.stop_sequence, "END");
});

test("Anthropic retains complete tool input when there are no JSON deltas", async () => {
  const body = await json(
    event({
      type: "message_start",
      message: { id: "m", content: [{ type: "text", text: "initial" }] },
    }) +
      event({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t", name: "f", input: { a: 1 } },
      }) +
      event({ type: "message_stop" }),
    "anthropic",
  );
  assert.deepEqual(body.content[1].input, { a: 1 });
  assert.equal(body.content[0].text, "initial");
});

test("Anthropic reads an empty argument delta set as no arguments at all", async () => {
  const body = await json(
    event({ type: "message_start", message: { id: "m", content: [] } }) +
      event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t", name: "f", input: { a: 1 } },
      }) +
      event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta" } }) +
      event({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "u", name: "g", input: {} },
      }) +
      event({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "  " },
      }) +
      event({ type: "message_stop" }),
    "anthropic",
  );
  // No bytes to parse is not malformed JSON, and not a reason to drop the
  // input the block opened with.
  assert.deepEqual(body.content[0].input, { a: 1 });
  assert.deepEqual(body.content[1].input, {});
});

for (const protocol of ["chat", "responses", "anthropic"]) {
  test(`${protocol}: HTTP failures and non-SSE JSON return the same unread Response`, async () => {
    const httpError = sse(event({ error: { message: "quota" } }), { status: 429 });
    assert.equal(await collapseResponse(httpError, protocol), httpError);
    assert.equal(httpError.bodyUsed, false);
    const plain = new Response('{"unchanged": true}', {
      headers: { "content-type": "application/json", "content-length": "19" },
    });
    assert.equal(await collapseResponse(plain, protocol), plain);
    assert.equal(plain.bodyUsed, false);
    assert.equal(await plain.text(), '{"unchanged": true}');
  });

  test(`${protocol}: empty and truncated SSE are 502 errors`, async () => {
    await failure("", protocol, /complet|end|terminat/i);
    await failure(
      event({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "stop" }] }),
      protocol,
    );
    if (protocol !== "chat") await failure(event("[DONE]"), protocol);
  });

  test(`${protocol}: error events and JSON errors are 502 errors`, async () => {
    await failure(event({ error: { message: "quota exhausted" } }), protocol, /quota exhausted/);
    await failure(event({ message: "upstream exploded" }, "error"), protocol, /upstream exploded/);
    await failure(event("plain failure", "error"), protocol, /plain failure/);
    await failure(
      event({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
      protocol,
      /busy/,
    );
    await failure(event("{invalid json"), protocol, /JSON|invalid|malformed/i);
  });

  test(`${protocol}: open SSE errors cancel promptly and return 502`, async () => {
    for (const text of [
      event({ message: "upstream exploded" }, "error"),
      event("upstream exploded", "error"),
      event({ error: { message: "upstream exploded" } }),
      event({ type: "error", error: { message: "upstream exploded" } }),
    ]) {
      const response = await collapseOpenStream(text, protocol);
      assert.equal(response.status, 502);
      assertProtocolError(await response.json(), protocol, "upstream exploded");
    }
  });

  test(`${protocol}: open SSE errors propagate cancellation failures`, async () => {
    for (const asynchronous of [false, true]) {
      const cause = new DOMException("cancel failed", "AbortError");
      let cancelled = false;
      await assert.rejects(
        collapseOpenStream(event("upstream exploded", "error"), protocol, () => {
          cancelled = true;
          if (asynchronous) return Promise.reject(cause);
          throw cause;
        }),
        (error) => error === cause,
      );
      assert.equal(cancelled, true);
    }
  });

  test(`${protocol}: body read errors and aborts reject with the original exception`, async () => {
    for (const cause of [new Error("read failed"), new DOMException("cancelled", "AbortError")]) {
      let pulled = false;
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            if (pulled) return controller.error(cause);
            pulled = true;
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      await assert.rejects(collapseResponse(response, protocol), (error) => error === cause);
    }
  });
}

test("protocol-specific finish reasons without terminal events remain truncated", async () => {
  await failure(
    event({ type: "response.created", response: { id: "r", output: [] } }) +
      event({ type: "response.output_text.delta", output_index: 0, delta: "partial" }),
    "responses",
    /completion/,
  );
  await failure(
    event({ type: "message_start", message: { id: "m", content: [] } }) +
      event({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    "anthropic",
    /completion/,
  );
  await failure("data: [DONE]\n", "chat", /completion/);
});

test("a [DONE] marker ends a non-chat stream only where it already ended", async () => {
  // [DONE] is how a Chat stream ends, and a Responses or Messages stream may
  // be given one after it has reported its own terminal event (a gateway in
  // front of the upstream appends it). Before that event it claims an ending
  // the protocol never reported, and the guard refuses the same bytes with
  // the same words — its half of this test is in tool-response.test.mjs.
  const terminal = event(
    { type: "response.completed", response: { id: "r1", status: "completed", output: [] } },
    "response.completed",
  );
  assert.equal((await json(terminal + event("[DONE]"), "responses")).id, "r1");
  for (const protocol of ["responses", "anthropic"]) {
    await failure(event("[DONE]"), protocol, /Unexpected upstream completion marker/);
  }
});

test("upstream errors after terminal events are not successful responses", async () => {
  for (const [protocol, terminal] of [
    ["chat", "[DONE]"],
    ["responses", { type: "response.completed", response: { output: [] } }],
    ["anthropic", { type: "message_stop" }],
  ]) {
    await failure(
      event(terminal) + event({ error: { message: "late error" } }),
      protocol,
      /late error/,
    );
  }
});

// The other half of this contract is in tool-response.test.mjs, where the
// same bytes are streamed to a client that reads a stream: the two paths
// answered the same upstream differently — this one dropped an event after
// the terminal marker, and that one forwarded it. An event after the marker
// is not part of the reply, in either path; a failure after it still is.
// Both halves of the same contract: what came before the marker is the reply
// and is still there, and what came after it is not. The absence of the tail
// alone was satisfied by a reply that carried nothing at all.
test("an event after the terminal marker is not folded into the reply, and what came before it is", async () => {
  const tails = {
    chat: [
      { choices: [{ index: 0, delta: { content: "hi" } }] },
      "[DONE]",
      { choices: [{ index: 0, delta: { content: "TAIL" } }] },
    ],
    responses: [
      { type: "response.output_item.added", output_index: 0, item: { id: "m", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hi" },
      // A terminal that carries no output of its own: what the stream
      // accumulated before it is the reply, and the marker is the frame after
      // which nothing more is folded in.
      { type: "response.completed", response: { status: "completed" } },
      { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "TAIL" },
    ],
    anthropic: [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "message_stop" },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "TAIL" } },
    ],
  };
  // Where each protocol answers the text its own frames delivered, read from
  // the field the protocol keeps it in. The sentinel alone (`/hi/`) proved only
  // that the two letters appeared somewhere in the body: a Messages block typed
  // "thinking" carries them, and so does any other field a rewrite might put
  // the text in while the reply still lost the text the marker ended.
  const keptText = {
    chat: (body) => body.choices[0].message.content,
    responses: (body) => body.output[0].content[0].text,
    anthropic: (body) => body.content[0].text,
  };
  for (const [protocol, frames] of Object.entries(tails)) {
    const body = await json(frames.map((value) => event(value)).join(""), protocol);
    assert.equal(
      keptText[protocol](body),
      "hi",
      `${protocol}: the reply the terminal marker ended was discarded`,
    );
    // Once, and in that field: the word is what proves the frames before the
    // marker delivered the text the reply answers with.
    assert.equal(
      (JSON.stringify(body).match(/hi/g) ?? []).length,
      1,
      `${protocol}: the text the terminal marker ended is not the reply's own text`,
    );
    assert.doesNotMatch(
      JSON.stringify(body),
      /TAIL/,
      `${protocol}: an event after the terminal marker reached the reply`,
    );
  }
  // A frame after the marker that is not JSON at all is a failure, not an
  // event to ignore — the same answer the streaming path gives it.
  for (const [protocol, terminal] of [
    ["chat", event("[DONE]")],
    ["responses", event({ type: "response.completed", response: { output: [] } })],
    ["anthropic", event({ type: "message_stop" })],
  ])
    await failure(terminal + "data: {broken\n\n", protocol, /JSON/);
});

test("buffer-limit cancellation failures propagate instead of becoming JSON", async () => {
  const cause = new DOMException("cancel failed", "AbortError");
  const chunk = new Uint8Array(1024 * 1024);
  const { response } = endlessSse(chunk, {
    cancel() {
      throw cause;
    },
  });
  await assert.rejects(collapseResponse(response, "chat"), (error) => error === cause);
});

test("Responses open SSE failed events cancel promptly and return 502", async () => {
  const response = await collapseOpenStream(
    event({
      type: "response.failed",
      response: { status: "failed", error: { message: "model failed" } },
    }),
    "responses",
  );
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.message, "model failed");
});

test("Responses failed is an error even when a response object is present", async () => {
  await failure(
    event({
      type: "response.failed",
      response: { id: "r", status: "failed", error: { message: "model failed" }, output: [] },
    }),
    "responses",
    /model failed/,
  );
});

test("Anthropic rejects malformed accumulated tool JSON", async () => {
  await failure(
    event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", input: {} },
    }) +
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"unfinished":' },
      }) +
      event({ type: "message_stop" }),
    "anthropic",
    /JSON|argument|input/i,
  );
});

test("success and error JSON remove stale entity headers and preserve retry metadata", async () => {
  for (const text of [event("[DONE]"), event({ error: { message: "fail" } })]) {
    const response = await collapseResponse(
      sse(text, {
        headers: {
          "content-length": "999",
          "content-encoding": "gzip",
          "transfer-encoding": "chunked",
          "content-md5": "md5",
          etag: 'W/"stream"',
          "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
          "retry-after": "12",
          "x-request-id": "req-1",
        },
      }),
      "chat",
    );
    assert.equal(response.headers.get("content-type"), "application/json");
    // What described the stream's own bytes cannot describe the JSON body.
    for (const name of [
      "content-length",
      "content-encoding",
      "transfer-encoding",
      "content-md5",
      "etag",
      "last-modified",
    ])
      assert.equal(response.headers.get(name), null, name);
    assert.equal(response.headers.get("retry-after"), "12");
    assert.equal(response.headers.get("x-request-id"), "req-1");
  }
});

// The limit is exact, and it was not pinned: the fixture that stood for
// "past the limit" used MAX_BYTES + 1, which a limit off by N refuses as
// well, so an off-by-N in the number or in the comparison was invisible to
// the whole suite. Exactly the limit is a reply, and one byte past it is
// refused with the number it names. The bytes are one 64 KiB comment line
// handed out again and again — comments reach no part of the reply — so
// nothing here allocates 32 MiB to be counted.
test("the buffer limit is exact: exactly 32 MiB is read, and one byte more is not", { timeout: 60_000 }, async () => {
  const prefix = event({ choices: [{ index: 0, delta: { content: "hi" } }] });
  const suffix = event("[DONE]");
  const block = encoder.encode(`:${"x".repeat(65536 - 2)}\n`);
  function exactStream(total) {
    const head = encoder.encode(prefix);
    const tail = encoder.encode(suffix);
    const parts = [head];
    let left = total - head.byteLength - tail.byteLength;
    while (left >= block.byteLength) {
      parts.push(block);
      left -= block.byteLength;
    }
    // Whatever is left is one more comment line of exactly that size: the
    // padding is part of the SSE's own framing, and its length is what puts
    // the stream on the byte the limit names.
    if (left === 1) parts.push(encoder.encode("\n"));
    else if (left === 2) parts.push(encoder.encode(":\n"));
    else if (left > 2) parts.push(encoder.encode(`:${"x".repeat(left - 2)}\n`));
    parts.push(tail);
    let at = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (at === parts.length) return controller.close();
          controller.enqueue(parts[at++]);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }

  const accepted = await collapseResponse(exactStream(MAX_BYTES), "chat");
  assert.equal(accepted.status, 200, "a reply of exactly the limit is a reply");
  const body = await accepted.json();
  assert.equal(body.choices[0].message.content, "hi");

  const refused = await collapseResponse(exactStream(MAX_BYTES + 1), "chat");
  assert.equal(refused.status, 502, "one byte past the limit is refused");
  await assertProtocolError(
    await refused.json(),
    "chat",
    new RegExp(`${MAX_BYTES / (1024 * 1024)} MiB`),
  );
});

test("bounded buffering rejects oversized unterminated events and cancels the source", async () => {
  let cancelled = false;
  const chunk = encoder.encode("x".repeat(1024 * 1024));
  const source = endlessSse(chunk, {
    cancel() {
      cancelled = true;
    },
  });
  const result = await collapseResponse(source.response, "chat");
  assert.equal(result.status, 502);
  assert.match((await result.json()).error.message, /limit|large|buffer/i);
  // One chunk past the limit ends the read, and the stream may have handed
  // out a chunk or two ahead of the reader.
  assert.ok(
    source.pulls() <= MAX_BYTES / chunk.length + 3,
    `pulled ${source.pulls()} chunks before the buffer limit`,
  );
  assert.equal(cancelled, true);
});

test("bounded buffering also counts many small completed events", async () => {
  // A different payload every pull, at a constant size: what the limit counts
  // is the events, not the same bytes arriving over and over.
  const content = 65536;
  const chunk = (pull) =>
    encoder.encode(
      event({ choices: [{ index: 0, delta: { content: String(pull).padEnd(content, "x") } }] }),
    );
  const chunkBytes = chunk(0).byteLength;
  let cancelled = false;
  const source = endlessSse(chunk, {
    cancel() {
      cancelled = true;
    },
  });
  const result = await collapseResponse(source.response, "chat");
  assert.equal(result.status, 502);
  // Completed events count towards the limit too, so an upstream that never
  // stops sending them is cut off rather than read forever.
  assert.ok(
    source.pulls() <= Math.ceil(MAX_BYTES / chunkBytes) + 3,
    `pulled ${source.pulls()} chunks before the buffer limit`,
  );
  assert.equal(cancelled, true);
});

test("read failures after a completion marker are not swallowed", async () => {
  const cause = new Error("late transport failure");
  let sent = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (sent) return controller.error(cause);
        sent = true;
        controller.enqueue(encoder.encode(event("[DONE]")));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  await assert.rejects(collapseResponse(response, "chat"), (error) => error === cause);
});

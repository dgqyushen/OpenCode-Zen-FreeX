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
                { index: 1, function: { arguments: "2}" } },
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

test("Anthropic takes only the fields a message_delta may carry", async () => {
  // Object.assign copies with [[Set]] semantics, and JSON.parse makes
  // "__proto__" an own property: an upstream's delta re-parented the message
  // being accumulated, and any other key in it overwrote the message's own
  // id, role, type or content. The delta is written as bytes here because an
  // object literal's "__proto__" sets a prototype rather than a key.
  const body = await json(
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
      event({ type: "message_stop" }, "message_stop"),
    "anthropic",
  );
  assert.equal(Object.getPrototypeOf(body), Object.prototype);
  assert.equal(body.id, "m");
  assert.equal(body.role, "assistant");
  assert.equal(body.type, "message");
  assert.equal(body.content[0].text, "kept");
  // What a message_delta is defined to carry is taken, and reaches the body.
  assert.equal(body.stop_reason, "end_turn");
  assert.equal(body.stop_sequence, "END");
  assert.equal(body.usage.output_tokens, 3);
  assert.doesNotMatch(JSON.stringify(body), /__proto__|polluted/);
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
  const chunk = encoder.encode(
    event({ choices: [{ index: 0, delta: { content: "x".repeat(65536) } }] }),
  );
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
    source.pulls() <= Math.ceil(MAX_BYTES / chunk.byteLength) + 3,
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

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { PROFILES, generationOf } from "./core-tools.mjs";
import { protocols, declaredTools, toolReply } from "./tool-fixtures.mjs";
import { requestFor } from "./tools-smoke.mjs";

const subject = import("./index.mjs").then((module) => ({
  default: { server: module.ZenFreePlugin },
}));

async function fixture(t, input = {}) {
  const state = { calls: [], status: 200, modelsStatus: 200, docsStatus: 200, catalogStatus: 200 };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    state.calls.push({ url: req.url, headers: req.headers, body: text && JSON.parse(text) });
    if (state.discoveryHang) {
      state.onDiscovery?.();
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(state.modelsStatus, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: (state.ids ?? ["chat-free", "responses-free", "messages-free", "paid"]).map(
            (id) => ({
              id,
            }),
          ),
        }),
      );
    } else if (req.url === "/catalog") {
      res.writeHead(state.catalogStatus, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          opencode: {
            npm: "@ai-sdk/openai-compatible",
            models: {
              ...(state.omitChat
                ? {}
                : { "chat-free": { name: "Chat Free", limit: { context: 200000, output: 8192 } } }),
              "responses-free": { provider: { npm: "@ai-sdk/openai" } },
              "messages-free": { provider: { npm: "@ai-sdk/anthropic" } },
              paid: { cost: { input: 3, output: 10 } },
              "late-free": {},
            },
          },
        }),
      );
    } else if (req.url === "/docs") {
      res.writeHead(state.docsStatus);
      res.end(
        state.docsText ??
          `| Model | chat-free | \`https://opencode.ai/zen/v1/${state.chatProtocol ?? "chat/completions"}\` | sdk |`,
      );
    } else if (state.body !== undefined) {
      res.writeHead(state.status ?? 403, { "content-type": "application/json" });
      res.end(state.body);
    } else if (state.reply) {
      res.writeHead(200, { "content-type": state.contentType ?? "text/event-stream" });
      res.end(state.reply);
    } else if (state.hang) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": heartbeat\n\n");
    } else if (state.status !== 200) {
      res.writeHead(state.status, { "content-type": "application/json", "retry-after": "30" });
      res.end('{"error":{"message":"limited","type":"rate_limit_error"}}');
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"id":"chat-1","model":"chat-free","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const module = await subject;
  assert.equal(typeof module.default?.server, "function", "plugin hooks must be implemented");
  const plugin = await module.default.server(input, {
    baseURL: `${origin}/v1`,
    catalogURL: `${origin}/catalog`,
    docsURL: `${origin}/docs`,
  });
  return { plugin, state, origin };
}

const publicAuth = async () => ({ type: "api", key: "public" });

for (const { protocol, path, model } of protocols) {
  for (const stream of [true, false]) {
    for (const upstreamSSE of [true, false]) {
      test(`${protocol}: guards tool names with client stream=${stream}, upstream SSE=${upstreamSSE}`, async (t) => {
        const { plugin, state, origin } = await fixture(t);
        await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
        const loader = await plugin.auth.loader(publicAuth);
        const tools = declaredTools(protocol);
        state.contentType = upstreamSSE ? "text/event-stream" : "application/json";
        const send = () =>
          loader.fetch(`${origin}/v1/${path}`, {
            method: "POST",
            body: JSON.stringify({ model, stream, tools }),
          });
        for (const [upstream, expected] of [
          ["bash", "Bash"],
          ["read", "Read"],
          ["Bash", "Bash"],
        ]) {
          state.reply = toolReply(protocol, upstream, upstreamSSE);
          const response = await send();
          assert.equal(response.status, 200);
          const text = await response.text();
          assert.match(text, new RegExp(`"name"\\s*:\\s*"${expected}"`));
          assert.doesNotMatch(text, /"name"\s*:\s*"(?:bash|read)"/);
        }
        const outbound = state.calls.at(-1).body.tools;
        assert.deepEqual(outbound.slice(0, tools.length), tools);
        for (const raw of outbound.slice(tools.length)) {
          const tool = protocol === "chat" ? raw.function : raw;
          // Zen reads the body as well as the headers: a tool it knows the
          // name of has to carry OpenCode's own description, so the gap is
          // filled with that rather than with a refusal (#130).
          const known = PROFILES["1.x"].tools[tool.name];
          assert.ok(known, `${tool.name} is not one of the tools Zen reads`);
          assert.ok(
            known.description.startsWith(tool.description.slice(0, 200)),
            `${tool.name} does not start as OpenCode describes it`,
          );
          assert.ok(Object.keys((tool.parameters ?? tool.input_schema).properties).length > 0);
        }
        // A call of a tool the agent doesn't have is left out, said in
        // the reply's text, and the turn ends as a stop rather than
        // failing (#76).
        state.reply = toolReply(protocol, "edit", upstreamSSE);
        const left = await send();
        assert.equal(left.status, 200);
        const text = await left.text();
        assert.doesNotMatch(text, /"name"\s*:\s*"edit"/);
        assert.doesNotMatch(text, /"error"|"tool_calls"|"tool_use"|"function_call"/);
        assert.match(text, /a tool this agent doesn't have: \\"edit\\"/);
      });
    }
  }
}

test("keeps declared tools isolated between requests using the same loader", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.reply = toolReply("chat", "bash");
  const send = (tools) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", stream: false, tools }),
    });
  assert.equal((await send(declaredTools("chat"))).status, 200);
  const blocked = await send([]);
  assert.equal(blocked.status, 200);
  const text = await blocked.text();
  assert.doesNotMatch(text, /"name"\s*:\s*"Bash"/);
  assert.match(text, /a tool this agent doesn't have: \\"bash\\"/);
});

for (const [input, supplied, expected] of [
  [{}, undefined, "global"],
  [{ project: { id: "magpie" } }, undefined, "global"],
  [{ project: { id: "abc123", vcs: "git" } }, undefined, "abc123"],
  [{}, "client-project", "client-project"],
]) {
  test(`uses OpenCode project identity ${expected}`, async (t) => {
    const { plugin, state, origin } = await fixture(t, input);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: supplied ? { "x-opencode-project": supplied } : {},
      body: JSON.stringify({ model: "chat-free", stream: true }),
    });
    await response.text();
    assert.equal(state.calls.at(-1).headers["x-opencode-project"], expected);
    assert.equal(
      state.calls.at(-1).headers["user-agent"],
      "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
    );
  });
}

// The headers OpenCode 1.19.0's release binary sends to opencode.ai/zen/v1,
// captured on each protocol: these and no others, whatever the caller sent.
for (const [path, model, utils, key] of [
  ["chat/completions", "chat-free", "4.0.23", ["authorization"]],
  ["responses", "responses-free", "4.0.40", ["authorization"]],
  ["messages", "messages-free", "4.0.46", ["anthropic-version", "x-api-key"]],
]) {
  test(`${path}: sends OpenCode's own headers and none of the caller's`, async (t) => {
    const { plugin, state, origin } = await fixture(t);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/${path}`, {
      method: "POST",
      headers: {
        "user-agent": "claude-cli/2.1.0",
        "x-stainless-lang": "js",
        "x-session-affinity": "header-parity-conversation",
        "x-magpie-work-dir": "/tmp/x",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ model, stream: true }),
    });
    await response.text();
    const sent = state.calls.at(-1).headers;
    assert.equal(sent["user-agent"], `opencode/1.19.0 ai-sdk/provider-utils/${utils} runtime/bun/1.3.14`);
    assert.equal(sent.accept, "*/*");
    const own = Object.keys(sent).filter(
      (name) => !["host", "connection", "content-length", "accept-encoding"].includes(name),
    );
    assert.deepEqual(
      own.sort(),
      [
        "accept",
        "content-type",
        "user-agent",
        "x-opencode-client",
        "x-opencode-project",
        "x-opencode-session",
        "x-opencode-session-id",
        ...key,
      ].sort(),
    );
    assert.equal(sent["x-opencode-session-id"], sent["x-opencode-session"]);
    // x-opencode-request, x-session-affinity and x-session-id are in OpenCode's
    // own header set upstream, and none of them is needed: measured 2026-10-15,
    // each answers on its own and x-opencode-request with x-session-affinity is
    // refused. So the set above stays a strict subset of what has been seen
    // accepted (#4842 of decolua/9router).
    assert.equal(sent["x-opencode-request"], undefined);
  });
}

// The gate is what says whether this plugin still works, so it has to ask with
// the request the plugin makes. It used to build its own copy of the headers,
// and that copy had already drifted - it was missing `accept` - with nothing
// failing on it. Both generations are held here against what the plugin was
// observed to send, so the gate cannot go back to asking with a shape of its own.
for (const [generation, profile] of Object.entries(PROFILES)) {
  test(`the gate asks Zen with the ${generation} request this plugin sends`, async (t) => {
    const { plugin, state, origin } = await fixture(t);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const names = [...profile.required];
    const tools = names.map((name) => ({ type: "function", function: profile.tools[name] }));
    const response = await loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "user-agent": "claude-cli/2.1.0" },
      body: JSON.stringify({ model: "chat-free", stream: true, tools }),
    });
    await response.text();

    const sent = state.calls.at(-1).headers;
    const wire = Object.keys(sent).filter(
      (name) => !["host", "connection", "content-length", "accept-encoding"].includes(name),
    );
    const gate = requestFor(generation, profile, names).headers;
    assert.deepEqual([...gate.keys()].sort(), wire.sort());
    assert.equal(gate.get("user-agent"), sent["user-agent"]);
    // The tools the floor is asked with have to name the generation they came
    // from, or the plugin would present itself as the other one.
    assert.equal(generationOf(tools), generation);
  });
}

test("aborts discovery immediately when the inference caller cancels", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const loader = await plugin.auth.loader(publicAuth);
  const controller = new AbortController();
  state.discoveryHang = true;
  const started = new Promise((resolve) => {
    state.onDiscovery = resolve;
  });
  const request = loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({ model: "chat-free", stream: true }),
  });
  const rejected = assert.rejects(request, /abort/i);
  await started;
  controller.abort();
  let timer;
  try {
    await Promise.race([
      rejected,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("discovery ignored caller cancellation")), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
});

test("partial discovery never restores a model explicitly changed to SystemOne", async (t) => {
  const { plugin, state } = await fixture(t);
  state.omitChat = true;
  const before = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.ok(before["chat-free"]);
  state.catalogStatus = 503;
  state.chatProtocol = "systemone";
  const after = await plugin.provider.models({ models: before }, { auth: await publicAuth() });
  assert.equal(after["chat-free"], undefined);
});

test("registers without overwriting user config and enables public access without a secret", async (t) => {
  const { plugin } = await fixture(t);
  const cfg = {};
  await plugin.config(cfg);
  assert.equal(cfg.provider["opencode-zen-free"].name, "OpenCode Zen Free");
  cfg.provider["opencode-zen-free"].name = "My name";
  await plugin.config(cfg);
  assert.equal(cfg.provider["opencode-zen-free"].name, "My name");
  assert.deepEqual(await plugin.auth.methods[0].authorize(), { type: "success", key: "public" });
  assert.deepEqual(await plugin.auth.loader(async () => undefined), {});
  await assert.rejects(
    plugin.auth.loader(async () => ({ type: "api", key: "paid-secret" })),
    /public/i,
  );
  assert.deepEqual((await plugin.auth.usage(publicAuth)).windows, []);
});

test("discovers protocols and free models, caches success, marks failed refresh as fallback", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  const provider = { models: {} };
  const models = await plugin.provider.models(provider, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(models).sort(), ["chat-free", "messages-free", "responses-free"]);
  assert.equal(models["responses-free"].api.npm, "@ai-sdk/openai");
  assert.equal(models["messages-free"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models["chat-free"].api.url, `${origin}/v1`);
  state.modelsStatus = 503;
  const fallback = await plugin.provider.models({ models }, { auth: await publicAuth() });
  assert.equal(fallback[Symbol.for("magpie.fellBack")], true);
  assert.deepEqual(Object.keys(fallback), Object.keys(models));
});

test("partial catalog failure retains previously verified models rather than dropping them", async (t) => {
  const { plugin, state } = await fixture(t);
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  state.catalogStatus = 503;
  state.docsStatus = 503;
  const partial = await plugin.provider.models({ models }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(partial).sort(), ["chat-free", "messages-free", "responses-free"]);
  // and it is not said as fallen back: Zen's own list was read, and a host that
  // cannot reach the catalogue or the docs must still see what that list says
  assert.equal(partial[Symbol.for("magpie.fellBack")], undefined);
});

// The reporter of yetone/magpie#2305 saw only the three models the plugin
// knew offline: the catalog and the docs out of reach dropped every listed
// free model they didn't name. The coverage the other tests here cannot see,
// because theirs all name synthetic ids the fixture catalog supplies — these
// are the real ones only bootstrapProvider covers. A listed free model now
// takes its endpoint from the snapshot of OpenCode's console docs; Jev is a
// SystemOne decision model and stays out, and a paid one is not offered.
test("listed free models are offered when the catalog and the docs can't be read", async (t) => {
  const { plugin, state } = await fixture(t);
  state.catalogStatus = 503;
  state.docsStatus = 404;
  state.ids = ["big-pickle", "step-5-preview-free", "cat-jam-free", "jev-1.13-free", "paid"];
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(models).sort(), ["big-pickle", "cat-jam-free", "step-5-preview-free"]);
  assert.equal(models["step-5-preview-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["step-5-preview-free"].name, "Step 5 Preview Free");
  assert.equal(models["step-5-preview-free"].limit.context, 1000000);
  // offered, not said as fallen back: the listing was read, so a host that can't
  // reach the catalogue or the docs still gets every model Zen lists (#2385)
  assert.equal(models[Symbol.for("magpie.fellBack")], undefined);
});

// The floor is not a rival to the docs: what they name wins, and only what
// they no longer name falls back to the snapshot. The snapshot calls Muse
// Spark a Responses model; the docs calling it Anthropic is what is sent.
test("the console docs' table wins over the bootstrap snapshot", async (t) => {
  const { plugin, state } = await fixture(t);
  state.ids = ["cat-jam-free", "muse-spark-1.3-contributor-free"];
  state.docsText =
    "| Muse Spark 1.3 Contributor Free | muse-spark-1.3-contributor-free | `https://opencode.ai/inference/v1/messages` | `@ai-sdk/anthropic` |";
  const models = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.equal(models["muse-spark-1.3-contributor-free"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models["cat-jam-free"].api.npm, "@ai-sdk/openai-compatible");
});

test("forces upstream streaming, preserves existing tools and returns the SSE body unbuffered", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const bash = {
    type: "function",
    function: {
      name: "bash",
      description: "real bash",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  };
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer client-key",
      "x-session-id": "session_123",
      "content-length": "1",
    },
    body: JSON.stringify({
      model: "chat-free",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      tools: [bash],
    }),
  });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(await response.text(), /\[DONE\]/);
  const sent = state.calls.at(-1);
  assert.equal(sent.headers.authorization, "Bearer public");
  assert.match(sent.headers["x-opencode-session"], /^ses_[0-9a-f]{9}ff[0-9a-f][0-9A-Za-z]{14}$/);
  // OpenCode sends neither to its own gateway; a caller's never goes on.
  assert.equal(sent.headers["x-session-affinity"], undefined);
  assert.equal(sent.headers["x-session-id"], undefined);
  assert.equal(sent.headers["x-opencode-session-id"], sent.headers["x-opencode-session"]);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.stream_options.include_usage, true);
  assert.deepEqual(sent.body.tools[0].function.parameters, bash.function.parameters);
  // The wording sent is OpenCode's, whatever the host called its own bash.
  assert.equal(sent.body.tools[0].function.description, PROFILES["1.x"].tools.bash.description);
  assert.deepEqual(
    sent.body.tools.map((tool) => tool.function.name),
    ["bash", "glob", "grep", "read"],
  );
});

test("collapses SSE for a non-streaming client and preserves upstream HTTP errors", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = () =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hello" }] }),
    });
  const response = await send();
  assert.equal((await response.json()).choices[0].message.content, "hello");
  state.status = 429;
  const error = await send();
  assert.equal(error.status, 429);
  assert.equal(error.headers.get("retry-after"), "30");
  assert.equal((await error.json()).error.message, "limited");
});

// Zen accepts a request only when every part of it belongs to one generation of
// OpenCode, and a header belonging to none is enough to lose it. x-session-
// affinity and x-session-id are in OpenCode's own header set upstream but are
// not needed, so the outbound set is pinned by name rather than by comment:
// measured 2026-10-15, either alone answers and the two together are refused
// (#131).
test("sends exactly the headers one generation of OpenCode sends", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
  });
  const sent = state.calls.at(-1).headers;
  // accept-encoding, connection and content-length are the HTTP stack's, not
  // this plugin's, so what is pinned here is the set the plugin chooses.
  const transport = ["accept-encoding", "connection", "content-length"];
  const chosen = Object.keys(sent)
    .filter((name) => !transport.includes(name))
    .sort();
  assert.deepEqual(chosen, [
    "accept",
    "authorization",
    "content-type",
    "host",
    "user-agent",
    "x-opencode-client",
    "x-opencode-project",
    "x-opencode-session",
    "x-opencode-session-id",
  ]);
  // x-opencode-request is not needed either: measured 2026-10-15, it answers on
  // its own and it is the pair x-opencode-request + x-session-affinity that is
  // refused, so the set above has to stay a strict subset of what has been seen
  // accepted (#4842 of decolua/9router).
  assert.equal(sent["x-opencode-request"], undefined);
  // The two that upstream sends and this plugin does not, named here so that
  // adding one is a deliberate act rather than an accident.
  assert.equal(sent["x-session-affinity"], undefined);
  assert.equal(sent["x-session-id"], undefined);
  assert.equal(sent["x-opencode-parent-session-id"], undefined);
});

test("presents the generation the tools say, and a host that names its own", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = (tools, headers) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }], tools }),
    });
  const tool = (name, description) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties: { a: { type: "string" } } } },
  });

  await send();
  assert.match(
    state.calls.at(-1).headers["user-agent"],
    /^opencode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/\S+ runtime\/bun\//,
  );

  // A host declaring 2.x tools is answered as 2.x, without a gap being filled.
  await send([tool("shell", "Execute a shell command and return its output."), tool("read", "Read the contents of a file or directory.")]);
  const two = state.calls.at(-1);
  assert.equal(two.headers["user-agent"], "opencode/latest/2.0.29/cli");
  assert.deepEqual(
    two.body.tools.map((t) => t.function.name),
    ["shell", "read"],
  );

  // A host that is OpenCode itself already says which it is; that is above
  // whatever floor Zen is holding, so it is passed on rather than pinned.
  await send(undefined, { "user-agent": "opencode/stable/1.2.3/desktop" });
  assert.equal(state.calls.at(-1).headers["user-agent"], "opencode/stable/1.2.3/desktop");

  // A host on a development build is not something Zen accepts, so its word is
  // not taken.
  await send(undefined, { "user-agent": "opencode/dev/0.0.0-dev-1/cli" });
  assert.match(state.calls.at(-1).headers["user-agent"], /^opencode\/\d+\.\d+\.\d+ ai-sdk\//);
});

// A host that sent one protocol's tool shape to another's endpoint has still
// declared those tools. Reading the name out of only one shape would fill a
// gap that is not one, and the tool would go out twice (#131).
test("reads a tool's name out of either shape, so nothing is filled twice", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  await loader.fetch(`${origin}/v1/responses`, {
    method: "POST",
    body: JSON.stringify({
      model: "responses-free",
      input: "hi",
      // The chat shape, on the responses endpoint.
      tools: PROFILES["2.x"].tools.shell ? [
        { type: "function", function: PROFILES["2.x"].tools.shell },
        { type: "function", function: PROFILES["2.x"].tools.read },
      ] : [],
    }),
  });
  const tools = state.calls.at(-1).body.tools;
  assert.equal(tools.length, 2, "the host's tools go out once each, not once each and again filled");
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ["shell", "read"],
  );
});
// A host that is not OpenCode describes its tools in its own words, and Zen
// reads the wording of the tools it knows by name. The tool itself is the
// host's, so that it still runs; the wording sent is OpenCode's.
test("keeps the host's tools and sends OpenCode's wording for the names Zen reads", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = (tools) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }], tools }),
    });
  const hostTool = (name, description, properties) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required: Object.keys(properties) } },
  });
  const own = [
    hostTool("bash", "Run a shell command and return what it printed.", { cmd: { type: "string" } }),
    hostTool("read", "Load a file into context.", { path: { type: "string" } }),
    hostTool("glob", "Find files by pattern.", { pattern: { type: "string" } }),
    hostTool("grep", "Search file contents.", { pattern: { type: "string" } }),
    hostTool("write", "Save a file.", { path: { type: "string" }, contents: { type: "string" } }),
  ];

  assert.equal((await send()).status, 200);
  assert.deepEqual(
    state.calls.at(-1).body.tools.map((tool) => tool.function.name),
    ["bash", "glob", "grep", "read"],
  );

  assert.equal((await send(own)).status, 200);
  const sent = state.calls.at(-1).body.tools;
  assert.deepEqual(
    sent.map((tool) => tool.function.name),
    ["bash", "read", "glob", "grep", "write"],
    "nothing is filled in, and nothing is sent twice",
  );
  const spoken = PROFILES["1.x"].tools;
  for (const tool of sent) {
    const name = tool.function.name;
    assert.equal(tool.function.description, spoken[name].description, `${name} wording`);
  }
  // The tool that will run the call is still the host's, so its parameters are
  // what the model has to fit.
  assert.deepEqual(sent[0].function.parameters.properties, { cmd: { type: "string" } });
  assert.deepEqual(sent[0].function.parameters.required, ["cmd"]);
  // Nothing this package uses to decide what to send is ever sent: `required`
  // marks which names Zen insists on and is not part of a tool.
  for (const tool of sent) assert.equal(tool.function.required, undefined);
  const added = (await (async () => {
    await send();
    return state.calls.at(-1).body.tools;
  })()).filter((tool) => !own.some((declared) => declared.function.name === tool.function.name));
  for (const tool of added) assert.equal(tool.function.required, undefined);
});

// A host may put a tool in the other protocol's shape. The name is read from
// either, and so is the wording to replace; a tool whose wording went out
// unchanged would be one Zen refuses.
test("replaces the wording of a tool sent in the other shape", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      model: "chat-free",
      messages: [{ role: "user", content: "hi" }],
      // The responses shape, on the chat endpoint.
      tools: [{ type: "function", name: "bash", description: "Run a command.", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    }),
  });
  const bash = state.calls.at(-1).body.tools[0];
  // Left in the shape it arrived in, with the wording replaced where the
  // description sits in that shape.
  assert.equal(bash.function, undefined);
  assert.equal(bash.description, PROFILES["1.x"].tools.bash.description);
  assert.deepEqual(bash.parameters.properties, { cmd: { type: "string" } });
});

// A tool this plugin added has nothing behind it, so it is said to be one — but
// only that tool, and only after the opening Zen reads.
test("marks an added tool as a placeholder without touching the host's own", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const send = (tools) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }], tools }),
    });

  await send();
  for (const tool of state.calls.at(-1).body.tools) {
    const spoken = PROFILES["1.x"].tools[tool.function.name];
    assert.ok(
      tool.function.description.startsWith(spoken.description),
      `${tool.function.name} still opens as OpenCode words it`,
    );
    assert.match(tool.function.description, /placeholder/i);
    assert.match(tool.function.description, /do not call it/i);
  }

  // The host's own tool gets OpenCode's wording and nothing else: it is the one
  // that runs, so nothing may tell the model to leave it.
  const own = { type: "function", function: { name: "read", description: "Load a file.", parameters: { type: "object", properties: { path: { type: "string" } } } } };
  await send([own]);
  const read = state.calls.at(-1).body.tools.find((tool) => tool.function.name === "read");
  assert.equal(read.function.description, PROFILES["1.x"].tools.read.description);
});

test("a refusal names the wording to update rather than the headers", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 403;
  state.body = JSON.stringify({
    type: "error",
    error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode." },
  });
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 403);
  const { error } = await response.json();
  assert.equal(error.type, "FreeTierError");
  assert.match(error.message, /wording/i);
  assert.match(error.message, /bash, glob, grep, read/);
  assert.match(error.message, /1\.19\.0/);
  // Zen's own wording, which sends people off to change headers, is replaced.
  assert.doesNotMatch(error.message, /can only be used from within OpenCode/);
});

for (const [path, model, key] of [
  ["responses", "responses-free", "parameters"],
  ["messages", "messages-free", "input_schema"],
]) {
  test(`normalizes ${path} tools and authentication using native protocol`, async (t) => {
    const { plugin, state, origin } = await fixture(t);
    await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
    const loader = await plugin.auth.loader(publicAuth);
    const response = await loader.fetch(`${origin}/v1/${path}`, {
      method: "POST",
      body: JSON.stringify({ model, stream: true }),
    });
    await response.text();
    const sent = state.calls.at(-1);
    assert.equal(sent.body.tools[0].name, "bash");
    assert.equal(sent.body.tools[0][key].type, "object");
    if (path === "messages") {
      assert.equal(sent.headers["x-api-key"], "public");
      assert.equal(sent.headers["anthropic-version"], "2023-06-01");
      assert.equal(sent.headers.authorization, undefined);
    }
  });
}

test("rejects paid models, wrong protocol and foreign URLs before sending inference", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const before = state.calls.length;
  const paid = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "paid", stream: true }),
  });
  assert.equal(paid.status, 404);
  for (const [url, model] of [
    [`${origin}/v1/responses`, "chat-free"],
    ["https://other.example/v1/chat/completions", "chat-free"],
  ]) {
    await assert.rejects(
      loader.fetch(url, { method: "POST", body: JSON.stringify({ model, stream: true }) }),
    );
  }
  assert.equal(state.calls.length, before);
});

test("accepts Request input and aborts a streaming request", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.hang = true;
  const controller = new AbortController();
  const req = new Request(`${origin}/v1/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({ model: "chat-free", stream: true }),
  });
  const response = await loader.fetch(req);
  const body = response.text();
  controller.abort();
  await assert.rejects(body, /abort/i);
});

test("chat headers name the session the way the free tier wants", async (t) => {
  const { plugin } = await fixture(t);
  const out = { headers: {} };
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "s1" }, out);
  assert.deepEqual(out.headers, {});
  await plugin["chat.headers"](
    { model: { providerID: "opencode-zen-free" }, sessionID: "s1" },
    out,
  );
  assert.deepEqual(out.headers, { "x-opencode-session": "s1", "x-opencode-session-id": "s1" });
});

test("a refresh drops a model Zen no longer lists and adds one it lists now", async (t) => {
  const { plugin, state } = await fixture(t);
  const before = await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(before).sort(), ["chat-free", "messages-free", "responses-free"]);
  state.ids = ["chat-free", "messages-free", "late-free"];
  const after = await plugin.provider.models({ models: before }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(after).sort(), ["chat-free", "late-free", "messages-free"]);
  assert.equal(after[Symbol.for("magpie.fellBack")], undefined);
  // a failed list keeps the last one, said as fallen back
  state.modelsStatus = 503;
  const kept = await plugin.provider.models({ models: after }, { auth: await publicAuth() });
  assert.deepEqual(Object.keys(kept).sort(), ["chat-free", "late-free", "messages-free"]);
  assert.equal(kept[Symbol.for("magpie.fellBack")], true);
});

test("a model no longer free is answered 404 naming the free ones, so only it is set aside", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  const before = state.calls.length;
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "gone-free", stream: true }),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error.message, /Model gone-free is not available/);
  assert.match(body.error.message, /chat-free, messages-free, responses-free/);
  // listed a moment ago: the list isn't asked again for it
  assert.equal(state.calls.length, before);
});

test("a model made free since the list was read is served after the list is asked again", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.ids = ["chat-free", "late-free"];
  state.chatProtocol = "chat/completions";
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  t.after(() => {
    Date.now = realNow;
  });
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "late-free", stream: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(state.calls.at(-1).body.model, "late-free");
});

test("a Chat stream Zen closes before its [DONE] ends cut short for a streaming client and fails for one that doesn't (#91)", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.reply =
    'data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"chat-free","choices":[{"index":0,"delta":{"role":"assistant"}}],"usage":null}\n\n' +
    'data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"chat-free","choices":[{"index":0,"delta":{"content":"Installed successfully and all"}}],"usage":null}\n\n' +
    'data: {"id":"x2","object":"chat.completion.chunk","created":1,"model":"chat-free","choices":[{"index":0,"delta":{"content":" other plugins are intact."}}],"usage":null}\n\n';
  const send = (stream) =>
    loader.fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-free", stream, messages: [{ role: "user", content: "hi" }] }),
    });
  const streamed = await send(true);
  assert.equal(streamed.status, 200);
  const text = await streamed.text();
  assert.match(text, /other plugins are intact\./);
  assert.match(text, /The reply was cut short.*"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]\n\n$/);
  assert.doesNotMatch(text, /"error"/);
  const whole = await send(false);
  assert.notEqual(whole.status, 200);
  assert.match(await whole.text(), /without a completion marker \(reply x2, 3 events/);
});

// A refusal is the one place this route states its own window, and the plugin
// reads it on its way past (observeRouteStatement, called from the provider's
// fetch). The window in this fixture is one no measurement ever produced, so
// only the live path can put it there: a unit test of the reader would pass
// with the call site missing, which is exactly how the last plugin lost a
// mechanism it had already shipped and tested.
test("a refusal that names a window reaches the declaration, not only the caller", async (t) => {
  const { plugin, state, origin } = await fixture(t);
  await plugin.provider.models({ models: {} }, { auth: await publicAuth() });
  const loader = await plugin.auth.loader(publicAuth);
  state.status = 400;
  state.body = JSON.stringify({
    error: {
      type: "invalid_request_error",
      message:
        "This model's maximum context length is 900000 tokens. However, you requested 1000000 tokens (900000 in the messages, 100000 in the completion).",
    },
  });
  const response = await loader.fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "chat-free", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /maximum context length is 900000 tokens/);
  const { limitOverrides } = await import("./limits.mjs");
  assert.equal(limitOverrides("chat-free", { context: 200000, output: 8192 }).context, 900000);
});

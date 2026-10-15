import assert from "node:assert/strict";
import test from "node:test";

const subject = import("./limits.mjs").catch(() => ({}));

const DECLARED = { context: 200000, output: 32000 };

// Verbatim from a real refusal, 2026-10-15 (the request carried a 1,038,278
// token prompt and max_tokens 384000). This sentence is the whole reason the
// window below is a route figure and not a vendor one.
const REFUSAL = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "This model's maximum context length is 1048576 tokens. However, you requested 1422278 tokens (1038278 in the messages, 384000 in the completion). Please reduce the length of the messages or completion.",
  },
});

test("a free id Zen under-reports is declared at what the route says", async () => {
  const { limitOverrides } = await subject;
  assert.equal(typeof limitOverrides, "function", "limit alignment must be implemented");
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", DECLARED), {
    context: 1048576,
    output: 384000,
  });
});

test("a second id on another upstream, whose axes rest on different tiers, is declared the same way", async () => {
  const { limitOverrides } = await subject;
  // its window is the route's own sentence; its output is the vendor's
  // catalogue entry, because this upstream names no completion ceiling
  assert.deepEqual(limitOverrides("mimo-v2.6-flash-free", DECLARED), {
    context: 1048576,
    output: 131072,
  });
});

test("evidence measured against another catalogue is void, and only on its own axis", async () => {
  const { limitOverrides } = await subject;
  // Zen moved the window it declares: the measured window is an answer to a
  // question nobody is asking any more, while the output axis was measured
  // against 32000 and still stands.
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", { context: 250000, output: 32000 }), {
    output: 384000,
  });
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", { context: 200000, output: 64000 }), {
    context: 1048576,
  });
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", {}), {});
});

test("a model with no evidence keeps exactly what the catalogue declared", async () => {
  const { limitOverrides } = await subject;
  assert.deepEqual(limitOverrides("nemotron-3.5-lightning-free", DECLARED), {});
  assert.deepEqual(limitOverrides("big-pickle", {}), {});
  assert.deepEqual(limitOverrides("__proto__", DECLARED), {});
});

test("weaker evidence may raise a limit but never lower one", async () => {
  const { limitOverrides } = await subject;
  const table = {
    "vendor-lower-free": { context: { value: 100000, source: "vendor", declaredAt: 200000 } },
    "witnessed-raise-free": { output: { value: 64000, source: "witnessed", declaredAt: 32000 } },
    "route-lower-free": { context: { value: 100000, source: "route", declaredAt: 200000 } },
    "malformed-free": { context: { value: 0, source: "route", declaredAt: 200000 } },
  };
  assert.deepEqual(limitOverrides("vendor-lower-free", DECLARED, table), {});
  assert.deepEqual(limitOverrides("witnessed-raise-free", DECLARED, table), { output: 64000 });
  // the route may say a window is smaller than the catalogue claims; a vendor
  // page or a witness may not, because that invents a restriction
  assert.deepEqual(limitOverrides("route-lower-free", DECLARED, table), { context: 100000 });
  assert.deepEqual(limitOverrides("malformed-free", DECLARED, table), {});
});

test("a refusal naming a window while the process runs outranks the shipped table forever after", async () => {
  const { observeRouteStatement, namedContextWindow, limitOverrides } = await subject;
  assert.equal(namedContextWindow(REFUSAL), 1048576);
  assert.equal(
    await observeRouteStatement(
      "deepseek-v4.1-flash-free",
      new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json" } }),
    ),
    1048576,
  );
  const live = new Map([["deepseek-v4.1-flash-free", 900000]]);
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", DECLARED, undefined, live), {
    context: 900000,
    output: 384000,
  });
});

test("only a refusal that names a window is read, and only its first few KiB", async () => {
  const { observeRouteStatement, namedContextWindow } = await subject;
  assert.equal(namedContextWindow(""), undefined);
  assert.equal(namedContextWindow('{"error":{"message":"invalid request"}}'), undefined);
  assert.equal(namedContextWindow(undefined), undefined);
  assert.equal(namedContextWindow('{"error":{"message":"maximum context length is 0 tokens"}}'), undefined);
  // a refusal is read; the answer to a served request is not
  assert.equal(
    await observeRouteStatement("x-free", new Response(REFUSAL, { status: 200 })),
    undefined,
  );
  assert.equal(
    await observeRouteStatement("x-free", new Response('{"error":{"message":"Upstream failed"}}', { status: 400 })),
    undefined,
  );
  // a 4xx that says what it wants only past the read budget is not read at all
  assert.equal(
    await observeRouteStatement("x-free", new Response(" ".repeat(5000) + REFUSAL, { status: 400 })),
    undefined,
  );
  // nothing here may throw into a request that is on its way to a caller
  assert.equal(await observeRouteStatement("x-free", undefined), undefined);
  assert.equal(await observeRouteStatement("x-free", new Response(null, { status: 400 })), undefined);
  assert.equal(await observeRouteStatement("", new Response(REFUSAL, { status: 400 })), undefined);
});

test("discovery declares the aligned limits for the ids with evidence, and leaves the rest alone", async () => {
  const { buildModels } = await import("./models.mjs");
  const provider = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "deepseek-v4.1-flash-free": {
        name: "DeepSeek V4.1 Flash Free",
        cost: { input: 0, output: 0 },
        limit: { context: 200000, output: 32000 },
      },
      "mimo-v2.6-flash-free": {
        name: "MiMo V2.6 Flash Free",
        cost: { input: 0, output: 0 },
        limit: { context: 200000, output: 32000 },
      },
      "big-pickle": {
        name: "Big Pickle",
        cost: { input: 0, output: 0 },
        limit: { context: 200000, input: 160000, output: 32000 },
      },
    },
  };
  const models = buildModels(
    Object.keys(provider.models),
    provider,
    {},
    "https://opencode.ai/inference/v1",
  );
  assert.deepEqual(models["deepseek-v4.1-flash-free"].limit, { context: 1048576, output: 384000 });
  assert.deepEqual(models["mimo-v2.6-flash-free"].limit, { context: 1048576, output: 131072 });
  // no evidence for this one, and the catalogue's own `input` survives untouched
  assert.deepEqual(models["big-pickle"].limit, { context: 200000, input: 160000, output: 32000 });
});

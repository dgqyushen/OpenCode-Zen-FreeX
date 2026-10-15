import assert from "node:assert/strict";
import test from "node:test";

const subject = import("./limits.mjs").catch((error) => {
  assert.fail(`limits.mjs failed to load: ${error?.message ?? error}`);
});

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
  // an id that is not an id at all must not reach the prototype chain for a
  // record: `table["toString"]` is a function, and reading an entry off it
  // would invent evidence for a model nobody declared
  for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    assert.deepEqual(limitOverrides(key, DECLARED), {}, `${key} must never yield phantom evidence`);
  }
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
  // the caller is still waiting on this response when the plugin reads it, so
  // observing has to be non-destructive: it reads a copy, never the body itself
  const response = new Response(REFUSAL, {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(await observeRouteStatement("deepseek-v4.1-flash-free", response), {
    context: 1048576,
    output: undefined,
  });
  assert.equal(response.bodyUsed, false, "observing must not consume the caller's body");
  assert.equal(await response.text(), REFUSAL, "the caller still gets the whole body");
  const live = new Map([["deepseek-v4.1-flash-free", 900000]]);
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", DECLARED, undefined, live), {
    context: 900000,
    output: 384000,
  });
});

// An upstream that validates the ceiling it was asked for says what the ceiling
// is, which is the one place a completion limit has been named by this route at
// all — the DeepSeek upstream accepts max_tokens 2000000 in silence.
const CEILING =
  '{"param":"max_tokens is too large: 200000. This model supports at most 131072 completion tokens, whereas you provided 200000.","type":"server_error"}';

test("a refusal that names a completion ceiling is read on the output axis too", async () => {
  const { namedOutputCap, namedContextWindow, observeRouteStatement, limitOverrides } = await subject;
  assert.equal(namedOutputCap(CEILING), 131072);
  assert.equal(namedContextWindow(CEILING), undefined);
  assert.deepEqual(await observeRouteStatement("x-free", new Response(CEILING, { status: 400 })), {
    context: undefined,
    output: 131072,
  });
  const liveOutput = new Map([["x-free", 131072]]);
  assert.deepEqual(
    limitOverrides("x-free", { context: 200000, output: 32000 }, undefined, undefined, liveOutput),
    { output: 131072 },
  );
  assert.equal(namedOutputCap('{"error":{"message":"supports at most 0 completion tokens"}}'), undefined);
});

test("an id with a route-stated ceiling and an unmeasured window is aligned on one axis only", async () => {
  const { limitOverrides } = await subject;
  // big-pickle: the ceiling is the route's own sentence; its window was not
  // measured, and being the same upstream model as another id is not a window
  assert.deepEqual(limitOverrides("big-pickle", { context: 200000, input: 160000, output: 32000 }), {
    output: 131072,
  });
  // and the untouched axis is left exactly as the catalogue declared it
  assert.deepEqual(limitOverrides("big-pickle", { context: 250000, output: 32000 }), { output: 131072 });
});

test("the audit's first run named two more, each on the axis its refusal named", async () => {
  const { limitOverrides, namedOutputCap } = await subject;
  // a window named by a refusal, against a catalogue that declares a quarter of it
  assert.deepEqual(
    limitOverrides("nemotron-3.5-lightning-free", { context: 262144, output: 262144 }),
    { context: 1000000 },
  );
  // a ceiling named in the second wording, where the catalogue declares half of it
  const longcat =
    "Upstream request failed: [invalid_parameter] 参数校验失败: \n/max_tokens: 1000000 is not less or equal to 262144\n";
  assert.equal(namedOutputCap(longcat), 262144);
  assert.deepEqual(
    limitOverrides("longcat-2.5-preview-free", { context: 1000000, output: 131072 }),
    { output: 262144 },
  );
});

// LongCat's wording ends with the digits it captured, and the body is read only
// up to a budget. A cut inside those digits leaves a smaller number that looks
// complete — and that number would be stored as live evidence, past the
// catalogue-staleness check and past the downgrade guard, and sent as
// max_tokens on every request after it.
const CEILING_WORDING =
  "Upstream request failed: [invalid_parameter] 参数校验失败: \n/max_tokens: 1000000 is not less or equal to 262144\n";

test("a body cut inside the ceiling it names is not read as a smaller ceiling", async () => {
  const { observeRouteStatement, limitOverrides, namedOutputCap } = await subject;
  const at = CEILING_WORDING.indexOf("262144");
  // whole, and cut after the number is complete: the ceiling is read
  assert.equal(namedOutputCap(CEILING_WORDING), 262144);
  assert.deepEqual(
    await observeRouteStatement("longcat-2.5-preview-free", new Response(CEILING_WORDING, { status: 400 })),
    { context: undefined, output: 262144 },
  );
  // cut inside it: no axis is read at all, so nothing reaches the declaration.
  // The read that ends on the last digit counts too — there is no way to tell
  // it from that same digit being the first of a longer number.
  for (let limit = at + 1; limit <= at + 6; limit++) {
    assert.equal(
      await observeRouteStatement("longcat-2.5-preview-free", new Response(CEILING_WORDING, { status: 400 }), limit),
      undefined,
      `a read that ends inside 262144 must not be taken as a ceiling (limit ${limit}, would read "${CEILING_WORDING.slice(at, limit)}")`,
    );
  }
  // and the declaration is still the one the table measured, not the half number
  assert.deepEqual(limitOverrides("longcat-2.5-preview-free", { context: 1000000, output: 131072 }), {
    output: 262144,
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
      "space-bunny-free": {
        name: "Space Bunny Free",
        cost: { input: 0, output: 0 },
        limit: { context: 1048576, input: 524288, output: 524288 },
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
  // one axis has evidence for this one and the other does not, so only its
  // output moves and the catalogue's own `input` survives untouched
  assert.deepEqual(models["big-pickle"].limit, { context: 200000, input: 160000, output: 131072 });
  // no evidence at all here: everything the catalogue declared survives
  assert.deepEqual(models["space-bunny-free"].limit, {
    context: 1048576,
    input: 524288,
    output: 524288,
  });
});

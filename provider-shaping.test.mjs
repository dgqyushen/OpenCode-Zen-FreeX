import assert from "node:assert/strict";
import test from "node:test";
import { encodeBody, upstreamEndpoint } from "./provider.mjs";

// The gateway's own base. Zen 2.1 groups its inference routes by the provider
// family behind them, so the flat path this plugin used to post is no longer
// the one a 2.1 client sends.
test("the inference gateway route is grouped by provider family", () => {
  const base = "https://opencode.ai/inference/v1";
  assert.equal(
    upstreamEndpoint(base, "chat"),
    "https://opencode.ai/inference/openai/v1/chat/completions",
  );
  assert.equal(
    upstreamEndpoint(base, "responses"),
    "https://opencode.ai/inference/openai/v1/responses",
  );
  assert.equal(
    upstreamEndpoint(base, "anthropic"),
    "https://opencode.ai/inference/anthropic/v1/messages?beta=true",
  );
  // A base carrying a trailing slash reaches the same route: the slash is not
  // part of the path the grouping reads.
  assert.equal(
    upstreamEndpoint(`${base}/`, "chat"),
    "https://opencode.ai/inference/openai/v1/chat/completions",
  );
  // The grouping belongs to a gateway under a path, not to the origin's root.
  assert.equal(
    upstreamEndpoint("https://gateway.example/proxy/inference/v1", "anthropic"),
    "https://gateway.example/proxy/inference/anthropic/v1/messages?beta=true",
  );
});

test("a custom base keeps the flat route it was written with", () => {
  // A host's own route is not the gateway, and Zen's grouping has no meaning
  // there: the path the caller wrote is the path that answers.
  assert.equal(
    upstreamEndpoint("http://127.0.0.1:1234/v1", "chat"),
    "http://127.0.0.1:1234/v1/chat/completions",
  );
  assert.equal(
    upstreamEndpoint("http://127.0.0.1:1234/v1", "responses"),
    "http://127.0.0.1:1234/v1/responses",
  );
  assert.equal(
    upstreamEndpoint("http://127.0.0.1:1234/v1", "anthropic"),
    "http://127.0.0.1:1234/v1/messages",
  );
  // `/inference` without `/v1` is not the route the grouping names; the flat
  // path is left alone rather than guessed at.
  assert.equal(
    upstreamEndpoint("https://opencode.ai/inference", "chat"),
    "https://opencode.ai/inference/chat/completions",
  );
  assert.throws(() => upstreamEndpoint("https://opencode.ai/inference/v1", "grpc"), /Unknown protocol "grpc"/);
});

test("a 2.x chat body writes the client's key order, other lanes keep the caller's", () => {
  const body = {
    temperature: 0.2,
    stream_options: { include_usage: true },
    max_completion_tokens: 32000,
    stream: true,
    tools: [{ type: "function", function: { name: "read" } }],
    messages: [{ role: "user", content: "hi" }],
    model: "chat-free",
    user: "conversation-a",
  };
  const encoded = encodeBody(body, "chat", "2.x");
  assert.deepEqual(Object.keys(JSON.parse(encoded)), [
    "model",
    "messages",
    "tools",
    "stream",
    "stream_options",
    "max_completion_tokens",
    "temperature",
    "user",
  ]);
  assert.deepEqual(JSON.parse(encoded), body, "ordering does not change what was sent");
  // A key the order does not name sorts after the ones it does, so two runs
  // from the same body write the same bytes.
  assert.equal(encodeBody(body, "chat", "2.x"), encoded);

  // The other lanes and the 1.x Chat lane preserve the body's own insertion
  // order; there is no gateway order to match there.
  const one = encodeBody(body, "chat", "1.x");
  assert.deepEqual(Object.keys(JSON.parse(one)), Object.keys(body));
  for (const [protocol, generation] of [
    ["chat", "1.x"],
    ["responses", "2.x"],
    ["anthropic", "2.x"],
  ]) {
    const text = encodeBody(body, protocol, generation);
    assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(body));
    assert.deepEqual(JSON.parse(text), body);
  }
});

test("a shaped chat body with only a few keys is ordered without inventing fields", () => {
  const body = { model: "chat-free", messages: [], stream: true };
  const parsed = JSON.parse(encodeBody(body, "chat", "2.x"));
  assert.deepEqual(Object.keys(parsed), ["model", "messages", "stream"]);
  assert.deepEqual(parsed, body);
  // The order is a rendering rule, not a mutation of the body it renders.
  assert.deepEqual(Object.keys(body), ["model", "messages", "stream"]);
});

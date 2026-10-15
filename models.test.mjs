import assert from "node:assert/strict";
import test from "node:test";

// Not caught: a syntax error, a renamed file or a failure while models.mjs (or
// limits.mjs, which it imports) is evaluated has to surface as itself. Swallowed
// into an empty module it reads as "model discovery must be implemented" or
// "parseProtocolDocs is not a function", which is not what broke.
const subject = import("./models.mjs");
const provider = {
  npm: "@ai-sdk/openai-compatible",
  models: {
    "coder-free": {
      name: "Coder Free",
      cost: { input: 0, output: 0 },
      limit: { context: 200000, input: 160000, output: 32000 },
      reasoning: true,
      tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    },
    "zero-cost": { cost: { input: 0, output: 0 } },
    paid: { cost: { input: 1, output: 3 } },
    "old-free": { status: "deprecated", cost: { input: 0, output: 0 } },
    "decision-free": { provider: { npm: "@vendor/systemone" } },
    "responses-free": { provider: { npm: "@ai-sdk/openai" } },
    "messages-free": { provider: { npm: "@ai-sdk/anthropic" } },
    "gone-free": {},
  },
};
const ids = Object.keys(provider.models).filter((id) => id !== "gone-free");
const baseURL = "https://opencode.ai/zen/v1";

test("lists only live free models with supported protocols and excludes retired models", async () => {
  const { buildModels } = await subject;
  assert.equal(typeof buildModels, "function", "model discovery must be implemented");
  const models = buildModels(ids, provider, {}, baseURL);
  assert.deepEqual(Object.keys(models).sort(), [
    "coder-free",
    "messages-free",
    "responses-free",
    "zero-cost",
  ]);
  assert.equal(models["coder-free"].free, true);
  assert.equal(models["coder-free"].providerID, "opencode-zen-free");
  assert.deepEqual(models["coder-free"].limit, { context: 200000, input: 160000, output: 32000 });
  assert.equal(models["coder-free"].capabilities.input.image, true);
  assert.equal(models["coder-free"].capabilities.toolcall, true);
  assert.deepEqual(Object.keys(models["coder-free"].variants).sort(), ["high", "low"]);
  assert.equal(models["responses-free"].api.npm, "@ai-sdk/openai");
  assert.equal(models["messages-free"].api.npm, "@ai-sdk/anthropic");
});

test("endpoint documentation overrides inherited SDK and excludes SystemOne", async () => {
  const { buildModels, parseProtocolDocs } = await subject;
  assert.equal(typeof parseProtocolDocs, "function", "protocol parsing must be implemented");
  const protocols = parseProtocolDocs(
    [
      "| Coder | coder-free | `https://opencode.ai/zen/v1/messages` | sdk |",
      "| Decision | decision-free | `https://opencode.ai/zen/v1/systemone` | - |",
    ].join("\n"),
  );
  const models = buildModels(ids, provider, protocols, baseURL);
  assert.equal(models["coder-free"].api.npm, "@ai-sdk/anthropic");
  assert.equal(models["decision-free"], undefined);
});

test("an unknown id is offered on its own free name, never on a guessed endpoint", async () => {
  const { buildModels } = await subject;
  assert.equal(typeof buildModels, "function", "model discovery must be implemented");
  // an id that does not name itself free is not offered at all
  assert.deepEqual(Object.keys(buildModels(["unknown-paid"], {}, {}, baseURL)), []);
  // one that does is asked through the provider's own protocol, not a guess at it
  const free = buildModels(["new-free"], {}, {}, baseURL);
  assert.deepEqual(Object.keys(free), ["new-free"]);
  assert.equal(free["new-free"].api.npm, "@ai-sdk/openai-compatible");
  const models = buildModels(["new-free"], {}, { "new-free": "chat" }, baseURL);
  assert.equal(models["new-free"].api.url, baseURL);
  assert.equal(models["new-free"].cost.input, 0);
});

// A model Zen lists that neither the catalogue nor the docs describe yet: the id
// says it is free, so it is offered at the protocol the provider itself speaks
// rather than waiting for the catalogue to catch up (yetone/magpie#2385). An id
// that does not call itself free still needs the catalogue's word, and one the
// catalogue does describe keeps the protocol the catalogue gave it.
test("an id that calls itself free is offered before the catalogue describes it", async () => {
  const { buildModels } = await subject;
  const models = buildModels(
    ["brand-new-free", "brand-new", "responses-free"],
    provider,
    {},
    baseURL,
  );
  assert.deepEqual(Object.keys(models).sort(), ["brand-new-free", "responses-free"]);
  assert.equal(models["brand-new-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["brand-new-free"].name, "brand-new-free");
  // the fallback used when the catalogue carries no limit for the model
  assert.equal(models["brand-new-free"].limit.context, 32768);
  // the catalogue's own package still decides the protocol for an id it describes
  assert.equal(models["responses-free"].api.npm, "@ai-sdk/openai");
});

// Rows as OpenCode's console docs have them since 2026-10-12
// (services/www/src/docs/content/console/models.mdx), and the pricing table
// beside it that names no endpoint (yetone/magpie#2305): the zen.mdx these
// were read from before was removed that day. Two of the rows below are ones the
// parser has to leave out, and the assertions say so rather than leaving it to
// the whole-object comparison: a pricing row carries no endpoint at all, and an
// endpoint path that is not one of the four protocols (`/v1/models/…`, Gemini's)
// is not a protocol this plugin can ask.
const consoleDocs = [
  "| Claude Haiku 4.5                | claude-haiku-4-5                | `https://opencode.ai/inference/v1/messages`                     | `@ai-sdk/anthropic`         |",
  "| Gemini 3 Flash                  | gemini-3-flash                  | `https://opencode.ai/inference/v1/models/gemini-3-flash`        | `@ai-sdk/google`            |",
  "| Jev 1.13 Free                   | jev-1.13-free                   | `https://opencode.ai/inference/v1/systemone`                    | -                           |",
  "| Big Pickle                      | big-pickle                      | `https://opencode.ai/inference/v1/chat/completions`             | `@ai-sdk/openai-compatible` |",
  "| Step 5 Preview Free             | step-5-preview-free             | `https://opencode.ai/inference/v1/chat/completions`             | `@ai-sdk/openai-compatible` |",
  "| Muse Spark 1.3 Contributor Free | muse-spark-1.3-contributor-free | `https://opencode.ai/inference/v1/responses`                    | `@ai-sdk/openai`            |",
  "| Step 5 Preview Free               | Free            | Free            | Free            | -            |",
].join("\n");

test("reads the console docs' endpoint table, and Jev stays out as SystemOne", async () => {
  const { buildModels, parseProtocolDocs, bootstrapProtocols } = await subject;
  assert.equal(typeof bootstrapProtocols, "object", "the console-docs snapshot must be exported");
  const protocols = parseProtocolDocs(consoleDocs);
  assert.deepEqual(protocols, {
    "claude-haiku-4-5": "anthropic",
    "jev-1.13-free": "systemone",
    "big-pickle": "chat",
    "step-5-preview-free": "chat",
    "muse-spark-1.3-contributor-free": "responses",
  });
  // the two rows that must not have produced a protocol: the pricing row that
  // names no endpoint, and the path outside the supported set
  assert.equal(protocols["step-5-preview-free"], "chat");
  assert.equal(protocols["gemini-3-flash"], undefined);
  // the snapshot kept for when the docs can't be read says the same, for every
  // id it carries: `claude-haiku-4-5` is a paid model the free snapshot has no
  // entry for, and every other id here has to be in it
  for (const [id, protocol] of Object.entries(protocols)) {
    if (id === "claude-haiku-4-5") continue;
    assert.equal(bootstrapProtocols?.[id], protocol, id);
  }
  const models = buildModels(["jev-1.13-free", "step-5-preview-free"], {}, protocols, baseURL);
  assert.deepEqual(Object.keys(models), ["step-5-preview-free"]);
});

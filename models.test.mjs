import assert from "node:assert/strict";
import test from "node:test";

// Not caught: a syntax error, a renamed file or a failure while models.mjs (or
// limits.mjs, which it imports) is evaluated has to surface as itself. Swallowed
// into an empty module it reads as "model discovery must be implemented" or
// "parseProtocolDocs is not a function", which is not what broke. The handler
// attached below is not that: it marks the load handled the moment it can fail,
// so a rejected import cannot surface as an unhandled rejection — Bun's test
// runner then aborts the file before any test runs and reports the whole run as
// a crash — while `await subject` in every test still rejects with the original
// error, which is what makes each one fail for the real reason.
const subject = import("./models.mjs");
subject.catch(() => {});
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
    // The one entry where the two free-ness rules disagree: the id ends in
    // `-free` while the catalogue still prices it. The name wins — see the test
    // that pins it below.
    "late-free": { cost: { input: 5, output: 25 } },
    "old-free": { status: "deprecated", cost: { input: 0, output: 0 } },
    // Retired through `lifecycle`, with a blank `status` written in front of it:
    // a blank status is not a status, so it must not hide the lifecycle.
    "lifecycle-free": { status: "", lifecycle: "retired", cost: { input: 0, output: 0 } },
    // ...and a blank status on its own retires nothing.
    "blank-status-free": { status: "", cost: { input: 0, output: 0 } },
    "decision-free": { provider: { npm: "@vendor/systemone" } },
    "responses-free": { provider: { npm: "@ai-sdk/openai" } },
    "messages-free": { provider: { npm: "@ai-sdk/anthropic" } },
  },
};
// Every id the catalogue describes is handed to `buildModels`, and which of them
// it lists is the module's answer: an id Zen has stopped listing is retired by
// being absent from the caller's `ids`, which is discovery's business and not
// something this fixture can pin by filtering one out of it.
const ids = Object.keys(provider.models);
const baseURL = "https://opencode.ai/zen/v1";

test("lists only live free models with supported protocols and excludes retired models", async () => {
  const { buildModels } = await subject;
  assert.equal(typeof buildModels, "function", "model discovery must be implemented");
  const models = buildModels(ids, provider, {}, baseURL);
  assert.deepEqual(Object.keys(models).sort(), [
    "blank-status-free",
    "coder-free",
    "late-free",
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

// Where the two free-ness rules disagree, the name wins. `-free` is the rule for
// an id the catalogue has not caught up with — Zen lists a model the hour it
// turns free — so an id that names itself free is offered even while the
// catalogue still prices it (README 模型, MAINTAINING.md "Waiting for the
// catalogue before offering a model Zen already lists"). The cost reported is
// zero whatever the catalogue says: the one thing this plugin serves is free
// models, so a price is never passed on.
test("an id that names itself free is offered even while the catalogue prices it", async () => {
  const { buildModels } = await subject;
  const models = buildModels(["late-free", "paid"], provider, {}, baseURL);
  assert.deepEqual(Object.keys(models), ["late-free"]);
  assert.equal(models["late-free"].cost.input, 0);
  assert.equal(models["late-free"].cost.output, 0);
});

// A status has to say something to be one: the catalogue writes an empty string
// as well as a null. A blank one must not stand in front of the `lifecycle` that
// retires the model — it did, so a model retired that way stayed on offer — and
// it does not retire one by itself either.
test("a blank status falls through to lifecycle, and retires nothing on its own", async () => {
  const { buildModels, isFree } = await subject;
  assert.equal(isFree("lifecycle-free", provider.models["lifecycle-free"]), false);
  assert.equal(isFree("blank-status-free", provider.models["blank-status-free"]), true);
  const models = buildModels(["blank-status-free", "lifecycle-free", "old-free"], provider, {}, baseURL);
  assert.deepEqual(Object.keys(models), ["blank-status-free"]);
});

// The date axes are read the same way the status is: the catalogue writes an
// empty string for a date it does not have, and a blank one is not a date, so it
// must not retire a model. A date that does say something still retires it.
test("a blank retirement date retires nothing, a set one does", async () => {
  const { buildModels, isFree } = await subject;
  for (const axis of ["deprecated_at", "retirement_date"]) {
    const blank = { [axis]: "", cost: { input: 0, output: 0 } };
    assert.equal(isFree(`blank-${axis}-free`, blank), true, `a blank ${axis} is not a date`);
    // and the same shape with a date in it is still read as retired
    const dated = { [axis]: "2026-01-01", cost: { input: 0, output: 0 } };
    assert.equal(isFree(`dated-${axis}-free`, dated), false, `a set ${axis} retires the model`);
  }
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "blank-date-free": { deprecated_at: "", retirement_date: null, cost: { input: 0, output: 0 } },
      "dated-free": { retirement_date: "2026-01-01", cost: { input: 0, output: 0 } },
    },
  };
  assert.deepEqual(
    Object.keys(buildModels(["blank-date-free", "dated-free"], catalogue, {}, baseURL)),
    ["blank-date-free"],
  );
});

// The catalogue writes an explicit null for an axis it does not state — this
// file's own comments say so — and the spread that built the model's limit used
// to copy every own key, nulls included, over the 32768/4096 defaults. The host
// was then handed `context: null` as the model's window. Only axes that are
// usable numbers go in, and an axis the catalogue does state still wins.
test("an explicit null limit does not replace the defaults", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "null-limit-free": { cost: { input: 0, output: 0 }, limit: { context: null, output: null } },
      "blank-limit-free": { cost: { input: 0, output: 0 }, limit: { context: "", output: 0 } },
      "partial-limit-free": {
        cost: { input: 0, output: 0 },
        limit: { context: 200000, output: null, input: 160000 },
      },
    },
  };
  const models = buildModels(
    ["null-limit-free", "blank-limit-free", "partial-limit-free"],
    catalogue,
    {},
    baseURL,
  );
  assert.deepEqual(models["null-limit-free"].limit, { context: 32768, output: 4096 });
  assert.deepEqual(models["blank-limit-free"].limit, { context: 32768, output: 4096 });
  assert.deepEqual(models["partial-limit-free"].limit, {
    context: 200000,
    output: 4096,
    input: 160000,
  });
  for (const [id, model] of Object.entries(models))
    for (const [axis, value] of Object.entries(model.limit))
      assert.ok(Number.isSafeInteger(value) && value > 0, `${id}.${axis} is a usable window`);
});

// The names every plain object answers out of Object.prototype — `constructor`,
// `toString`, `hasOwnProperty` — are neither a catalogue entry nor a protocol.
// Read as the docs map's protocol, `protocols["toString"]` is a function the SDK
// does not have, so the model was dropped instead of being asked the way its own
// catalogue entry says; an id the catalogue does describe is offered here even
// though it is named like one of those members.
test("a prototype member name is not read as a protocol", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: { toString: { cost: { input: 0, output: 0 }, limit: { context: 4096 } } },
  };
  const models = buildModels(["toString"], catalogue, {}, baseURL);
  assert.deepEqual(Object.keys(models), ["toString"]);
  assert.equal(models["toString"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["toString"].limit.context, 4096);
});

// A model description has to be the catalogue's own, the same rule the
// `__proto__` skip states: what a plain object inherits is not something the
// catalogue says about a model. An id without one is not a described model, and
// is then offered only if it names itself free.
test("a description the catalogue only inherits is not one", async () => {
  const { buildModels } = await subject;
  const chained = Object.create({ legacy: { cost: { input: 0, output: 0 } } });
  const catalogue = { npm: "@ai-sdk/openai-compatible", models: chained };
  assert.deepEqual(Object.keys(buildModels(["legacy"], catalogue, {}, baseURL)), []);
  assert.deepEqual(Object.keys(buildModels(["legacy-free"], catalogue, {}, baseURL)), ["legacy-free"]);
});

// The rest of the names a plain object answers out of Object.prototype, which
// the tests above only reach through `toString` and a chained `legacy`. Read as
// the catalogue's entry or as the docs map's protocol, each of them is a
// function the SDK does not have, so an id that names one has to reach the
// `-free` fallback rather than be dropped for naming a protocol nobody wrote —
// and `__proto__`, whose skip the comment above cites, is never exercised by any
// test unless it is here. The empty catalogue is what makes the names inherited
// rather than own; the second half below is the other side of the same rule.
test("a prototype member name is not read as a catalogue entry or a protocol", async () => {
  const { buildModels } = await subject;
  for (const name of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
    const models = buildModels([name, `${name}-free`], {}, {}, baseURL);
    assert.deepEqual(
      Object.keys(models),
      [`${name}-free`],
      `${name}: only the id that names itself free is offered`,
    );
    assert.equal(models[`${name}-free`].api.npm, "@ai-sdk/openai-compatible", name);
    assert.equal(
      Object.getPrototypeOf(models),
      Object.prototype,
      `${name} must not reach the result map's prototype`,
    );
    assert.equal(Object.hasOwn(models, "__proto__"), false, name);
  }
});

// The other half: a catalogue that really does carry one of those names as its
// own entry — which takes a null-prototype object, since on a plain one the
// write side of `__proto__` is the prototype itself — is read as what it is, and
// so is the docs map. `__proto__` stays out either way: that skip is stated at
// the point the rule is about, and it cannot be a catalogue entry in any file
// this reads.
test("a catalogue's own entry under a prototype name is still read", async () => {
  const { buildModels } = await subject;
  const catalogue = Object.create(null);
  catalogue.npm = "@ai-sdk/openai-compatible";
  catalogue.models = Object.create(null);
  for (const name of ["constructor", "hasOwnProperty", "toString"]) {
    catalogue.models[name] = { cost: { input: 0, output: 0 }, limit: { context: 4096 } };
  }
  catalogue.models.__proto__ = { cost: { input: 0, output: 0 }, limit: { context: 4096 } };
  const models = buildModels(
    ["__proto__", "constructor", "toString", "missing"],
    catalogue,
    {},
    baseURL,
  );
  assert.deepEqual(Object.keys(models).sort(), ["constructor", "toString"]);
  for (const name of ["constructor", "toString"]) {
    assert.equal(models[name].limit.context, 4096, `${name}: the catalogue's own window`);
  }
  assert.equal(Object.hasOwn(models, "__proto__"), false, "the prototype key is never an entry");
  assert.equal(Object.getPrototypeOf(models), Object.prototype);
  // and the docs map is an own-property lookup for the same reason: `toString`
  // as its own entry resolves the model to `responses`, while a `constructor`
  // the map merely inherits resolves nothing.
  const documented = Object.create(null);
  documented.toString = "responses";
  const free = { npm: "@ai-sdk/openai-compatible", models: { toString: { cost: { input: 0, output: 0 } } } };
  assert.equal(buildModels(["toString"], free, documented, baseURL)["toString"].api.npm, "@ai-sdk/openai");
  assert.equal(
    buildModels(["toString"], free, { constructor: "responses" }, baseURL)["toString"].api.npm,
    "@ai-sdk/openai-compatible",
    "an inherited protocol is not a protocol",
  );
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

// The test above leaves the SystemOne exclusion unpinned: `decision-free`'s
// catalogue entry already names `@vendor/systemone`, which maps to no protocol,
// so it is dropped whether the docs row is read or not. The id here is one the
// catalogue does not describe, so the fallback would hand it `chat` — it can
// only be missing if the endpoint the docs give it was resolved first, and
// `systemone` is not a protocol this plugin asks.
test("a documented SystemOne endpoint keeps an undescribed id out", async () => {
  const { buildModels, parseProtocolDocs } = await subject;
  const protocols = parseProtocolDocs(
    "| Fresh | fresh-free | `https://opencode.ai/zen/v1/systemone` | - |",
  );
  assert.equal(protocols["fresh-free"], "systemone");
  assert.deepEqual(Object.keys(buildModels(["fresh-free"], {}, {}, baseURL)), ["fresh-free"]);
  assert.deepEqual(Object.keys(buildModels(["fresh-free"], {}, protocols, baseURL)), []);
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
  // "names itself free" is asked case-insensitively, the way the free gate asks
  // it. Asked case-sensitively, an id like this passed the gate and then found
  // no protocol, so it was dropped silently instead of being offered.
  for (const id of ["new-model-FREE", "New-Model-Free"]) {
    const offered = buildModels([id], {}, {}, baseURL);
    assert.deepEqual(Object.keys(offered), [id], `${id} names itself free whatever its case`);
    assert.equal(offered[id].api.npm, "@ai-sdk/openai-compatible", id);
  }
});

// Rows as OpenCode's console docs have them since 2026-10-12
// (services/www/src/docs/content/console/models.mdx), and the pricing table
// beside it that names no endpoint (yetone/magpie#2305): the zen.mdx these
// were read from before was removed that day. Two of the rows below are ones the
// parser has to leave out, and each is parsed on its own further down: the
// whole-object comparison cannot say which row produced what, so it cannot say
// that the pricing row produced nothing — a pricing row carries no endpoint at
// all, and an endpoint path that is not one of the four protocols
// (`/v1/models/…`, Gemini's) is not a protocol this plugin can ask.
const geminiRow =
  "| Gemini 3 Flash                  | gemini-3-flash                  | `https://opencode.ai/inference/v1/models/gemini-3-flash`        | `@ai-sdk/google`            |";
const pricingRow =
  "| Step 5 Preview Free               | Free            | Free            | Free            | -            |";

// The rows of the four free models the fixture below used to leave out — all
// four are Chat, which is what the snapshot says and what the docs table shows.
// Without them the consistency check at the bottom of this file only ever runs
// in one direction: it walks the ids these rows parsed, so a snapshot entry the
// docs do not carry was compared with nothing at all. Those are exactly the
// entries that route a listed model when the docs cannot be read, so a stale one
// is a silent misroute rather than a test failure.
const chatRow = (name, id) =>
  `| ${name.padEnd(31)} | ${id.padEnd(31)} | \`https://opencode.ai/inference/v1/chat/completions\`             | \`@ai-sdk/openai-compatible\` |`;
const consoleDocs = [
  "| Claude Haiku 4.5                | claude-haiku-4-5                | `https://opencode.ai/inference/v1/messages`                     | `@ai-sdk/anthropic`         |",
  geminiRow,
  "| Jev 1.13 Free                   | jev-1.13-free                   | `https://opencode.ai/inference/v1/systemone`                    | -                           |",
  "| Big Pickle                      | big-pickle                      | `https://opencode.ai/inference/v1/chat/completions`             | `@ai-sdk/openai-compatible` |",
  "| Step 5 Preview Free             | step-5-preview-free             | `https://opencode.ai/inference/v1/chat/completions`             | `@ai-sdk/openai-compatible` |",
  "| Muse Spark 1.3 Contributor Free | muse-spark-1.3-contributor-free | `https://opencode.ai/inference/v1/responses`                    | `@ai-sdk/openai`            |",
  chatRow("Space Bunny Free", "space-bunny-free"),
  chatRow("Cat Jam Free", "cat-jam-free"),
  chatRow("LongCat 2.5 Preview Free", "longcat-2.5-preview-free"),
  chatRow("MiMo-V2.6-Flash Free", "mimo-v2.6-flash-free"),
  chatRow("Nemotron 3.5 Lightning Free", "nemotron-3.5-lightning-free"),
  pricingRow,
].join("\n");

// Ids the docs name that are paid, which is why the free snapshot has no entry
// for them. The loop below holds every other parsed row against the snapshot,
// and a routine docs update that adds a paid row with a supported endpoint
// belongs in this set rather than reading as a snapshot that has gone stale.
const paidIds = new Set(["claude-haiku-4-5"]);

test("reads the console docs' endpoint table, and Jev stays out as SystemOne", async () => {
  const { buildModels, parseProtocolDocs, bootstrapProtocols } = await subject;
  assert.ok(
    bootstrapProtocols &&
      typeof bootstrapProtocols === "object" &&
      Object.keys(bootstrapProtocols).length > 0,
    "the console-docs snapshot must be exported as a non-empty object",
  );
  const protocols = parseProtocolDocs(consoleDocs);
  assert.deepEqual(protocols, {
    "claude-haiku-4-5": "anthropic",
    "jev-1.13-free": "systemone",
    "big-pickle": "chat",
    "step-5-preview-free": "chat",
    "muse-spark-1.3-contributor-free": "responses",
    "space-bunny-free": "chat",
    "cat-jam-free": "chat",
    "longcat-2.5-preview-free": "chat",
    "mimo-v2.6-flash-free": "chat",
    "nemotron-3.5-lightning-free": "chat",
  });
  // the two rows that must not have produced a protocol, each on its own
  assert.deepEqual(parseProtocolDocs(pricingRow), {}, "a pricing row names no endpoint");
  assert.deepEqual(parseProtocolDocs(geminiRow), {}, "an endpoint outside the four protocols");
  // the snapshot kept for when the docs can't be read says the same, for every
  // id it carries: the paid ids are the ones the free snapshot has no entry for,
  // and every other id here has to be in it
  for (const [id, protocol] of Object.entries(protocols)) {
    if (paidIds.has(id)) continue;
    assert.ok(Object.hasOwn(bootstrapProtocols, id), `${id} is missing from the free snapshot`);
    assert.equal(
      bootstrapProtocols[id],
      protocol,
      `${id}: the docs' endpoint and the free snapshot's protocol disagree`,
    );
  }
  // ...and the other direction, which is the one that was never checked: every
  // id the snapshot carries is one the docs describe, at the protocol it says.
  // The snapshot is what routes a listed model when the docs cannot be read, so
  // an entry the docs have since dropped or moved misroutes it silently.
  for (const [id, protocol] of Object.entries(bootstrapProtocols)) {
    assert.ok(Object.hasOwn(protocols, id), `${id} is in the snapshot but no docs row`);
    assert.equal(
      protocol,
      protocols[id],
      `${id}: the free snapshot's protocol and the docs' endpoint disagree`,
    );
  }
  const models = buildModels(["jev-1.13-free", "step-5-preview-free"], {}, protocols, baseURL);
  assert.deepEqual(Object.keys(models), ["step-5-preview-free"]);
});

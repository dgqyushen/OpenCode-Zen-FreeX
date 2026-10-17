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
    // Deprecated, and still listed — which is offered. "deprecated" is the
    // catalogue expecting a model to go, not a statement that it is gone: on
    // 2026-10-16 `muse-spark-1.2-contributor-free` carried exactly this status
    // while Zen listed it and the free tier answered a request for it, so
    // reading the status as an ending hid a model that was being served. The
    // endings are `lifecycle-free` below and the dated entries further down.
    "old-free": { status: "deprecated", cost: { input: 0, output: 0 } },
    // Retired through `lifecycle`, with a blank `status` written in front of it:
    // a blank status is not a status, so it must not hide the lifecycle.
    "lifecycle-free": { status: "", lifecycle: "retired", cost: { input: 0, output: 0 } },
    // ...and a blank status on its own retires nothing.
    "blank-status-free": { status: "", cost: { input: 0, output: 0 } },
    // Half-described: the catalogue describes it, and the package it gives the
    // model is one this plugin has no SDK for. The id names itself free, so the
    // rule for an id the catalogue cannot speak for is what answers it — before
    // that rule reached this shape, the entry merely being there dropped it.
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
  // `decision-free` is here, and the assertion it used to sit outside of is not
  // a weaker one for it: the catalogue describes this id and gives it a package
  // no SDK answers to, which is the same hole the `-free` rule exists for — an
  // id with no catalogue entry at all was already offered the same way. What
  // keeps a SystemOne id out is the docs naming its endpoint, which the test
  // below pins; a package name alone is not the docs.
  assert.deepEqual(Object.keys(models).sort(), [
    "blank-status-free",
    "coder-free",
    "decision-free",
    "late-free",
    "messages-free",
    "old-free",
    "responses-free",
    "zero-cost",
  ]);
  assert.equal(models["decision-free"].api.npm, "@ai-sdk/openai-compatible");
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
  const models = buildModels(["blank-status-free", "lifecycle-free"], provider, {}, baseURL);
  assert.deepEqual(Object.keys(models), ["blank-status-free"]);
});

// The statuses that are endings, and the one that is not. `muse-spark-1.2-
// contributor-free` is the measured case: the catalogue calls it deprecated, Zen
// lists it, and the free tier answered a request for it through this plugin on
// 2026-10-16 — so the list, which discovery reads, is what decides whether a
// model is still there, and a deprecated-but-listed model stays offered. The
// statuses that do end a model are read as they always were.
test("a status ends a model only when it says the model is gone", async () => {
  const { isFree } = await subject;
  for (const status of ["retired", "disabled"]) {
    assert.equal(isFree(`ended-${status}-free`, { status, cost: { input: 0, output: 0 } }), false, status);
  }
  for (const status of ["deprecated", "active"]) {
    assert.equal(isFree(`live-${status}-free`, { status, cost: { input: 0, output: 0 } }), true, status);
  }
  // The lifecycle field is the same vocabulary in the same place...
  assert.equal(isFree("ended-free", { lifecycle: "retired", cost: { input: 0, output: 0 } }), false);
  assert.equal(
    isFree("live-free", { lifecycle: "deprecated", cost: { input: 0, output: 0 } }),
    true,
    "deprecated through lifecycle is the same warning as through status",
  );
  // ...and an explicit flag or an effective date still ends one, whatever the
  // status beside it says.
  assert.equal(isFree("flagged-free", { deprecated: true, status: "active" }), false);
  assert.equal(
    isFree("scheduled-free", { status: "deprecated", retirement_date: "2026-11-01" }),
    false,
  );
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

// ...and the third way a field can fail to say anything, which is not about the
// value but about its shape. `isSet` asks whether a field says something, and
// `String` answered for a container as if it had: a list is one non-empty
// string, so `retirement_date: ["2026-01-01"]` — a field that states no date —
// retired the model, and the model left the offered list with nothing in the
// table and nothing in a note to say why. Every other shape rule in this file
// exists to prevent exactly that loss; a status and a date are single values,
// and a container is not one of them.
test("a retirement field written in another shape retires nothing", async () => {
  const { buildModels, isFree } = await subject;
  const free = { cost: { input: 0, output: 0 } };
  // The contrast is the shape and not the value: the string the catalogue really
  // writes retires the model, and a list holding that same string does not.
  assert.equal(isFree("dated-free", { ...free, retirement_date: "2026-01-01" }), false);
  for (const [axis, value] of [
    ["retirement_date", ["2026-01-01"]],
    ["retirement_date", {}],
    ["retirement_date", []],
    ["deprecated_at", [1]],
    ["deprecated_at", () => {}],
  ]) {
    const model = { ...free, [axis]: value };
    const label = `${axis} written as ${JSON.stringify(value) ?? typeof value}`;
    assert.equal(isFree(`shape-${axis}-free`, model), true, `${label} is not a date`);
    // "retires nothing" is about the offered list, so the id is asked for there
    const id = `shape-${axis}-free`;
    const offered = buildModels([id], { npm: "@ai-sdk/openai-compatible", models: { [id]: model } }, {}, baseURL);
    assert.deepEqual(Object.keys(offered), [id], label);
  }
  // The status is the same rule with its own half: a container says nothing, so
  // the `lifecycle` behind it is what is read — the ending the catalogue really
  // wrote. A blank status has always been read that way (the case above); a
  // container was not, and stood in front of the lifecycle as if it were a
  // status the model never had.
  assert.equal(isFree("container-status-free", { ...free, status: {}, lifecycle: "retired" }), false);
  // ...and a container status with nothing behind it retires nothing, whatever
  // it holds: `["retired"]` is a list, not the word
  for (const status of [[], {}, ["retired"]])
    assert.equal(
      isFree("container-only-free", { ...free, status }),
      true,
      `a status written as ${JSON.stringify(status)} is not a status`,
    );
  // A status the catalogue really wrote is still read as itself, which is what
  // keeps the rule above from being "a status never counts": it is set, and
  // being set it stands in front of the lifecycle as it always has.
  assert.equal(isFree("live-status-free", { ...free, status: "active", lifecycle: "retired" }), true);
  assert.equal(isFree("ended-status-free", { ...free, status: "retired", lifecycle: "active" }), false);
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

// The test above leaves the SystemOne exclusion with two possible reasons, and
// this is the one it must be: an id the *docs* name as SystemOne. `decision-free`
// is in that fixture's catalogue too, and its entry describes it with a package
// mapping to no protocol — so before the `-free` rule reached a described id,
// that entry alone dropped it and the docs row was never what did. The id here
// has no catalogue entry at all, so the fallback would hand it `chat`: it can
// only be missing when the docs named its endpoint, and `systemone` is not a
// protocol this plugin asks. The same id, with a catalogue entry that resolves
// to no protocol, is offered — the two halves are pinned together below.
test("a documented SystemOne endpoint keeps an undescribed id out", async () => {
  const { buildModels, parseProtocolDocs } = await subject;
  const protocols = parseProtocolDocs(
    "| Fresh | fresh-free | `https://opencode.ai/zen/v1/systemone` | - |",
  );
  assert.equal(protocols["fresh-free"], "systemone");
  assert.deepEqual(Object.keys(buildModels(["fresh-free"], {}, {}, baseURL)), ["fresh-free"]);
  assert.deepEqual(Object.keys(buildModels(["fresh-free"], {}, protocols, baseURL)), []);
});

// The hole the `-free` rule was written for, on the one shape it could not
// reach: an id the catalogue *does* describe, whose entry names a package no SDK
// answers to. The fallback used to be skipped for it — the entry was there, so
// the id was read as described and then dropped for a protocol nobody resolved —
// while the very same id with no catalogue entry at all was offered. Nothing
// about the two facts differs: neither the catalogue nor the package has said
// what this id speaks.
test("a catalogue entry that resolves to no protocol still leaves a free id to its own name", async () => {
  const { buildModels } = await subject;
  // the catalogue describes it and gives it a package `sdkProtocol` cannot read
  const described = buildModels(
    ["Foo-Free"],
    { npm: "@ai-sdk/openai-compatible", models: { "Foo-Free": { provider: { npm: "@vendor/nothing" }, limit: { context: 4096 } } } },
    {},
    baseURL,
  );
  assert.deepEqual(Object.keys(described), ["Foo-Free"]);
  assert.equal(described["Foo-Free"].api.npm, "@ai-sdk/openai-compatible");
  // the fallback is the provider's own protocol, not a guess at an endpoint: a
  // provider that speaks responses gets that one
  const elsewhere = buildModels(
    ["Foo-Free"],
    { npm: "@ai-sdk/openai", models: { "Foo-Free": { provider: { npm: "@vendor/nothing" } } } },
    {},
    baseURL,
  );
  assert.equal(elsewhere["Foo-Free"].api.npm, "@ai-sdk/openai");
  // ...and the two shapes the rule must not reach are unchanged: systemone named
  // by the docs keeps the id out however it names itself...
  const systemone = { "Foo-Free": "systemone", "Foo-FREE": "systemone" };
  assert.deepEqual(Object.keys(buildModels(["Foo-Free", "Foo-FREE"], {}, systemone, baseURL)), []);
  // ...and so does an id the catalogue describes, when the docs name its
  // endpoint: the docs' own name for it is what `protocols` carries here
  assert.deepEqual(
    Object.keys(
      buildModels(
        ["labeled-free"],
        { npm: "@ai-sdk/openai-compatible", models: { "labeled-free": {} } },
        { "labeled-free": "systemone" },
        baseURL,
      ),
    ),
    [],
  );
  // and the name the docs give is read as itself when it is one this plugin
  // asks, so the rule above is about `systemone` and not about the docs map
  const spoken = buildModels(["chatty-free"], {}, { "chatty-free": "chat" }, baseURL);
  assert.deepEqual(Object.keys(spoken), ["chatty-free"]);
  assert.equal(spoken["chatty-free"].api.npm, "@ai-sdk/openai-compatible");
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

// The catalogue writes `null` for a row it could not fill in, and one such row
// used to take the whole list with it: this loop read the entry as a
// description, `model.modalities?.input` on `null` threw, and the throw was
// discovery's — so a host that could have been offering every other free model
// offered none of them. An entry that is not an object describes nothing, which
// is a fact this file already knows how to state: the id is then read exactly
// like one the catalogue has no entry for, and is offered when it names itself
// free.
test("a malformed catalogue entry does not take the models that are described with it", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "coder-free": { cost: { input: 0, output: 0 }, limit: { context: 4096 } },
      "empty-free": null,
      "string-free": "not a model",
    },
  };
  const models = buildModels(["coder-free", "empty-free", "string-free"], catalogue, {}, baseURL);
  assert.deepEqual(Object.keys(models), ["coder-free", "empty-free", "string-free"]);
  assert.equal(models["coder-free"].limit.context, 4096, "the described model keeps what the catalogue says");
  // The row the catalogue could not fill in is read as an undescribed free id:
  // the provider's own protocol, and the defaults where the catalogue said
  // nothing. Said as "no title, not a model" rather than as a limit, because a
  // `null` read as a description is a description with `name: null` in it — the
  // model offered under a blank name is the same dirty row arriving one layer
  // further along.
  assert.equal(models["empty-free"].name, "empty-free", "a row that says nothing does not name the model");
  assert.equal(models["empty-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(models["empty-free"].limit, { context: 32768, output: 4096 });
  assert.equal(typeof models["string-free"], "object", "a row that is not an object is not a description");
  assert.equal(models["string-free"].name, "string-free");
  assert.equal(models["string-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(models["string-free"].limit, { context: 32768, output: 4096 });
  // ...and one that does not call itself free is still not offered on the
  // strength of a row that says nothing: the rule is the id's name or the
  // catalogue's word, and a `null` row is not the catalogue's word
  const notFree = buildModels(["empty-paid"], { npm: "@ai-sdk/openai-compatible", models: { "empty-paid": null } }, {}, baseURL);
  assert.deepEqual(Object.keys(notFree), []);
  // The rows the whole loop has to survive, each of which has a member read on it
  // by the caller of `buildModels` (provider.mjs reads `.cost` off `metadata.models`):
  // a `null` there is a TypeError out of a hook a host is waiting on. The empty
  // list is the row that is hardest to catch — `typeof []` is `"object"`, so it
  // passed the object test — and is read by the same rule: see the case below,
  // which is where that row's own shapes are pinned.
  for (const row of [null, [], "not a model", 17, true, undefined]) {
    const dirty = { npm: "@ai-sdk/openai-compatible", models: { "dirty-free": row } };
    const label = JSON.stringify(row) ?? String(row);
    const offered = buildModels(["dirty-free"], dirty, {}, baseURL);
    assert.deepEqual(Object.keys(offered), ["dirty-free"], `${label}: the id is still offered`);
    assert.equal(offered["dirty-free"].name, "dirty-free", `${label}: and under its own name`);
  }
  // The rule stated where it cannot be missed: a row the catalogue cannot be
  // read as a description is one this loop does not carry out of itself. What a
  // member read on the malformed values above cannot show — `(17).name` is
  // `undefined`, not a throw — is the difference between "read as nothing" and
  // "read as a description with holes in it", and that difference is exactly
  // what the guard is for; the rows above are the shapes the catalogue really
  // writes, and each of them being offered on its own name is the observable
  // half of the rule. What is left is stated as the rule it is.
  for (const axis of Object.keys(catalogue.models))
    assert.equal(
      Object.hasOwn(models, axis),
      true,
      `${axis}: a malformed row is still the id's own reason to be offered`,
    );
  // the same row does not become a description the way an inherited one must
  // not, and the result map's own prototype is untouched either way
  assert.equal(Object.getPrototypeOf(models), Object.prototype);
  assert.equal(Object.hasOwn(models, "__proto__"), false);
});

// The row that is a list, which is the same fact as `null` one step harder to
// see: `typeof []` is `"object"`, so it passed the "is it an object" test that
// `null` does not, and was then read as a description — from which nothing can
// be read, because a list has no `name` and no `cost` and no `limit` of its own.
// `provider.mjs` reads a row as a description by `isDescription`, which says a
// list is not one, and the two sides deciding differently about one row is a
// model whose fate depends on which file looked at it. This is that answer
// stated where the models it decides about can be counted.
test("an array is a row the catalogue could not fill in, not a description", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "described-free": { cost: { input: 0, output: 0 }, name: "Described", limit: { context: 4096 } },
      "empty-array-free": [],
      "empty-array-paid": [],
    },
  };
  const models = buildModels(["described-free", "empty-array-free", "empty-array-paid"], catalogue, {}, baseURL);
  // the row that is a description is untouched, and the ones beside it are what
  // says the list did not take the call with it
  assert.equal(models["described-free"].limit.context, 4096);
  // An id the row belongs to is offered exactly the way an id the catalogue has
  // no entry for is: on its `-free` name, at the provider's own protocol, with
  // the defaults where the catalogue said nothing.
  assert.deepEqual(Object.keys(models), ["described-free", "empty-array-free"]);
  assert.equal(models["empty-array-free"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(
    models["empty-array-free"].name,
    "empty-array-free",
    "a row that is not a description does not name the model",
  );
  assert.deepEqual(models["empty-array-free"].limit, { context: 32768, output: 4096 });
  // ...and one that does not call itself free gets nothing from the row at all,
  // rather than a protocol invented for something nobody could read
  assert.equal(Object.hasOwn(models, "empty-array-paid"), false);
  // The rule, stated where it can fail. A bare list reads the same either way:
  // every axis this loop consults is absent from an empty list and from an empty
  // object alike, so the fixture that can tell the two rules apart is a list
  // that *carries* something — a shape only a hand-built catalogue hands over,
  // and the shape the rule is about. Nothing a list carries is the catalogue's
  // word about the model.
  const named = Object.assign([], { name: "Array Row" });
  const namedModels = buildModels(
    ["named-free"],
    { npm: "@ai-sdk/openai-compatible", models: { "named-free": named } },
    {},
    baseURL,
  );
  assert.equal(
    namedModels["named-free"].name,
    "named-free",
    "a name hung on a list is not the catalogue naming the model",
  );
  // The cost is the one that decides who is offered at all: a zero-cost row
  // makes a model free, so a list carrying one would hand a host a model nobody
  // described — the silent arrival the free rules exist to prevent.
  const priced = Object.assign([], { cost: { input: 0, output: 0 }, name: "Array Row" });
  assert.deepEqual(
    Object.keys(
      buildModels(["priced-paid"], { npm: "@ai-sdk/openai-compatible", models: { "priced-paid": priced } }, {}, baseURL),
    ),
    [],
    "a cost hung on a list is not the catalogue calling the model free",
  );
  // ...and the same row through the free gate, where the id's own name is what
  // offers it: the list's numbers are still not the model's numbers
  const limited = Object.assign([], { limit: { context: 4096 }, name: "Array Row" });
  const limitedModels = buildModels(
    ["limited-free"],
    { npm: "@ai-sdk/openai-compatible", models: { "limited-free": limited } },
    {},
    baseURL,
  );
  assert.deepEqual(limitedModels["limited-free"].limit, { context: 32768, output: 4096 });
});

// The other half of the same rule, on the fields read as shapes rather than as
// values. `?? []` and `?? {}` cover a field the catalogue left out and nothing
// else, and these are the shapes it writes when it writes something else — each
// of which used to throw out of `buildModels`, which is discovery's: `.filter`
// is not a function on an object or a string, `option.type` on a `null` element
// is a TypeError, and `Object.entries` reads a list as its indices. One dirty
// field on one row took every free model with it, and the host was waiting on
// the hook that threw.
test("a field the catalogue wrote in another shape does not end the call", async () => {
  const { buildModels } = await subject;
  const catalogue = {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "kept-free": {
        cost: { input: 0, output: 0 },
        name: "Kept",
        reasoning_options: [{ type: "effort", values: ["low"] }],
      },
      "object-options-free": { cost: { input: 0, output: 0 }, reasoning_options: {} },
      "string-options-free": { cost: { input: 0, output: 0 }, reasoning_options: "low" },
      "null-element-free": {
        cost: { input: 0, output: 0 },
        reasoning_options: [null, { type: "effort", values: ["high"] }],
      },
      "string-values-free": { cost: { input: 0, output: 0 }, reasoning_options: [{ type: "effort", values: "low" }] },
    },
  };
  const ids = Object.keys(catalogue.models);
  const models = buildModels(ids, catalogue, {}, baseURL);
  assert.deepEqual(Object.keys(models), ids, "a wrong shape is not a reason to lose a row, or the rows beside it");
  // a list the catalogue did write is read exactly as it always was
  assert.deepEqual(Object.keys(models["kept-free"].variants), ["low"]);
  // and the ones it did not say nothing about are read as no efforts, which is
  // what a host shows as "this model has no effort settings" rather than as a
  // selection the catalogue never offered
  for (const id of ["object-options-free", "string-options-free", "string-values-free"])
    assert.deepEqual(Object.keys(models[id].variants), [], `${id}: no efforts can be read`);
  // the element that is not a description is skipped and the one beside it is
  // still read: a wrong element is not a wrong list
  assert.deepEqual(Object.keys(models["null-element-free"].variants), ["high"]);
  // The axis map: `Object.entries` reads a list as its indices, and a row whose
  // `limit` was `[111, 222]` handed the host
  // `{0: 111, 1: 222, context: 32768, output: 4096}` — two axes no catalogue
  // named, on the one object a host plans a prompt from.
  const listed = buildModels(
    ["limit-list-free"],
    { npm: "@ai-sdk/openai-compatible", models: { "limit-list-free": { cost: { input: 0, output: 0 }, limit: [111, 222] } } },
    {},
    baseURL,
  );
  assert.deepEqual(listed["limit-list-free"].limit, { context: 32768, output: 4096 });
  // a word is not an axis map either, and said here so the rule is one rule
  const word = buildModels(
    ["limit-word-free"],
    { npm: "@ai-sdk/openai-compatible", models: { "limit-word-free": { cost: { input: 0, output: 0 }, limit: "big" } } },
    {},
    baseURL,
  );
  assert.deepEqual(word["limit-word-free"].limit, { context: 32768, output: 4096 });
  // ...and a map that really is one is still read, on both levels: the
  // catalogue's own axes, and the evidence limits.mjs has for the id
  const real = buildModels(
    ["deepseek-v4.1-flash-free"],
    {
      npm: "@ai-sdk/openai-compatible",
      models: { "deepseek-v4.1-flash-free": { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 } } },
    },
    {},
    baseURL,
  );
  assert.deepEqual(real["deepseek-v4.1-flash-free"].limit, { context: 1048576, output: 384000 });
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
  // The free ids the tier was serving on 2026-10-16, whose snapshot entries the
  // consistency check at the bottom holds against these rows. The docs table
  // lists all four (the last one as its paid twin's endpoint, responses).
  chatRow("DeepSeek V4.1 Flash Free", "deepseek-v4.1-flash-free"),
  chatRow("GLM-5.3-Flash Free", "glm-5.3-flash-free"),
  chatRow("LL Alpha Free", "ll-alpha-free"),
  chatRow("Nemotron 3.5 Super VL Free", "nemotron-3.5-super-vl-free"),
  "| Muse Spark 1.2 Contributor Free | muse-spark-1.2-contributor-free | `https://opencode.ai/inference/v1/responses`                    | `@ai-sdk/openai`            |",
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
    "deepseek-v4.1-flash-free": "chat",
    "glm-5.3-flash-free": "chat",
    "ll-alpha-free": "chat",
    "nemotron-3.5-super-vl-free": "chat",
    "muse-spark-1.2-contributor-free": "responses",
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

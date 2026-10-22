import assert from "node:assert/strict";
import test from "node:test";
// The adaptive cases read and write real files: a state file is the one thing
// this module puts on disk, and a case with a stubbed file system would not be
// testing the one promise made about it — that a bracket survives a restart.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const subject = import("./limits.mjs").catch((error) => {
  assert.fail(`limits.mjs failed to load: ${error?.message ?? error}`);
});

const DECLARED = { context: 200000, output: 32000 };

// Every case here that is about the table, the catalogue or the bracket is
// answered with no sweep beside it — an empty string is how the environment says
// the snapshot is not there. The shipped file holds a measurement of the live
// route, which is not what these cases are asking about, and a suite whose
// expectations moved every time a scheduled run committed a new reading would be
// a suite nobody could keep green. The sweep's own tier has its cases at the end
// of this file, where it is handed a map or a file of its own.
const SNAPSHOT_ENV = "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT";
process.env[SNAPSHOT_ENV] = "";

// A case about the installed remote answer is a case about "no local source was
// named": the suite's module-level pin above is a local source (the empty one).
// Removing the variable for the length of the case is the documented way to say
// "nothing pinned here, use the installed answer"; restoring it afterwards keeps
// the rest of the file isolated from the operator's snapshot.
function unpinSnapshot() {
  const previous = process.env[SNAPSHOT_ENV];
  delete process.env[SNAPSHOT_ENV];
  return () => {
    if (previous === undefined) delete process.env[SNAPSHOT_ENV];
    else process.env[SNAPSHOT_ENV] = previous;
  };
}

const SHIPPED_SNAPSHOT = fileURLToPath(new URL("./limits-observed.json", import.meta.url));

// The brackets this suite learns are written by the module's debounced writer,
// and a test run may not write the operator's copy of that file: the cases below
// call `observeServedRequest`/`observeRefusedRequest`, which schedule that
// write, and `loadLimitState` puts records into the same global map the writer
// publishes. An empty value keeps the state in memory, which is what every case
// here wants — the cases that exercise the file itself name a path of their
// own. `index.test.mjs` and `models.test.mjs` say the same thing for the same
// reason.
process.env.OPENCODE_ZEN_FREE_LIMITS_STATE = "";

// A read that never ends is the shape of the defect this file's first fix is
// about: `readBoundedText` used to cancel a branch of `response.clone()`'s tee,
// which settles only once the sibling branch is drained, so a refusal bigger
// than the budget arriving in more than one read left the plugin's fetch pending
// forever. Every read below goes through a deadline, so that regression fails
// with a sentence instead of hanging the suite.
async function within(ms, promise, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not settle within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A body that arrives the way a network one does: several reads, with a
// statement free to fall across them. Every fixture this file had before was a
// single string, which is exactly the shape that hid the cut-number defect —
// one chunk leaves `text.length > limit`, so the old "was it cut?" test agreed
// with itself by accident.
function chunked(text, size) {
  const bytes = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < text.length; at += size)
        controller.enqueue(bytes.encode(text.slice(at, at + size)));
      controller.close();
    },
  });
}

function refusal(body, { status = 400, size } = {}) {
  return new Response(size ? chunked(body, size) : body, { status });
}

// A body that hands over its first `after` characters and then fails, the way a
// refusal on a connection that drops does. The read stops without reaching the
// budget, which is the shape a "was it cut?" test taken from the length of what
// was read cannot see.
function diesMidway(text, after) {
  const bytes = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.error(new Error("the body failed halfway"));
        return;
      }
      sent = true;
      controller.enqueue(bytes.encode(text.slice(0, after)));
    },
  });
}

// A body that hands over its first chunk and then never answers again until the
// reader gives up on it: the shape of an upstream that dies mid-body, or of
// headers promising more bytes than the response delivers (measured: a 403 with
// `content-length: 999` over a 120-byte body). Nothing about this shape ends the
// read on its own — only the wait does — and the promise the stalled read is
// waiting on is `cancel`'s to settle, so the fixture ends when the code under
// test releases it rather than leaving a pending promise and a live stream
// behind for the life of the process. `seen` is where it says so, which is the
// one fact a fixture that can never settle cannot state.
function stallsAfter(text, seen = {}) {
  const bytes = new TextEncoder();
  let sent = false;
  let release;
  return new ReadableStream({
    pull(controller) {
      if (sent)
        return new Promise((resolve) => {
          release = () => {
            seen.settled = true;
            resolve();
          };
        });
      sent = true;
      controller.enqueue(bytes.encode(text));
    },
    cancel() {
      release?.();
    },
  });
}

function stalled(text, seen) {
  return new Response(stallsAfter(text, seen), {
    status: 403,
    headers: { "content-length": "999" },
  });
}

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
  // The window is the last point this route is measured to serve, rounded down:
  // its refusal names no number and refuses 326,750 itself, so the declared
  // budget stops under it. The completion ceiling is the paid twin's declaration.
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", DECLARED), {
    context: 326000,
    output: 384000,
  });
});

test("a second id on another upstream, whose axes rest on different tiers, is declared the same way", async () => {
  const { limitOverrides } = await subject;
  // its window is the route's own enforcement, found by bracketing after the
  // window it used to state was contradicted; its output is the vendor's
  // catalogue entry, because this upstream names no completion ceiling
  assert.deepEqual(limitOverrides("mimo-v2.6-flash-free", DECLARED), {
    context: 375000,
    output: 131072,
  });
});

// The two the tier added on 2026-10-16, each measured that day. The declarations
// they are measured against are the catalogue's, and the axis that moves is the
// one the evidence is about — nothing else is touched.
test("the ids the tier added last do not keep the ceilings the catalogue gave them", async () => {
  const { limitOverrides } = await subject;
  // ll-alpha-free: the route's own refusal names a completion ceiling four times
  // what the catalogue declares, and its window is the catalogue's already.
  assert.deepEqual(limitOverrides("ll-alpha-free", { context: 262144, output: 65536 }), {
    output: 262144,
  });
  // glm-5.3-flash-free: its window is the route's own enforcement, measured on
  // 2026-10-19 after the paid twin's 1000000 was contradicted by a refusal; its
  // output is still the twin's, which nothing has contradicted.
  assert.deepEqual(limitOverrides("glm-5.3-flash-free", { context: 200000, output: 32000 }), {
    context: 323000,
    output: 131072,
  });
  // and the catalogue moving voids the axis it moved, as it does for every entry
  assert.deepEqual(limitOverrides("ll-alpha-free", { context: 262144, output: 131072 }), {});
});

// The third axis, and the one a catalogue derives rather than measures:
// space-bunny-free's declared `input` is its own `context − output`, and prompts
// of up to nearly twice it were served — while the input axis is what a host
// that shows a window displays. The window and the ceiling are what this route
// declares, and they are left alone.
test("an input the catalogue derives, and the route does not enforce, is raised to the window", async () => {
  const { limitOverrides } = await subject;
  assert.deepEqual(
    limitOverrides("space-bunny-free", { context: 1048576, input: 524288, output: 524288 }),
    { input: 1048576 },
  );
  // the staleness guard is the axis's own: a catalogue that moves the input
  // voids this entry rather than leaving the measured value behind
  assert.deepEqual(
    limitOverrides("space-bunny-free", { context: 1048576, input: 600000, output: 524288 }),
    {},
  );
  // and the other two axes stay exactly as declared
  assert.deepEqual(limitOverrides("space-bunny-free", { context: 1048576, output: 524288 }), {});
  // a live window is the strongest answer this axis has, and an input the
  // catalogue declares under it follows like any other measured window: left at
  // 180000, magpie reads `context_window` from the smaller of the two axes and the
  // window the route just named is never on screen at all
  const live = new Map([["live-input-free", 900000]]);
  const liveOutput = new Map([["live-input-free", 64000]]);
  assert.deepEqual(
    limitOverrides(
      "live-input-free",
      { context: 200000, input: 180000, output: 32000 },
      undefined,
      live,
      liveOutput,
    ),
    { context: 900000, input: 900000, output: 64000 },
    "an input under a live window is raised to it",
  );
});

// The window wording measured on ll-alpha-free's upstream: the same fact as the
// "maximum context length is N tokens" sentence, phrased as a parenthetical. A
// window this module cannot read is a window the plugin keeps under-declaring.
test("the second way a refusal states its window is read as the same fact", async () => {
  const { namedContextWindow } = await subject;
  assert.equal(
    namedContextWindow("The input (341480 tokens) is longer than the model's context length (262144 tokens)."),
    262144,
  );
  assert.equal(
    namedContextWindow("\"This endpoint's maximum context length is 1048576 tokens. However, you requested about 1496523 tokens\""),
    1048576,
  );
  // a sentence that names no window still names none
  assert.equal(namedContextWindow("the model's context length is unbounded"), undefined);
  // and a zero is not a window: the reader drops any number that is not usable,
  // so a wording like this cannot declare a model unusable
  assert.equal(namedContextWindow("context length (0 tokens)"), undefined);
});

test("evidence measured against another catalogue is void, and only on its own axis", async () => {
  const { limitOverrides } = await subject;
  // Zen moved the window it declares: the measured window is an answer to a
  // question nobody is asking any more, while the output axis was measured
  // against 32000 and still stands.
  assert.deepEqual(limitOverrides("mimo-v2.6-flash-free", { context: 250000, output: 32000 }), {
    output: 131072,
  });
  assert.deepEqual(limitOverrides("mimo-v2.6-flash-free", { context: 200000, output: 64000 }), {
    context: 375000,
  });
  assert.deepEqual(limitOverrides("mimo-v2.6-flash-free", {}), {});
  // The DeepSeek id obeys the same rule on both axes: its window was measured
  // against the catalogue's 200000, so a catalogue that moves it voids that axis
  // while the output stands, and a pair carrying both declarations keeps both.
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", { context: 250000, output: 32000 }), {
    output: 384000,
  });
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", { context: 200000, output: 64000 }), {
    context: 326000,
  });
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", {}), {});
});

test("a model with no evidence keeps exactly what the catalogue declared", async () => {
  const { limitOverrides } = await subject;
  assert.deepEqual(limitOverrides("nemotron-3.5-lightning-free", DECLARED), {});
  // beam-free is one of the two ids the table carries no entry for at all: every
  // size asked of it up to about 599,000 tokens was served, so there is nothing
  // measured to declare and the catalogue's own pair stands.
  assert.deepEqual(limitOverrides("beam-free", {}), {});
  // an id that is not an id at all must not reach the prototype chain for a
  // record: `table["toString"]` is a function, and reading an entry off it
  // would invent evidence for a model nobody declared
  for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    assert.deepEqual(limitOverrides(key, DECLARED), {}, `${key} must never yield phantom evidence`);
  }
});

test("a record carried only by the table's prototype is not evidence", async () => {
  const { limitOverrides } = await subject;
  const entry = { context: { value: 1000000, source: "route", declaredAt: 200000 } };
  // the keys Object.prototype carries are not the only ones an index read
  // answers for: a table with a prototype of its own hands back a record it
  // never declared, and an inherited record reads exactly like a measurement.
  // Only what the table itself holds is evidence.
  const inherited = Object.create({ "phantom-free": entry });
  assert.deepEqual(
    limitOverrides("phantom-free", DECLARED, inherited),
    {},
    "an entry the table never declared is not evidence",
  );
  // the same table still reads a record it does hold
  inherited["declared-free"] = entry;
  assert.deepEqual(limitOverrides("declared-free", DECLARED, inherited), { context: 1000000 });
  // and a table with no prototype at all reads the same as it always did
  const bare = Object.create(null);
  bare["bare-free"] = entry;
  assert.deepEqual(limitOverrides("bare-free", DECLARED, bare), { context: 1000000 });
});

test("a declaration carried only by the caller's prototype is not a declaration", async () => {
  const { limitOverrides } = await subject;
  const table = {
    "prototype-declared-free": {
      context: { value: 1000000, source: "route", declaredAt: 200000 },
    },
  };
  // The other half of the same rule: `declared` is handed in by a caller, and an
  // axis inherited from its prototype — or from a polluted `Object.prototype` —
  // would be read as the number the catalogue declared. That number feeds the
  // staleness compare, so an inherited one can void a real entry through the
  // drift note, or suppress an override meant for the model.
  const inherited = Object.create({ context: 200000 });
  inherited.output = 32000;
  assert.deepEqual(
    limitOverrides("prototype-declared-free", inherited, table),
    {},
    "an inherited context is not a declaration to measure against",
  );
  // the same pair declared as own properties is evidence, as it always was
  assert.deepEqual(
    limitOverrides("prototype-declared-free", { context: 200000, output: 32000 }, table),
    { context: 1000000 },
  );
});

// ...and the third read of the same rule, on the one line that was left out of
// it. `table[id]` and `declared[axis]` are own-property reads, and the record's
// own axis was not: read through the prototype, an axis nobody measured read
// exactly like one that was. What it then does is worse than the other two —
// the staleness compare asks whether `declaredAt` is still the catalogue's
// number and not whose axis the entry is, so an inherited entry passes it, and
// the raise-only rule reads `entry.source`, which the inherited value supplies
// too. A record the table handed over with one axis is then one override more
// than it declared.
test("an axis carried only by the record's prototype is not evidence", async () => {
  const { limitOverrides, LIMITS } = await subject;
  // The pair the caller declares is the one the inherited axis was measured
  // against, and the record's own axis is one the catalogue has not moved, so
  // nothing but the own-property rule stands between the inherited number and
  // the wire. `Object.create` is how a table built by hand gets there — and a
  // polluted `Object.prototype` is the same read with a prototype nobody wrote.
  const shared = { context: { value: 999999, source: "route", declaredAt: 200000 } };
  const record = Object.assign(Object.create(shared), {
    output: { value: 64000, source: "route", declaredAt: 32000 },
  });
  const table = { "phantom-axis-free": record };
  assert.equal(Object.hasOwn(record, "context"), false, "the fixture's window is inherited, not declared");
  assert.deepEqual(
    limitOverrides("phantom-axis-free", { context: 200000, output: 32000 }, table),
    { output: 64000 },
    "only the axis the record itself carries is evidence",
  );
  // the same axis written as the record's own property is the measurement it
  // looks like, so the silence above is the own-property rule and not the pair
  record.context = shared.context;
  assert.deepEqual(
    limitOverrides("phantom-axis-free", { context: 200000, output: 32000 }, table),
    { context: 999999, output: 64000 },
  );
  // and a marker on a prototype is the same read: no record declares it, so no
  // model is measured against it — on any table, shipped one included. The
  // prototype here is one this case made, and not `Object.prototype`: the
  // project's rules forbid writing to a native prototype, and a global patch
  // would put an enumerable key on every plain object in the process — the
  // fixtures of this file, the module under test and every other suite sharing
  // the runner — so that a `for...in` over any of them walks a key it never
  // had. The same read with a prototype nobody wrote is the read that matters.
  const carried = { context: { value: 999999, source: "route", declaredAt: 200000 } };
  const polluted = Object.assign(Object.create(carried), LIMITS);
  assert.deepEqual(
    limitOverrides("nothing-measured-free", { context: 200000, output: 32000 }, polluted),
    {},
    "a marker inherited by the table is not a record the table holds",
  );
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", { context: 200000, output: 32000 }, polluted), {
    context: 326000,
    output: 384000,
  });
  assert.equal(
    Object.prototype.context,
    undefined,
    "and the native prototype is left exactly as it was found",
  );
});

test("weaker evidence may raise a limit but never lower one", async () => {
  const { limitOverrides } = await subject;
  const table = {
    "vendor-lower-free": { context: { value: 100000, source: "vendor", declaredAt: 200000 } },
    "witnessed-raise-free": { output: { value: 64000, source: "witnessed", declaredAt: 32000 } },
    "route-lower-free": { context: { value: 100000, source: "route", declaredAt: 200000 } },
    "malformed-free": { context: { value: 0, source: "route", declaredAt: 200000 } },
    // the rule is per axis, and the input axis obeys it the same way
    "vendor-input-lower-free": { input: { value: 100000, source: "vendor", declaredAt: 200000 } },
    "route-input-lower-free": { input: { value: 100000, source: "route", declaredAt: 200000 } },
  };
  assert.deepEqual(limitOverrides("vendor-lower-free", DECLARED, table), {});
  assert.deepEqual(limitOverrides("witnessed-raise-free", DECLARED, table), { output: 64000 });
  // the route may say a window is smaller than the catalogue claims; a vendor
  // page or a witness may not, because that invents a restriction
  assert.deepEqual(limitOverrides("route-lower-free", DECLARED, table), { context: 100000 });
  assert.deepEqual(limitOverrides("malformed-free", DECLARED, table), {});
  assert.deepEqual(
    limitOverrides("vendor-input-lower-free", { context: 200000, input: 200000, output: 32000 }, table),
    {},
    "a vendor page does not get to take room away from a prompt",
  );
  assert.deepEqual(
    limitOverrides("route-input-lower-free", { context: 200000, input: 200000, output: 32000 }, table),
    { input: 100000 },
    "the route's own word does, on this axis as on the others",
  );
});

test("a refusal naming a window while the process runs outranks the shipped table forever after", async () => {
  const { observeRouteStatement, namedContextWindow, limitOverrides, limitObservations } =
    await subject;
  assert.equal(namedContextWindow(REFUSAL), 1048576);
  // The observation is this case's own, under an id no other case asserts on,
  // and the maps are put back when the case is done: they are module-global, so
  // an entry left in one would quietly change the answers later cases read
  // instead of failing them. What the shipped ids resolve to is asserted
  // separately, with nothing but the table in play.
  const held = limitObservations();
  const id = "observed-once-free";
  // The caller is still waiting on this response when the plugin reads it, so
  // observing has to be non-destructive in what it does with what it read: the
  // bytes come back with the answer, and the body is read exactly once — there
  // is no copy to hand out, and asking for one is what used to hang the request.
  const response = new Response(REFUSAL, {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  try {
    const observed = await within(
      1000,
      observeRouteStatement(id, response),
      "a one-chunk refusal",
    );
    assert.deepEqual(observed, { context: 1048576, output: undefined, text: REFUSAL, ended: true });
    assert.equal(response.bodyUsed, true, "the one read of the body is the reader's");
    // the live value is applied on the default path — no maps handed in — and it
    // outranks the declaration it was measured against
    assert.deepEqual(limitOverrides(id, DECLARED), { context: 1048576 });
    // an injected observation still stands in for it...
    const live = new Map([[id, 900000]]);
    assert.deepEqual(limitOverrides(id, DECLARED, undefined, live), { context: 900000 });
    // ...and an id the shipped table carries is answered from the table, which is
    // the same answer the observation above would have given it, read from one
    // place: the entry's own declared pair.
    assert.deepEqual(limitOverrides("mimo-v2.6-flash-free", DECLARED), {
      context: 375000,
      output: 131072,
    });
  } finally {
    limitObservations(held);
  }
});

// An upstream that validates the ceiling it was asked for says what the ceiling
// is, which is the one place a completion limit has been named by this route at
// all — the DeepSeek upstream accepts max_tokens 2000000 in silence.
const CEILING =
  '{"param":"max_tokens is too large: 200000. This model supports at most 131072 completion tokens, whereas you provided 200000.","type":"server_error"}';

test("a refusal that names a completion ceiling is read on the output axis too", async () => {
  const { namedOutputCap, namedContextWindow, observeRouteStatement, limitOverrides, limitObservations } =
    await subject;
  assert.equal(namedOutputCap(CEILING), 131072);
  assert.equal(namedContextWindow(CEILING), undefined);
  // The id is this case's own, and the maps go back as they were when it is
  // done. They are module state that outlives the case, so an observation left
  // under a name other cases use answers a later read of that name from this
  // case's measurement: `x-free` was that name, and the case below that reads it
  // came back `{ output: 131072 }` where it expects `{}` until the maps were put
  // back.
  const id = "observed-ceiling-free";
  const held = limitObservations();
  try {
    assert.deepEqual(await observeRouteStatement(id, new Response(CEILING, { status: 400 })), {
      context: undefined,
      output: 131072,
      text: CEILING,
      ended: true,
    });
    // the live value is applied on the default path, which is the path a host
    // takes: no maps handed in
    assert.deepEqual(limitOverrides(id, { context: 200000, output: 32000 }), { output: 131072 });
    const liveOutput = new Map([[id, 131072]]);
    assert.deepEqual(
      limitOverrides(id, { context: 200000, output: 32000 }, undefined, undefined, liveOutput),
      { output: 131072 },
    );
  } finally {
    limitObservations(held);
  }
  assert.equal(namedOutputCap('{"error":{"message":"supports at most 0 completion tokens"}}'), undefined);
});

// What the two cases above must not leave behind: the maps they observed into
// are module-global, so an entry left in one answers a later case from evidence
// that case never collected. None of these three ids is evidence for anything:
// two of them are the ones those cases chose for themselves, and the third is
// read here on the default path for exactly that reason.
test("the observations two cases stored are put back before the next case reads", async () => {
  const { limitOverrides } = await subject;
  for (const id of ["x-free", "observed-once-free", "observed-ceiling-free"]) {
    assert.deepEqual(
      limitOverrides(id, DECLARED),
      {},
      `${id}: an observation another case made is not evidence for this one`,
    );
  }
});

test("an id whose ceiling the route stated and whose window rests on the catalogue moves one axis only", async () => {
  const { limitOverrides } = await subject;
  // longcat-2.5-preview-free: the ceiling is the route's own sentence, and its
  // window is the catalogue's — the refusal that named 262144 also called the
  // endpoint's window 1000000, which is what the catalogue already declares, so
  // there is nothing to override on that axis.
  assert.deepEqual(
    limitOverrides("longcat-2.5-preview-free", { context: 1000000, input: 160000, output: 131072 }),
    { output: 262144 },
  );
  // and the axis nothing was measured for is left exactly as the catalogue
  // declared it, `input` included
  assert.deepEqual(limitOverrides("longcat-2.5-preview-free", { context: 250000, output: 131072 }), {
    output: 262144,
  });
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

// The third wording this route has for a completion ceiling, and the only one
// that states it as a range. Measured 2026-10-19 against deepseek-v4.1-flash-free:
// `max_tokens: 393216` is served, and the number past it comes back in this
// sentence while the window refusal from the same run names no number at all. So
// of the two axes this is the one the route still states out loud while it runs,
// and it states it about the axis the shipped table had only inferred from a twin.
const RANGE_WORDING =
  '{"error":{"param":null,"type":"invalid_request_error","code":"invalid_request_error",' +
  '"message":"Upstream request failed: [invalid_request_error] Invalid max_tokens value, ' +
  'the valid range of max_tokens is [1, 393216] (request_id: c05a28eb)"}}';

test("a ceiling stated as a range is read at the end that is the ceiling", async () => {
  const { namedOutputCap, namedContextWindow } = await subject;
  assert.equal(namedOutputCap(RANGE_WORDING), 393216);
  // The first number is the floor of the range, so the second is the one captured:
  // a range whose ends differ says which end was read.
  assert.equal(namedOutputCap("the valid range of max_tokens is [65536, 262144]"), 262144);
  // A sentence about max_tokens says nothing about the window, and reading the
  // range's number onto that axis would take the smaller of the two as a budget.
  assert.equal(namedContextWindow(RANGE_WORDING), undefined);
  // LongCat's wording puts its ceiling last in the body, where a read that stops
  // inside the digits leaves a smaller number that still looks complete, so that
  // one needs the cut guard. This one cannot fail that way: the closing bracket is
  // part of the pattern, and a read that stops inside the digits matches nothing
  // and leaves the axis unread, which is the direction this has to fail in.
  assert.equal(namedOutputCap("the valid range of max_tokens is [1, 39321"), undefined);
  assert.equal(namedOutputCap("the valid range of max_tokens is [1, 393216"), undefined);
});

test("a range-stated ceiling goes past the twin-derived number the table carries", async () => {
  const { observeRouteStatement, limitOverrides, limitObservations } = await subject;
  // The shipped table gives this id 384000 on the strength of a sibling id and
  // DeepSeek's own page, which is tier `route-twin` and not a statement about this
  // route. The route saying 393216 about itself is newer and better, and it is
  // higher, so it is also the direction the raise-only rule allows on its own.
  const held = limitObservations();
  try {
    assert.deepEqual(
      await observeRouteStatement("deepseek-v4.1-flash-free", new Response(RANGE_WORDING, { status: 400 })),
      { context: undefined, output: 393216, text: RANGE_WORDING, ended: true },
    );
    assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", DECLARED), {
      context: 326000,
      output: 393216,
    });
  } finally {
    limitObservations(held);
  }
  // Put back, and read here on the default path for exactly that reason: a
  // statement left under this id would answer every later case from a refusal it
  // never made, including the ones that assert what this id's ceiling is.
  assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", DECLARED), {
    context: 326000,
    output: 384000,
  });
});

// Every body below was captured from this route on 2026-10-19, and the rows that
// answer `undefined` are the whole reason the classifier exists. This route
// answers a 5xx, a rate limit and a 400 about a parameter exactly as readily as
// it answers a prompt that was too long — same status, same content type, a body
// that parses — and a bracket that took one of those for a wall would declare a
// model smaller than the route has already served it and spend part of a refusal
// budget four refusals deep. The statuses are the route's own; the axes are what
// `namedAxes` reads from the same body, so the two halves of the read are judged
// together rather than twice.
const REFUSALS = [
  [
    400,
    '{"error":{"message":"Your request resulted in more tokens than this model\'s maximum context length allows. Please reduce the length of the messages or run compaction.","code":"context_length_exceeded"}}',
    {},
    "context",
    "deepseek-v4.1-flash-free at 1,522,600 characters: the unnamed too-long refusal, which is the one this route sends most",
  ],
  [
    400,
    '{"error":{"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] Requested token count exceeds the model\'s maximum context length of 200000 tokens"}}',
    {},
    "context",
    "big-pickle, seen by `bun run limits:audit`: the same fact in different words, and the words are all there is",
  ],
  [
    400,
    '{"error":{"type":"server_error","message":"Upstream request failed: [400] This endpoint\'s maximum context length is 1000000 tokens. However, you requested about 1001494 tokens (50 of text input, 1444 of tool input, 1000000 in the output)."}}',
    { context: 1000000 },
    "context",
    "nemotron-3.5-lightning-free: names the window, so the number decides before the words do",
  ],
  [
    400,
    'data: {"error":{"param":"max_tokens is too large: 1000000. This model supports at most 131072 completion tokens, whereas you provided 1000000.","type":"server_error","message":"Streaming response failed: [400] Param Incorrect"}}',
    { output: 131072 },
    "output",
    "big-pickle: about the completion ceiling, so it says nothing about the window even though the request was refused",
  ],
  [
    400,
    "Upstream request failed: [invalid_parameter] 参数校验失败: \n/max_tokens: 1000000 is not less or equal to 262144\n",
    { output: 262144 },
    "output",
    "longcat-2.5-preview-free: the second ceiling wording, and not a window either",
  ],
  [
    500,
    "",
    {},
    undefined,
    "nemotron-3.5-super-vl-free answered this to two asks and then served the identical requests: a fault is not a wall",
  ],
  [
    400,
    '{"error":{"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] invalid request"}}',
    {},
    undefined,
    "space-bunny-free, asked for a ceiling of 1000000: names nothing, so nothing is learned from it",
  ],
  [
    429,
    '{"error":{"message":"limited","type":"rate_limit_error"}}',
    {},
    undefined,
    "the rate limit this suite's own route answers with: it is about how often, not how much",
  ],
  [413, "", {}, undefined, "a status that can be about size with a body that says nothing is still nothing"],
];

test("a refusal is read for the axis it is about, and a fault is read for no axis", async () => {
  const { refusalAxis } = await subject;
  for (const [status, text, axes, axis, why] of REFUSALS)
    assert.equal(refusalAxis(status, text, axes), axis, `${status} ${why}`);
  // A status that cannot be about size is not rescued by a body that talks about
  // it: the same words arrive in the prose of a model's own answer, which is a
  // 200 and never reaches this, and in the error a gateway wraps around a fault.
  assert.equal(refusalAxis(502, "maximum context length", {}), undefined);
  assert.equal(refusalAxis(400, "maximum context length", {}), "context");
});

// LongCat's wording ends with the digits it captured, and the body is read only
// up to a budget. A cut inside those digits leaves a smaller number that looks
// complete — and that number would be stored as live evidence, past the
// catalogue-staleness check and past the downgrade guard, and sent as
// max_tokens on every request after it.
const CEILING_WORDING =
  "Upstream request failed: [invalid_parameter] 参数校验失败: \n/max_tokens: 1000000 is not less or equal to 262144\n";

// The cut guard has two homes in this file — the one-chunk shapes and the same
// body read a character at a time — so both go through one helper: each asserts
// the same three things (no axis read, and the bytes that came back), and a
// later edit cannot leave one of the two homes checking less than the other.
async function readCutAt(observe, id, limit, shape, size) {
  const at = CEILING_WORDING.indexOf("262144");
  const read = await within(
    1000,
    observe(id, refusal(CEILING_WORDING, { size, status: 400 }), limit),
    `the refusal cut at ${limit} (${shape})`,
  );
  assert.equal(
    read.output,
    undefined,
    `a read that stops inside 262144 must not be taken as a ceiling (limit ${limit}, ${shape}, would read "${CEILING_WORDING.slice(at, limit)}")`,
  );
  assert.equal(read.context, undefined, `and it names no window either (limit ${limit}, ${shape})`);
  // what comes back is what was consumed: one character past the budget is
  // read to learn the body went on, and handed on with the rest of it
  assert.equal(
    read.text,
    CEILING_WORDING.slice(0, limit + 1),
    `the bytes read (limit ${limit}, ${shape})`,
  );
  assert.equal(read.ended, false, `and it says the body did not end there (limit ${limit}, ${shape})`);
  return read;
}

test("a body cut inside the ceiling it names is not read as a smaller ceiling", async () => {
  const { observeRouteStatement, limitOverrides, namedOutputCap, LIMITS, limitObservations } = await subject;
  const at = CEILING_WORDING.indexOf("262144");
  // The whole body below is observed through the module's live output map, and
  // that map outlives the case: an entry left in it answers a later read of this
  // id from this refusal instead of from the shipped entry — which is exactly
  // the confusion the assertions at the end exist to rule out — so the pair is
  // held and put back in a `finally`, as the observation cases above do.
  const held = limitObservations();
  try {
    // whole, and cut after the number is complete: the ceiling is read
  assert.equal(namedOutputCap(CEILING_WORDING), 262144);
  assert.deepEqual(
    await observeRouteStatement("longcat-2.5-preview-free", new Response(CEILING_WORDING, { status: 400 })),
    { context: undefined, output: 262144, text: CEILING_WORDING, ended: true },
  );
  // cut inside it: no axis is read at all, so nothing reaches the declaration.
  // The read that ends on the last digit counts too — there is no way to tell it
  // from that same digit being the first of a longer number. Both shapes are
  // read: one string, which is everything this test used to have, and the same
  // body one character per read, which is how a refusal actually arrives.
  for (let limit = at + 1; limit <= at + 6; limit++) {
    for (const [shape, size] of [
      ["one chunk", undefined],
      ["one character per read", 1],
    ]) {
      await readCutAt(observeRouteStatement, "longcat-2.5-preview-free", limit, shape, size);
    }
  }
  // a refusal that dies before it finishes is not a whole one either, and this
  // is the shape the old "was it cut?" test — more text than the budget — could
  // not see: the read never reached the budget, and half a number read before
  // the connection dropped is exactly what must not be stored
  const died = await within(
    1000,
    observeRouteStatement(
      "longcat-2.5-preview-free",
      new Response(diesMidway(CEILING_WORDING, at + 4), { status: 400 }),
      at + 12,
    ),
    "the refusal that failed halfway",
  );
  assert.equal(died.output, undefined, "a number at the end of a body that never finished is not a ceiling");
  // and the declaration is still the one the table measured, not the half number.
  //
  // Read from the table rather than only through `limitOverrides`, because that
  // call answers from two places: a live observation for this id outranks the
  // table, so the pair below would have been satisfied by the run-time
  // observation alone. The entry the plugin ships is a fact of its own — it has
  // the measured ceiling, and it names the catalogue value it was measured
  // against, which is what makes it live rather than stale.
  assert.equal(
    LIMITS["longcat-2.5-preview-free"]?.output?.value,
    262144,
    "the shipped ceiling has to be the measured one, not only what a live refusal would say",
  );
  assert.equal(
    LIMITS["longcat-2.5-preview-free"]?.output?.declaredAt,
    131072,
    "and it has to carry the catalogue value it was measured against, which is what survives staleness",
  );
  assert.deepEqual(limitOverrides("longcat-2.5-preview-free", { context: 1000000, output: 131072 }), {
    output: 262144,
  });
  } finally {
    limitObservations(held);
  }
});

test("a chunked body cut inside a number stores nothing, and the same body whole is read", async () => {
  const { observeRouteStatement, limitOverrides } = await subject;
  const at = CEILING_WORDING.indexOf("262144");
  // an id with no entry in the table: anything stored live shows up in the
  // declaration below, which is exactly where 2621 used to appear
  const id = "chunked-cut-free";
  for (let limit = at + 1; limit <= at + 6; limit++) {
    await readCutAt(observeRouteStatement, id, limit, "one character per read", 1);
  }
  assert.deepEqual(limitOverrides(id, { context: 1000000, output: 131072 }), {});
  // the same body in five-character reads, with room for all of it: the ceiling
  // is read as stated, so the guard is about the cut and not about the shape
  const whole = await within(
    1000,
    observeRouteStatement(id, refusal(CEILING_WORDING, { size: 5, status: 400 })),
    "the chunked refusal read whole",
  );
  assert.deepEqual(whole, { context: undefined, output: 262144, text: CEILING_WORDING, ended: true });
  assert.deepEqual(limitOverrides(id, { context: 1000000, output: 131072 }), { output: 262144 });
});

test("a number the read stopped after is read when the text after it proves it ended", async () => {
  const { observeRouteStatement } = await subject;
  // The guard is about digits that reach the last character read. A number whose
  // digits are followed, inside the head, by a character the greedy `(\d+)`
  // refused to consume ended there — a match running on past the digits is not
  // evidence they were cut. Judging the cut by the match's own end threw away
  // numbers that were provably whole, and with them the under-declaration this
  // table exists to correct.
  const at = CEILING_WORDING.indexOf("262144");
  const ceiling = await within(
    1000,
    observeRouteStatement(
      "whole-number-free",
      refusal(`${CEILING_WORDING}${" ".repeat(50)}`, { status: 400 }),
      at + 7,
    ),
    "the refusal read one character past the ceiling",
  );
  assert.equal(ceiling.output, 262144, "the newline after the digits proves they ended");
  assert.equal(ceiling.ended, false, "and the body did not end there");

  // The same for the wording whose match runs on into " completion tokens": the
  // digits end well before the read does, with words after them.
  const window = "this endpoint's maximum context length is 1048576 tokens, and further text follows";
  const digits = window.indexOf("1048576") + "1048576".length;
  const context = await within(
    1000,
    observeRouteStatement(
      "whole-window-free",
      refusal(window, { status: 400 }),
      digits + " tokens".length,
    ),
    "the refusal read through the words after the window",
  );
  assert.equal(context.context, 1048576, "the words after the digits are not part of the number");
  assert.equal(context.ended, false);
});

test("only a refusal that names a window is read, and only its first few KiB", async () => {
  const { observeRouteStatement, namedContextWindow } = await subject;
  assert.equal(namedContextWindow(""), undefined);
  assert.equal(namedContextWindow('{"error":{"message":"invalid request"}}'), undefined);
  assert.equal(namedContextWindow(undefined), undefined);
  assert.equal(namedContextWindow('{"error":{"message":"maximum context length is 0 tokens"}}'), undefined);
  // a refusal is read; the answer to a served request is not — and "not read"
  // has to mean the body is still there for its caller, since a drained 2xx
  // body is an answer nobody can read any more, which is the failure this whole
  // reading path was rebuilt around
  const served = new Response(REFUSAL, { status: 200 });
  assert.equal(await observeRouteStatement("x-free", served), undefined);
  assert.equal(served.bodyUsed, false, "a served answer is left for its caller to read");
  // a refusal that names nothing is read all the same — the caller has to be
  // able to hand the body on — and it says so by naming no axis
  const namesNothing = '{"error":{"message":"Upstream failed"}}';
  assert.deepEqual(await observeRouteStatement("x-free", new Response(namesNothing, { status: 400 })), {
    context: undefined,
    output: undefined,
    text: namesNothing,
    ended: true,
  });
  // a 4xx that says what it wants only past the read budget names nothing, and
  // what was read comes back: the budget and the one character past it that
  // says the body went on — with `ended` saying it did not end there, which is
  // what a caller has to know before handing those bytes on as the reply
  assert.deepEqual(
    await observeRouteStatement("x-free", new Response(" ".repeat(5000) + REFUSAL, { status: 400 })),
    { context: undefined, output: undefined, text: " ".repeat(4097), ended: false },
  );
  // nothing here may throw into a request that is on its way to a caller
  assert.equal(await observeRouteStatement("x-free", undefined), undefined);
  assert.equal(await observeRouteStatement("x-free", new Response(null, { status: 400 })), undefined);
  assert.equal(await observeRouteStatement("", new Response(REFUSAL, { status: 400 })), undefined);
});

test("a refusal whose body cannot be read says so, rather than reading as empty", async () => {
  const { observeRouteStatement } = await subject;
  // A body that fails before it delivers anything: there are no bytes to hand
  // on, and `ended` is the only thing that says so. A defined observation with
  // an empty `text` and no such flag reads exactly like a body that arrived
  // empty, and the caller relays one of those two facts to the host.
  const broken = new ReadableStream({
    start(controller) {
      controller.error(new Error("connection reset"));
    },
  });
  const read = await within(
    1000,
    observeRouteStatement("broken-body-free", new Response(broken, { status: 400 })),
    "the refusal whose body failed",
  );
  assert.deepEqual(read, { context: undefined, output: undefined, text: "", ended: false });
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
  // the window is the wall this route enforces, with a margin; the output is the
  // paid twin's declaration
  assert.deepEqual(models["deepseek-v4.1-flash-free"].limit, { context: 326000, output: 384000 });
  assert.deepEqual(models["mimo-v2.6-flash-free"].limit, { context: 375000, output: 131072 });
  // all three axes have evidence for this one: the catalogue's `input` of 160000
  // was falsified by the same served prompt that set the window, at more than
  // twice the declaration
  assert.deepEqual(models["big-pickle"].limit, { context: 375000, input: 375000, output: 131072 });
  // the input axis is one of the axes now: this one's declared input is its own
  // context − output, falsified by prompts of up to nearly twice it served, so
  // the input moves to the window while the window and the ceiling stay as
  // declared
  assert.deepEqual(models["space-bunny-free"].limit, {
    context: 1048576,
    input: 1048576,
    output: 524288,
  });
});

// The shape that hung the plugin's whole fetch. `readBoundedText` used to read
// `response.clone().body` and cancel that reader; a tee's branch cancel settles
// only once the sibling branch is drained or cancelled, and the sibling here is
// the body the caller reads later, after this promise has been awaited — so the
// request never finished. A one-chunk body settled anyway, which is why nothing
// caught it. The read is of the response's own stream now, and the reader it
// cancels is the one it owns.
test("a refusal larger than the budget that arrives in pieces settles", async () => {
  const { observeRouteStatement } = await subject;
  const filler = "y".repeat(1400);
  const body = REFUSAL + " " + filler.repeat(4); // five reads, well over 4096
  assert.ok(body.length > 4096, "the fixture has to be larger than the read budget");
  const response = refusal(body, { size: 1400, status: 400 });
  const read = await within(1000, observeRouteStatement("chunked-free", response), "a chunked refusal over budget");
  assert.equal(read.context, 1048576, "the statement is inside the budget and is still read");
  assert.equal(read.output, undefined, "and nothing else is invented from the filler");
  // what was consumed comes back: the budget and the character that says the
  // body went on, which the caller needs to rebuild the response it holds
  assert.equal(read.text, body.slice(0, 4097));
  assert.equal(response.bodyUsed, true, "the body is read once, by the reader that hands it back");
});

test("the bounded read says whether it saw the whole body, and hands back what it read", async () => {
  const { readBoundedText } = await subject;
  const states = async (body, limit, size) =>
    within(1000, readBoundedText(size ? refusal(body, { size }) : new Response(body, { status: 400 }), limit), "the bounded read");
  // the whole body inside the budget
  assert.deepEqual(await states("hello", 16), { text: "hello", ended: true, over: false });
  // exactly the budget: the read is allowed the one character that tells it the
  // body ended there, so a body landing on the budget is not reported as cut
  assert.deepEqual(await states("0123456789", 10), { text: "0123456789", ended: true, over: false });
  // one character past it, in one read and in reads of two
  assert.deepEqual(await states("0123456789!", 10), { text: "0123456789!", ended: false, over: true });
  assert.deepEqual(await states("0123456789!", 10, 2), { text: "0123456789!", ended: false, over: true });
  // a response with no body at all has nothing to read and nothing to buffer
  assert.deepEqual(await within(1000, readBoundedText(new Response(null, { status: 400 }), 10), "no body"), {
    text: "",
    ended: true,
    over: false,
  });
  // a body somebody else is holding reads nothing, and does not claim it ended
  const held = new Response("held", { status: 400 });
  held.body.getReader();
  assert.deepEqual(await within(1000, readBoundedText(held, 10), "a held body"), {
    text: "",
    ended: false,
    over: true,
  });
});

// The read stops at the budget, so the buffer may hold one character past it and
// no more: a refusal is an error path, and a 64 KB chunk must not be
// materialised to read the first 64 characters of it.
test("a body larger than the budget is read bounded and the rest is released", async () => {
  const { readBoundedText } = await subject;
  let pulled = 0;
  let released = false;
  const endless = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
    },
    cancel() {
      released = true;
    },
  });
  const read = await within(1000, readBoundedText(new Response(endless, { status: 400 }), 64), "the bounded read");
  assert.equal(read.text.length, 65, "the budget and the one character past it");
  assert.equal(read.over, true);
  assert.equal(read.ended, false);
  assert.ok(pulled <= 2, `the source must not be drained into the buffer (read ${pulled} chunks)`);
  assert.equal(released, true, "the rest of the body is released rather than left open");
});

// The guard used to run on the first pattern that matched and the number came
// from the first pattern that named one, which are not always the same match: a
// wording that matches but names no ceiling (here, "at most 0") sat far from the
// cut, so the guard saw nothing to do, and the ceiling that ended exactly on the
// cut was returned by a different pattern. Both now come from one match.
test("a ceiling ending on the cut is not read, even when another wording matches first", async () => {
  const { observeRouteStatement, namedOutputCap, limitOverrides } = await subject;
  const body = "supports at most 0 completion tokens. /max_tokens: 1000000 is not less or equal to 262144 tail";
  const at = body.indexOf("262144");
  assert.equal(namedOutputCap(body), 262144, "the whole body names the second wording's ceiling");
  const read = await within(
    1000,
    observeRouteStatement("two-wordings-free", refusal(body, { size: 1, status: 400 }), at + 6),
    "the read stopping on the last digit",
  );
  assert.equal(read.output, undefined, "a number ending on the cut is not a ceiling");
  assert.deepEqual(
    limitOverrides("two-wordings-free", { context: 1000000, output: 131072 }),
    {},
    "and nothing was stored for it",
  );
});

// A live value is applied past the staleness guard and past the raise-only rule,
// which is the one decision here with nothing to see afterwards. The note says
// what was applied and what it stands in for; without a sink, nothing is said.
test("an applied live value is reported to a diagnostic sink, and only to one", async () => {
  const { observeRouteStatement, limitDiagnostics, limitOverrides } = await subject;
  const notes = [];
  const previous = limitDiagnostics((entry) => notes.push(entry));
  try {
    await observeRouteStatement("noted-free", refusal(REFUSAL, { status: 400 }));
    assert.deepEqual(notes, [], "reading a refusal applies nothing on its own");
    assert.deepEqual(limitOverrides("noted-free", { context: 200000, output: 32000 }), { context: 1048576 });
    assert.deepEqual(notes, [
      { kind: "route-statement", id: "noted-free", axis: "context", value: 1048576, declared: 200000 },
    ]);
    // the same refusal read again cannot change what was already applied
    notes.length = 0;
    await observeRouteStatement("quiet-free", refusal(REFUSAL, { status: 400 }));
    assert.deepEqual(limitOverrides("quiet-free", { context: 1048576, output: 32000 }), {}, "no change, no note");
    assert.deepEqual(notes, [], "a value that replaces nothing is not worth a line");
  } finally {
    limitDiagnostics(previous);
  }
  // the sink is off again: a host that asked for nothing hears nothing
  await observeRouteStatement("unnoted-free", refusal(REFUSAL, { status: 400 }));
  assert.deepEqual(limitOverrides("unnoted-free", { context: 200000, output: 32000 }), { context: 1048576 });
  assert.deepEqual(notes, []);
});

// An entry the catalogue has moved past is void, and that used to be
// indistinguishable from an axis nobody ever measured. The note is the
// difference; an entry that still applies, and an id with no entry at all, are
// both silent.
test("an entry the catalogue has moved past says so, and one that applies says nothing", async () => {
  const { limitOverrides, limitDiagnostics } = await subject;
  const notes = [];
  const previous = limitDiagnostics((entry) => notes.push(entry));
  const fresh = () => new Map(); // no live value: the table is what is being read
  try {
    assert.deepEqual(
      limitOverrides("mimo-v2.6-flash-free", { context: 200000, output: 32000 }, undefined, fresh(), fresh()),
      { context: 375000, output: 131072 },
    );
    assert.deepEqual(notes, [], "an entry that applies has nothing to explain");
    // the catalogue moved: the window was measured against a question nobody is
    // asking any more, while the output axis still stands
    assert.deepEqual(
      limitOverrides("mimo-v2.6-flash-free", { context: 250000, output: 32000 }, undefined, fresh(), fresh()),
      { output: 131072 },
    );
    // the axis is not declared at all any more: the same rule, said the same way
    assert.deepEqual(
      limitOverrides("mimo-v2.6-flash-free", { output: 32000 }, undefined, fresh(), fresh()),
      { output: 131072 },
    );
    // no entry is no evidence, which is a different thing and stays quiet
    assert.deepEqual(limitOverrides("never-measured-free", DECLARED, undefined, fresh(), fresh()), {});
  } finally {
    limitDiagnostics(previous);
  }
  assert.deepEqual(notes, [
    {
      kind: "catalogue-drift",
      id: "mimo-v2.6-flash-free",
      axis: "context",
      value: 375000,
      measuredAgainst: 200000,
      declared: 250000,
    },
    {
      kind: "catalogue-drift",
      id: "mimo-v2.6-flash-free",
      axis: "context",
      value: 375000,
      measuredAgainst: 200000,
      declared: undefined,
    },
  ]);
});

// The sink is for a host that wants the notes in its own log; the variable is
// for a user who has none and wants them on stderr. Neither may talk by itself.
test("the same notes reach stderr when the environment asks for them", async () => {
  const { limitOverrides, LIMITS_DEBUG_ENV } = await subject;
  const lines = [];
  const warn = console.warn;
  try {
    // Both side effects go on inside the `try` whose `finally` takes them off.
    // `console` and the environment are the process's, so an assignment made
    // outside the restore's own guard is one that outlives this case's failure —
    // and a `console.warn` left behind is a stub every later case writes into.
    console.warn = (line) => lines.push(line);
    process.env[LIMITS_DEBUG_ENV] = "1";
    limitOverrides("mimo-v2.6-flash-free", { context: 250000, output: 32000 }, undefined, new Map(), new Map());
  } finally {
    delete process.env[LIMITS_DEBUG_ENV];
    console.warn = warn;
  }
  assert.equal(lines.length, 1, "one line for the one axis the catalogue voided");
  assert.match(
    lines[0],
    /mimo-v2\.6-flash-free context=375000 was measured against a catalogue that declared 200000, and this one declares 250000: not applied/,
  );
});

// A body can stall as well as be large, and the read is bounded in time as well
// as in size: a 403 whose `content-length` promised 999 bytes over a 120-byte
// body left `read()` pending for good, which hung the request exactly as the
// clone did. Nothing here supplies a signal, so this is the deadline the module
// keeps for itself; the watchdog is well above it and well below the test
// runner's own, so a regression fails with a sentence about the read.
test("a body that stalls is given up on, and what it did read comes back cut", async () => {
  const { readBoundedText } = await subject;
  const seen = {};
  const read = await within(
    4500,
    readBoundedText(stalled(REFUSAL, seen), 4096),
    "the read of a stalled body",
  );
  assert.equal(read.text, REFUSAL, "the bytes that did arrive are the evidence");
  assert.equal(read.ended, false, "the body did not end; the wait did");
  assert.equal(read.over, true, "so a number at the end of it may be half of one");
  assert.equal(seen.settled, true, "and the fixture's own wait is over, because the read released it");
});

// The other half of that bound belongs to the caller: a host that gave up on the
// request is not kept waiting for the deadline, and the bytes already read are
// still worth what they say.
test("a caller's own signal ends the wait and keeps what was read", async () => {
  const { observeRouteStatement } = await subject;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  try {
    const read = await within(
      1500,
      observeRouteStatement("stalled-signal-free", stalled(REFUSAL), 4096, { signal: controller.signal }),
      "the read of a body a caller gave up on",
    );
    assert.ok(
      Date.now() - started < 1000,
      "a caller who gave up is not waited on for the module's own 3000 ms deadline",
    );
    assert.equal(read.text, REFUSAL, "the partial text is returned, not thrown away");
    assert.equal(read.context, 1048576, "and it is still read for what it says");
  } finally {
    clearTimeout(timer);
  }
});

// The two ways a wait ends are the caller's own cancellation and the module's
// deadline, and they are one signal. `AbortSignal.any` landed in Node 20.3 and
// this package declares Node 18.17, where the call is a TypeError — and it sat
// outside the try that swallows errors on an error path, so on Node 18 every
// refusal body went unread: no route-stated window was learned, no completion
// cap either, and the diagnostic sink was never told. So the two are linked by
// hand where the runtime cannot link them.
test("a wait ends when either of the signals it watches ends", async () => {
  const { linkAbortSignals, anyAbortSignals } = await subject;
  const first = new AbortController();
  const second = new AbortController();
  const linked = linkAbortSignals([first.signal, second.signal]);
  assert.equal(linked.signal.aborted, false, "nothing has ended the wait yet");
  first.abort();
  assert.equal(linked.signal.aborted, true, "the caller's own cancellation ends it");
  // ...and the other way round: the deadline is the module's own.
  const third = new AbortController();
  const fourth = new AbortController();
  const other = linkAbortSignals([third.signal, fourth.signal]);
  fourth.abort();
  assert.equal(other.signal.aborted, true, "and so does the deadline");
  // A signal that had already ended ends the wait before it starts.
  const ended = new AbortController();
  ended.abort();
  assert.equal(linkAbortSignals([ended.signal]).signal.aborted, true, "an ended signal ends it at once");
  // The listeners go back to whoever owns the signals they were on: a wait that
  // is over must not answer the caller's next cancellation.
  const kept = new AbortController();
  const finished = linkAbortSignals([kept.signal]);
  finished.dispose();
  kept.abort();
  assert.equal(finished.signal.aborted, false, "a wait that is over answers nothing");
  // Where the runtime has its own answer, it is used, and it is the same shape.
  const combined = anyAbortSignals([new AbortController().signal]);
  assert.equal(combined.signal.aborted, false);
  assert.equal(typeof combined.dispose, "function", "and it can be let go of either way");
});

// What the wait being cut has to mean: the last characters read are not the end
// of the body, so a number ending there is not a number the route stated. A
// cancelled reader answers its pending `read()` as done, which on its own would
// put back exactly what the cut guard removes — measured before the read kept
// this of its own: a stalled body whose text ends `...is not less or equal to
// 2621`, out of `262144`, was stored and applied as a completion ceiling.
// A body handed out at chosen byte offsets, so a character can be told to fall
// across two reads rather than hoped to. `chunked` above splits on a character
// count, which puts the cut wherever the string's own bytes happen to land: for
// `参数校验失败` in fives the last read is the single byte `e8`. What matters
// here is where the read stops, so the fixtures below state it in bytes.
function splitAt(text, ...cuts) {
  const bytes = new TextEncoder().encode(text);
  const parts = [];
  let from = 0;
  for (const at of [...cuts, bytes.length]) {
    parts.push(bytes.slice(from, at));
    from = at;
  }
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

// Everything this route has to say fits in ASCII, and that is exactly why the
// read could lose a character for so long: a refusal is the one body whose words
// this package repeats, and this route refuses in Chinese (`参数校验失败`, the
// 400 LongCat answers a bad request with), where a character is three bytes and
// a read ends wherever the socket put it. Decoded one read at a time with no
// state carried over, a character split across two reads becomes one U+FFFD per
// piece — measured with `decoder.decode(value)` for the fixture below, `日` came
// back as `\uFFFD\uFFFD\uFFFD`: a row of diamonds where a character was, in the
// one message a caller is meant to repeat.
test("a multi-byte character split across two reads is decoded whole", async () => {
  const { readBoundedText } = await subject;
  // `日` is `e6 97 a5`, so cutting after its first byte and after its third
  // leaves it in two pieces, the way a socket may.
  const text = "abc日本def";
  const bytes = new TextEncoder().encode(text);
  assert.deepEqual(
    [...bytes.slice(3, 7)],
    [0xe6, 0x97, 0xa5, 0xe6],
    "the cut has to land after 日's first byte and inside 本",
  );
  const read = await within(
    1000,
    readBoundedText(new Response(splitAt(text, 4, 6), { status: 400 }), 4096),
    "a read cut inside a character",
  );
  assert.equal(read.text, text, "the character is whole, not one replacement per piece");
  assert.equal(read.ended, true, "and the body was read to its end");
  assert.equal(read.over, false, "so nothing of it was cut");
  // The same body through the character-count chunker this file already uses.
  // It slices by UTF-16 code units, so it can cut a chunk in the middle of a
  // surrogate pair — and then the encoder replaces the half-pair it was handed,
  // which is a fact about the fixture rather than about the reader. What it can
  // be asked is the question it really asks: a body arriving in pieces, every
  // piece a whole number of characters, still comes back as its own text.
  const chunkedRead = await within(
    1000,
    readBoundedText(refusal(text, { size: 5, status: 400 }), 4096),
    "a read cut inside a character by the chunker",
  );
  assert.equal(chunkedRead.text, text, "the same character, split by the same rule");
  assert.equal(chunkedRead.ended, true);
  assert.equal(chunkedRead.over, false);
  // ...and the split that only a byte-wise reader can be asked: the same body,
  // its bytes cut inside 日 rather than between two characters. The chunker
  // above cannot state this — `text.slice` counts code units, and a code unit
  // boundary that does not land on a character boundary corrupts the fixture
  // before the reader ever sees it (`"ab日本def".slice(0, 4)` ends on half a
  // surrogate pair, which `TextEncoder` replaces) — so the fixture is stated in
  // bytes, and the reader is the thing that carries its decoder across the cut.
  const cut = new TextEncoder().encode("ab日本def");
  const insideChar = await within(
    1000,
    readBoundedText(new Response(splitAt("ab日本def", 3, 6), { status: 400 }), 4096),
    "a read cut inside a character by its bytes",
  );
  assert.deepEqual(
    [...cut.slice(3, 6)],
    [0x97, 0xa5, 0xe6],
    "the cuts have to land inside 日 and inside 本, not between two characters",
  );
  assert.equal(insideChar.text, "ab日本def", "a character whose bytes the read was cut inside is whole");
  assert.equal(insideChar.ended, true);
  assert.equal(insideChar.over, false);
});

// The budget is counted in characters of decoded text, and the read that reaches
// it is allowed one character past: a cut decided in characters is decided from
// a decode that has to finish the character the previous read left half of. A
// decoder that forgot between reads answers the cut with replacement characters,
// which are characters too — `参数校验失败` decoded three bytes at a time is six
// of them — and each one would sit in the refusal this package repeats.
test("a split character landing on the budget edge is decoded whole", async () => {
  const { readBoundedText } = await subject;
  const text = "参数校验失败：max_tokens 超出";
  // Decoded, `参数校验失败` is six characters falling at byte 18, and byte 15 is
  // inside the sixth: the read that reaches the budget opens with a character
  // the read before it started, and has to count the whole of it.
  const read = await within(
    1000,
    readBoundedText(new Response(splitAt(text, 5, 10, 15, 18), { status: 400 }), 5),
    "a read reaching the budget on the far side of a split character",
  );
  assert.equal(
    read.text,
    "参数校验失败",
    "the budget, and the one character that says the body went on",
  );
  assert.equal(read.over, true, "the body went on past the budget");
  assert.equal(read.ended, false, "and did not end where the read did");
  // Stated again from the other side: with the budget landing between two
  // characters, the same fixture reads one character less and no more.
  const boundary = await within(
    1000,
    readBoundedText(new Response(splitAt(text, 5, 10, 15, 18), { status: 400 }), 4),
    "a read budgeted between two characters",
  );
  assert.equal(boundary.text, "参数校验失", "the budget and nothing else");
  assert.equal(boundary.over, true);
  assert.equal(boundary.ended, false);
});

// The decode is counted in UTF-16 code units, and a character outside the basic
// plane is two of them, so a cut taken on the unit count can land between the
// halves of one character. What it then leaves is half a character: a lone
// surrogate, which `String.length` counts as one, which renders as a replacement
// diamond wherever it is shown, and which the caller repeating this refusal has
// no way to put back together. The half is dropped and the read says it stopped
// short, because a character the body held is not in the text.
test("a cut landing inside a character outside the basic plane keeps no half of it", async () => {
  const { readBoundedText } = await subject;
  // `😀` is `f0 9f 98 80`, four bytes, two code units, and it is placed to start
  // a chunk of its own: the cut for a four-unit budget lands on its high half.
  const text = "aaaa😀zzzz";
  const bytes = new TextEncoder().encode(text);
  assert.deepEqual(
    [...bytes.slice(4, 8)],
    [0xf0, 0x9f, 0x98, 0x80],
    "the fixture has to put the character exactly at the cut",
  );
  const read = await within(
    1000,
    readBoundedText(new Response(splitAt(text, 4, 8), { status: 400 }), 4),
    "a read cut inside a character outside the basic plane",
  );
  assert.equal(
    read.text,
    "aaaaz",
    "the half is dropped, and the next whole character says the body went on",
  );
  assert.equal(
    read.text.isWellFormed(),
    true,
    `no half of a character may be kept: ${JSON.stringify(read.text)}`,
  );
  assert.equal(
    read.over,
    true,
    "a character the body held is not in the text, so this is not the whole body",
  );
  assert.equal(read.ended, false, "however the stream ended");
  // The same body read with room for the character: it is decoded whole, and the
  // budget's own one character past the limit is a whole character too.
  const roomy = await within(
    1000,
    readBoundedText(new Response(splitAt(text, 4, 8), { status: 400 }), 8),
    "a read with room for the character",
  );
  assert.equal(roomy.text, "aaaa😀zzz", "a character inside the budget is read whole");
  assert.equal(roomy.text.isWellFormed(), true);
  assert.equal(roomy.over, true);
  assert.equal(roomy.ended, false);
  // The flag the drop has to leave behind, stated where nothing else says it:
  // the same cut with nothing after it, so the read reaches the end of the body
  // holding one character less than the body did. `ended` alone would be true —
  // the stream really did end — and a caller told that and `over: false` would
  // hand a prefix on as the whole reply, which is the one lie this read may not
  // tell.
  const trailing = await within(
    1000,
    readBoundedText(new Response(splitAt("aaaa😀", 4), { status: 400 }), 4),
    "a read whose dropped half is the last thing in the body",
  );
  assert.equal(trailing.text, "aaaa", "the half is dropped, and nothing follows it");
  assert.equal(trailing.text.isWellFormed(), true);
  assert.equal(
    trailing.ended,
    false,
    "the body ended at the reader, but a character the body held is not in the text",
  );
  assert.equal(trailing.over, true, "so this is not the whole body");
});

test("a number the wait cut short is not a limit", async () => {
  const { observeRouteStatement, limitOverrides } = await subject;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  const id = "stalled-cut-free";
  const text = "Upstream request failed: /max_tokens: 1000000 is not less or equal to 2621";
  try {
    const read = await within(
      1500,
      observeRouteStatement(id, stalled(text), 4096, { signal: controller.signal }),
      "the read of a body cut inside a number",
    );
    assert.equal(read.text, text, "the bytes read are handed back");
    assert.equal(read.output, undefined, "a number ending on the cut is not a ceiling");
    assert.deepEqual(limitOverrides(id, { context: 1000000, output: 131072 }), {}, "and nothing was stored");
  } finally {
    clearTimeout(timer);
  }
});

// ---- the wall this plugin learns while it runs -----------------------------
//
// Everything above is a number somebody measured by hand. Below is the other
// half of the same idea: the bracket a model's own traffic draws, which is what
// makes the table a starting point rather than the only answer. Every case here
// holds a bracket map of its own rather than the module's, because the module
// keeps one state for the whole process and a case that read the default one
// would be asserting on whatever ran before it.

test("the tokens a request holds are estimated from its own text", async () => {
  const { estimateTokens, requestText, requestSize } = await subject;
  // The route's own count, on the bodies a host actually sends: 3.996 characters
  // per token. Measured against `usage.prompt_tokens` at three sizes — 3.938,
  // 4.015 and 4.034 — where the old 4.66, calibrated on repeated filler, read the
  // prompt about 14% short. An estimate is an estimate, and this case pins the
  // ratio rather than a tokenizer this plugin does not have.
  assert.equal(estimateTokens("a".repeat(3996)), 1000);
  assert.equal(estimateTokens("a".repeat(400)), 100);
  // CJK is counted per character: a window declared from a Latin ratio alone
  // would come out at a third of the real one for a wall of Chinese text, which
  // is the under-declaration this file exists to remove.
  assert.equal(estimateTokens("汉".repeat(1000)), 700);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(7), 0, "a number is not text");
  // Only strings are counted, and every string in the body is counted whichever
  // protocol wrote it: what comes back is a floor on the request's size, and the
  // one direction it may not fail in is calling a small request a large one.
  assert.equal(
    requestText({ messages: [{ role: "user", content: "abcd" }], temperature: 0.7 }),
    "userabcd",
  );
  assert.equal(requestText({ system: "ab", input: [{ content: [{ text: "cd" }] }] }), "abcd");
  assert.deepEqual(requestSize({ messages: [{ content: "a".repeat(3996) }] }), { tokens: 1000 });
});

test("an encoded attachment is not prompt text, and does not use up the scan", async () => {
  const { requestSize, requestText } = await subject;
  // 140,000 characters is about 100 KB of PNG: small as screenshots go, and
  // 35,035 "tokens" if the encoding is read as text — 35,000 tokens of a prompt
  // nobody typed. On the VPS the same arithmetic read a 10 MB screenshot as
  // 3,498,676 tokens and the floor under it became a model's declared window.
  const payload = "A".repeat(140_000);
  const withImage = (text) => ({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          { type: "image_url", image_url: { url: `data:image/png;base64,${payload}` } },
        ],
      },
    ],
  });
  // The payload adds nothing: the same body with an empty URL reads the same size,
  // and what the two share is the image part's own labels, not the picture.
  const shapeOnly = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe the screenshot" },
          { type: "image_url", image_url: { url: "" } },
        ],
      },
    ],
  };
  assert.deepEqual(requestSize(withImage("describe the screenshot")), requestSize(shapeOnly));
  assert.ok(requestSize(shapeOnly).tokens < 20, "the shared part is the prompt's own words and two labels");
  // The same characters without the data URI are a request body of text, and
  // nothing in a walk over strings can know better: the rule is the shape.
  assert.equal(requestSize({ content: payload }).tokens, 35_035);
  // The anthropic and gemini shapes arrive as a bare base64 field beside what it
  // holds; a `data` field with nothing saying what it is stays text. What is left
  // of the first two is the label the part carries, not the picture.
  assert.equal(
    requestText({ source: { type: "base64", media_type: "image/png", data: payload } }),
    "base64image/png",
  );
  assert.equal(requestText({ inline_data: { mime_type: "image/jpeg", data: payload } }), "image/jpeg");
  assert.equal(requestText({ data: payload }), payload);
  // A data URI too short to be a payload is counted: dropping it would be
  // skipping text on a guess about its length.
  assert.equal(requestText({ url: "data:image/gif;base64,R0lGOD" }), "data:image/gif;base64,R0lGOD");
  // The budget bounds text, and an attachment is not 12 MB of prompt: what comes
  // after it is still read, which is the half a floor cannot afford to lose.
  const after = {
    messages: [
      {
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${"B".repeat(12_000_000)}` } },
          { type: "text", text: "hello" },
        ],
      },
    ],
  };
  assert.equal(requestText(after), "image_urltexthello");
});

test("a bracket measured before attachments were skipped is dropped", async () => {
  const { ESTIMATE_SCALE, loadLimitState, limitAdaptivity } = await subject;
  const at = `${tmpdir()}/zen-attachment-scale-${process.pid}-${Date.now()}.json`;
  try {
    // What the VPS wrote on scale 2: a floor that is really a picture's base64.
    const shot = { floor: 3_491_182, ceiling: 3_491_182, step: 400_000, refusals: 0, seen: 3_491_182, seededFrom: 1_048_576 };
    writeFileSync(at, JSON.stringify({ version: 1, models: { "shot-free": { ...shot, scale: ESTIMATE_SCALE - 1 } } }));
    assert.equal(await loadLimitState(at), false, "counted on the scale that read a screenshot as 3.49 million tokens");
    // The same record on the scale in use is still evidence, so the guard is
    // about the instrument and not about the picture being unpublishable.
    const now = `${at}.now`;
    writeFileSync(now, JSON.stringify({ version: 1, models: { "shot-free": { ...shot, scale: ESTIMATE_SCALE } } }));
    assert.equal(await loadLimitState(now), true);
    rmSync(now, { force: true });
  } finally {
    limitAdaptivity(new Map());
    rmSync(at, { force: true });
  }
});

test("a body of many strings is read to its end, not to a count of strings", async () => {
  const { requestText, requestSize } = await subject;
  // The budget is characters, and it is the quantity being estimated. It used to
  // be 4096 STRINGS, and a chat body carries one string per role, per content,
  // per tool-call id, per tool name and per tool arguments: a conversation of a
  // few hundred turns hit the cap and everything past it went unread. What came
  // back was not a floor on the request's size but a floor on the part of it the
  // walk happened to reach, and a wall learned from it lands below a size the
  // route has already served.
  const body = { messages: [] };
  for (let at = 0; at < 3000; at += 1) {
    body.messages.push({ role: "user", content: `question ${at} ${"x".repeat(200)}` });
    body.messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `call_${at}`, type: "function", function: { name: "read", arguments: `{"path":"/tmp/${at}"}` } },
      ],
    });
  }
  const strings = 1 + body.messages.length + 3000 * 2;
  assert.ok(strings > 4096, `the fixture has to hold more strings than the old budget (${strings})`);
  // Every character of every string is read: the text the walk returns is as long
  // as the strings in the body put together, which the old rule could not do.
  const walked = requestText(body);
  let real = 0;
  const count = (value) => {
    if (typeof value === "string") real += value.length;
    else if (Array.isArray(value)) value.forEach(count);
    else if (value && typeof value === "object") Object.values(value).forEach(count);
  };
  count(body);
  assert.equal(walked.length, real, "the walk reads the whole body, not the first 4096 strings of it");
  // And the estimate follows the body: doubling the tail changes it. Under the
  // string budget the last 2000 messages contributed nothing at all.
  const longer = { messages: body.messages.map((message) => ({ ...message })) };
  for (const message of longer.messages) if (typeof message.content === "string") message.content += "y".repeat(200);
  assert.ok(requestSize(longer).tokens > requestSize(body).tokens, "the tail of the body is counted");
});

test("a bracket measured by another estimator never bounds the table's own measurement", async () => {
  const { ESTIMATE_SCALE, limitAdaptivity, limitOverrides, limitStateJSON, loadLimitState } = await subject;
  const at = `${tmpdir()}/zen-scale-${process.pid}-${Date.now()}.json`;
  try {
    // The estimator once counted strings instead of characters, so a long
    // conversation was read to a fifth of its length and every size it produced was
    // deflated by the same factor. The bracket built on that scale is not a
    // measurement of the window — it is a measurement of a different quantity, and
    // the table's 326000 was taken by the sweep on the scale in use now.
    //
    // This is the VPS on 2026-10-19: floor 228286 and ceiling 223942, both produced
    // by the string-counting walk, bounding a table that says 326000.
    const table = { context: 326000, output: 384000 };
    // The file a previous version wrote: no scale field, because there was none.
    writeFileSync(
      at,
      JSON.stringify({
        version: 1,
        models: {
          "deepseek-v4.1-flash-free": {
            floor: 228286,
            ceiling: 223942,
            ceil: 226020,
            step: 27992,
            refusals: 4,
            seen: 228286,
            seededFrom: 326000,
          },
        },
      }),
    );
    assert.equal(await loadLimitState(at), false, "a record that names no scale is from before there was one");
    // Which is the whole point: with the record dropped, the table's own
    // measurement is what the host is told. The window is not narrowed to a count
    // taken by an instrument that read a fifth of the request.
    assert.deepEqual(
      limitOverrides("deepseek-v4.1-flash-free", table, undefined, undefined, undefined, undefined, new Map()),
      {},
      "the table needs no override, because nothing on this scale contradicted it",
    );
    // A file written now carries the scale beside the numbers it belongs to, and is
    // read back, so the gate is about the instrument and not about never persisting.
    // A second path, because a load is memoised per file: the point here is a file
    // that was never read before, which is what a restart sees.
    const written = JSON.parse(limitStateJSON(new Map([["scaled-free", { floor: 90000, ceiling: 100000 }]])));
    assert.equal(written.models["scaled-free"].scale, ESTIMATE_SCALE);
    const fresh = `${at}.current`;
    writeFileSync(fresh, limitStateJSON(new Map([["scaled-free", { floor: 90000, ceiling: 100000 }]])));
    assert.equal(await loadLimitState(fresh), true, "a record on the current scale is still evidence");
    rmSync(fresh, { force: true });
  } finally {
    limitAdaptivity(new Map());
    rmSync(at, { force: true });
  }
});

test("a refusal never declares a window below a size the route has served", async () => {
  const { observeServedRequest, observeRefusedRequest, limitBracket, limitOverrides } = await subject;
  const brackets = new Map();
  const seeded = 326000;
  // The VPS on 2026-10-19, replayed: a prompt estimated at 228286 tokens is
  // served, and the same conversation 227 tokens larger by the estimate is
  // refused. The bound a refusal draws is a function of the refused size alone,
  // so floor(228513 * 0.98) = 223942 lands 4344 tokens BELOW the size the route
  // had just answered.
  observeServedRequest("inverted-free", { tokens: 228286 }, seeded, brackets, 1000);
  observeRefusedRequest("inverted-free", { tokens: 228513 }, seeded, brackets, 2000);
  const refused = limitBracket("inverted-free", brackets);
  assert.equal(refused.floor, 228286);
  assert.equal(refused.ceil, 228513);
  assert.ok(
    refused.ceiling >= refused.floor,
    `a declaration (${refused.ceiling}) under a served size (${refused.floor}) is contradicted by its own evidence`,
  );
  // It has to stay recoverable as well. The un-refusal guard needs floor >= ceil,
  // which a refusal this close to the floor never satisfies, so the raise path is
  // the only way out — and it used to re-derive the same bound every time.
  let now = 10_000_000;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    observeServedRequest("inverted-free", { tokens: 228286 }, seeded, brackets, now);
    now += 3_600_000;
    const raised = limitBracket("inverted-free", brackets);
    assert.ok(raised.ceiling >= raised.floor, `raise ${attempt + 1} kept the declaration above the floor`);
  }
  // A record read back from a state file that already holds the inversion is
  // repaired rather than republished. The clamp in `derivedCeiling` is not enough
  // on its own: a record arrives with a usable `ceiling`, and the two paths that
  // answer with it without deriving anything are the ones a host is in before it
  // sends its first request and once the refusal budget is spent. Both are asked
  // here, because both published 223942 while only the raise path was repaired.
  //
  // What is asserted is what the model list is told, not what the record holds:
  // `limitBracket` reads the stored value, and the boundary that answers magpie is
  // `limitOverrides`. A record is repaired on its way out of that boundary, which
  // is also what the next save writes.
  const stale = (refusals) => ({
    floor: 228286,
    ceil: 228513,
    ceiling: 223942,
    step: 27992,
    refusals,
    seen: 228286,
    seededFrom: 326000,
  });
  const published = (brackets) =>
    limitOverrides(
      "persisted-free",
      { context: 326000, output: 384000 },
      undefined,
      undefined,
      undefined,
      brackets,
      new Map(),
    );
  // 4 is MAX_REFUSALS, the point at which the raise path closes. It is not
  // exported, and the boundary has to hold there rather than anywhere this test
  // chooses.
  for (const refusals of [3, 4]) {
    // Cold: nothing has been served in this process, so nothing derives a ceiling
    // and `adoptedCeiling` is what the model list reads.
    const cold = new Map([["persisted-free", stale(refusals)]]);
    assert.equal(
      published(cold).context,
      228286,
      `a persisted inversion (refusals=${refusals}) is not republished before the first request`,
    );
    assert.equal(
      limitBracket("persisted-free", cold).ceiling,
      228286,
      `and the record itself is repaired as it is answered (refusals=${refusals})`,
    );
    // Warm: the host filled the declaration, and the cooldown has long passed.
    // With the budget spent the raise is closed, so this is the other path that
    // used to answer 223942 for as long as the file was kept.
    const warm = new Map([["persisted-free", stale(refusals)]]);
    observeServedRequest("persisted-free", { tokens: 223942 }, 326000, warm, 9_999_999_999);
    // The invariant, not a fixed number: the window never sits below the floor, and
    // it may climb past it — a raise that moves is the search working, and pinning
    // this to 228286 would forbid the very progress `derivedCeiling` exists to make.
    const warmPublished = published(warm).context;
    assert.ok(
      warmPublished >= 228286,
      `a persisted inversion (refusals=${refusals}) is not republished after a raise: got ${warmPublished}`,
    );
    assert.ok(
      warmPublished <= 228513,
      `and it stays under the size the route refused: got ${warmPublished}`,
    );
    // The output axis is not the context axis and is not clamped with it: a
    // completion ceiling larger than the window is what this route serves, and
    // magpie's own clamp is a rule about a declaration this file should not be
    // making. 384000 is left alone here so that the pair the table states is the
    // pair that is published.
    assert.equal(published(warm).output, undefined, "the output declaration is left as the table states it");
  }
});

test("a served request proves a floor, and a declaration moves only when the host fills it", async () => {
  const { observeServedRequest, limitBracket } = await subject;
  const brackets = new Map();
  const seeded = 200000;
  // A request well under the declaration is a fact about the floor and nothing
  // else: the route serving 100000 tokens says nothing about wanting more room.
  observeServedRequest("small-free", { tokens: 100000 }, seeded, brackets, 0);
  assert.equal(limitBracket("small-free", brackets).ceiling, seeded);
  assert.equal(limitBracket("small-free", brackets).floor, 100000);
  // The host filling the declaration is the only demand signal there is, and the
  // first one is held back by the cooldown: a probe costs a turn when it
  // overshoots, so probes are spaced.
  observeServedRequest("small-free", { tokens: 190000 }, seeded, brackets, 0);
  assert.equal(limitBracket("small-free", brackets).ceiling, seeded, "a first raise is held back");
  observeServedRequest("small-free", { tokens: 190000 }, seeded, brackets, 900001);
  const raised = limitBracket("small-free", brackets);
  assert.equal(
    raised.ceiling,
    190000 + 20000,
    "the step doubled, and the declaration went a step above the floor it proved",
  );
  // ...and a second raise waits for the cooldown again.
  observeServedRequest("small-free", { tokens: 215000 }, seeded, brackets, 900002);
  assert.equal(limitBracket("small-free", brackets).ceiling, raised.ceiling);
});

test("a narrow bracket climbs to its own ceiling instead of stopping at the floor", async () => {
  const { observeServedRequest, observeRefusedRequest, limitBracket } = await subject;
  const brackets = new Map();
  // A margin that is a fraction of the refused size is no margin when the bracket
  // is narrow. 2% of 330000 is 6600, which is below a floor of 326000, so the
  // bound sits on the wrong side of the evidence and the declaration was pinned at
  // 326000 for good: six raises moved it nowhere, on a route that had refused
  // 330000 and been asked nothing in between.
  const seed = 330000;
  observeServedRequest("narrow-free", { tokens: 326000 }, seed, brackets, 0);
  observeRefusedRequest("narrow-free", { tokens: 330000 }, seed, brackets, 1000);
  assert.equal(limitBracket("narrow-free", brackets).ceiling, 326000);
  // The host fills the declaration, the cooldown passes, and the search moves into
  // the interval it has evidence for rather than sitting on its lower edge.
  let now = 1000 + 900001;
  const trail = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const held = limitBracket("narrow-free", brackets);
    observeServedRequest("narrow-free", { tokens: held.ceiling }, seed, brackets, now);
    trail.push(limitBracket("narrow-free", brackets).ceiling);
    now += 900001;
  }
  assert.ok(trail[0] > 326000, `the first raise moves into the bracket, got ${trail[0]}`);
  // Never past the size the route refused, and never back under the floor.
  for (const value of trail) {
    assert.ok(value > 326000 && value < 330000, `${value} stays inside (326000, 330000)`);
  }
  // It converges on the wall rather than approaching it by 2% of itself: six
  // bisections put it within a sixteenth of the span, which a 2%-margin climb
  // cannot do because the margin is larger than the span.
  assert.ok(
    trail[trail.length - 1] >= 330000 - (330000 - 326000) / 4,
    `the declaration reaches the top quarter of the bracket, got ${trail[trail.length - 1]}`,
  );
});

test("a refusal halves the step, puts the declaration under the wall, and is never crossed", async () => {
  const { observeServedRequest, observeRefusedRequest, limitBracket } = await subject;
  const brackets = new Map();
  const seeded = 200000;
  observeServedRequest("wall-free", { tokens: 195000 }, seeded, brackets, 1000000);
  assert.equal(limitBracket("wall-free", brackets).ceiling, 215000);
  observeRefusedRequest("wall-free", { tokens: 230000 }, seeded, brackets, 2000000);
  const refused = limitBracket("wall-free", brackets);
  assert.equal(refused.ceiling, 195000, "back to what the route is known to have served");
  assert.equal(refused.step, 10000, "the step halved");
  assert.equal(refused.ceil, 230000, "the size that was refused, kept as the bound");
  assert.equal(refused.refusals, 1);
  // The bound is what keeps the search off a size already turned down: the next
  // raise goes a halved step above the floor, and it needs a served request at
  // the declaration plus the cooldown before it happens.
  observeServedRequest("wall-free", { tokens: 196000 }, seeded, brackets, 3000000);
  observeServedRequest("wall-free", { tokens: 196000 }, seeded, brackets, 3900001);
  const climbed = limitBracket("wall-free", brackets);
  assert.ok(climbed.ceiling > refused.ceiling, "it climbs again, on a smaller step");
  assert.ok(
    climbed.ceiling <= Math.floor(230000 * 0.98),
    "and never at or above the size the route refused",
  );
});

test("a refusal that puts the declaration back at the floor leaves demand to raise again", async () => {
  const { observeServedRequest, observeRefusedRequest, limitBracket } = await subject;
  const brackets = new Map();
  const seeded = 200000;
  // The shape the raise gate could not survive: the host fills the declaration,
  // the declaration is raised, the host builds to the raised number and is
  // refused, and the declaration falls back to what had already been served.
  observeServedRequest("pinned-free", { tokens: 190000 }, seeded, brackets, 0);
  observeServedRequest("pinned-free", { tokens: 190000 }, seeded, brackets, 900001);
  const raised = limitBracket("pinned-free", brackets);
  assert.ok(raised.ceiling > 190000, `the first raise happened, got ${raised.ceiling}`);
  assert.equal(raised.raisedAtSeen, 190000, "and it was paid for by the served request");
  observeRefusedRequest("pinned-free", { tokens: 215000 }, seeded, brackets, 900002);
  const lowered = limitBracket("pinned-free", brackets);
  assert.equal(lowered.ceiling, 190000, "a refusal puts the declaration back at the floor");
  assert.equal(lowered.raisedAt, 900002, "the cooldown is kept");
  // `seen` is still 190000, and leaving the baseline at it would compare the
  // largest request ever carried with itself for the rest of the process: the
  // host can only rebuild to 190000, so no second raise could ever fire.
  assert.equal(lowered.raisedAtSeen, 0, "the demand baseline is reset, so re-filling the floor counts");
  // The host rebuilds to the lowered declaration and the cooldown passes.
  observeServedRequest("pinned-free", { tokens: 190000 }, seeded, brackets, 900002 + 900001);
  const again = limitBracket("pinned-free", brackets);
  assert.ok(
    again.ceiling > lowered.ceiling,
    `re-filling the lowered declaration buys another raise, got ${again.ceiling}`,
  );
});

test("a configured maximum below a served size never declares under the floor", async () => {
  const { MAX_WINDOW_ENV, observeServedRequest, observeRefusedRequest, limitBracket } = await subject;
  const previous = process.env[MAX_WINDOW_ENV];
  // An operator sets the search's ceiling below a size the route has already
  // served. The wedge path leaves `derivedCeiling` before its floor clamp, so
  // the global cap became the declaration — lower than the request the route
  // answered, which is the inversion this file has a rule about.
  process.env[MAX_WINDOW_ENV] = "1048576";
  try {
    const brackets = new Map();
    observeServedRequest("oversized-free", { tokens: 2_000_000 }, 200000, brackets, 0);
    observeRefusedRequest("oversized-free", { tokens: 2_000_100 }, 200000, brackets, 1000);
    const held = limitBracket("oversized-free", brackets);
    assert.equal(held.floor, 2_000_000, "the served request is the floor");
    assert.ok(
      held.ceiling >= held.floor,
      `the declaration (${held.ceiling}) may not sit below the served floor (${held.floor})`,
    );
  } finally {
    if (previous === undefined) delete process.env[MAX_WINDOW_ENV];
    else process.env[MAX_WINDOW_ENV] = previous;
  }
});

test("a size the route served at or above a refused one drops that refusal", async () => {
  const { observeServedRequest, observeRefusedRequest, limitBracket } = await subject;
  const seeded = 200000;
  const brackets = new Map();
  observeServedRequest("flaky-free", { tokens: 195000 }, seeded, brackets, 1000000);
  observeRefusedRequest("flaky-free", { tokens: 210000 }, seeded, brackets, 1000000);
  const refused = limitBracket("flaky-free", brackets);
  assert.equal(refused.ceil, 210000, "the refusal put a bound under the wall");
  assert.equal(refused.refusals, 1, "and spent one of the four a model gets");
  assert.equal(refused.ceiling, 195000, "and put the declaration back at the floor");
  // ...and then the route serves the identical request it just turned down. It
  // does this: on 2026-10-19 big-pickle answered a 1,600,000-character prompt
  // with a 400 that named no code and then served the same request, counting
  // 343,131 tokens. Left in place, that bound is permanent — `ceil` only ever
  // comes down — so the declaration could never again climb over a size the route
  // had in fact served, and the refusal would keep a quarter of the budget that
  // turned out not to have been spent on anything.
  observeServedRequest("flaky-free", { tokens: 210000 }, seeded, brackets, 2000000);
  const unrefused = limitBracket("flaky-free", brackets);
  assert.equal(unrefused.ceil, undefined, "the bound that refusal drew is gone");
  assert.equal(unrefused.refusals, 0, "and the budget it spent is given back");
  assert.equal(unrefused.floor, 210000, "at the size the route went on to serve");
  // A window the route named in its own words is not dropped this way. That is
  // the route stating a limit rather than one endpoint misbehaving, and the same
  // sweep re-asked every named number it found and had them all hold still.
  const named = new Map();
  observeRefusedRequest("named-free", { tokens: 120000 }, seeded, named, 1000000, 100000);
  assert.equal(limitBracket("named-free", named).exact, true);
  observeServedRequest("named-free", { tokens: 120000 }, seeded, named, 2000000);
  const held = limitBracket("named-free", named);
  assert.equal(held.ceil, 100000, "a named window stands, and it is not widened");
  assert.equal(held.refusals, 1, "and the refusal it cost is still counted");
});

test("the search stops after its refusal budget, and a window the route names replaces it", async () => {
  const { observeServedRequest, observeRefusedRequest, limitBracket } = await subject;
  const seeded = 200000;
  const brackets = new Map();
  for (let at = 0; at < 8; at += 1) {
    observeRefusedRequest("budget-free", { tokens: 240000 }, seeded, brackets, at * 2000000);
    observeServedRequest("budget-free", { tokens: 196000 }, seeded, brackets, at * 2000000 + 1000000);
  }
  const spent = limitBracket("budget-free", brackets);
  assert.ok(spent.refusals >= 4, "the refusals were counted");
  assert.equal(spent.ceiling, 196000, "and the declaration sits on the floor it proved");
  // A refusal that names the window is not a bracket at all: the route stated
  // its own limit, which is better evidence than any estimate.
  const namedBrackets = new Map();
  observeRefusedRequest("named-free", { tokens: 300000 }, seeded, namedBrackets, 0, 262144);
  const named = limitBracket("named-free", namedBrackets);
  assert.equal(named.ceiling, 262144);
  assert.equal(named.exact, true);
});

test("a raise is paid for by demand the host has shown since the last one", async () => {
  const { observeServedRequest, observeRefusedRequest, limitBracket } = await subject;
  const seeded = 326000;
  const wall = 330000;
  const brackets = new Map();
  // The host's real demand is 326000 tokens and the route refuses at 330000. A
  // raise used to be granted whenever the largest request carried was above 90% of
  // the declaration, and the declaration was what the previous raise had just
  // moved: the same unanswered 326000 therefore paid for two raises in a row, to
  // 358600 and then 391200. The host built to 391200, was refused, and did that
  // again until all four refusals were gone — leaving the declaration at 326000 for
  // good, 4000 tokens under a wall the route had already shown.
  let now = 0;
  let firstRaise;
  for (let round = 0; round < 10; round += 1) {
    now += 900001;
    observeServedRequest("demand-free", { tokens: 326000 }, seeded, brackets, now);
    const held = limitBracket("demand-free", brackets);
    if (round === 0) {
      // The host filling the declaration is real demand, so the first raise is
      // granted: that is the whole point of the search.
      firstRaise = held.ceiling;
      assert.ok(firstRaise > 326000, `filling the declaration buys one raise, got ${firstRaise}`);
    } else {
      // But the same unanswered request cannot pay for a second one. This is the
      // difference the defect made: two raises in a row off one 326000 request, to
      // 358600 and then 391200.
      assert.equal(
        held.ceiling,
        firstRaise,
        `round ${round + 1}: an unchanged request does not buy another raise, got ${held.ceiling}`,
      );
    }
  }
  const quiet = limitBracket("demand-free", brackets);
  assert.equal(quiet.refusals, 0, "and no refusal was spent speculating");

  // Demand that really grows still climbs: this is the half the rule must not cost.
  const climbing = new Map();
  let demand = 190000;
  let at = 0;
  for (let round = 0; round < 4; round += 1) {
    at += 900001;
    observeServedRequest("growing-free", { tokens: demand }, 200000, climbing, at);
    demand += 20000;
  }
  assert.ok(
    limitBracket("growing-free", climbing).ceiling > 200000,
    `a growing conversation still lifts the declaration, got ${limitBracket("growing-free", climbing).ceiling}`,
  );
});

// A raise is a raise only if it raises.
//
// The declaration may be pulled down by a refusal — that is what a refusal is
// for, and the route is the one saying so — but a probe that did not move it
// may not lower it, and it may not spend the demand that pays for the next one.
// The case that showed it: a route named a window of 2,000,000 tokens in its own
// words. That number is above the 1,048,576 this file caps an estimated search
// at, so the bound the declaration was held under came back as the cap, and the
// raise published 1,048,576 over a declaration of 2,000,000 — under a
// `wall-raised` note that said it had gone UP. The host was then handed a
// window that had shrunk, so it could not fill it, so the demand that pays for
// the next raise could never arrive: the evidence had been spent on a raise
// that never happened.
test("a raise may not pull the declaration down, and a raise that does not raise spends nothing", async () => {
  const { observeServedRequest, observeRefusedRequest, limitBracket, limitDiagnostics } = await subject;
  const notes = [];
  const previous = limitDiagnostics((entry) => notes.push(entry));
  const brackets = new Map();
  try {
    // The route names its window in its own words.
    observeRefusedRequest("named-cap-free", { tokens: 2000000 }, 200000, brackets, 1000, 2000000);
    const named = limitBracket("named-cap-free", brackets);
    assert.equal(named.ceiling, 2000000, "the declaration is the window the route named");
    // The host fills the declaration and the cooldown passes, so the search may
    // raise it.
    observeServedRequest("named-cap-free", { tokens: 1900000 }, 200000, brackets, 901001);
    const after = limitBracket("named-cap-free", brackets);
    assert.equal(after.ceiling, 2000000, "a raise may not pull the declaration down");
    assert.equal(after.raisedAtSeen, 0, "and it does not spend the demand that pays for the next one");
    assert.equal(after.raisedAt, 1000, "nor start the cooldown it would have started");
    assert.equal(after.step, named.step, "nor move the probe");
    assert.deepEqual(
      notes.filter((entry) => entry.kind === "wall-raised"),
      [],
      "and no note says a raise happened",
    );
  } finally {
    limitDiagnostics(previous);
  }
});

// The same rule for a record that came back from a state file, where the
// declaration may sit above the bound a refusal drew: the bound is 2% under the
// size that was refused, so a declaration above that bound is one the search
// reached past — and a probe that derives the bound back may not publish it.
// The request that filled the declaration was served, so nothing here is a
// statement the route has not made.
test("a raise may not pull a declaration read back from a state file down either", async () => {
  const { ESTIMATE_SCALE, observeServedRequest, limitBracket, limitDiagnostics } = await subject;
  const notes = [];
  const previous = limitDiagnostics((entry) => notes.push(entry));
  const brackets = new Map([
    ["read-back-free", {
      floor: 250000, ceil: 290000, ceiling: 300000, step: 10000, scale: ESTIMATE_SCALE,
      refusals: 1, seen: 250000, raisedAtSeen: 0, seededFrom: 200000, raisedAt: 0,
      refusedAt: 1000, seenAt: 0,
    }],
    // The other half: a record whose declaration the search cannot move at all,
    // because the floor and the step are already under it. The raise is asked
    // for and there is nowhere to go — and a raise that goes nowhere may not
    // spend the demand that pays for the next one, because the host cannot
    // send a larger request than the window it was given, and that window did
    // not grow.
    ["stuck-free", {
      floor: 250000, ceil: 310000, ceiling: 300000, step: 10000, scale: ESTIMATE_SCALE,
      refusals: 1, seen: 250000, raisedAtSeen: 0, seededFrom: 200000, raisedAt: 0,
      refusedAt: 1000, seenAt: 0,
    }],
  ]);
  try {
    // The host fills the declaration: the request is served, so the floor moves
    // to 270000 and the bound the refusal drew is still above it.
    observeServedRequest("read-back-free", { tokens: 270000 }, 200000, brackets, 900001);
    const after = limitBracket("read-back-free", brackets);
    assert.equal(after.ceil, 290000, "the bound the refusal drew is still there");
    assert.equal(after.ceiling, 300000, "the declaration is where it was");
    assert.equal(after.raisedAtSeen, 0, "and the demand is still there to pay for a raise");
    assert.equal(after.step, 10000, "and the probe has not moved");
    // The same record, filling the declaration the same way: the search derives
    // the declaration it already has, so there is nothing to raise.
    observeServedRequest("stuck-free", { tokens: 270000 }, 200000, brackets, 900001);
    const stuck = limitBracket("stuck-free", brackets);
    assert.equal(stuck.ceiling, 300000, "the declaration is where it was");
    assert.equal(stuck.raisedAtSeen, 0, "and the demand is still there to pay for a raise");
    assert.equal(stuck.raisedAt, 0, "and no cooldown has started");
    assert.equal(stuck.step, 10000, "and the probe has not moved");
    assert.deepEqual(
      notes.filter((entry) => entry.kind === "wall-raised"),
      [],
      "and no note says a raise happened",
    );
  } finally {
    limitDiagnostics(previous);
  }
});

test("what the route taught outranks the table for its axis, and a model nothing was asked of keeps the table", async () => {
  const { observeServedRequest, observeRefusedRequest, limitOverrides } = await subject;
  const brackets = new Map();
  const declared = { context: 200000, output: 32000 };
  observeServedRequest("learned-free", { tokens: 150000 }, declared.context, brackets, 0);
  observeRefusedRequest("learned-free", { tokens: 170000 }, declared.context, brackets, 1000);
  // The bracket is route evidence, so the raise-only rule that binds the weaker
  // tiers does not bind it: 150000 is below the catalogue's 200000 and it is
  // still what this file declares, because the route refused 170000.
  assert.deepEqual(
    limitOverrides("learned-free", declared, {}, new Map(), new Map(), brackets),
    { context: 150000 },
  );
  // ...and it is what this file declares even when the shipped table has an
  // entry of its own for the id, because a record exists only because a request
  // was served or refused: the table had the first word, and the route has the
  // last one. This is the id the table covers, which is the case the bracket was
  // built for and the one an entry consulted first would hide.
  const table = {
    "learned-free": {
      context: { value: 200000, source: "route", declaredAt: 200000 },
      output: { value: 64000, source: "route", declaredAt: 32000 },
    },
  };
  assert.deepEqual(
    limitOverrides("learned-free", declared, table, new Map(), new Map(), brackets),
    { context: 150000, output: 64000 },
    "the bracket answers for the axis the route moved, the table for the one it did not",
  );
  // A model nothing has been asked of has no record, and its axes are the
  // table's and nothing else.
  assert.deepEqual(limitOverrides("learned-free", declared, {}, new Map(), new Map(), new Map()), {});
  // ...and a window a refusal named this process still outranks the bracket,
  // because a number the route stated beats one this file estimated.
  const live = new Map([["learned-free", 262144]]);
  assert.deepEqual(limitOverrides("learned-free", declared, {}, live, new Map(), brackets), {
    context: 262144,
  });
  // A record is read, never created, by a model list: a list is not evidence
  // about a wall, and a bracket invented at startup would be a bracket nobody
  // measured.
  assert.equal(limitOverrides("never-seen-free", declared, {}, new Map(), new Map(), brackets).context, undefined);
});

// An axis a record owns as `null` is a value a state file or a caller can write
// for "not measured". The `!== undefined` guard alone let it through to
// `.declaredAt`, so a model list threw where it should have answered the axis
// from the weaker tiers. Both the context entry read before the loop and the
// per-axis entry inside it need the null guard.
test("a table entry that owns null for an axis is not a measurement", async () => {
  const { limitOverrides } = await subject;
  const declared = { context: 200000, output: 32000, input: 160000 };
  const table = { "null-entry-free": { context: null, output: null, input: null } };
  assert.deepEqual(
    limitOverrides("null-entry-free", declared, table, new Map(), new Map(), new Map()),
    {},
    "the null entry is skipped rather than read as a measurement",
  );
  // The per-axis guard with no context entry in play: the loop reaches the axes
  // the table owns as null on its own, and must answer them like a missing entry.
  const perAxis = { "null-axis-free": { input: null } };
  assert.deepEqual(
    limitOverrides("null-axis-free", declared, perAxis, new Map(), new Map(), new Map()),
    {},
    "an axis the table owns as null leaves the catalogue's declaration in place",
  );
});

test("a bracket survives a restart through one file, and a file that is not one is no state", async () => {
  const { observeRefusedRequest, limitBracket, limitAdaptivity, limitStateJSON, loadLimitState, saveLimitState } =
    await subject;
  const file = join(tmpdir(), `zen-limits-${process.pid}-${Date.now()}.json`);
  try {
    const brackets = new Map();
    observeRefusedRequest("kept-free", { tokens: 170000 }, 200000, brackets, 1000);
    assert.equal(await saveLimitState(file, brackets), true);
    // A fresh process — which is what an empty state and a read of the file
    // stands in for — gets the bracket back, including the bound the refusal put
    // under the declaration.
    limitAdaptivity(new Map());
    assert.equal(await loadLimitState(file), true);
    const read = limitBracket("kept-free");
    // The declaration the search had reached: the seed, held down by the bound
    // the refusal put under it — a model with no served request yet has no floor
    // to fall back to, so the estimate is all there is.
    assert.equal(read.ceiling, Math.floor(170000 * 0.98), "the declaration the search had reached");
    assert.equal(read.ceil, 170000, "and the bound the refusal put under it");
    assert.equal(read.refusals, 1);
    // The write is atomic: a temporary file beside the name, renamed over it, so
    // a reader never sees half a state file — and the temporary file is gone.
    assert.deepEqual(
      readdirSync(dirname(file)).filter((name) => name.startsWith(`${basename(file)}.`)),
      [],
      "no temporary file is left behind",
    );
    assert.deepEqual(JSON.parse(limitStateJSON(brackets)).models["kept-free"].ceil, 170000);
  } finally {
    limitAdaptivity(new Map());
    rmSync(file, { force: true });
  }
});

// Two saves inside one process used to land on one temporary path: the second
// truncated the file the first was about to rename, the rename failed, and the
// save answered false for a state file that was there. Measured 2026-10-20.
test("two saves at once both land, and the file holds one whole state", async () => {
  const { ESTIMATE_SCALE, saveLimitState } = await subject;
  const file = join(tmpdir(), `zen-limits-race-${process.pid}-${Date.now()}.json`);
  const brackets = new Map([
    ["kept-free", {
      floor: 90000, ceiling: 100000, step: 1024, scale: ESTIMATE_SCALE, refusals: 0,
      raisedAtSeen: 0, seen: 90000, seededFrom: 100000, raisedAt: 0, refusedAt: 0, seenAt: 0,
    }],
  ]);
  try {
    const [first, second] = await Promise.all([saveLimitState(file, brackets), saveLimitState(file, brackets)]);
    assert.equal(first, true, "the first save lands");
    assert.equal(second, true, "and so does the one that overlapped it");
    // One whole state, not half of one: the file is what the next process reads
    // as measured brackets.
    assert.equal(JSON.parse(readFileSync(file, { encoding: "utf8" })).models["kept-free"].ceiling, 100000);
    assert.deepEqual(
      readdirSync(dirname(file)).filter((name) => name.startsWith(`${basename(file)}.`)),
      [],
      "and no temporary file is left behind",
    );
  } finally {
    rmSync(file, { force: true });
  }
});

test("a state file is read field by field, and none of it may become a bracket nobody measured", async () => {
  const { ESTIMATE_SCALE, limitAdaptivity, limitBracket, limitStateJSON, loadLimitState } = await subject;
  const at = `${tmpdir()}/zen-limits-${process.pid}-${Date.now()}`;
  const write = (name, body) => {
    writeFileSync(`${at}-${name}.json`, body);
    return `${at}-${name}.json`;
  };
  try {
    // Round trip: the writer and the reader are one shape, so nothing the search
    // needs is lost between them.
    const map = new Map([
      ["round-free", { floor: 120000, ceil: 140000, ceiling: 130000, step: 4096, refusals: 2, seen: 120000 }],
    ]);
    const parsed = JSON.parse(limitStateJSON(map));
    assert.equal(parsed.version, 1);
    assert.deepEqual(
      { ...parsed.models["round-free"], raisedAt: 0, refusedAt: 0, seenAt: 0 },
      {
        floor: 120000,
        ceil: 140000,
        ceiling: 130000,
        step: 4096,
        scale: ESTIMATE_SCALE,
        refusals: 2,
        raisedAtSeen: 0,
        seen: 120000,
        raisedAt: 0,
        refusedAt: 0,
        seenAt: 0,
      },
    );
    // A version this file does not write is not a state file: reading one as a
    // bracket would be reading somebody else's fields as measurements.
    assert.equal(await loadLimitState(write("version", JSON.stringify({ version: 99, models: { x: { ceiling: 5 } } }))), false);
    // A record with nothing usable in it is dropped, and the file with only that
    // record is read as no state rather than as a model with no window.
    assert.equal(
      await loadLimitState(
        write("junk", JSON.stringify({ version: 1, models: { x: { ceiling: "big", floor: null, scale: ESTIMATE_SCALE } } })),
      ),
      false,
    );
    assert.equal(await loadLimitState(write("broken", "{not json")), false);
    assert.equal(await loadLimitState(write("empty", "")), false);
    // A record measured on another scale is dropped rather than read: the floor it
    // carries is a size the route was seen to serve as a DIFFERENT estimator
    // counted it, and this file cannot turn that into a token count. The file is
    // read as no state, which leaves the model with the table's own measurement
    // instead of bounding it with a count whose unit was wrong.
    assert.equal(
      await loadLimitState(
        write(
          "scale",
          JSON.stringify({ version: 1, models: { "old-scale-free": { floor: 228286, ceiling: 223942, scale: 1 } } }),
        ),
      ),
      false,
      "a record from another estimator is not evidence on this one",
    );
    assert.equal(
      await loadLimitState(
        write("noscale", JSON.stringify({ version: 1, models: { "no-scale-free": { floor: 228286, ceiling: 223942 } } })),
      ),
      false,
      "and a record that names no scale is from before there was one",
    );
    // And a file that really is one is read, with the junk fields of a record
    // that also holds good ones defaulted rather than trusted.
    const good = write(
      "good",
      JSON.stringify({
        version: 1,
        models: {
          "half-free": { floor: 90000, ceiling: 100000, step: -3, refusals: "many", ceil: 0, scale: ESTIMATE_SCALE },
        },
      }),
    );
    assert.equal(await loadLimitState(good), true);
    const read = limitBracket("half-free");
    assert.equal(read.floor, 90000);
    assert.equal(read.ceiling, 100000);
    assert.ok(read.step > 0, "a step that is not a size is re-seeded rather than read");
    assert.equal(read.refusals, 0);
    assert.equal(read.ceil, undefined, "a bound of zero is not a bound");
  } finally {
    limitAdaptivity(new Map());
    for (const name of ["version", "junk", "broken", "empty", "good", "scale", "noscale"])
      rmSync(`${at}-${name}.json`, { force: true });
  }
});

test("a report of a state file cannot itself become the state, and a state with no models in it is not written", async () => {
  const { ESTIMATE_SCALE, limitAdaptivity, limitStateJSON } = await subject;
  // A map with nothing in it writes a file with nothing in it, which is read
  // back as no state: writing one would be a file that says a bracket exists.
  assert.equal(limitStateJSON(new Map()), JSON.stringify({ version: 1, models: {} }));
  // Restoring a state hands back a copy: a caller that mutates what it was given
  // is mutating its own record and not the one the plugin reads. The record
  // carries the scale it was measured on, because a record from another
  // estimator is not evidence on this one — the same rule the state file is
  // read under, and the same reason it is asked for here.
  const held = limitAdaptivity(new Map([["copy-free", { floor: 10, ceiling: 20, scale: ESTIMATE_SCALE }]]));
  const first = limitAdaptivity();
  first.get("copy-free").floor = 999;
  assert.equal(limitAdaptivity().get("copy-free").floor, 10);
  limitAdaptivity(new Map());
  limitAdaptivity(held);
});

// An id comes out of a Map, and a caller's model id is not a safe key for a
// plain object: `models["__proto__"] = row` runs `Object.prototype`'s setter
// instead of adding a row. The row would be lost from the file — a restart
// would read no measurement for it — and the object written would carry a
// row-shaped prototype. A null-prototype map keeps the id as a key, and
// JSON.stringify writes the same bytes it does for any other map.
test("an id named __proto__ reaches the state file like any other", async () => {
  const { limitStateJSON } = await subject;
  const written = JSON.parse(limitStateJSON(new Map([["__proto__", { floor: 120000, ceiling: 130000 }]])));
  assert.deepEqual(Object.keys(written.models), ["__proto__"], "the row is an own key of the written map");
  assert.equal(written.models["__proto__"].ceiling, 130000, "and carries the measurement");
  assert.equal(Object.getPrototypeOf(written.models), Object.prototype, "and parsing it gives an ordinary object");
});

// A record measured on another scale is not this record, and the file path has
// always said so. The state can also be handed in by a caller, and that is the
// documented way to swap it, so a snapshot taken with an older estimator could
// otherwise bound a window with a count whose unit was wrong — the very failure
// the scale guard was added for.
test("a record measured on another scale is not restored either", async () => {
  const { ESTIMATE_SCALE, limitAdaptivity, limitBracket } = await subject;
  const previous = limitAdaptivity(new Map());
  const record = { floor: 228286, ceiling: 223942, step: 1024, refusals: 0, seededFrom: 223942, seen: 228286 };
  try {
    limitAdaptivity(
      new Map([
        ["scaled-free", { ...record, scale: ESTIMATE_SCALE }],
        ["old-scale-free", { ...record, scale: ESTIMATE_SCALE - 1 }],
        ["no-scale-free", { ...record }],
      ]),
    );
    assert.ok(limitBracket("scaled-free"), "a record measured on this scale is restored");
    assert.equal(
      limitBracket("old-scale-free"),
      undefined,
      "a record from another estimator is not evidence on this one",
    );
    assert.equal(
      limitBracket("no-scale-free"),
      undefined,
      "and a record that names no scale is from before there was one",
    );
  } finally {
    limitAdaptivity(previous);
  }
});

// The sweep's tier. Everything above this point is answered with no snapshot
// beside it; these are the cases that hand one in, because what a scheduled run
// commits is the one piece of this file's evidence that arrives without anybody
// editing this file.
const HIT = { value: 343000, settles: true, wall: "bracketed", at: "2026-10-19" };
const FLOOR = { value: 599000, settles: false, wall: "openEnded", at: "2026-10-19" };
const NO_WALLS = new Map();

test("a wall the sweep measured answers for an id the table never named", async () => {
  const { limitOverrides } = await subject;
  const walls = new Map([["new-free", HIT]]);
  // above the declaration: the catalogue under-reports, which is the case the
  // table was written for and a new model never gets a table entry for
  assert.deepEqual(
    limitOverrides("new-free", { context: 200000, output: 32000 }, undefined, undefined, undefined, NO_WALLS, walls),
    { context: 343000 },
  );
  // and below it: a catalogue that declares a million while the route refuses
  // past about 407,000 tokens is the same defect the other way round, which a
  // raise-only rule would leave standing
  assert.deepEqual(
    limitOverrides("new-free", { context: 1048576, output: 32000 }, undefined, undefined, undefined, NO_WALLS, walls),
    { context: 343000 },
  );
  // an axis the catalogue does not declare at all is answered the same way
  assert.deepEqual(limitOverrides("new-free", {}, undefined, undefined, undefined, NO_WALLS, walls), {
    context: 343000,
  });
});

test("a wall the sweep never hit may only raise the declaration", async () => {
  const { limitOverrides } = await subject;
  const walls = new Map([["new-free", FLOOR]]);
  // Nothing was refused, so the largest served prompt is a floor and not a
  // ceiling: declaring it over a bigger catalogue number would narrow a window on
  // the strength of a request that was never turned down.
  assert.deepEqual(
    limitOverrides("new-free", { context: 1048576, output: 32000 }, undefined, undefined, undefined, NO_WALLS, walls),
    {},
  );
  // Over a smaller one it is still a demonstration that the route serves that
  // much, which is what the raise is.
  assert.deepEqual(
    limitOverrides("new-free", { context: 200000, output: 32000 }, undefined, undefined, undefined, NO_WALLS, walls),
    { context: 599000 },
  );
  // and a floor that is exactly the declaration says nothing either way
  assert.deepEqual(limitOverrides("new-free", { context: 599000 }, undefined, undefined, undefined, NO_WALLS, walls), {});
});

test("the table keeps the first word for an id it names, whatever the sweep measured", async () => {
  const { limitOverrides } = await subject;
  const empty = new Map();
  // deepseek-v4.1-flash-free: the table's 326000 is the same kind of measurement
  // taken by hand and the largest served sample is beside it, so a sweep that
  // stopped at the first refusal — 215,178 tokens, its own record — does not get
  // to lower it
  assert.deepEqual(
    limitOverrides(
      "deepseek-v4.1-flash-free",
      { context: 200000, output: 32000 },
      undefined,
      empty,
      empty,
      empty,
      new Map([["deepseek-v4.1-flash-free", { value: 215000, settles: true, wall: "bracketed" }]]),
    ),
    { context: 326000, output: 384000 },
  );
  // and the entry only has the first word while it still applies: against a
  // catalogue that has moved past it, the swept window is what there is
  assert.deepEqual(
    limitOverrides(
      "deepseek-v4.1-flash-free",
      { context: 250000, output: 32000 },
      undefined,
      empty,
      empty,
      empty,
      new Map([["deepseek-v4.1-flash-free", { value: 215000, settles: true, wall: "bracketed" }]]),
    ),
    { context: 215000, output: 384000 },
  );
});

test("a sweep value seeds the search, so a bracket starts where the route was measured", async () => {
  const { limitOverrides } = await subject;
  // A record with no ceiling derives one from its seed. The seed is the settled
  // value, so a model whose window the sweep measured is searched from that window
  // rather than from the catalogue's optimistic number — which is the difference
  // between one probe and six.
  assert.deepEqual(
    limitOverrides(
      "new-free",
      { context: 1048576, output: 32000 },
      undefined,
      undefined,
      undefined,
      new Map([["new-free", {}]]),
      new Map([["new-free", HIT]]),
    ),
    { context: 343000 },
  );
  // with no sweep and no bracket the same declaration stands
  assert.deepEqual(
    limitOverrides("new-free", { context: 1048576, output: 32000 }, undefined, undefined, undefined, NO_WALLS, NO_WALLS),
    {},
  );
});

test("a sweep answers the context axis and nothing else", async () => {
  const { limitOverrides } = await subject;
  // The sweep asks for sixteen completion tokens, so nothing it watched says
  // anything about a completion ceiling: it must not invent one.
  assert.deepEqual(
    limitOverrides("new-free", { context: 200000, output: 32000 }, {}, new Map(), new Map(), new Map(), new Map([["new-free", HIT]])),
    { context: 343000 },
  );
});

test("a sweep value reaches the diagnostics sink with the wall and the day it was measured", async () => {
  const { limitOverrides, limitDiagnostics } = await subject;
  const seen = [];
  const previous = limitDiagnostics((entry) => seen.push(entry));
  try {
    limitOverrides("new-free", { context: 200000, output: 32000 }, {}, new Map(), new Map(), new Map(), new Map([["new-free", HIT]]));
  } finally {
    limitDiagnostics(previous);
  }
  assert.deepEqual(seen, [
    {
      kind: "sweep-statement",
      id: "new-free",
      axis: "context",
      value: 343000,
      declared: 200000,
      wall: "bracketed",
      at: "2026-10-19",
    },
  ]);
});

test("a served sample is floored to a whole thousand, and a wall nobody hit is a floor", async () => {
  const { measuredWalls } = await subject;
  const at = join(tmpdir(), `zen-sweep-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(
      at,
      JSON.stringify({
        version: 1,
        models: {
          "bracketed-free": {
            servedTokens: 343131,
            servedChars: 1600000,
            refusedChars: 1900000,
            refusedSizes: [1900000],
            wall: "bracketed",
            at: "2026-10-19",
          },
          "open-free": { servedTokens: 599561, servedChars: 2800000, refusedChars: null, refusedSizes: [], wall: "openEnded" },
          "never-served-free": { servedTokens: null, wall: "single-refusal" },
          "no-tokens-free": { servedChars: 2800000, wall: "openEnded" },
          "too-small-free": { servedTokens: 999, wall: "bracketed" },
        },
      }),
    );
    const walls = measuredWalls(at);
    assert.deepEqual(walls.get("bracketed-free"), {
      value: 343000,
      settles: true,
      wall: "bracketed",
      at: "2026-10-19",
    });
    assert.deepEqual(walls.get("open-free"), { value: 599000, settles: false, wall: "openEnded", at: undefined });
    // A run that only ever saw refusals has no sample to declare, and a sample
    // that floors to nothing is not a window.
    assert.equal(walls.has("never-served-free"), false);
    assert.equal(walls.has("no-tokens-free"), false);
    assert.equal(walls.has("too-small-free"), false);
  } finally {
    rmSync(at, { force: true });
  }
});

// The sweep writes the first refused size twice — as a number and as the head of
// the list — and a row whose two copies disagree was edited by hand into a state
// where it says two things about one ceiling. Which of them to believe is a
// guess, so the row is not read at all: it is the same answer as a row that was
// never measured.
test("a snapshot row that disagrees with itself is not a measurement", async () => {
  const { measuredWalls } = await subject;
  const at = join(tmpdir(), `zen-sweep-split-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(
      at,
      JSON.stringify({
        version: 1,
        models: {
          "agreeing-free": { servedTokens: 343131, refusedChars: 1900000, refusedSizes: [1900000, 2100000], wall: "bracketed" },
          "split-free": { servedTokens: 343131, refusedChars: 1900000, refusedSizes: [2100000], wall: "bracketed" },
          "one-sided-free": { servedTokens: 343131, refusedChars: 1900000, wall: "bracketed" },
          "nothing-refused-free": { servedTokens: 343131, refusedChars: null, refusedSizes: [], wall: "openEnded" },
        },
      }),
    );
    const walls = measuredWalls(at);
    assert.ok(walls.get("agreeing-free"), "a row that agrees with itself is read");
    assert.equal(walls.has("split-free"), false, "and one whose two copies differ is not");
    assert.equal(walls.has("one-sided-free"), false, "nor one that has a ceiling and no list of refusals");
    assert.ok(walls.get("nothing-refused-free"), "a row that says nothing was refused is read");
  } finally {
    rmSync(at, { force: true });
  }
});

test("the sweep is read once per file, and a file that is not one is no measurement", async () => {
  const { measuredWalls } = await subject;
  const at = join(tmpdir(), `zen-sweep-once-${process.pid}-${Date.now()}.json`);
  const broken = join(tmpdir(), `zen-broken-${process.pid}-${Date.now()}.json`);
  const listed = join(tmpdir(), `zen-listed-${process.pid}-${Date.now()}.json`);
  const other = join(tmpdir(), `zen-other-version-${process.pid}-${Date.now()}.json`);
  const unversioned = join(tmpdir(), `zen-unversioned-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(at, JSON.stringify({ version: 1, models: { "once-free": { servedTokens: 100000, wall: "bracketed" } } }));
    assert.equal(measuredWalls(at).get("once-free").value, 100000);
    // The file is an input that changes when somebody commits a run's result, not
    // while a process serves requests: what is already read stands, so the same
    // path is never a syscall per model list.
    writeFileSync(at, JSON.stringify({ version: 1, models: { "once-free": { servedTokens: 900000, wall: "bracketed" } } }));
    assert.equal(measuredWalls(at).get("once-free").value, 100000);
    // A path that is not there, one holding something else, and one whose models
    // are not a map all answer the way a build with no snapshot answers.
    assert.equal(measuredWalls(join(tmpdir(), `zen-absent-${process.pid}-${Date.now()}.json`)).size, 0);
    writeFileSync(broken, "{ this is not json");
    assert.equal(measuredWalls(broken).size, 0);
    writeFileSync(listed, JSON.stringify({ version: 1, models: ["a", "b"] }));
    assert.equal(measuredWalls(listed).size, 0);
    // A version this build does not know is no measurement either: the field says
    // what shape the rows are in, and rows written for another shape would be
    // read here as measurements of this one. The state file has been read this
    // way since it was written.
    writeFileSync(
      other,
      JSON.stringify({ version: 99, models: { "future-free": { servedTokens: 100000, wall: "bracketed" } } }),
    );
    assert.equal(measuredWalls(other).size, 0, "a snapshot of another version is not read");
    // ...and so is one that names no version at all.
    writeFileSync(
      unversioned,
      JSON.stringify({ models: { "unversioned-free": { servedTokens: 100000, wall: "bracketed" } } }),
    );
    assert.equal(measuredWalls(unversioned).size, 0, "a snapshot that names no version is not read");
  } finally {
    rmSync(at, { force: true });
    rmSync(broken, { force: true });
    rmSync(listed, { force: true });
    rmSync(other, { force: true });
    rmSync(unversioned, { force: true });
  }
});

test("the environment says where the sweep's file is, and an empty answer says it is nowhere", async () => {
  const { limitsSnapshotPath, LIMITS_SNAPSHOT_ENV } = await subject;
  assert.equal(limitsSnapshotPath("C:/named/by/a/caller.json"), "C:/named/by/a/caller.json");
  assert.equal(
    limitsSnapshotPath(undefined, { [LIMITS_SNAPSHOT_ENV]: "C:/named/by/the/env.json" }),
    "C:/named/by/the/env.json",
  );
  assert.equal(limitsSnapshotPath(undefined, { [LIMITS_SNAPSHOT_ENV]: "" }), "");
  // and with nothing said at all it is the file the sweep writes beside this
  // module: the one the scheduled run commits.
  assert.equal(limitsSnapshotPath(undefined, {}), SHIPPED_SNAPSHOT);
});

test("the shipped snapshot holds whole thousands and nothing else", async () => {
  const { measuredWalls } = await subject;
  // Read by path rather than through the environment, which this file has already
  // told that there is no snapshot. What is asserted is the shape of the file and
  // not the numbers in it: the scheduled run rewrites those, and a suite that
  // pinned them would go red every time the route moved.
  if (!existsSync(SHIPPED_SNAPSHOT)) return;
  const walls = measuredWalls(SHIPPED_SNAPSHOT);
  assert.ok(walls.size > 0, "the committed measurement names at least one model");
  for (const [id, wall] of walls) {
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
    assert.ok(Number.isSafeInteger(wall.value) && wall.value >= 1000 && wall.value % 1000 === 0, `${id}: ${wall.value}`);
    assert.equal(typeof wall.settles, "boolean");
    // Three kinds, and the third is the strongest: a window the route stated in
    // its own words settles the axis as it stands and is not rounded down, which
    // is how `nemotron-3.5-lightning-free` is read — the route answered with
    // 1000000 and the file keeps that number rather than a floor.
    assert.ok(
      wall.wall === "bracketed" || wall.wall === "openEnded" || wall.wall === "named",
      `${id}: ${wall.wall}`,
    );
    if (wall.wall === "named") assert.equal(wall.settles, true, `${id}: a named wall settles`);
  }
});

test("an input the catalogue declares under a measured window is raised to it, and never lowered", async () => {
  const { limitOverrides } = await subject;
  // The catalogue declares a 160000 input cap for a model the sweep watched serve
  // 343000 tokens, and magpie shows `context_window` as the smaller of the two
  // axes: left alone, that 160000 is the model's size on screen.
  assert.deepEqual(
    limitOverrides(
      "new-free",
      { context: 200000, input: 160000, output: 32000 },
      {},
      new Map(),
      new Map(),
      new Map(),
      new Map([["new-free", HIT]]),
    ),
    { context: 343000, input: 343000 },
  );
  // An input the catalogue declares above the measured window is left where it is:
  // the window already bounds what is shown, and lowering an axis nothing here
  // measured would be inventing a cap.
  assert.deepEqual(
    limitOverrides(
      "new-free",
      { context: 200000, input: 1048576, output: 32000 },
      {},
      new Map(),
      new Map(),
      new Map(),
      new Map([["new-free", HIT]]),
    ),
    { context: 343000 },
  );
  // With no input declared there is nothing to raise: magpie's own fallback reads
  // the window already.
  assert.deepEqual(
    limitOverrides("new-free", { context: 200000, output: 32000 }, {}, new Map(), new Map(), new Map(), new Map([["new-free", HIT]])),
    { context: 343000 },
  );
  // And it holds for a window the table measured, not only for the sweep's: this
  // is the shape big-pickle and space-bunny-free needed written out by hand.
  assert.deepEqual(
    limitOverrides(
      "mimo-v2.6-flash-free",
      { context: 200000, input: 160000, output: 32000 },
      undefined,
      new Map(),
      new Map(),
      new Map(),
      NO_WALLS,
    ),
    { context: 375000, input: 375000, output: 131072 },
  );
});

test("a window named while the process runs raises an input the catalogue left behind", async () => {
  const { limitOverrides } = await subject;
  // The strongest answer this axis has is a window the route named, and the input
  // axis follows it like any other measured window: without that, magpie's
  // `context_window` would be the smaller catalogue input and the route's own
  // statement would never reach the screen.
  assert.deepEqual(
    limitOverrides(
      "new-free",
      { context: 200000, input: 160000, output: 32000 },
      {},
      new Map([["new-free", 900000]]),
      new Map(),
      new Map(),
      NO_WALLS,
    ),
    { context: 900000, input: 900000 },
  );
  // A live window below the declared input leaves the declaration where it is: the
  // smaller of the two is already what is shown, and this file does not lower an
  // axis it has nothing else to say about.
  assert.deepEqual(
    limitOverrides(
      "new-free",
      { context: 200000, input: 1048576, output: 32000 },
      {},
      new Map([["new-free", 900000]]),
      new Map(),
      new Map(),
      NO_WALLS,
    ),
    { context: 900000 },
  );
});

test("a snapshot past the read ceiling is no measurement, and one naming the prototype keys is only ever keys", async () => {
  const { measuredWalls, limitOverrides } = await subject;
  const big = join(tmpdir(), `zen-sweep-big-${process.pid}-${Date.now()}.json`);
  const proto = join(tmpdir(), `zen-sweep-proto-${process.pid}-${Date.now()}.json`);
  try {
    // The file is read on a path that must not be talked into a large read, and the
    // ceiling is the one the state file is read under. A row invented to fill it is
    // refused whole rather than read in part, because half a model listing is not a
    // smaller listing.
    writeFileSync(
      big,
      JSON.stringify({ version: 1, models: { "filler-free": { servedTokens: 300000, wall: "bracketed" }, pad: "x".repeat(300 * 1024) } }),
    );
    assert.equal(measuredWalls(big).size, 0);
    // `__proto__` and `toString` are keys like any other in a Map, and reading them
    // as evidence for an id named that way says nothing about any other model: the
    // catalogue never offers such an id, and the ids this reads for are the ones
    // the file names. What matters is that nothing inherited becomes a measurement,
    // which `Object.entries` over a parsed object cannot produce.
    writeFileSync(proto, '{"version":1,"models":{"__proto__":{"servedTokens":900000,"wall":"bracketed"},"toString":{"servedTokens":900000,"wall":"bracketed"}}}');
    const walls = measuredWalls(proto);
    assert.equal(walls.size, 2);
    assert.equal(walls.get("__proto__").value, 900000);
    // and an id the file does not name is answered by the declaration it was handed,
    // prototype chain and all
    assert.deepEqual(limitOverrides("valueOf", { context: 200000 }, {}, new Map(), new Map(), new Map(), walls), {});
  } finally {
    rmSync(big, { force: true });
    rmSync(proto, { force: true });
  }
});

// models.dev is read as a second opinion on the SCALE of a round number, and
// nowhere else. The rule is one line of policy with two halves that fail
// differently: applied to an id under a million it would raise a window on a
// claim nobody measured, and applied as a majority vote it would take 1000000
// over 1048576 seventeen times out of nineteen — which is what the population
// for MiniMax's canonical model actually looks like.
test("models.dev is read as the largest claim, never as a vote", async () => {
  const { modelsDevClaims, modelsDevLimit } = await import("./limits.mjs");
  const doc = {
    providers: {
      a: { models: { one: { canonical_model_id: "x/model", limit: { context: 1_000_000 } } } },
      b: { models: { two: { canonical_model_id: "x/model", limit: { context: 1_048_576 } } } },
      c: { models: { three: { canonical_model_id: "x/model", limit: { context: 1_000_000 } } } },
      d: { models: { four: { canonical_model_id: "x/model", limit: { context: 1_000_000 } } } },
    },
  };
  const info = modelsDevClaims(doc);
  assert.equal(info.models, 1);
  assert.equal(
    modelsDevLimit("x/model"),
    1_048_576,
    "three providers saying 1000000 do not outvote the one that says 1048576",
  );
});

test("models.dev output uses the first-party entry, then the most common claim", async () => {
  const { modelsDevClaims, modelsDevOutput, modelsDevOutputSource, limitOverrides } = await import("./limits.mjs");
  try {
    modelsDevClaims({
      providers: {
        a: { models: { one: { canonical_model_id: "v/m", limit: { context: 200_000, output: 131_072 } } } },
        // An output-only row still counts: the two maxima are collected apart.
        b: { models: { two: { canonical_model_id: "v/m", limit: { output: 262_144 } } } },
        c: { models: { three: { canonical_model_id: "v/m", limit: { output: 100_000 } } } },
      },
    });
    assert.equal(modelsDevOutput("v/m"), 262_144, "a three-way tie takes the larger value");
    assert.equal(modelsDevOutputSource("v/m"), "b/two");
    const blank = { table: {}, observed: new Map(), observedOutput: new Map(), brackets: new Map(), walls: new Map() };
    const args = (declared, table = blank.table, observedOutput = blank.observedOutput) => [
      "id",
      declared,
      table,
      blank.observed,
      observedOutput,
      blank.brackets,
      blank.walls,
      "v/m",
    ];
    // The chosen models.dev claim is authoritative in both directions.
    assert.deepEqual(limitOverrides(...args({ context: 200_000, output: 32_000 })), { output: 262_144 });
    assert.deepEqual(
      limitOverrides(...args({ context: 200_000, output: 500_000 })),
      { output: 262_144 },
      "following models.dev also lowers a stale catalogue ceiling",
    );
    // The chosen models.dev claim is authoritative in both directions, over the
    // catalogue: 32000 up to 262144, and 500000 down to it. A route statement is
    // the one thing it may not cut, because that is evidence about this route
    // and the claim is evidence about the weights — `big-pickle` had a 131072
    // ceiling the route named in a refusal and 32000 on screen from its paid
    // twin's models.dev row.
    const table = { id: { output: { value: 999_999, source: "route", declaredAt: 32_000 } } };
    assert.deepEqual(
      limitOverrides(...args({ context: 200_000, output: 32_000 }, table)),
      { output: 999_999 },
      "a route statement above the claim is the declaration",
    );
    const below = { id: { output: { value: 200_000, source: "route", declaredAt: 32_000 } } };
    assert.deepEqual(
      limitOverrides(...args({ context: 200_000, output: 32_000 }, below)),
      { output: 262_144 },
      "a claim above the route's statement still wins, which is what the tier is for",
    );
    // A refusal this process saw is the same statement and newer than the table.
    const live = new Map([["id", 888_888]]);
    assert.deepEqual(limitOverrides(...args({ context: 200_000, output: 32_000 }, {}, live)), {
      output: 888_888,
    });
    const quiet = new Map([["id", 200_000]]);
    assert.deepEqual(limitOverrides(...args({ context: 200_000, output: 32_000 }, {}, quiet)), {
      output: 262_144,
    });
  } finally {
    modelsDevClaims({});
  }
});

test("a minority that copies context into output cannot raise the ceiling", async () => {
  const { modelsDevClaims, modelsDevOutput, modelsDevOutputSource } = await import("./limits.mjs");
  try {
    modelsDevClaims({
      providers: {
        a: { models: { one: { canonical_model_id: "deepseek/v4", limit: { context: 1_048_576, output: 384_000 } } } },
        b: { models: { two: { canonical_model_id: "deepseek/v4", limit: { context: 1_000_000, output: 384_000 } } } },
        c: { models: { three: { canonical_model_id: "deepseek/v4", limit: { context: 1_048_576, output: 384_000 } } } },
        // These are the shape the user caught: output copied from context.
        d: { models: { four: { canonical_model_id: "deepseek/v4", limit: { context: 1_048_576, output: 1_048_576 } } } },
        e: { models: { five: { canonical_model_id: "deepseek/v4", limit: { context: 1_048_576, output: 1_048_576 } } } },
      },
    });
    assert.equal(modelsDevOutput("deepseek/v4"), 384_000, "three 384000 claims beat two context-sized outliers");
    assert.equal(modelsDevOutputSource("deepseek/v4"), "a/one");
  } finally {
    modelsDevClaims({});
  }
});

test("the canonical model's own provider outranks resellers, even when resellers are louder", async () => {
  const { modelsDevClaims, modelsDevOutput, modelsDevOutputSource } = await import("./limits.mjs");
  try {
    modelsDevClaims({
      providers: {
        nvidia: { models: { official: { canonical_model_id: "nvidia/x", limit: { context: 1_048_576, output: 8_192 } } } },
        a: { models: { one: { canonical_model_id: "nvidia/x", limit: { context: 1_048_576, output: 1_048_576 } } } },
        b: { models: { two: { canonical_model_id: "nvidia/x", limit: { context: 1_048_576, output: 1_048_576 } } } },
        c: { models: { three: { canonical_model_id: "nvidia/x", limit: { context: 1_048_576, output: 1_048_576 } } } },
      },
    });
    assert.equal(modelsDevOutput("nvidia/x"), 8_192, "the first-party entry wins over three copied-context entries");
    assert.equal(modelsDevOutputSource("nvidia/x"), "nvidia/official");
  } finally {
    modelsDevClaims({});
  }
});

test("a '-free' route id is looked up as its paid twin in models.dev", async () => {
  const { modelsDevClaims, modelsDevOutputFor, modelsDevOutputSourceFor, modelsDevOutput } = await import("./limits.mjs");
  try {
    modelsDevClaims({
      providers: {
        opencode: {
          models: {
            "deepseek-v4.1-flash-free": { canonical_model_id: "deepseek/v4", limit: { output: 32_000 } },
            "deepseek-v4.1-flash": { canonical_model_id: "deepseek/v4", limit: { output: 384_000 } },
            // A paid twin is not required to have a canonical id; big-pickle is
            // the route's own id and models.dev describes it directly.
            "big-pickle": { limit: { output: 32_000 } },
          },
        },
        // The canonical aggregate would otherwise see these context-sized ones.
        a: { models: { one: { canonical_model_id: "deepseek/v4", limit: { output: 1_048_576 } } } },
        b: { models: { two: { canonical_model_id: "deepseek/v4", limit: { output: 1_048_576 } } } },
      },
    });
    assert.equal(
      modelsDevOutputFor("deepseek-v4.1-flash-free", "deepseek/v4"),
      384_000,
      "the suffix is removed and the paid twin's 384000 wins over the free entry and the copied-context entries",
    );
    assert.equal(modelsDevOutputFor("deepseek-v4.1-flash", "deepseek/v4"), 384_000);
    assert.equal(modelsDevOutputSourceFor("deepseek-v4.1-flash-free", "deepseek/v4"), "opencode/deepseek-v4.1-flash");
    assert.equal(modelsDevOutputFor("big-pickle", undefined), 32_000, "big-pickle has no suffix and is read directly");
    // The canonical accessor stays canonical-only; it is the fallback, not a
    // second spelling of the paid-twin lookup.
    assert.equal(modelsDevOutput("deepseek/v4"), 1_048_576);
  } finally {
    modelsDevClaims({});
  }
});

test("with no paid twin, the route's own row and the canonical claim are both read, and the larger wins", async () => {
  const { modelsDevClaims, modelsDevOutputFor, modelsDevOutputSourceFor } = await import("./limits.mjs");
  try {
    modelsDevClaims({
      providers: {
        opencode: {
          models: {
            // The route row under-declares what the consensus publishes...
            "mimo-v2.6-flash-free": { canonical_model_id: "xiaomi/mimo", limit: { output: 32_000 } },
            // ...and here the first-party canonical row is the one below.
            "vl-free": { canonical_model_id: "v/vl", limit: { output: 131_072 } },
          },
        },
        a: { models: { one: { canonical_model_id: "xiaomi/mimo", limit: { output: 131_072 } } } },
        b: { models: { two: { canonical_model_id: "xiaomi/mimo", limit: { output: 131_072 } } } },
        v: { models: { vl: { canonical_model_id: "v/vl", limit: { output: 8_192 } } } },
      },
    });
    assert.equal(
      modelsDevOutputFor("mimo-v2.6-flash-free", "xiaomi/mimo"),
      131_072,
      "there is no paid twin, so the canonical consensus answers",
    );
    assert.equal(modelsDevOutputSourceFor("mimo-v2.6-flash-free", "xiaomi/mimo"), "a/one");
    // The case models.dev's own data has: `opencode/nemotron-3.5-super-vl-free`
    // declares 131072 while `nvidia/…` declares 8192, the vendor's own service
    // default. Reading only the canonical row cut that ceiling by sixteen times.
    assert.equal(
      modelsDevOutputFor("vl-free", "v/vl"),
      131_072,
      "the route row outranks a first-party default below it",
    );
    assert.equal(modelsDevOutputSourceFor("vl-free", "v/vl"), "opencode/vl-free");
    // With no canonical claim there is nothing to compare, and the row answers.
    assert.equal(modelsDevOutputFor("vl-free", "v/missing"), 131_072);
  } finally {
    modelsDevClaims({});
  }
});

test("without a models.dev output claim, the table and live ceiling remain the fallback", async () => {
  const { modelsDevClaims, limitOverrides } = await import("./limits.mjs");
  try {
    modelsDevClaims({});
    const blank = { table: {}, observed: new Map(), observedOutput: new Map(), brackets: new Map(), walls: new Map() };
    const args = (declared, table = blank.table, observedOutput = blank.observedOutput) => [
      "id",
      declared,
      table,
      blank.observed,
      observedOutput,
      blank.brackets,
      blank.walls,
      "v/none",
    ];
    const table = { id: { output: { value: 64_000, source: "route", declaredAt: 32_000 } } };
    assert.deepEqual(limitOverrides(...args({ context: 200_000, output: 32_000 }, table)), { output: 64_000 });
    const live = new Map([["id", 96_000]]);
    assert.deepEqual(limitOverrides(...args({ context: 200_000, output: 32_000 }, blank.table, live)), { output: 96_000 });
  } finally {
    modelsDevClaims({});
  }
});

test("a models.dev row with no canonical id is not matched to anything", async () => {
  const { modelsDevClaims, modelsDevLimit } = await import("./limits.mjs");
  modelsDevClaims({
    providers: { a: { models: { alias: { limit: { context: 9_000_000 } } } } },
  });
  assert.equal(modelsDevLimit("alias"), undefined, "an alias nobody can match is not a claim about a model");
});

// The counter says how many models it saw two or more claims for, and it could
// not: only the winning claim was kept, so the count was the number of models
// with a claim at all — every one of them. The evidence it was for, a model one
// provider describes saying nothing a catalogue would not, was thrown away with
// the claims that lost.
test("a model one provider describes is not contested, and one several describe is", async () => {
  const { modelsDevClaims } = await import("./limits.mjs");
  try {
    const one = modelsDevClaims({
      providers: {
        a: { models: { one: { canonical_model_id: "x/one", limit: { context: 1_000_000 } } } },
        b: { models: { two: { canonical_model_id: "x/two", limit: { context: 1_000_000 } } } },
      },
    });
    assert.equal(one.models, 2);
    assert.equal(one.contested, 0, "one provider each is nobody's cross-provider evidence");
    // Two providers describing the same weights are, and one provider describing
    // the same model twice is still one provider.
    const several = modelsDevClaims({
      providers: {
        a: { models: { one: { canonical_model_id: "x/one", limit: { context: 1_000_000 } } } },
        b: { models: { two: { canonical_model_id: "x/one", limit: { context: 1_048_576 } } } },
        c: {
          models: {
            three: { canonical_model_id: "x/three", limit: { context: 1_000_000 } },
            four: { canonical_model_id: "x/three", limit: { context: 1_000_000 } },
          },
        },
      },
    });
    assert.equal(several.models, 2);
    assert.equal(several.contested, 1, "one model was described by two providers");
  } finally {
    // The claims are module-global, so the map is left as it was found.
    modelsDevClaims({});
  }
});

test("the second opinion only answers an axis the catalogue declares at a million", async () => {
  const { limitOverrides, modelsDevClaims, MODELS_DEV_MIN } = await import("./limits.mjs");
  assert.equal(MODELS_DEV_MIN, 1_000_000);
  modelsDevClaims({
    providers: {
      a: { models: { big: { canonical_model_id: "v/big", limit: { context: 1_048_576 } } } },
      b: { models: { small: { canonical_model_id: "v/small", limit: { context: 1_048_576 } } } },
    },
  });
  const blank = { table: {}, observed: new Map(), observedOutput: new Map(), brackets: new Map(), walls: new Map() };
  const args = (declared, canonical) => [
    "id",
    declared,
    blank.table,
    blank.observed,
    blank.observedOutput,
    blank.brackets,
    blank.walls,
    canonical,
  ];
  // Declared at a million: the second opinion is allowed to say the scale.
  assert.deepEqual(limitOverrides(...args({ context: 1_000_000 }, "v/big")), { context: 1_048_576 });
  // Declared under it: measurement answers, and a third party's claim does not.
  assert.deepEqual(limitOverrides(...args({ context: 200_000 }, "v/small")), {});
  // Never lowered either way.
  assert.deepEqual(limitOverrides(...args({ context: 2_000_000 }, "v/big")), {});
});

// The read has to be a JSON read. `readRemote` returns text when asked for it,
// and `modelsDevClaims` walked a string entry by entry and found nothing: the
// deployment answered the catalogue's 1000000 for a model models.dev puts at
// 1048576, with no error anywhere — the worst shape a bug can take.
test("a models.dev document reaches the claim reader as an object", async () => {
  const { modelsDevClaims, modelsDevLimit } = await import("./limits.mjs");
  // The failure this pins: text in, a full map out of nothing.
  const info = modelsDevClaims(JSON.stringify({
    providers: { a: { models: { one: { canonical_model_id: "x/m", limit: { context: 1_048_576 } } } } },
  }));
  assert.equal(info.models, 0, "a string is not a document, and must not be read as one");
  assert.equal(modelsDevLimit("x/m"), undefined);
  // And the shape that does work.
  const good = modelsDevClaims({
    providers: { a: { models: { one: { canonical_model_id: "x/m", limit: { context: 1_048_576 } } } } },
  });
  assert.equal(good.models, 1);
  assert.equal(modelsDevLimit("x/m"), 1_048_576);
});

// A table entry and a second opinion are not rivals: the entry measures the
// WALL, the opinion says what scale the catalogue's round number was written in.
// The arm used to require `settled.source === undefined`, which is "no table
// entry and no sweep" — so it was unreachable for every id the table names,
// which is every id it exists for. The deployment answered 1000000 for
// `minimax-m3.1-flash-free` with the claim map full.
test("a table entry does not lock the second opinion out", async () => {
  const { limitOverrides, modelsDevClaims } = await import("./limits.mjs");
  modelsDevClaims({
    providers: { a: { models: { m: { canonical_model_id: "v/m", limit: { context: 1_048_576 } } } } },
  });
  const table = {
    id: { context: { value: 1_000_000, source: "models.dev", declaredAt: 1_000_000, measured: "2026-10-20" } },
  };
  const over = limitOverrides(
    "id", { context: 1_000_000 }, table, new Map(), new Map(), new Map(), new Map(), "v/m",
  );
  assert.deepEqual(over, { context: 1_048_576 }, "the entry's number and the claim's agree, and the claim is higher");
});

test("a claim below a measurement never pulls the measurement down", async () => {
  const { limitOverrides, modelsDevClaims } = await import("./limits.mjs");
  modelsDevClaims({
    providers: { a: { models: { m: { canonical_model_id: "v/m2", limit: { context: 1_000_000 } } } } },
  });
  const table = {
    id: { context: { value: 1_048_092, source: "route", declaredAt: 1_000_000, measured: "2026-10-20" } },
  };
  const over = limitOverrides(
    "id", { context: 1_000_000 }, table, new Map(), new Map(), new Map(), new Map(), "v/m2",
  );
  assert.equal(over.context, 1_048_092, "a bisection outranks a provider's claim");
});

// A bracket is seeded FROM the catalogue's number, so before the route has said
// anything about a million-token id the bracket IS 1000000 — and the second
// opinion, which exists to correct exactly that number, was required to wait for
// `adopted === undefined`. It therefore waited for ever: the deployment kept
// answering 1000000 with the claim map full and a 1048576 claim in it.
test("a bracket seeded at the catalogue number does not pin the second opinion", async () => {
  const { limitOverrides, modelsDevClaims, limitAdaptivity, ESTIMATE_SCALE } = await import("./limits.mjs");
  modelsDevClaims({
    providers: { a: { models: { m: { canonical_model_id: "v/seeded", limit: { context: 1_048_576 } } } } },
  });
  const previous = limitAdaptivity(
    new Map([["id", {
      floor: 0, ceil: undefined, exact: false, refusals: 0, scale: ESTIMATE_SCALE,
      step: 50_000, seededFrom: 1_000_000, ceiling: 1_000_000,
    }]]),
  );
  try {
    const over = limitOverrides(
      "id", { context: 1_000_000 }, undefined, undefined, undefined, undefined, undefined, "v/seeded",
    );
    assert.equal(over.context, 1_048_576, "the claim corrects the number the bracket was seeded from");
  } finally {
    limitAdaptivity(previous);
  }
});

// And a bracket the ROUTE grew past the claim still wins: that is a size this
// route served, which no provider's page can contradict.
test("a bracket the route raised above the claim is not lowered", async () => {
  const { limitOverrides, modelsDevClaims, limitAdaptivity, ESTIMATE_SCALE } = await import("./limits.mjs");
  modelsDevClaims({
    providers: { a: { models: { m: { canonical_model_id: "v/high", limit: { context: 1_048_576 } } } } },
  });
  const previous = limitAdaptivity(
    new Map([["id", {
      floor: 1_100_000, ceil: undefined, exact: false, refusals: 0, scale: ESTIMATE_SCALE,
      step: 50_000, seededFrom: 1_000_000, ceiling: 1_100_000,
    }]]),
  );
  try {
    const over = limitOverrides(
      "id", { context: 1_000_000 }, undefined, undefined, undefined, undefined, undefined, "v/high",
    );
    assert.equal(over.context, 1_100_000);
  } finally {
    limitAdaptivity(previous);
  }
});

// A refusal under the largest size the route is known to have served is not a
// bound. It cannot be one: a wall refuses what is above it and serves what is
// below. Measured 2026-10-20 on `glm-5.3-flash-free`, whose upstream was failing
// intermittently — a request of 547,384 characters was answered and one of
// 540,983 was refused, and the bracket that made of it (floor 136973 over
// ceiling 135381) pinned the declaration at a third of the window.
test("a refusal under a served size is void, and spends nothing", async () => {
  const { observeRefusedRequest, limitAdaptivity } = await import("./limits.mjs");
  const previous = limitAdaptivity(new Map());
  try {
    const brackets = new Map();
    // The route answered a request of 200,000 tokens.
    brackets.set("id", {
      floor: 200_000, ceil: undefined, exact: false, refusals: 0,
      step: 1024, seededFrom: 200_000, ceiling: 200_000, seen: 200_000,
    });
    const after = observeRefusedRequest("id", { tokens: 150_000 }, 200_000, brackets);
    assert.equal(after.refusals, 0, "a refusal under the floor does not spend the budget");
    assert.equal(after.ceil, undefined, "and draws no bound");
    assert.equal(after.ceiling, 200_000, "the declaration is not moved by it");
  } finally {
    limitAdaptivity(previous);
  }
});

test("a refusal above a served size is still a bound", async () => {
  const { observeRefusedRequest, limitAdaptivity } = await import("./limits.mjs");
  const previous = limitAdaptivity(new Map());
  try {
    const brackets = new Map();
    brackets.set("id", {
      floor: 200_000, ceil: undefined, exact: false, refusals: 0,
      step: 1024, seededFrom: 200_000, ceiling: 200_000, seen: 200_000,
    });
    const after = observeRefusedRequest("id", { tokens: 300_000 }, 200_000, brackets);
    assert.equal(after.refusals, 1, "a refusal above the floor is a bound and costs one");
    assert.equal(after.ceil, 300_000);
  } finally {
    limitAdaptivity(previous);
  }
});

// The route's other wording for the same refusal, which the reader did not
// know: "invalid params, context window exceeds limit (2013)". Without it, a
// 400 that names no number read as about no axis at all, so the plugin did not
// learn a wall the route had just named.
test("the route's second wording for a too-long prompt is read as one", async () => {
  const { refusalAxis } = await import("./limits.mjs");
  assert.equal(
    refusalAxis(400, "Upstream request failed: [bad_request_error] invalid params, context window exceeds limit (2013)"),
    "context",
  );
  // And an upstream fault is still about no axis, which is what stopped the
  // sweep from narrowing toward a wall that was not there.
  assert.equal(
    refusalAxis(400, "Upstream request failed: [400] Provider returned error"),
    undefined,
  );
});

// A bracket is a search state, and it is seeded from whatever the declaration
// was when it was born. It may RAISE a declaration and never pull one down —
// and that has to hold against the table as well as against the catalogue's
// number.
//
// `glm-5.3-flash-free` was seeded when the table said 311,000; the table was
// then measured again and says 323,000, and the record read back from the state
// file still answered 311,000 — so the model was published a third smaller than
// the table, and a third smaller than the 323,107 tokens the route had served.
test("a bracket seeded from an older declaration may not pull the new one down", async () => {
  const { limitOverrides } = await subject;
  const brackets = new Map([
    ["glm-5.3-flash-free", { floor: 136_973, ceiling: 311_000, step: 1024, scale: 2, refusals: 0, seededFrom: 311_000, seen: 136_973 }],
  ]);
  const over = limitOverrides(
    "glm-5.3-flash-free", { context: 200_000, output: 32_000 }, undefined, undefined, undefined, brackets, undefined,
  );
  assert.equal(over.context, 323_000, "the table's measurement stands; a search state may not lower it");
});

// And the clamp repairs the record as it goes, so the state file is written
// with the corrected ceiling rather than the stale one.
test("the clamp repairs the record it read", async () => {
  const { limitOverrides } = await subject;
  const record = { floor: 136_973, ceiling: 311_000, step: 1024, scale: 2, refusals: 0, seededFrom: 311_000, seen: 136_973 };
  const brackets = new Map([["glm-5.3-flash-free", record]]);
  limitOverrides(
    "glm-5.3-flash-free", { context: 200_000, output: 32_000 }, undefined, undefined, undefined, brackets, undefined,
  );
  assert.equal(record.ceiling, 323_000, "so the next save writes the corrected number");
});

// A bracket that RAISES above the table still wins: that is a size this route
// served, which no table can contradict.
test("a bracket above the table still raises it", async () => {
  const { limitOverrides } = await subject;
  const brackets = new Map([
    ["glm-5.3-flash-free", { floor: 400_000, ceiling: 400_000, step: 1024, scale: 2, refusals: 0, seededFrom: 200_000, seen: 400_000 }],
  ]);
  const over = limitOverrides(
    "glm-5.3-flash-free", { context: 200_000, output: 32_000 }, undefined, undefined, undefined, brackets, undefined,
  );
  assert.equal(over.context, 400_000);
});

// A bracket that DID draw a bound of its own is left alone: a refusal with a
// serve just under it is the route saying the wall is below the table's, and
// that is a stronger tier than the table.
test("a bracket with evidence of its own still lowers the table", async () => {
  const { limitOverrides } = await subject;
  const brackets = new Map([
    ["glm-5.3-flash-free", { floor: 136_973, ceil: 137_244, ceiling: 136_973, step: 1024, scale: 2, refusals: 3, seededFrom: 311_000, seen: 136_973 }],
  ]);
  const over = limitOverrides(
    "glm-5.3-flash-free", { context: 200_000, output: 32_000 }, undefined, undefined, undefined, brackets, undefined,
  );
  assert.equal(over.context, 136_973, "the route's own refusal outranks the table");
});

// ---- the snapshot as a remote input -----------------------------------------
//
// The primitives below are the core of reading the same snapshot from the URL
// the workflow publishes. The provider turns them into a refresh timer; these
// cases pin the decisions it must not make for itself: which source wins, what a
// document has to look like to be one, and that a bad fetch never replaces a
// good answer.
const LOCAL_SNAPSHOT_ENV = "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT";
const snapshotDocument = (models, extra = {}) => JSON.stringify({ version: 1, models, ...extra });
const remoteRow = (over = {}) => ({
  servedTokens: 375_142,
  servedChars: 1_750_000,
  refusedChars: 1_787_500,
  refusedSizes: [1_787_500],
  wall: "bracketed",
  at: "2026-10-20",
  ...over,
});
const remoteWall = (value, over = {}) => ({ value, settles: true, wall: "bracketed", at: "2026-10-20", ...over });

test("the remote snapshot settings are the names the provider imports", async () => {
  const {
    LIMITS_SNAPSHOT_URL_ENV,
    LIMITS_SNAPSHOT_CACHE_ENV,
    LIMITS_SNAPSHOT_REFRESH_ENV,
    LIMITS_SNAPSHOT_TIMEOUT_ENV,
    DEFAULT_LIMITS_SNAPSHOT_URL,
  } = await subject;
  assert.equal(LIMITS_SNAPSHOT_URL_ENV, "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_URL");
  assert.equal(LIMITS_SNAPSHOT_CACHE_ENV, "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_CACHE");
  assert.equal(LIMITS_SNAPSHOT_REFRESH_ENV, "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_REFRESH_MS");
  assert.equal(LIMITS_SNAPSHOT_TIMEOUT_ENV, "OPENCODE_ZEN_FREE_LIMITS_SNAPSHOT_TIMEOUT_MS");
  assert.equal(
    DEFAULT_LIMITS_SNAPSHOT_URL,
    "https://raw.githubusercontent.com/tkhs101/OpenCode-Zen-FreeX/main/limits-observed.json",
  );
});

test("the remote URL is chosen by explicit, then env, then the published default", async () => {
  const { limitsSnapshotURL, DEFAULT_LIMITS_SNAPSHOT_URL, LIMITS_SNAPSHOT_URL_ENV } = await subject;
  assert.equal(limitsSnapshotURL(undefined, {}), DEFAULT_LIMITS_SNAPSHOT_URL, "nothing named reads the published file");
  assert.equal(
    limitsSnapshotURL("https://explicit.test/s.json", { [LIMITS_SNAPSHOT_URL_ENV]: "https://env.test/s.json" }),
    "https://explicit.test/s.json",
    "an explicit URL is the caller's own answer",
  );
  assert.equal(limitsSnapshotURL("", {}), undefined, "an explicit empty string disables the remote");
  assert.equal(
    limitsSnapshotURL(undefined, { [LIMITS_SNAPSHOT_URL_ENV]: "https://env.test/s.json" }),
    "https://env.test/s.json",
    "an environment URL is read next",
  );
  assert.equal(limitsSnapshotURL(undefined, { [LIMITS_SNAPSHOT_URL_ENV]: "" }), undefined, "and empty disables it");
  // A local snapshot path is the operator choosing a source; the remote is off.
  // `Object.hasOwn` is what makes an empty value a pin too: "no local file" is a
  // statement about the source, not a request to fetch one.
  assert.equal(limitsSnapshotURL(undefined, { [LOCAL_SNAPSHOT_ENV]: "/tmp/local.json" }), undefined);
  assert.equal(limitsSnapshotURL(undefined, { [LOCAL_SNAPSHOT_ENV]: "" }), undefined);
  // ...and the pin outranks the URL variable too, not only the default. An
  // operator who named a local source has chosen one; a URL beside it is not a
  // second source to fetch behind that choice.
  assert.equal(
    limitsSnapshotURL(undefined, {
      [LOCAL_SNAPSHOT_ENV]: "/tmp/local.json",
      [LIMITS_SNAPSHOT_URL_ENV]: "https://mirror.test/s.json",
    }),
    undefined,
    "a local path plus a URL is still a pinned local source",
  );
  assert.equal(
    limitsSnapshotURL(undefined, {
      [LOCAL_SNAPSHOT_ENV]: "",
      [LIMITS_SNAPSHOT_URL_ENV]: "https://mirror.test/s.json",
    }),
    undefined,
    "an empty pin plus a URL is still no snapshot at all",
  );
});

test("the remote cache path is explicit, then env, then the platform cache directory", async () => {
  const { limitsSnapshotCachePath, LIMITS_SNAPSHOT_CACHE_ENV } = await subject;
  const root = join(tmpdir(), `zen-remote-cache-root-${process.pid}`);
  assert.equal(
    limitsSnapshotCachePath(undefined, { XDG_CACHE_HOME: root }),
    join(root, "opencode-zen-freex", "limits-observed.remote.json"),
    "nothing named lands in the platform cache directory beside the limits state",
  );
  assert.equal(limitsSnapshotCachePath("/custom/remote.json", { [LIMITS_SNAPSHOT_CACHE_ENV]: "/env/x.json" }), "/custom/remote.json");
  assert.equal(limitsSnapshotCachePath("", {}), undefined, "an explicit empty string disables the cache");
  assert.equal(limitsSnapshotCachePath(undefined, { [LIMITS_SNAPSHOT_CACHE_ENV]: "/env/x.json" }), "/env/x.json");
  assert.equal(limitsSnapshotCachePath(undefined, { [LIMITS_SNAPSHOT_CACHE_ENV]: "" }), undefined);
});

test("the refresh interval is a positive whole number of milliseconds, one hour by default", async () => {
  const { limitsSnapshotRefreshMs, LIMITS_SNAPSHOT_REFRESH_ENV } = await subject;
  assert.equal(limitsSnapshotRefreshMs(undefined, {}), 3_600_000);
  assert.equal(limitsSnapshotRefreshMs(120_000, {}), 120_000, "an explicit interval wins");
  assert.equal(limitsSnapshotRefreshMs(undefined, { [LIMITS_SNAPSHOT_REFRESH_ENV]: "60000" }), 60_000);
  for (const bad of [0, -1, 1.5, "nope", "", undefined]) assert.equal(limitsSnapshotRefreshMs(bad, {}), 3_600_000, String(bad));
  assert.equal(limitsSnapshotRefreshMs(undefined, { [LIMITS_SNAPSHOT_REFRESH_ENV]: "0" }), 3_600_000);
  assert.equal(limitsSnapshotRefreshMs(undefined, { [LIMITS_SNAPSHOT_REFRESH_ENV]: "1.5" }), 3_600_000);
});

test("the snapshot timeout is bounded to 100..60000 ms, five seconds by default", async () => {
  const { limitsSnapshotTimeoutMs, LIMITS_SNAPSHOT_TIMEOUT_ENV } = await subject;
  assert.equal(limitsSnapshotTimeoutMs(undefined, {}), 5_000);
  assert.equal(limitsSnapshotTimeoutMs(700, {}), 700);
  assert.equal(limitsSnapshotTimeoutMs(undefined, { [LIMITS_SNAPSHOT_TIMEOUT_ENV]: "100" }), 100);
  assert.equal(limitsSnapshotTimeoutMs(undefined, { [LIMITS_SNAPSHOT_TIMEOUT_ENV]: "60000" }), 60_000);
  for (const bad of [99, 60_001, 0, -1, 1.5, "nope", ""])
    assert.equal(limitsSnapshotTimeoutMs(bad, {}), 5_000, String(bad));
  assert.equal(limitsSnapshotTimeoutMs(undefined, { [LIMITS_SNAPSHOT_TIMEOUT_ENV]: "99" }), 5_000);
  assert.equal(limitsSnapshotTimeoutMs(undefined, { [LIMITS_SNAPSHOT_TIMEOUT_ENV]: "60001" }), 5_000);
});

test("a snapshot document is parsed into the walls it measures", async () => {
  const { parseSnapshotDocument } = await subject;
  const walls = parseSnapshotDocument(
    snapshotDocument({
      "bracketed-free": remoteRow(),
      "open-free": { servedTokens: 599_561, refusedChars: null, refusedSizes: [], wall: "openEnded", at: "2026-10-19" },
      "named-free": { wall: "named", named: 1_000_000, at: "2026-10-20" },
      // A prototype name is a key like any other in a Map, and is evidence for
      // the id that names it and no other model.
      toString: { servedTokens: 200_000, wall: "bracketed", at: "2026-10-18" },
    }),
  );
  assert.equal(walls.size, 4);
  assert.deepEqual(walls.get("bracketed-free"), {
    value: 375_000,
    settles: true,
    wall: "bracketed",
    at: "2026-10-20",
  });
  assert.deepEqual(walls.get("open-free"), {
    value: 599_000,
    settles: false,
    wall: "openEnded",
    at: "2026-10-19",
  });
  assert.deepEqual(walls.get("named-free"), {
    value: 1_000_000,
    settles: true,
    wall: "named",
    at: "2026-10-20",
  });
  assert.equal(walls.get("toString").value, 200_000);
});

test("a snapshot document that is not one is no measurement at all", async () => {
  const { parseSnapshotDocument } = await subject;
  assert.equal(parseSnapshotDocument("not json"), undefined);
  assert.equal(parseSnapshotDocument(JSON.stringify({ version: 2, models: {} })), undefined, "another version is another shape");
  assert.equal(parseSnapshotDocument(JSON.stringify({ models: { "a-free": remoteRow() } })), undefined, "and no version is not this one");
  assert.equal(parseSnapshotDocument(JSON.stringify({ version: 1, models: [] })), undefined, "models is a map, not a list");
  assert.equal(parseSnapshotDocument(JSON.stringify({ version: 1, models: null })), undefined);
  assert.equal(parseSnapshotDocument("x".repeat(256 * 1024 + 1)), undefined, "a document over the read ceiling is not read");
  const tooMany = {};
  for (let at = 0; at <= 1_000; at += 1) tooMany[`row-${at}-free`] = { servedTokens: 1000, wall: "openEnded" };
  const manyText = snapshotDocument(tooMany);
  assert.ok(manyText.length < 256 * 1024, "the row-limit case is inside the size ceiling, or it tests the wrong bound");
  assert.equal(parseSnapshotDocument(manyText), undefined, "more rows than a human-reviewed file may hold");
  // Zero valid rows is a document this build cannot read, not an empty list of
  // measurements: installing it would wipe the bundled table.
  assert.equal(parseSnapshotDocument(snapshotDocument({})), undefined);
});

test("a row that fails a rule is skipped, and one good row keeps the document", async () => {
  const { parseSnapshotDocument } = await subject;
  const walls = parseSnapshotDocument(
    snapshotDocument({
      ["__proto__"]: { servedTokens: 100_000, wall: "bracketed" },
      "": { servedTokens: 100_000, wall: "bracketed" },
      "text-free": "openEnded",
      "list-free": [],
      "wall-free": { servedTokens: 100_000, wall: "bracketedt" },
      "disagree-free": { servedTokens: 100_000, refusedChars: 1000, refusedSizes: [2000], wall: "bracketed" },
      "zero-free": { servedTokens: 0, wall: "openEnded" },
      "float-free": { servedTokens: 1000.5, wall: "openEnded" },
      "under-a-thousand-free": { servedTokens: 999, wall: "openEnded" },
      "huge-free": { servedTokens: 4_000_001, wall: "openEnded" },
      "chars-huge-free": { servedTokens: 100_000, servedChars: 32_000_001, wall: "openEnded" },
      "tokens-too-dense-free": { servedTokens: 1_000_000, servedChars: 400_000, wall: "openEnded" },
      "good-free": { servedTokens: 100_000, wall: "openEnded" },
    }),
  );
  assert.deepEqual([...walls.keys()], ["good-free"], "only the row that passes every rule is a measurement");
  assert.equal(walls.get("good-free").value, 100_000);
});

test("the remote bounds are inclusive where the sweep's own are", async () => {
  const { parseSnapshotDocument } = await subject;
  const walls = parseSnapshotDocument(
    snapshotDocument({
      "top-tokens-free": { servedTokens: 4_000_000, servedChars: 32_000_000, wall: "openEnded" },
      // 497,952 * 2 + 4096 = 1,000,000 exactly: the envelope's slack is inclusive.
      "at-slack-free": { servedTokens: 1_000_000, servedChars: 497_952, wall: "openEnded" },
      "over-slack-free": { servedTokens: 1_000_000, servedChars: 497_951, wall: "openEnded" },
    }),
  );
  assert.ok(walls.has("top-tokens-free"));
  assert.ok(walls.has("at-slack-free"));
  assert.equal(walls.has("over-slack-free"), false, "one character short of the slack is a row about two different things");
});

test("a named window is held to the token ceiling too", async () => {
  const { parseSnapshotDocument } = await subject;
  const walls = parseSnapshotDocument(
    snapshotDocument({
      "named-top-free": { wall: "named", named: 4_000_000 },
      "named-over-free": { wall: "named", named: 4_000_001 },
      "named-absurd-free": { wall: "named", named: 9_000_000_000 },
      "named-good-free": { wall: "named", named: 1_048_576 },
    }),
  );
  assert.deepEqual(
    [...walls.keys()].sort(),
    ["named-good-free", "named-top-free"],
    "named is a token count and obeys the same ceiling as a served one",
  );
  assert.equal(walls.get("named-top-free").value, 4_000_000);
});

test("an installed answer is what measuredWalls(undefined) reads, until it is cleared", async () => {
  const { installSnapshot, measuredWalls, clearInstalledSnapshot, snapshotState } = await subject;
  const restorePin = unpinSnapshot();
  clearInstalledSnapshot();
  try {
    assert.equal(snapshotState(), undefined, "nothing is installed at the start");
    assert.equal(installSnapshot(new Map(), { source: "remote" }), false, "an empty map is no answer");
    assert.equal(installSnapshot(new Map([["a-free", remoteWall(1000)]]), { source: "remote", fetchedAt: 1234, url: "https://example.test/x" }), true);
    assert.equal(measuredWalls().get("a-free").value, 1000, "the installed answer answers the no-file question");
    const state = snapshotState();
    assert.equal(state.source, "remote");
    assert.equal(state.fetchedAt, 1234);
    assert.equal(state.url, "https://example.test/x");
    assert.ok(Number.isFinite(state.ageMs) && state.ageMs >= 0);
    // A copy, not the stored object: a caller that mutates what it was handed
    // is mutating its own view, not the answer a request reads.
    const again = snapshotState();
    assert.notEqual(again, state);
    assert.equal(
      installSnapshot(new Map([["b-free", remoteWall(2000)]]), { source: "cache" }),
      true,
      "a later answer replaces the first",
    );
    assert.equal(measuredWalls().has("a-free"), false);
    assert.equal(measuredWalls().get("b-free").value, 2000);
    // An empty pin is "no snapshot at all", not "no opinion": it must disable
    // the installed answer too, or the documented kill switch cannot kill a
    // cache this process has already installed.
    process.env[SNAPSHOT_ENV] = "";
    assert.equal(measuredWalls().size, 0, "an empty pin does not disable the installed answer");
    delete process.env[SNAPSHOT_ENV];
    // ...and a file the caller names is always its own answer, installed or not.
    const file = join(tmpdir(), `zen-remote-explicit-${process.pid}-${Date.now()}.json`);
    try {
      writeFileSync(file, snapshotDocument({ "file-free": { servedTokens: 200_000, wall: "openEnded" } }));
      const explicit = measuredWalls(file);
      assert.equal(explicit.has("file-free"), true);
      assert.equal(explicit.has("b-free"), false, "the installed answer does not leak into a named file");
    } finally {
      rmSync(file, { force: true });
    }
  } finally {
    clearInstalledSnapshot();
    restorePin();
  }
});

test("an env-named snapshot file outranks an installed answer, and an explicit file outranks both", async () => {
  const { installSnapshot, measuredWalls, clearInstalledSnapshot } = await subject;
  const previous = process.env[LOCAL_SNAPSHOT_ENV];
  const file = join(tmpdir(), `zen-remote-env-${process.pid}-${Date.now()}.json`);
  clearInstalledSnapshot();
  try {
    writeFileSync(file, snapshotDocument({ "local-free": { servedTokens: 100_000, wall: "openEnded" } }));
    installSnapshot(new Map([["remote-free", remoteWall(1000)]]), { source: "remote" });
    process.env[LOCAL_SNAPSHOT_ENV] = file;
    // The process may have cached this path's bundled read already; that is the
    // file's answer either way, and the point here is only which source wins.
    assert.equal(measuredWalls().has("local-free"), true, "an operator-pinned path is the source");
    assert.equal(measuredWalls().has("remote-free"), false, "the installed answer stands aside for it");
    assert.equal(measuredWalls(file).has("local-free"), true, "and naming it explicitly is the same answer");
  } finally {
    clearInstalledSnapshot();
    if (previous === undefined) delete process.env[LOCAL_SNAPSHOT_ENV];
    else process.env[LOCAL_SNAPSHOT_ENV] = previous;
    rmSync(file, { force: true });
  }
});

test("a streamed body past the ceiling is cancelled rather than buffered", async () => {
  const { refreshSnapshot, snapshotState, clearInstalledSnapshot } = await subject;
  clearInstalledSnapshot();
  let canceled = false;
  const body = {
    getReader() {
      let sent = 0;
      return {
        async read() {
          sent += 1;
          if (sent > 3) return { done: true, value: undefined };
          return { done: false, value: new Uint8Array(100_000).fill(120) };
        },
        async cancel() {
          canceled = true;
        },
        releaseLock() {},
      };
    },
  };
  try {
    const result = await refreshSnapshot({
      url: "https://example.test/chunked.json",
      fetchImpl: async () => ({ ok: true, headers: { get: () => null }, body }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "too-large", "the running byte count is the ceiling, not an after-the-fact string length");
    assert.equal(canceled, true, "the body was cancelled when the ceiling was crossed");
    assert.equal(snapshotState(), undefined);
  } finally {
    clearInstalledSnapshot();
  }
});

test("the remote cache is read only when it holds a whole valid snapshot", async () => {
  const { readSnapshotCache } = await subject;
  const dir = mkdtempSync(join(tmpdir(), "zen-remote-cache-"));
  const file = join(dir, "limits.remote.json");
  try {
    writeFileSync(file, "not json");
    assert.equal(readSnapshotCache(file), undefined, "a cache that is not JSON is no cache");
    writeFileSync(file, snapshotDocument({}));
    assert.equal(readSnapshotCache(file), undefined, "and one with no valid row is no answer, not an empty one");
    const text = snapshotDocument({ "a-free": remoteRow() });
    writeFileSync(file, text);
    const cached = readSnapshotCache(file);
    assert.ok(cached, "a whole document is a cache");
    assert.equal(cached.walls.get("a-free").value, 375_000);
    assert.equal(cached.fetchedAt, statSync(file).mtimeMs, "the cache's own write time is its fetchedAt");
    assert.equal(readSnapshotCache(join(dir, "missing.json")), undefined);
    // Startup reads the cache synchronously, so its size and kind are checked
    // before the read: a corrupt large file or a non-file cannot stall a start.
    writeFileSync(file, "x".repeat(256 * 1024 + 1));
    assert.equal(readSnapshotCache(file), undefined, "a cache over the read ceiling is not read");
    assert.equal(readSnapshotCache(dir), undefined, "a directory is not a cache file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful refresh installs the answer and caches the validated bytes atomically", async () => {
  const {
    refreshSnapshot,
    measuredWalls,
    readSnapshotCache,
    snapshotState,
    clearInstalledSnapshot,
  } = await subject;
  const dir = mkdtempSync(join(tmpdir(), "zen-remote-refresh-"));
  const cache = join(dir, "nested", "limits.remote.json");
  const text = snapshotDocument({ "remote-free": remoteRow() });
  const restorePin = unpinSnapshot();
  clearInstalledSnapshot();
  try {
    const result = await refreshSnapshot({
      url: "https://example.test/limits-observed.json",
      cachePath: cache,
      fetchImpl: async () => new Response(text, { status: 200, headers: { "content-type": "application/json" } }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.reason, undefined);
    assert.equal(result.walls.get("remote-free").value, 375_000);
    assert.ok(Number.isFinite(result.fetchedAt));
    assert.equal(measuredWalls().get("remote-free").value, 375_000, "and it is installed");
    const state = snapshotState();
    assert.equal(state.source, "remote");
    assert.equal(state.url, "https://example.test/limits-observed.json");
    assert.equal(state.fetchedAt, result.fetchedAt);
    assert.equal(readFileSync(cache, "utf8"), text, "the raw validated text is what is cached");
    if (process.platform !== "win32")
      assert.equal(statSync(cache).mode & 0o777, 0o600, "the cache is private");
    assert.deepEqual(
      readdirSync(dirname(cache)).filter((name) => name.endsWith(".tmp")),
      [],
      "the temporary it was written through is gone",
    );
    const cached = readSnapshotCache(cache);
    assert.ok(cached);
    assert.equal(cached.walls.get("remote-free").value, 375_000);
    // A cache that cannot be written is not a refresh that failed: the answer is
    // installed, which is the part a request reads.
    const blocker = join(dir, "not a directory");
    writeFileSync(blocker, "x");
    const blocked = await refreshSnapshot({
      url: "https://example.test/limits-observed.json",
      cachePath: join(blocker, "cache.json"),
      fetchImpl: async () => new Response(text, { status: 200 }),
    });
    assert.equal(blocked.ok, true, "the cache is an optimisation, not the answer");
  } finally {
    clearInstalledSnapshot();
    restorePin();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed refresh answers why and leaves the installed answer untouched", async () => {
  const { refreshSnapshot, installSnapshot, measuredWalls, snapshotState, clearInstalledSnapshot } = await subject;
  const text = snapshotDocument({ "remote-free": remoteRow() });
  const restorePin = unpinSnapshot();
  clearInstalledSnapshot();
  const installed = new Map([["kept-free", remoteWall(1000)]]);
  installSnapshot(installed, { source: "cache", fetchedAt: 1234, url: "https://old.test/s.json" });
  const before = snapshotState();
  try {
    const cases = [
      [{ url: "ftp://example.test/x" }, "url"],
      [{ url: "not a url" }, "url"],
      [{ url: "https://example.test/x", fetchImpl: async () => { throw new Error("boom"); } }, "fetch"],
      [{ url: "https://example.test/x", fetchImpl: null }, "fetch"],
      [
        { url: "https://example.test/x", fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "" }) },
        "http",
      ],
      [
        { url: "https://example.test/x", fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); } },
        "timeout",
      ],
      [
        {
          url: "https://example.test/x",
          fetchImpl: async () => ({ ok: true, headers: { get: () => String(300 * 1024) }, text: async () => text }),
        },
        "too-large",
      ],
      [
        { url: "https://example.test/x", fetchImpl: async () => ({ ok: true, headers: { get: () => null }, text: async () => "x".repeat(300 * 1024) }) },
        "too-large",
      ],
      [
        { url: "https://example.test/x", fetchImpl: async () => ({ ok: true, headers: { get: () => null }, text: async () => "not json" }) },
        "invalid",
      ],
      [
        { url: "https://example.test/x", fetchImpl: async () => ({ ok: true, headers: { get: () => null }, text: async () => snapshotDocument({}) }) },
        "invalid",
      ],
    ];
    for (const [args, reason] of cases) {
      const result = await refreshSnapshot(args);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.equal(result.reason, reason, JSON.stringify(args));
      assert.equal(measuredWalls().get("kept-free").value, 1000, "the installed answer stands");
      const now = snapshotState();
      assert.equal(now.source, before.source);
      assert.equal(now.fetchedAt, before.fetchedAt);
      assert.equal(now.url, before.url);
    }
  } finally {
    clearInstalledSnapshot();
    restorePin();
  }
});

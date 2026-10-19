import assert from "node:assert/strict";
import test from "node:test";
// The adaptive cases read and write real files: a state file is the one thing
// this module puts on disk, and a case with a stubbed file system would not be
// testing the one promise made about it — that a bracket survives a restart.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const subject = import("./limits.mjs").catch((error) => {
  assert.fail(`limits.mjs failed to load: ${error?.message ?? error}`);
});

const DECLARED = { context: 200000, output: 32000 };

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
    context: 343000,
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
    context: 311000,
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
  // a live window does not stand in for an input nobody named: the maps carry
  // refusals, and no refusal names this axis
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
    { context: 900000, output: 64000 },
    "the input axis has no live form",
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
    context: 343000,
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
  const { limitOverrides } = await subject;
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
  // and a marker on `Object.prototype` is the same read: no record declares it,
  // so no model is measured against it — on any table, shipped one included. The
  // patch goes on inside the `try` whose `finally` takes it off: a global
  // assignment applied before the restore can be reached is one that outlives
  // this case's own failure and leaves the prototype dirty for every later case
  // in the process that reads it.
  try {
    Object.prototype.context = { value: 999999, source: "route", declaredAt: 200000 };
    assert.deepEqual(limitOverrides("nothing-measured-free", { context: 200000, output: 32000 }), {});
    assert.deepEqual(limitOverrides("deepseek-v4.1-flash-free", { context: 200000, output: 32000 }), {
      context: 326000,
      output: 384000,
    });
  } finally {
    delete Object.prototype.context;
  }
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
      context: 343000,
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
  const { observeRouteStatement, limitOverrides, namedOutputCap, LIMITS } = await subject;
  const at = CEILING_WORDING.indexOf("262144");
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
  assert.deepEqual(models["mimo-v2.6-flash-free"].limit, { context: 343000, output: 131072 });
  // both axes have evidence for this one, and the catalogue's own `input`
  // survives untouched because nothing on this route has ever named an input cap
  assert.deepEqual(models["big-pickle"].limit, { context: 343000, input: 160000, output: 131072 });
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
      { context: 343000, output: 131072 },
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
      value: 343000,
      measuredAgainst: 200000,
      declared: 250000,
    },
    {
      kind: "catalogue-drift",
      id: "mimo-v2.6-flash-free",
      axis: "context",
      value: 343000,
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
    /mimo-v2\.6-flash-free context=343000 was measured against a catalogue that declared 200000, and this one declares 250000: not applied/,
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
  // The route's own calibration for Latin filler: 4.66 characters per token,
  // measured on 2026-10-19. An estimate is an estimate, and this case pins the
  // ratio rather than a tokenizer this plugin does not have.
  assert.equal(estimateTokens("a".repeat(466)), 100);
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
  assert.deepEqual(requestSize({ messages: [{ content: "a".repeat(466) }] }), { tokens: 100 });
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
    // a reader never sees half a state file.
    assert.equal(existsSync(`${file}.${process.pid}.tmp`), false, "no temporary file is left behind");
    assert.deepEqual(JSON.parse(limitStateJSON(brackets)).models["kept-free"].ceil, 170000);
  } finally {
    limitAdaptivity(new Map());
    rmSync(file, { force: true });
  }
});

test("a state file is read field by field, and none of it may become a bracket nobody measured", async () => {
  const { limitAdaptivity, limitBracket, limitStateJSON, loadLimitState } = await subject;
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
      { floor: 120000, ceil: 140000, ceiling: 130000, step: 4096, refusals: 2, seen: 120000, raisedAt: 0, refusedAt: 0, seenAt: 0 },
    );
    // A version this file does not write is not a state file: reading one as a
    // bracket would be reading somebody else's fields as measurements.
    assert.equal(await loadLimitState(write("version", JSON.stringify({ version: 99, models: { x: { ceiling: 5 } } }))), false);
    // A record with nothing usable in it is dropped, and the file with only that
    // record is read as no state rather than as a model with no window.
    assert.equal(await loadLimitState(write("junk", JSON.stringify({ version: 1, models: { x: { ceiling: "big", floor: null } } }))), false);
    assert.equal(await loadLimitState(write("broken", "{not json")), false);
    assert.equal(await loadLimitState(write("empty", "")), false);
    // And a file that really is one is read, with the junk fields of a record
    // that also holds good ones defaulted rather than trusted.
    const good = write(
      "good",
      JSON.stringify({
        version: 1,
        models: { "half-free": { floor: 90000, ceiling: 100000, step: -3, refusals: "many", ceil: 0 } },
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
    for (const name of ["version", "junk", "broken", "empty", "good"]) rmSync(`${at}-${name}.json`, { force: true });
  }
});

test("a report of a state file cannot itself become the state, and a state with no models in it is not written", async () => {
  const { limitAdaptivity, limitStateJSON } = await subject;
  // A map with nothing in it writes a file with nothing in it, which is read
  // back as no state: writing one would be a file that says a bracket exists.
  assert.equal(limitStateJSON(new Map()), JSON.stringify({ version: 1, models: {} }));
  // Restoring a state hands back a copy: a caller that mutates what it was given
  // is mutating its own record and not the one the plugin reads.
  const held = limitAdaptivity(new Map([["copy-free", { floor: 10, ceiling: 20 }]]));
  const first = limitAdaptivity();
  first.get("copy-free").floor = 999;
  assert.equal(limitAdaptivity().get("copy-free").floor, 10);
  limitAdaptivity(new Map());
  limitAdaptivity(held);
});

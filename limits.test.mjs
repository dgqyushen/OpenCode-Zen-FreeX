import assert from "node:assert/strict";
import test from "node:test";

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

// A body that hands over its first chunk and then never answers again: the shape
// of an upstream that dies mid-body, or of headers promising more bytes than the
// response delivers (measured: a 403 with `content-length: 999` over a 120-byte
// body). Nothing about this shape ends the read on its own — only the wait does.
function stallsAfter(text) {
  const bytes = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) return new Promise(() => {});
      sent = true;
      controller.enqueue(bytes.encode(text));
    },
  });
}

function stalled(text) {
  return new Response(stallsAfter(text), { status: 403, headers: { "content-length": "999" } });
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
  // observing has to be non-destructive in what it does with what it read: the
  // bytes come back with the answer, and the body is read exactly once — there
  // is no copy to hand out, and asking for one is what used to hang the request
  const response = new Response(REFUSAL, {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  const observed = await within(
    1000,
    observeRouteStatement("deepseek-v4.1-flash-free", response),
    "a one-chunk refusal",
  );
  assert.deepEqual(observed, { context: 1048576, output: undefined, text: REFUSAL });
  assert.equal(response.bodyUsed, true, "the one read of the body is the reader's");
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
    text: CEILING,
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
    { context: undefined, output: 262144, text: CEILING_WORDING },
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
      const read = await within(
        1000,
        observeRouteStatement(
          "longcat-2.5-preview-free",
          refusal(CEILING_WORDING, { size, status: 400 }),
          limit,
        ),
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
      assert.equal(read.text, CEILING_WORDING.slice(0, limit + 1), `the bytes read (limit ${limit}, ${shape})`);
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
  // and the declaration is still the one the table measured, not the half number
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
    const read = await within(
      1000,
      observeRouteStatement(id, refusal(CEILING_WORDING, { size: 1, status: 400 }), limit),
      `the read cut at ${limit}`,
    );
    assert.equal(read.output, undefined, `limit ${limit} stops inside the ceiling the body names`);
  }
  assert.deepEqual(limitOverrides(id, { context: 1000000, output: 131072 }), {});
  // the same body in five-character reads, with room for all of it: the ceiling
  // is read as stated, so the guard is about the cut and not about the shape
  const whole = await within(
    1000,
    observeRouteStatement(id, refusal(CEILING_WORDING, { size: 5, status: 400 })),
    "the chunked refusal read whole",
  );
  assert.deepEqual(whole, { context: undefined, output: 262144, text: CEILING_WORDING });
  assert.deepEqual(limitOverrides(id, { context: 1000000, output: 131072 }), { output: 262144 });
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
  // a refusal that names nothing is read all the same — the caller has to be
  // able to hand the body on — and it says so by naming no axis
  const namesNothing = '{"error":{"message":"Upstream failed"}}';
  assert.deepEqual(await observeRouteStatement("x-free", new Response(namesNothing, { status: 400 })), {
    context: undefined,
    output: undefined,
    text: namesNothing,
  });
  // a 4xx that says what it wants only past the read budget names nothing, and
  // what was read comes back: the budget and the one character past it that
  // says the body went on
  assert.deepEqual(
    await observeRouteStatement("x-free", new Response(" ".repeat(5000) + REFUSAL, { status: 400 })),
    { context: undefined, output: undefined, text: " ".repeat(4097) },
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
      limitOverrides("deepseek-v4.1-flash-free", { context: 200000, output: 32000 }, undefined, fresh(), fresh()),
      { context: 1048576, output: 384000 },
    );
    assert.deepEqual(notes, [], "an entry that applies has nothing to explain");
    // the catalogue moved: the window was measured against a question nobody is
    // asking any more, while the output axis still stands
    assert.deepEqual(
      limitOverrides("deepseek-v4.1-flash-free", { context: 250000, output: 32000 }, undefined, fresh(), fresh()),
      { output: 384000 },
    );
    // the axis is not declared at all any more: the same rule, said the same way
    assert.deepEqual(
      limitOverrides("deepseek-v4.1-flash-free", { output: 32000 }, undefined, fresh(), fresh()),
      { output: 384000 },
    );
    // no entry is no evidence, which is a different thing and stays quiet
    assert.deepEqual(limitOverrides("never-measured-free", DECLARED, undefined, fresh(), fresh()), {});
  } finally {
    limitDiagnostics(previous);
  }
  assert.deepEqual(notes, [
    {
      kind: "catalogue-drift",
      id: "deepseek-v4.1-flash-free",
      axis: "context",
      value: 1048576,
      measuredAgainst: 200000,
      declared: 250000,
    },
    {
      kind: "catalogue-drift",
      id: "deepseek-v4.1-flash-free",
      axis: "context",
      value: 1048576,
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
  console.warn = (line) => lines.push(line);
  process.env[LIMITS_DEBUG_ENV] = "1";
  try {
    limitOverrides("deepseek-v4.1-flash-free", { context: 250000, output: 32000 }, undefined, new Map(), new Map());
  } finally {
    delete process.env[LIMITS_DEBUG_ENV];
    console.warn = warn;
  }
  assert.equal(lines.length, 1, "one line for the one axis the catalogue voided");
  assert.match(
    lines[0],
    /deepseek-v4\.1-flash-free context=1048576 was measured against a catalogue that declared 200000, and this one declares 250000: not applied/,
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
  const read = await within(4500, readBoundedText(stalled(REFUSAL), 4096), "the read of a stalled body");
  assert.equal(read.text, REFUSAL, "the bytes that did arrive are the evidence");
  assert.equal(read.ended, false, "the body did not end; the wait did");
  assert.equal(read.over, true, "so a number at the end of it may be half of one");
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
    assert.ok(Date.now() - started < 1500, "a caller who gave up is not waited on for the deadline");
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

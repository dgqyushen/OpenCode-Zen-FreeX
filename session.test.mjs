import assert from "node:assert/strict";
import test from "node:test";
import { opencodeID, realSessionID, sessionID } from "./provider.mjs";

// The layout provider.mjs encodes, from OpenCode's identifier.ts: a
// 3-character prefix and "_", 12 hex of Date.now() * 0x1000 + counter, then
// 14 random base62 characters. ID_SHAPE is that layout as one regex; SHAPE is
// the same thing pinned to the session prefix, so the two cannot drift.
const PREFIX = "ses";
const PREFIX_CHARS = PREFIX.length + 1;
const FIELD_HEX = 12;
const TAIL_CHARS = 14;
const ID_SHAPE = new RegExp(`^[a-z]{3}_[0-9a-f]{${FIELD_HEX}}[0-9A-Za-z]{${TAIL_CHARS}}$`);
const SHAPE = new RegExp(`^${PREFIX}_[0-9a-f]{${FIELD_HEX}}[0-9A-Za-z]{${TAIL_CHARS}}$`);
const FIELD_MASK = 0xffffffffffffn; // the 48 bits that hex field carries
const COUNTER_MOD = 0x1000n; // its low 12 bits are the counter
// realSessionID calls a counter below this one of OpenCode's.
const COUNTER_LIMIT = 16;
const WRAP = 2 ** 36; // the 36 bits of Date.now() the field keeps

// Decode an id the way OpenCode's identifier.ts lays it out. One of another
// shape is an assertion here, rather than a raw SyntaxError out of BigInt.
function decode(id, descending) {
  assert.match(id, ID_SHAPE);
  let value = BigInt(`0x${id.slice(PREFIX_CHARS, PREFIX_CHARS + FIELD_HEX)}`);
  if (descending) value = ~value & FIELD_MASK;
  return { time: Number(value / COUNTER_MOD), counter: Number(value % COUNTER_MOD) };
}

test("a made-up session id is OpenCode's: descending, the time it was made, a small counter", () => {
  const before = Date.now();
  const id = sessionID(new Headers({ "x-session-id": "conversation-a" }), {});
  const after = Date.now();
  assert.match(id, SHAPE);
  assert.ok(realSessionID(id), id);
  const { time, counter } = decode(id, true);
  // The time field wraps every 2^36 ms, so what a range check can hold is
  // the elapsed offset, not two already-wrapped values.
  const elapsed = ((time - before) % WRAP + WRAP) % WRAP;
  assert.ok(elapsed <= after - before, `${time} not in ${before}..${after}`);
  // Whatever the counter was, it has to be one realSessionID reads as a
  // counter rather than as part of the time: the id is the shape Zen checks.
  assert.ok(counter > 0 && counter < COUNTER_LIMIT, `counter ${counter}`);
});

test("one conversation keeps one session, another gets its own", () => {
  const a1 = sessionID(new Headers({ "x-session-id": "conversation-b" }), {});
  const a2 = sessionID(new Headers({ "x-session-id": "conversation-b" }), {});
  const b = sessionID(new Headers({ "x-session-id": "conversation-c" }), {});
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  // A conversation with no header of its own is keyed by its first user
  // message, so the same question keeps one session...
  const body = { messages: [{ role: "user", content: "first question" }] };
  assert.equal(sessionID(new Headers(), body), sessionID(new Headers(), body));
  // ...and a different one gets its own, rather than every headerless request
  // sharing whichever conversation arrived first.
  const other = { messages: [{ role: "user", content: "second question" }] };
  assert.notEqual(sessionID(new Headers(), body), sessionID(new Headers(), other));
  // A signal the host does send is read wherever it is: a conversation id in
  // the body's metadata is a signal, not prose to be hashed.
  const signaled = sessionID(new Headers(), { metadata: { session_id: "conversation-d" } });
  assert.equal(signaled, sessionID(new Headers({ "conversation-id": "conversation-d" }), {}));
});

test("a request with no signal and no user message gets one id, not a new one a turn", () => {
  // Nothing to key a conversation by: the id cannot be kept for a next turn,
  // but it must still be the shape Zen checks rather than a bare made-up value.
  const first = sessionID(new Headers(), {});
  const second = sessionID(new Headers(), {});
  assert.ok(realSessionID(first), first);
  assert.ok(realSessionID(second), second);
});

test("OpenCode's own session id is passed through, a hash cut to its shape is not", () => {
  const real = "ses_ecc5d8f28ffe9Cy14V8Em7lI2u";
  assert.equal(sessionID(new Headers({ "x-opencode-session": real }), {}), real);
  // 0.1.4 sent this for "x-session-id: session_123"; Zen answers it 403.
  const hashed = "ses_e9283da055b15JwOAra76bwUx4";
  assert.equal(realSessionID(hashed), false);
  const sent = sessionID(new Headers({ "x-opencode-session": hashed }), {});
  assert.notEqual(sent, hashed);
  assert.ok(realSessionID(sent), sent);
});

test("ids made in one millisecond count up, as OpenCode's do", () => {
  const now = 1_790_000_000_000;
  const first = opencodeID("msg", false, now);
  const second = opencodeID("msg", false, now);
  // Asserting the increment rather than the absolute numbers keeps this free of
  // the module's own counter state, which another test in this process shares.
  assert.equal(decode(second, false).counter, decode(first, false).counter + 1);
  assert.equal(decode(second, false).time, decode(first, false).time);
});

test("a burst that fills the counter field still makes OpenCode's ids", () => {
  const now = 1_790_000_000_001;
  const ids = Array.from({ length: 40 }, () => opencodeID("ses", true, now));
  const counters = ids.map((id) => decode(id, true).counter);
  // Past the field's worth of ids in one millisecond the counter has to stay
  // inside it: a counter that carried into bit 12 would move the time the id
  // claims, and an id whose low bits read as time is one realSessionID rejects.
  for (const [at, counter] of counters.entries()) {
    assert.ok(counter > 0 && counter < COUNTER_MOD, `id ${at} has counter ${counter}`);
    assert.ok(realSessionID(ids[at]), `id ${at} is not one OpenCode could have made`);
  }
  // Counting still happens: consecutive ids inside one millisecond differ.
  assert.notEqual(counters[0], counters[1]);
});

test("a session id is never minted from a signal that is not a string", () => {
  // A body is the host's to fill in, so `metadata.session_id` is not
  // guaranteed to be text; a number there is not a session the tier could have
  // seen, and hashing it would throw out of the request path.
  const id = sessionID(new Headers(), { metadata: { session_id: 42 } });
  assert.ok(realSessionID(id), id);
});

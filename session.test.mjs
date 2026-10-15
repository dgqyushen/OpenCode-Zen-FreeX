import assert from "node:assert/strict";
import test from "node:test";
import { opencodeID, realSessionID, sessionID } from "./provider.mjs";

const SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
// The layout provider.mjs encodes, from OpenCode's identifier.ts: a
// 3-character prefix and "_", 12 hex of Date.now() * 0x1000 + counter, then
// 14 random base62 characters.
const ID_SHAPE = /^[a-z]{3}_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const PREFIX_CHARS = 4;
const FIELD_HEX = 12;
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
  // This id is the first one made in its millisecond, which is what keeps
  // its counter as small as realSessionID requires of a made-up one (#100).
  assert.ok(counter >= 1 && counter < COUNTER_LIMIT, `counter ${counter}`);
});

test("one conversation keeps one session, another gets its own", () => {
  const a1 = sessionID(new Headers({ "x-session-id": "conversation-b" }), {});
  const a2 = sessionID(new Headers({ "x-session-id": "conversation-b" }), {});
  const b = sessionID(new Headers({ "x-session-id": "conversation-c" }), {});
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  const body = { messages: [{ role: "user", content: "first question" }] };
  assert.equal(sessionID(new Headers(), body), sessionID(new Headers(), body));
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
  assert.equal(decode(first, false).counter, 1);
  assert.equal(decode(second, false).counter, 2);
  assert.ok(second > first);
});

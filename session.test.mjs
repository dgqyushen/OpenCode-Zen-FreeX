import assert from "node:assert/strict";
import test from "node:test";
import { opencodeID, realSessionID, sessionID } from "./provider.mjs";

// The layout provider.mjs encodes, from OpenCode's identifier.ts: a
// 3-character prefix and "_", 12 hex of Date.now() * 0x1000 + counter, then
// 14 random base62 characters. The tail of that layout is written once, in
// LAYOUT; ID_SHAPE is the layout with the prefix left as a class as wide as the
// prefix this module mints, and SHAPE is the same layout with that prefix
// spelled out, so the field widths and the class after them cannot drift
// between the two readings.
const PREFIX = "ses";
const PREFIX_CHARS = PREFIX.length + 1;
const FIELD_HEX = 12;
const TAIL_CHARS = 14;
const LAYOUT = `_[0-9a-f]{${FIELD_HEX}}[0-9A-Za-z]{${TAIL_CHARS}}$`;
const ID_SHAPE = new RegExp(`^[a-z]{${PREFIX.length}}${LAYOUT}`);
const SHAPE = new RegExp(`^${PREFIX}${LAYOUT}`);
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

test("a request with no signal and no user message gets an id of its own, not a shared one", () => {
  // Nothing to key a conversation by: the id cannot be kept for a next turn, so
  // it is minted fresh — and it must still be the shape Zen checks rather than a
  // bare made-up value. Two of them differ, which is the half a name like "one
  // id, not a new one a turn" got wrong: a single constant here would fold every
  // such request into whichever conversation happened to arrive first.
  const first = sessionID(new Headers(), {});
  const second = sessionID(new Headers(), {});
  assert.ok(realSessionID(first), first);
  assert.ok(realSessionID(second), second);
  assert.notEqual(first, second, "nothing names this conversation, so nothing may be shared");
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
  // Forty ids is past the sixteen the counter's own range holds, so the burst
  // wraps it, and what this holds is that every id of the wrap stays inside that
  // range. COUNTER_LIMIT is the range: realSessionID reads a counter at or above
  // it as one OpenCode could not have made, and opencodeID's own wrap keeps the
  // counter below it. COUNTER_MOD is the width of the whole hex field instead,
  // and a counter read back below it is true by construction — a burst that
  // broke the wrap would carry into the time the id claims and still pass that
  // boundary, which is why this one is asserted here.
  for (const [at, counter] of counters.entries()) {
    assert.ok(counter > 0 && counter < COUNTER_LIMIT, `id ${at} has counter ${counter}`);
    assert.ok(realSessionID(ids[at]), `id ${at} is not one OpenCode could have made`);
  }
  // Counting still happens: consecutive ids inside one millisecond differ.
  assert.notEqual(counters[0], counters[1]);
});

// A signal the host sends outranks an empty opening. `""` is falsy, so a
// conversation whose first user message is empty used to be read as one with no
// opening at all and was minted an id of its own — per call, not per
// conversation — even though the host had named it. What the host said is the
// one thing here that identifies a conversation, and an empty message is not a
// reason to discard it.
//
// The two headed cases below are what says so: the same name answers one id,
// two names answer two, and both are OpenCode-shaped rather than the name
// passed through (a name that is not one of OpenCode's own is hashed, the way
// any other signal is).
test("a host signal still names a conversation whose first user message is empty", () => {
  const empty = { messages: [{ role: "user", content: "" }] };
  const first = sessionID(new Headers({ "x-opencode-session": "conversation-g" }), empty);
  const second = sessionID(new Headers({ "x-opencode-session": "conversation-g" }), empty);
  assert.equal(first, second, "one name, one conversation");
  assert.ok(realSessionID(first), first);
  const other = sessionID(new Headers({ "x-opencode-session": "conversation-h" }), empty);
  assert.notEqual(first, other, "two names, two conversations");
  assert.notEqual(first, "conversation-g", "a name that is not OpenCode's is hashed, not passed on");
  // The body's metadata is the same kind of signal and outranks it the same way.
  const byMetadata = sessionID(new Headers(), { ...empty, metadata: { session_id: "conversation-g" } });
  assert.equal(byMetadata, first, "where the name came from does not change what it names");
});

// An empty opening with NO signal is the one shape that cannot be keyed: two
// conversations that opened empty are indistinguishable from one, so any key
// derived here would either be shared by unrelated conversations — one Zen
// session, with its affinity and its quota — or differ again on the next turn.
// Not sharing is the half worth keeping, and it is what this does: the id is
// minted per call. This is a known limit and not an accident, so it is pinned:
// a change that started sharing these would be a regression here.
test("an empty opening with no signal is never shared between conversations", () => {
  const empty = { messages: [{ role: "user", content: "" }] };
  const first = sessionID(new Headers(), empty);
  const second = sessionID(new Headers(), empty);
  assert.ok(realSessionID(first), first);
  assert.ok(realSessionID(second), second);
  assert.notEqual(first, second, "nothing named this conversation, so nothing may be shared");
  // An opening with words is still a key, so this is the shape that gave
  // something up rather than the contract itself — the key is the first *user*
  // message wherever it sits in the history.
  const spoken = { messages: [{ role: "user", content: "hi" }, { role: "user", content: "" }] };
  assert.equal(sessionID(new Headers(), spoken), sessionID(new Headers(), spoken));
});

// The reachable limit of keying a conversation by its opening: two hosts that
// send no session signal at all and open with the very same words are one key,
// and one Zen session. There is nothing in the request that distinguishes them
// — that is what the signal is for — so this is pinned rather than papered
// over, and it is the reason the signal above is read first: a host that does
// name its conversations gets separate sessions for them.
test("conversations with the same opening and no signal are one key", () => {
  const opening = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(
    sessionID(new Headers(), opening),
    sessionID(new Headers(), opening),
    "nothing distinguishes these two, so they key the same — the contract this plugin has",
  );
});

test("a session id is never minted from a signal that is not a string", () => {
  // A body is the host's to fill in, so `metadata.session_id` is not guaranteed
  // to be text; a number there is not a session the tier could have seen. The
  // guard is not about throwing — the hash is a template literal, so it would
  // coerce the number rather than fail — it is about not keying by it: with the
  // guard gone, both calls below would answer one session, hashed from "42".
  const first = sessionID(new Headers(), { metadata: { session_id: 42 } });
  const second = sessionID(new Headers(), { metadata: { session_id: 42 } });
  assert.ok(realSessionID(first), first);
  // and it is not the text "42" either: the number is ignored rather than
  // coerced, so what the string keys must not be what the number answered.
  const text = sessionID(new Headers(), { metadata: { session_id: "42" } });
  assert.notEqual(first, text, "42 is not \"42\"");
  assert.notEqual(first, second, "a number is not a session to key a conversation by");
});

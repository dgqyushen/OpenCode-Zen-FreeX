import { MAX_BYTES, STALE_BODY_HEADERS } from "./stream.mjs";

// The limit as a failure's message names it, from the one place it is set:
// stream.mjs owns the number, and this guard reads the same bytes through it.
const LIMIT = `${MAX_BYTES / (1024 * 1024)} MiB`;
const encoder = new TextEncoder();

class GuardError extends Error {
  constructor(message, code = "upstream_error") {
    super(message);
    this.code = code;
  }
}

function headersFor(response) {
  const headers = new Headers(response.headers);
  for (const name of STALE_BODY_HEADERS) headers.delete(name);
  return headers;
}

// failure answers the error a client reads. `code` says what went wrong
// where the shape has room for it: only a call the guard cannot name at all
// is an undeclared one, and a limit, a truncation or a malformed upstream is
// not.
function failure(protocol, message, stream = false, code = "upstream_error") {
  if (protocol === "anthropic") return { type: "error", error: { type: "api_error", message } };
  if (protocol === "responses") {
    return stream
      ? { type: "error", code, message }
      : { error: { type: "upstream_error", code, message } };
  }
  return { error: { message, type: "upstream_error" } };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new GuardError("Invalid upstream tool snapshot");
  return value;
}

// OpenCode's own models call OpenCode's tool names (bash, todowrite,
// webfetch) whatever the agent declared. A call is given the agent's tool
// whose name differs only in case, or else only in case and separators
// (todowrite → todo_write, webfetch → web_fetch), when exactly one does; a
// name two of the agent's tools fold to is never guessed between.
const separators = /[\s_.-]/g;
function foldsTo(declared, key) {
  const folded = new Map();
  for (const name of declared) {
    const k = key(name);
    // A name of separators only folds to nothing, and would be handed any
    // other such call ("_" for "--"): it matches only itself.
    if (!k) continue;
    folded.set(k, folded.has(k) ? null : name);
  }
  return folded;
}

// The names the policy says the agent declared. A field that is missing or
// renamed used to read as an empty set — `new Set(undefined)` does not throw —
// so every call of every reply became "a tool this agent doesn't have", with
// nothing thrown and nothing logged to say why. A policy this guard cannot
// read is a caller's mistake and is refused by name instead: the Set this
// package's own producer builds (provider.mjs's normalizeTools), or an array
// of names. It is a TypeError, not a GuardError: the reply is not what is
// wrong, the caller is.
function declaredNames(policy) {
  const held = policy?.declared;
  const names = held instanceof Set ? [...held] : held;
  // A field that is not one of the two shapes gets here as itself: `names` is
  // the field's own value unless it was a Set, so an array never reaches this
  // message (the old `Array.isArray(held) ? "an array of those"` arm could not
  // be read at all).
  if (!Array.isArray(names))
    throw new TypeError(
      `policy.declared must be a Set or an array of tool names, not ${
        held === null ? "null" : typeof held
      }`,
    );
  for (const name of names) {
    if (typeof name !== "string")
      throw new TypeError(`policy.declared must hold tool names, and holds ${typeof name}`);
  }
  return new Set(names);
}

// nameGuard answers the agent's name for a call: the agent's spelling when one
// folds to it, else the name as the model wrote it. A call of a tool the agent
// has no spelling of (bedit, psh, mcp__netcatcatty__unused) reaches the agent
// as called, as it does on every other provider: the agent answers it with its
// own unknown-tool error, and the model corrects the name and goes on (#209).
// Leaving it out ended an agent's turn as a plain answer, which an autonomous
// host reads as "the task is done" (#76 fixed the failure that came before
// this one; that reply is not handed a turn's end any more, it is handed a
// call). Only a call with no name answers null, and is left out.
function nameGuard(policy) {
  const declared = declaredNames(policy);
  const lower = (name) => name.toLowerCase();
  const bare = (name) => name.toLowerCase().replace(separators, "");
  const byCase = foldsTo(declared, lower);
  const byShape = foldsTo(declared, bare);
  return (name) => {
    if (typeof name !== "string" || !name) return null;
    if (declared.has(name)) return name;
    const match =
      byCase.get(lower(name)) ?? (byCase.has(lower(name)) ? null : byShape.get(bare(name)));
    return match || name;
  };
}

// A call with no name can't be run, named onto one the agent has, or answered
// by any agent: nothing keys a result by it and its own id names nothing. It
// is left out instead of failing the reply — failing threw away the whole turn
// (#76) — and the reply says so in its text, where the agent's user and the
// model's next turn both read it. A reply left with no call ends as a plain
// stop. Every named call, whatever the name, is handed on as called.
export function droppedNote(name) {
  return typeof name === "string" && name
    ? `(The model called a tool this agent doesn't have: ${JSON.stringify(name.slice(0, 128))}. The call was left out.)`
    : "(The model called a tool without a name. The call was left out.)";
}

function appendNotes(message, notes) {
  const text = notes.join("\n\n");
  if (typeof message.content === "string" && message.content) {
    message.content = `${message.content}\n\n${text}`;
  } else if (Array.isArray(message.content)) {
    message.content.push({ type: "text", text });
  } else {
    message.content = text;
  }
}

// checkChatMessage renames message's calls to the agent's tools and leaves
// out the rest, answering the notes for those left out.
function checkChatMessage(message, checkName) {
  const result = { changed: false, notes: [] };
  if (!object(message)) return result;
  if (message.function_call != null) {
    const value = message.function_call;
    if (!object(value)) throw new GuardError("Invalid upstream function call");
    const name = checkName(value.name);
    if (name == null) {
      result.notes.push(droppedNote(value.name));
      delete message.function_call;
      result.changed = true;
    } else if (name !== value.name) {
      value.name = name;
      result.changed = true;
    }
  }
  if (message.tool_calls != null) {
    const calls = list(message.tool_calls);
    const kept = [];
    for (const call of calls) {
      if (!object(call) || (call.type != null && call.type !== "function")) {
        throw new GuardError("Unsupported upstream tool call");
      }
      if (!object(call.function)) throw new GuardError("Invalid upstream function call");
      const name = checkName(call.function.name);
      if (name == null) {
        result.notes.push(droppedNote(call.function.name));
        result.changed = true;
        continue;
      }
      if (name !== call.function.name) {
        call.function.name = name;
        result.changed = true;
      }
      kept.push(call);
    }
    if (kept.length !== calls.length) {
      if (kept.length) message.tool_calls = kept;
      else delete message.tool_calls;
    }
  }
  return result;
}

const callFinish = new Set(["tool_calls", "function_call"]);
function hasCalls(message) {
  return message.function_call != null || (message.tool_calls?.length ?? 0) > 0;
}

function isCall(protocol, value) {
  return (
    (protocol === "responses" && value.type === "function_call") ||
    (protocol === "anthropic" && ["tool_use", "server_tool_use"].includes(value.type))
  );
}

// What a call is named by, when it is named at all: a non-empty string. ""
// names nothing a client can key by — the empty id this route was measured
// putting on a call — and neither does a number or a boolean. Every place
// that asks whether a call has an identity asks it here, or two calls of one
// reply share one item (measured: two `"call_id": ""` calls each became the
// item `msg_`, and their arguments frames could not be matched to either).
function identity(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Counts the ids invented for calls the reply gives nothing to place: a
// counter cannot be stable, but it is the only thing that keeps two of them
// apart (see inPlaceOf).
let synthesized = 0;

// What a call left out of a Responses or Messages reply becomes: text
// saying so, in the call's place, so no later index moves. `at` is where the
// call sits in the reply as far as the caller can tell — a frame's
// output_index, or the index the walk found it at. `placed` is the id a
// caller that follows the whole stream has already answered for this call
// (see snapshotStream): without it every rewrite of that call invented a new
// id.
function inPlaceOf(protocol, call, note, at, placed) {
  if (protocol === "anthropic") return { type: "text", text: note };
  // An item id is what a Responses client keys the item by, and what the
  // streaming path suppresses arguments by. One call is replaced more than
  // once — its output_item.added, its output_item.done, and the copy inside
  // the terminal response's output — so the invented id has to be the same
  // every time: a counter made one call into several items to the client, and
  // left leftIDs unable to match its arguments frames. A call's place is the
  // same in all three, and two calls cannot share one, so the id names it —
  // and a call the reply places nowhere takes the id its own stream settled
  // on for it.
  //
  // The id a stream already answered comes first, before the place the caller
  // knows. The id the call *itself* carries comes last, and only behind the
  // `msg_` the invented kind is named under: a word is not the guard's to hand
  // out twice. A reply can name two items by one word (this route was measured
  // settling on an id only after the frame that opened the call, and nothing
  // stops the same id naming a call the reply keeps), and the note taking that
  // id verbatim would key two items — the note and the item the reply kept —
  // by one word, which is the failure this arm exists to prevent, read back at
  // the other end. Behind the prefix the word cannot collide with an item of
  // the reply, and a call_id the reply used is still named in the id it
  // answers, as it was.
  const id =
    placed ??
    `msg_${identity(call.call_id) ?? (at === undefined ? `anon_${++synthesized}` : `dropped_${at}`)}`;
  return {
    type: "message",
    id,
    role: "assistant",
    status: call.status ?? "completed",
    content: [{ type: "output_text", text: note, annotations: [] }],
  };
}

// A tool call needs an id its host can key the result by, and this route has
// been measured leaving calls without one: 2026-10-17, through this plugin, a
// reply's flushed frame carried `{"index":0,"id":null,"name":"bash"}` — the
// route puts `"id": null` on a continuation frame of a call it named on the
// first one, and a reply can also leave the call unnamed to the end. OpenAI's
// shape requires the field, and a host it reaches has nothing to match its
// result against without it: dsh keys its tool/result records by this id and
// fails the whole turn — and then the whole session, on reload — when the id
// is empty ("toolCallId matching its tool source"). So a call that reaches
// the wire leaves with an id: the last-resort kind, process-unique under the
// same counter the invented item ids use, so two invented calls cannot share
// one.
//
// An invented id is only process-unique, and the counter is shared with every
// earlier reply, so it can reach a word the same reply already placed: an
// upstream that names its calls call_1, call_2, … names the very ids the
// counter mints, and a call left unnamed beside those used to be handed one of
// them — two calls of one reply under one id, which is the same failure the
// counter exists to prevent, one step further out. The ids the calls being
// flushed already carry are read first, and an invented id misses all of them.
function ensureCallIDs(calls) {
  const held = new Set();
  for (const call of calls) {
    const id = identity(call.id);
    if (id !== undefined) held.add(id);
  }
  for (const call of calls) {
    if (identity(call.id) !== undefined) continue;
    let id;
    do id = `call_${++synthesized}`;
    while (held.has(id));
    held.add(id);
    call.id = id;
  }
}

// checkSnapshots checks every call in a reply or event: renamed to the
// agent's tool, or (Responses, Messages) put in place of by a note. It
// answers whether data changed, how many calls it kept and how many it
// left out. `placeOf` is the stream's own answer for a call whose frames
// carry no output_index and no item id — a token already invented for it, so
// all of its rewrites answer one item id (snapshotStream); a caller reading a
// whole reply has no such state and leaves it out.
function checkSnapshots(data, protocol, checkName, placeOf) {
  let changed = false;
  if (protocol === "chat") {
    for (const choice of list(data.choices)) {
      if (!object(choice)) throw new GuardError("Invalid upstream choice");
      const message = choice.message;
      const checked = checkChatMessage(message, checkName);
      changed = checked.changed || changed;
      if (checked.notes.length) {
        appendNotes(message, checked.notes);
        if (!hasCalls(message) && callFinish.has(choice.finish_reason))
          choice.finish_reason = "stop";
      }
    }
    return { changed, kept: 0, left: 0 };
  }
  let kept = 0;
  let left = 0;
  if (!object(data)) throw new GuardError("Invalid upstream tool snapshot");
  // Each entry is a value, where it sits, the place it holds in the reply as
  // far as the walk knows, and whether the walk reached it as an item of a
  // list (an item of an output array, as opposed to a frame's own `item`,
  // which keeps the output_index the frame carries). A call left out is
  // replaced by an item whose invented id names that place, so the added,
  // done and terminal copies of one call are one item (inPlaceOf).
  const stack = [[data, null, null, object(data) ? data.output_index : undefined, false]];
  while (stack.length) {
    const [value, holder, key, at, listed] = stack.pop();
    if (!object(value)) throw new GuardError("Invalid upstream tool snapshot");
    if (
      protocol === "responses" &&
      typeof value.type === "string" &&
      value.type.endsWith("_call") &&
      value.type !== "function_call"
    ) {
      throw new GuardError("Unsupported upstream tool call type");
    }
    if (isCall(protocol, value)) {
      const name = checkName(value.name);
      if (name == null) {
        if (!holder) throw new GuardError(droppedNote(value.name), "undeclared_tool");
        holder[key] = inPlaceOf(
          protocol,
          value,
          droppedNote(value.name),
          at,
          placeOf?.(value, at, listed),
        );
        changed = true;
        left++;
        continue;
      }
      if (name !== value.name) {
        value.name = name;
        changed = true;
      }
      kept++;
    }
    const arrays = protocol === "responses" ? ["output", "content"] : ["content"];
    const objects =
      protocol === "responses" ? ["response", "item", "part"] : ["message", "content_block"];
    for (const name of arrays) {
      // Text content is not a snapshot container.
      if (typeof value[name] === "string") continue;
      const items = list(value[name]);
      for (let i = 0; i < items.length; i++) stack.push([items[i], items, i, i, true]);
    }
    for (const name of objects) {
      if (value[name] != null) stack.push([value[name], value, name, at, false]);
    }
  }
  if (
    protocol === "anthropic" &&
    left &&
    !kept &&
    data.type === "message" &&
    data.stop_reason === "tool_use"
  ) {
    data.stop_reason = "end_turn";
  }
  return { changed, kept, left };
}

// The slot a fragmented call or a choice sits in. A frame that names no index
// is read as the first one, which is what the collapse path reads it as too
// (stream.mjs's `index`): a fragment carries no other place it could hold, and
// the two paths over one stream must answer one reply (pinned by the chat test
// "a fragment that names no index is read the same by both paths").
function position(value) {
  const result = value ?? 0;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new GuardError("Invalid upstream tool index");
  return result;
}

function appendFunction(target, fragment) {
  if (!object(fragment)) throw new GuardError("Invalid upstream function delta");
  for (const [key, value] of Object.entries(fragment)) {
    if (key === "name" || key === "arguments") {
      if (typeof value !== "string") throw new GuardError("Invalid upstream function delta");
      target[key] = (target[key] ?? "") + value;
    } else {
      Object.defineProperty(target, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
}

function chatBuffer(checkName) {
  const pending = new Map();
  let bytes = 0;
  function charge(state, value) {
    const size = encoder.encode(JSON.stringify(value)).byteLength;
    bytes += size;
    state.bytes += size;
    if (bytes > MAX_BYTES)
      throw new GuardError(`Pending upstream tools exceed the ${LIMIT} buffer limit`);
  }
  function stateFor(index, data) {
    if (!pending.has(index)) {
      const metadata = {};
      for (const key of [
        "id",
        "object",
        "created",
        "model",
        "system_fingerprint",
        "service_tier",
      ]) {
        if (data[key] !== undefined) metadata[key] = data[key];
      }
      const state = { calls: new Map(), legacy: null, metadata, bytes: 0 };
      pending.set(index, state);
      charge(state, metadata);
    }
    return pending.get(index);
  }
  // Choices that streamed text, and those whose every call was left out
  // (whose later "tool_calls" finish is a stop). The second is per round: a
  // later round that buffers a call for the same choice is judged on what it
  // holds, not on the round before it, so the mark is dropped as soon as that
  // call arrives.
  const wrote = new Set();
  const ended = new Set();
  function complete(state, index) {
    const delta = {};
    if (state.calls.size) {
      delta.tool_calls = [...state.calls].sort(([a], [b]) => a - b).map(([, value]) => value);
    }
    if (state.legacy) delta.function_call = state.legacy;
    const { notes } = checkChatMessage(delta, checkName);
    if (Array.isArray(delta.tool_calls)) ensureCallIDs(delta.tool_calls);
    if (notes.length) {
      delta.tool_calls?.forEach((call, i) => {
        call.index = i;
      });
      delta.content = (wrote.has(index) ? "\n\n" : "") + notes.join("\n\n");
      if (!hasCalls(delta)) ended.add(index);
    }
    return delta;
  }
  // What a choice the buffer flushes at [DONE] ended as: tool use when the
  // delta it publishes carries calls, the legacy field when it carries that,
  // and a plain stop otherwise.
  function ending(delta) {
    if (delta.tool_calls?.length) return "tool_calls";
    if (delta.function_call) return "function_call";
    return "stop";
  }
  function remove(index) {
    const state = pending.get(index);
    if (state) bytes -= state.bytes;
    pending.delete(index);
  }
  return {
    get size() {
      return pending.size;
    },
    clear() {
      pending.clear();
      // Everything this buffer holds, not only the bytes: a cleared buffer
      // has no round to judge.
      wrote.clear();
      ended.clear();
      bytes = 0;
    },
    apply(data) {
      let { changed } = checkSnapshots(data, "chat", checkName);
      const choices = list(data.choices);
      for (const choice of choices) {
        const delta = choice.delta;
        if (!object(delta)) continue;
        if (typeof delta.content === "string" && delta.content) wrote.add(position(choice.index));
        // A `tool_calls` that is there but empty is a call of nothing: a
        // gateway re-emitting the shape with a role-only delta sends one, and
        // no call is being waited for. Reading it as a call opened a round
        // with nothing in it — the choice's `ended` mark was dropped with it,
        // a choice the upstream never sent was flushed at [DONE], and a stream
        // that then closed without the marker failed the whole turn "a tool
        // call unfinished" while nothing was pending. It is left where it is,
        // as a field the guard has nothing to say about.
        const fragments = list(delta.tool_calls);
        if (delta.function_call == null && !fragments.length) continue;
        changed = true;
        // A call buffered now opens a round of its own for this choice: a
        // choice that finished as a plain stop because every call of an
        // earlier round was left out is judged again on what this one holds.
        const at = position(choice.index);
        ended.delete(at);
        const state = stateFor(at, data);
        for (const fragment of fragments) {
          if (!object(fragment) || (fragment.type != null && fragment.type !== "function")) {
            throw new GuardError("Unsupported upstream tool delta");
          }
          charge(state, fragment);
          const index = position(fragment.index);
          const previous = state.calls.get(index) ?? { index, function: {} };
          const value = { ...previous, ...fragment, index, function: previous.function };
          // A continuation frame may carry `"id": null` — measured on this
          // route — and a spread would let it clobber the id that named the
          // call. A fragment that says nothing about the id leaves the one
          // already there; one that carries a real id still wins, as it did.
          if (
            (typeof value.id !== "string" || value.id === "") &&
            typeof previous.id === "string" &&
            previous.id !== ""
          )
            value.id = previous.id;
          if (fragment.function != null) appendFunction(value.function, fragment.function);
          state.calls.set(index, value);
        }
        if (delta.function_call != null) {
          charge(state, delta.function_call);
          state.legacy ??= {};
          appendFunction(state.legacy, delta.function_call);
        }
        delete delta.tool_calls;
        delete delta.function_call;
      }
      // Validate every finishing choice before publishing any part of this event.
      for (const choice of choices) {
        if (choice.finish_reason == null) continue;
        const index = position(choice.index);
        const state = pending.get(index);
        if (!state) continue;
        const own = object(choice.delta) ? choice.delta : {};
        const delta = complete(state, index);
        if (typeof own.content === "string" && delta.content)
          delta.content = own.content + delta.content;
        choice.delta = { ...own, ...delta };
        remove(index);
        changed = true;
      }
      for (const choice of choices) {
        if (callFinish.has(choice.finish_reason) && ended.has(position(choice.index))) {
          choice.finish_reason = "stop";
          changed = true;
        }
      }
      if (!changed) return { data, changed: false };
      data.choices = choices.filter(
        (choice) =>
          choice.finish_reason != null ||
          Object.keys(choice.delta ?? {}).length ||
          Object.keys(choice).some((key) => !["index", "delta", "finish_reason"].includes(key)),
      );
      return { data: data.choices.length || data.usage != null ? data : null, changed: true };
    },
    finish() {
      if (!pending.size) return null;
      const choices = [...pending].sort(([a], [b]) => a - b).map(([index, state]) => {
        const delta = complete(state, index);
        // The case this buffer exists for is an upstream that closes with
        // [DONE] before sending a finish chunk: the calls it buffered are
        // published here, and the choice has to say the turn ended in tool
        // use. A null reason reads as no ending at all, and "stop" as a plain
        // one — either way a client keyed on finish_reason never runs a call
        // it was handed.
        return { index, delta, finish_reason: ending(delta) };
      });
      const metadata = pending.values().next().value.metadata;
      pending.clear();
      bytes = 0;
      return { ...metadata, choices };
    },
  };
}

// snapshotStream checks a Responses or Messages stream event by event. A
// call left out is streamed as text in its place: its item or block starts
// as text carrying the note, and its arguments are never sent. A message
// whose every call was left out stops as a turn's end, not as tool use.
function snapshotStream(protocol, checkName) {
  // Where a call left out was replaced, by its output_index (or a Messages
  // block's index, which stores true: the id it answers is the text's, not an
  // item's). A copy of the call that lands on the same place answers the id
  // recorded there rather than the one the upstream names it by later.
  const left = new Map();
  // The places the items the reply kept hold. A place is a fact about the
  // reply, so an arguments frame that gives one belongs to whoever holds it —
  // the item kept there, or the call left out there — whatever words either
  // was named by. Reading the place first is what makes the answer the same
  // whichever order the two calls arrived in: two sets subtracted from each
  // other answered by arrival order instead (a kept call named X before a
  // dropped one named X let the dropped call's frames through, and the same
  // reply with the two swapped did not).
  const keptPlaces = new Set();
  // The words the items the reply kept were named by, for the one case a place
  // cannot answer: two items stating one index, one of them replaced by a note
  // (an upstream at odds with itself). There the frame's own word is all that
  // says whose it is, and a word a kept item was named by is that item's —
  // reading the place alone would swallow the declared call's frames with the
  // dropped call's.
  const keptWords = new Set();
  // Every word the calls this stream left out are named by: the ids the guard
  // invented for them, and the ids and call_ids the upstream named them by. A
  // frame that gives no place and arrives outside any item is read by its
  // word, and a word a call left out was named by is never forwarded —
  // reaching the client it would describe an item that was replaced by a note.
  const leftIDs = new Set();
  // The calls this stream placed nowhere — its frames carried no output_index
  // and no item id — in the order it opened them. Nothing in those frames says
  // which item is which, so the order is all the guard has: the k-th item a
  // stream opens without a place of its own is the k-th item of a reply that
  // places nothing, which is where the terminal response's copy of it sits.
  // One call is replaced three times — the frame that opens it, the frame that
  // closes it, and that copy — and all three answer the same invented id
  // (inPlaceOf), which is also what its arguments frames are matched by. An
  // entry is settled once the stream has left the call.
  const nowhere = []; // { token, name, settled }
  // What each word the reply has used for a call it left out answers: the id
  // the guard invented for that call, under every word the reply names it by.
  // One call is replaced more than once, and the client keys an item by the id
  // it was handed first — the frames of the measured route carry no id at all
  // until their arguments frames name one, so the id the upstream settled on
  // arrives after the replacement, and answering it then would make one call
  // two items (inPlaceOf).
  const minted = new Map(); // a word the call is named by → the id it answers
  // The item ids the reply has named on an item of its own, and the words of
  // the item the stream is inside. A frame that names one of the latter is that
  // item's — the reply naming the same word elsewhere says nothing about it —
  // while a frame naming one of the former belongs to that other item, which
  // is what keeps an item the guard kept from being read as the one it is
  // inside.
  const seen = new Set();
  const insideWords = new Set();
  let open = -1; // the placeless call the stream is inside, or -1
  // The item the stream is inside, as far as an arguments frame that gives no
  // place of its own is concerned: the id the call left out there answers (and
  // the name it was called), or undefined with `insideKept` for an item the
  // reply kept. `closingID`/`closingName` are the same for the frame that
  // closes an item: a copy of a call can arrive with nothing to name it by,
  // and the call being closed is what it is.
  let insideID;
  let insideName;
  let insideKept = false;
  let closingID;
  let closingName;
  let kept = 0;
  let dropped = 0;
  // What a frame says the reply's items are called. A frame that names none of
  // them — the shape this tracking exists for — records nothing.
  function see(data) {
    const values = [
      data.item,
      ...(Array.isArray(data.output) ? data.output : []),
      ...(Array.isArray(data.response?.output) ? data.response.output : []),
    ];
    for (const value of values) {
      if (object(value) && typeof value.id === "string" && value.id) seen.add(value.id);
    }
  }
  // Opens a call the reply placed nowhere — a frame with no output_index — and
  // answers the entry that names it. Its id is what the guard answered for the
  // call, filled in by the caller once it knows: the entry is what a later copy
  // of the same call is recognised by, and that copy can carry nothing at all —
  // no word of its own and no index (measured: the frame that closes the call
  // drops the call_id the frame that opened it carried), so the call's name
  // among the entries is the only thing left to read it by.
  function entering(name, settled = false) {
    const entry = { name, id: undefined, settled };
    nowhere.push(entry);
    open = nowhere.length - 1;
    return entry;
  }
  // The words a frame can name this call by: the item id and the call_id, a
  // non-empty string each (identity), and both name the one call.
  function names(call) {
    return [identity(call.id), identity(call.call_id)].filter((value) => value !== undefined);
  }
  // Whether the call carries a word of its own to be placed by — the test
  // inPlaceOf and ensureCallIDs make, so all three read "" the same way.
  function identified(call) {
    return identity(call.id) !== undefined || identity(call.call_id) !== undefined;
  }
  // Records that this call answers `id`, under every word the reply has for it:
  // the copies of the call that follow answer the same one.
  function mintedFor(call, id) {
    minted.set(id, id);
    for (const word of names(call)) minted.set(word, id);
    return id;
  }
  // The stream's answer for a call it leaves out: the id this call already
  // answers, or undefined when the stream has none and the call keeps its own.
  // The walk hands every call it leaves out through here.
  function placeOf(call, at, listed) {
    if (protocol !== "responses") return undefined;
    // A word the reply has already used for a call it left out names that
    // call: answer the id it was handed.
    const bound = names(call)
      .map((word) => minted.get(word))
      .find((id) => id !== undefined);
    if (bound !== undefined) return bound;
    if (listed) {
      // The copy inside a snapshot or the terminal response's output: it sits
      // where the walk found it, and a call the stream already replaced at
      // that place has answered an id there. A reply that places nothing is
      // what the rest can be read from, so the entry is matched by the place
      // it holds when the names agree, and by its name when they do not — the
      // same call is copied into several snapshots, and every one of them has
      // to answer the same id. Two calls of one name cannot be told apart
      // here, and the last one the stream opened answers for both, and a call
      // that carries a word of its own is not guessed at from a name.
      const held = left.get(at);
      if (typeof held === "string") return held;
      if (identified(call)) return undefined;
      const entry =
        (nowhere[at]?.name === call.name ? nowhere[at] : undefined) ??
        nowhere.findLast((value) => value.name === call.name);
      return entry?.id;
    }
    // A frame's own item. One that gave an index is placed by it: the call the
    // stream already replaced at that place answered an id there, and the
    // dropped_<at> token inPlaceOf mints is what a call the stream never
    // replaced gets.
    if (at !== undefined) {
      const held = left.get(at);
      return typeof held === "string" ? held : undefined;
    }
    const inside = nowhere[open] && !nowhere[open].settled ? nowhere[open] : undefined;
    if (identified(call)) {
      // The frame that closes a call the stream opened with nothing to place it
      // by can be the first of its frames to carry an id (measured). It is the
      // call the stream is inside, and the id already answered is what the
      // client has.
      if (!inside) return undefined;
      inside.settled = true;
      return mintedFor(call, inside.id);
    }
    // A frame with nothing at all to name it by: the call the stream opened
    // last of that name, which is the one it is closing — the id it answered
    // is the one the client was handed, and a later copy of the call has to
    // answer it again rather than mint one of its own.
    const entry = nowhere.findLast((value) => value.name === call.name) ?? inside;
    if (entry) {
      entry.settled = true;
      return mintedFor(call, entry.id);
    }
    // The call the stream is closing, in a frame that carries nothing to name
    // it by: the id the guard answered for it is what this copy answers, so
    // the call's rewrites stay one item. A frame of another call that only
    // looks like it — same name, no words — is read the same way, and that is
    // the closest thing to a word either of them has.
    if (closingID !== undefined && closingName === call.name) return mintedFor(call, closingID);
    // A done frame whose added frame was never seen. It is a call of its own,
    // and the terminal's copy of it still answers this id by name.
    const opened = entering(call.name, true);
    opened.id = `msg_anon_${++synthesized}`;
    return mintedFor(call, opened.id);
  }
  return {
    apply(data, type) {
      if (protocol === "responses") {
        see(data);
        const item = data.item;
        const opens = type === "response.output_item.added";
        const closes = type === "response.output_item.done";
        // A frame that opens or closes an item ends the window the last one
        // had: the stream is not inside that item any more, so an arguments
        // frame that gives no place of its own is not that item's to answer
        // for (below). The item this frame opens is entered just after this,
        // in the frame's own branch.
        if (opens || closes) {
          // The item the stream was inside, for the frame that closes it: a
          // copy of a call can arrive with nothing at all to name it by — no
          // word of its own and no index — and the call being closed is the
          // one whose id it answers.
          closingID = closes ? insideID : undefined;
          closingName = closes ? insideName : undefined;
          insideID = undefined;
          insideName = undefined;
          insideKept = false;
          insideWords.clear();
          if (opens && nowhere[open]) nowhere[open].settled = true;
        }
        // The item this frame carries, when it is a call with no name: the
        // walk below replaces it — opens or closes it, the copy is the same
        // call — and its words are the ones a note takes the place of. Every
        // other item the frame names is one the reply keeps, and the place it
        // holds is a fact the suppression below reads before any word.
        const leaving =
          (opens || closes) &&
          object(item) &&
          item.type === "function_call" &&
          checkName(item.name) == null;
        // A copy of a call left out — the frame that closes it, and every copy
        // of it a snapshot or the terminal carries — holds no place of its own:
        // the place the call holds is the one the frame that opened it was
        // answered at, and a reply at odds with itself (one copy numbered and
        // the next not, or two copies numbered differently) reads back as one
        // item only when the copies leave the placing to the stream's own
        // answer. The id they all answer is what the collapse path finds them
        // by. The frame that opens the call keeps its index: that is where the
        // place comes from.
        if (closes && leaving && data.output_index !== undefined) delete data.output_index;
        if ((opens || closes) && object(item) && !leaving) {
          if (data.output_index !== undefined) keptPlaces.add(data.output_index);
          for (const id of names(item)) keptWords.add(id);
          // A function_call the reply kept: an arguments frame that gives no
          // place of its own is this call's while the stream is inside it.
          if (opens && item.type === "function_call") {
            insideKept = true;
            for (const id of names(item)) insideWords.add(id);
          }
        }
        if (opens && leaving) {
          const note = droppedNote(item.name);
          // The frame's output_index is this call's place in the reply, which
          // is the id its later frames (done, the terminal's output) invent
          // for it again (inPlaceOf). A frame that gives no index leaves the
          // place to the stream: the entry opened here is what its later
          // frames — and its arguments frames — are matched by, and it is
          // opened whether or not the frame carried a word, because the frame
          // that closes the call can carry none (measured: the call_id the
          // added frame named is gone from the done frame).
          const entry = data.output_index === undefined ? entering(item.name) : undefined;
          const message = inPlaceOf(protocol, item, note, data.output_index, entry?.id);
          if (entry) entry.id = message.id;
          // Every word this call can be named by later is recorded, whichever
          // shape its frames have: the id the guard answered for it (with the
          // place in it), and the id and call_id the upstream gave it — the
          // arguments frames of a call that gave an index name it by one of
          // those alone, so a set of invented ids would let them through,
          // describing an item the client is told was replaced by a note. The
          // place it answered at is recorded too, so the copies of it that
          // follow answer the same id rather than the one the upstream settles
          // on after them.
          if (data.output_index !== undefined) left.set(data.output_index, message.id);
          for (const id of [message.id, ...names(item)]) leftIDs.add(id);
          mintedFor(item, message.id);
          // And the stream is inside it: its arguments frames carry no place
          // of their own, and this window is what says they are its frames
          // rather than an item the reply never opened.
          insideID = message.id;
          insideName = item.name;
          for (const id of [message.id, ...names(item)]) insideWords.add(id);
          dropped++;
          const where = { item_id: message.id, output_index: data.output_index, content_index: 0 };
          const part = { type: "output_text", text: "", annotations: [] };
          return {
            changed: true,
            data: { ...data, item: { ...message, status: "in_progress", content: [] } },
            extra: [
              { type: "response.content_part.added", ...where, part },
              { type: "response.output_text.delta", ...where, delta: note },
              { type: "response.output_text.done", ...where, text: note },
              { type: "response.content_part.done", ...where, part: { ...part, text: note } },
            ],
          };
        }
        if (typeof type === "string" && type.startsWith("response.function_call_arguments.")) {
          // Whose frame this is, by what the frame itself says: the place it
          // gives is a fact about the reply and is read first, whoever holds
          // it; a frame that gives none belongs to the item the stream is
          // inside; and one that arrives outside any item is read by its word.
          // The answer is the same whichever order the calls arrived in,
          // because no step of it subtracts one set of words from another.
          const place = data.output_index;
          const word = identity(data.item_id);
          let holder = "kept";
          if (place != null && left.has(place) && !keptPlaces.has(place)) holder = "dropped";
          // Two items stated one index: the place cannot say whose the frame
          // is, and the word it names is what is left.
          else if (place != null && word !== undefined && keptWords.has(word)) holder = "kept";
          else if (place != null && left.has(place)) holder = "dropped";
          else if (place != null && keptPlaces.has(place)) holder = "kept";
          else if (place == null && insideID !== undefined)
            // A word the reply named on some other item is that item's frame,
            // interleaved with this call's own: the call the stream is inside
            // answers for the words it was named by, and for a word the reply
            // names nowhere else (measured: the added frame carries no id, and
            // the frames after it name one).
            holder =
              word !== undefined && seen.has(word) && !insideWords.has(word) ? "kept" : "dropped";
          else if (place == null && insideKept) holder = "kept";
          else if (word !== undefined && leftIDs.has(word)) holder = "dropped";
          if (holder === "dropped") {
            if (word !== undefined) {
              leftIDs.add(word);
              // The id names the call the stream is inside, so a copy of that
              // call which later carries it answers the id the client was
              // handed (placeOf).
              const answers = (place != null ? left.get(place) : undefined) ?? insideID;
              if (answers !== undefined) minted.set(word, answers);
            }
            return { changed: true, data: null };
          }
        }
      } else {
        if (type === "message_start") {
          left.clear();
          kept = 0;
          dropped = 0;
        }
        const block = data.content_block;
        if (
          type === "content_block_start" &&
          object(block) &&
          isCall(protocol, block) &&
          checkName(block.name) == null
        ) {
          left.set(data.index, true);
          dropped++;
          return {
            changed: true,
            data: { ...data, content_block: { type: "text", text: "" } },
            extra: [
              {
                type: "content_block_delta",
                index: data.index,
                delta: { type: "text_delta", text: droppedNote(block.name) },
              },
            ],
          };
        }
        if (type === "content_block_delta" && left.has(data.index))
          return { changed: true, data: null };
        if (
          type === "message_delta" &&
          object(data.delta) &&
          data.delta.stop_reason === "tool_use" &&
          dropped &&
          !kept
        ) {
          data.delta.stop_reason = "end_turn";
          return { changed: true, data };
        }
      }
      const checked = checkSnapshots(data, protocol, checkName, placeOf);
      kept += checked.kept;
      dropped += checked.left;
      return { changed: checked.changed, data };
    },
  };
}

// A reply that is not a stream is read whole before it is checked, so it is
// read through the same limit a streamed reply's events are: a body past it
// is a 502, rather than the whole of it sitting in memory first.
async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts = [];
  let bytes = 0;
  // Named for the read it ends, not `failure`: that word is this module's
  // error constructor, and a local of the same name reads as if the guard's
  // own failures were being built here.
  let readFailure;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES)
        throw new GuardError(`Upstream response exceeds the ${LIMIT} buffer limit`);
      parts.push(value);
    }
  } catch (error) {
    readFailure = error;
  }
  // Whatever ended the read — the limit, a malformed body, or the end of it —
  // this body is never read again, so the stream is cancelled and the reader
  // loosed. This was the one place in the package that abandoned a body
  // without cancelling it (measured: no cancellation past the limit, and the
  // source still pulled after the 502), which leaves an upstream writing into
  // a socket nobody reads. A cancel that fails must not stand in for what
  // ended the read: an oversized body is the 502 this function promises, not
  // an opaque transport error, so the cancel's failure is kept as that
  // error's cause — and is thrown itself only when nothing else went wrong.
  // The lock is released either way.
  try {
    await reader.cancel();
  } catch (error) {
    if (!readFailure) throw error;
    if (readFailure instanceof Error && !("cause" in readFailure)) readFailure.cause = error;
  } finally {
    reader.releaseLock();
  }
  if (readFailure) throw readFailure;
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(all);
}

function parseJSON(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GuardError("Invalid JSON in upstream response");
  }
  if (!object(value)) throw new GuardError("Invalid JSON object in upstream response");
  return value;
}

function encodeEvent(data, name = "") {
  return `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function rewrite(frame, data) {
  const lines = frame.lines.filter((line) => line !== "data" && !line.startsWith("data:"));
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

async function* framesFrom(reader) {
  let parts = [];
  let lineBytes = 0;
  let eventBytes = 0;
  let lines = [];
  let rawLines = [];
  let skipLF = false;
  let pendingFrame;
  let firstLine = true;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function append(value) {
    eventBytes += value.byteLength;
    if (eventBytes > MAX_BYTES)
      throw new GuardError(`Upstream SSE event exceeds the ${LIMIT} buffer limit`);
    if (value.byteLength) {
      parts.push(value);
      lineBytes += value.byteLength;
    }
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (pendingFrame) {
        yield pendingFrame;
        pendingFrame = null;
        eventBytes = 0;
      }
      if (eventBytes || lineBytes || lines.length)
        throw new GuardError("Upstream SSE ended inside an event");
      return;
    }
    let start = 0;
    if (skipLF && value.length) {
      if (value[0] === 10) {
        eventBytes++;
        if (pendingFrame) pendingFrame.raw += "\n";
        else rawLines[rawLines.length - 1] += "\n";
        start = 1;
      }
      if (eventBytes > MAX_BYTES)
        throw new GuardError(`Upstream SSE event exceeds the ${LIMIT} buffer limit`);
      skipLF = false;
      if (pendingFrame) {
        const frame = pendingFrame;
        pendingFrame = null;
        eventBytes = 0;
        yield frame;
      }
    }
    for (let offset = start; offset < value.length; offset++) {
      if (value[offset] !== 10 && value[offset] !== 13) continue;
      append(value.subarray(start, offset));
      if (++eventBytes > MAX_BYTES)
        throw new GuardError(`Upstream SSE event exceeds the ${LIMIT} buffer limit`);
      const bytes = new Uint8Array(lineBytes);
      let cursor = 0;
      for (const part of parts) {
        bytes.set(part, cursor);
        cursor += part.length;
      }
      let line;
      try {
        line = decoder.decode(bytes);
      } catch {
        throw new GuardError("Invalid UTF-8 in upstream SSE event");
      }
      parts = [];
      lineBytes = 0;
      let rawLine = line + String.fromCharCode(value[offset]);
      if (firstLine) {
        line = line.replace(/^\uFEFF/, "");
        firstLine = false;
      }
      if (value[offset] === 13) {
        if (value[offset + 1] === 10) {
          rawLine += "\n";
          offset++;
          if (++eventBytes > MAX_BYTES)
            throw new GuardError(`Upstream SSE event exceeds the ${LIMIT} buffer limit`);
        } else if (offset + 1 === value.length) skipLF = true;
      }
      start = offset + 1;
      rawLines.push(rawLine);
      if (line) {
        lines.push(line);
      } else {
        const frameLines = lines;
        lines = [];
        let name = "";
        const data = [];
        for (const item of frameLines) {
          const colon = item.indexOf(":");
          const key = colon < 0 ? item : item.slice(0, colon);
          let content = colon < 0 ? "" : item.slice(colon + 1);
          if (content.startsWith(" ")) content = content.slice(1);
          if (key === "event") name = content;
          if (key === "data") data.push(content);
        }
        const frame = {
          lines: frameLines,
          name,
          text: data.join("\n"),
          raw: rawLines.join(""),
        };
        rawLines = [];
        if (skipLF) {
          // Preserve a trailing CRLF even when its LF arrives in the next chunk.
          pendingFrame = frame;
        } else {
          eventBytes = 0;
          yield frame;
        }
      }
    }
    append(value.subarray(start));
  }
}

// A Chat stream Zen closed before its [DONE] (#91: space-bunny-free, about
// 0.1% of turns) is ended as a turn cut short when it has said something
// and no tool call of it is pending: each choice still open gets a note
// saying so and a stop, then [DONE]. Failing it threw away the reasoning
// and text the agent already had, and a Chat reply through Zen can't be
// asked to go on from there. A pending call's arguments may be half
// written, and a reply that said nothing is an empty one, so both still
// fail, as does one collapsed for a client that doesn't stream, which can
// still be asked again. Anthropic and Responses streams cut short fail
// too: magpie's gateway tells such a reply from a whole one itself
// (#370), and goes on with it where the upstream can (an Anthropic one),
// which a made-up end here would stop.
export const cutShortNote =
  "(The reply was cut short: Zen closed the stream before it finished. Ask again to go on.)";

function chatTrack() {
  const open = new Set();
  const finished = new Set();
  const wrote = new Set();
  let said = false;
  let meta = null;
  return {
    see(data) {
      if (!object(data)) return;
      meta = {
        id: data.id ?? meta?.id,
        created: data.created ?? meta?.created,
        model: data.model ?? meta?.model,
      };
      for (const choice of Array.isArray(data.choices) ? data.choices : []) {
        if (!object(choice)) continue;
        const index = position(choice.index);
        const delta = object(choice.delta) ? choice.delta : {};
        for (const key of ["content", "reasoning_content", "reasoning"]) {
          if (typeof delta[key] === "string" && delta[key]) said = true;
        }
        if (typeof delta.content === "string" && delta.content) wrote.add(index);
        if (choice.finish_reason != null) {
          finished.add(index);
          open.delete(index);
        } else {
          // A frame for this choice after it finished opens a new round of it
          // (chatBuffer.apply judges a later round the same way), so the
          // choice is open again: latching it shut for good left a round cut
          // short with no note and no finish_reason, only a bare [DONE].
          finished.delete(index);
          open.add(index);
        }
      }
    },
    // ending answers the frames that end the reply as cut short, or null
    // when it can't be.
    ending() {
      if (!said) return null;
      const choices = [...open]
        .sort((a, b) => a - b)
        .map((index) => ({
          index,
          delta: { content: (wrote.has(index) ? "\n\n" : "") + cutShortNote },
          finish_reason: "stop",
        }));
      const head = {
        id: meta?.id ?? "chatcmpl-cut-short",
        object: "chat.completion.chunk",
        created: meta?.created ?? Math.floor(Date.now() / 1000),
        model: meta?.model ?? "",
      };
      return (choices.length ? encodeEvent({ ...head, choices }) : "") + "data: [DONE]\n\n";
    },
  };
}

function guardedStream(response, protocol, checkName, endCutShort) {
  const source = response.body?.getReader();
  // What came before a stream cut short, for its error to say (#91).
  let bytes = 0;
  let events = 0;
  let replyID;
  const reader = source && {
    async read() {
      const result = await source.read();
      if (result.value) bytes += result.value.byteLength;
      return result;
    },
    releaseLock: () => source.releaseLock(),
    cancel: (reason) => source.cancel(reason),
  };
  const chat = protocol === "chat" ? chatBuffer(checkName) : null;
  const track = chat && endCutShort ? chatTrack() : null;
  const snapshots = chat ? null : snapshotStream(protocol, checkName);
  let frames = reader ? framesFrom(reader) : null;
  let completed = false;
  let stopped = false;
  let released = false;
  let cancellation;
  function release() {
    if (reader && !released) {
      reader.releaseLock();
      released = true;
    }
    chat?.clear();
    frames = null;
  }
  function cancel(reason) {
    cancellation ??= (async () => {
      try {
        await reader?.cancel(reason);
      } finally {
        release();
      }
    })();
    return cancellation;
  }
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          while (!stopped) {
            const next = frames ? await frames.next() : { done: true };
            if (stopped) return;
            if (next.done) {
              const ending = !completed && !chat?.size ? track?.ending() : null;
              if (ending) {
                stopped = true;
                release();
                controller.enqueue(encoder.encode(ending));
                controller.close();
                return;
              }
              if (!completed || chat?.size) {
                const came = [
                  replyID ? `reply ${String(replyID).slice(0, 128)}` : "",
                  `${events} event${events === 1 ? "" : "s"}`,
                  `${bytes} bytes received`,
                  chat?.size ? "a tool call unfinished" : "",
                ].filter(Boolean);
                throw new GuardError(
                  `Upstream SSE ended without a completion marker (${came.join(", ")})`,
                );
              }
              stopped = true;
              release();
              controller.close();
              return;
            }
            const frame = next.value;
            if (frame.name !== "error" && !frame.text.trim()) {
              controller.enqueue(encoder.encode(frame.raw));
              return;
            }
            if (frame.name !== "error" && frame.text.trim() === "[DONE]") {
              // [DONE] is what ends a Chat stream, and a valid end-of-stream
              // sentinel for a Responses or Messages one that has already
              // reported its own terminal event (response.completed,
              // response.incomplete, message_stop) — a gateway in front of the
              // upstream may append it. Before that event it claims an ending
              // the protocol never reported, and the frame is refused; the
              // collapse path reads the same bytes the same way.
              if (protocol !== "chat" && !completed)
                throw new GuardError("Unexpected upstream completion marker");
              const final = chat ? chat.finish() : null;
              completed = true;
              controller.enqueue(encoder.encode((final ? encodeEvent(final) : "") + frame.raw));
              return;
            }
            events++;
            const data = frame.name === "error" ? null : parseJSON(frame.text);
            const type = data?.type ?? frame.name;
            replyID = data?.id ?? data?.message?.id ?? data?.response?.id ?? replyID;
            if (
              frame.name === "error" ||
              type === "error" ||
              data?.error ||
              type === "response.failed" ||
              data?.response?.status === "failed"
            ) {
              stopped = true;
              try {
                await cancel();
              } catch (cause) {
                controller.error(cause);
                return;
              }
              controller.enqueue(encoder.encode(frame.raw));
              controller.close();
              return;
            }
            // An event after the terminal marker is not part of the reply: the
            // reply ended where the marker said. Reading it as more of the
            // same was this path's behaviour alone — the collapse path read
            // the same bytes and dropped it (stream.mjs's `if (completed)
            // return`) — so the same upstream answered two different replies.
            // It is ignored: not applied to the buffer, not forwarded. This
            // sits below the error branch above on purpose: an upstream that
            // reports an error after it ended the reply still failed the turn,
            // and that is a failure, not something to ignore. A frame with no
            // data at all is the SSE's own framing rather than an event, and
            // it keeps flowing from above this point.
            if (completed) continue;
            const checked = chat ? chat.apply(data) : snapshots.apply(data, type);
            const { changed, data: result, extra = [] } = checked;
            if (result) track?.see(result);
            if (
              (protocol === "responses" &&
                ["response.completed", "response.incomplete"].includes(type)) ||
              (protocol === "anthropic" && type === "message_stop")
            )
              completed = true;
            if (result || extra.length) {
              // A frame the walk left as it came is forwarded as it came: only
              // its own bytes carry what a rewrite would drop — the event name
              // it was sent under, and any field of the frame the guard does
              // not read.
              let own = "";
              if (result) own = changed ? rewrite(frame, result) : frame.raw;
              const added = extra.map((value) => encodeEvent(value, value.type)).join("");
              controller.enqueue(encoder.encode(own + added));
              return;
            }
          }
        } catch (error) {
          if (stopped) return;
          stopped = true;
          if (error instanceof GuardError) {
            try {
              await cancel(error);
            } catch (cause) {
              controller.error(cause);
              return;
            }
            controller.enqueue(
              encoder.encode(
                encodeEvent(
                  failure(protocol, error.message, true, error.code),
                  protocol === "chat" ? "" : "error",
                ),
              ),
            );
            controller.close();
          } else {
            // A failure that is not the guard's own is a transport one: the
            // stream is over either way, and what is left of the body is not
            // something to keep writing into a socket nobody reads — the
            // same rule readBounded follows. Cancel's own failure is not
            // allowed to replace the error the client has to see, which is
            // the one that got here.
            try {
              await cancel(error);
            } catch {
              /* the original error is the one the client must see */
            }
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        stopped = true;
        await cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

// options.endCutShort lets a Chat stream cut short end as one (#91): for a
// client that streams, which has the reply's start already. A reply
// collapsed for a client that doesn't stream fails instead, so it can be
// asked again before anything reached the client.
export async function guardToolResponse(response, protocol, policy, options = {}) {
  // A protocol this guard has no rules for is the caller's mistake, and it
  // is one whichever the upstream answered: checked before the status is
  // read, so an error response cannot return it unexamined. The policy is
  // read here for the same reason: a policy this guard cannot read refuses
  // every call of every reply, and that must be said rather than done
  // quietly (declaredNames), whichever the upstream answered.
  if (!["chat", "responses", "anthropic"].includes(protocol))
    throw new TypeError(`Unsupported protocol: ${protocol}`);
  const checkName = nameGuard(policy);
  if (!response.ok) return response;
  const headers = headersFor(response);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType === "text/event-stream") {
    return new Response(guardedStream(response, protocol, checkName, options.endCutShort === true), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  let value;
  let status = response.status;
  try {
    value = parseJSON(await readBounded(response));
    checkSnapshots(value, protocol, checkName);
    if (protocol === "chat") {
      for (const choice of list(value.choices)) {
        const message = object(choice) ? choice.message : undefined;
        if (object(message)) ensureCallIDs(list(message.tool_calls));
      }
    }
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    status = 502;
    value = failure(protocol, error.message, false, error.code);
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { status, headers });
}

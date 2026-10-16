// The one byte limit a reply held in memory is read through: a streamed one
// event by event, a whole one in one read. Exported because tool-response.mjs
// reads the same bytes through the same limit and names the same number in its
// failures — a second copy of it is a second thing to keep in step.
export const MAX_BYTES = 32 * 1024 * 1024;

// The headers that describe the bytes a reply arrived as. A reply whose body
// is written again — a stream collapsed into one JSON document, or a guarded
// stream whose frames may be rewritten or added to — no longer describes
// those bytes: a length, an encoding, hop-by-hop framing, and the validators
// a cache or a conditional request would compare against all describe the
// old ones only. What says something about the reply itself (a retry-after,
// a request id) is left alone. One list, so the two places that write a body
// again cannot drift apart.
export const STALE_BODY_HEADERS = [
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "content-md5",
  "etag",
  "last-modified",
];

function jsonResponse(source, protocol, value, error) {
  const headers = new Headers(source.headers);
  for (const name of STALE_BODY_HEADERS) headers.delete(name);
  headers.set("content-type", "application/json");
  if (error) {
    const detail = { type: "upstream_error", message: error };
    value =
      protocol === "anthropic"
        ? { type: "error", error: detail }
        : { error: { ...detail, param: null, code: null } };
  }
  return new Response(JSON.stringify(value), {
    status: error ? 502 : source.status,
    headers,
  });
}

function errorMessage(value, fallback = "Upstream stream failed") {
  if (typeof value === "string" && value) return value;
  return value?.message || value?.error?.message || fallback;
}

function index(value) {
  const result = value ?? 0;
  if (!Number.isInteger(result) || result < 0 || result > 65535) {
    throw new Error("Invalid stream item index");
  }
  return result;
}

function sorted(map) {
  return [...map].sort(([a], [b]) => a - b).map(([, value]) => value);
}

function appendFunction(target, delta) {
  for (const key of ["name", "arguments"]) {
    if (typeof delta[key] === "string") target[key] = (target[key] ?? "") + delta[key];
  }
}

// The rule every streamed text field follows: a .delta appends to what came
// before it, a .done replaces it with the whole text. Written once, so a
// protocol tweak is applied to all of them together rather than five times.
function applyText(target, field, value, isDelta) {
  if (isDelta) target[field] = (target[field] ?? "") + (value ?? "");
  else if (value !== undefined) target[field] = value;
}

// How much of a streamed reply a snapshot carries, counted over the fields a
// stream fills in.
function weight(snapshot, fields) {
  let total = 0;
  for (const field of fields) {
    const value = snapshot?.[field];
    if (typeof value === "string") total += value.length;
    else if (Array.isArray(value)) total += value.length;
    else if (value && typeof value === "object") total += Object.keys(value).length;
  }
  return total;
}

// Whether a snapshot may stand in for what was accumulated. An upstream puts
// snapshots beside the deltas they describe — a repeated response.created, a
// message_start whose block has not been filled in, a terminal response — and
// one that carries nothing where the accumulation has content is a partial
// view of it rather than a newer one: taking it would discard what the stream
// already delivered. One that does carry the collection settles it, which is
// how response.output_item.done and a whole terminal response replace
// accumulated arguments with the complete ones.
function carries(snapshot, accumulated, fields) {
  return weight(snapshot, fields) > 0 || weight(accumulated, fields) === 0;
}

function chatAccumulator() {
  const body = { object: "chat.completion", choices: [] };
  const choices = new Map();
  const tools = new Map();
  return {
    apply(data) {
      for (const key of ["id", "created", "model", "system_fingerprint", "service_tier"]) {
        if (data[key] !== undefined) body[key] = data[key];
      }
      if (data.usage) body.usage = { ...body.usage, ...data.usage };
      for (const part of data.choices ?? []) {
        const position = index(part.index);
        if (!choices.has(position)) {
          choices.set(position, {
            index: position,
            message: { role: "assistant", content: null },
            finish_reason: null,
          });
          tools.set(position, new Map());
        }
        const choice = choices.get(position);
        const message = choice.message;
        const delta = part.delta ?? {};
        if (delta.role) message.role = delta.role;
        for (const key of ["content", "reasoning_content", "reasoning", "refusal"]) {
          if (typeof delta[key] === "string") message[key] = (message[key] ?? "") + delta[key];
        }
        if (delta.function_call) {
          message.function_call ??= { name: "", arguments: "" };
          appendFunction(message.function_call, delta.function_call);
        }
        for (const fragment of delta.tool_calls ?? []) {
          const toolIndex = index(fragment.index);
          const calls = tools.get(position);
          if (!calls.has(toolIndex))
            calls.set(toolIndex, { type: "function", function: { name: "", arguments: "" } });
          const call = calls.get(toolIndex);
          for (const key of ["id", "type"]) {
            if (fragment[key] !== undefined) call[key] = fragment[key];
          }
          if (fragment.function) appendFunction(call.function, fragment.function);
        }
        // Both null and undefined are "this chunk carried no finish reason";
        // a loose comparison is the only way to say that in one test, and the
        // project's rules do not allow it.
        if (part.finish_reason !== null && part.finish_reason !== undefined)
          choice.finish_reason = part.finish_reason;
        if (part.logprobs) {
          choice.logprobs ??= {};
          // Written as a defined own property, and read back as one. A
          // "__proto__" key arrives as an own property of the parsed object,
          // and `choice.logprobs[key] = value` would take the inherited
          // accessor instead: an object value silently re-parented the
          // accumulated object and the key never reached the reply, while an
          // array value read Object.prototype back and spread it, throwing
          // "not iterable" — a 502 on an otherwise valid stream. The delta
          // written by tool-response.mjs follows the same rule.
          for (const [key, value] of Object.entries(part.logprobs)) {
            const held = Object.hasOwn(choice.logprobs, key) ? choice.logprobs[key] : undefined;
            Object.defineProperty(choice.logprobs, key, {
              value: Array.isArray(value)
                ? [...(Array.isArray(held) ? held : []), ...value]
                : value,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        }
      }
    },
    finish() {
      for (const [position, choice] of choices) {
        if (tools.get(position).size) choice.message.tool_calls = sorted(tools.get(position));
      }
      body.choices = sorted(choices);
      return body;
    },
  };
}

function responsesAccumulator() {
  let body = { object: "response", output: [] };
  let final;
  const output = new Map();
  // The fields a streamed item fills in: a message its content, a call its
  // arguments, a reasoning item its summary.
  const fields = ["content", "arguments", "summary", "text"];
  // The slot a frame belongs to: the output_index it carries, or the slot
  // of the item it names when the upstream left output_index out. A frame
  // naming an item the stream never opened has no slot at all — slot 0 is
  // only for a frame that names nothing, which a stream that never indexed
  // its items means as the first one. Merging an unknown item into slot 0
  // was measured handing a function_call there the text of a message. An
  // `added` frame opens an item, so the id it names is new there by
  // definition and takes the next free slot; a frame that has to find an
  // item that is already open still throws.
  function slot(data, id, fresh = false) {
    if (data.output_index !== undefined) return index(data.output_index);
    if (id === undefined || id === null || id === "") return index(undefined);
    const position = [...output].find(([, value]) => value.id === id)?.[0];
    if (position !== undefined) return index(position);
    if (!fresh) throw new Error("Upstream frame names an unknown item without an output index");
    let next = 0;
    for (const held of output.keys()) next = Math.max(next, held + 1);
    return index(next);
  }
  // A snapshot replaces the item in its slot only when it is a whole view of
  // it; a partial one leaves what the deltas delivered standing.
  function keep(position, value) {
    if (carries(value, output.get(position), fields)) output.set(position, value);
  }
  function item(data, type = "message") {
    const position = slot(data, data.item_id);
    if (!output.has(position)) {
      const value = { type };
      if (data.item_id) value.id = data.item_id;
      if (type === "message") Object.assign(value, { role: "assistant", content: [] });
      if (type === "function_call") value.arguments = "";
      if (type === "reasoning") value.summary = [];
      output.set(position, value);
    }
    return output.get(position);
  }
  return {
    apply(data, type) {
      if (type === "response.created" || type === "response.in_progress") {
        if (data.response) {
          body = { ...body, ...data.response };
          // A snapshot that carries an item where the reply already has one
          // adds only what it actually carries: the accumulated items stand
          // against an output list it does not carry, or carries empty.
          for (const [position, value] of (data.response.output ?? []).entries())
            keep(position, value);
        }
      } else if (type === "response.output_item.added" || type === "response.output_item.done") {
        if (data.item)
          keep(slot(data, data.item.id, type === "response.output_item.added"), data.item);
      } else if (type === "response.content_part.added" || type === "response.content_part.done") {
        const value = item(data);
        value.content ??= [];
        // A re-emitted opening part carries an empty text where the deltas
        // have already filled the slot — the partial-snapshot hazard the item
        // guard above and content_block_start exist for, so the same test.
        // `refusal` is weighed too: a part whose only content is a refusal
        // weighs nothing on text alone and would be taken for an empty one.
        const at = index(data.content_index);
        if (carries(data.part, value.content[at], ["text", "refusal"]))
          value.content[at] = data.part;
      } else if (
        type === "response.output_text.delta" ||
        type === "response.output_text.done" ||
        type === "response.refusal.delta" ||
        type === "response.refusal.done"
      ) {
        const value = item(data);
        value.content ??= [];
        const refusal = type.startsWith("response.refusal.");
        const field = refusal ? "refusal" : "text";
        const part = (value.content[index(data.content_index)] ??= refusal
          ? { type: "refusal", refusal: "" }
          : { type: "output_text", text: "", annotations: [] });
        const isDelta = type.endsWith(".delta");
        applyText(part, field, isDelta ? data.delta : data[field], isDelta);
      } else if (
        type === "response.function_call_arguments.delta" ||
        type === "response.function_call_arguments.done"
      ) {
        const value = item(data, "function_call");
        const isDelta = type.endsWith(".delta");
        applyText(value, "arguments", isDelta ? data.delta : data.arguments, isDelta);
      } else if (
        type === "response.reasoning_summary_part.added" ||
        type === "response.reasoning_summary_part.done"
      ) {
        const value = item(data, "reasoning");
        value.summary ??= [];
        // The same re-emitted-opening-frame hazard as content_part above.
        const at = index(data.summary_index);
        if (carries(data.part, value.summary[at], ["text"])) value.summary[at] = data.part;
      } else if (/^response\.reasoning_(summary_)?text\.(delta|done)$/.test(type)) {
        const value = item(data, "reasoning");
        const summary = type.includes("summary");
        const collection = summary ? "summary" : "content";
        value[collection] ??= [];
        const at = index(summary ? data.summary_index : data.content_index);
        const part = (value[collection][at] ??= {
          type: summary ? "summary_text" : "reasoning_text",
          text: "",
        });
        // A summary's whole text arrives in `summary` and a reasoning text's
        // in `text`. Reading `text` for a summary lost a done event that had
        // no delta before it (measured: the summary came back empty).
        const isDelta = type.endsWith(".delta");
        applyText(part, "text", isDelta ? data.delta : summary ? data.summary : data.text, isDelta);
      } else if (type === "response.reasoning_content.delta") {
        body.reasoning_content = (body.reasoning_content ?? "") + (data.delta ?? "");
      } else if (type === "response.completed" || type === "response.incomplete") {
        if (data.response && typeof data.response === "object") final = data.response;
        body.status = type === "response.completed" ? "completed" : "incomplete";
        for (const key of ["incomplete_details", "finish_reason"]) {
          if (data[key] !== undefined) body[key] = data[key];
        }
      }
      if (data.usage) body.usage = { ...body.usage, ...data.usage };
    },
    finish() {
      if (!final) {
        body.output = sorted(output);
        return body;
      }
      const kept = sorted(output);
      // A terminal object that carries no output of its own — absent, or
      // empty while the stream accumulated some — is not a whole view of the
      // reply: returning it verbatim discards every delta already delivered,
      // and the client reads a 200 as a model that said nothing. The
      // accumulation stands in for the collection it lost; everything else
      // about the terminal is what the upstream said last, and comes back
      // exactly as it arrived.
      const whole = Array.isArray(final.output)
        ? final.output.length > 0
        : final.output !== null && final.output !== undefined;
      // An array is not a reply object at all, and is returned as it came.
      if (Array.isArray(final)) return final;
      // The terminal is not the whole reply either. What apply merged onto
      // the body from the events' top level — usage, status,
      // incomplete_details, finish_reason, and the object this reply is — is
      // the upstream's too, and answering with the terminal alone dropped it:
      // a terminal carrying its whole response beside a top-level usage, or
      // one that omits object, answered without them. The body is the base,
      // the terminal overrides what it carries, and the items it lost come
      // back from the accumulation.
      if (whole || !kept.length) return { ...body, ...final };
      return { ...body, ...final, output: kept };
    },
  };
}

function anthropicAccumulator() {
  let body = {
    type: "message",
    role: "assistant",
    content: [],
    stop_reason: null,
    stop_sequence: null,
  };
  const blocks = new Map();
  const argumentsJSON = new Map();
  // The fields a Messages block fills in: its text, thinking, signature, or
  // the input a tool call opened with.
  const fields = ["text", "thinking", "signature", "partial_json", "input"];
  return {
    apply(data, type) {
      if (type === "message_start") {
        body = { ...body, ...data.message };
        // A message_start that repeats beside the deltas it opened, or one
        // whose block has not been filled in yet, is a partial view of the
        // reply: a block that carries nothing where the accumulated one has
        // content leaves it standing.
        for (const [position, block] of (data.message?.content ?? []).entries())
          if (carries(block, blocks.get(position), fields)) blocks.set(position, block);
      } else if (type === "content_block_start") {
        // The same test message_start's blocks get, for the same reason: a
        // gateway re-emitting a block's opening frame carries a block that
        // was never filled in (a text one opens with text: ""), and taking
        // it would discard the text, thinking or signature the deltas
        // already delivered. A start with nothing accumulated applies, as
        // does one that carries content of its own.
        const position = index(data.index);
        if (carries(data.content_block, blocks.get(position), fields))
          blocks.set(position, data.content_block);
      } else if (type === "content_block_delta") {
        const position = index(data.index);
        const block = blocks.get(position);
        if (!block) throw new Error("Content delta without a content block");
        const delta = data.delta ?? {};
        const field = {
          text_delta: "text",
          thinking_delta: "thinking",
          signature_delta: "signature",
        }[delta.type];
        if (field) applyText(block, field, delta[field], true);
        if (delta.type === "input_json_delta") {
          argumentsJSON.set(
            position,
            (argumentsJSON.get(position) ?? "") + (delta.partial_json ?? ""),
          );
        }
      } else if (type === "message_delta") {
        // Only the fields a message_delta is defined to carry are taken from
        // it. Object.assign copied with [[Set]] semantics: a "__proto__" key
        // in the upstream's delta re-parented the message being accumulated,
        // and any other key silently overwrote its id, role, type or content.
        for (const field of ["stop_reason", "stop_sequence"]) {
          if (data.delta?.[field] !== undefined) body[field] = data.delta[field];
        }
        if (data.usage) body.usage = { ...body.usage, ...data.usage };
      }
    },
    finish() {
      for (const [position, value] of argumentsJSON) {
        // An upstream may send an empty delta set for a call that takes no
        // arguments: there are no bytes to parse, and the block's own input
        // stands. JSON.parse("") would fail a valid call.
        if (!value.trim()) continue;
        const block = blocks.get(position);
        if (!block) throw new Error("Tool input for no content block in upstream stream");
        try {
          block.input = JSON.parse(value);
        } catch {
          throw new Error("Invalid tool input JSON in upstream stream");
        }
      }
      body.content = sorted(blocks);
      return body;
    },
  };
}

export async function collapseResponse(response, protocol) {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/event-stream") return response;
  const factories = {
    chat: chatAccumulator,
    responses: responsesAccumulator,
    anthropic: anthropicAccumulator,
  };
  if (!Object.hasOwn(factories, protocol)) throw new TypeError(`Unsupported protocol: ${protocol}`);
  const accumulator = factories[protocol]();
  let completed = false;
  let failure;
  let eventName = "";
  let dataLines = [];
  let lineParts = [];
  let skipLF = false;

  function dispatch() {
    const name = eventName;
    const text = dataLines.join("\n");
    eventName = "";
    dataLines = [];
    if (failure) return;
    if (name === "error") {
      let value = text;
      try {
        value = JSON.parse(text);
      } catch {
        /* Error events may contain plain text. */
      }
      failure = errorMessage(value);
      return;
    }
    if (!text.trim()) return;
    if (text.trim() === "[DONE]") {
      // [DONE] is what ends a Chat stream, and it is a valid end-of-stream
      // sentinel for a Responses or Messages one that has already reported
      // its own terminal event (response.completed, response.incomplete,
      // message_stop) — a gateway in front of the upstream may append it.
      // Before that event it is an ending the protocol never reported, so
      // what was streamed is not a whole reply: the guard refuses the same
      // bytes with the same words rather than reading them as a success.
      if (protocol === "chat") completed = true;
      else if (!completed) failure = "Unexpected upstream completion marker";
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      failure = "Invalid JSON in upstream SSE event";
      return;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      failure = "Invalid JSON object in upstream SSE event";
      return;
    }
    const type = data.type ?? name;
    if (
      data.error ||
      type === "error" ||
      type === "response.failed" ||
      data.response?.status === "failed"
    ) {
      failure = errorMessage(data.error ?? data.response?.error ?? data);
      return;
    }
    if (completed) return;
    try {
      accumulator.apply(data, type);
    } catch (error) {
      failure = errorMessage(error, "Invalid upstream SSE event");
      return;
    }
    if (
      (protocol === "responses" &&
        (type === "response.completed" || type === "response.incomplete")) ||
      (protocol === "anthropic" && type === "message_stop")
    )
      completed = true;
  }

  function line(value) {
    if (value === "") return dispatch();
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") dataLines.push(content);
    if (field === "event") eventName = content;
  }

  function feed(text) {
    let start = 0;
    if (skipLF && text.length) {
      if (text[0] === "\n") start = 1;
      skipLF = false;
    }
    const endings = /[\r\n]/g;
    endings.lastIndex = start;
    let match;
    while ((match = endings.exec(text))) {
      lineParts.push(text.slice(start, match.index));
      line(lineParts.join(""));
      lineParts = [];
      start = match.index + 1;
      if (match[0] === "\r") {
        if (text[start] === "\n") start++;
        else if (start === text.length) skipLF = true;
      }
      endings.lastIndex = start;
    }
    if (start < text.length) lineParts.push(text.slice(start));
  }

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          failure = `Upstream SSE exceeds the ${MAX_BYTES / (1024 * 1024)} MiB limit`;
          await reader.cancel();
          break;
        }
        feed(decoder.decode(value, { stream: true }));
        if (failure) {
          await reader.cancel();
          break;
        }
      }
      feed(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }
  if (!failure && !completed) failure = "Upstream SSE ended without a completion marker";
  let body;
  if (!failure) {
    try {
      body = accumulator.finish();
    } catch (error) {
      failure = errorMessage(error);
    }
  }
  return jsonResponse(response, protocol, body, failure);
}

export const protocols = [
  { protocol: "chat", path: "chat/completions", model: "chat-free" },
  { protocol: "responses", path: "responses", model: "responses-free" },
  { protocol: "anthropic", path: "messages", model: "messages-free" },
];

// The registry above is the one list of protocols. A typo, a renamed one, or
// one added there and not here is an error, rather than a fixture of
// whichever shape happens to be written last.
function known(protocol) {
  if (!protocols.some((entry) => entry.protocol === protocol))
    throw new Error(`unknown protocol: ${protocol}`);
  return protocol;
}

// The model a protocol is asked as, read from the same registry every other
// fixture gets its protocol from: a rename there cannot leave a fixture
// naming a model the plugin no longer offers.
export function modelFor(protocol) {
  known(protocol);
  return protocols.find((entry) => entry.protocol === protocol).model;
}

// Where a call's arguments are cut into the two deltas a stream delivers
// them in. One number for both protocols, so the fixtures cannot disagree
// about where the first piece ends.
const argumentSplit = 12;

export function declaredTools(protocol) {
  known(protocol);
  return ["Bash", "Read"].map((name) => {
    const schema = { type: "object", properties: { command: { type: "string" } } };
    const tool = { name, description: `Client ${name}` };
    if (protocol === "chat") return { type: "function", function: { ...tool, parameters: schema } };
    if (protocol === "anthropic") return { ...tool, input_schema: schema };
    if (protocol === "responses") return { type: "function", ...tool, parameters: schema };
    // Unreachable while known() above holds the registry, and deliberate:
    // a protocol added to the registry and given no shape here is an error
    // rather than whichever fixture is written last.
    throw new Error(`unhandled protocol: ${protocol}`);
  });
}

export function toolReply(protocol, name, sse = true) {
  known(protocol);
  const args = JSON.stringify({ command: "ls -la" });
  const model = modelFor(protocol);
  const event = (value, type) =>
    `${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
  if (protocol === "chat") {
    const tool = { id: "call_1", type: "function", function: { name, arguments: args } };
    const head = { id: "c1", object: "chat.completion.chunk", model };
    if (!sse)
      return JSON.stringify({
        id: "c1",
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [tool] },
            finish_reason: "tool_calls",
          },
        ],
      });
    return (
      event({
        ...head,
        choices: [
          {
            index: 0,
            // A real Chat stream opens with the role in its first delta.
            delta: { role: "assistant", tool_calls: [{ index: 0, ...tool }] },
            finish_reason: null,
          },
        ],
      }) +
      event({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n"
    );
  }
  if (protocol === "responses") {
    const item = {
      id: "fc1",
      type: "function_call",
      call_id: "call_1",
      name,
      arguments: args,
      status: "completed",
    };
    const response = { id: "r1", object: "response", status: "completed", output: [item] };
    if (!sse) return JSON.stringify(response);
    const where = { item_id: "fc1", output_index: 0 };
    return (
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, arguments: "", status: "in_progress" },
      }) +
      event({
        type: "response.function_call_arguments.delta",
        ...where,
        delta: args.slice(0, argumentSplit),
      }) +
      event({
        type: "response.function_call_arguments.delta",
        ...where,
        delta: args.slice(argumentSplit),
      }) +
      event({ type: "response.function_call_arguments.done", ...where, arguments: args }) +
      event({ type: "response.output_item.done", output_index: 0, item }) +
      event({ type: "response.completed", response })
    );
  }
  if (protocol !== "anthropic") throw new Error(`unhandled protocol: ${protocol}`);
  const block = { type: "tool_use", id: "call_1", name, input: JSON.parse(args) };
  const message = {
    id: "m1",
    type: "message",
    role: "assistant",
    content: [block],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 2 },
  };
  if (!sse) return JSON.stringify(message);
  // The canonical shape: the block opens carrying no input, and the
  // arguments arrive as partial JSON, the way a real Messages stream
  // delivers them.
  return (
    event(
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      "message_start",
    ) +
    event(
      { type: "content_block_start", index: 0, content_block: { ...block, input: {} } },
      "content_block_start",
    ) +
    event(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: args.slice(0, argumentSplit) },
      },
      "content_block_delta",
    ) +
    event(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: args.slice(argumentSplit) },
      },
      "content_block_delta",
    ) +
    event({ type: "content_block_stop", index: 0 }, "content_block_stop") +
    event(
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
      "message_delta",
    ) +
    event({ type: "message_stop" }, "message_stop")
  );
}

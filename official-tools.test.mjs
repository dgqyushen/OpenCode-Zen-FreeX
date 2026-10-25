import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_TOOL_PREFIX,
  OFFICIAL_SETS,
  TOOL_NAME_LIMIT,
  ToolRenames,
  clientToolWireName,
  officialTool,
  officialToolNames,
  officialToolset,
  renameAndCompleteTools,
  sanitizeToolName,
} from "./official-tools.mjs";

// The capture is data, not a fixture this file may edit: every test reads the
// published table, so a re-capture moves the expectations with it. The one
// description the module rewrites for the host platform is read through the
// same rule here rather than pinned to the Linux wording.
const isWindows = process.platform === "win32";

function capturedDescription(generation, name) {
  const description = OFFICIAL_SETS[generation].tools[name].description;
  if (!isWindows) return description;
  if (generation === "1.x" && name === "bash") {
    return description.replace("OS: linux, Shell: bash", "OS: windows, Shell: powershell");
  }
  if (generation === "2.x" && name === "shell") {
    return description.replace("on Linux using bash", "on Windows using bash");
  }
  return description;
}

const chatTool = (name, description = `The host's ${name}.`) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
});

// The two generations are the two shapes Zen answers. A capture with one of
// them missing is a packaging failure, and these assert the names the gate and
// the request path both build their bodies from.
test("the capture holds the complete official set for both generations", () => {
  assert.deepEqual(Object.keys(OFFICIAL_SETS).sort(), ["1.x", "2.x"]);
  assert.deepEqual(officialToolNames("1.x"), [
    "bash",
    "edit",
    "glob",
    "grep",
    "read",
    "skill",
    "task",
    "todowrite",
    "webfetch",
    "websearch",
    "write",
  ]);
  // The 2.x set is 2.1.4's, captured 2026-10-25: `execute` joins the set (Code
  // Mode's runner), `patch` has left it, and `execute` is ordered last, where
  // the client sends it.
  assert.deepEqual(officialToolNames("2.x"), [
    "edit",
    "glob",
    "grep",
    "question",
    "read",
    "shell",
    "skill",
    "subagent",
    "webfetch",
    "websearch",
    "write",
    "execute",
  ]);
  for (const generation of Object.keys(OFFICIAL_SETS)) {
    const set = OFFICIAL_SETS[generation];
    // Every ordered name is described, and every description has something to
    // send: a tool with no parameters is a malformed function definition.
    assert.deepEqual([...set.order].sort(), Object.keys(set.tools).sort());
    for (const name of set.order) {
      assert.equal(typeof set.tools[name].description, "string");
      assert.ok(set.tools[name].description.length > 0, `${generation} ${name} wording`);
      assert.equal(typeof set.tools[name].parameters, "object");
    }
  }
  // The accessor hands out a copy: a caller that sorts the names it is given
  // must not reorder the table for the next request.
  const names = officialToolNames("1.x");
  names.reverse();
  assert.equal(officialToolNames("1.x")[0], "bash");
});

test("an official tool is rendered in the protocol's own shape", () => {
  for (const generation of ["1.x", "2.x"]) {
    const names = officialToolNames(generation);
    const chat = officialToolset("chat", generation);
    const anthropic = officialToolset("anthropic", generation);
    const responses = officialToolset("responses", generation);
    assert.equal(chat.length, names.length);
    assert.equal(anthropic.length, names.length);
    assert.equal(responses.length, names.length);
    for (const [at, name] of names.entries()) {
      const definition = OFFICIAL_SETS[generation].tools[name];
      assert.equal(chat[at].type, "function");
      assert.equal(chat[at].function.name, name);
      // 2.x's Chat client writes strict:false on every function; 1.x writes no
      // strict field at all, so the shape must not grow one.
      assert.equal(chat[at].function.strict, generation === "2.x" ? false : undefined);
      assert.equal(chat[at].function.description, capturedDescription(generation, name));
      assert.deepEqual(chat[at].function.parameters, definition.parameters);

      assert.equal(anthropic[at].name, name);
      assert.equal(anthropic[at].description, capturedDescription(generation, name));
      assert.deepEqual(anthropic[at].input_schema, definition.parameters);
      assert.equal(anthropic[at].type, undefined);

      assert.equal(responses[at].type, "function");
      assert.equal(responses[at].name, name);
      assert.equal(responses[at].description, capturedDescription(generation, name));
      assert.deepEqual(responses[at].parameters, definition.parameters);
    }
  }
});

test("the platform's shell is the one the official wording describes", () => {
  // The rewrite is conditional on the host: on Linux the captured wording is
  // already true, and replacing it would tell the model about a shell this
  // machine does not have.
  const bash = officialTool("chat", "bash", "1.x").function.description;
  const shell = officialTool("chat", "shell", "2.x").function.description;
  if (isWindows) {
    assert.match(bash, /OS: windows, Shell: powershell/);
    assert.doesNotMatch(bash, /OS: linux, Shell: bash/);
    assert.match(shell, /on Windows using bash/);
    assert.doesNotMatch(shell, /on Linux using bash/);
  } else {
    assert.match(bash, /OS: linux, Shell: bash/);
    assert.doesNotMatch(bash, /OS: windows, Shell: powershell/);
    assert.match(shell, /on Linux using bash/);
    assert.doesNotMatch(shell, /on Windows using bash/);
  }
  // A tool whose description has nothing to do with the shell is left alone.
  assert.equal(
    officialTool("chat", "read", "1.x").function.description,
    OFFICIAL_SETS["1.x"].tools.read.description,
  );
});

test("an unknown generation, name or protocol is named in the error", () => {
  assert.throws(() => officialToolNames("3.x"), /no official set for generation "3\.x"/);
  assert.throws(() => officialTool("chat", "nope", "1.x"), /does not describe "nope"/);
  assert.throws(() => officialTool("grpc", "read", "1.x"), /unknown protocol "grpc"/);
});

test("a client tool name is reduced to what the upstreams accept", () => {
  assert.equal(sanitizeToolName("Read File!"), "Read_File");
  assert.equal(sanitizeToolName("  --foo__bar--  "), "foo__bar");
  // Every invalid run collapses to one underscore, and a name that is nothing
  // but invalid characters has nothing left after the trim.
  assert.equal(sanitizeToolName("a??b"), "a_b");
  assert.equal(sanitizeToolName("???"), "");
  assert.equal(sanitizeToolName(""), "");
  assert.equal(sanitizeToolName(null), "");
  assert.equal(sanitizeToolName(undefined), "");
  // The character set is kept as written: case and separators are the host's.
  assert.equal(sanitizeToolName("apply_patch-v2"), "apply_patch-v2");
});

test("a client tool's wire name fits the limit, has the prefix and never collides", () => {
  const used = new Set();
  assert.equal(clientToolWireName("read", used), "clint_read");
  assert.equal(clientToolWireName("read", used), "clint_read_2");
  assert.equal(clientToolWireName("read", used), "clint_read_3");
  // Names that sanitize to the same spelling collide too: they are the same
  // wire name, and a second tool cannot answer to it.
  assert.equal(clientToolWireName("a b", used), "clint_a_b");
  assert.equal(clientToolWireName("a?b", used), "clint_a_b_2");
  // An empty name still has to be addressable, and a long one is cut rather
  // than sent over the limit.
  assert.equal(clientToolWireName("", new Set()), "clint_tool");
  assert.equal(clientToolWireName("???", new Set()), "clint_tool");
  const long = clientToolWireName("x".repeat(200), new Set());
  assert.equal(long.length, TOOL_NAME_LIMIT);
  assert.ok(long.startsWith(CLIENT_TOOL_PREFIX));
  // The collision suffix takes its own room rather than growing the name.
  const base = clientToolWireName("y".repeat(200), new Set());
  const second = clientToolWireName("y".repeat(200), new Set([base]));
  assert.equal(second.length, TOOL_NAME_LIMIT);
  assert.ok(second.endsWith("_2"));
});

test("a wire name restores the client name the host declared", () => {
  const renames = new ToolRenames();
  assert.equal(renames.empty, true);
  renames.add("read", "clint_read");
  renames.add("lookup", "clint_lookup");
  assert.equal(renames.size, 2);
  assert.equal(renames.empty, false);
  assert.equal(renames.wire("read"), "clint_read");
  assert.equal(renames.wire("unknown"), undefined);
  assert.equal(renames.restore("clint_read"), "read");
  assert.equal(renames.restore("clint_lookup"), "lookup");
  // The exact map is the rule; a name from before a reload is recovered by
  // stripping the prefix, and a name that never had it is passed through.
  assert.equal(renames.restore("clint_ghost"), "ghost");
  assert.equal(renames.restore("clint_"), "clint_");
  assert.equal(renames.restore("read"), "read");
  assert.equal(renames.restore(""), "");
  assert.equal(renames.restore(undefined), undefined);
  // A pair that would not rename anything, or would point two clients at one
  // wire name, is not recorded.
  renames.add("same", "same");
  renames.add("other", "clint_read");
  renames.add("", "clint_empty");
  renames.add("empty", "");
  assert.equal(renames.size, 2);
  assert.equal(renames.wire("same"), undefined);
  assert.equal(renames.wire("other"), undefined);
});

test("a chat request renames its client tools, appends the official set and rewrites every reference", () => {
  const body = {
    model: "chat-free",
    tools: [chatTool("lookup"), chatTool("apply_patch")],
    tool_choice: { type: "function", function: { name: "lookup" } },
    function_call: { name: "apply_patch", arguments: "{}" },
    messages: [
      {
        role: "assistant",
        function_call: { name: "lookup", arguments: "{}" },
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
          { id: "call-2", type: "function", function: { name: "apply_patch", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
    ],
  };
  const renames = renameAndCompleteTools(body, "chat", "1.x");

  assert.deepEqual(
    body.tools.map((tool) => tool.function.name),
    ["clint_lookup", "clint_apply_patch", ...officialToolNames("1.x")],
  );
  // The host's definitions are its own: the name moved, and nothing else did.
  assert.equal(body.tools[0].function.description, "The host's lookup.");
  assert.deepEqual(body.tools[0].function.parameters, { type: "object", properties: {} });
  // The wire name in a reference has to match the definition, or the request
  // refers to a tool it did not send.
  assert.equal(body.tool_choice.function.name, "clint_lookup");
  assert.equal(body.function_call.name, "clint_apply_patch");
  assert.equal(body.messages[0].function_call.name, "clint_lookup");
  assert.deepEqual(
    body.messages[0].tool_calls.map((call) => call.function.name),
    ["clint_lookup", "clint_apply_patch"],
  );
  // A tool result names only its call id, which is not a tool name.
  assert.equal(body.messages[1].tool_call_id, "call-1");
  assert.equal(renames.size, 2);
  assert.equal(renames.restore("clint_lookup"), "lookup");
  assert.equal(renames.restore("clint_apply_patch"), "apply_patch");
});

test("a string tool_choice carries no name and is left alone", () => {
  const body = {
    model: "chat-free",
    tools: [chatTool("read")],
    tool_choice: "auto",
  };
  renameAndCompleteTools(body, "chat", "1.x");
  assert.equal(body.tool_choice, "auto");
});

test("a 2.x chat request marks every tool strict:false unless the host said otherwise", () => {
  const body = {
    model: "chat-free",
    tools: [
      chatTool("read"),
      { type: "function", function: { ...chatTool("write").function, strict: true } },
    ],
  };
  renameAndCompleteTools(body, "chat", "2.x");
  const [read, write] = body.tools;
  assert.equal(read.function.name, "clint_read");
  assert.equal(read.function.strict, false, "an omitted strict is filled");
  assert.equal(write.function.name, "clint_write");
  assert.equal(write.function.strict, true, "a stated strict is kept");
  for (const tool of body.tools.slice(2)) {
    assert.equal(tool.function.strict, false, `${tool.function.name} carries strict:false`);
  }
  // 1.x does not write the field, so neither the host's tools nor the official
  // set grow one.
  const v1 = { model: "chat-free", tools: [chatTool("read")] };
  renameAndCompleteTools(v1, "chat", "1.x");
  assert.equal(Object.hasOwn(v1.tools[0].function, "strict"), false);
  for (const tool of v1.tools) assert.equal(Object.hasOwn(tool.function, "strict"), false);
});

test("a duplicate client definition reuses its first wire name", () => {
  const body = {
    model: "chat-free",
    tools: [chatTool("read", "first"), chatTool("read", "second")],
  };
  const renames = renameAndCompleteTools(body, "chat", "1.x");
  // Every declaration is kept, under the one name the model can call: the
  // second is the host's own problem to resolve, and a second spelling would
  // make the reply one the host never declared.
  assert.deepEqual(
    body.tools.slice(0, 2).map((tool) => tool.function.name),
    ["clint_read", "clint_read"],
  );
  assert.equal(renames.size, 1);
  assert.equal(renames.restore("clint_read"), "read");
});

test("a responses request renames client functions and leaves built-in tools untouched", () => {
  const body = {
    model: "responses-free",
    tools: [
      { type: "function", name: "lookup", description: "Look up.", parameters: { type: "object" } },
      { type: "custom", name: "apply_patch", description: "Apply a patch." },
      { type: "web_search_preview" },
    ],
    tool_choice: {
      type: "function",
      name: "lookup",
      allowed_tools: [{ type: "function", name: "lookup" }],
    },
    input: [
      { type: "function_call", name: "lookup", arguments: "{}", call_id: "call-1" },
      { type: "custom_tool_call", name: "apply_patch", input: "***", call_id: "call-2" },
      { type: "message", role: "user", content: "hi" },
    ],
  };
  const renames = renameAndCompleteTools(body, "responses", "1.x");

  assert.deepEqual(
    body.tools.slice(0, 3).map((tool) => tool.name),
    ["clint_lookup", "clint_apply_patch", undefined],
  );
  // The built-in tool has no client name and is not one of the host's
  // functions: renaming it would be inventing a tool the request did not send.
  assert.equal(body.tools[2].type, "web_search_preview");
  assert.deepEqual(
    body.tools.slice(3).map((tool) => tool.name),
    officialToolNames("1.x"),
  );
  assert.equal(body.tool_choice.name, "clint_lookup");
  assert.equal(body.tool_choice.allowed_tools[0].name, "clint_lookup");
  assert.equal(body.input[0].name, "clint_lookup");
  assert.equal(body.input[1].name, "clint_apply_patch");
  assert.equal(renames.restore("clint_lookup"), "lookup");
  assert.equal(renames.restore("clint_apply_patch"), "apply_patch");
});

test("an anthropic request renames client tools and leaves server tools untouched", () => {
  const body = {
    model: "messages-free",
    tools: [
      {
        name: "lookup",
        description: "Look up.",
        input_schema: { type: "object", properties: {} },
      },
      { type: "web_search_20250305", name: "web_search" },
    ],
    tool_choice: { type: "tool", name: "lookup" },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
      },
    ],
  };
  const renames = renameAndCompleteTools(body, "anthropic", "1.x");

  assert.deepEqual(
    body.tools.slice(0, 2).map((tool) => tool.name),
    ["clint_lookup", "web_search"],
  );
  assert.equal(body.tools[1].type, "web_search_20250305");
  assert.deepEqual(
    body.tools.slice(2).map((tool) => tool.name),
    officialToolNames("1.x"),
  );
  assert.equal(body.tool_choice.name, "clint_lookup");
  assert.equal(body.messages[0].content[1].name, "clint_lookup");
  // A tool result names the call, not the tool.
  assert.equal(body.messages[1].content[0].tool_use_id, "toolu_1");
  assert.equal(renames.restore("clint_lookup"), "lookup");
});

test("a tool set with nothing to rename still gets the official set", () => {
  const body = { model: "chat-free" };
  const renames = renameAndCompleteTools(body, "chat", "2.x");
  assert.deepEqual(
    body.tools.map((tool) => tool.function.name),
    officialToolNames("2.x"),
  );
  assert.equal(renames.empty, true);
  // Tools that are not objects are passed through rather than dropped: the
  // request said something, and this is not the layer that judges it.
  const mixed = { model: "chat-free", tools: [null, "junk", chatTool("read")] };
  renameAndCompleteTools(mixed, "chat", "1.x");
  assert.equal(mixed.tools[0], null);
  assert.equal(mixed.tools[1], "junk");
  assert.equal(mixed.tools[2].function.name, "clint_read");
});

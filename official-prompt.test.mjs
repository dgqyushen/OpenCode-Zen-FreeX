import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENCODE_PROMPT_MARKER,
  OPENCODE_PROMPT_MARKER_V2,
  carriesOfficialPrompt,
  injectOfficialPrompt,
  officialEnvironment,
  officialSystemPrompt,
  textFragments,
} from "./official-prompt.mjs";

// Every prompt carries this opening; a body that already holds it came from an
// OpenCode-shaped client and has to be left as it is.
const markerCount = (text) =>
  text.split(OPENCODE_PROMPT_MARKER).length - 1 + text.split(OPENCODE_PROMPT_MARKER_V2).length - 1;

test("the environment block names the model, directory, platform and UTC date", () => {
  const env = officialEnvironment("opencode/chat-free", {
    cwd: "/workspace/project",
    platform: "windows",
    gitRepository: false,
    now: new Date(Date.UTC(2026, 9, 5, 12, 0, 0)),
  });
  assert.equal(
    env,
    [
      "You are powered by the model named chat-free. The exact model ID is opencode/chat-free",
      "Here is some useful information about the environment you are running in:",
      "<env>",
      "  Working directory: /workspace/project",
      "  Workspace root folder: /workspace/project",
      "  Is directory a git repo: no",
      "  Platform: win32",
      "  Today's date: Mon Oct 05 2026",
      "</env>",
    ].join("\n"),
  );
  // The date is written with a padded day, as the CLI writes it, and the
  // platform name is the one Node reports rather than the name a host used.
  assert.match(env, /Mon Oct 05 2026/);
  const linux = officialEnvironment("opencode/read-free", {
    cwd: "/srv",
    platform: "linux",
    now: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
  });
  assert.match(linux, /Platform: linux/);
  assert.match(linux, /Thu Jan 01 2026/);
  // A platform the CLI has no special spelling for is passed through as-is.
  assert.match(officialEnvironment("m", { platform: "freebsd" }), /Platform: freebsd/);
});

test("a model id is reduced to the name and id the CLI states", () => {
  assert.match(officialEnvironment("opencode/muse-spark-1.3-free"), /model named muse-spark-1\.3-free/);
  assert.match(officialEnvironment("opencode/  chat-free  "), /named chat-free/);
  assert.match(officialEnvironment("  chat-free  "), /named chat-free/);
  // An empty or malformed name still has to produce a usable block: the exact
  // id is what the model is told it is, and "unknown" is at least truthful.
  assert.match(officialEnvironment("opencode/"), /model named unknown\. The exact model ID is opencode\/unknown/);
  assert.match(officialEnvironment(undefined), /model named unknown/);
  // The working directory falls back to a stable, platform-neutral path rather
  // than an empty field.
  assert.match(officialEnvironment("m", { cwd: "." }), /Working directory: \/workspace/);
  assert.match(officialEnvironment("m", { cwd: "" }), /Working directory: \/workspace/);
  assert.match(officialEnvironment("m"), /Is directory a git repo: yes/);
});

test("the 1.x prompt is the captured CLI text with the environment after it", () => {
  const prompt = officialSystemPrompt("1.x", "opencode/chat-free", {
    cwd: "/workspace",
    platform: "linux",
    gitRepository: true,
    now: new Date(Date.UTC(2026, 9, 25, 0, 0, 0)),
  });
  assert.ok(prompt.startsWith(OPENCODE_PROMPT_MARKER));
  assert.match(prompt, /You are powered by the model named chat-free/);
  assert.match(prompt, /Working directory: \/workspace/);
  assert.match(prompt, /Platform: linux/);
  assert.match(prompt, /Today's date: Sun Oct 25 2026/);
  assert.ok(prompt.endsWith("</env>"));
  // No skill is advertised: a host that is not OpenCode has none of OpenCode's
  // built-in skills, and the one 0.5.4 named was called by a model that read
  // the listing (2026-10-25, DeepSeek Harness: `skill "customize-opencode" is
  // unknown or no longer available`). The prompt ends where the proven shape
  // ends — opencode2api's deployed prompts carry no listing either.
  assert.doesNotMatch(prompt, /<available_skills>/);
  assert.doesNotMatch(prompt, /customize-opencode/);
  // The four names 1.x spells with capitals are present in the captured text.
  assert.match(prompt, /\bBash\b/);
  assert.match(prompt, /\bWebFetch\b/);
  assert.match(prompt, /\bTask\b/);
});

test("the 2.x prompt is the 2.1.4 capture with its model, date and environment filled in", () => {
  const v2 = officialSystemPrompt("2.x", "opencode/chat-free", {
    cwd: "/workspace",
    platform: "linux",
    gitRepository: true,
    now: new Date(Date.UTC(2026, 9, 25, 0, 0, 0)),
  });
  assert.ok(v2.startsWith(OPENCODE_PROMPT_MARKER_V2));
  // The 2.1 line rewrote the prompt as new prose, so it is its own capture:
  // the model section names the requested model, the date sits above the
  // environment block, and the block carries the CLI's temp-directory line.
  assert.match(v2, /# Your Model\n- Name: Chat Free\n- Provider ID: opencode\n- Model ID: chat-free/);
  assert.match(v2, /Today's date: Sun Oct 25 2026\n\nHere is some useful information/);
  assert.match(
    v2,
    /<env>\n  Working directory: \/workspace\n  Workspace root folder: \/workspace\n  Is directory a git repo: yes\n  Platform: linux\n  Prefer \S+opencode over generic system temporary directories/,
  );
  assert.ok(v2.endsWith("the session's working directory."));
  // No placeholder is left behind, and no skill is advertised (see the 1.x
  // test above for why the listing never ships).
  assert.doesNotMatch(v2, /\{\{[A-Z_]+\}\}/);
  assert.doesNotMatch(v2, /<available_skills>/);
  // A model with no opencode/ prefix and no name at all still fills the
  // section with something rather than an empty line.
  assert.match(officialSystemPrompt("2.x", "glm-5.3-flash-free"), /- Name: Glm 5\.3 Flash Free\n/);
  assert.match(officialSystemPrompt("2.x", ""), /- Model ID: unknown\n/);
  assert.throws(() => officialSystemPrompt("3.x", "m"), /no prompt for generation "3\.x"/);
});

test("text fragments are flattened out of strings, blocks and nested content", () => {
  assert.deepEqual(textFragments("a"), ["a"]);
  assert.deepEqual(textFragments(""), []);
  assert.deepEqual(textFragments(["a", ["b", "c"]]), ["a", "b", "c"]);
  assert.deepEqual(textFragments({ type: "text", text: "a" }), ["a"]);
  assert.deepEqual(textFragments({ content: [{ type: "text", text: "b" }] }), ["b"]);
  // A block that carries both keeps the text; a value with neither is not a
  // fragment at all.
  assert.deepEqual(textFragments({ text: "a", content: "b" }), ["a"]);
  assert.deepEqual(textFragments(7), []);
  assert.deepEqual(textFragments(null), []);
  assert.deepEqual(textFragments(undefined), []);
  assert.equal(carriesOfficialPrompt([{ type: "text", text: `x ${OPENCODE_PROMPT_MARKER}` }]), true);
  assert.equal(carriesOfficialPrompt({ content: ["part", OPENCODE_PROMPT_MARKER] }), true);
  assert.equal(carriesOfficialPrompt("You are opencode, but not the prompt"), false);
  assert.equal(carriesOfficialPrompt(undefined), false);
});

test("a chat body gets one leading system message and keeps its own instructions after it", () => {
  const body = {
    model: "opencode/chat-free",
    messages: [
      { role: "system", content: "First instruction" },
      { role: "user", content: "hi" },
      { role: "developer", content: "Second instruction" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ],
  };
  assert.equal(injectOfficialPrompt(body, "chat", "1.x"), true);
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ["system", "user", "assistant", "user"],
  );
  const system = body.messages[0].content;
  assert.ok(system.startsWith(OPENCODE_PROMPT_MARKER));
  assert.match(system, /model named chat-free\. The exact model ID is opencode\/chat-free/);
  assert.ok(system.endsWith("\n\nFirst instruction\nSecond instruction"));
  assert.equal(markerCount(system), 1);
  // The conversation itself is untouched, in the order it arrived.
  assert.deepEqual(body.messages.slice(1).map((message) => message.content), ["hi", "hello", "again"]);
});

test("a chat system message may be a list of blocks", () => {
  const body = {
    model: "opencode/chat-free",
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: " Keep me " },
          { type: "text", content: "And me" },
          { type: "text", text: "   " },
          { type: "image", source: {} },
        ],
      },
      { role: "user", content: "hi" },
    ],
  };
  assert.equal(injectOfficialPrompt(body, "chat", "1.x"), true);
  assert.ok(body.messages[0].content.endsWith("\n\nKeep me\nAnd me"));
  // A system value with no text at all still gets the official prompt, and the
  // empty message is not sent as an empty instruction.
  const blank = { model: "m", messages: [{ role: "system", content: "   " }, { role: "user", content: "hi" }] };
  assert.equal(injectOfficialPrompt(blank, "chat", "1.x"), true);
  assert.ok(blank.messages[0].content.endsWith("</system-reminder>"));
});

test("a chat body that already carries the prompt is not shaped twice", () => {
  const original = {
    role: "system",
    content: `${OPENCODE_PROMPT_MARKER} and the rest`,
  };
  const messages = [original, { role: "user", content: "hi" }];
  const body = { model: "chat-free", messages };
  assert.equal(injectOfficialPrompt(body, "chat", "1.x"), false);
  assert.equal(body.messages, messages, "the body is not replaced");
  assert.equal(body.messages[0], original, "the message is not replaced");
  assert.equal(markerCount(body.messages[0].content), 1);
  // A developer message is system text too, and the marker in one is enough.
  const developer = {
    model: "chat-free",
    messages: [{ role: "developer", content: [{ type: "text", text: OPENCODE_PROMPT_MARKER }] }],
  };
  assert.equal(injectOfficialPrompt(developer, "chat", "1.x"), false);
  assert.equal(developer.messages.length, 1);
});

test("a chat body without a message list is left alone", () => {
  const body = { model: "chat-free" };
  assert.equal(injectOfficialPrompt(body, "chat", "1.x"), false);
  assert.deepEqual(body, { model: "chat-free" });
  const notList = { model: "chat-free", messages: "hi" };
  assert.equal(injectOfficialPrompt(notList, "chat", "1.x"), false);
  assert.equal(notList.messages, "hi");
});

test("an anthropic body carries the prompt in its top-level system value", () => {
  const body = { model: "opencode/messages-free" };
  assert.equal(injectOfficialPrompt(body, "anthropic", "1.x"), true);
  assert.ok(body.system.startsWith(OPENCODE_PROMPT_MARKER));
  assert.match(body.system, /model named messages-free/);

  const string = { model: "m", system: "Be careful." };
  assert.equal(injectOfficialPrompt(string, "anthropic", "1.x"), true);
  assert.ok(string.system.startsWith(OPENCODE_PROMPT_MARKER));
  assert.ok(string.system.endsWith("\n\nBe careful."));

  const empty = { model: "m", system: "   " };
  assert.equal(injectOfficialPrompt(empty, "anthropic", "1.x"), true);
  assert.ok(empty.system.endsWith("</system-reminder>"));

  const block = {
    model: "m",
    system: [{ type: "text", text: "Be careful.", cache_control: { type: "ephemeral" } }],
  };
  assert.equal(injectOfficialPrompt(block, "anthropic", "1.x"), true);
  assert.equal(block.system[0].type, "text");
  assert.ok(block.system[0].text.startsWith(OPENCODE_PROMPT_MARKER));
  assert.match(block.system[0].text, /model named m\./);
  assert.equal(block.system[1].text, "Be careful.");
  assert.equal(block.system[1].cache_control.type, "ephemeral");

  const marked = { model: "m", system: [{ type: "text", text: `${OPENCODE_PROMPT_MARKER} already` }] };
  const held = marked.system;
  assert.equal(injectOfficialPrompt(marked, "anthropic", "1.x"), false);
  assert.equal(marked.system, held);
  assert.equal(markerCount(marked.system[0].text), 1);
});

test("a responses body carries the prompt in instructions", () => {
  const body = { model: "opencode/responses-free" };
  assert.equal(injectOfficialPrompt(body, "responses", "1.x"), true);
  assert.ok(body.instructions.startsWith(OPENCODE_PROMPT_MARKER));
  assert.match(body.instructions, /model named responses-free/);

  const given = { model: "m", instructions: "Answer briefly." };
  assert.equal(injectOfficialPrompt(given, "responses", "1.x"), true);
  assert.ok(given.instructions.startsWith(OPENCODE_PROMPT_MARKER));
  assert.ok(given.instructions.endsWith("\n\nAnswer briefly."));

  const empty = { model: "m", instructions: "" };
  assert.equal(injectOfficialPrompt(empty, "responses", "1.x"), true);
  assert.ok(empty.instructions.endsWith("</system-reminder>"));

  const marked = { model: "m", instructions: `${OPENCODE_PROMPT_MARKER} already` };
  assert.equal(injectOfficialPrompt(marked, "responses", "1.x"), false);
  assert.equal(marked.instructions, `${OPENCODE_PROMPT_MARKER} already`);
  assert.equal(markerCount(marked.instructions), 1);
});

test("a 2.x injection carries the 2.1.4 prompt and is not shaped twice", () => {
  const body = { model: "chat-free", messages: [{ role: "user", content: "hi" }] };
  assert.equal(injectOfficialPrompt(body, "chat", "2.x"), true);
  const system = body.messages[0].content;
  // The 2.1 line's prompt is new prose that names no function tool, so the
  // generation shows in the marker sentence, not in tool spellings.
  assert.ok(system.startsWith(OPENCODE_PROMPT_MARKER_V2));
  // Injecting it again finds the marker and leaves the body alone — and a
  // body carrying the 1.x marker is just as shaped, whatever lane it takes.
  assert.equal(injectOfficialPrompt(body, "chat", "2.x"), false);
  assert.equal(markerCount(body.messages[0].content), 1);
  const as1x = { model: "chat-free", messages: [{ role: "system", content: `${OPENCODE_PROMPT_MARKER} v1` }, { role: "user", content: "hi" }] };
  assert.equal(injectOfficialPrompt(as1x, "chat", "2.x"), false);
});

test("an unknown protocol or generation is named rather than guessed", () => {
  assert.equal(injectOfficialPrompt(null, "chat", "1.x"), false);
  assert.throws(() => injectOfficialPrompt({ model: "m" }, "grpc", "1.x"), /unknown protocol "grpc"/);
  assert.throws(
    () => injectOfficialPrompt({ model: "m", messages: [] }, "chat", "3.x"),
    /no prompt for generation "3\.x"/,
  );
});

test("the prompt is followed by the truth about which tools this host runs", () => {
  // The official prompt teaches Code Mode and the official set rides in the
  // tools array, so a model that believes its prompt calls `execute` first
  // (measured 2026-10-25 on DeepSeek Harness: execute, then shell, then it
  // found the clint_ names). The correction travels as a system-reminder, the
  // prompt's own convention for harness instruction, and it names the wire
  // names the model must actually call.
  const body = {
    model: "chat-free",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "clint_pwsh", description: "run", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "clint_search", description: "find", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "read", description: "official", parameters: { type: "object", properties: {} } } },
    ],
  };
  assert.equal(injectOfficialPrompt(body, "chat", "2.x"), true);
  const system = body.messages[0].content;
  const note = system.slice(system.lastIndexOf("<system-reminder>"));
  assert.ok(note.startsWith("<system-reminder>\nCode Mode is not active"));
  assert.match(note, /clint_pwsh, clint_search/);
  assert.doesNotMatch(note, /, read/);
  assert.ok(system.endsWith("</system-reminder>"));
  // The note sits between the official prompt and the host's own text, so the
  // model meets the correction before the host's instructions.
  const withOwn = {
    model: "chat-free",
    messages: [{ role: "system", content: "Host rule." }, { role: "user", content: "hi" }],
  };
  assert.equal(injectOfficialPrompt(withOwn, "chat", "2.x"), true);
  const text = withOwn.messages[0].content;
  // The prompt's own Harness section names `<system-reminder>` in prose, so
  // the note is found by its last occurrence, not its first.
  assert.ok(text.indexOf("the session's working directory.") < text.lastIndexOf("<system-reminder>"));
  assert.ok(text.lastIndexOf("</system-reminder>") < text.indexOf("Host rule."));
  // A host that declared nothing is told so, rather than being handed a list
  // of built-ins it cannot run.
  const bare = { model: "chat-free", messages: [{ role: "user", content: "hi" }] };
  injectOfficialPrompt(bare, "chat", "2.x");
  assert.match(bare.messages[0].content, /This host implements no tools at all/);
  // A body already carrying the official prompt is left alone, note and all.
  const marked = {
    model: "chat-free",
    messages: [{ role: "system", content: `${OPENCODE_PROMPT_MARKER_V2} v2` }, { role: "user", content: "hi" }],
  };
  assert.equal(injectOfficialPrompt(marked, "chat", "2.x"), false);
  assert.doesNotMatch(marked.messages[0].content, /Code Mode is not active/);
});

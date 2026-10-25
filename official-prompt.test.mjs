import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENCODE_PROMPT_MARKER,
  carriesOfficialPrompt,
  injectOfficialPrompt,
  officialEnvironment,
  officialSystemPrompt,
  textFragments,
} from "./official-prompt.mjs";

// Every prompt carries this opening; a body that already holds it came from an
// OpenCode-shaped client and has to be left as it is.
const markerCount = (text) => text.split(OPENCODE_PROMPT_MARKER).length - 1;

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

test("the 1.x prompt is the captured CLI text with the environment and skills after it", () => {
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
  assert.match(prompt, /<available_skills>/);
  assert.match(prompt, /<name>customize-opencode<\/name>/);
  assert.ok(prompt.endsWith("</available_skills>"));
  // The four names 1.x spells with capitals are present in the captured text.
  assert.match(prompt, /\bBash\b/);
  assert.match(prompt, /\bWebFetch\b/);
  assert.match(prompt, /\bTask\b/);
});

test("the 2.x prompt is the same text with the 2.x tool names", () => {
  const v1 = officialSystemPrompt("1.x", "opencode/chat-free");
  const v2 = officialSystemPrompt("2.x", "opencode/chat-free");
  assert.ok(v2.startsWith(OPENCODE_PROMPT_MARKER));
  // The prose is otherwise identical: only the base prompt's tool names
  // differ ("shell" is two characters longer than "Bash" twice, and "subagent"
  // four longer than "Task"). The environment and skill listing are the same
  // text in both.
  assert.equal(v2.length, v1.length + 6);
  const baseOf = (text) => text.slice(0, text.indexOf("You are powered by the model named"));
  const skillsOf = (text) => text.slice(text.indexOf("Skills provide specialized instructions"));
  assert.equal(
    baseOf(v2),
    baseOf(v1).replaceAll("WebFetch", "webfetch").replaceAll("Bash", "shell").replaceAll("Task", "subagent"),
  );
  assert.equal(skillsOf(v2), skillsOf(v1));
  assert.doesNotMatch(v2, /\bWebFetch\b/);
  assert.doesNotMatch(v2, /\bBash\b/);
  assert.doesNotMatch(v2, /\bTask\b/);
  assert.match(v2, /\bwebfetch\b/);
  assert.match(v2, /\bshell\b/);
  assert.match(v2, /\bsubagent\b/);
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
  assert.ok(blank.messages[0].content.endsWith("</available_skills>"));
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
  assert.ok(empty.system.endsWith("</available_skills>"));

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
  assert.ok(empty.instructions.endsWith("</available_skills>"));

  const marked = { model: "m", instructions: `${OPENCODE_PROMPT_MARKER} already` };
  assert.equal(injectOfficialPrompt(marked, "responses", "1.x"), false);
  assert.equal(marked.instructions, `${OPENCODE_PROMPT_MARKER} already`);
  assert.equal(markerCount(marked.instructions), 1);
});

test("the generation decides the prompt's own tool names", () => {
  const body = { model: "chat-free", messages: [{ role: "user", content: "hi" }] };
  assert.equal(injectOfficialPrompt(body, "chat", "2.x"), true);
  const system = body.messages[0].content;
  assert.doesNotMatch(system, /\bBash\b/);
  assert.match(system, /\bshell\b/);
  assert.match(system, /\bsubagent\b/);
  // Injecting it again finds the marker and leaves the body alone.
  assert.equal(injectOfficialPrompt(body, "chat", "2.x"), false);
  assert.equal(markerCount(body.messages[0].content), 1);
});

test("an unknown protocol or generation is named rather than guessed", () => {
  assert.equal(injectOfficialPrompt(null, "chat", "1.x"), false);
  assert.throws(() => injectOfficialPrompt({ model: "m" }, "grpc", "1.x"), /unknown protocol "grpc"/);
  assert.throws(
    () => injectOfficialPrompt({ model: "m", messages: [] }, "chat", "3.x"),
    /no prompt for generation "3\.x"/,
  );
});

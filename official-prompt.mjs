// The system prompt an OpenCode CLI session sends, and the protocol-aware
// injection that puts it in front of a host's own instructions.
//
// Zen's free tier accepts only agent-shaped traffic and checks the request
// against the CLI's prompt, so a request from any other host has to carry it.
// The base text is OpenCode 1.19.3's own (MIT), captured verbatim; the 2.x text
// is the same text with the four tool names that generation spells differently.
// The environment block names the requested model, the working directory, the
// platform and the UTC date.

import { readFileSync } from "node:fs";

const PROMPT = new URL("./opencode-prompt-v1.txt", import.meta.url);

// The sentence every copy of the prompt carries. A body that already holds it
// came from an OpenCode-shaped client and is left alone, so repeated shaping
// cannot duplicate the prompt.
export const OPENCODE_PROMPT_MARKER = "You are opencode, an interactive CLI tool";

function readPrompt() {
  try {
    return readFileSync(PROMPT, "utf8");
  } catch (error) {
    const reason =
      error.code === "ENOENT"
        ? "is missing"
        : `could not be read (${error.code ?? error.message})`;
    throw new Error(`official-prompt: the prompt at ${PROMPT.pathname} ${reason}`, {
      cause: error,
    });
  }
}

const V1 = readPrompt();

// The four differences between the 1.x and 2.x prompt are tool names. Keeping
// one file and deriving the other cannot let the two drift apart in prose.
const V2 = V1.replaceAll("WebFetch", "webfetch")
  .replaceAll("Bash", "shell")
  .replaceAll("Task", "subagent");

// No skill listing follows the environment block, though the CLI's own prompt
// carries one. A host that is not OpenCode has none of OpenCode's built-in
// skills: the listing 0.5.4 appended named `customize-opencode`, and a model
// that read it on 2026-10-25 called the official `skill` tool for that name
// twice — DeepSeek Harness answered `skill "customize-opencode" is unknown or
// no longer available`, because the skill does not exist outside OpenCode. The
// listing is not part of the shape Zen is known to read: opencode2api's
// field-deployed prompts end at `</env>` with no skills named. An advertised
// skill is a call waiting to happen, and there is no tool behind it here.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// The date the CLI writes: `Sun Oct 25 2026`, in UTC.
function utcDate(value) {
  return `${DAYS[value.getUTCDay()]} ${MONTHS[value.getUTCMonth()]} ${String(
    value.getUTCDate(),
  ).padStart(2, "0")} ${value.getUTCFullYear()}`;
}

// The <env> block. Options are for tests; a request uses the process's own
// directory and platform and the current UTC date.
export function officialEnvironment(model, options = {}) {
  const raw = options.cwd ?? process.cwd();
  const directory = typeof raw === "string" && raw && raw !== "." ? raw : "/workspace";
  const platform = options.platform ?? process.platform;
  const name = platform === "windows" ? "win32" : platform;
  const apiModel =
    typeof model === "string" && model.startsWith("opencode/")
      ? model.slice("opencode/".length).trim()
      : typeof model === "string"
        ? model.trim()
        : "";
  const named = apiModel || "unknown";
  const now = options.now instanceof Date ? options.now : new Date();
  return [
    `You are powered by the model named ${named}. The exact model ID is opencode/${named}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    `  Is directory a git repo: ${options.gitRepository === false ? "no" : "yes"}`,
    `  Platform: ${name}`,
    `  Today's date: ${utcDate(now)}`,
    "</env>",
  ].join("\n");
}

// The complete prompt for one generation.
export function officialSystemPrompt(generation, model, options = {}) {
  const base = generation === "1.x" ? V1 : generation === "2.x" ? V2 : undefined;
  if (base === undefined) {
    throw new Error(
      `official-prompt: no prompt for generation ${JSON.stringify(generation)}`,
    );
  }
  return `${base}${officialEnvironment(model, options)}`;
}

const isTable = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Flatten a system or instruction value into its text: a string, a list of
// content blocks, or a block carrying text or content.
export function textFragments(value) {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => textFragments(item));
  if (isTable(value)) {
    if (typeof value.text === "string") return textFragments(value.text);
    if (value.content !== undefined) return textFragments(value.content);
  }
  return [];
}

export function carriesOfficialPrompt(value) {
  return textFragments(value).some((part) => part.includes(OPENCODE_PROMPT_MARKER));
}

function injectChatPrompt(body, prompt) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  const kept = [];
  const instructions = [];
  for (const message of messages) {
    if (!isTable(message) || (message.role !== "system" && message.role !== "developer")) {
      kept.push(message);
      continue;
    }
    if (carriesOfficialPrompt(message.content)) return false;
    for (const part of textFragments(message.content)) {
      const text = part.trim();
      if (text) instructions.push(text);
    }
  }
  const system = instructions.length ? `${prompt}\n\n${instructions.join("\n")}` : prompt;
  body.messages = [{ role: "system", content: system }, ...kept];
  return true;
}

function injectAnthropicPrompt(body, prompt) {
  const system = body.system;
  if (system !== undefined && system !== null) {
    if (carriesOfficialPrompt(system)) return false;
    if (typeof system === "string") {
      body.system = system.trim() === "" ? prompt : `${prompt}\n\n${system}`;
      return true;
    }
    if (Array.isArray(system)) {
      body.system = [{ type: "text", text: prompt }, ...system];
      return true;
    }
  }
  body.system = prompt;
  return true;
}

function injectResponsesPrompt(body, prompt) {
  const instructions = body.instructions;
  if (instructions !== undefined && instructions !== null) {
    if (carriesOfficialPrompt(instructions)) return false;
    if (typeof instructions === "string") {
      body.instructions =
        instructions.trim() === "" ? prompt : `${prompt}\n\n${instructions}`;
      return true;
    }
  }
  body.instructions = prompt;
  return true;
}

// Put the official prompt in front of a shaped body. The protocol decides where
// its system text lives: Chat folds system and developer messages into one
// leading system message, Anthropic uses the top-level system value, and
// Responses uses instructions. A body that already carries the marker is left
// untouched and answers false.
export function injectOfficialPrompt(body, protocol, generation) {
  if (!isTable(body)) return false;
  const prompt = officialSystemPrompt(generation, body.model);
  if (protocol === "chat") return injectChatPrompt(body, prompt);
  if (protocol === "anthropic") return injectAnthropicPrompt(body, prompt);
  if (protocol === "responses") return injectResponsesPrompt(body, prompt);
  throw new Error(`official-prompt: unknown protocol ${JSON.stringify(protocol)}`);
}

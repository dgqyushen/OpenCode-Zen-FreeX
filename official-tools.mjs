// The complete tool set an OpenCode CLI session carries, and the reshaping a
// host's own tools need so a free-tier request reads as one.
//
// The definitions in official-tools.json are captured from OpenCode (MIT): the
// 1.x set from 1.19.3, the 2.x set from 2.1.1. They are data, not code, and are
// kept apart from fingerprint.json because a capture rewrites a profile entire
// (`{ agent, required, tools }`) and would drop a table stored there.
//
// Zen reads a request as agent-shaped partly by its tools. A host that is not
// OpenCode describes its tools in its own names and words, so the shape is
// rebuilt here: every named client tool becomes `clint_<name>` (sanitized and
// collision-free), the complete official set for the generation is appended,
// and every reference to a client tool in the body is renamed to match. The
// response path restores the names the host declared, so the host never sees
// the wire names it did not write.

import { readFileSync } from "node:fs";

const ASSET = new URL("./official-tools.json", import.meta.url);

const isTable = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readSets() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ASSET, "utf8"));
  } catch (error) {
    // A missing or broken asset is a packaging failure, not a request failure:
    // name the file and the reason rather than letting a JSON.parse error out
    // of whichever request happened to read it first.
    const reason =
      error.code === "ENOENT"
        ? "is missing"
        : error instanceof SyntaxError
          ? "is not valid JSON"
          : `could not be read (${error.code ?? error.message})`;
    throw new Error(`official-tools: the capture at ${ASSET.pathname} ${reason}`, {
      cause: error,
    });
  }
  if (!isTable(parsed) || !Object.keys(parsed).length) {
    throw new Error("official-tools: the capture holds no generations");
  }
  for (const [generation, set] of Object.entries(parsed)) {
    if (!isTable(set) || !Array.isArray(set.order) || !isTable(set.tools)) {
      throw new Error(
        `official-tools: the ${JSON.stringify(generation)} capture is not { order, tools }`,
      );
    }
    for (const name of set.order) {
      if (!isTable(set.tools[name])) {
        throw new Error(
          `official-tools: the ${JSON.stringify(generation)} capture orders ${JSON.stringify(name)} but does not describe it`,
        );
      }
    }
  }
  return parsed;
}

export const OFFICIAL_SETS = readSets();

function setFor(generation) {
  if (!Object.hasOwn(OFFICIAL_SETS, generation)) {
    throw new Error(
      `official-tools: no official set for generation ${JSON.stringify(generation)}; the capture holds ${Object.keys(
        OFFICIAL_SETS,
      ).join(", ")}`,
    );
  }
  return OFFICIAL_SETS[generation];
}

// The names of the official set, in the order the capture holds them. Order is
// not validated upstream, but keeping it makes the wire body stable.
export function officialToolNames(generation) {
  return [...setFor(generation).order];
}

// The 2.x client describes the shell it actually has, so a Windows host says
// powershell where a Unix host says bash. The 1.x bash definition states the
// same fact inline. A description without the sentence is left as it is.
const WINDOWS = process.platform === "win32";

function platformDescription(generation, name, description) {
  if (!WINDOWS) return description;
  if (generation === "1.x" && name === "bash") {
    return description.replace("OS: linux, Shell: bash", "OS: windows, Shell: powershell");
  }
  if (generation === "2.x" && name === "shell") {
    return description.replace("on Linux using bash", "on Windows using powershell");
  }
  return description;
}

// One official tool in the protocol's wire shape. The 2.x Chat shape marks
// every function strict:false, as the captured client does; the 1.x entries
// carry no strict field and are rendered without one.
export function officialTool(protocol, name, generation) {
  const set = setFor(generation);
  if (!Object.hasOwn(set.tools, name)) {
    throw new Error(
      `official-tools: the ${JSON.stringify(generation)} capture does not describe ${JSON.stringify(name)}`,
    );
  }
  const definition = set.tools[name];
  const description = platformDescription(generation, name, definition.description);
  const parameters = definition.parameters;
  if (protocol === "chat") {
    const fn = { name, description, parameters };
    if (generation === "2.x") fn.strict = false;
    return { type: "function", function: fn };
  }
  if (protocol === "anthropic") {
    return { name, description, input_schema: parameters };
  }
  if (protocol === "responses") {
    return { type: "function", name, description, parameters };
  }
  throw new Error(`official-tools: unknown protocol ${JSON.stringify(protocol)}`);
}

export function officialToolset(protocol, generation) {
  return officialToolNames(generation).map((name) => officialTool(protocol, name, generation));
}

// The prefix every client tool carries on the way out. It keeps client tools
// distinct from the official set and gives the response path a name to restore.
export const CLIENT_TOOL_PREFIX = "clint_";
export const TOOL_NAME_LIMIT = 64;

// Reduce a client name to the character set the upstreams accept, collapsing
// every invalid run into one underscore and trimming separators from the ends.
export function sanitizeToolName(name) {
  return String(name ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "");
}

// Build the wire name for one client tool, keeping it within the 64-byte limit
// and away from every name already used by this request. An empty sanitized
// name becomes "tool"; a collision gets a _2, _3, ... suffix.
export function clientToolWireName(name, used = new Set()) {
  const max = TOOL_NAME_LIMIT - CLIENT_TOOL_PREFIX.length;
  let clean = sanitizeToolName(name) || "tool";
  if (clean.length > max) clean = clean.slice(0, max);
  const base = CLIENT_TOOL_PREFIX + clean;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const tag = `_${suffix}`;
    const cut = Math.min(base.length, TOOL_NAME_LIMIT - tag.length);
    const candidate = base.slice(0, cut) + tag;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

// The renames of one request, in both directions. A pair is recorded once; a
// duplicate client name reuses its first wire name, so every reference to it
// points at the one tool that was sent.
export class ToolRenames {
  constructor() {
    this.clientToWire = new Map();
    this.wireToClient = new Map();
  }

  get size() {
    return this.clientToWire.size;
  }

  get empty() {
    return this.clientToWire.size === 0;
  }

  add(client, wire) {
    if (typeof client !== "string" || !client) return;
    if (typeof wire !== "string" || !wire || wire === client) return;
    if (this.clientToWire.has(client) || this.wireToClient.has(wire)) return;
    this.clientToWire.set(client, wire);
    this.wireToClient.set(wire, client);
  }

  wire(client) {
    return typeof client === "string" ? this.clientToWire.get(client) : undefined;
  }

  // The name the client declared for a wire name. An exact mapping is the rule;
  // a prefix-only name is recovered by stripping it, which is what a stream
  // that outlived a reconfiguration needs. A name without the prefix is
  // returned as it came.
  restore(name) {
    if (typeof name !== "string" || !name) return name;
    const client = this.wireToClient.get(name);
    if (client !== undefined) return client;
    if (name.startsWith(CLIENT_TOOL_PREFIX)) {
      const rest = name.slice(CLIENT_TOOL_PREFIX.length);
      if (rest) return rest;
    }
    return name;
  }
}

// The client name of one tool definition, or undefined for a tool that is not a
// named client function: Responses built-in tools and Anthropic server tools
// carry a type of their own and are left untouched.
function clientNameOf(protocol, tool) {
  if (!isTable(tool)) return undefined;
  if (protocol === "chat") {
    const name = tool.function?.name ?? tool.name;
    return typeof name === "string" && name ? name : undefined;
  }
  if (protocol === "responses") {
    if (tool.type !== undefined && tool.type !== "function" && tool.type !== "custom")
      return undefined;
    const name = tool.name ?? tool.function?.name;
    return typeof name === "string" && name ? name : undefined;
  }
  if (protocol === "anthropic") {
    if (tool.type !== undefined && tool.type !== "custom") return undefined;
    const name = tool.name ?? tool.function?.name;
    return typeof name === "string" && name ? name : undefined;
  }
  throw new Error(`official-tools: unknown protocol ${JSON.stringify(protocol)}`);
}

function setToolName(protocol, tool, name) {
  if (protocol === "chat") {
    if (isTable(tool.function)) tool.function.name = name;
    else tool.name = name;
    return;
  }
  if (tool.name !== undefined || !isTable(tool.function)) tool.name = name;
  else tool.function.name = name;
}

function renameNamed(container, renames) {
  if (!isTable(container)) return;
  const wire = renames.wire(container.name);
  if (wire !== undefined) container.name = wire;
}

// Every outbound reference to a client tool has to name the wire spelling, or
// the request contradicts itself: a named tool_choice, the legacy function_call,
// and the tool-call history each protocol keeps. String choices ("auto",
// "required", "none") carry no name and are left alone.
function rewriteToolReferences(body, protocol, renames) {
  if (renames.empty) return;
  if (protocol === "chat") {
    const choice = body.tool_choice;
    if (isTable(choice)) {
      if (isTable(choice.function)) renameNamed(choice.function, renames);
      else renameNamed(choice, renames);
    }
    if (isTable(body.function_call)) renameNamed(body.function_call, renames);
    if (Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (!isTable(message)) continue;
        if (isTable(message.function_call)) renameNamed(message.function_call, renames);
        if (!Array.isArray(message.tool_calls)) continue;
        for (const call of message.tool_calls) {
          if (isTable(call) && isTable(call.function)) renameNamed(call.function, renames);
        }
      }
    }
    return;
  }
  if (protocol === "responses") {
    if (isTable(body.tool_choice)) {
      renameNamed(body.tool_choice, renames);
      if (Array.isArray(body.tool_choice.allowed_tools)) {
        for (const entry of body.tool_choice.allowed_tools) renameNamed(entry, renames);
      }
    }
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (!isTable(item)) continue;
        if (item.type === "function_call" || item.type === "custom_tool_call")
          renameNamed(item, renames);
      }
    }
    return;
  }
  // Anthropic
  if (isTable(body.tool_choice)) renameNamed(body.tool_choice, renames);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isTable(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (isTable(block) && block.type === "tool_use") renameNamed(block, renames);
      }
    }
  }
}

// Rewrite the tool list in place so it reads as an official CLI session:
// rename every named client tool, append the full official set, and keep every
// reference in the body consistent with the rename. `body.tools` must already
// be an array; normalizeTools is the owner of that rule.
export function renameAndCompleteTools(body, protocol, generation) {
  const renames = new ToolRenames();
  const used = new Set();
  const shaped = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const client = clientNameOf(protocol, tool);
    if (client === undefined) {
      shaped.push(tool);
      continue;
    }
    let wire = renames.wire(client);
    if (wire === undefined) {
      wire = clientToolWireName(client, used);
      renames.add(client, wire);
    }
    if (wire !== client) setToolName(protocol, tool, wire);
    // The 2.x client writes strict:false on every tool; a client that stated a
    // value has stated one, and only an omitted field is filled.
    if (
      generation === "2.x" &&
      protocol === "chat" &&
      isTable(tool.function) &&
      tool.function.strict === undefined
    ) {
      tool.function.strict = false;
    }
    shaped.push(tool);
  }
  shaped.push(...officialToolset(protocol, generation));
  body.tools = shaped;
  rewriteToolReferences(body, protocol, renames);
  return renames;
}

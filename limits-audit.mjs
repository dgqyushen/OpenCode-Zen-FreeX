// Asks the route which free models it still offers, groups them by the upstream
// model serving them, and says which look under-declared.
//
//   bun run limits:audit
//
// Why this exists. Zen's catalogue is where this plugin declares limits from,
// and two of the ids it publishes were declared far below what the model does:
// `deepseek-v4.1-flash-free` at 200000/32000 against 1048576/384000, and
// `mimo-v2.6-flash-free` at 200000/32000 against 1048576/131072. Both were found
// by hand, one id at a time. What makes them findable without reading every id
// by eye is that the route answers `x-opencode-upstream-model-id` on every
// request: two ids naming one upstream model are one capability, so a
// declaration that differs inside such a group is the question worth asking.
//
// What this does not do: measure a window, or write anything. A window costs a
// prompt of about a million tokens — minutes and megabytes — and belongs to the
// one id a signal has already pointed at; the numbers live in limits.mjs and are
// put there by a measurement, never by a script. What this does ask is cheap:
// one request of `max_tokens: 1000000` per offered id, stopped as soon as it
// starts writing. An upstream that validates the ceiling refuses and names its
// own; one that does not just begins to answer and is cut off after the first
// chunk. Either way the cost is a handful of tokens, and a 410 or a 400 for a
// model that is gone is visible in the same request.
//
// The offered set is the listing's, not the catalogue's: Zen's /v1/models
// carries 10 of the 40 free ids the catalogue still describes, and a plugin
// only ever offers what the listing has. Auditing the other 30 reports a page
// of `Model is unavailable` about models nobody can pick.
//
// What is reported, per offered id: the upstream model and the ids sharing it,
// the ceiling a refusal named, the window a refusal named, and the status. The
// candidates at the end are the reason to run it.
//
// Exit code is 0 when at least one offered id answered, 1 when none did: being
// unable to ask is not a finding about limits.

import { PROFILES } from "./core-tools.mjs";
import { LIMITS, limitOverrides, namedContextWindow, namedOutputCap } from "./limits.mjs";
import { CATALOG, DEFAULT_BASE } from "./provider.mjs";
import { chatRequest } from "./tools-smoke.mjs";

const BASE = process.env.ZEN_BASE_URL ?? DEFAULT_BASE;
const CATALOG_URL = process.env.ZEN_CATALOG_URL ?? CATALOG;
const GENERATION = process.env.ZEN_GENERATION ?? "1.x";
const READ_BUDGET = 4096;
const ASKED_CEILING = 1_000_000;

// The ids the plugin would offer: the listing's, kept where the catalogue calls
// them free. Exported for the tests.
export function offeredIds(listing, catalog) {
  return listing.filter((id) => {
    const model = catalog?.[id];
    if (!model) return false;
    return /free/i.test(id) || (model.cost?.input === 0 && model.cost?.output === 0);
  });
}

// Offered ids by the upstream model serving them, which is the route's own
// answer and not a guess from the id's shape.
export function groupByUpstream(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.upstream) continue;
    groups.set(row.upstream, [...(groups.get(row.upstream) ?? []), row]);
  }
  return groups;
}

// What is worth a measurement, in the order it should be read. `covered` are the
// ids limits.mjs already carries evidence for, which are said once and not
// raised again. Exported for the tests.
export function findings(rows, covered = new Set()) {
  const out = [];
  for (const row of rows) {
    const declared = row.declared ?? {};
    // An id limits.mjs already carries evidence for is not asked for again: its
    // numbers are in the table and repeating them here would bury what is new.
    // Its status is still printed in the table above, so a model that dies is
    // not hidden by this — only its numbers stop being a question.
    if (covered.has(row.id)) continue;
    if (row.ceiling !== undefined && row.ceiling !== declared.output)
      out.push(
        `${row.id}: the route names a ceiling of ${row.ceiling} completion tokens, the catalogue declares ${declared.output ?? "none"}`,
      );
    if (row.window !== undefined && row.window !== declared.context)
      out.push(
        `${row.id}: a refusal named a window of ${row.window}, the catalogue declares ${declared.context ?? "none"}`,
      );
    const named = row.ceiling !== undefined || row.window !== undefined;
    if (row.status !== 200 && !named) {
      // A 400 this audit provoked by asking for too much is the audit working,
      // not a finding, and neither is a refusal a number was just read out of.
      // What is left is worth reading: a 410, a 400 that named nothing, and a
      // model that does not speak the shape asked with.
      const protocol = /protocol|format/i.test(row.says ?? "");
      out.push(
        `${row.id}: HTTP ${row.status}${protocol ? " (does not speak the chat shape this audit asks with)" : ""}${row.says ? ` — ${row.says}` : ""}`,
      );
    }
  }
  for (const [upstream, list] of groupByUpstream(rows)) {
    const largest = (axis) => Math.max(...list.map((row) => row.declared?.[axis] ?? 0));
    if (list.length < 2) continue;
    if (new Set(list.map((row) => `${row.declared?.context}/${row.declared?.output}`)).size < 2) continue;
    for (const row of list) {
      if (covered.has(row.id)) continue;
      if ((row.declared?.context ?? 0) >= largest("context") && (row.declared?.output ?? 0) >= largest("output"))
        continue;
      const siblings = list
        .filter((other) => other.id !== row.id)
        .map((other) => `${other.id} (${other.declared?.context}/${other.declared?.output})`)
        .join(", ");
      out.push(
        `${row.id}: declared ${row.declared?.context}/${row.declared?.output}, and ${upstream} is also served as ${siblings}`,
      );
    }
  }
  return out;
}

function says(text) {
  const match = text.match(/"(?:message|param)"\s*:\s*"([^"]{0,160})"/);
  if (match) return match[1];
  // Some upstreams refuse in words that are not under a `message` key at all,
  // and a refusal nobody can read is not a finding.
  const flat = text.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 160) : "";
}

async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

// One cheap question per id. The ceiling asked for is past anything this route
// serves, so an upstream that validates it says what it allows, and the stream
// is dropped as soon as it starts rather than paying for an answer nobody reads.
async function ask(id, names) {
  const { headers, body } = chatRequest({
    model: id,
    generation: GENERATION,
    profile: PROFILES[GENERATION],
    names,
    maxTokens: ASKED_CEILING,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let text = "";
    if (response.ok) {
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (text.length < READ_BUDGET) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      }
    } else {
      text = (await response.text()).slice(0, READ_BUDGET);
    }
    const upstream = response.headers.get("x-opencode-upstream-model-id") ?? undefined;
    const endpoint = response.headers.get("x-opencode-endpoint-id") ?? undefined;
    return {
      status: response.status,
      upstream,
      endpoint,
      window: namedContextWindow(text),
      ceiling: namedOutputCap(text),
      says: response.ok ? "" : says(text),
    };
  } catch (error) {
    return { status: 0, says: error.message, upstream: undefined, endpoint: undefined };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Only a run asks the route. The tests import the helpers above and must not
// reach the network.
if (import.meta.main) {
  const names = [...PROFILES[GENERATION].required];
  const [listing, catalog] = await Promise.all([getJSON(`${BASE}/models`), getJSON(CATALOG_URL)]);
  const models = catalog?.opencode?.models ?? {};
  const ids = offeredIds(
    (Array.isArray(listing?.data) ? listing.data : []).map((entry) => entry?.id).filter(Boolean),
    models,
  );
  const free = Object.keys(models).filter(
    (id) => /free/i.test(id) || (models[id].cost?.input === 0 && models[id].cost?.output === 0),
  );
  console.log(`limits audit — ${BASE}`);
  console.log(`${ids.length} free ids are offered; the catalogue still describes ${free.length}\n`);

  const rows = [];
  for (const id of ids) {
    const answer = await ask(id, names);
    const declared = models[id]?.limit ?? {};
    rows.push({ id, declared, ...answer });
    // What the plugin declares is the catalogue's limit with limits.mjs over it,
    // so that is what is printed; the catalogue's own pair is shown beside it
    // when the two differ, since that is the under-report being answered.
    const effective = { ...declared, ...limitOverrides(id, declared) };
    const moved =
      effective.context !== declared.context || effective.output !== declared.output;
    const mark = answer.status === 200 ? "  " : "! ";
    console.log(
      `${mark}${id.padEnd(34)} ${`${effective.context}/${effective.output}`.padStart(17)}` +
        `${moved ? `  (catalogue ${declared.context}/${declared.output})` : ""}  ${answer.status}` +
        `${answer.upstream ? `  ${answer.upstream}${answer.endpoint ? ` via ${answer.endpoint}` : ""}` : ""}` +
        `${answer.ceiling !== undefined ? `  ceiling=${answer.ceiling}` : ""}${answer.window !== undefined ? `  window=${answer.window}` : ""}` +
        `${answer.says ? `  — ${answer.says}` : ""}`,
    );
  }

  const answered = rows.filter((row) => row.status === 200);
  const candidates = findings(rows, new Set(Object.keys(LIMITS)));
  console.log(`\nlimits.mjs already carries evidence for: ${Object.keys(LIMITS).join(", ")}`);
  console.log(`\n${candidates.length} candidate${candidates.length === 1 ? "" : "s"}:`);
  for (const line of candidates) console.log(`  ${line}`);
  if (!candidates.length) console.log("  none — every offered id is either measured or declared at what the route states");

  if (!answered.length) {
    console.log(
      "\nNothing answered, so this says nothing about limits. Check the network or ZEN_BASE_URL and ask again.",
    );
    process.exitCode = 1;
  }
}

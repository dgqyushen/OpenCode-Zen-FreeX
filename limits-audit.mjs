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
// one request of `max_tokens: 1000000` per offered id that speaks the chat
// shape, stopped as soon as it starts writing. An upstream that validates the
// ceiling refuses and names its own; one that does not just begins to answer and
// is cut off after the first chunk. Either way the cost is a handful of tokens,
// and a 410 or a 400 for a model that is gone is visible in the same request.
// An id the snapshot places on another protocol is listed and not asked, and an
// id that answers by naming another shape is listed as asked and refused for it:
// the two are different facts and are said as two lines.
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

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILES, profileFor } from "./core-tools.mjs";
import { LIMITS, limitOverrides, namedAxes, readBoundedText } from "./limits.mjs";
import { SDK, bootstrapProtocols, isFree } from "./models.mjs";
import { CATALOG, DEFAULT_BASE } from "./provider.mjs";
import { chatRequest } from "./tools-smoke.mjs";

// The route's own base, without the trailing slash a deployment's `ZEN_BASE_URL`
// often carries. Every URL below is that base plus a path, and a base left with
// its slash makes `//models` and `//chat/completions`: some routes treat the
// doubled slash as a different path or answer it themselves, and the failure
// reads as "the route or the catalogue could not be read … check the network"
// about a variable the operator set by hand. This is provider.mjs's own rule for
// its three URLs (`httpURL`, `url.href.replace(/\/+$/, "")`) stated here,
// because the audit reads its base from the environment at module load and does
// not go through the server to get at it. Exported so the rule can be asked
// about directly: a constant would only show the answer for one spelling.
export function baseFrom(value) {
  // An empty string is a variable that names no base: `ZEN_BASE_URL=` in a
  // profile exports one, and `??` reads it as set, so the base became the empty
  // string and every URL below it a relative path (`/models`) — a request to no
  // host at all, reported as "the route or the catalogue could not be read …
  // check the network" about a variable that was wrong before it was used.
  // Whitespace names no base either, for the same reason.
  const text = value === undefined || value === null ? DEFAULT_BASE : String(value);
  return (text.trim() === "" ? DEFAULT_BASE : text).replace(/\/+$/, "");
}

const BASE = baseFrom(process.env.ZEN_BASE_URL);
const CATALOG_URL = process.env.ZEN_CATALOG_URL ?? CATALOG;
const GENERATION = process.env.ZEN_GENERATION ?? "1.x";
// How many characters of a response body the audit reads. The reader is
// limits.mjs's `readBoundedText`: the unit rule, the deadline and the release of
// the rest of the body are all its, and only the budget is this file's. Exported
// because it is the number the tests' fixtures are built around — a fixture
// pinned to a literal here goes on passing, and goes on meaning nothing, the
// moment this constant moves.
export const READ_BUDGET = 4096;
const ASKED_CEILING = 1_000_000;
// How many ids are asked at once. Each ask stops as soon as the answer starts,
// so the connection and the upstream load stay modest while the 45 s abort of
// one id no longer holds up every id behind it.
const POOL = 4;

// An own-property read of a table this module did not build: the protocol
// snapshot, and the catalogue's own rows. `table[id]` otherwise answers out of
// Object.prototype for an id named `toString`, `valueOf`, `constructor` or
// `__proto__` — and an id the plugin offers, whose name is the only thing making
// it free, can be named exactly that. Every such read is wrong in the same way:
// as a protocol this plugin has no SDK for (so the id was dropped from the audit
// with no line saying so), as a snapshot entry saying the id is not asked at the
// chat shape, and as a catalogue description nobody wrote. models.mjs's
// `protocolFor`, limits.mjs's `limitOverrides` and provider.mjs's `catalogueRow`
// each state this rule for the tables they read; these are this file's reads of
// other modules' tables.
function ownIn(table, id) {
  return table && Object.hasOwn(table, id) ? table[id] : undefined;
}

// The ids the plugin would offer: the listing's, kept where the catalogue calls
// them free — or, for an id neither the catalogue nor the docs describe, where
// the id names itself free and nothing else names its protocol, which is what
// models.mjs offers on its own say-so. An id the snapshot already calls
// something this plugin has no SDK for is not offered by anyone: `jev-1.13-free`
// is SystemOne, and stays out here for the same reason buildModels leaves it out.
// "Free" is models.mjs's own answer, retirement included, so the audited set and
// the offered set cannot drift apart — and for an undescribed id that answer is
// `isFree` with no description at all, which is the same `/i` rule buildModels
// falls back on. Spelled `/-free$/` here it was case-sensitive, and an id like
// `Foo-Free` — which the plugin does offer — was audited by nobody: a name the
// audit does not read is a model this tool silently stops speaking for.
// Exported for the tests.
export function offeredIds(listing, catalog, snapshot = bootstrapProtocols) {
  return listing.filter((id) => {
    const protocol = ownIn(snapshot, id);
    if (protocol !== undefined && !Object.hasOwn(SDK, protocol)) return false;
    const model = ownIn(catalog, id);
    if (!model) return isFree(id);
    return isFree(id, model);
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

// A row as `run` builds it: the catalogue's own pair under `declared`, which is
// what the "catalogue says …" note prints, and the pair the plugin really puts on
// the wire under `effective` — the catalogue's with limits.mjs over it. The two
// are the same for every id with no evidence against it, which is most of them.
export function withEffective(row, table = LIMITS) {
  const declared = row.declared ?? {};
  return { ...row, effective: { ...declared, ...limitOverrides(row.id, declared, table) } };
}

// The pair the sibling comparison below is made against: what the plugin
// declares, not what the catalogue lists under it. Reading `declared` there
// while the table printed `effective` is how a sibling the plugin declares far
// below the numbers the evidence already carries was never raised, and how a
// line could contradict the table above it. The two lines that name the
// catalogue read `row.declared` instead — they are about the catalogue's own
// number, and reading this pair there attributed limits.mjs's override to the
// catalogue.
const judgement = (row) => row.effective ?? row.declared ?? {};

// What is worth a measurement, in the order it should be read. `covered` are the
// ids limits.mjs already carries evidence for, which are said once and not
// raised again. Exported for the tests.
export function findings(rows, covered = new Set()) {
  const out = [];
  for (const row of rows) {
    // The catalogue's own pair, because that is what these two lines say. Every
    // row `run` builds also carries `effective` — the same pair with limits.mjs's
    // overrides over it — and `judgement` is that one, which belongs to the
    // sibling comparison below, where the numbers the plugin puts on the wire are
    // the point. Here they are not: an id the table does not cover would have had
    // the plugin's own number printed as the catalogue's.
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
    // A model that does not speak the shape this audit asks with is not a limits
    // finding and must not sit in this list for ever: it is said once, beside the
    // ids that were not asked at all.
    if (protocolScoped(row)) continue;
    if (row.status !== 200 && row.status !== 0 && !named) {
      // What is left is worth reading: a 410, and a 400 that named nothing. A 0
      // is a question that was never answered — timeout, DNS, a closed socket —
      // and the audit's own rule is that being unable to ask is not a finding
      // about limits, so the id, its status and its message stay in the table.
      out.push(`${row.id}: HTTP ${row.status}${row.says ? ` — ${row.says}` : ""}`);
    }
  }
  for (const [upstream, list] of groupByUpstream(rows)) {
    // Only the rows this audit could speak for take part, in the comparison and
    // in what is printed beside it. A row refused for its shape still carries
    // `x-opencode-upstream-model-id`, but it was asked the chat shape and said
    // no, so its catalogue pair is the free id's declaration rather than
    // anything the route confirmed: a sibling measured against it is picked up
    // as an under-declaration candidate off a row that was never really asked,
    // while run() lists that same id as refused. `covered` rows stay in — those
    // were asked, and their numbers are already in the table.
    const spoke = list.filter((row) => !protocolScoped(row));
    if (spoke.length < 2) continue;
    const pair = (row) => judgement(row);
    if (new Set(spoke.map((row) => `${pair(row).context}/${pair(row).output}`)).size < 2) continue;
    const largest = (axis) => Math.max(...spoke.map((row) => pair(row)[axis] ?? 0));
    for (const row of spoke) {
      if (covered.has(row.id)) continue;
      if ((pair(row).context ?? 0) >= largest("context") && (pair(row).output ?? 0) >= largest("output"))
        continue;
      const siblings = spoke
        .filter((other) => other.id !== row.id)
        .map((other) => `${other.id} (${pair(other).context}/${pair(other).output})`)
        .join(", ");
      out.push(`${row.id}: declared ${pair(row).context}/${pair(row).output}, and ${upstream} is also served as ${siblings}`);
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

// A refusal that names the protocol rather than a limit. This audit asks the
// chat shape, so a model that speaks Responses or Messages answers by saying so;
// that is the host's business, not a limit to measure. What counts is a shape
// word tied to protocol or endpoint wording, because the words on their own are
// ordinary parts of an ordinary refusal: `protocol` itself, an endpoint path
// such as `/v1/messages`, a pairing like `messages api` or `responses endpoint`,
// or `anthropic` beside a protocol or endpoint noun. "messages: at least one
// message is required" and "too many messages in the request" are 400s about the
// request's own content — questions this audit asked and was refused — and a
// candidate list that dropped them would be the silent false negative the list
// exists to avoid. `format` is deliberately not a shape word here: `invalid
// request format` is how an ordinary refusal is worded and belongs in the
// candidate list, not beside the ids that were never asked.
const OTHER_SHAPE =
  /\bprotocol\b|\/(?:v\d+\/)?(?:messages|responses)\b|\b(?:messages|responses)\s+(?:api|protocol|endpoint)s?\b|\banthropic\s+(?:protocol|endpoint|messages)\b/i;

export function protocolScoped(row) {
  return OTHER_SHAPE.test(row?.says ?? "");
}

async function getJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

// One cheap question per id. The ceiling asked for is past anything this route
// serves, so an upstream that validates it says what it allows, and the stream
// is dropped as soon as it starts rather than paying for an answer nobody reads.
// Exported so a test can hand it a broken request without asking the route: a
// request that cannot be built is answered before anything is sent.
export async function ask(id, names) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    // Built inside the guard, because building it is the one thing here that can
    // throw on its own: a name in `required` with no entry in that profile's
    // `tools` raises before a request exists. Outside the guard that threw out of
    // the whole `Promise.all` batch, so the audit asked nothing at all and the
    // entry point reported "unable to ask … check the network" — a broken
    // fingerprint read as an apparent transport failure, with every id's own
    // status-0 row skipped. tools-smoke.mjs guards this same case the same way.
    //
    // The profile is read through core-tools' own accessor, not `PROFILES[…]`:
    // the accessor is the one place that says which generations the capture
    // holds, and a generation it does not carry is named in the message instead
    // of failing as `.required` of a function or of nothing.
    const { headers, body } = chatRequest({
      model: id,
      generation: GENERATION,
      profile: profileFor(GENERATION),
      names,
      maxTokens: ASKED_CEILING,
    });
    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // A refusal is read for the limits it names; a 200 is the model's own prose,
    // which is not a limit, so it is read only far enough to stop the answer and
    // then dropped by the reader rather than left to the abort in `finally`.
    //
    // The read is limits.mjs's, which is the one place in this tree that knows
    // the budget is a character budget, that a body can stall as well as be
    // large, and that a caller has to be told when the read stopped short. It is
    // handed the request's own cancellation, so a host that gave up is not
    // waited on, and it also carries its own 3 s deadline for the body alone.
    const { text, over } = await readBoundedText(response, READ_BUDGET, { signal: controller.signal });
    const upstream = response.headers.get("x-opencode-upstream-model-id") ?? undefined;
    const endpoint = response.headers.get("x-opencode-endpoint-id") ?? undefined;
    // limits.mjs reads refusals, and a refusal is the only place this route
    // states a limit. The body of a 200 is the model's own prose, which an
    // answer about token limits — or one that merely mentions them — would turn
    // into a ceiling nobody stated, and a `named` row then skips its status line
    // in findings() as well.
    //
    // The two axes come from limits.mjs's cut-aware reader, with the read's own
    // `over` as the cut flag: a refusal can be longer than the budget, and a
    // number whose digits land on the last character read may have had digits
    // past it. Those rows are the documented source for hand-editing LIMITS, so
    // a ceiling read a digit short (262144 as 26214) would be written into the
    // table as a measurement nobody made. `over` is the reader's own answer to
    // whether it stopped before the body did — not the length of what it read,
    // which a body landing exactly on the budget makes look the same.
    const axes = response.ok ? {} : namedAxes(text, READ_BUDGET, over);
    return {
      status: response.status,
      upstream,
      endpoint,
      window: axes.context,
      ceiling: axes.output,
      says: response.ok ? "" : says(text),
    };
  } catch (error) {
    return { status: 0, says: error.message, upstream: undefined, endpoint: undefined };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// What is said when the run/import question has no answer. Exported so a test
// can pin the sentence and an importer can recognise it.
export const UNDETERMINED_ENTRY =
  "Could not tell whether this file was run or imported, so nothing was asked: neither import.meta.main nor process.argv[1] named an entry point. Run it with `bun run limits:audit`.";

// Whether this module is the file that was run rather than one the tests
// import. `import.meta.main` is the direct answer and the one Bun gives, but it
// arrived in Node 22.18 and nothing before that has it — and an audit that cannot
// tell whether it was run is an audit that reports success without asking.
//
// The three facts are arguments so the question can be asked about paths other
// than this module's own: the tests hand it a junctioned path on purpose. The
// answer is three-state. `true` and `false` are the verdicts; `undefined` means
// the question genuinely cannot be answered — no entry point was named at all,
// or the module is not a `file:` URL — and a caller must treat that as "nothing
// was asked" rather than as "imported", which is the silent success this
// function exists to prevent.
export function entryVerdict({ main, url, argv }) {
  // A runtime that offers the flag has answered the question; nothing else is
  // consulted, and its `false` really does mean this module was imported.
  if (main === true || main === false) return main;

  const asked = argv?.[1];
  if (asked === undefined || asked === "") return undefined;

  let here;
  try {
    here = fileURLToPath(url);
  } catch {
    // Not a `file:` URL — a `data:`, an `http:`, a loader's virtual module — so
    // there are not two paths to compare, whatever argv[1] says.
    return undefined;
  }

  // Resolved first, because that is free and answers the ordinary case: the same
  // spelling of the same path. A symlink, a Windows junction, a differently
  // cased path or a hard link makes one file answer to several spellings and
  // defeats a raw string comparison, so the paths are compared as files rather
  // than as strings — and `false` means "asked nothing, exit 0", which is
  // exactly the wrong answer to give about this very file.
  return sameFile(resolve(here), resolve(asked));
}

// Whether two resolved paths name one file, or undefined when that cannot be
// settled. `false` is only for a file system that has proven it: it means
// "asked nothing, exit 0", the one answer that must never be given about this
// very file, so every step that cannot answer leaves the question open instead.
//
// `stat` is a parameter so a test can hand this an identity the local file
// system will not give — an `ino` of 0, or a stat that throws.
export function sameFile(left, right, stat = statSync) {
  if (left === right) return true;

  let a;
  let b;
  try {
    a = realpathSync(left);
    b = realpathSync(right);
  } catch {
    // Either path could not be resolved — an entry that is gone, a URL that is
    // not a file — so which file was run is not a question this can answer.
    return undefined;
  }
  if (a === b) return true;

  // Two names for one file that realpath cannot join: a hard link has no target
  // to resolve, so it stays two paths on disk and a differing realpath is no
  // proof of a different file. Identity is what is left to tell it from a
  // different file, and it is only read when both sides report one: an `ino` of
  // 0 is a file system saying it has no identity to give (some FUSE and network
  // mounts), and comparing those would call two different files one file — a
  // `true` that would make an import ask the route. Where the identity cannot be
  // read at all, the question stays open rather than answered "different file".
  const identity = (at) => {
    const stats = stat(at, { bigint: true });
    return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
  };
  let ids;
  try {
    ids = [identity(left), identity(right)];
  } catch {
    return undefined;
  }
  if (ids[0] === undefined || ids[1] === undefined) return undefined;
  return ids[0] === ids[1];
}

function invokedDirectly() {
  // `typeof` rather than `??`: a runtime without the property throws on the
  // member access itself, where there is nothing to fall back from.
  const main = typeof import.meta.main === "boolean" ? import.meta.main : undefined;
  return entryVerdict({ main, url: import.meta.url, argv: process.argv });
}

// Only a run asks the route. The tests import the helpers above and must not
// reach the network. An undeterminable answer is thrown rather than exited on,
// because this is module evaluation: a `process.exit(1)` here would kill the
// importer — a test runner, a loader, anything that asked for these helpers —
// instead of telling it what happened. Throwing leaves the report and the exit
// code to the caller, so a run that reaches it still dies non-zero with the
// sentence above, and an importer can catch it and say so itself.
const entry = invokedDirectly();
if (entry === undefined) throw new Error(UNDETERMINED_ENTRY);

if (entry) {
  // A generation nobody captured is a typo or a Zen that has moved on, and is
  // worth saying in one line rather than throwing a TypeError out of the first
  // line of the run.
  if (!Object.hasOwn(PROFILES, GENERATION)) {
    console.error(
      `limits audit — ZEN_GENERATION "${GENERATION}" is not a captured generation (${Object.keys(PROFILES).join(", ")})`,
    );
    process.exitCode = 1;
  } else {
    try {
      await run();
    } catch (error) {
      // Being unable to ask is not a finding about limits, so it is a sentence
      // and an exit code rather than a stack trace about a fetch that failed.
      console.error(`\nlimits audit — unable to ask: ${error?.message ?? error}`);
      console.error("The route or the catalogue could not be read. Check the network and ZEN_BASE_URL, then ask again.");
      process.exitCode = 1;
    }
  }
}

// One audit: read the listing and the catalogue, ask every id the plugin would
// offer, print what came back and judge it. Exported so a test can drive the
// whole thing — the exit code, the summary and the candidate lines are the
// answers it gives, and a test that reached only the helpers beside it could not
// say whether they agree with each other.
export async function run() {
  // Through core-tools' accessor, as in `ask` above: it answers the failure with
  // a sentence naming the generation and what the capture holds, which is what
  // the entry point's own `Object.hasOwn` check reports for a generation nobody
  // captured.
  const names = [...profileFor(GENERATION).required];
  const [listing, catalog] = await Promise.all([getJSON(`${BASE}/models`), getJSON(CATALOG_URL)]);
  const models = catalog?.opencode?.models ?? {};
  const ids = offeredIds(
    (Array.isArray(listing?.data) ? listing.data : []).map((entry) => entry?.id).filter(Boolean),
    models,
  );
  // The catalogue count is models.mjs's own free rule, the same one `offeredIds`
  // reads a listing id by, so the two numbers in this line are one question.
  // Written out as `/free/i` here — a match anywhere, not the `-free$` name Zen
  // gives its free models — it counted a paid `free-tier-model`, and it counted
  // a free id the catalogue has retired: the line then said the catalogue still
  // describes models the plugin has stopped offering, which is the drift the
  // count exists to make visible. Retirement is part of `isFree`, so a retired
  // id belongs to neither number. `Object.keys` is what makes the row read an
  // own one here: it names the catalogue's own ids and nothing else.
  const free = Object.keys(models).filter((id) => isFree(id, models[id]));
  console.log(`limits audit — ${BASE}`);
  console.log(`${ids.length} free ids are offered; the catalogue still describes ${free.length}\n`);

  const rows = [];
  // This asks the chat shape only. An id the snapshot places on another protocol
  // is left to the host that speaks it, and said once rather than reported as a
  // finding it cannot be. The snapshot is read as its own property, the same rule
  // `offeredIds` reads it by: through the prototype, an id named `constructor`
  // read as a protocol this audit does not speak, was printed under "not asked"
  // with a function for a protocol, and was never asked at all.
  const asked = ids.filter((id) => (ownIn(bootstrapProtocols, id) ?? "chat") === "chat");
  const elsewhere = ids.filter((id) => !asked.includes(id));
  // The asks are independent, and each one can sit until its 45 s abort, so a
  // few run together: 4 at a time overlaps the waiting without opening a
  // connection per id. Answers are gathered first and printed in `asked` order,
  // which is the order the listing gave.
  for (let at = 0; at < asked.length; at += POOL) {
    const batch = await Promise.all(
      asked.slice(at, at + POOL).map(async (id) => {
        const answer = await ask(id, names);
        // The pair the plugin puts on the wire travels with the row, so the
        // table, the sibling list and the candidates all read one number
        // instead of three that can be computed from different things. The
        // catalogue's row for the id is an own read, like the two above it: a
        // declaration read through the prototype is one nobody made.
        return withEffective({ id, declared: ownIn(models, id)?.limit ?? {}, ...answer });
      }),
    );
    rows.push(...batch);
  }

  // What the plugin declares is the catalogue's limit with limits.mjs over it,
  // so that is what is printed; the catalogue's own pair is shown beside it when
  // the two differ, since that is the under-report being answered.
  for (const { id, declared, effective, ...answer } of rows) {
    const moved = effective.context !== declared.context || effective.output !== declared.output;
    const pair = (limit) => `${limit.context ?? "—"}/${limit.output ?? "—"}`;
    const mark = answer.status === 200 ? "  " : "! ";
    console.log(
      `${mark}${id.padEnd(34)} ${pair(effective).padStart(17)}` +
        `${moved ? `  (catalogue ${pair(declared)})` : ""}  ${answer.status}` +
        `${answer.upstream ? `  ${answer.upstream}${answer.endpoint ? ` via ${answer.endpoint}` : ""}` : ""}` +
        `${answer.ceiling !== undefined ? `  ceiling=${answer.ceiling}` : ""}${answer.window !== undefined ? `  window=${answer.window}` : ""}` +
        `${answer.says ? `  — ${answer.says}` : ""}`,
    );
  }

  // "Answered" is this file's own word for a positive result, and a 200 is not
  // the only shape it takes: an upstream that validates the ceiling it was asked
  // for and names its own has answered the question this audit exists to ask —
  // the file's header says so, and `findings` treats such a row as a candidate
  // rather than as a failure. Counted as a 200 alone, a run where every id was
  // refused in exactly that way printed its candidates and then said "nothing
  // answered, so this says nothing about limits" and exited 1: the summary
  // contradicting the table above it, and the exit code contradicting both.
  //
  // `says` alone is deliberately not enough. It is set on every refusal and on
  // every transport failure alike — a 400 that names nothing, a 410 for a model
  // that is gone, `status: 0` with a socket error in it — so counting it would
  // call a run that reached nothing a run that answered. What is counted is a
  // row that either served the request or named a limit: `ceiling` and `window`
  // are the two axes only a refusal that stated something produces, and a row
  // that named nothing has neither.
  const answered = rows.filter(
    (row) => row.status === 200 || row.ceiling !== undefined || row.window !== undefined,
  );
  const candidates = findings(rows, new Set(Object.keys(LIMITS)));
  // Two different kinds of id, said as two lines. `elsewhere` was never asked —
  // the snapshot places it on a protocol this audit does not speak, and the
  // protocol it names is worth printing. A row refused for its shape was asked
  // and said no, and its snapshot entry is necessarily `chat`: printing that
  // under "not asked, this audit asks the chat shape only" would contradict the
  // line it sits on.
  if (elsewhere.length) {
    // Own property here too, so the line names the same protocol the filter
    // above read: through the prototype it printed a function where a protocol
    // goes, which is not a protocol anybody captured.
    const named = elsewhere.map((id) => {
      const protocol = ownIn(bootstrapProtocols, id);
      return `${id}${protocol ? ` (${protocol})` : ""}`;
    });
    console.log(`\nnot asked, this audit asks the chat shape only: ${named.join(", ")}`);
  }
  const refusedShape = rows.filter(protocolScoped).map((row) => row.id);
  if (refusedShape.length)
    console.log(`\nasked, and refused for its shape: ${refusedShape.join(", ")}`);
  console.log(`\nlimits.mjs already carries evidence for: ${Object.keys(LIMITS).join(", ")}`);
  console.log(`\n${candidates.length} candidate${candidates.length === 1 ? "" : "s"}:`);
  for (const line of candidates) console.log(`  ${line}`);
  if (!candidates.length) console.log("  none — every offered id is either measured or declared at what the route states");

  if (!answered.length) {
    console.log(
      asked.length
        ? "\nNothing answered, so this says nothing about limits. Check the network or ZEN_BASE_URL and ask again."
        : "\nNo offered id speaks the chat shape, so nothing was asked and this says nothing about limits.",
    );
    process.exitCode = 1;
  } else {
    // Said rather than left alone, so the rule at the top of this file has one
    // answer instead of two: a run that answered sets 0, a run that did not sets
    // 1. Left implicit, `undefined` was the success code after an earlier run in
    // the same process had set 1 — the audit's answer was then whatever the last
    // one was, which is no answer at all.
    process.exitCode = 0;
  }
}

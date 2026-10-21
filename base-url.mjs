// The one place `ZEN_BASE_URL` is turned into a base URL.
//
// Two tools read the same variable: `limits-audit.mjs` and `tools-smoke.mjs`.
// The rule used to be written twice — once in the audit, once as a trim-only
// copy in the gate — and the copies disagreed the moment the audit's rule grew:
// the gate accepted a `ftp://` base and a base carrying credentials, and a
// request built on either is reported as the free tier being unreachable. The
// copy exists no more: both import this module, and neither imports the other
// for it (`tools-smoke.mjs` is imported *by* `limits-audit.mjs`, so importing
// the rule back from there would close a cycle).
//
// This file is a maintenance tool like the two that read it, and is not part of
// the published tarball: `package.json` ships only the runtime modules plus
// `fingerprint.json` and `limits-observed.json`, and this path is not among
// them, nor is it exported. It must not be added to either list — a host never
// loads it, and publishing it would only widen what a release promises.

import { DEFAULT_BASE } from "./provider.mjs";

// The route's own base, without the trailing slash a deployment's `ZEN_BASE_URL`
// often carries. Every URL the tools build is that base plus a path, and a base
// left with its slash makes `//models` and `//chat/completions`: some routes
// treat the doubled slash as a different path or answer it themselves, and the
// failure reads as "the route or the catalogue could not be read … check the
// network" about a variable the operator set by hand. This is provider.mjs's own
// rule for its three URLs (`httpURL`, `url.href.replace(/\/+$/, "")`) stated
// here, because the tools read their base from the environment and do not go
// through the server to get at it. Exported so the rule can be asked about
// directly: a constant would only show the answer for one spelling.
export function baseFrom(value) {
  // An empty string is a variable that names no base: `ZEN_BASE_URL=` in a
  // profile exports one, and `??` reads it as set, so the base became the empty
  // string and every URL below it a relative path (`/models`) — a request to no
  // host at all, reported as "the route or the catalogue could not be read …
  // check the network" about a variable that was wrong before it was used.
  // Whitespace names no base either, for the same reason.
  const text = value === undefined || value === null ? DEFAULT_BASE : String(value);
  const trimmed = text.trim();
  if (trimmed === "") return DEFAULT_BASE;
  // The rest of provider.mjs's `httpURL` rule, which this base has to answer
  // too — it was copied here as half of it, and the half that was missing is
  // the half that fails the same unexplained way:
  //
  //   * The whitespace is judged before the text is used, and the trimmed text
  //     is what is returned. A base written as `" https://host "` kept its
  //     spaces, so the trailing-slash strip never fired and the tool fetched
  //     `https://host/%20/models` — a 404 reported as "the route or the
  //     catalogue could not be read … check the network and ZEN_BASE_URL", a
  //     network message about a whitespace typo.
  //   * A base carrying credentials, a query or a fragment is refused, as
  //     `httpURL` refuses it. Pasted into the middle of a URL here it becomes
  //     `https://host?x=1/models`, which is a URL with a query in the path and
  //     fails the same unexplained way.
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `ZEN_BASE_URL is not a URL: ${JSON.stringify(trimmed)}. It has to be an HTTP(S) URL such as ${DEFAULT_BASE}.`,
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    // An empty query or fragment is not visible in `search`/`hash`: `new URL`
    // answers "" for both on `https://host?` and `https://host#`, so the guards
    // above pass and the base joined below is `https://host/?` + `/models` — a
    // query in the path, which the route cannot answer and reports as a network
    // failure about a base that was wrong before it was used. The trailing
    // spelling is what has to be refused, because the parse has already lost it.
    /[?#]$/.test(trimmed)
  ) {
    throw new Error(
      `ZEN_BASE_URL must be an HTTP(S) URL without credentials, query or fragment: ${JSON.stringify(trimmed)}.`,
    );
  }
  return url.href.replace(/\/+$/, "");
}

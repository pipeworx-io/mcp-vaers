interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * VAERS (Vaccine Adverse Event Reporting System) — report counts by vaccine,
 * manufacturer, symptom, year and severity. Fleet #1294.
 *
 * A VAERS REPORT IS NOT A CONFIRMED ADVERSE EVENT. Anyone — a patient, a
 * parent, a clinician, a manufacturer — can file one, VAERS does not verify
 * the contents, and a rise in reports for a vaccine can reflect more doses
 * given, more media attention, or a reporting-requirement change as easily
 * as it can reflect a real safety signal. CDC and FDA say this about their
 * own data, in their own words, and every tool below repeats it:
 *
 *   "The number of reports alone cannot be interpreted as evidence of a
 *   causal association between a vaccine and an adverse event, or as
 *   evidence about the existence, severity, frequency, or rates of problems
 *   associated with vaccines. Reports may include incomplete, inaccurate,
 *   coincidental, and unverified information."
 *   — https://wonder.cdc.gov/wonder/help/vaers.html
 *
 * So this pack:
 *   - never calls a row a "case" or an "event" — it is a REPORT, always.
 *   - carries `is_causal: false` as a literal field on every response, not
 *     just prose, so a model reading the payload cannot round a report count
 *     up into a causal claim.
 *   - answers COUNT questions only (by vaccine / manufacturer / symptom /
 *     year / severity) and never returns a single report's free text —
 *     there is no tool here that lets a caller quote one person's narrative
 *     as if it were a finding. See supabase/migrations/165_vaers_aggregates.sql
 *     for why: the raw seed's free-text columns (SYMPTOM_TEXT, HISTORY,
 *     LAB_DATA, OTHER_MEDS, CUR_ILL, ALLERGIES) are not even stored.
 *
 * COUNTING CONVENTION, stated because it surprises people: a report that
 * names two vaccines (e.g. a combined visit) is counted once PER VACCINE —
 * the same convention CDC WONDER itself uses for VAERS. So summing
 * report_count across every vaccine in a year can exceed that year's total
 * UNIQUE reports (vaers_coverage gives the unique total).
 *
 * DATA: the public VAERS data files (AllVAERSDataCSVS.zip,
 * https://vaers.hhs.gov/data/datasets.html), a one-time human-downloaded
 * seed (Bruce's ruling, task #1294, 2026-09-07 — every automated surface CDC
 * exposes for VAERS is closed, see docs/vaers-access-finding.md). REFRESH IS
 * MANUAL: re-download the zip and rerun `scripts/ingest-vaers.mjs
 * <path>` — there is no live proxy here, `vaers_coverage`'s
 * `data_last_loaded` says how stale the copy currently is.
 */


async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'VAERS (hosted seed)');
}

interface Cfg { url: string; key: string }

const DISCLAIMER =
  'The number of reports alone cannot be interpreted as evidence of a causal association between a vaccine and an adverse event, or as evidence about the existence, severity, frequency, or rates of problems associated with vaccines. Reports may include incomplete, inaccurate, coincidental, and unverified information. — CDC/FDA (https://wonder.cdc.gov/wonder/help/vaers.html)';

const SOURCE = 'VAERS (Vaccine Adverse Event Reporting System), co-run by CDC and FDA — public data files at https://vaers.hhs.gov/data/datasets.html';

const NOT_UNIQUE_NOTE =
  'A report naming more than one vaccine is counted once PER VACCINE it names (the convention CDC WONDER itself uses) — do not sum report_count across vaccines/manufacturers and compare it to a unique-report total.';

async function rpc<T>(cfg: Cfg, fn: string, body: Record<string, unknown>): Promise<T[]> {
  const res = await pwFetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res, 'VAERS (hosted seed)');
  return parseJson<T[]>(res, 'VAERS (hosted seed)');
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
}

function yearArg(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1900 && n <= 2100 ? Math.trunc(n) : null;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'vaers_events_by_vaccine',
    description:
      'VAERS report counts and severity breakdown (died / life-threatening / hospitalized / disabled / ER visit) by vaccine, for the requested year range. Pass `vaccine` as the VAERS vax_type code (e.g. "COVID19", "FLU4", "HPV9", "VARCEL", "MMR") to get that vaccine\'s counts; omit it to browse the top vaccines ranked by report volume, which doubles as a way to discover valid codes. Optionally narrow to one `manufacturer` (substring match, e.g. "PFIZER", "MODERNA"). Answers "how many VAERS reports mention the COVID-19 vaccine", "which vaccine has the most reported deaths in VAERS", "Pfizer vs Moderna VAERS report counts". '
      + 'IMPORTANT: a report count is NOT evidence the vaccine caused the event — VAERS accepts any report from anyone, unverified. Every response carries the CDC/FDA disclaimer and `is_causal: false`. This never returns a single report\'s free text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        vaccine: { type: 'string', description: 'VAERS vax_type code, e.g. "COVID19", "FLU4", "HPV9", "MMR", "VARCEL". Omit to see the top vaccines by report count.' },
        manufacturer: { type: 'string', description: 'Manufacturer substring, e.g. "PFIZER", "MODERNA", "MERCK". Optional.' },
        year_from: { type: ['number', 'string'], description: 'Earliest report-received year to include (data covers 1990-2026).' },
        year_to: { type: ['number', 'string'], description: 'Latest report-received year to include.' },
        limit: { type: ['number', 'string'], description: 'Max rows (1-200, default 20).' },
      },
    },
  },
  {
    name: 'vaers_events_by_symptom',
    description:
      'VAERS report counts by symptom (MedDRA preferred term), optionally filtered to one vaccine and/or year range. Pass `symptom` as a substring (e.g. "headache", "anaphyla", "myocarditis") to count how often it was reported; omit it to see the most-reported symptoms overall (optionally within one vaccine). Answers "how many VAERS reports mention myocarditis after the COVID-19 vaccine", "most commonly reported symptoms for the flu vaccine in 2022". Counts are MENTIONS — a report naming several symptoms and/or several vaccines contributes to each combination, so this is not a count of unique reports. '
      + 'IMPORTANT: a symptom being reported alongside a vaccine is NOT evidence the vaccine caused it — VAERS accepts any report from anyone, unverified. Every response carries the CDC/FDA disclaimer and `is_causal: false`. This never returns a single report\'s free text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symptom: { type: 'string', description: 'Symptom substring (MedDRA preferred term), e.g. "headache", "anaphyla", "myocarditis". Omit to see the top symptoms.' },
        vaccine: { type: 'string', description: 'VAERS vax_type code to narrow to one vaccine, e.g. "COVID19". Optional.' },
        year_from: { type: ['number', 'string'], description: 'Earliest report-received year to include (data covers 1990-2026).' },
        year_to: { type: ['number', 'string'], description: 'Latest report-received year to include.' },
        limit: { type: ['number', 'string'], description: 'Max rows (1-200, default 20).' },
      },
    },
  },
  {
    name: 'vaers_coverage',
    description:
      'What this VAERS pack currently holds: total unique reports, the year range covered, how many distinct vaccine types and manufacturers, and when the seed was last (re)loaded — refresh is a manual re-download of the CDC/FDA data files, not a live feed, so check this before relying on recency. Also returns the top 5 vaccines by report volume as a starting point for vaers_events_by_vaccine.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

interface VaccineStatsRow {
  vax_type: string; vax_manu: string;
  report_count: number; died_count: number; life_threatening_count: number;
  hospitalized_count: number; disabled_count: number; er_visit_count: number;
  years_covered: number;
}

interface SymptomStatsRow {
  symptom: string; vax_type: string; report_count: number; years_covered: number;
}

interface CoverageRow {
  total_reports: number; year_min: number; year_max: number;
  distinct_vaccine_types: number; distinct_manufacturers: number;
  last_loaded: string | null;
}

function shapeVaccineRow(r: VaccineStatsRow) {
  return {
    vaccine: r.vax_type,
    manufacturer: r.vax_manu,
    report_count: r.report_count,
    died_count: r.died_count,
    life_threatening_count: r.life_threatening_count,
    hospitalized_count: r.hospitalized_count,
    disabled_count: r.disabled_count,
    er_visit_count: r.er_visit_count,
    years_covered: r.years_covered,
  };
}

function shapeSymptomRow(r: SymptomStatsRow) {
  return {
    symptom: r.symptom,
    vaccine: r.vax_type,
    report_count: r.report_count,
    years_covered: r.years_covered,
  };
}

/**
 * A zero-row `vaers_events_by_vaccine` result used to be blamed on the
 * `vaccine` argument unconditionally — even when `vaccine` was a perfectly
 * valid code and it was `manufacturer` (or the year range) that eliminated
 * every row. That is the misleading-refusal class: telling the caller the
 * wrong argument is wrong, which sends a retry at the one thing that was
 * never broken. This isolates which filter actually did it and, when it was
 * manufacturer, lists the manufacturers that DO have data for that vaccine
 * — a near-miss hint costs one extra RPC call and turns a dead end into a
 * usable retry.
 */
async function diagnoseVaccineZero(
  cfg: Cfg,
  vaccine: string,
  manufacturer: string | null,
  yearFrom: number | null,
  yearTo: number | null,
): Promise<Record<string, unknown>> {
  // Does the vaccine code exist AT ALL (no manufacturer, no year filter)?
  const anyRows = await rpc<VaccineStatsRow>(cfg, 'vaers_vaccine_stats', {
    vax_type_in: vaccine, manufacturer_in: null, year_from: null, year_to: null, lim: 1,
  });
  if (!anyRows.length) {
    return {
      result: `No VAERS data found for vaccine code "${vaccine}" — that code does not appear in the data at all. Call vaers_events_by_vaccine with no "vaccine" argument to see valid codes ranked by report volume.`,
    };
  }

  // The vaccine code is real. If a year range was given, check whether the
  // vaccine has ANY reports in that range before blaming manufacturer —
  // otherwise a valid manufacturer for a wrong year range would still get
  // mislabeled as a bad manufacturer.
  if (yearFrom !== null || yearTo !== null) {
    const inRange = await rpc<VaccineStatsRow>(cfg, 'vaers_vaccine_stats', {
      vax_type_in: vaccine, manufacturer_in: null, year_from: yearFrom, year_to: yearTo, lim: 1,
    });
    if (!inRange.length) {
      return {
        result: `"${vaccine}" has VAERS reports, but none in the requested year range (${yearFrom ?? 'earliest'}-${yearTo ?? 'latest'}). Call vaers_coverage or vaers_events_by_vaccine({vaccine:"${vaccine}"}) with no year range to see which years it covers.`,
      };
    }
  }

  if (manufacturer) {
    // Vaccine exists and the year range (if any) has data — manufacturer is
    // the eliminating filter. manufacturer_in:'' matches every row (LIKE
    // '%%') while still grouping BY manufacturer, so this is the per-
    // manufacturer breakdown for this vaccine/year-range, not the collapsed
    // ALL MANUFACTURERS total.
    const validMfrs = await rpc<VaccineStatsRow>(cfg, 'vaers_vaccine_stats', {
      vax_type_in: vaccine, manufacturer_in: '', year_from: yearFrom, year_to: yearTo, lim: 20,
    });
    return {
      result: `"${vaccine}" has VAERS reports, but none from a manufacturer matching "${manufacturer}". It was the manufacturer filter, not the vaccine code, that eliminated every row.`,
      valid_manufacturers_for_vaccine: validMfrs.map((r) => ({ manufacturer: r.vax_manu, report_count: r.report_count })),
    };
  }

  // No manufacturer given and the year range (if any) checked out — this
  // combination genuinely has no explanation left to offer.
  return { result: `No VAERS data found for vaccine code "${vaccine}" with that filter combination.` };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) {
    throw new Error('vaers is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.');
  }
  const cfg: Cfg = { url, key };

  switch (name) {
    case 'vaers_events_by_vaccine': {
      const vaccine = typeof args.vaccine === 'string' && args.vaccine.trim() ? args.vaccine.trim() : null;
      const manufacturer = typeof args.manufacturer === 'string' && args.manufacturer.trim() ? args.manufacturer.trim() : null;
      const limit = clampInt(args.limit, 1, 200, 20);
      const yearFrom = yearArg(args.year_from);
      const yearTo = yearArg(args.year_to);
      const rows = await rpc<VaccineStatsRow>(cfg, 'vaers_vaccine_stats', {
        vax_type_in: vaccine,
        manufacturer_in: manufacturer,
        year_from: yearFrom,
        year_to: yearTo,
        lim: limit,
      });
      if (!rows.length) {
        const diagnosis = vaccine
          ? await diagnoseVaccineZero(cfg, vaccine, manufacturer, yearFrom, yearTo)
          : { result: 'No VAERS data found for that filter combination.' };
        return {
          found: false,
          ...diagnosis,
          queried: { vaccine, manufacturer, year_from: yearFrom, year_to: yearTo },
          is_causal: false,
          disclaimer: DISCLAIMER,
          source: SOURCE,
        };
      }
      return {
        found: true,
        queried: { vaccine, manufacturer, year_from: yearArg(args.year_from), year_to: yearArg(args.year_to) },
        vaccines: rows.map(shapeVaccineRow),
        counting_convention: NOT_UNIQUE_NOTE,
        is_causal: false,
        disclaimer: DISCLAIMER,
        source: SOURCE,
      };
    }

    case 'vaers_events_by_symptom': {
      const symptom = typeof args.symptom === 'string' && args.symptom.trim() ? args.symptom.trim() : null;
      const vaccine = typeof args.vaccine === 'string' && args.vaccine.trim() ? args.vaccine.trim() : null;
      const limit = clampInt(args.limit, 1, 200, 20);
      const rows = await rpc<SymptomStatsRow>(cfg, 'vaers_symptom_stats', {
        symptom_in: symptom,
        vax_type_in: vaccine,
        year_from: yearArg(args.year_from),
        year_to: yearArg(args.year_to),
        lim: limit,
      });
      if (!rows.length) {
        return {
          found: false,
          result: symptom
            ? `No VAERS reports found mentioning a symptom matching "${symptom}" for that filter.`
            : 'No VAERS data found for that filter combination.',
          queried: { symptom, vaccine, year_from: yearArg(args.year_from), year_to: yearArg(args.year_to) },
          is_causal: false,
          disclaimer: DISCLAIMER,
          source: SOURCE,
        };
      }
      return {
        found: true,
        queried: { symptom, vaccine, year_from: yearArg(args.year_from), year_to: yearArg(args.year_to) },
        symptoms: rows.map(shapeSymptomRow),
        counting_convention: 'Counts are MENTIONS: a report naming several symptoms and/or several vaccines contributes to each combination, so this is not a count of unique reports.',
        is_causal: false,
        disclaimer: DISCLAIMER,
        source: SOURCE,
      };
    }

    case 'vaers_coverage': {
      const [s] = await rpc<CoverageRow>(cfg, 'vaers_coverage_stats', {});
      const top = await rpc<VaccineStatsRow>(cfg, 'vaers_vaccine_stats', {
        vax_type_in: null, manufacturer_in: null, year_from: null, year_to: null, lim: 5,
      });
      return {
        found: true,
        total_unique_reports: s?.total_reports ?? 0,
        year_range: s ? `${s.year_min}-${s.year_max}` : null,
        distinct_vaccine_types: s?.distinct_vaccine_types ?? 0,
        distinct_manufacturers: s?.distinct_manufacturers ?? 0,
        data_last_loaded: s?.last_loaded ?? null,
        refresh_note: 'Refresh is MANUAL: this is a seed loaded from a one-time human download of the CDC/FDA VAERS data files (every automated CDC surface for VAERS is closed — see docs/vaers-access-finding.md). Check data_last_loaded before relying on recency; it does not update on its own.',
        top_vaccines_by_report_count: top.map(shapeVaccineRow),
        is_causal: false,
        disclaimer: DISCLAIMER,
        source: SOURCE,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

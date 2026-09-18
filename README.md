# vaers

VAERS (Vaccine Adverse Event Reporting System) report counts — by vaccine,
manufacturer, symptom, year and severity. Fleet #1294.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1558+ live data sources.

## A VAERS report is not a confirmed adverse event — read this first

Anyone can file a VAERS report — a patient, a parent, a clinician, a
manufacturer — and VAERS does not verify what's in it. A rise in report counts
for a vaccine can reflect more doses given, more media attention, or a
reporting-requirement change just as easily as a real safety signal. CDC and
FDA say this about their own data:

> The number of reports alone cannot be interpreted as evidence of a causal
> association between a vaccine and an adverse event, or as evidence about
> the existence, severity, frequency, or rates of problems associated with
> vaccines. Reports may include incomplete, inaccurate, coincidental, and
> unverified information.
> — <https://wonder.cdc.gov/wonder/help/vaers.html>

Every tool response below carries that disclaimer **and** a literal
`is_causal: false` field, so a model reading the payload cannot round a report
count up into a causal claim. No tool here returns a single report's free
text (`SYMPTOM_TEXT`, `HISTORY`, `LAB_DATA`, `OTHER_MEDS`, `CUR_ILL`,
`ALLERGIES` are not even stored — see the migration comment) — everything is
a count, by design.

## Tools

| Tool | Answers |
|---|---|
| `vaers_events_by_vaccine` | Report counts + severity breakdown by vaccine (and optionally manufacturer), for a year range. Omit `vaccine` to browse the top vaccines by report volume — this doubles as vax_type-code discovery. |
| `vaers_events_by_symptom` | Report-mention counts by symptom (MedDRA preferred term), optionally narrowed to one vaccine/year range. Omit `symptom` to see the most-reported symptoms. |
| `vaers_coverage` | Total unique reports, year range, distinct vaccine/manufacturer counts, when the seed was last loaded, and the top 5 vaccines by volume. |

## Counting convention — read before comparing numbers across tools

A report that names more than one vaccine is counted **once per vaccine** —
the same convention CDC WONDER itself uses for VAERS. So summing
`report_count` across every vaccine for a year can exceed that year's
**unique** report total (`vaers_coverage.total_unique_reports`). Symptom
counts are **mentions**: a report naming several symptoms and/or several
vaccines contributes to each combination.

## Auth

None — no key, no account. This pack answers from pre-aggregated report
counts built from the seed described below.

## Data source and how it got here

**VAERS**, co-run by CDC and FDA — public data files at
<https://vaers.hhs.gov/data/datasets.html>. US federal public-domain data.

Every automated surface CDC exposes for VAERS is closed to a script:

- The bulk-download page is CAPTCHA-gated (image word-verification).
- CDC WONDER's own XML API documents VAERS (database `D8`) as a live
  dataset but the endpoint returns `HTTP 500` with **no error message** for
  every request shape tried — recognized but not enabled, undocumented.
- `data.cdc.gov`'s two VAERS listings are `href` pointers back to WONDER, not
  queryable Socrata datasets.

Full write-up: `docs/vaers-access-finding.md`.

So Bruce's ruling (task #1294, 2026-09-07) is **seed-plus-manual-refresh**:
he downloads `AllVAERSDataCSVS.zip` (the single archive covering every year,
1990-2026, plus non-domestic reports) by hand from the datasets page above,
and this pack's loader ingests it. He explicitly did **not** authorize the
outward-facing option (emailing CDC to ask for the API to be enabled) — that
still needs his own OK if it's ever pursued.

## Storage — why aggregates, not raw rows

The seed is 2.8M report rows / 3.4M vaccine rows / 3.77M symptom rows (2.75GB
uncompressed CSV, 589MB zip). Postgres here is small and has crashed on an
unbatched load before (`docs/medical-data-ingest-plan.md` §3), and this
pack's tools only ever answer count questions — never a raw-row dump — so the
loader (`scripts/ingest-vaers.mjs`) aggregates entirely in memory and writes
only the aggregates, in committed batches:

| Table | Grain | Measured rows (1990-2026 + non-domestic seed) |
|---|---|---|
| `vaers_yearly_totals` | year | 37 |
| `vaers_severity_by_vaccine` | year × vax_type × manufacturer | 4,975 |
| `vaers_symptom_counts` | year × vax_type × symptom | 961,457 |

Total Postgres footprint: tens of MB, not gigabytes. Three RPCs
(`vaers_vaccine_stats`, `vaers_symptom_stats`, `vaers_coverage_stats`, see
`supabase/migrations/165_vaers_aggregates.sql`) do the filtering/summing in
SQL since the tables are small enough that a plain `GROUP BY` is fast.

**Compression note**, since this class of bug has bitten a sibling ingest
before (NCHS natality was Deflate64, unreadable by Node's zlib): checked
first — every entry in `AllVAERSDataCSVS.zip` is method 8 (plain Deflate),
which `node:zlib.inflateRawSync` reads natively. No Deflate64 trap here.

## Refreshing (manual, by design)

VAERS updates weekly. There is no automated path around the CAPTCHA, so
refresh is:

1. A human downloads a fresh `AllVAERSDataCSVS.zip` from
   <https://vaers.hhs.gov/data/datasets.html>.
2. `node scripts/ingest-vaers.mjs /path/to/AllVAERSDataCSVS.zip`

The loader is idempotent (`ON CONFLICT ... DO UPDATE`) and re-runnable — a
rerun with the same or a newer file simply updates the aggregates in place.
It refuses to load a result that looks truncated (fewer than 20 years, 1,000
severity keys, or 100,000 symptom keys) rather than quietly shrinking the
dataset.

**Proposed cadence: weekly**, matching VAERS' own release rhythm — one
re-download + rerun per week keeps `vaers_coverage.data_last_loaded` inside
a week of the live data. This is a recurring cost of Bruce's time by design
(his ruling); if an automated path ever opens up (CDC enabling the WONDER
API for D8, or a future scrape-friendly surface), this is the loader to
replace, not the schema.

### Two write paths, chosen automatically

`ingest-vaers.mjs` looks for the platform's database credentials in `.env`
first (fast REST batched upsert). If they aren't available in the
environment it's run from, it falls back to writing chunked, idempotent SQL
files to `/tmp/vaers-sql/` and printing the `supabase db query --file ...
--linked` commands to apply them — the same Management-API path used to
apply `supabase/migrations/165_vaers_aggregates.sql`. Either path produces
the same tables.

## What this does not cover

- Individual report narratives (`SYMPTOM_TEXT`, `HISTORY`, etc.) — not
  stored, not returned, by design (see above).
- Anything past the loaded seed's vintage — check `vaers_coverage` before
  relying on recency.
- FAERS (drug adverse events) — that's `openfda`. VAERS is vaccines only.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "vaers": {
      "url": "https://gateway.pipeworx.io/vaers/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/vaers/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1558+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/vaers_events_by_vaccine \
  -H 'Content-Type: application/json' \
  -d '{"vaccine":"COVID19","year_from":2021,"year_to":2022}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/vaers_events_by_vaccine`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "vaers": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-vaers"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-vaers
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Vaers data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

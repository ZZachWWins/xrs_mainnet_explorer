# External explorer history archive

This service prepares a searchable archive outside the audited L1. It never signs,
submits transactions, restarts a node, changes node configuration, or writes to a
node ledger/receipt database. Source SQLite connections use `mode=ro`,
`query_only=ON`, and an explicit read transaction. Only the explicitly named public
source files are opened; adjacent key files must never be supplied or scanned.

The archive indexes block slot and hash, transaction signature, and participating
addresses. Every indexed transaction retains its complete signed wire, raw
instructions, and decoded fields where supported. Raw amounts are decimal strings.
An included transaction has `status: unknown` until complete, matching instruction
outcomes are available. A receipt for one instruction does not establish that all
instructions succeeded.

## What is implemented

- Durable derived SQLite database with foreign-key indexes and atomic ingestion.
- Three-node observer import with chain/checkpoint binding, stored-evidence digest,
  agreement, transaction order/Merkle, and complete receipt checks. SQLite receipt imports also validate ordered effect
  summaries against decoded wires, slot/signature, and block timestamps, preserving
  signed SQLite amounts as their original unsigned decimal values.
- Streaming historical JSONL backfill into a **new** index. It recomputes every
  block's v4 scrypt header commitment and transaction Merkle root, checks parent
  linkage and the pinned checkpoint, and matches every observer-overlap block.
- A fixed ledger byte-prefix snapshot, rehashed after ingestion. Source truncation,
  replacement, changed prefix, partial final record, or contradictory evidence
  aborts the import. Concurrent appends are left for the next observer refresh.
- Stable SQLite pagination: a cursor binds query, canonical tip, and revision.
  Appending does not skip/repeat existing rows. Replacing a branch invalidates
  previous cursors and atomically removes orphaned transaction/address indexes.
- Honest coverage: earliest retained slot, tip/hash, absent slot ranges, record
  counts, outcome coverage, observer interval, source-prefix digest, and revision.
- Immutable JSON exports with per-file SHA-256/size and a generation manifest.
- Netlify Blobs adapter, public read-only API handler, and isolated tests.

“Canonical” here means consistent with the supplied local ledger, checkpoint and
three-node observer evidence. The service does **not** independently validate
producer certificates, hybrid signatures, difficulty, or recovery/gap certificates.
A parent-linked jump in slot numbers is disclosed as a gap; no empty block is
invented. Slot 1 is the first produced block; the initial genesis state is not
represented as a fictitious slot-0 transaction.

Address coverage consists of message account keys, supported native/token embedded
addresses, and receipt participants. Unparsed instruction fields and contract state
history are not claimed to be a complete address/token/contract index. Full original
block JSON, including producer certificate fields, remains in the source ledger;
this compact searchable archive retains block metadata and complete transaction
wires, not every producer certificate byte.

## Local commands

Run from the workspace root. These commands write only to `work/explorer-history-index`.
Use a new output name for each backfill/export; they refuse to overwrite one.

```sh
python3 work/sites/xeris-mainnet-explorer/services/history-index/history_index.py observe \
  --source work/settlement-operator-state/observer.sqlite3 \
  --index work/explorer-history-index/observer-index.sqlite3

python3 work/sites/xeris-mainnet-explorer/services/history-index/history_index.py backfill \
  --observer-index work/explorer-history-index/observer-index.sqlite3 \
  --ledger work/mac-mainnet/treasury/ledger.dat \
  --receipts work/mac-mainnet/treasury/tx_receipts.sqlite \
  --output work/explorer-history-index/full-index.sqlite3

python3 work/sites/xeris-mainnet-explorer/services/history-index/history_index.py query \
  --index work/explorer-history-index/full-index.sqlite3 1

python3 work/sites/xeris-mainnet-explorer/services/history-index/history_index.py observe \
  --source work/settlement-operator-state/observer.sqlite3 \
  --index work/explorer-history-index/full-index.sqlite3

python3 work/sites/xeris-mainnet-explorer/services/history-index/history_index.py export \
  --index work/explorer-history-index/full-index.sqlite3 \
  --output work/explorer-history-index/export-001

node work/sites/xeris-mainnet-explorer/services/history-index/blobs.mjs verify-export \
  work/explorer-history-index/export-001 xeris-mainnet-v4
```

When the observer is behind, `tail` independently validates new records from the
already verified public ledger. It rehashes the retained prefix, rejects any changed
prefix, checks every new header/Merkle/parent, and rehashes the captured whole prefix
before committing. It performs no source writes. This fallback reads the full prefix
twice; measure disk cost before scheduling it frequently on a large archive.

```sh
python3 work/sites/xeris-mainnet-explorer/services/history-index/history_index.py tail \
  --index work/explorer-history-index/full-index.sqlite3 \
  --ledger work/mac-mainnet/treasury/ledger.dat
```

Capture a consistent receipt backup **before** extending the ledger so its tip is
included by the later ledger snapshot. SQLite backup includes committed WAL data;
copying only a live `.sqlite` file does not.

```sh
python3 work/sites/xeris-mainnet-explorer/services/history-index/history_index.py snapshot-receipts \
  --source /explicit/public/path/to/live/tx_receipts.sqlite \
  --output work/explorer-history-index/receipt-snapshots/new-snapshot.sqlite3
```

`query` accepts a slot, block hash, transaction signature, or address. Python callers
can use `Index.page('blocks'|'transactions', limit, cursor, address)` for SQLite
pagination. The static/Blobs API uses immutable 100-record pages.

The sibling receipt database supplied during this preparation was stale at slot 11,754,
with zero stored outcomes and a tip hash that does not match this canonical
ledger. It was rejected and recorded in coverage; missing outcomes remain unknown. The exact databases held open by the live processes were subsequently located
through filenames returned by `lsof`. Consistent SQLite backups from both nodes
matched canonical tips at 46,358 (recovery snapshots) and, in the final capture,
47,625 (candidate snapshots). The final candidate snapshots agreed on all 16
receipt/outcome records.
Their complete instruction outcomes and receipt summaries were matched to the
canonical signed wires before import. All 16 indexed transactions at that capture
therefore have confirmed outcomes; unsupported or missing evidence in later data
will still remain explicit. Receipt fees and full contract-internal balance changes
are not invented from these summary rows. Raw transaction and
block history can still be indexed without fabricating success. Optional backfill
receipt rejection is explicit in `coverage.receipt_snapshot_rejected`; it cannot
turn missing evidence into confirmed execution. A later strict import uses:

```sh
python3 work/sites/xeris-mainnet-explorer/services/history-index/history_index.py receipts \
  --index work/explorer-history-index/full-index.sqlite3 \
  --source /explicit/public/path/to/current/tx_receipts.sqlite
```

Use the actual public receipt database held open by the node, verified by its
canonical tip/hash. Recovery/reorg code may keep databases in named cache/candidate
directories while the sibling database is stale. Discover filenames through process
metadata; do not scan adjacent files or assume the newest candidate is canonical.

## Reorgs and safe updates

Normal `observe` refreshes fail on a canonical conflict; they never silently replace
history. `Index.replace_suffix(anchor_slot, anchor_hash, records)` is an explicit
operator API for a replacement already validated against canonical source evidence.
It requires a retained common ancestor, rolls back on bad linkage/duplicate data,
records removed block hashes, deletes orphan references, increments the revision,
and clears superseded provenance coverage. Feed replacement records through
`normalize_block`; raw ledger records must also pass `work_hash` verification.
This API is not exposed by the public HTTP handler.

For a changed historical branch, the simplest deployment workflow is to rebuild a
new derived index from the source ledger plus a consistent observer snapshot,
validate/export it, then activate the new Blobs generation. Keep the prior generation
for in-flight pagination and investigation. No source ledger is repaired or reset.
A failed backfill may leave an empty/partial **derived output**; it is not a valid
release unless the command succeeds and its full export verifies.

## Netlify Blobs deployment preparation

No credentials were inspected, no SDK was installed, no background indexer or HTTP
service was started, and no archive was uploaded by this preparation.

The adapter uses a site-wide `xeris-explorer-history` store, chain-qualified keys,
strong reads, immutable generation objects, and an ETag conditional update of
`current.json` **last**, after all data and the manifest are stored. A failed upload
leaves the previous generation active. Each read verifies the manifest-listed file
size and SHA-256 before parsing. Readers retain their selected immutable generation
across pagination, even after the active pointer advances.

Before deployment:

1. Install and lock `@netlify/blobs` in the chosen Node publishing/Function runtime.
2. Wire `createHistoryApiHandler({adapter, basePath: '/api/history'})` from
   `read-api.mjs` into a Netlify Function, using
   `createHistoryBlobAdapter({chainId: 'xeris-mainnet-v4'})` from `blobs.mjs`.
   Netlify's Function runtime supplies site/auth context. An explicit operator
   publisher may instead pass `netlify: {siteID, token, region}` from approved
   secret storage; never put these values in export JSON or client bundles.
3. Verify the complete local export, then explicitly call
   `adapter.publish(manifest, readFile, {expectedGeneration: currentOrNull})`.
   `openLocalExport` provides a reader confined to manifest-listed regular files.
   A competing publisher causes activation to fail instead of overwriting it.
4. Connect explorer history/search views to the new read API and show coverage,
   unknown status, gaps, and archive freshness. Existing explorer routes are not
   changed by this service directory.
5. Run a separate bounded refresh/export/publish job and monitor its last successful
   tip. Start with a conservative cadence. This first version republishes complete
   immutable generations; it does not yet deduplicate identical data across
   generations. Measure Blobs write/storage cost before a frequent schedule.
   Retention/garbage collection is deliberately not automatic.

Do not use a build plugin to write this site-wide store: Netlify restricts build
plugin writes to deploy-specific stores. The Function reader and explicit operator
publisher use a site-wide store. See the
[Netlify Blobs documentation](https://docs.netlify.com/build/data-and-storage/netlify-blobs/).

Public read routes: `GET /api/history/coverage`, `/blocks`, `/transactions`,
`/block/:slot-or-hash`, `/transaction/:signature`, `/address/:address`, and
`/search?q=...`. List continuation uses the returned `cursor`; it must not be mixed
between addresses/routes. There are no mutation routes.

## Tests

```sh
python3 -m unittest discover -s work/sites/xeris-mainnet-explorer/services/history-index -p 'test_*.py' -v
node --test work/sites/xeris-mainnet-explorer/services/history-index/*.test.mjs
```

Tests use temporary synthetic public data/in-memory storage, without connecting to
nodes or Netlify. They cover wire/Merkle/header integrity, receipt identity,
large-integer preservation, address pagination, append/reorg cursors, rollback,
read-only source handling, export checksums, upload atomicity, concurrent publication,
immutable generation reads, corruption, and path confinement.

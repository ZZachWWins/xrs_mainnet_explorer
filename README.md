# Xeris network explorer

Public, read-only explorer prepared for `ZZachWWins/xrs_mainnet_explorer` and Netlify. **Testnet is the current default.** Users can select Mainnet or Testnet at the top of every page.

## Run and deploy

Requirements: Node 20+ and Python 3. No package installation, account credentials, signing keys, database, or secret environment variables are required.

```sh
python3 build.py
npm test
npm run dev
```

Preview: `http://127.0.0.1:8770`. Explicit deep links use `?network=mainnet` or `?network=testnet`. Netlify should import this repository using the committed `netlify.toml`: build `python3 build.py`, publish `dist`, functions `netlify/functions`. Deploy the **repository**, including its read-only function; dragging only `dist` into hosting omits the API proxy.

To switch the launch default later, edit the single `DEFAULT_NETWORK` constant in `src/network.mjs`, rebuild, test, and redeploy. Explicit saved network links remain unchanged. No network selection or chain data is persisted in browser storage. Switching networks performs a document reload, clearing React state and all in-memory requests. Internal links, history navigation, and copied deep links retain the network query.

## Data boundaries

The browser contacts only same-origin `/networks/<network>/…`. The Netlify function and local preview use the same fixed route validator. They permit only bounded explorer GET routes and an explicit read-only RPC method list. They reject write methods, unknown networks, arbitrary upstream URLs, excessive pagination, and redirects; they do not forward browser credentials. Responses have `Cache-Control: no-store` and an explicit network header. Failed reads never fall back to another chain or fabricate an empty successful response.

Before loading the interface, each network must match its independently checked slot 27201 checkpoint:

| Network | Fixed upstream | Checkpoint hash |
| --- | --- | --- |
| Mainnet | `https://mainnetrpc.xerisweb.com` | `0a401c139eef73f049010450d4aa13ef38636799784d01bbc0ecdb9c71facaf3` |
| Testnet | `http://138.197.116.81:50008` | `04a25302888ed7988efe33b427d9409ab6ba8c144cb0993ed515e57bbbef7fc7` |

The Testnet upstream comes from the supplied existing deployment. Browser traffic remains HTTPS when hosted, but the function-to-legacy-testnet hop is currently HTTP. The supplied `https://rpc.xerisweb.com` did not expose usable explorer REST/JSON-RPC routes during verification. Moving the legacy upstream behind working HTTPS is a follow-up infrastructure change; this project does not alter servers or DNS. A pinned historic checkpoint prevents accidental network mixing; it is not cryptographic verification of every returned record.

Mainnet `/v2/stats`, blocks, validators, tokens and pools were verified. Its public proxy does not expose `/balances`, `/v2/contracts`, `/v2/search`, or token-holder routes; those features display an explicit unavailable notice and never borrow Testnet data. Pool contract details use the existing same-network `/contract/:id` route, with a validated raw Swap-to-UI mapping. Token metadata and issued supply remain visible when holders are unavailable. Transaction listings reflect the node endpoint's retained/indexed window and are labelled recent transactions, not a complete historical ledger. Native balance lists can be capped by the endpoint; they sort exact raw balances numerically and do not invent ownership percentages. Wrapped XRS holders are read from the token registry, never substituted with native balance holders. The inherited swap calculator is omitted because its quote route is not available on the public mainnet endpoint.

The legacy Testnet token endpoint ignores pagination and returns a registry larger than Netlify's response limit. Only that fixed endpoint receives a bounded 24 MiB upstream allowance; `src/legacy-tokens.mjs` preserves exact raw integers and projects core assets plus the newest tokens into an explicitly limited 100-record listing. The browser displays coverage/count information and does not present this subset as a complete registry. Historical rows with unsupported identifiers are omitted with an explicit `omitted_count` and UI notice; duplicate identifiers still reject the response. Exact `token_id` lookups allow supported historical direct links outside the listing. All browser/function output remains capped at 4 MiB. Normal upstream routes retain their 4 MiB bound. Listing/lookup each read the current registry; no stale cached registry is substituted when the upstream fails. A proper paginated legacy index is the follow-up for browsing the entire large registry efficiently.

Circulating supply is read only from the current Mainnet `/market/supply` schema-v2 `unlocked_on_chain_v2` feed. A missing/stale feed shows unavailable. It is not derived from wrapped-token maximum supply, premine assumptions, or FDV. Testnet circulating/total outstanding supply is unavailable without an authoritative feed. Historical raw integers above JavaScript's exact-number range remain strings. Human display conversions can be rounded; the explorer never signs or constructs spending transactions.

## Recovered UI provenance and maintainability

The provided folder was a compiled Vite deployment, without editable React/TypeScript source or its dependency manifest. `vendor/` preserves the supplied public JS/CSS/images. It is **not represented as recovered original source**. `build.py` replaces one asserted data-layer span with maintainable `src/explorer-api.mjs` and applies narrowly asserted UI repairs. It fixes case-sensitive asset paths and removes incorrect inherited claims such as hardcoded 100% success, inferred zero fees, 400 ms block time, wrapped maximum supply labelled circulating, and token maximum labelled total issued supply. Original license notices remain inside the vendor bundle. A future full UI refactor should use the original source repository if available.

`dist/build-manifest.json` records SHA-256 hashes of the source UI, patched UI, and built assets. The build fails if an expected vendor patch no longer matches, so a new export cannot silently skip corrections. `src/network.mjs`, `src/proxy.mjs`, `src/explorer-api.mjs`, and `src/bootstrap.mjs` are the maintained network/data layers. `src/navigation.mjs` provides the responsive navigation and exact-identifier search; `src/view-loaders.mjs` owns cancellable, independent view reads. `ui_reliability.py` contains asserted repairs to the supplied compiled views. CSS preserves the supplied branding with readable tables, a maintained search/header, mobile navigation, and reduced-motion support.

Initial visits and network changes immediately display a connection screen with a spinner and named loading message. Route sections show their own loading messages while reads finish, and failures offer recovery instead of a blank view. Account balances do not wait for history or optional timestamps. Late responses cannot replace the newly selected account or transaction page; dashboard refreshes never overlap. Unknown routes and render failures have explicit recovery screens.

Native transaction amounts and fees are formatted from exact raw integers. Only verified native transfer/stake instruction types receive an XRS amount label; token and other instructions link to details rather than mislabeling quantities as native money. Missing fees remain unavailable, including when the node provides no fee metadata. Indexed history is not presented as all-time account activity.

Tests use synthetic public responses only. They cover checkpoint mismatch, explicit network routing, default selection, deep links, integer precision, request bounds, no write RPC, no credential forwarding, no cross-network fallback, stale supply, in-flight-only coalescing, and wrapped/native holder separation. Browser QA is performed against the local preview before publishing. This repository contains no signing keys, live journal, operator service, or node consensus changes.

## Reliability audit follow-up

The data adapter now distinguishes temporary transport/rate-limit failures from a verified checkpoint mismatch. A later explicit refresh can recover a temporary identity-read failure; a wrong checkpoint or network response header remains latched for that adapter instance. Requests do not automatically retry. Typed `ExplorerError` values expose `code`, `network`, `status`, `retryable`, and `retryAfterMs`; the proxy preserves HTTP 429/503 and a validated, bounded `Retry-After`. No cached response is used as a fallback.

Optional live-supply reads and optional block-timestamp enrichment have a two-second deadline and do not produce a global page error. Primary account/history information must remain useful when enrichment is unavailable. Fetch and streamed-body deadlines are bounded even if cancellation does not finish. Invalid UTF-8 and oversized responses fail closed. Coalesced failures retain each caller's route context. Existing public API method return shapes remain compatible; `block(slot, {optional:true})` is an additive read-only option.

Known endpoint limits remain explicit: ordinary registry helpers can walk at most 20 pages of 100 records; their returned arrays are not an immutable historical snapshot. Mainnet token lookup currently walks that bounded registry. A future paginated UI should preserve `count`, `next_after`, and coverage metadata instead of requesting a complete registry. Recent transaction totals refer to retained blocks; account transaction totals refer to indexed receipts. The current node may return zero indexed rows when no receipt index is available, so an empty result does not prove that an address never transacted. Validator rows expose stake and blocks proposed, not live status, vote credits, or uptime.

## Website audit repairs — November 24, 2026

Detail reads now bind the returned block slot, transaction signature and account address to the requested page. A wrong network header after startup stops further reads in that adapter. Registry pages enforce the requested 100-row bound and validate cursors before another request.

Unknown transaction outcomes are neutral; failed and partially executed transactions have distinct labels. Token maxima, holder balances and pool reserves use exact integer formatting. Zero-decimal tokens are supported, and unavailable token precision is displayed explicitly as raw units. Optional token metadata failures no longer erase real pool records or produce a false “No Pools Found” result. Pool loading and errors are named separately from empty results.

These checks are application-level verification, not a CertiK audit or proof of chain consensus. The known HTTP hop to the legacy Testnet node and the limited registry/history coverage remain infrastructure/indexing follow-ups. No node, consensus, signer or key material is included in these changes.

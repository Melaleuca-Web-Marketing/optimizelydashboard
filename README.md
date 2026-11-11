# Optimizely Dashboard

An independently versioned local dashboard that can run alongside the OptAPI operations app. It only reads from Optimizely. Local annotation edits do not change Optimizely or Azure DevOps.

## Start

From the dashboard repository folder:

```powershell
node server.js
```

Open http://127.0.0.1:4243. Node.js 22.19+ is required (24 LTS works). There are no package dependencies to install. The existing OptAPI server can continue running independently on its own port. On Windows, the process adds the system trusted certificate store to Node's defaults, so corporate certificates work while TLS verification remains enabled. This affects only this process.

For independent use, copy `.env.example` to `.env` and set `OPTIMIZELY_TOKEN`. Existing installations can continue using the parent OptAPI `.env` as a fallback. Process environment settings take priority, followed by the dashboard `.env`, then the parent `.env`. The dashboard defaults to the US/CA project used by the tracker, `5443948697616384`, regardless of the operations app's currently selected project. Override it with `DASHBOARD_PROJECT_ID`. The API token never goes to the browser, snapshot cache, or exported CSV.

Optional environment settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_PORT` | `4243` | Local dashboard port |
| `DASHBOARD_CACHE_MINUTES` | `15` | Shared snapshot lifetime; minimum 1 minute |
| `DASHBOARD_PROJECT_ID` | `5443948697616384` | Optimizely project |
| `DASHBOARD_SEED_FILE` | Existing Nov 9 US/CA extract | Optional initial snapshot when no cache exists |

## What updates automatically

Campaigns, running experiences, audience definitions, locales, URL rules, variation splits and activation dates are read from the API. Campaigns must be running and not archived. Standalone running A/B tests are included when they are not represented by a returned campaign. Campaigns belonging to paused or archived parents are not resurrected as standalone tests.

New Welcome grouping uses positive audience references/attributes, including negation handling. Campaign names alone do not decide the view. General audience contains the remaining campaigns, including tenured-only, preferred-customer and unrestricted configurations. The audience badge makes that distinction. Mixed audience configurations are flagged for review. US/CA filtering retains unspecified-market campaigns for review instead of silently discarding them.

Production / UAT flags come from positive URL rules; excluded production URLs do not make a UAT campaign production. Relative paths or unrecognized host patterns are marked unscoped and prevent an unsafe UAT-only conclusion. Unknown or code-only targeting remains visible as needing review. This is configuration reporting, not proof that every eligible visitor sees a change. Variation split and eligible traffic are separate fields. Performance results are not queried. Page summaries imported from the tracker are curated; inspect URL rules in details for the current API targeting.

## Cache & request behavior

- One shared, sanitized snapshot in `data/snapshot.json`, preserved across restarts.
- Default 15-minute TTL. A one-minute background check refreshes expired data while the Node process runs, even with no browser open. This is not an unattended job when the computer/server is off.
- Browser polls the local server every 30 seconds (2 seconds during a sync). Search, audience views and export never call Optimizely.
- Each full sync paginates campaigns, experiments, saved pages and audiences. API calls are spaced by 500 ms; request totals appear in the snapshot. No per-row detail calls.
- Concurrent refreshes share the same in-flight operation. Manual refresh has a 60-second cooldown. HTTP 429 honors `Retry-After`; repeated failures back off exponentially from 1 minute to 15 minutes.
- A failed refresh preserves the last good snapshot, shows a visible warning and retries. A failed/partial batch cannot replace a complete snapshot.
- First launch can display the existing Nov 9 extract immediately, clearly marked stale, while live sync runs.

## Descriptive names and User Stories

`metadata.json` is a one-time import from the reviewed descriptive-name tracker. It seeds names, work-item links, page descriptions, owners and notes. Existing source workbooks are never rewritten. Edit these fields in a campaign's details using **Edit local details**; changes persist to ignored `data/annotations.json` and survive API refreshes.

The dashboard reads three Optimizely custom field keys during the existing API sync:

| Key | Displayed value | Fallback when blank |
| --- | --- | --- |
| `campaign-descriptive-name` | Descriptive name | Saved tracker/local name, then API name |
| `user-story` | User Story ID and derived Azure DevOps link | Saved story text and link together |
| `assignment` | Owner | Saved tracker/local owner |

Each field resolves independently. Campaign values take priority; when a key is absent on the campaign, a consistent parent-field value exposed on its running experiences can be used. Conflicting experience values are flagged instead of arbitrarily choosing one. Standalone experiments use their own fields. Only these three custom keys are saved in the snapshot.

User Story IDs must be positive safe whole numbers. The link is constructed under `https://dev.azure.com/MelaleucaPlatform/Melaleuca/_workitems/edit/`. A custom ID displays as `User Story #ID`; an old tracker title/candidate label is never attached to a different ID. Invalid custom values keep the saved fallback and show a review warning. Empty or whitespace-only fields use the fallback without a warning.

Names, owners and stories show their source: Optimizely, Tracker fallback, Local fallback, API name or Not provided. Search and CSV export use the displayed values; export also includes owner, field sources and review warnings. Edit local details edits the saved fallback only and never overwrites Optimizely. The original local/imported values are retained when custom fields are filled or cleared. Existing version-2 snapshots remain available while a startup refresh fetches custom fields.

No Azure DevOps API requests are made and story titles/status/assignees are not retrieved from ADO. Existing candidate labels remain visible only when the saved story is being used. The technical API name remains visible under each descriptive name. Experience Details displays API experience names. Existing custom-field values need a successful sync before they can replace fallbacks.

## Analytics attributes in campaign details

Open a campaign and choose **Analytics** to inspect `data-opt-promo` and `data-gtm-promo` values from the existing Optimizely sync. The view shows ID, name, creative and position, full JSON, experience/variation, traffic weight, change ID, selector and page ID where available. Empty names remain visibly blank. Filter by experience or search for a tracking value. Identical occurrences in the same change are counted together; separate variations remain separate.

Extraction covers inline HTML, HTML-encoded JSON (`&quot;`, numeric entities), attribute edits, literal JavaScript setters and nested extension configurations such as `slides_json` / `gtmPromo`. Extension configuration values are labeled as configurations because their generated attribute depends on the extension implementation. JavaScript-computed values are flagged as dynamic; malformed JSON stays visible for review. Externally loaded code is reported as uninspected and is not fetched. Scripts and extension code are never executed. Archived variations are excluded and zero-weight variations are labeled. This reports configured tracking metadata, not analytics event delivery, clicks, impressions or performance results. No extra Optimizely or ADO requests are needed.

Older snapshots remain visible while a startup sync populates analytics metadata. This view is available after that sync completes.

## Design references

Optional Optimizely custom field: name **Design**, key `design`, type **Link**, not required. Use an HTTPS Figma or Adobe XD share link. The populated Optimizely value takes priority over the local Design reference fallback. Links appear in campaign details, the campaign list, and both exports. Blank values do not trigger a warning; invalid links are flagged and fall back to a valid saved URL. Design services are not called and their documents are not fetched.

## Local access

The Project selector supports US/CA Web (`5443948697616384`) and MX Web (`5730256506585088`). Campaigns, Analytics, totals, filters, exports and local edits apply to the selected project. Project and Campaigns/Analytics selections are remembered in localStorage. MX starts with the Mexico market filter. Each project has an independent cache and saved fallback file; US/CA keeps its existing filenames and tracker metadata, while MX uses `snapshot-5730256506585088.json` and `annotations-5730256506585088.json`. Both projects support the same four custom fields. API routes accept `?project_id=...`; unknown projects are rejected. `/api/projects` lists available projects.

The server binds only to `127.0.0.1`. Credentials and data files are not served as static files. For the shared internal server, see [deployment instructions](deploy/README.md). Nginx routes `/campaign-monitor/` to port 17821, and `DASHBOARD_PUBLIC_URL` explicitly allows the HTTPS origin for refresh/edit requests. Access follows the existing host controls; the app does not add a separate login.

## Checks

```powershell
node --test test/*.test.js
```

Tests cover cache deduplication, persistence, failure fallback, refresh cooldown, pagination host validation, rate-limit backoff, standalone tests, audience negation, URL exclusions and traffic percentages.

API reference: https://docs.optimizely.com/web-experimentation/api/list-experiments

## Version control

This directory is a separate Git repository from the OptAPI operations tool. Run Git commands from this folder. The parent operations repository ignores `/campaign-dashboard/`. Credentials (`.env`), runtime snapshots, local annotation edits (`data/`), dependencies, and logs are excluded. `metadata.json` contains the curated US/CA tracker fallback metadata and is intentionally versioned. No cached Optimizely API responses are versioned.

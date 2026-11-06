# gw-shopify-agent

The Good Work Shopify build agent. Given a client's design (Figma, HTML prototype or mockup images), a store and a product sheet, it forks `gw-theme`, maps the design onto the library, builds the client theme, pushes an unpublished dev theme, loads the catalog, proposes apps, runs QA, and reports every step to the Good Work tracker. Four approval gates stop it for Cade.

Built on the Claude Agent SDK. Milestone 2 (terminal mode) — the tracker integration (milestone 4) calls the same runner from a Vercel Sandbox.

## Setup

```bash
npm install                      # Node 22+; installs the SDK, Shopify CLI 5, Playwright 1.63 (matches the preinstalled browser), zod 4
cp .env.example .env             # fill in the values below
```

`.env` (or real env vars):

| Variable | Required | What |
| --- | --- | --- |
| `SHOPIFY_CLI_THEME_TOKEN` | yes | Theme Access password for the client store (`shptka_…`) |
| `SHOPIFY_STOREFRONT_PASSWORD` | if the store is password-protected | lets the screenshot tools through the password page |
| `SHOPIFY_ADMIN_CLIENT_ID`, `SHOPIFY_ADMIN_CLIENT_SECRET` | for catalog, pages, menus | a Dev Dashboard app installed on the store (same Shopify organization), scopes `write_products, write_inventory, write_files, read_locations, write_publications, write_content, write_online_store_navigation`; the agent exchanges them for 24-hour tokens |
| `SHOPIFY_ADMIN_TOKEN` | alternative | legacy custom-app token (`shpat_…`) for apps created before 2026 |
| `GW_BASE_THEME` | no | git URL or local path of gw-theme (default `https://github.com/ccmedia365/gw-theme.git`) |
| `GW_BASE_THEME_TOKEN` | if gw-theme is private | GitHub token that can read gw-theme (falls back to `GW_AGENT_REPO_TOKEN`) |
| `GW_STAGING_STORE`, `GW_STAGING_THEME_TOKEN`, `GW_STAGING_PASSWORD` | no | Good Work staging store for design previews (gate 1); without them previews go to the client store as an unpublished theme |
| `FIGMA_TOKEN` | for Figma inputs | Figma personal access token |
| `GW_TRACKER_URL`, `GW_TRACKER_TOKEN` | no | when set, events/status/questions/artifacts also post to tracker.goodwork.io; otherwise they stay in `.gw-builds/<id>/` |
| `ANTHROPIC_API_KEY` | yes (or a logged-in Claude Code) | model access for the SDK |

## Run

```bash
npx tsx src/cli.ts run \
  --client bluff-and-pine --name "Bluff & Pine" \
  --store goodwork-9onfatyj.myshopify.com \
  --design html:./design/index.html \          # or figma:<url> or images:<dir>; repeatable
  --sheet ./products.csv \
  --brief-file ./brief.md
```

The run stops at the first gate (design preview) or question. Then:

```bash
npx tsx src/cli.ts status <buildId>                      # what happened, links, open question
npx tsx src/cli.ts approve <buildId> --note "..."        # approve a gate (notes are applied next phase)
npx tsx src/cli.ts approve <buildId> --apps "Klaviyo,Judge.me"   # at the app_selection gate
npx tsx src/cli.ts answer <buildId> "..."                # answer a needs_human question
npx tsx src/cli.ts resume <buildId>                      # continue after a crash
npx tsx src/cli.ts run ... --auto-approve --until qa     # smoke test straight through
```

Everything for a build lives in `.gw-builds/<buildId>/`: `build.json` (the record), `events.jsonl`, `design/` (ingested inputs + `design.json`), `gw-theme-<client>/` (the theme fork, committed on `build/<id>`), `mapping_report.md`, `qa/<label>/` screenshots and `report.json`, `phase-<name>.md` summaries, `catalog-issues.csv`.

## Running from the tracker

When the build record lives in tracker.goodwork.io (milestone 4), the tracker's Build tab launches the agent in a Vercel Sandbox with:

```bash
GW_TRACKER_URL=https://tracker.goodwork.io GW_TRACKER_TOKEN=… npx tsx src/cli.ts run-tracker <buildId>
```

`run-tracker` GETs `/api/builds/<id>` (record, store secrets, questions), mirrors status/notes/selected apps from the tracker, runs until the next gate or question, and writes back with `PATCH /api/builds/<id>`, `POST …/events`, `POST …/questions`, `POST …/artifacts` (multipart file uploads; a directory artifact uploads every png/md/csv/json inside it). The same command works on a laptop when the tracker is in local-runner mode.

## Phases and gates

`intake → ingesting_design → previewing → [preview_review] → extending_library → generating → pushing → [theme_review] → loading_catalog → [app_selection] → installing_apps → qa → [ready_for_review] → client_review → approved → published`

Gates in brackets. The agent can never set `client_review` or publish; those are human actions in the tracker.

## How it works

- `src/runner.ts` runs one Agent SDK `query()` per phase with the playbook (`src/prompts/playbook.md`) + the theme's `AGENTS.md` as the system prompt, the phase prompt (`src/prompts/phases.ts`) as the turn, and the session resumed across phases so context carries. A permission gate confines file writes to the build workspace and Bash to theme-build commands; `theme publish`, `rm -r`, and anything touching secrets are denied.
- `src/tools/*` are in-process MCP tools: design ingestion (`ingest_figma`, `ingest_html`, `ingest_images`), theme (`fork_base_theme`, `library_index`, `theme_check`, `theme_push`, `git_commit`), Shopify Admin (`admin_graphql`, `load_catalog`, `create_collection`, `store_info`), QA (`screenshot_pages`, `visual_diff`, `axe_check`, `smoke_cart`), tracker (`report_progress`, `attach_artifact`, `ask_cade`, `write_report`).
- The Shopify Dev MCP (`@shopify/dev-mcp`) is attached so the model looks up current docs and validates GraphQL/Liquid instead of guessing.

## Known limits (v0)

- GitHub push and PR creation are manual; the theme fork is committed locally on `build/<id>`.
- App installation is a human OAuth step; the agent prepares slots and settings.
- Images from the design are not uploaded to the store without an Admin token (`fileCreate`); placeholders are used.
- `visual_diff` is a pixel score, not a judgement; the agent also reads both images.

## Lessons baked in

- Shopify CLI must not inherit `npm_*`/`INIT_CWD` env vars from an `npx` parent: it resolves the theme root to the parent package and deletes the whole remote theme. `shopifyEnv()` strips them.
- `page.evaluate` callbacks must be strings under `tsx` (esbuild's `__name` helper breaks serialisation).
- Never `--nodelete` on push: the repo is the source of truth.

/**
 * Per-phase prompts. Each returns the user-turn prompt for that phase; the
 * playbook is the system prompt. Keep these concrete: what to do, what tools,
 * what "done" means, what to write to the tracker.
 */
import type { BuildRecord, Phase } from '../build.js';

function intake(r: BuildRecord) {
  const i = r.intake;
  return `# Phase: intake

Build ${r.id} for ${i.clientName} (${i.client}), store ${i.shopDomain}.
Brief: ${i.brief || '(none)'}
Design inputs: ${JSON.stringify(i.designInputs)}
Product sheet: ${i.productSheet || '(none)'} · Markets: ${(i.markets || ['default']).join(', ')} · Requested apps: ${(i.requestedApps || []).join(', ') || 'none'} · allow_new_sections: ${i.allowNewSections}
Pages required beyond the standard set: ${(i.pagesRequired || []).join(', ') || 'none'}

Do:
1. fork_base_theme, then Read AGENTS.md, DESIGN.md and gw.config.json in the theme directory.
2. store_info to confirm Admin API access (if it fails, note it — catalog loading will need a token later — and continue).
3. Write the "Client" section of DESIGN.md from the brief: brand summary and anything already known. Leave palette/type blank until the design is ingested.
4. report_progress with a two-line intake summary. Done when the theme directory exists and DESIGN.md has the client header filled.`;
}

function ingesting(r: BuildRecord) {
  return `# Phase: ingesting_design

Ingest every design input with the matching tool (ingest_figma / ingest_html / ingest_images), then Read the rendered images (frames, screenshots, mockups) so you have actually looked at the design, not only the outline. When an input has a \`pages\` array, pages[i] names the template the i-th source entry is for (Home, Collection, Product, …): use it instead of guessing from the picture, and record it as the page's template in design.json.

Write <workspace>/design/design.json (the build workspace path from the system prompt, NOT inside the theme directory): { pages: [{ name, source, regions: [{ order, kind, heading, text, media, buttons, notes, box }] }], tokens: { colors: [{hex, role}], fonts: {heading, body}, radius, spacing } }. Regions are top-to-bottom; kind is your best read (hero, product grid, feature row, testimonials, …). Do not map to the library yet.

report_progress with what you ingested and anything you could not read. Done when design.json exists and every rendered image has been read.`;
}

function previewing(r: BuildRecord) {
  return `# Phase: previewing (leads to gate 1)

1. Map design/design.json onto the library (library_index for schemas). Produce mapping_report.md (write_report kind=mapping_report) with a table per page: region → section + preset → blocks/settings → color scheme → confidence (exact/close/needs-new-section) → notes. List every needs-new-section with a one-line spec of the section you would build.
2. Apply the mapping to the client theme: settings_data.json (color schemes from the design tokens, fonts, radius, spacing, logo if present), templates/index.json, templates/collection.json, templates/product.json, header/footer groups, locale copy, DESIGN.md palette/type sections. Use real copy from the design; where the design has an image you cannot upload yet, use the theme placeholder.
3. theme_check until CLEAN, git_commit "preview 1: design mapped".
4. theme_push target=staging (if GW_STAGING_STORE is set) else target=client. Then screenshot_pages label="preview-1" for home, collection and product at all widths.
5. visual_diff each desktop screenshot against the matching design image when one exists; Read both images and judge the match yourself. If something is clearly off (wrong scheme, missing region, broken layout) fix it and repeat steps 3–5, at most 3 rounds.
6. attach_artifact kind=preview_images path=qa/preview-1 and finish with a summary: match quality per page, new sections needed, questions for Cade. Stop — Cade approves in the tracker.`;
}

function extending(r: BuildRecord) {
  return `# Phase: extending_library

Approved new sections/blocks from mapping_report.md (and Cade's notes: ${r.notes.join(' | ') || 'none'}) are built now, to the library contract in AGENTS.md: doc/comment header, section wrapper, tokens only, schema with common settings and presets, t: keys added to locales/en.default.schema.json via scripts/sync-schema-locales.py, gw.config.json updated, DESIGN.md "Components the design introduced" updated. theme_check CLEAN, then git_commit "library: add <names>". If nothing new is needed, say so and finish. report_progress per section built.`;
}

function generating(r: BuildRecord) {
  return `# Phase: generating

Finish the client theme: every required page template, menus referenced by handle (document which menus/collections the client must create or that you created via admin), 404/password/search/cart/account templates checked, agents.md.liquid present, favicon/og image settings, locale copy. Apply Cade's notes: ${r.notes.join(' | ') || 'none'}. Validate any Liquid you write with the Dev MCP. theme_check CLEAN, git_commit "theme: generated". report_progress when done.`;
}

function pushing(r: BuildRecord) {
  return `# Phase: pushing (leads to gate 2)

theme_push target=client (unpublished). Then screenshot_pages label="theme" for home, collection, product, cart, search and one blog/page at all widths; fix anything broken and push again (max 3 rounds). attach_artifact kind=screenshots path=qa/theme. Finish with the preview and editor URLs and a short list of what Cade should look at. Stop — Cade approves and shares in the tracker.`;
}

function loadingCatalog(r: BuildRecord) {
  return `# Phase: loading_catalog

${r.intake.productSheet ? `Product sheet: ${r.intake.productSheet}. Run load_catalog dry_run=true, review the issues, then load_catalog for real (limit to the first 5 first, check them in the store, then the rest). Create the collections the templates reference (create_collection), using automated rules where tags/types make sense. Attach catalog-issues.csv (kind=catalog_issues). Rows you cannot resolve → ask_cade once with the full list.` : 'No product sheet was provided. Confirm with store_info whether the store already has products; if it does, make sure the templates and menus point at real collections and skip loading. If it is empty, ask_cade for the sheet.'}`;
}

function appSelection(r: BuildRecord) {
  return `# Phase: app_selection (gate 3)

From the brief, requested apps (${(r.intake.requestedApps || []).join(', ') || 'none'}) and what the store needs (subscriptions? reviews? email? forms? loyalty?), write an app proposal (write_report kind=app_proposal): a table of need → recommended app (Shopify-native first; only apps that use app blocks/embeds, never script tags) → why → monthly cost → what the client must configure. Mark the ones you recommend installing. Do not install anything. Stop — Cade selects in the tracker.`;
}

function installingApps(r: BuildRecord) {
  return `# Phase: installing_apps

Selected apps: ${(r.selectedApps || []).join(', ') || 'none'}. App installation itself is a human step in the store admin (OAuth). For each selected app: place its app block/embed slot in the right template (@app blocks in main-product, gw-apps section, footer), add any theme settings it needs, and write the client-facing setup note. theme_check CLEAN, git_commit "apps: <names>", theme_push target=client. report_progress with the exact steps Cade/the client must do in the admin.`;
}

function qa(r: BuildRecord) {
  return `# Phase: qa (leads to gate 4)

1. screenshot_pages label="qa" for every template: home, collection, product (one with variants), cart, search, collections list, blog, article, page, contact, 404, login. All widths.
2. smoke_cart on a product with variants. axe_check on home, collection, product, cart.
3. Read the screenshots and compare against the design images; list visual differences.
4. write_report kind=punch_list: severity-ranked table (blocker / should-fix / nice-to-have) with page, width, issue, fix. Fix every blocker yourself now (theme_check, git_commit, theme_push), re-screenshot the affected pages, and update the list.
5. write_report kind=qa_report summarising results, Theme Check status, axe counts, what the client must still provide (images, copy, menus, apps).
Stop — Cade approves and shares to the client hub.`;
}

export const PHASE_PROMPTS: Partial<Record<Phase, (r: BuildRecord) => string>> = {
  intake,
  ingesting_design: ingesting,
  previewing,
  extending_library: extending,
  generating,
  pushing,
  loading_catalog: loadingCatalog,
  app_selection: appSelection,
  installing_apps: installingApps,
  qa,
};

/** Which phases run the model; gates and terminal states do not. */
export const RUNNABLE: Phase[] = Object.keys(PHASE_PROMPTS) as Phase[];

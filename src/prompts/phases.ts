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

ingest_images slices every screenshot into full-resolution tiles (design/tiles/) and samples its palette: Read every tile, top to bottom — a tall page shrunk into one frame hides the type, badges and spacing you must reproduce.

Write <workspace>/design/design.json (the build workspace path from the system prompt, NOT inside the theme directory): { pages: [{ name, template, source, regions: [{ order, kind, heading, text, media: { count, aspect, layout }, buttons, components (badges, chips, accordions, arrows, counters…), type: { face, case, weight, width }, colors: { bg, text, accent }, layout: { columns, align, sticky }, notes, box }] }], tokens: { colors: [{hex, role}], fonts: { heading: { face, fallback-in-shopify-library }, body: {…} }, radius, spacing }, header: {…}, announcement: {…}, footer: {…} }. Regions are top-to-bottom; kind is your best read (hero, product grid, feature row, testimonials, …). Quote copy verbatim. Do not map to the library yet.

report_progress with what you ingested and anything you could not read. Done when design.json exists and every rendered image has been read.`;
}

function previewing(r: BuildRecord) {
  return `# Phase: previewing (leads to gate 1: Cade compares your screenshots with the design, region by region)

Goal: the client store's dev theme renders the supplied design — every page the design covers, every region, faithfully (see "Fidelity is the job" in the playbook). allow_new_sections: ${r.intake.allowNewSections} (true → build what the design needs now).

1. Read every tile under design/tiles/ (and design.json). Map each page onto the library (library_index for schemas). Write mapping_report.md (write_report kind=mapping_report): a table per page, region → section + preset (or NEW: <gw-name>, one-line spec) → blocks/settings → colour scheme → confidence (exact / new-section) → what differs. Header, announcement bar and footer are rows in the table.
2. Build every NEW section/block now, in the client theme, to the library contract (AGENTS.md): sections/gw-<name>.liquid or blocks/_<name>.liquid, tokens only, common block settings, schema presets, t: keys synced (scripts/sync-schema-locales.py), gw.config.json entry, DESIGN.md "Components the design introduced". Validate Liquid with the Dev MCP tools. Where a library section is "close", change its settings or add a setting/block variant to make it exact — do not ship "close".
3. Apply the mapping: settings_data.json (colour schemes from the design, fonts from the Shopify font library that match the design's faces, radius, spacing, logo if present), templates/index.json, collection.json, product.json, header/footer groups, locale copy, DESIGN.md palette/type. Use the design's copy; where the design is another brand's, keep its layout and replace copy with clearly marked placeholders of the same length and case. Where the design has an image you cannot upload yet, use the theme placeholder at the same aspect ratio.
4. theme_check until CLEAN, git_commit "preview 1: design rebuilt".
5. theme_push target=client (an unpublished dev theme; reuse the existing one). screenshot_pages label="preview-1" for every page the design covers, at all widths. Tip: if the store has no suitable products/collections, screenshot the templates with whatever exists, but note it.
6. Compare: visual_diff each desktop screenshot against the design image, then Read your screenshot tiles and the design tiles side by side and check every region against the fidelity list (structure, layout, type, colour, components, copy, behaviour). Fix what differs — including building a section you skipped — then repeat 4–6. Keep going until the only differences left are ones you cannot fix from here (missing product data, images you cannot upload, fonts not in the Shopify library) — those go in the summary. Do not stop early to ask whether to build something the design clearly shows.
7. attach_artifact kind=preview_images path=qa/preview-1. Finish with a per-page summary: what matches, what cannot match yet and why, and the new sections built. Stop — Cade approves in the tracker.`;
}

function extending(r: BuildRecord) {
  return `# Phase: extending_library

The preview is approved. The new sections/blocks built in the client theme (see mapping_report.md and DESIGN.md "Components the design introduced") now become permanent library members so every future build has them: review each against AGENTS.md (doc header, section wrapper, tokens only, common settings, presets that make sense for other brands, no client copy baked in — copy belongs in settings with sensible defaults), generalise names and settings where they are client-specific, make sure gw.config.json and locales are complete, theme_check CLEAN, git_commit "library: add <names>". Apply Cade's notes: ${r.notes.join(' | ') || 'none'}. Then write <workspace>/library-upstream.md: the list of files to merge into gw-theme (sections/, blocks/, locale keys, gw.config.json entries) with a one-paragraph description of each, so the upstream PR can be opened. attach_artifact kind=library_upstream path=library-upstream.md. If nothing new was built, say so and finish. report_progress per section.`;
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

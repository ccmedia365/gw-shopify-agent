#!/usr/bin/env node
/**
 * gw-shopify-agent CLI
 *
 *   gw-shopify-agent run --client acme --name "Acme Co" --store acme.myshopify.com \
 *       --design html:./design/index.html --design figma:https://figma.com/file/... \
 *       --sheet ./products.csv --base https://github.com/ccmedia365/gw-theme.git
 *   gw-shopify-agent status [buildId]
 *   gw-shopify-agent approve <buildId> [--note "..."]
 *   gw-shopify-agent resume <buildId>
 *   gw-shopify-agent answer <buildId> "answer text"
 */
import 'dotenv/config';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { GATES, listBuilds, loadBuild, newBuild, newBuildWithId, saveBuild, type BuildIntake, type DesignInput, type Phase } from './build.js';
import { HttpTracker, makeTracker } from './tracker.js';
import { approve, runBuild } from './runner.js';

const program = new Command().name('gw-shopify-agent').description('Good Work Shopify build agent').version('0.1.0');

function parseDesign(values: string[]): DesignInput[] {
  return values.map((v) => {
    const [type, ...rest] = v.split(':');
    const source = rest.join(':');
    if (!['figma', 'html', 'images'].includes(type) || !source) throw new Error(`--design must be figma:<url>, html:<path>, or images:<dir> (got ${v})`);
    return { type: type as DesignInput['type'], source: /^https?:/.test(source) ? source : path.resolve(source) };
  });
}

program
  .command('run')
  .description('Create a build and run it until the first gate or question')
  .requiredOption('--client <slug>', 'client slug, e.g. no-thanks-sugar')
  .requiredOption('--name <name>', 'client display name')
  .requiredOption('--store <domain>', 'client store *.myshopify.com')
  .requiredOption('--design <input...>', 'figma:<url> | html:<path> | images:<dir> (repeatable)')
  .option('--sheet <csv>', 'product sheet CSV')
  .option('--base <repo>', 'gw-theme git URL or local path', process.env.GW_BASE_THEME || 'https://github.com/ccmedia365/gw-theme.git')
  .option('--password <pw>', 'storefront password')
  .option('--brief <text>', 'client brief')
  .option('--brief-file <path>', 'client brief from a file')
  .option('--markets <list>', 'comma-separated markets')
  .option('--apps <list>', 'comma-separated requested apps')
  .option('--pages <list>', 'comma-separated extra pages')
  .option('--allow-new-sections', 'allow the agent to build sections outside the library', false)
  .option('--auto-approve', 'walk through gates without stopping (smoke tests)', false)
  .option('--until <phase>', 'stop after this phase')
  .option('--budget <usd>', 'max spend per phase in USD', '15')
  .option('--model <model>', 'model alias or id')
  .option('--verbose', 'print raw SDK messages', false)
  .action(async (o) => {
    const intake: BuildIntake = {
      client: o.client,
      clientName: o.name,
      shopDomain: o.store,
      storefrontPassword: o.password || process.env.SHOPIFY_STOREFRONT_PASSWORD,
      designInputs: parseDesign(o.design),
      productSheet: o.sheet ? path.resolve(o.sheet) : undefined,
      markets: o.markets?.split(',').map((s: string) => s.trim()),
      requestedApps: o.apps?.split(',').map((s: string) => s.trim()),
      pagesRequired: o.pages?.split(',').map((s: string) => s.trim()),
      allowNewSections: !!o.allowNewSections,
      brief: o.briefFile ? fs.readFileSync(o.briefFile, 'utf8') : o.brief,
      baseThemeRepo: o.base,
    };
    const record = newBuild(intake);
    console.log(`Build ${record.id} → ${record.workdir}`);
    const tracker = makeTracker();
    const done = await runBuild(record, tracker, { autoApprove: o.autoApprove, until: o.until, maxBudgetUsd: Number(o.budget), model: o.model, verbose: o.verbose });
    printStatus(done);
  });

program
  .command('resume')
  .description('Continue a build from its next phase (after approve/answer)')
  .argument('<buildId>')
  .option('--auto-approve', '', false)
  .option('--until <phase>')
  .option('--budget <usd>', '', '15')
  .option('--model <model>')
  .option('--verbose', '', false)
  .action(async (id, o) => {
    const record = loadBuild(id);
    if (GATES.includes(record.status as Phase) && !o.autoApprove) {
      console.log(`Build is at gate ${record.status}. Run: gw-shopify-agent approve ${id} [--note "..."]`);
      return;
    }
    const done = await runBuild(record, makeTracker(), { autoApprove: o.autoApprove, until: o.until, maxBudgetUsd: Number(o.budget), model: o.model, verbose: o.verbose });
    printStatus(done);
  });

program
  .command('approve')
  .description('Approve the current gate (optionally with change notes) and continue')
  .argument('<buildId>')
  .option('--note <text>', 'reviewer notes the agent must apply')
  .option('--apps <list>', 'at the app_selection gate: comma-separated apps to install')
  .option('--no-run', 'approve only; do not continue running')
  .action(async (id, o) => {
    let record = loadBuild(id);
    if (o.apps) record.selectedApps = o.apps.split(',').map((s: string) => s.trim());
    record = approve(record, o.note);
    console.log(`Approved → next phase ${record.nextPhase}`);
    if (o.run === false) return;
    const done = await runBuild(record, makeTracker());
    printStatus(done);
  });

program
  .command('answer')
  .description('Answer the open question on a needs_human build and continue')
  .argument('<buildId>')
  .argument('<text>')
  .action(async (id, text) => {
    let record = loadBuild(id);
    if (record.status !== 'needs_human') throw new Error(`Build is ${record.status}, no open question`);
    record = approve(record, text);
    const done = await runBuild(record, makeTracker());
    printStatus(done);
  });

program
  .command('run-tracker')
  .description('Run (or continue) a build whose record lives in the Good Work tracker (GW_TRACKER_URL + GW_TRACKER_TOKEN)')
  .argument('<buildId>')
  .option('--budget <usd>', '', '20')
  .option('--model <model>')
  .option('--verbose', '', false)
  .action(async (id, o) => {
    const url = process.env.GW_TRACKER_URL; const token = process.env.GW_TRACKER_TOKEN;
    if (!url || !token) throw new Error('GW_TRACKER_URL and GW_TRACKER_TOKEN are required');
    const tracker = new HttpTracker(url, token);
    const { build, store, questions } = await tracker.fetchBuild(id);
    if (store) {
      process.env.SHOPIFY_CLI_THEME_TOKEN ||= store.theme_access_token || '';
      process.env.SHOPIFY_ADMIN_TOKEN ||= store.admin_api_token || '';
      process.env.SHOPIFY_STOREFRONT_PASSWORD ||= store.storefront_password || '';
    }
    let record: ReturnType<typeof loadBuild>;
    try { record = loadBuild(id); } catch { record = newBuildWithId(id, { ...build.intake, shopDomain: build.intake.shopDomain || store?.shop_domain, storefrontPassword: build.intake.storefrontPassword || store?.storefront_password, markets: build.intake.markets || store?.markets }); }
    // The tracker is the source of truth for status, notes, selected apps and answered questions.
    record.status = build.status; record.nextPhase = build.next_phase || record.nextPhase || 'intake';
    record.notes = build.notes || []; record.selectedApps = build.selected_apps || undefined; record.sessionId = build.session_id || record.sessionId;
    record.devThemeId = build.dev_theme_id || record.devThemeId; record.stagingThemeId = build.staging_theme_id || record.stagingThemeId;
    for (const q of questions || []) { const local = record.questions.find((x) => x.id === q.id); if (local) { local.answer = q.answer || local.answer; } else record.questions.push({ id: q.id, phase: q.phase, question: q.question, options: q.options || undefined, answer: q.answer || undefined }); }
    if (['needs_human', 'iterating', 'queued'].includes(record.status) || GATES.includes(record.status as Phase)) record.status = 'iterating';
    saveBuild(record);
    console.log(`Tracker build ${id}: resuming at ${record.nextPhase}`);
    const done = await runBuild(record, tracker, { maxBudgetUsd: Number(o.budget), model: o.model, verbose: o.verbose });
    printStatus(done);
  });

program
  .command('status')
  .description('Show a build (or list all builds)')
  .argument('[buildId]')
  .action((id) => {
    if (!id) {
      for (const b of listBuilds()) console.log(`${b.id.padEnd(40)} ${b.status.padEnd(18)} $${b.spendUsd.toFixed(2)}  ${b.updatedAt}`);
      return;
    }
    printStatus(loadBuild(id));
  });

program
  .command('note')
  .description('Add a reviewer note to a build without changing its status')
  .argument('<buildId>')
  .argument('<text>')
  .action((id, text) => {
    const r = loadBuild(id);
    r.notes.push(text);
    saveBuild(r);
    console.log('noted');
  });

function printStatus(r: ReturnType<typeof loadBuild>) {
  console.log(`\n${r.id}\n  status: ${r.status}  next: ${r.nextPhase ?? '-'}  spend: $${r.spendUsd.toFixed(2)}  turns: ${r.turns}`);
  if (r.previewUrl) console.log(`  preview: ${r.previewUrl}\n  editor:  ${r.editorUrl}`);
  const open = r.questions.filter((q) => !q.answer);
  if (open.length) console.log(`  QUESTION: ${open[0].question}${open[0].options ? '\n    options: ' + open[0].options.join(' | ') : ''}`);
  if (r.artifacts.length) console.log(`  artifacts:\n` + r.artifacts.slice(-8).map((a) => `    ${a.kind}: ${a.url ?? a.path}`).join('\n'));
  if (GATES.includes(r.status as Phase)) console.log(`  → gate: review, then  gw-shopify-agent approve ${r.id} [--note "..."]`);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exit(1);
});

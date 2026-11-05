/**
 * Theme tools: fork the base theme, read the library index, run Theme Check
 * and the strict parse check, push to a dev theme, list themes.
 * All Shopify CLI calls use SHOPIFY_FLAG_STORE / SHOPIFY_CLI_THEME_TOKEN from
 * the build record or env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { BuildRecord } from '../build.js';

const execFileP = promisify(execFile);
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export function shopifyEnv(record: BuildRecord, overrides: { store?: string; token?: string } = {}) {
  // Strip npm/npx context: with npm_package_json / INIT_CWD set, Shopify CLI resolves
  // the theme root to the *agent's* package instead of the cwd, sees no theme files,
  // and deletes everything on the remote theme.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_|^INIT_CWD$|^NODE$/.test(k)));
  return {
    ...clean,
    SHOPIFY_FLAG_STORE: overrides.store || record.intake.shopDomain,
    SHOPIFY_CLI_THEME_TOKEN: overrides.token || record.intake.themeToken || process.env.SHOPIFY_CLI_THEME_TOKEN || '',
    SHOPIFY_FLAG_FORCE: '1',
    SHOPIFY_CLI_NO_ANALYTICS: '1',
  };
}

async function shopify(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  try {
    const { stdout, stderr } = await execFileP('shopify', args, { cwd, env, maxBuffer: 50 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
  }
}

export const forkBaseTheme = (record: BuildRecord) =>
  tool(
    'fork_base_theme',
    'Clone the Good Work base theme (gw-theme) into the build workspace as gw-theme-<client>, on a new branch build/<build-id>. Returns the theme directory and the library index from gw.config.json. Call once at intake.',
    {},
    async () => {
      const dest = path.join(record.workdir, `gw-theme-${record.intake.client}`);
      if (!fs.existsSync(dest)) {
        const src = record.intake.baseThemeRepo;
        try {
          execFileSync('git', ['clone', '-q', src, dest], { stdio: 'pipe' });
        } catch (e: any) {
          return fail(`git clone ${src} failed: ${e.stderr?.toString() || e.message}`);
        }
        execFileSync('git', ['checkout', '-q', '-b', `build/${record.id}`], { cwd: dest });
      }
      record.themeDir = dest;
      const cfgPath = path.join(dest, 'gw.config.json');
      const cfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '{}';
      return text(`Theme forked to ${dest} (branch build/${record.id}). Read AGENTS.md and DESIGN.md there before editing.\n\ngw.config.json:\n${cfg}`);
    },
  );

export const libraryIndex = (record: BuildRecord) =>
  tool(
    'library_index',
    'Return the gw-theme library index (sections, blocks, settings ids, presets) from gw.config.json, optionally filtered to one section or block with its full schema JSON.',
    { name: z.string().optional().describe('A section or block file stem, e.g. gw-hero or _heading, to get its full schema') },
    async ({ name }) => {
      if (!record.themeDir) return fail('Fork the base theme first (fork_base_theme).');
      if (!name) return text(fs.readFileSync(path.join(record.themeDir, 'gw.config.json'), 'utf8'));
      const file = [path.join(record.themeDir, 'sections', `${name}.liquid`), path.join(record.themeDir, 'blocks', `${name}.liquid`)].find((f) => fs.existsSync(f));
      if (!file) return fail(`No section or block named ${name}`);
      const src = fs.readFileSync(file, 'utf8');
      const m = src.match(/{%\s*schema\s*%}([\s\S]*?){%\s*endschema\s*%}/);
      return text(`${path.relative(record.themeDir, file)} schema:\n${m ? m[1].trim() : '(none)'}`);
    },
    { annotations: { readOnlyHint: true } },
  );

export const themeCheck = (record: BuildRecord) =>
  tool(
    'theme_check',
    'Run Shopify Theme Check, the strict Liquid parse check and the template validator on the client theme. Returns a summary; must be clean (0 errors) before any push.',
    {},
    async () => {
      if (!record.themeDir) return fail('No theme directory yet.');
      const env = shopifyEnv(record);
      const tc = await shopify(['theme', 'check', '-o', 'json'], record.themeDir, env);
      let summary = '';
      try {
        const d = JSON.parse(tc.stdout);
        const issues = (d.issues || []) as any[];
        const errors = issues.filter((i) => i.severity === 'error');
        summary += `Theme Check: ${errors.length} errors, ${issues.length - errors.length} warnings\n`;
        for (const i of issues.slice(0, 40)) summary += `  [${i.severity}] ${path.relative(record.themeDir, i.filePath)}:${i.startRow + 1} ${i.check}: ${i.message}\n`;
      } catch {
        summary += `Theme Check output: ${tc.stdout.slice(0, 2000)} ${tc.stderr.slice(0, 1000)}\n`;
      }
      const parse = fs.existsSync(path.join(record.themeDir, 'scripts', 'parse-check.mjs'))
        ? await execFileP('node', ['scripts/parse-check.mjs'], { cwd: record.themeDir }).catch((e) => ({ stdout: e.stdout, stderr: e.stderr }))
        : { stdout: 'parse-check.mjs missing', stderr: '' };
      summary += `Strict parse: ${parse.stdout.trim()}\n`;
      const tpl = fs.existsSync(path.join(record.themeDir, 'scripts', 'validate-templates.py'))
        ? await execFileP('python3', ['scripts/validate-templates.py'], { cwd: record.themeDir }).catch((e) => ({ stdout: e.stdout, stderr: e.stderr }))
        : { stdout: 'validate-templates.py missing', stderr: '' };
      summary += `Templates: ${tpl.stdout.trim().split('\n').slice(-5).join('\n')}\n`;
      const clean = /0 errors/.test(summary) && /parse errors: 0/.test(summary) && /templates: 0 errors/.test(summary);
      return { ...text(summary + (clean ? '\nCLEAN' : '\nNOT CLEAN — fix before pushing')), isError: !clean };
    },
  );

export const themePush = (record: BuildRecord) =>
  tool(
    'theme_push',
    'Push the client theme to a store as an UNPUBLISHED theme (never the live theme). Remote files not in the local theme are removed so the store always mirrors the repo. target "client" = the client store from intake; "staging" = the Good Work staging store (GW_STAGING_STORE / GW_STAGING_THEME_TOKEN env) used for design previews. Reuses the existing theme id for the target when one exists. Returns preview and editor URLs.',
    {
      target: z.enum(['client', 'staging']),
      name: z.string().optional().describe('Theme name (default: "GW Build — <client> <date>")'),
    },
    async ({ target, name }) => {
      if (!record.themeDir) return fail('No theme directory yet.');
      const env =
        target === 'staging'
          ? shopifyEnv(record, { store: process.env.GW_STAGING_STORE, token: process.env.GW_STAGING_THEME_TOKEN || process.env.GW_STAGING_TOKEN })
          : shopifyEnv(record);
      if (!env.SHOPIFY_FLAG_STORE || !env.SHOPIFY_CLI_THEME_TOKEN) return fail(`Missing store or Theme Access token for ${target}.`);
      const existing = target === 'staging' ? record.stagingThemeId : record.devThemeId;
      const themeName = name || `GW Build — ${record.intake.clientName} ${new Date().toISOString().slice(0, 10)}`;
      const args = ['theme', 'push', '--json', ...(existing ? ['--theme', existing] : ['--unpublished', '--theme', themeName])];
      const res = await shopify(args, record.themeDir, env);
      let parsed: any = null;
      try {
        parsed = JSON.parse(res.stdout);
      } catch {
        /* fallthrough */
      }
      const diag = [...res.stderr.matchAll(/"level":"error","message":"([^"]*)/g)].map((m) => m[1].replace(/\\n/g, ' '));
      if (!parsed?.theme) return fail(`theme push failed.\n${res.stdout.slice(0, 1500)}\n${res.stderr.slice(-2000)}`);
      const t = parsed.theme;
      if (target === 'staging') record.stagingThemeId = String(t.id);
      else {
        record.devThemeId = String(t.id);
        record.previewUrl = t.previewUrl;
        record.editorUrl = t.editorUrl;
      }
      const errs = (parsed.errors || []).map((e: any) => `${path.relative(record.themeDir!, e.filePath)}: ${e.message}`);
      const all = [...new Set([...errs, ...diag])];
      return {
        ...text(`Pushed to ${env.SHOPIFY_FLAG_STORE} theme #${t.id} (${t.name}).\npreview: ${t.previewUrl}\neditor: ${t.editorUrl}` + (all.length ? `\n\nUPLOAD ERRORS (${all.length}) — fix and push again:\n${all.join('\n')}` : '\nNo upload errors.')),
        isError: all.length > 0,
      };
    },
  );

export const gitCommit = (record: BuildRecord) =>
  tool(
    'git_commit',
    'Commit all changes in the client theme on the build branch with a message. Returns the short SHA. (Pushing to GitHub and opening the PR happen outside the agent in v0.)',
    { message: z.string() },
    async ({ message }) => {
      if (!record.themeDir) return fail('No theme directory yet.');
      try {
        execFileSync('git', ['add', '-A'], { cwd: record.themeDir });
        execFileSync('git', ['-c', 'user.name=gw-shopify-agent', '-c', 'user.email=agent@goodwork.io', 'commit', '-q', '-m', message, '--allow-empty'], { cwd: record.themeDir });
        const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: record.themeDir }).toString().trim();
        return text(`Committed ${sha}: ${message}`);
      } catch (e: any) {
        return fail(e.stderr?.toString() || e.message);
      }
    },
  );

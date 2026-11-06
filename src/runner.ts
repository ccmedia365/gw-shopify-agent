/**
 * Phase runner: one Agent SDK query per phase, the playbook as system prompt,
 * the Good Work tools + Shopify Dev MCP available, session resumed across
 * phases so the model keeps its context. Gates stop the run; `approve`
 * advances it. Any phase can end in needs_human (ask_cade) or failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { query, createSdkMcpServer, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { GATES, PHASES, nextPhaseAfter, saveBuild, type BuildRecord, type Phase } from './build.js';
import type { Tracker } from './tracker.js';
import { PHASE_PROMPTS, RUNNABLE } from './prompts/phases.js';
import { ingestFigma, ingestHtml, ingestImages } from './tools/design.js';
import { forkBaseTheme, gitCommit, libraryIndex, themeCheck, themePush } from './tools/theme.js';
import { adminGraphqlTool, createCollection, loadCatalog, storeInfo } from './tools/shopify.js';
import { axeCheck, screenshotPages, smokeCart, visualDiff } from './tools/qa.js';
import { askCade, attachArtifact, reportProgress, writeReport } from './tools/tracker.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface RunOptions {
  autoApprove?: boolean; // walk through gates without stopping (smoke tests)
  until?: Phase; // stop after this phase
  maxBudgetUsd?: number;
  maxTurnsPerPhase?: number;
  model?: string;
  verbose?: boolean;
}

export function buildServer(record: BuildRecord, tracker: Tracker) {
  return createSdkMcpServer({
    name: 'gw',
    version: '0.1.0',
    instructions: 'Good Work build tools: design ingestion, theme operations, Shopify Admin, QA, tracker reporting.',
    tools: [
      ingestFigma(record),
      ingestHtml(record),
      ingestImages(record),
      forkBaseTheme(record),
      libraryIndex(record),
      themeCheck(record),
      themePush(record),
      gitCommit(record),
      adminGraphqlTool(record),
      loadCatalog(record),
      createCollection(record),
      storeInfo(record),
      screenshotPages(record),
      visualDiff(record),
      axeCheck(record),
      smokeCart(record),
      reportProgress(record, tracker),
      attachArtifact(record, tracker),
      askCade(record, tracker),
      writeReport(record, tracker),
    ],
  });
}

function systemPrompt(record: BuildRecord): string {
  const playbook = fs.readFileSync(path.join(here, 'prompts', 'playbook.md'), 'utf8');
  const agentsMd = record.themeDir && fs.existsSync(path.join(record.themeDir, 'AGENTS.md')) ? fs.readFileSync(path.join(record.themeDir, 'AGENTS.md'), 'utf8') : '';
  return [
    playbook,
    agentsMd ? `\n\n# Base theme rulebook (gw-theme/AGENTS.md)\n\n${agentsMd}` : '',
    `\n\n# Build context\n\nBuild id: ${record.id}\nWorkspace: ${record.workdir}\nTheme directory: ${record.themeDir || '(not forked yet)'}\nClient: ${record.intake.clientName} · store ${record.intake.shopDomain}\nStatus: ${record.status}`,
  ].join('');
}

/** Claude Code keeps session transcripts under ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl. */
function sessionExists(sessionId: string): boolean {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  if (!fs.existsSync(root)) return false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.name === `${sessionId}.jsonl`) return true;
    }
  }
  return false;
}

/** Summaries the earlier phases wrote (phase-<name>.md), to seed a fresh session with what already happened. */
function priorSummaries(record: BuildRecord): string {
  const files = fs.existsSync(record.workdir) ? fs.readdirSync(record.workdir).filter((f) => /^phase-.*\.md$/.test(f)) : [];
  if (!files.length) return '';
  const parts = files.map((f) => `## ${f}\n${fs.readFileSync(path.join(record.workdir, f), 'utf8').slice(0, 3000)}`);
  return `\n\n# What earlier phases did (you are continuing a build, not starting one)\n\n${parts.join('\n\n')}`;
}

export async function runPhase(record: BuildRecord, phase: Phase, tracker: Tracker, opts: RunOptions = {}): Promise<BuildRecord> {
  const makePrompt = PHASE_PROMPTS[phase];
  if (!makePrompt) throw new Error(`Phase ${phase} is not runnable`);
  await tracker.status(record, phase, { nextPhase: phase });
  const server = buildServer(record, tracker);
  const prompt = makePrompt(record) + (record.notes.length && phase !== 'extending_library' && phase !== 'generating' ? `\n\nReviewer notes to apply: ${record.notes.join(' | ')}` : '');

  let resultText = '';
  let subtype = '';
  const start = Date.now();
  let lastBeat = Date.now();
  // Resume the previous phase's session only when its transcript is actually on this machine; a fresh sandbox or a lost
  // snapshot would otherwise fail with "No conversation found". Without it the phase prompt + the phase-*.md summaries carry
  // enough context to continue.
  const resume = record.sessionId && sessionExists(record.sessionId) ? record.sessionId : undefined;
  if (record.sessionId && !resume) await tracker.event(record, { phase, level: 'warn', message: `Previous session ${record.sessionId} is not on this machine; starting a fresh session.` });
  try {
    for await (const message of query({
      prompt: resume ? prompt : prompt + priorSummaries(record),
      options: {
        cwd: record.themeDir || record.workdir,
        model: opts.model,
        systemPrompt: systemPrompt(record),
        settingSources: [],
        resume,
        maxTurns: opts.maxTurnsPerPhase ?? 120,
        maxBudgetUsd: opts.maxBudgetUsd,
        permissionMode: 'default',
        canUseTool: makePermissionGate(record),
        mcpServers: {
          gw: server,
          'shopify-dev': { type: 'stdio', command: 'npx', args: ['-y', '@shopify/dev-mcp@latest'], env: { OPT_OUT_INSTRUMENTATION: 'true' } },
        },
        allowedTools: ['mcp__gw__*', 'mcp__shopify-dev__*', 'Read', 'Glob', 'Grep', 'Agent'],
        disallowedTools: ['WebSearch', 'WebFetch'],
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
          CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3',
        },
        agents: {
          'design-reader': {
            description: 'Reads design images and outlines and returns a precise region-by-region description. Use when a design has many pages/frames.',
            prompt: 'You describe designs for a Shopify theme builder. For each image you are given, list regions top to bottom with: kind, headline copy, body copy, media (image/video count and ratio), buttons (labels), background color (hex guess), text color, layout (columns, alignment). Be exact; quote copy verbatim.',
            tools: ['Read', 'Glob'],
            maxTurns: 30,
          },
        },
      },
    }) as AsyncIterable<SDKMessage>) {
      handleMessage(message, record, opts);
      // Heartbeat every 90s: the tracker's stale-run banner otherwise fires during long quiet stretches (building sections).
      if (message.type === 'assistant' && tracker.heartbeat && Date.now() - lastBeat > 90_000) {
        lastBeat = Date.now();
        const tools = ((message as any).message?.content ?? []).filter((b: any) => b.type === 'tool_use').map((b: any) => b.name.replace(/^mcp__gw__/, ''));
        void tracker.heartbeat(record, `${phase}${tools.length ? ' — ' + tools.join(', ') : ''}`);
      }
      if (message.type === 'result') {
        subtype = message.subtype;
        resultText = 'result' in message ? String(message.result ?? '') : '';
        record.sessionId = message.session_id;
        record.spendUsd += message.total_cost_usd ?? 0;
        record.turns += message.num_turns ?? 0;
        saveBuild(record);
      }
    }
  } catch (err: any) {
    await tracker.event(record, { phase, level: 'error', message: `phase ${phase} crashed: ${err.message}` });
    await tracker.status(record, 'failed', { nextPhase: phase });
    throw err;
  }

  const mins = ((Date.now() - start) / 60000).toFixed(1);
  await tracker.event(record, { phase, level: 'info', message: `phase ${phase} finished (${subtype}, ${mins} min, $${record.spendUsd.toFixed(2)} so far)`, payload: { summary: resultText.slice(0, 4000) } });
  fs.writeFileSync(path.join(record.workdir, `phase-${phase}.md`), resultText);

  if (record.status === 'needs_human') {
    // ask_cade set this; keep nextPhase = this phase so it reruns after the answer
    await tracker.status(record, 'needs_human', { nextPhase: phase });
    return record;
  }
  if (subtype !== 'success') {
    await tracker.status(record, 'failed', { nextPhase: phase });
    return record;
  }
  const next = nextPhaseAfter(phase);
  if (!next) return record;
  if (GATES.includes(next)) {
    await tracker.status(record, next, { nextPhase: nextPhaseAfter(next) });
    return record;
  }
  await tracker.status(record, next, { nextPhase: next });
  return record;
}

/** Run phases from record.nextPhase until a gate, a question, a failure, `until`, or the end. */
export async function runBuild(record: BuildRecord, tracker: Tracker, opts: RunOptions = {}): Promise<BuildRecord> {
  let phase = record.nextPhase ?? 'intake';
  while (phase) {
    if (!RUNNABLE.includes(phase)) {
      // gate or terminal state reached
      if (GATES.includes(phase) && opts.autoApprove) {
        await tracker.event(record, { phase, level: 'warn', message: `auto-approving gate ${phase}` });
        phase = nextPhaseAfter(phase)!;
        continue;
      }
      break;
    }
    record = await runPhase(record, phase, tracker, opts);
    if (record.status === 'needs_human' || record.status === 'failed') break;
    if (opts.until === phase) break;
    if (GATES.includes(record.status as Phase)) {
      if (!opts.autoApprove) break;
      await tracker.event(record, { phase: record.status, level: 'warn', message: `auto-approving gate ${record.status}` });
    }
    const next = record.nextPhase;
    if (!next || next === phase) break;
    phase = next;
  }
  return record;
}

export function approve(record: BuildRecord, note?: string): BuildRecord {
  if (!GATES.includes(record.status as Phase) && record.status !== 'needs_human') throw new Error(`Build is ${record.status}, nothing to approve`);
  if (note) record.notes.push(note);
  if (record.status === 'needs_human') {
    const open = record.questions.find((q) => !q.answer);
    if (open && note) {
      open.answer = note;
      open.answeredAt = new Date().toISOString();
    }
  } else {
    const gate = record.status as Phase;
    record.sharedWithClient[gate] = record.sharedWithClient[gate] ?? '';
    record.nextPhase = nextPhaseAfter(gate);
  }
  record.status = 'iterating';
  saveBuild(record);
  return record;
}

/**
 * Permission gate: the agent may edit files only inside the build workspace
 * and may run only the commands a theme build needs (shopify theme check/push/
 * list, git, node/python scripts in the theme, ls/cat-style inspection). It can
 * never publish a theme, delete recursively, or touch anything outside the
 * workspace.
 */
const BASH_ALLOW = [
  /^shopify theme (check|push|list|info|console|pull)\b/,
  /^git (status|add|commit|diff|log|checkout|branch|rev-parse|show)\b/,
  /^(node|npx tsx|python3) (scripts\/|\.\/scripts\/)/,
  /^(npm (run|ci|install)|npx (prettier|eslint))\b/,
  /^(ls|cat|head|tail|wc|find|grep|rg|diff|mkdir -p|cp|mv|jq|sed -n|tree|pwd|echo)\b/,
];
const BASH_DENY = [/publish/, /rm -rf/, /\brm\b.*-r/, /sudo/, /curl .*\|\s*(sh|bash)/, /shptka_|shpat_/, />\s*\/etc/, /ssh\b/, /theme delete/];

function makePermissionGate(record: BuildRecord) {
  const inside = (p: string) => {
    const abs = path.resolve(record.themeDir || record.workdir, p);
    return abs.startsWith(record.workdir);
  };
  return async (toolName: string, input: Record<string, unknown>) => {
    const deny = (message: string) => ({ behavior: 'deny' as const, message });
    const allow = () => ({ behavior: 'allow' as const, updatedInput: input });
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
      const fp = String(input.file_path ?? input.path ?? '');
      return inside(fp) ? allow() : deny(`Writes are limited to the build workspace (${record.workdir}).`);
    }
    if (toolName === 'Bash') {
      const cmd = String(input.command ?? '').trim();
      if (BASH_DENY.some((r) => r.test(cmd))) return deny('That command is not allowed for the build agent.');
      const ok = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).every((part) => BASH_ALLOW.some((r) => r.test(part.trim())));
      return ok ? allow() : deny('Only theme-build commands are allowed (shopify theme check/push/list, git, node/python scripts, file inspection). Use the gw tools for everything else.');
    }
    return allow();
  };
}

function handleMessage(message: SDKMessage, record: BuildRecord, opts: RunOptions) {
  if (!opts.verbose) {
    if (message.type === 'assistant') {
      for (const block of (message as any).message?.content ?? []) {
        if (block.type === 'tool_use') console.log(`   ↳ ${block.name}${block.name.startsWith('mcp__gw__') ? ' ' + JSON.stringify(block.input).slice(0, 120) : ''}`);
      }
    }
    return;
  }
  console.log(JSON.stringify(message).slice(0, 2000));
}

export { PHASES };

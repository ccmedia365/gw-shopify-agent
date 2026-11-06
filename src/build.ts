/**
 * Build record — the single source of truth for one theme build.
 * Mirrors the `theme_builds` table in the Good Work tracker. In terminal mode
 * it lives at .gw-builds/<id>/build.json; the tracker runner reads/writes the
 * same shape through the HTTP tracker client.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PHASES = [
  'intake',
  'ingesting_design',
  'previewing',
  'preview_review', // gate 1
  'extending_library',
  'generating',
  'pushing',
  'theme_review', // gate 2
  'loading_catalog',
  'app_selection', // gate 3
  'installing_apps',
  'qa',
  'ready_for_review', // gate 4
  'client_review',
  'approved',
  'published',
] as const;
export type Phase = (typeof PHASES)[number];
export type Status = Phase | 'queued' | 'needs_human' | 'iterating' | 'failed';
export const GATES: Phase[] = ['preview_review', 'theme_review', 'app_selection', 'ready_for_review'];

export interface DesignInput {
  type: 'figma' | 'html' | 'images';
  /** Figma file URL or key, HTML file/dir path, or image directory */
  source: string;
  /** Optional: Figma page/frame names to restrict to */
  frames?: string[];
  /** Optional: pages[i] labels the i-th comma-separated entry of `source` (Home, Collection, Product, …) */
  pages?: string[];
}

export interface BuildIntake {
  client: string; // slug, e.g. "no-thanks-sugar"
  clientName: string;
  shopDomain: string; // *.myshopify.com
  storefrontPassword?: string;
  /** Theme Access password (shptka_…). Prefer env SHOPIFY_CLI_THEME_TOKEN. */
  themeToken?: string;
  /** Admin API access token (shpat_…). Prefer env SHOPIFY_ADMIN_TOKEN. */
  adminToken?: string;
  designInputs: DesignInput[];
  productSheet?: string; // CSV/XLSX path
  markets?: string[];
  requestedApps?: string[];
  allowNewSections: boolean;
  pagesRequired?: string[];
  brief?: string; // free text from the proposal
  baseThemeRepo: string; // git URL or local path to gw-theme
}

export interface BuildEvent {
  at: string;
  phase: Status;
  level: 'info' | 'warn' | 'question' | 'error' | 'artifact';
  message: string;
  payload?: Record<string, unknown>;
}

export interface BuildQuestion {
  id: string;
  phase: Status;
  question: string;
  options?: string[];
  answer?: string;
  answeredAt?: string;
}

export interface BuildRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: Status;
  /** Phase to resume at when status is needs_human / iterating / a gate */
  nextPhase?: Phase;
  intake: BuildIntake;
  workdir: string; // absolute path to the build workspace
  themeDir?: string; // the client theme fork inside workdir
  repoUrl?: string;
  branch?: string;
  prUrl?: string;
  devThemeId?: string;
  previewUrl?: string;
  editorUrl?: string;
  stagingThemeId?: string;
  sessionId?: string; // Agent SDK session for resume
  spendUsd: number;
  turns: number;
  questions: BuildQuestion[];
  artifacts: { kind: string; path: string; url?: string; phase: Status }[];
  sharedWithClient: Partial<Record<Phase, string>>;
  selectedApps?: string[];
  notes: string[]; // reviewer comments to apply on resume
}

export function buildsRoot(): string {
  return process.env.GW_BUILDS_DIR || path.resolve(process.cwd(), '.gw-builds');
}

export function buildPath(id: string): string {
  return path.join(buildsRoot(), id, 'build.json');
}

export function newBuild(intake: BuildIntake): BuildRecord {
  const id = `${intake.client}-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(2).toString('hex')}`;
  return newBuildWithId(id, intake);
}

/** Create a local record for a build whose id was minted elsewhere (the tracker). */
export function newBuildWithId(id: string, intake: BuildIntake): BuildRecord {
  const workdir = path.join(buildsRoot(), id);
  fs.mkdirSync(workdir, { recursive: true });
  const record: BuildRecord = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'queued',
    nextPhase: 'intake',
    intake,
    workdir,
    spendUsd: 0,
    turns: 0,
    questions: [],
    artifacts: [],
    sharedWithClient: {},
    notes: [],
  };
  saveBuild(record);
  return record;
}

export function loadBuild(id: string): BuildRecord {
  const p = buildPath(id);
  if (!fs.existsSync(p)) throw new Error(`No build ${id} at ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as BuildRecord;
}

export function saveBuild(record: BuildRecord): void {
  record.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(buildPath(record.id)), { recursive: true });
  fs.writeFileSync(buildPath(record.id), JSON.stringify(record, null, 2));
}

export function appendEvent(record: BuildRecord, event: Omit<BuildEvent, 'at'>): BuildEvent {
  const full: BuildEvent = { at: new Date().toISOString(), ...event };
  fs.appendFileSync(path.join(record.workdir, 'events.jsonl'), JSON.stringify(full) + '\n');
  return full;
}

export function listBuilds(): BuildRecord[] {
  const root = buildsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, 'build.json')))
    .map((d) => loadBuild(d))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function nextPhaseAfter(phase: Phase): Phase | undefined {
  const i = PHASES.indexOf(phase);
  return PHASES[i + 1];
}

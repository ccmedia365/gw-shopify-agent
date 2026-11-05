/**
 * Tracker client — how the agent reports to tracker.goodwork.io.
 * LocalTracker writes to the build folder (terminal mode).
 * HttpTracker posts to the tracker API (set GW_TRACKER_URL + GW_TRACKER_TOKEN).
 * Both keep the local record current so a build can always be inspected on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, saveBuild, type BuildEvent, type BuildRecord, type Status } from './build.js';

export interface Tracker {
  event(record: BuildRecord, e: Omit<BuildEvent, 'at'>): Promise<void>;
  status(record: BuildRecord, status: Status, patch?: Partial<BuildRecord>): Promise<void>;
  question(record: BuildRecord, question: string, options?: string[]): Promise<string>;
  artifact(record: BuildRecord, kind: string, filePath: string, url?: string): Promise<void>;
}

export class LocalTracker implements Tracker {
  constructor(private readonly log: (line: string) => void = (l) => console.log(l)) {}

  async event(record: BuildRecord, e: Omit<BuildEvent, 'at'>) {
    const full = appendEvent(record, e);
    const tag = e.level === 'info' ? '·' : e.level.toUpperCase();
    this.log(`[${full.at.slice(11, 19)}] ${record.status} ${tag} ${e.message}`);
  }

  async status(record: BuildRecord, status: Status, patch: Partial<BuildRecord> = {}) {
    Object.assign(record, patch, { status });
    saveBuild(record);
    await this.event(record, { phase: status, level: 'info', message: `status → ${status}` });
  }

  async question(record: BuildRecord, question: string, options?: string[]) {
    const id = `q${record.questions.length + 1}`;
    record.questions.push({ id, phase: record.status, question, options });
    saveBuild(record);
    await this.event(record, { phase: record.status, level: 'question', message: question, payload: { id, options } });
    return id;
  }

  async artifact(record: BuildRecord, kind: string, filePath: string, url?: string) {
    record.artifacts.push({ kind, path: filePath, url, phase: record.status });
    saveBuild(record);
    await this.event(record, { phase: record.status, level: 'artifact', message: `${kind}: ${url ?? filePath}` });
  }
}

/** Map the local camelCase record onto the tracker's theme_builds columns (agent-writable fields only). */
function toPatch(record: BuildRecord, status: Status) {
  return {
    status,
    next_phase: record.nextPhase ?? null,
    workdir: record.workdir,
    theme_dir: record.themeDir ?? null,
    repo_url: record.repoUrl ?? null,
    branch: record.branch ?? null,
    pr_url: record.prUrl ?? null,
    dev_theme_id: record.devThemeId ?? null,
    preview_url: record.previewUrl ?? null,
    editor_url: record.editorUrl ?? null,
    staging_theme_id: record.stagingThemeId ?? null,
    session_id: record.sessionId ?? null,
    spend_usd: Number(record.spendUsd.toFixed(4)),
    turns: record.turns,
  };
}

export class HttpTracker extends LocalTracker {
  constructor(private readonly baseUrl: string, private readonly token: string, log?: (line: string) => void) {
    super(log);
  }

  private url(path: string) {
    // Accept "tracker.goodwork.io" as well as "https://tracker.goodwork.io/".
    const base = this.baseUrl.trim().replace(/\/$/, '');
    return `${/^https?:\/\//i.test(base) ? base : `https://${base}`}${path}`;
  }

  private async send(method: 'POST' | 'PATCH' | 'GET', path: string, body?: unknown) {
    const res = await fetch(this.url(path), {
      method,
      headers: body instanceof FormData ? { Authorization: `Bearer ${this.token}` } : { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`tracker ${method} ${path} → ${res.status} ${await res.text()}`);
    return res.json().catch(() => ({}));
  }

  /** GET the build record + store secrets from the tracker. */
  async fetchBuild(id: string): Promise<{ build: any; store: any; questions: any[] }> {
    return this.send('GET', `/api/builds/${id}`);
  }

  /** Mark a build failed with an error event. Needs only the id, so it works even before the local record exists. */
  async reportFailure(id: string, message: string) {
    await this.send('POST', `/api/builds/${id}/events`, { phase: 'failed', level: 'error', message: message.slice(0, 3000) }).catch((err) => console.error(err.message));
    await this.send('PATCH', `/api/builds/${id}`, { status: 'failed', last_summary: message.slice(0, 500) }).catch((err) => console.error(err.message));
  }

  async patch(record: BuildRecord, status: Status, extra: Record<string, unknown> = {}) {
    await this.send('PATCH', `/api/builds/${record.id}`, { ...toPatch(record, status), ...extra }).catch((err) => console.error(err.message));
  }

  override async event(record: BuildRecord, e: Omit<BuildEvent, 'at'>) {
    await super.event(record, e);
    await this.send('POST', `/api/builds/${record.id}/events`, { phase: e.phase, level: e.level, message: e.message, payload: e.payload ?? null }).catch((err) => console.error(err.message));
  }

  override async status(record: BuildRecord, status: Status, patch: Partial<BuildRecord> = {}) {
    await super.status(record, status, patch);
    await this.patch(record, status);
  }

  override async question(record: BuildRecord, question: string, options?: string[]) {
    const id = await super.question(record, question, options);
    await this.send('POST', `/api/builds/${record.id}/questions`, { id, phase: record.status, question, options }).catch((err) => console.error(err.message));
    return id;
  }

  /** Files are uploaded (a directory → every png/md/csv/json/txt inside it, 25 MB cap each); URLs are posted as links. */
  override async artifact(record: BuildRecord, kind: string, filePath: string, url?: string) {
    await super.artifact(record, kind, filePath, url);
    try {
      if (url && !fs.existsSync(filePath)) {
        await this.send('POST', `/api/builds/${record.id}/artifacts`, { kind, url, phase: record.status });
        return;
      }
      const files = fs.statSync(filePath).isDirectory()
        ? fs.readdirSync(filePath).filter((f) => /\.(png|jpe?g|webp|md|csv|json|txt)$/i.test(f)).map((f) => path.join(filePath, f))
        : [filePath];
      const form = new FormData();
      form.set('kind', kind);
      form.set('phase', record.status);
      for (const f of files) {
        const st = fs.statSync(f);
        if (st.size > 25 * 1024 * 1024) continue;
        const mime = /\.png$/i.test(f) ? 'image/png' : /\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.md$/i.test(f) ? 'text/markdown' : /\.csv$/i.test(f) ? 'text/csv' : /\.json$/i.test(f) ? 'application/json' : 'text/plain';
        form.append('file', new Blob([fs.readFileSync(f)], { type: mime }), path.basename(f));
      }
      await this.send('POST', `/api/builds/${record.id}/artifacts`, form);
    } catch (err: any) {
      console.error(err.message);
    }
  }
}

export function makeTracker(): Tracker {
  const url = process.env.GW_TRACKER_URL;
  const token = process.env.GW_TRACKER_TOKEN;
  if (url && token) return new HttpTracker(url, token);
  return new LocalTracker();
}

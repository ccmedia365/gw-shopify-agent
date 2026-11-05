/**
 * Tracker tools the model calls to report progress, attach artifacts, ask
 * Cade a question (which stops the phase with needs_human), and record the
 * mapping report / punch list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { BuildRecord } from '../build.js';
import type { Tracker } from '../tracker.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export const reportProgress = (record: BuildRecord, tracker: Tracker) =>
  tool(
    'report_progress',
    'Post a short progress line to the tracker (shows live in the build stepper). Use at every meaningful step: what you did, what you found, what is next.',
    { message: z.string().max(400), level: z.enum(['info', 'warn']).default('info') },
    async ({ message, level }) => {
      await tracker.event(record, { phase: record.status, level, message });
      return text('ok');
    },
  );

export const attachArtifact = (record: BuildRecord, tracker: Tracker) =>
  tool(
    'attach_artifact',
    'Attach a file in the build folder to the tracker as a named artifact (mapping_report, preview_images, punch_list, catalog_issues, design_md, qa_report, screenshots, other).',
    { kind: z.enum(['mapping_report', 'preview_images', 'punch_list', 'catalog_issues', 'design_md', 'qa_report', 'screenshots', 'app_proposal', 'other']), path: z.string(), url: z.string().optional() },
    async ({ kind, path: p, url }) => {
      const abs = path.isAbsolute(p) ? p : path.join(record.workdir, p);
      if (!fs.existsSync(abs)) return { ...text(`Not found: ${abs}`), isError: true };
      await tracker.artifact(record, kind, abs, url);
      return text(`attached ${kind}: ${abs}`);
    },
  );

export const askCade = (record: BuildRecord, tracker: Tracker) =>
  tool(
    'ask_cade',
    'Stop and ask Cade a specific question when you cannot proceed without a decision (missing price/SKU, ambiguous design element, an app not on the list, a new section outside the library when allow_new_sections is false). The phase ends with status needs_human; the build resumes when he answers. Ask once with everything you need, not one question per turn.',
    { question: z.string(), options: z.array(z.string()).optional() },
    async ({ question, options }) => {
      const id = await tracker.question(record, question, options);
      record.status = 'needs_human';
      return text(`Question ${id} posted. Finish the turn now: summarise what is done, what is blocked, and stop.`);
    },
  );

export const writeReport = (record: BuildRecord, tracker: Tracker) =>
  tool(
    'write_report',
    'Write a markdown report into the build folder and attach it (mapping report, punch list, app proposal, QA summary).',
    { kind: z.enum(['mapping_report', 'punch_list', 'app_proposal', 'qa_report']), markdown: z.string() },
    async ({ kind, markdown }) => {
      const file = path.join(record.workdir, `${kind}.md`);
      fs.writeFileSync(file, markdown);
      await tracker.artifact(record, kind, file);
      return text(`wrote ${file}`);
    },
  );

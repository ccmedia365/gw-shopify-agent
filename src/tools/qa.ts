/**
 * QA tools: screenshot the dev theme at three widths through the storefront
 * password gate, compare a render against a design image (pixel diff), run
 * axe accessibility checks, and smoke-test the add-to-cart flow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { BuildRecord } from '../build.js';
import { tileImages } from './design.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });
const WIDTHS = { phone: 390, tablet: 768, desktop: 1440 } as const;

async function openPreview(browser: Browser, store: string, themeId: string, password?: string): Promise<Page> {
  const page = await browser.newPage();
  const base = `https://${store}`;
  if (password) {
    await page.goto(`${base}/password?preview_theme_id=${themeId}`);
    const input = page.locator('input[type=password]');
    if (await input.count()) {
      await input.fill(password);
      await Promise.all([page.waitForNavigation().catch(() => {}), page.click('button[type=submit], input[type=submit]').catch(() => {})]);
    }
  }
  await page.goto(`${base}/?preview_theme_id=${themeId}`, { waitUntil: 'networkidle' });
  return page;
}

function target(record: BuildRecord, which: 'client' | 'staging') {
  return which === 'staging'
    ? { store: process.env.GW_STAGING_STORE || '', themeId: record.stagingThemeId || '', password: process.env.GW_STAGING_PASSWORD }
    : { store: record.intake.shopDomain, themeId: record.devThemeId || '', password: record.intake.storefrontPassword };
}

export const screenshotPages = (record: BuildRecord) =>
  tool(
    'screenshot_pages',
    'Screenshot storefront paths on the pushed dev theme (client or staging store) at phone/tablet/desktop into <workdir>/qa/<label>/<name>-<width>.png. Also reports per page: HTTP status, h1 count, "Liquid error" occurrences, horizontal overflow and JS page errors. Read the PNGs afterwards to judge them visually.',
    {
      target: z.enum(['client', 'staging']).default('client'),
      pages: z.record(z.string(), z.string()).describe('name → path, e.g. {"home":"/","collection":"/collections/all","product":"/products/<handle>"}'),
      widths: z.array(z.enum(['phone', 'tablet', 'desktop'])).optional(),
      label: z.string().optional().describe('Subfolder label, e.g. "preview-1" or "qa"'),
    },
    async ({ target: which, pages, widths, label }) => {
      const t = target(record, which);
      if (!t.store || !t.themeId) return fail(`No ${which} theme pushed yet.`);
      const dir = path.join(record.workdir, 'qa', label || which);
      fs.mkdirSync(dir, { recursive: true });
      const browser = await chromium.launch();
      const report: any[] = [];
      try {
        const page = await openPreview(browser, t.store, t.themeId, t.password);
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        for (const [name, p] of Object.entries(pages)) {
          for (const w of widths || (Object.keys(WIDTHS) as (keyof typeof WIDTHS)[])) {
            await page.setViewportSize({ width: WIDTHS[w], height: 900 });
            const resp = await page.goto(`https://${t.store}${p}`, { waitUntil: 'networkidle' }).catch(() => null);
            await page.waitForTimeout(400);
            const file = path.join(dir, `${name}-${w}.png`);
            await page.screenshot({ path: file, fullPage: true });
            const facts: any = await page.evaluate(`({
              h1: document.querySelectorAll('h1').length,
              liquidErrors: (document.body.innerText.match(/Liquid error/gi) || []).length,
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              title: document.title,
            })`);
            report.push({ page: name, width: w, status: resp?.status(), file, ...facts });
          }
        }
        fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ report, errors }, null, 2));
        const problems = report.filter((r) => r.status !== 200 || r.h1 !== 1 || r.liquidErrors || r.overflow > 1);
        // Desktop shots are tall; tile them so they can be read at full resolution next to the design tiles.
        const tiled = await tileImages(report.filter((r) => r.width === 'desktop').map((r) => r.file), path.join(dir, 'tiles')).catch(() => ({ images: [] as { file: string; tiles: string[] }[] }));
        const tileLines = tiled.images.map((im) => `${path.basename(im.file)} tiles: ${im.tiles.join(', ')}`);
        return text(
          `${report.length} screenshots in ${dir}.\n` +
            report.map((r) => `${r.page}-${r.width}: ${r.status} h1=${r.h1} liquidErrors=${r.liquidErrors} overflow=${r.overflow}px → ${r.file}`).join('\n') +
            (tileLines.length ? `\n\nFull-resolution tiles (read these when comparing with the design tiles):\n${tileLines.join('\n')}` : '') +
            (errors.length ? `\nJS errors: ${[...new Set(errors)].slice(0, 5).join(' | ')}` : '\nNo JS page errors.') +
            (problems.length ? `\n\nPROBLEMS: ${problems.length}` : '\n\nAll pages clean.'),
        );
      } finally {
        await browser.close();
      }
    },
  );

export const visualDiff = (record: BuildRecord) =>
  tool(
    'visual_diff',
    'Compare a rendered screenshot against a design image (Figma frame export, HTML prototype screenshot or mockup). Resizes the render to the design width, crops both to the shorter height, writes a diff PNG and returns the mismatch percentage. Use it to judge how close a preview is; combine with your own visual read of both images.',
    { render: z.string().describe('Path to the storefront screenshot'), design: z.string().describe('Path to the design image'), out: z.string().optional() },
    async ({ render, design, out }) => {
      if (!fs.existsSync(render) || !fs.existsSync(design)) return fail('render or design file not found');
      const a = PNG.sync.read(fs.readFileSync(render));
      const b = PNG.sync.read(fs.readFileSync(design));
      // Scale render to design width with nearest-neighbour (good enough for a mismatch score)
      const scale = b.width / a.width;
      const scaled = new PNG({ width: b.width, height: Math.round(a.height * scale) });
      for (let y = 0; y < scaled.height; y++)
        for (let x = 0; x < scaled.width; x++) {
          const sx = Math.min(a.width - 1, Math.floor(x / scale));
          const sy = Math.min(a.height - 1, Math.floor(y / scale));
          const si = (sy * a.width + sx) * 4;
          const di = (y * scaled.width + x) * 4;
          scaled.data[di] = a.data[si];
          scaled.data[di + 1] = a.data[si + 1];
          scaled.data[di + 2] = a.data[si + 2];
          scaled.data[di + 3] = 255;
        }
      const h = Math.min(scaled.height, b.height);
      const w = b.width;
      const crop = (img: PNG) => {
        const c = new PNG({ width: w, height: h });
        PNG.bitblt(img, c, 0, 0, w, h, 0, 0);
        return c;
      };
      const ca = crop(scaled);
      const cb = crop(b);
      const diff = new PNG({ width: w, height: h });
      const mismatched = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.15 });
      const outPath = out || render.replace(/\.png$/, '.diff.png');
      fs.writeFileSync(outPath, PNG.sync.write(diff));
      const pct = (mismatched / (w * h)) * 100;
      return text(`Mismatch ${pct.toFixed(2)}% over ${w}×${h} (render ${a.width}×${a.height} scaled ×${scale.toFixed(2)}, design ${b.width}×${b.height}; heights differ by ${Math.abs(scaled.height - b.height)}px). Diff: ${outPath}`);
    },
    { annotations: { readOnlyHint: true } },
  );

export const axeCheck = (record: BuildRecord) =>
  tool(
    'axe_check',
    'Run axe-core accessibility checks on storefront paths of the pushed dev theme. Returns violations grouped by impact.',
    { target: z.enum(['client', 'staging']).default('client'), paths: z.array(z.string()) },
    async ({ target: which, paths }) => {
      const t = target(record, which);
      if (!t.store || !t.themeId) return fail(`No ${which} theme pushed yet.`);
      const { AxeBuilder } = await import('@axe-core/playwright');
      const browser = await chromium.launch();
      try {
        const page = await openPreview(browser, t.store, t.themeId, t.password);
        const out: string[] = [];
        for (const p of paths) {
          await page.goto(`https://${t.store}${p}`, { waitUntil: 'networkidle' });
          const results = await new AxeBuilder({ page: page as any }).withTags(['wcag2a', 'wcag2aa']).exclude('#shopify-section-preview-bar, [id^="PBar"], .shopify-preview-bar').analyze();
          const v = results.violations;
          out.push(`${p}: ${v.length} violations` + v.map((x) => `\n  [${x.impact}] ${x.id}: ${x.help} (${x.nodes.length} nodes) e.g. ${x.nodes[0]?.target?.join(' ')}`).join(''));
        }
        fs.writeFileSync(path.join(record.workdir, 'qa', 'axe.txt'), out.join('\n\n'));
        return text(out.join('\n\n'));
      } finally {
        await browser.close();
      }
    },
  );

export const smokeCart = (record: BuildRecord) =>
  tool(
    'smoke_cart',
    'Open a product page on the pushed dev theme, click Add to cart, and verify the cart drawer opens with one item; also checks predictive search and the mobile menu. Returns pass/fail facts.',
    { target: z.enum(['client', 'staging']).default('client'), product_path: z.string().describe('e.g. /products/<handle>') },
    async ({ target: which, product_path }) => {
      const t = target(record, which);
      if (!t.store || !t.themeId) return fail(`No ${which} theme pushed yet.`);
      const browser = await chromium.launch();
      try {
        const page = await openPreview(browser, t.store, t.themeId, t.password);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`https://${t.store}${product_path}`, { waitUntil: 'networkidle' });
        const add = page.locator('button[name="add"]').first();
        const facts: Record<string, unknown> = { addButton: await add.count() };
        if (await add.count()) {
          await add.click();
          await page.waitForTimeout(2500);
          facts.drawerOpen = (await page.locator('#CartDrawer[open]').count()) === 1;
          facts.cartCount = (await page.locator('[data-cart-count]').first().textContent())?.trim();
        }
        await page.keyboard.press('Escape');
        await page.click('[data-drawer-open="SearchModal"]').catch(() => {});
        await page.fill('#SearchModal input[type=search]', 'a').catch(() => {});
        await page.waitForTimeout(1500);
        facts.predictiveResults = await page.locator('#PredictiveSearchResults a').count();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload({ waitUntil: 'networkidle' });
        await page.click('[data-drawer-open="MenuDrawer"]').catch(() => {});
        await page.waitForTimeout(300);
        facts.menuDrawerOpen = (await page.locator('#MenuDrawer[open]').count()) === 1;
        const pass = facts.addButton && facts.drawerOpen && facts.menuDrawerOpen;
        return { ...text(JSON.stringify(facts) + (pass ? '\nPASS' : '\nFAIL')), isError: !pass };
      } finally {
        await browser.close();
      }
    },
  );

/**
 * Design ingestion tools: Figma (REST API), HTML prototypes (Playwright) and
 * image/PDF mockups. Each writes a normalised summary into
 * <workdir>/design/ so the model can map regions onto the gw-theme library.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { chromium } from 'playwright';
import type { BuildRecord } from '../build.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

function designDir(record: BuildRecord) {
  const d = path.join(record.workdir, 'design');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* ---------------- Figma ---------------- */

function figmaKey(source: string): string {
  const m = source.match(/figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/);
  return m ? m[1] : source;
}

function summariseNode(node: any, depth = 0, out: any[] = [], maxDepth = 4): any[] {
  if (!node || depth > maxDepth) return out;
  const entry: any = { name: node.name, type: node.type };
  if (node.absoluteBoundingBox) {
    const b = node.absoluteBoundingBox;
    entry.box = [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
  }
  if (node.type === 'TEXT' && node.characters) entry.text = String(node.characters).slice(0, 300);
  if (node.style?.fontFamily) entry.font = `${node.style.fontFamily} ${node.style.fontWeight ?? ''} ${node.style.fontSize ?? ''}`.trim();
  const fills = (node.fills || []).filter((f: any) => f.type === 'SOLID' && f.visible !== false);
  if (fills.length) {
    const c = fills[0].color;
    entry.fill = '#' + [c.r, c.g, c.b].map((v: number) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  }
  if (node.type === 'RECTANGLE' && (node.fills || []).some((f: any) => f.type === 'IMAGE')) entry.image = true;
  if (node.children?.length && depth < maxDepth) entry.children = node.children.map((c: any) => summariseNode(c, depth + 1, [], maxDepth)[0]).filter(Boolean);
  out.push(entry);
  return out;
}

export const ingestFigma = (record: BuildRecord) =>
  tool(
    'ingest_figma',
    'Read a Figma file through the REST API (FIGMA_TOKEN env). Writes design/figma.json (pages → top-level frames with a structural outline: names, boxes, text, fonts, fills) and renders each top-level frame to design/frames/<page>--<frame>.png. Returns the outline summary.',
    {
      source: z.string().describe('Figma file URL or file key'),
      frames: z.array(z.string()).optional().describe('Only these frame names (default: all top-level frames on every page)'),
      max_frames: z.number().int().min(1).max(40).optional(),
    },
    async ({ source, frames, max_frames }) => {
      const token = process.env.FIGMA_TOKEN;
      if (!token) return fail('FIGMA_TOKEN is not set. Ask Cade for a Figma personal access token (Figma → Settings → Security → Personal access tokens) or provide an HTML/image export instead.');
      const key = figmaKey(source);
      const headers = { 'X-Figma-Token': token };
      const res = await fetch(`https://api.figma.com/v1/files/${key}?depth=2`, { headers });
      if (!res.ok) return fail(`Figma API ${res.status}: ${await res.text()}`);
      const file: any = await res.json();
      const dir = designDir(record);
      const pages = (file.document?.children || []).map((page: any) => ({
        name: page.name,
        frames: (page.children || [])
          .filter((n: any) => ['FRAME', 'COMPONENT', 'SECTION'].includes(n.type))
          .filter((n: any) => !frames || frames.includes(n.name))
          .map((n: any) => ({ id: n.id, name: n.name, width: n.absoluteBoundingBox?.width, height: n.absoluteBoundingBox?.height })),
      }));
      const wanted = pages.flatMap((p: any) => p.frames.map((f: any) => ({ ...f, page: p.name }))).slice(0, max_frames ?? 20);
      // Full node trees for the wanted frames
      const ids = wanted.map((f: any) => f.id).join(',');
      const nodesRes = await fetch(`https://api.figma.com/v1/files/${key}/nodes?ids=${encodeURIComponent(ids)}&depth=6`, { headers });
      const nodes: any = nodesRes.ok ? await nodesRes.json() : { nodes: {} };
      const outline = wanted.map((f: any) => ({ page: f.page, frame: f.name, width: f.width, height: f.height, tree: summariseNode(nodes.nodes?.[f.id]?.document)[0] }));
      // Renders
      fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
      const imgRes = await fetch(`https://api.figma.com/v1/images/${key}?ids=${encodeURIComponent(ids)}&format=png&scale=1`, { headers });
      const images: any = imgRes.ok ? await imgRes.json() : { images: {} };
      const rendered: string[] = [];
      for (const f of wanted) {
        const url = images.images?.[f.id];
        if (!url) continue;
        const png = await fetch(url);
        const file = path.join(dir, 'frames', `${slug(f.page)}--${slug(f.name)}.png`);
        fs.writeFileSync(file, Buffer.from(await png.arrayBuffer()));
        rendered.push(file);
      }
      const styles = Object.entries(file.styles || {}).map(([id, s]: any) => ({ id, name: s.name, type: s.styleType }));
      const summary = { file: file.name, lastModified: file.lastModified, pages, styles, outline, rendered };
      fs.writeFileSync(path.join(dir, 'figma.json'), JSON.stringify(summary, null, 2));
      return text(`Figma "${file.name}": ${wanted.length} frames captured, ${rendered.length} rendered to design/frames/. Outline written to design/figma.json.\n` + JSON.stringify({ pages, rendered }, null, 1));
    },
    { annotations: { readOnlyHint: false, openWorldHint: true } },
  );

/* ---------------- HTML prototype ---------------- */

const WIDTHS = { phone: 390, tablet: 768, desktop: 1440 } as const;

export const ingestHtml = (record: BuildRecord) =>
  tool(
    'ingest_html',
    'Render an HTML prototype (file, directory with index.html, or URL) with Playwright at 390/768/1440, screenshot each width to design/html/<page>-<width>.png, and extract a DOM outline (top-level sections with headings, text, images, buttons, links) plus computed design tokens (colors, font families, font sizes, radii) to design/html.json. Returns the outline.',
    {
      source: z.string().describe('Path to .html, a directory containing index.html, or an http(s) URL'),
      pages: z.array(z.string()).optional().describe('Additional relative pages to render (e.g. ["collection.html","product.html"])'),
    },
    async ({ source, pages }) => {
      const dir = path.join(designDir(record), 'html');
      fs.mkdirSync(dir, { recursive: true });
      const browser = await chromium.launch();
      try {
        // A downloadable export (…/x.html or …/x.zip, including signed tracker links) is fetched first so relative pages and assets work.
        if (/^https?:/.test(source) && /\.(zip|html?)(\?|$)/i.test(source)) {
          const dl = await download(source, path.join(designDir(record), 'html-src'));
          if (/\.zip$/i.test(dl.file)) {
            const { execSync } = await import('node:child_process');
            const unz = path.join(designDir(record), 'html-src', 'unzipped');
            fs.mkdirSync(unz, { recursive: true });
            execSync(`unzip -qo "${dl.file}" -d "${unz}"`);
            const found = fs.readdirSync(unz, { recursive: true } as any).map(String).find((f) => /(^|\/)index\.html?$/i.test(f)) || fs.readdirSync(unz, { recursive: true } as any).map(String).find((f) => /\.html?$/i.test(f));
            if (!found) return fail('The zip has no .html file.');
            source = path.join(unz, found);
          } else source = dl.file;
        }
        const targets = [source, ...(pages || [])].map((p, i) => ({ name: i === 0 ? 'home' : slug(path.basename(p).replace(/\.html?$/, '')), src: i === 0 ? p : path.join(path.dirname(source), p) }));
        const result: any[] = [];
        for (const t of targets) {
          let url = t.src;
          if (!/^https?:/.test(url)) {
            let p = path.resolve(url);
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
            if (!fs.existsSync(p)) return fail(`Not found: ${p}`);
            url = 'file://' + p;
          }
          const page = await browser.newPage();
          const shots: Record<string, string> = {};
          for (const [w, width] of Object.entries(WIDTHS)) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(url, { waitUntil: 'networkidle' }).catch(() => page.goto(url));
            await page.waitForTimeout(300);
            const file = path.join(dir, `${t.name}-${w}.png`);
            await page.screenshot({ path: file, fullPage: true });
            shots[w] = file;
          }
          const analysis: any = await page.evaluate(`(() => {
            const colorCount = new Map();
            const fonts = new Map();
            const sizes = new Map();
            const radii = new Map();
            const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
            document.querySelectorAll('body *').forEach((el) => {
              const cs = getComputedStyle(el);
              if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bump(colorCount, cs.backgroundColor);
              if (cs.color) bump(colorCount, cs.color);
              bump(fonts, cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim());
              if (/^H[1-6]$|^P$|^A$|^BUTTON$|^SPAN$|^LI$/.test(el.tagName)) bump(sizes, \`\${el.tagName.toLowerCase()}:\${cs.fontSize}/\${cs.fontWeight}\`);
              if (cs.borderRadius && cs.borderRadius !== '0px') bump(radii, cs.borderRadius);
            });
            const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ value: k, count: v }));
            const sectionEls = [...document.querySelectorAll('header, nav, main > *, body > section, body > div > section, footer')];
            const sections = sectionEls.slice(0, 40).map((el) => {
              const rect = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              const grab = (sel, n = 6) => [...el.querySelectorAll(sel)].slice(0, n).map((e) => e.innerText?.trim().slice(0, 140)).filter(Boolean);
              return {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                classes: [...el.classList].slice(0, 4).join(' ') || undefined,
                top: Math.round(rect.top + window.scrollY),
                height: Math.round(rect.height),
                background: cs.backgroundColor,
                headings: grab('h1,h2,h3'),
                paragraphs: grab('p', 4),
                buttons: grab('a.button, a.btn, button, [class*=button], [class*=btn]', 6),
                images: [...el.querySelectorAll('img')].slice(0, 8).map((i) => ({ alt: i.alt, w: i.naturalWidth, h: i.naturalHeight })),
                videos: el.querySelectorAll('video, iframe').length,
                forms: el.querySelectorAll('form').length,
                links: el.querySelectorAll('a').length,
                childCount: el.children.length,
              };
            });
            return { title: document.title, colors: top(colorCount, 12), fonts: top(fonts, 5), typeSizes: top(sizes, 16), radii: top(radii, 5), sections };
})()`);
          result.push({ page: t.name, url, screenshots: shots, ...analysis });
          await page.close();
        }
        fs.writeFileSync(path.join(designDir(record), 'html.json'), JSON.stringify(result, null, 2));
        return text(`Rendered ${result.length} page(s) at 3 widths into design/html/. Outline in design/html.json.\n` + JSON.stringify(result.map((r) => ({ page: r.page, colors: r.colors.slice(0, 6), fonts: r.fonts, sections: r.sections.map((s: any) => ({ tag: s.tag, classes: s.classes, h: s.headings[0], buttons: s.buttons.length, images: s.images.length, height: s.height })) })), null, 1));
      } finally {
        await browser.close();
      }
    },
  );

/* ---------------- Images / PDF ---------------- */

export const TILE_H = 1100;

/**
 * Slice each image into full-resolution horizontal tiles (TILE_H px tall) and sample its dominant colours, using the bundled
 * Chromium so PNG/JPEG/WebP all work without native image deps. Tiles go to <outDir>/<stem>-NN.png.
 */
export async function tileImages(files: string[], outDir: string) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const images: { file: string; width: number; height: number; tiles: string[]; palette: { hex: string; pct: number }[] }[] = [];
  try {
    for (const file of files) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
      await page.goto('file://' + file);
      const dims = (await page.evaluate('(() => { const i = document.querySelector("img"); return i ? [i.naturalWidth, i.naturalHeight] : [0, 0]; })()')) as [number, number];
      const [w, h] = dims;
      if (!w || !h) { await page.close(); continue; }
      const width = Math.min(w, 2400);
      const scale = width / w;
      const height = Math.round(h * scale);
      await page.setViewportSize({ width, height: Math.min(height, 4000) });
      const html = path.join(outDir, `.${slug(path.basename(file))}.html`);
      const mime = /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
      // Inline the image as a data URL so the canvas palette sample is same-origin (file:// images taint it).
      fs.writeFileSync(html, `<html><body style="margin:0;background:#fff"><img src="data:${mime};base64,${fs.readFileSync(file).toString('base64')}" style="display:block;width:${width}px;height:${height}px"></body></html>`);
      await page.goto('file://' + html, { waitUntil: 'load' });
      fs.rmSync(html, { force: true });
      const stem = slug(path.basename(file, path.extname(file)));
      const tiles: string[] = [];
      for (let y = 0, n = 0; y < height; y += TILE_H, n++) {
        const out = path.join(outDir, `${stem}-${String(n).padStart(2, '0')}.png`);
        await page.screenshot({ path: out, clip: { x: 0, y, width, height: Math.min(TILE_H, height - y) }, fullPage: true });
        tiles.push(out);
      }
      const palette = (await page.evaluate(`(() => {
        const img = document.querySelector('img'); const c = document.createElement('canvas'); const s = 200 / Math.max(img.naturalWidth, img.naturalHeight);
        c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data; const m = new Map(); let total = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 128) continue; const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); m.set(k, (m.get(k) || 0) + 1); total++; }
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => ({ hex: '#' + [(k >> 8) & 15, (k >> 4) & 15, k & 15].map((v) => (v * 17).toString(16).padStart(2, '0')).join(''), pct: Math.round((n / total) * 1000) / 10 }));
      })()`)) as { hex: string; pct: number }[];
      images.push({ file, width: w, height: h, tiles, palette });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return { images };
}

export const ingestImages = (record: BuildRecord) =>
  tool(
    'ingest_images',
    'Collect screenshot/PDF mockups into design/images/ and list them so you can Read each one (vision). Accepts local files/directories or http(s) URLs (comma-separated for several; signed tracker links are fine). PDFs are split into page PNGs when pdftoppm is available.',
    { source: z.string().describe('Image file, PDF, directory of images, or one or more URLs separated by commas') },
    async ({ source }) => {
      const dir = path.join(designDir(record), 'images');
      fs.mkdirSync(dir, { recursive: true });
      const out: string[] = [];
      const errors: string[] = [];
      const items = source.split(',').map((s) => s.trim()).filter(Boolean);
      const localFiles: string[] = [];
      for (const item of items) {
        if (/^https?:\/\//i.test(item)) {
          const dl = await download(item, dir).catch((e) => ({ error: e.message as string }));
          if ('error' in dl) errors.push(`${item.slice(0, 80)}: ${dl.error}`);
          else localFiles.push(dl.file);
        } else {
          const src = path.resolve(item);
          if (!fs.existsSync(src)) {
            errors.push(`Not found: ${src}`);
            continue;
          }
          localFiles.push(...(fs.statSync(src).isDirectory() ? fs.readdirSync(src).map((f) => path.join(src, f)) : [src]));
        }
      }
      for (const f of localFiles) {
        if (/\.pdf$/i.test(f)) {
          const { execSync } = await import('node:child_process');
          try {
            const stem = slug(path.basename(f, path.extname(f)));
            execSync(`pdftoppm -png -r 110 "${f}" "${path.join(dir, stem)}"`);
            out.push(...fs.readdirSync(dir).filter((x) => x.startsWith(stem) && x.endsWith('.png')).map((x) => path.join(dir, x)));
          } catch (e: any) {
            errors.push(`pdftoppm failed for ${path.basename(f)}: ${e.message.split('\n')[0]}`);
          }
        } else if (/\.(png|jpe?g|webp)$/i.test(f)) {
          const dest = path.join(dir, path.basename(f));
          if (path.resolve(f) !== path.resolve(dest)) fs.copyFileSync(f, dest);
          out.push(dest);
        }
      }
      // Drop byte-identical duplicates (the same screenshot uploaded twice).
      const seen = new Map<string, string>();
      const unique: string[] = [];
      for (const f of out) {
        const h = crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
        if (seen.has(h)) errors.push(`${path.basename(f)} is identical to ${path.basename(seen.get(h)!)} — ignored`);
        else { seen.set(h, f); unique.push(f); }
      }
      // Tall page screenshots are useless shrunk to one frame: slice every image into full-resolution tiles and sample its palette.
      const tiled = await tileImages(unique, path.join(designDir(record), 'tiles')).catch((e) => ({ error: e.message as string }));
      const info = 'error' in tiled ? [] : tiled.images;
      if ('error' in tiled) errors.push(`tiling failed: ${tiled.error}`);
      fs.writeFileSync(path.join(designDir(record), 'images.json'), JSON.stringify({ files: unique, images: info, errors }, null, 2));
      if (!unique.length) return fail(`No images collected.${errors.length ? ' ' + errors.join(' | ') : ''}`);
      const lines = info.length
        ? info.map((im) => `${path.basename(im.file)} — ${im.width}×${im.height}px, ${im.tiles.length} tiles (Read EVERY tile, top to bottom; each is ${TILE_H}px of the page at full resolution):\n${im.tiles.map((t) => '  ' + t).join('\n')}\n  palette (share of pixels): ${im.palette.map((c) => `${c.hex} ${c.pct}%`).join(', ')}`)
        : unique.map((f) => `${f} (Read it)`);
      return text(`${unique.length} image(s) in design/images/, tiles in design/tiles/.\n\n${lines.join('\n\n')}${errors.length ? '\n\nNotes: ' + errors.join(' | ') : ''}\n\nDo not judge a page from a shrunken overview: read the tiles. Record exact copy, badge styles, type (case, weight, width, mono vs sans), column counts, image aspect ratios and spacing per region.`);
    },
  );

/** Download a URL into dir; the file name comes from the Content-Disposition header, the URL path, or the content type. */
async function download(url: string, dir: string): Promise<{ file: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cd = res.headers.get('content-disposition') || '';
  const ct = (res.headers.get('content-type') || '').split(';')[0];
  let name = decodeURIComponent((cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] || '').trim());
  if (!name) name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'download';
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += ct === 'image/png' ? '.png' : ct === 'image/jpeg' ? '.jpg' : ct === 'image/webp' ? '.webp' : ct === 'application/pdf' ? '.pdf' : ct === 'text/html' ? '.html' : '';
  const file = path.join(dir, slug(path.basename(name, path.extname(name))) + path.extname(name).toLowerCase());
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { file };
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';
}

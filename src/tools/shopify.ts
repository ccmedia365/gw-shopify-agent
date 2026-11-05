/**
 * Shopify Admin tools: raw GraphQL, catalog loading from a product sheet,
 * collections and inventory. Uses the Admin API access token from the build
 * record or SHOPIFY_ADMIN_TOKEN. The model validates mutations with the
 * Shopify Dev MCP before calling admin_graphql for anything non-standard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { parse } from 'csv-parse/sync';
import type { BuildRecord } from '../build.js';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

export async function adminGraphql(record: BuildRecord, query: string, variables: Record<string, unknown> = {}) {
  const token = record.intake.adminToken || process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error('No Admin API token (intake.adminToken or SHOPIFY_ADMIN_TOKEN). Create a custom app in the store with write_products, write_inventory, write_files, read_locations scopes.');
  const res = await fetch(`https://${record.intake.shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (!res.ok || json.errors) throw new Error(`Admin GraphQL ${res.status}: ${JSON.stringify(json.errors || json).slice(0, 2000)}`);
  return json.data;
}

export const adminGraphqlTool = (record: BuildRecord) =>
  tool(
    'admin_graphql',
    `Run a GraphQL query or mutation against the client store's Admin API (version ${API_VERSION}). Validate non-trivial mutations with the Shopify Dev MCP (validate_graphql_codeblocks) first. Returns data or the error.`,
    { query: z.string(), variables: z.record(z.string(), z.unknown()).optional() },
    async ({ query, variables }) => {
      try {
        const data = await adminGraphql(record, query, variables || {});
        return text(JSON.stringify(data, null, 1).slice(0, 20000));
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );

/* ---------------- Catalog loading ---------------- */

interface SheetRow {
  [k: string]: string;
}

/** Group Shopify-style CSV rows (one row per variant, handle repeated) into products. */
function groupProducts(rows: SheetRow[]) {
  const byHandle = new Map<string, SheetRow[]>();
  let lastHandle = '';
  for (const r of rows) {
    const handle = (r.Handle || r.handle || lastHandle).trim();
    if (!handle) continue;
    lastHandle = handle;
    if (!byHandle.has(handle)) byHandle.set(handle, []);
    byHandle.get(handle)!.push(r);
  }
  return byHandle;
}

function col(r: SheetRow, ...names: string[]) {
  for (const n of names) {
    const k = Object.keys(r).find((key) => key.toLowerCase().trim() === n.toLowerCase());
    if (k && r[k] !== undefined && r[k] !== '') return r[k].trim();
  }
  return '';
}

function toProductSetInput(handle: string, rows: SheetRow[], locationId?: string) {
  const first = rows[0];
  const optionNames = [col(first, 'Option1 Name'), col(first, 'Option2 Name'), col(first, 'Option3 Name')].filter(Boolean);
  const hasOptions = optionNames.length > 0 && !(optionNames.length === 1 && optionNames[0].toLowerCase() === 'title' && col(first, 'Option1 Value').toLowerCase() === 'default title');
  const optionValues = optionNames.map((name, i) => ({ name, values: [...new Set(rows.map((r) => col(r, `Option${i + 1} Value`)).filter(Boolean))].map((v) => ({ name: v })) }));
  const issues: string[] = [];
  const variants = rows
    .filter((r) => col(r, 'Variant Price', 'Price') || col(r, 'Variant SKU', 'SKU') || !hasOptions)
    .map((r) => {
      const price = col(r, 'Variant Price', 'Price');
      if (!price) issues.push(`${handle}: variant without price (${col(r, 'Variant SKU', 'SKU') || col(r, 'Option1 Value')})`);
      const qty = col(r, 'Variant Inventory Qty', 'Inventory Qty', 'Quantity');
      const v: any = {
        price: price || '0',
        compareAtPrice: col(r, 'Variant Compare At Price', 'Compare At Price') || undefined,
        sku: col(r, 'Variant SKU', 'SKU') || undefined,
        barcode: col(r, 'Variant Barcode', 'Barcode') || undefined,
        taxable: col(r, 'Variant Taxable') ? col(r, 'Variant Taxable').toLowerCase() === 'true' : undefined,
        inventoryPolicy: col(r, 'Variant Inventory Policy').toUpperCase() === 'CONTINUE' ? 'CONTINUE' : 'DENY',
        optionValues: hasOptions ? optionNames.map((name, i) => ({ optionName: name, name: col(r, `Option${i + 1} Value`) })) : undefined,
      };
      const grams = col(r, 'Variant Grams', 'Weight (g)');
      if (grams) v.inventoryItem = { measurement: { weight: { unit: 'GRAMS', value: Number(grams) } }, tracked: true };
      if (qty && locationId) v.inventoryQuantities = [{ locationId, name: 'available', quantity: Number(qty) }];
      return v;
    });
  const files = [...new Set(rows.map((r) => col(r, 'Image Src', 'Image')).filter(Boolean))].map((src, i) => ({ originalSource: src, contentType: 'IMAGE', alt: col(rows[i] || first, 'Image Alt Text') || undefined }));
  const status = (col(first, 'Status') || 'ACTIVE').toUpperCase();
  const input: any = {
    handle,
    title: col(first, 'Title') || handle,
    descriptionHtml: col(first, 'Body (HTML)', 'Body', 'Description') || undefined,
    vendor: col(first, 'Vendor') || undefined,
    productType: col(first, 'Type', 'Product Type', 'Product Category') || undefined,
    tags: col(first, 'Tags') ? col(first, 'Tags').split(',').map((t) => t.trim()).filter(Boolean) : undefined,
    status: ['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(status) ? status : 'ACTIVE',
    seo: col(first, 'SEO Title') || col(first, 'SEO Description') ? { title: col(first, 'SEO Title') || undefined, description: col(first, 'SEO Description') || undefined } : undefined,
    productOptions: hasOptions ? optionValues : undefined,
    variants: variants.length ? variants : [{ price: col(first, 'Variant Price', 'Price') || '0' }],
    files: files.length ? files : undefined,
  };
  if (!col(first, 'Title')) issues.push(`${handle}: missing title`);
  return { input, issues };
}

const PRODUCT_SET = `mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
  productSet(input: $input, synchronous: $synchronous) {
    product { id handle title variants(first: 1) { nodes { id } } }
    userErrors { field message code }
  }
}`;

export const loadCatalog = (record: BuildRecord) =>
  tool(
    'load_catalog',
    'Load products from a CSV product sheet (Shopify product CSV columns: Handle, Title, Body (HTML), Vendor, Type, Tags, Option1 Name/Value…, Variant SKU, Variant Price, Variant Compare At Price, Variant Inventory Qty, Variant Grams, Image Src, Status, SEO Title/Description) into the client store with productSet, one product per mutation. Inventory quantities go to the store\'s first active location unless location_id is given. Dry-run first to see what would be created. Rows with problems are written to catalog-issues.csv in the build folder.',
    {
      sheet: z.string().optional().describe('CSV path (default: intake.productSheet)'),
      dry_run: z.boolean().optional().describe('Parse and report only; no mutations'),
      limit: z.number().int().min(1).optional().describe('Only the first N products'),
      location_id: z.string().optional(),
    },
    async ({ sheet, dry_run, limit, location_id }) => {
      const file = sheet || record.intake.productSheet;
      if (!file) return fail('No product sheet provided (intake.productSheet).');
      if (!fs.existsSync(file)) return fail(`Not found: ${file}`);
      const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }) as SheetRow[];
      const grouped = groupProducts(rows);
      const handles = [...grouped.keys()].slice(0, limit ?? Infinity);
      let locationId = location_id;
      if (!dry_run && !locationId) {
        try {
          const data = await adminGraphql(record, `{ locations(first: 5, query: "active:true") { nodes { id name } } }`);
          locationId = data.locations.nodes[0]?.id;
        } catch (e: any) {
          return fail(e.message);
        }
      }
      const issues: string[] = [];
      const results: string[] = [];
      let created = 0;
      for (const handle of handles) {
        const { input, issues: rowIssues } = toProductSetInput(handle, grouped.get(handle)!, locationId);
        issues.push(...rowIssues);
        if (dry_run) {
          results.push(`${handle}: ${input.title} — ${input.variants.length} variant(s), ${input.files?.length || 0} image(s)${rowIssues.length ? ' ⚠' : ''}`);
          continue;
        }
        try {
          const data = await adminGraphql(record, PRODUCT_SET, { input, synchronous: true });
          const ue = data.productSet.userErrors;
          if (ue.length) issues.push(...ue.map((u: any) => `${handle}: ${u.field?.join('.')} ${u.message}`));
          else {
            created++;
            results.push(`${handle} → ${data.productSet.product.id}`);
          }
        } catch (e: any) {
          issues.push(`${handle}: ${e.message.slice(0, 300)}`);
        }
      }
      const issuesPath = path.join(record.workdir, 'catalog-issues.csv');
      fs.writeFileSync(issuesPath, 'issue\n' + issues.map((i) => `"${i.replace(/"/g, '""')}"`).join('\n') + '\n');
      return text(`${dry_run ? 'DRY RUN — ' : ''}${handles.length} products in sheet, ${dry_run ? 0 : created} created, ${issues.length} issues (catalog-issues.csv).\n${results.slice(0, 60).join('\n')}${issues.length ? '\n\nISSUES:\n' + issues.slice(0, 40).join('\n') : ''}`);
    },
  );

export const createCollection = (record: BuildRecord) =>
  tool(
    'create_collection',
    'Create a collection: manual (list of product handles) or automated (rules on tag/type/vendor/title). Idempotent on handle: an existing collection with that handle is updated.',
    {
      title: z.string(),
      handle: z.string().optional(),
      description_html: z.string().optional(),
      rules: z
        .array(z.object({ column: z.enum(['TAG', 'TYPE', 'VENDOR', 'TITLE', 'VARIANT_PRICE']), relation: z.enum(['EQUALS', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'GREATER_THAN', 'LESS_THAN']), condition: z.string() }))
        .optional(),
      product_handles: z.array(z.string()).optional(),
    },
    async ({ title, handle, description_html, rules, product_handles }) => {
      try {
        const h = handle || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const existing = await adminGraphql(record, `{ collectionByHandle(handle: "${h}") { id } }`);
        const input: any = { title, handle: h, descriptionHtml: description_html };
        if (rules?.length) input.ruleSet = { appliedDisjunctively: false, rules };
        if (product_handles?.length) {
          const ids: string[] = [];
          for (const ph of product_handles) {
            const d = await adminGraphql(record, `{ productByHandle(handle: "${ph}") { id } }`);
            if (d.productByHandle?.id) ids.push(d.productByHandle.id);
          }
          input.products = ids;
        }
        const mutation = existing.collectionByHandle
          ? `mutation($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id handle } userErrors { field message } } }`
          : `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id handle } userErrors { field message } } }`;
        if (existing.collectionByHandle) input.id = existing.collectionByHandle.id;
        const data = await adminGraphql(record, mutation, { input });
        const r = data.collectionUpdate || data.collectionCreate;
        if (r.userErrors.length) return fail(JSON.stringify(r.userErrors));
        return text(`Collection ${r.collection.handle} → ${r.collection.id}`);
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );

export const storeInfo = (record: BuildRecord) =>
  tool(
    'store_info',
    'Read basic store facts: name, plan, currency, enabled locales/markets, locations, product count, published collections, installed app embeds visible to the Admin API. Use at intake to confirm access and at the apps phase.',
    {},
    async () => {
      try {
        const data = await adminGraphql(
          record,
          `{ shop { name plan { displayName } currencyCode primaryDomain { host } enabledPresentmentCurrencies }
             shopLocales { locale primary published }
             markets(first: 10) { nodes { name enabled } }
             locations(first: 5) { nodes { id name isActive } }
             productsCount { count }
             collections(first: 20) { nodes { handle title productsCount { count } } } }`,
        );
        return text(JSON.stringify(data, null, 1));
      } catch (e: any) {
        return fail(e.message);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

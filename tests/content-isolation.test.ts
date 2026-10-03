import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Modules that read settings or keys, call providers, or write the ledger. */
const BACKGROUND_ONLY = [
  "utils/storage.ts",
  "utils/auth.ts",
  "utils/managed.ts",
  "utils/openai.ts",
  "utils/usage.ts",
  "utils/money.ts",
  "utils/models.ts",
  "utils/narration.ts",
  "utils/narrationCache.ts",
  "utils/overlaySettings.ts",
  "utils/briefState.ts",
];

const SPECIFIER =
  /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\?.*$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

/** Runtime imports only: `import type` and `export type` vanish from the bundle. */
function runtimeImports(file: string): string[] {
  const source = code(file);
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    if (match[2]) continue;
    const specifier = match[3] ?? match[4];
    if (!specifier) continue;
    const target = resolveModule(file, specifier);
    if (target) found.push(target);
  }
  return found;
}

function contentGraph(entry: string): Map<string, string> {
  const parents = new Map<string, string>([[entry, ""]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const target of runtimeImports(file)) {
      if (parents.has(target)) continue;
      parents.set(target, file);
      queue.push(target);
    }
  }
  return parents;
}

function chain(parents: Map<string, string>, file: string): string {
  const path: string[] = [];
  for (let at = file; at; at = parents.get(at) ?? "") {
    path.unshift(relative(root, at).replaceAll("\\", "/"));
  }
  return path.join(" -> ");
}

void test("the content script bundles no settings, key, provider, or ledger code", () => {
  const parents = contentGraph(resolve(root, "entrypoints/content/index.tsx"));
  assert.ok(parents.size > 10, "the import scan found the overlay");
  assert.ok(
    parents.has(resolve(root, "utils/narrationProtocol.ts")),
    "the overlay narrates over the port",
  );
  const leaks = BACKGROUND_ONLY.map((file) => resolve(root, file))
    .filter((file) => parents.has(file))
    .map((file) => chain(parents, file));
  assert.deepEqual(leaks, []);
});

void test("no content script module touches extension storage, which is restricted to extension pages", () => {
  const parents = contentGraph(resolve(root, "entrypoints/content/index.tsx"));
  const touching = [...parents.keys()]
    .filter((file) => /\b(?:browser|chrome)\.storage\b/.test(code(file)))
    .map((file) => chain(parents, file));
  assert.deepEqual(touching, []);
});

void test("the import scan sees through re-exports but skips type-only imports", () => {
  const imports = runtimeImports(resolve(root, "utils/narrationProtocol.ts")).map((file) =>
    relative(root, file).replaceAll("\\", "/"),
  );
  assert.ok(imports.includes("utils/errors.ts"));
  assert.ok(imports.includes("utils/pcmFormat.ts"));
  assert.ok(!imports.includes("utils/prefetch.ts"), "prefetch is imported for its type only");
});

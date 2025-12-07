import type { Plugin, ResolvedConfig } from "vite";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// --- Types ---

interface FunctionParam {
  name: string;
  defaultValue?: string;
}

interface FunctionDef {
  name: string;
  params: FunctionParam[];
  body: string;
}

interface MixinDef {
  name: string;
  params: FunctionParam[];
  body: string;
  hasContents: boolean;
}

interface PluginOptions {
  /** Extra paths to scan for @function definitions (can be files or directories) */
  include?: string[];
}

// --- Constants ---

const SOURCE_EXTENSIONS = new Set([
  "css",
  "scss",
  "sass",
  "less",
  "styl",
  "stylus",
]);
const ALL_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, "svelte", "vue"]);
const IGNORED_DIRS = new Set([".git", "dist"]);
const MAX_RECURSION_DEPTH = 10;

const OPEN_BRACKETS = new Set(["(", "{", "["]);
const CLOSE_BRACKETS = new Set([")", "}", "]"]);

// --- Parsing Utilities ---

function findMatchingBrace(code: string, start: number): number {
  let depth = 1;
  for (let i = start; i < code.length; i++) {
    if (OPEN_BRACKETS.has(code[i])) depth++;
    else if (CLOSE_BRACKETS.has(code[i])) depth--;
    if (depth == 0) return i;
  }
  throw new Error(`Unmatched brace at position ${start}`);
}

function splitByComma(str: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of str) {
    if (OPEN_BRACKETS.has(char)) depth++;
    else if (CLOSE_BRACKETS.has(char)) depth--;

    if (char == "," && depth == 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseParams(paramStr: string): {
  params: FunctionParam[];
  hasContents: boolean;
} {
  const parts = splitByComma(paramStr);
  const params: FunctionParam[] = [];
  let hasContents = false;

  for (const p of parts) {
    // Check for @contents parameter (for mixins)
    if (p.trim() == "@contents") {
      hasContents = true;
      continue;
    }

    const colonIdx = p.indexOf(":");
    const namePart = colonIdx > -1 ? p.slice(0, colonIdx).trim() : p;
    const defaultValue =
      colonIdx > -1 ? p.slice(colonIdx + 1).trim() : undefined;
    // Remove type annotations like <color>, type(<number> | <percentage>), etc.
    const nameMatch = namePart.match(/^(--[\w-]+)/);
    const name = nameMatch?.[1] ?? namePart;
    if (name) {
      params.push({ name, defaultValue });
    }
  }

  return { params, hasContents };
}

function extractResult(body: string): string {
  const match = body.match(/result\s*:\s*([^;]+)(?:;|$)/);
  if (!match) throw new Error(`Missing "result:" in function body`);
  return match[1].trim();
}

function substituteVars(
  template: string,
  params: FunctionParam[],
  args: string[],
): string {
  const argMap = new Map(
    params.map((param, i) => [param.name, args[i] ?? param.defaultValue]),
  );

  return template.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\s*\)/g,
    (match, varName, fallback) =>
      argMap.get(varName) ?? fallback?.trim() ?? match,
  );
}

function substituteEnvVars(
  template: string,
  params: FunctionParam[],
  args: string[],
): string {
  const argMap = new Map(
    params.map((param, i) => [param.name, args[i] ?? param.defaultValue]),
  );

  return template.replace(
    /env\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\s*\)/g,
    (match, varName, fallback) =>
      argMap.get(varName) ?? fallback?.trim() ?? match,
  );
}

// --- Function Extraction ---

function extractFunctions(
  code: string,
  registry: Map<string, FunctionDef>,
): [number, number][] {
  const regex =
    /@function\s+(--[\w-]+)\s*\(([^)]*)\)(?:\s*returns\s*[^{]+)?\s*\{/g;
  const removals: [number, number][] = [];

  for (const match of code.matchAll(regex)) {
    const [fullMatch, name, paramStr] = match;
    const bodyStart = match.index! + fullMatch.length;
    const bodyEnd = findMatchingBrace(code, bodyStart);

    const { params } = parseParams(paramStr);
    registry.set(name, {
      name,
      params,
      body: code.slice(bodyStart, bodyEnd),
    });
    removals.push([match.index!, bodyEnd + 1]);
  }

  return removals;
}

// --- Mixin Extraction ---

function extractMixins(
  code: string,
  registry: Map<string, MixinDef>,
): [number, number][] {
  const regex = /@mixin\s+(--[\w-]+)\s*(\([^)]*\))?\s*\{/g;
  const removals: [number, number][] = [];

  for (const match of code.matchAll(regex)) {
    const [fullMatch, name, paramsWithParens] = match;
    const bodyStart = match.index! + fullMatch.length;
    const bodyEnd = findMatchingBrace(code, bodyStart);

    const paramStr = paramsWithParens ? paramsWithParens.slice(1, -1) : "";
    const { params, hasContents } = parseParams(paramStr);
    registry.set(name, {
      name,
      params,
      body: code.slice(bodyStart, bodyEnd),
      hasContents,
    });
    removals.push([match.index!, bodyEnd + 1]);
  }

  return removals;
}

function stripDefinitions(code: string, removals: [number, number][]): string {
  let result = code;
  for (const [start, end] of removals.toReversed()) {
    const blank = result.slice(start, end).replace(/[^\n]/g, "");
    result = result.slice(0, start) + blank + result.slice(end);
  }
  return result;
}

// --- Function Call Resolution ---

function resolveFunctionCalls(
  code: string,
  registry: Map<string, FunctionDef>,
): string {
  let result = code;
  for (let i = 0; i < MAX_RECURSION_DEPTH; i++) {
    const next = resolveOnce(result, registry);
    if (next == result) break;
    result = next;
  }
  return result;
}

function resolveOnce(code: string, registry: Map<string, FunctionDef>): string {
  const callRegex = /(--[\w-]+)\(/g;
  let result = "";
  let lastIdx = 0;

  for (const match of code.matchAll(callRegex)) {
    const [fullMatch, fnName] = match;
    const start = match.index!;
    const argsStart = start + fullMatch.length;

    result += code.slice(lastIdx, start);

    const def = registry.get(fnName);
    if (!def) {
      result += fullMatch;
      lastIdx = argsStart;
      continue;
    }

    const argsEnd = findMatchingBrace(code, argsStart);
    const args = splitByComma(code.slice(argsStart, argsEnd));
    result += substituteVars(extractResult(def.body), def.params, args);
    lastIdx = argsEnd + 1;
  }

  return result + code.slice(lastIdx);
}

// --- Mixin Application Resolution ---

function resolveMixinApplications(
  code: string,
  registry: Map<string, MixinDef>,
): string {
  let result = code;
  for (let i = 0; i < MAX_RECURSION_DEPTH; i++) {
    const next = resolveMixinsOnce(result, registry);
    if (next == result) break;
    result = next;
  }
  return result;
}

function resolveMixinsOnce(
  code: string,
  registry: Map<string, MixinDef>,
): string {
  // Match @apply with optional block: @apply --name(args) { contents } or @apply --name(args); or @apply --name;
  const applyRegex =
    /@apply\s+(--[\w-]+)(?:\s*\(([^)]*)\))?\s*(?:\{([^}]*)\}\s*;?|;)/g;
  let result = "";
  let lastIdx = 0;

  for (const match of code.matchAll(applyRegex)) {
    const [fullMatch, mixinName, argsStr, contentsBlock] = match;
    const start = match.index!;

    result += code.slice(lastIdx, start);

    const def = registry.get(mixinName);
    if (!def) {
      // Unknown mixin, leave as-is or remove
      result += `/* Unknown mixin: ${mixinName} */`;
      lastIdx = start + fullMatch.length;
      continue;
    }

    const args = argsStr ? splitByComma(argsStr) : [];
    let substituted = substituteEnvVars(def.body, def.params, args);

    // Handle @contents substitution
    if (def.hasContents && contentsBlock !== undefined) {
      substituted = substituted.replace(
        /@contents\s*(?:\{[^}]*\})?\s*;?/g,
        contentsBlock.trim(),
      );
    } else if (def.hasContents) {
      // No contents block provided, use default if present
      substituted = substituted.replace(/@contents\s*\{([^}]*)\}\s*;?/g, "$1");
      substituted = substituted.replace(/@contents\s*;?/g, "");
    }

    result += substituted;
    lastIdx = start + fullMatch.length;
  }

  return result + code.slice(lastIdx);
}

// --- Helpers to preserve definitions while transforming outside them ---

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      merged.push([curStart, curEnd]);
      [curStart, curEnd] = [s, e];
    }
  }
  merged.push([curStart, curEnd]);
  return merged;
}

function transformExcludingRanges(
  code: string,
  exclude: [number, number][],
  mixinRegistry: Map<string, MixinDef>,
  functionRegistry: Map<string, FunctionDef>,
): string {
  const ranges = mergeRanges(exclude);
  let result = "";
  let cursor = 0;

  for (const [start, end] of ranges) {
    // Process the chunk before this excluded range
    const chunk = code.slice(cursor, start);
    let processedChunk = resolveMixinApplications(chunk, mixinRegistry);
    processedChunk = resolveFunctionCalls(processedChunk, functionRegistry);
    result += processedChunk;

    // Append the excluded range (definitions) untouched
    result += code.slice(start, end);
    cursor = end;
  }

  // Process the trailing part after the last excluded range
  const tail = code.slice(cursor);
  let processedTail = resolveMixinApplications(tail, mixinRegistry);
  processedTail = resolveFunctionCalls(processedTail, functionRegistry);
  result += processedTail;

  return result;
}

// --- File Discovery ---

async function* findStyleFiles(
  dir: string,
  skipNodeModules = true,
): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (skipNodeModules && entry.name == "node_modules") continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* findStyleFiles(fullPath, skipNodeModules);
    } else if (SOURCE_EXTENSIONS.has(entry.name.split(".").at(-1)!)) {
      yield fullPath;
    }
  }
}

// --- Build Folder Processor ---

export interface ProcessOptions {
  /** Directory to process (defaults to 'dist') */
  dir?: string;
  /** Whether to remove @function and @mixin definitions after processing (default: false) */
  strip?: boolean;
}

export async function processBuildFolder({
  dir = "dist",
  strip = false,
}: ProcessOptions = {}): Promise<void> {
  const functionRegistry = new Map<string, FunctionDef>();
  const mixinRegistry = new Map<string, MixinDef>();

  // First pass: collect all definitions
  const filesToProcess: string[] = [];
  for await (const file of findStyleFilesWithExtensions(
    dir,
    ALL_EXTENSIONS,
    false,
  )) {
    filesToProcess.push(file);
    const content = await fs.readFile(file, "utf-8");
    extractFunctions(content, functionRegistry);
    extractMixins(content, mixinRegistry);
  }

  // Second pass: process each file
  for (const file of filesToProcess) {
    const content = await fs.readFile(file, "utf-8");

    // Extract ranges to remove definitions
    const functionRanges = extractFunctions(content, functionRegistry);
    const mixinRanges = extractMixins(content, mixinRegistry);
    const excludeRanges: [number, number][] = [
      ...functionRanges,
      ...mixinRanges,
    ];

    // Resolve calls outside definitions
    let processed = transformExcludingRanges(
      content,
      excludeRanges,
      mixinRegistry,
      functionRegistry,
    );

    if (strip) {
      // Remove the definitions since they're now resolved
      processed = stripDefinitions(processed, [
        ...functionRanges,
        ...mixinRanges,
      ]);
    }

    await fs.writeFile(file, processed, "utf-8");
  }
}

async function* findStyleFilesWithExtensions(
  dir: string,
  extensions: Set<string>,
  skipNodeModules = true,
): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (skipNodeModules && entry.name == "node_modules") continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* findStyleFilesWithExtensions(
        fullPath,
        extensions,
        skipNodeModules,
      );
    } else if (extensions.has(entry.name.split(".").at(-1)!)) {
      yield fullPath;
    }
  }
}

// --- Plugin ---

export const functionsMixins = (options: PluginOptions = {}): Plugin => {
  const functionRegistry = new Map<string, FunctionDef>();
  const mixinRegistry = new Map<string, MixinDef>();
  let root: string;

  return {
    name: "vite-plugin-functions-mixins",
    enforce: "pre",

    configResolved(config: ResolvedConfig) {
      root = config.root;
    },

    async buildStart() {
      const includeScans = (options.include ?? []).map(async (p) => {
        const resolved = path.isAbsolute(p) ? p : path.join(root, p);
        const stat = await fs.stat(resolved);

        if (stat.isDirectory()) {
          for await (const file of findStyleFiles(resolved)) {
            const content = await fs.readFile(file, "utf-8");
            extractFunctions(content, functionRegistry);
            extractMixins(content, mixinRegistry);
          }
        } else {
          const content = await fs.readFile(resolved, "utf-8");
          extractFunctions(content, functionRegistry);
          extractMixins(content, mixinRegistry);
        }
      });
      await Promise.all(includeScans);

      for await (const file of findStyleFiles(root)) {
        const content = await fs.readFile(file, "utf-8");
        extractFunctions(content, functionRegistry);
        extractMixins(content, mixinRegistry);
      }
    },

    transform(code: string, id: string) {
      const ext = id.split("?")[0].split(".").at(-1)!;
      if (!ALL_EXTENSIONS.has(ext)) {
        return null;
      }

      // Extract function and mixin definitions to populate registries, but do not remove them
      const functionRanges = extractFunctions(code, functionRegistry);
      const mixinRanges = extractMixins(code, mixinRegistry);

      const excludeRanges: [number, number][] = [
        ...functionRanges,
        ...mixinRanges,
      ];

      // Resolve @apply and function calls only outside definition blocks
      let processed = transformExcludingRanges(
        code,
        excludeRanges,
        mixinRegistry,
        functionRegistry,
      );

      // In the plugin (bundling for browser), we ALWAYS strip definitions
      processed = stripDefinitions(processed, excludeRanges);

      return { code: processed, map: null };
    },
  };
};

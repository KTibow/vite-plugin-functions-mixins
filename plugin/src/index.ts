import type { Plugin, ResolvedConfig } from "vite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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

// --- Constants ---

const SOURCE_EXTENSIONS = new Set([
  "css",
  "scss",
  "sass",
  "less",
  "styl",
  "stylus",
]);
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
    /var\(\s*(--[\w-]+)\s*(?:,\s*[^)]+)?\s*\)/g,
    (match, varName) => {
      return argMap.get(varName) ?? match;
    },
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
  strip: boolean,
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

    // Handle the excluded range (the definition)
    if (strip) {
      // Replace definition with blanks that preserve newline characters to keep line numbers
      const definition = code.slice(start, end);
      const blank = definition.replace(/[^\n]/g, "");
      result += blank;
    } else {
      // Append the definition UNTOUCHED
      result += code.slice(start, end);
    }

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
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (skipNodeModules && entry.name == "node_modules") continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* findStyleFiles(fullPath, skipNodeModules);
    } else if (SOURCE_EXTENSIONS.has(entry.name.split(".").at(-1)!)) {
      yield fullPath;
    }
  }
}

// --- Plugin ---

export const functionsMixins = ({
  deps = [],
  strip = true,
}: {
  deps?: string[];
  strip?: boolean;
} = {}): Plugin => {
  const functionRegistry = new Map<string, FunctionDef>();
  const mixinRegistry = new Map<string, MixinDef>();
  let root: string;

  function processCode(code: string, strip: boolean): string {
    const functionRanges = extractFunctions(code, functionRegistry);
    const mixinRanges = extractMixins(code, mixinRegistry);
    const excludeRanges: [number, number][] = [
      ...functionRanges,
      ...mixinRanges,
    ];

    const processed = transformExcludingRanges(
      code,
      excludeRanges,
      mixinRegistry,
      functionRegistry,
      strip,
    );

    return processed;
  }

  const stylePreprocessor = ({
    content,
    filename,
  }: {
    content: string;
    filename: string;
  }) => {
    const dep = deps.find((d) => filename.includes(`node_modules/${d}/`));
    if (!dep) return;

    const processed = processCode(content, strip);
    return { code: processed };
  };

  return {
    name: "vite-plugin-functions-mixins",

    async buildStart() {
      const includeScans = [
        ...deps.map((d) => join("node_modules", d)),
        root,
      ].map(async (p) => {
        for await (const file of findStyleFiles(p)) {
          const content = await readFile(file, "utf-8");
          extractFunctions(content, functionRegistry);
          extractMixins(content, mixinRegistry);
        }
      });
      await Promise.all(includeScans);
    },

    configResolved(config: ResolvedConfig) {
      root = config.root;

      const sveltePlugin =
        config.plugins.find((p) => p.name == "vite-plugin-svelte:config") ||
        config.plugins.find((p) => p.name == "vite-plugin-svelte");
      if (!sveltePlugin?.api?.options) return;
      const opts = sveltePlugin.api.options;
      opts.preprocess = [
        ...(Array.isArray(opts.preprocess)
          ? opts.preprocess
          : opts.preprocess
            ? [opts.preprocess]
            : []),
        {
          style: stylePreprocessor,
        },
      ];
    },

    transform(code: string, id: string) {
      const ext =
        id.split("?")[1]?.split("lang.")[1] ||
        id.split("?")[0].split(".").at(-1)!;

      if (SOURCE_EXTENSIONS.has(ext)) {
        const processed = processCode(code, strip);
        return { code: processed, map: null };
      } else if (ext == "svelte" || ext == "vue") {
        const styleStart = code.indexOf("<style");
        if (styleStart == -1) return;

        const before = code.slice(0, styleStart);
        const after = code.slice(styleStart);
        return { code: before + processCode(after, strip), map: null };
      }
    },
  };
};

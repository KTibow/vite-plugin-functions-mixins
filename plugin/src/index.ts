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

function parseParams(paramStr: string): FunctionParam[] {
  return splitByComma(paramStr).map((p) => {
    const colonIdx = p.indexOf(":");
    const namePart = colonIdx > -1 ? p.slice(0, colonIdx).trim() : p;
    const defaultValue =
      colonIdx > -1 ? p.slice(colonIdx + 1).trim() : undefined;
    const name = namePart.match(/^(--[\w-]+)/)?.[1] ?? namePart;
    return { name, defaultValue };
  });
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

    registry.set(name, {
      name,
      params: parseParams(paramStr),
      body: code.slice(bodyStart, bodyEnd),
    });
    removals.push([match.index!, bodyEnd + 1]);
  }

  return removals;
}

function stripFunctionDefinitions(
  code: string,
  removals: [number, number][],
): string {
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

// --- File Discovery ---

async function* findStyleFiles(
  dir: string,
  skipNodeModules = true,
): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (skipNodeModules && entry.name === "node_modules") continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* findStyleFiles(fullPath, skipNodeModules);
    } else if (SOURCE_EXTENSIONS.has(entry.name.split(".").at(-1)!)) {
      yield fullPath;
    }
  }
}

// --- Plugin ---

export const functionsMixins = (options: PluginOptions = {}): Plugin => {
  const registry = new Map<string, FunctionDef>();
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
            extractFunctions(await fs.readFile(file, "utf-8"), registry);
          }
        } else {
          extractFunctions(await fs.readFile(resolved, "utf-8"), registry);
        }
      });
      await Promise.all(includeScans);

      for await (const file of findStyleFiles(root)) {
        extractFunctions(await fs.readFile(file, "utf-8"), registry);
      }
    },

    transform(code: string, id: string) {
      const ext = id.split("?")[0].split(".").at(-1)!;
      if (!ALL_EXTENSIONS.has(ext)) {
        return null;
      }

      const removals = extractFunctions(code, registry);
      const stripped = stripFunctionDefinitions(code, removals);
      const resolved = resolveFunctionCalls(stripped, registry);

      return { code: resolved, map: null };
    },
  };
};

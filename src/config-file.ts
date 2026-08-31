import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomic } from "./json-atomic.js";
import { configKeyById, type ConfigValidation } from "./config-schema.js";

/**
 * The Squid config file: flat JSON, string scalars only.
 *
 * Shape is deliberately boring — `{ "watchRoot": "/home/me", "retentionHours": "72" }`
 * — because the file is the storage form of exactly the strings a settings form
 * submits and the wire carries. Numbers would invite the parser to type values
 * the schema intends to type; nested objects would invite an inheritance rule
 * nothing downstream can express; both are refused rather than coerced.
 *
 * A malformed file fails the session, loudly. That is the same judgment
 * `app-model.ts` makes about a hand-edited `models.json`: a file the user
 * wrote that no longer parses is not ours to repair or silently ignore —
 * ignoring it would start a session whose effective settings are not the ones
 * on disk, which is the one lie a config layer must never tell.
 *
 * Unknown keys are validated never but preserved always: they ride through
 * reads and writes untouched, so a key from a newer build survives a downgrade
 * round-trip. Filtering them out of the session is `effective-env`'s job — the
 * file layer reports what is on disk, honestly; the env boundary decides what
 * the session sees.
 */

export type ConfigFileRead =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly values: Readonly<Record<string, string>> }
  | { readonly configError: string };

export function readConfigFile(path: string): ConfigFileRead {
  if (!existsSync(path)) return { kind: "absent" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { configError: `The config file at ${path} is not valid JSON: ${String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { configError: `The config file at ${path} must be a JSON object.` };
  }

  const raw = parsed as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      return {
        configError: `The config file at ${path} holds "${id}" as ${describeJson(value)}; every setting is a string.`,
      };
    }
    // Only this build's table is validated: an unknown key rides along
    // untouched, and a known key's syntax is checked exactly once, here,
    // so the resolvers downstream keep owning semantics only.
    const key = configKeyById(id);
    if (key !== undefined) {
      const verdict: ConfigValidation = key.validate(value);
      if (!verdict.ok) return { configError: `${key.label} (in the config file): ${verdict.error}` };
    }
    values[id] = value;
  }
  return { kind: "read", values };
}

/**
 * Merges updates into the file and writes it atomically.
 *
 * A `""` update removes the key — unset, in file terms, is absence, matching
 * how `effective-env` reads the file. Keys this build does not know are
 * carried through untouched, so the merge never eats an entry it cannot name.
 * Returns the same configError a read would, because an update that cannot
 * read the current file has nothing safe to merge onto.
 */
export function updateConfigFile(
  path: string,
  updates: Readonly<Record<string, string>>,
): ConfigFileRead {
  const current = readConfigFile(path);
  if ("configError" in current) return current;

  const merged: Record<string, string> = current.kind === "read"
    ? { ...current.values }
    : {};
  for (const [id, value] of Object.entries(updates)) {
    const key = configKeyById(id);
    if (key === undefined) {
      return { configError: `Unknown setting "${id}".` };
    }
    const verdict = key.validate(value);
    if (!verdict.ok) return { configError: `${key.label}: ${verdict.error}` };
    // "" is unset, and unset is written as absence — never as an empty string
    // the next read would have to mean something by.
    if (value.length === 0) delete merged[id];
    else merged[id] = value;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, merged);
  return { kind: "read", values: merged };
}

function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "a nested object";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "a boolean";
  return `a ${typeof value}`;
}

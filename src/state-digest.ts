import type { WorldState } from "./protocol.js";
import { createHash } from "node:crypto";

export const WORLD_STATE_DIGEST_VERSION = "world-state-digest-v1" as const;

/** Canonical JSON with recursively sorted object keys and preserved array order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Canonical JSON cannot encode this value.");
  return encoded;
}

export function digestWorldState(state: WorldState): string {
  const input = canonicalJson({ algorithmVersion: WORLD_STATE_DIGEST_VERSION, state });
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

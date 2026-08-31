import { renameSync, writeFileSync } from "node:fs";

/**
 * The one atomic write: temp file plus rename, so a crash mid-write leaves the
 * previous file intact rather than a truncated one.
 *
 * Extracted from `app-model.ts`, which needed the same guarantee for Pi's
 * `models.json`/`auth.json` that the config file needs for itself. Both write
 * small JSON documents the same process reads back; the single-process
 * read-modify-write needs no locking, only the crash window closed. Two copies
 * of a write idiom is two places to disagree about the temp suffix, and a stray
 * temp file that outlived a crash is exactly the litter a shared helper cleans
 * up by being predictable about its name.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.squid.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

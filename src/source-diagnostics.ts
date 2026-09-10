import { describeErrorForAudit } from "./audit-text.js";
import type { ActivitySourceDiagnostic } from "./activity-source.js";

/**
 * How many diagnostics a source keeps. The only standing consumer reads the
 * newest one (`SourceManager` shows it as the qualifying sentence on a
 * "Watching" card); everything older is debug context. Twenty is enough to see
 * a developing fault and its recovery in one glance, and small enough that a
 * source wedged since boot stays cheap.
 */
const MAX_KEPT_DIAGNOSTICS = 20;

/**
 * Bounded diagnostic log shared by every activity source.
 *
 * A source that fails on every poll records a diagnostic on every poll — a
 * wedged screen reader polls once a second, so a month at the desk is
 * millions of entries if the array is append-only. The reader is the same
 * shape in all five sources, so the cap is too: the newest `MAX_KEPT_DIAGNOSTICS`
 * entries are kept, and each new one pushes the oldest out.
 *
 * The live sink (`onDiagnostic`) still sees every entry the moment it happens —
 * the ring only bounds what the source *remembers*, not what it says.
 */
export class SourceDiagnosticLog {
  private readonly entries: ActivitySourceDiagnostic[] = [];
  private readonly onDiagnostic: ((diagnostic: ActivitySourceDiagnostic) => void) | undefined;

  public constructor(onDiagnostic?: (diagnostic: ActivitySourceDiagnostic) => void) {
    this.onDiagnostic = onDiagnostic;
  }

  public record(kind: ActivitySourceDiagnostic["kind"], error: unknown): void {
    const diagnostic: ActivitySourceDiagnostic = {
      kind,
      message: describeErrorForAudit(error),
      occurredAt: new Date().toISOString(),
    };
    this.entries.push(diagnostic);
    if (this.entries.length > MAX_KEPT_DIAGNOSTICS) {
      this.entries.splice(0, this.entries.length - MAX_KEPT_DIAGNOSTICS);
    }
    this.onDiagnostic?.(diagnostic);
  }

  /** A copy, so a reader can neither mutate the ring nor watch it move. */
  public get diagnostics(): readonly ActivitySourceDiagnostic[] {
    return this.entries.map((diagnostic) => ({ ...diagnostic }));
  }
}

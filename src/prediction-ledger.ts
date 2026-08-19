import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { Compile } from "typebox/compile";
import { Type } from "typebox";
import type { PredictionOutcome } from "./prediction-provider.js";
import type { PredictionCandidate, PredictionKind } from "./protocol.js";

export const feedbackKinds = [
  "accepted",
  "rejected",
  "expired",
  "dispatched",
  "succeeded",
  "failed",
] as const;

export type PredictionFeedbackKind = (typeof feedbackKinds)[number];

export interface PredictionCandidateEnvelope {
  readonly candidateId: string;
  readonly ordinal: number;
  readonly candidate: PredictionCandidate;
}

export interface PredictionAttemptRecord {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly recordType: "attempt";
  readonly requestId: string;
  readonly episodeId: string | null;
  readonly triggerEventId: string;
  readonly triggeredAt: string;
  readonly completedAt: string;
  readonly provider: string;
  readonly status: PredictionOutcome["status"];
  readonly latencyMs: number;
  readonly fallbackReason?: string;
  readonly candidates: readonly PredictionCandidateEnvelope[];
}

export interface PredictionFeedbackRecord {
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly recordType: "feedback";
  readonly feedbackId: string;
  readonly requestId: string;
  readonly candidateId: string;
  readonly feedback: PredictionFeedbackKind;
  readonly occurredAt: string;
  readonly details: Record<string, string | number | boolean | null>;
}

export type PredictionLedgerRecord = PredictionAttemptRecord | PredictionFeedbackRecord;

export interface PredictionLedger {
  appendAttempt(record: PredictionAttemptRecord): Promise<void>;
  appendFeedback(record: PredictionFeedbackRecord): Promise<void>;
  all(): Promise<readonly PredictionLedgerRecord[]>;
}

export interface PredictionFeedbackInput {
  readonly feedbackId: string;
  readonly requestId: string;
  readonly candidateId: string;
  readonly feedback: PredictionFeedbackKind;
  readonly occurredAt?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const candidateSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("draft_completion"),
    Type.Literal("run_tests"),
    Type.Literal("inspect_error"),
    Type.Literal("search_selection"),
    Type.Literal("none"),
  ]),
  rationale: Type.String(),
  confidence: Type.Number(),
  expiresAt: Type.String({ minLength: 1 }),
  sourceEventIds: Type.Array(Type.String()),
  parameters: Type.Record(Type.String(), scalar),
}, { additionalProperties: false });
const envelopeSchema = Type.Object({
  candidateId: nonEmptyString(),
  ordinal: Type.Integer({ minimum: 0 }),
  candidate: candidateSchema,
}, { additionalProperties: false });
const attemptSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  recordId: nonEmptyString(),
  recordType: Type.Literal("attempt"),
  requestId: nonEmptyString(),
  episodeId: Type.Union([Type.String(), Type.Null()]),
  triggerEventId: nonEmptyString(),
  triggeredAt: timestamp(),
  completedAt: timestamp(),
  provider: nonEmptyString(),
  status: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("timeout"),
    Type.Literal("cancelled"),
    Type.Literal("stale"),
  ]),
  latencyMs: Type.Number({ minimum: 0 }),
  fallbackReason: Type.Optional(Type.String()),
  candidates: Type.Array(envelopeSchema),
}, { additionalProperties: false });
const feedbackSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  recordId: nonEmptyString(),
  recordType: Type.Literal("feedback"),
  feedbackId: nonEmptyString(),
  requestId: nonEmptyString(),
  candidateId: nonEmptyString(),
  feedback: Type.Union(feedbackKinds.map((kind) => Type.Literal(kind))),
  occurredAt: timestamp(),
  details: Type.Record(Type.String(), scalar),
}, { additionalProperties: false });
const recordValidator = Compile(Type.Union([attemptSchema, feedbackSchema]));

export class PredictionLedgerConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PredictionLedgerConflictError";
  }
}

export class PredictionLedgerReferenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PredictionLedgerReferenceError";
  }
}

export interface PredictionLedgerDiagnostic {
  readonly kind: "truncated_final_record";
  readonly line: number;
}

export function candidateEnvelopes(
  requestId: string,
  candidates: readonly PredictionCandidate[],
): readonly PredictionCandidateEnvelope[] {
  if (requestId.length === 0) throw new TypeError("Prediction request ID must not be empty.");
  return candidates.map((candidate, ordinal) => ({
    candidateId: `${requestId}:candidate:${ordinal}`,
    ordinal,
    candidate: structuredClone(candidate),
  }));
}

export function createAttemptRecord(input: {
  readonly triggerEventId: string;
  readonly episodeId: string | null;
  readonly triggeredAt: string;
  readonly completedAt: string;
  readonly outcome: PredictionOutcome;
  readonly candidates: readonly PredictionCandidateEnvelope[];
}): PredictionAttemptRecord {
  return parsePredictionLedgerRecord({
    schemaVersion: 1,
    recordId: `attempt:${input.outcome.requestId}`,
    recordType: "attempt",
    requestId: input.outcome.requestId,
    episodeId: input.episodeId,
    triggerEventId: input.triggerEventId,
    triggeredAt: input.triggeredAt,
    completedAt: input.completedAt,
    provider: input.outcome.provider,
    status: input.outcome.status,
    latencyMs: input.outcome.latencyMs,
    ...(input.outcome.fallbackReason !== undefined ? { fallbackReason: input.outcome.fallbackReason } : {}),
    candidates: input.candidates,
  }) as PredictionAttemptRecord;
}

export function createFeedbackRecord(
  input: PredictionFeedbackInput,
  now = new Date(),
): PredictionFeedbackRecord {
  return parsePredictionLedgerRecord({
    schemaVersion: 1,
    recordId: `feedback:${input.feedbackId}`,
    recordType: "feedback",
    feedbackId: input.feedbackId,
    requestId: input.requestId,
    candidateId: input.candidateId,
    feedback: input.feedback,
    occurredAt: input.occurredAt ?? now.toISOString(),
    details: structuredClone(input.details ?? {}),
  }) as PredictionFeedbackRecord;
}

export function parsePredictionLedgerRecord(value: unknown): PredictionLedgerRecord {
  if (!recordValidator.Check(value)) {
    throw new TypeError("Prediction ledger record failed protocol validation.");
  }
  const record = recordValidator.Parse(value) as PredictionLedgerRecord;
  if (record.recordType === "attempt") {
    for (const envelope of record.candidates) {
      if (envelope.candidateId !== `${record.requestId}:candidate:${envelope.ordinal}`) {
        throw new TypeError("Prediction candidate ID does not match its request and ordinal.");
      }
    }
  }
  return structuredClone(record);
}

export class InMemoryPredictionLedger implements PredictionLedger {
  private readonly index = new LedgerIndex();

  public async appendAttempt(record: PredictionAttemptRecord): Promise<void> {
    this.append(parsePredictionLedgerRecord(record));
  }

  public async appendFeedback(record: PredictionFeedbackRecord): Promise<void> {
    this.append(parsePredictionLedgerRecord(record));
  }

  public async all(): Promise<readonly PredictionLedgerRecord[]> {
    return this.index.all();
  }

  private append(record: PredictionLedgerRecord): void {
    if (this.index.hasEquivalent(record)) return;
    this.index.assertCanAccept(record);
    this.index.add(record);
  }
}

export class JsonlPredictionLedger implements PredictionLedger {
  private readonly index = new LedgerIndex();
  private writeTail: Promise<void> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private repairAtBytes: number | null = null;
  private readDiagnostics: PredictionLedgerDiagnostic[] = [];

  public constructor(private readonly filePath: string) {}

  public get diagnostics(): readonly PredictionLedgerDiagnostic[] {
    return this.readDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  public appendAttempt(record: PredictionAttemptRecord): Promise<void> {
    return this.append(parsePredictionLedgerRecord(record));
  }

  public appendFeedback(record: PredictionFeedbackRecord): Promise<void> {
    return this.append(parsePredictionLedgerRecord(record));
  }

  public async all(): Promise<readonly PredictionLedgerRecord[]> {
    await this.writeTail;
    await this.ensureLoaded();
    return this.index.all();
  }

  private async append(record: PredictionLedgerRecord): Promise<void> {
    const write = this.writeTail.then(async () => {
      await this.ensureLoaded();
      if (this.index.hasEquivalent(record)) return;
      this.index.assertCanAccept(record);
      await mkdir(dirname(this.filePath), { recursive: true });
      if (this.repairAtBytes !== null) {
        await truncate(this.filePath, this.repairAtBytes);
        this.repairAtBytes = null;
      }
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
      this.index.add(record);
    });
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = this.loadExisting();
    await this.loadPromise;
  }

  private async loadExisting(): Promise<void> {
    this.readDiagnostics = [];
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        this.loaded = true;
        return;
      }
      throw error;
    }

    const lines = content.split("\n");
    const terminal = lines.pop();
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      const record = parseLedgerLine(line, index + 1);
      if (!this.index.hasEquivalent(record)) this.index.add(record);
    }
    if (terminal !== undefined && terminal.length > 0) {
      try {
        const record = parsePredictionLedgerRecord(JSON.parse(terminal));
        if (!this.index.hasEquivalent(record)) this.index.add(record);
      } catch (error) {
        if (error instanceof SyntaxError) {
          this.readDiagnostics.push({ kind: "truncated_final_record", line: lines.length + 1 });
          this.repairAtBytes = Buffer.byteLength(lines.join("\n"), "utf8")
            + (lines.length > 0 ? Buffer.byteLength("\n", "utf8") : 0);
        } else {
          throw new Error(`Invalid prediction ledger record at line ${lines.length + 1}.`, { cause: error });
        }
      }
    }
    this.loaded = true;
  }
}

class LedgerIndex {
  private readonly records: PredictionLedgerRecord[] = [];
  private readonly byRecordId = new Map<string, PredictionLedgerRecord>();
  private readonly byRequestId = new Map<string, PredictionAttemptRecord>();
  private readonly candidateIds = new Set<string>();
  private readonly requestByCandidateId = new Map<string, string>();

  public hasEquivalent(record: PredictionLedgerRecord): boolean {
    const existing = this.byRecordId.get(record.recordId);
    return existing !== undefined && stableJson(existing) === stableJson(record);
  }

  public assertCanAccept(record: PredictionLedgerRecord): void {
    const existing = this.byRecordId.get(record.recordId);
    if (existing !== undefined) {
      throw new PredictionLedgerConflictError(`Ledger record ${record.recordId} conflicts with an existing record.`);
    }
    if (record.recordType === "attempt") {
      const existingAttempt = this.byRequestId.get(record.requestId);
      if (existingAttempt !== undefined) {
        throw new PredictionLedgerConflictError(`Prediction request ${record.requestId} already has an attempt record.`);
      }
      const ids = new Set<string>();
      for (const candidate of record.candidates) {
        if (ids.has(candidate.candidateId) || this.candidateIds.has(candidate.candidateId)) {
          throw new PredictionLedgerConflictError(`Candidate ${candidate.candidateId} already exists.`);
        }
        ids.add(candidate.candidateId);
      }
    } else if (!this.candidateIds.has(record.candidateId)) {
      throw new PredictionLedgerReferenceError(`Feedback references unknown candidate ${record.candidateId}.`);
    } else if (this.requestByCandidateId.get(record.candidateId) !== record.requestId) {
      throw new PredictionLedgerReferenceError(
        `Feedback candidate ${record.candidateId} does not belong to request ${record.requestId}.`,
      );
    }
  }

  public add(record: PredictionLedgerRecord): void {
    this.assertCanAccept(record);
    this.records.push(structuredClone(record));
    this.byRecordId.set(record.recordId, record);
    if (record.recordType === "attempt") {
      this.byRequestId.set(record.requestId, record);
      for (const candidate of record.candidates) {
        this.candidateIds.add(candidate.candidateId);
        this.requestByCandidateId.set(candidate.candidateId, record.requestId);
      }
    }
  }

  public all(): readonly PredictionLedgerRecord[] {
    return structuredClone(this.records);
  }
}

function nonEmptyString() {
  return Type.String({ minLength: 1 });
}

function timestamp() {
  return Type.String({ format: "date-time", minLength: 1 });
}

function parseLedgerLine(line: string, lineNumber: number): PredictionLedgerRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid prediction ledger record at line ${lineNumber}.`, { cause: error });
  }
  try {
    return parsePredictionLedgerRecord(decoded);
  } catch (error) {
    throw new Error(`Invalid prediction ledger record at line ${lineNumber}.`, { cause: error });
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

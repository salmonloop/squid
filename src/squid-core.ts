import { compareActivityEvents, eventIdentity, orderActivityEvents } from "./chronicle-ordering.js";
import type { EventStore } from "./event-store.js";
import { HeuristicPredictor, type Predictor } from "./baseline-predictor.js";
import { parseActivityEvent, type ActivityEvent, type PredictionCandidate, type WorldState } from "./protocol.js";
import { buildWorldState, cloneWorldState, reduceWorldState } from "./world-state.js";

export type IngestDisposition = "accepted" | "duplicate" | "late";

export interface IngestResult {
  disposition: IngestDisposition;
  state: WorldState;
  baselinePredictions: readonly PredictionCandidate[];
}

export class ChronicleConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChronicleConflictError";
  }
}

export class SquidCore {
  private state: WorldState = buildWorldState([]);
  private latestProjectedEvent: ActivityEvent | null = null;
  private readonly eventsById = new Map<string, ActivityEvent>();
  private readonly eventsByIdentity = new Map<string, ActivityEvent>();
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly eventStore: EventStore,
    private readonly predictor: Predictor = new HeuristicPredictor(),
  ) {}

  public get currentState(): WorldState {
    return cloneWorldState(this.state);
  }

  public async ingest(input: ActivityEvent): Promise<IngestResult> {
    return this.enqueue(() => this.ingestInternal(input));
  }

  public async restore(): Promise<WorldState> {
    return this.enqueue(() => this.restoreInternal());
  }

  private async ingestInternal(input: ActivityEvent): Promise<IngestResult> {
    const event = parseActivityEvent(input);
    const duplicate = this.inspectDuplicate(event);
    if (duplicate) {
      return this.result("duplicate");
    }

    const late = this.latestProjectedEvent !== null
      && compareActivityEvents(event, this.latestProjectedEvent) < 0;

    await this.eventStore.append(event);
    this.remember(event);

    if (late) {
      const canonicalEvents = orderActivityEvents([...this.eventsById.values()]);
      this.replaceProjection(canonicalEvents);
      return this.result("late");
    }

    this.state = reduceWorldState(this.state, event);
    this.latestProjectedEvent = event;
    return this.result("accepted", event.occurredAt);
  }

  private async restoreInternal(): Promise<WorldState> {
    const events = orderActivityEvents((await this.eventStore.all()).map(parseActivityEvent));
    const restoredById = new Map<string, ActivityEvent>();
    const restoredByIdentity = new Map<string, ActivityEvent>();

    for (const event of events) {
      const existingById = restoredById.get(event.eventId);
      if (existingById) {
        if (sameEventRecord(existingById, event)) continue;
        throw new ChronicleConflictError(`Event ID ${event.eventId} conflicts with an existing event.`);
      }

      const identity = eventIdentity(event);
      const existingByIdentity = restoredByIdentity.get(identity);
      if (existingByIdentity) {
        if (sameSourceRecord(existingByIdentity, event)) continue;
        throw new ChronicleConflictError(`Source-local event identity ${identity} conflicts with an existing event.`);
      }

      restoredById.set(event.eventId, event);
      restoredByIdentity.set(identity, event);
    }

    const canonicalEvents = orderActivityEvents([...restoredById.values()]);
    this.resetIndex();
    for (const event of canonicalEvents) {
      this.remember(event);
    }
    this.replaceProjection(canonicalEvents);
    return cloneWorldState(this.state);
  }

  private replaceProjection(canonicalEvents: readonly ActivityEvent[]): void {
    this.state = buildWorldState(canonicalEvents);
    this.latestProjectedEvent = canonicalEvents.at(-1) ?? null;
  }

  private result(disposition: IngestDisposition, predictionTime = this.state.updatedAt): IngestResult {
    const state = cloneWorldState(this.state);
    const baselinePredictions = predictionTime === null
      ? []
      : this.predictor.predict(cloneWorldState(this.state), new Date(predictionTime));

    return {
      disposition,
      state,
      baselinePredictions: structuredClone(baselinePredictions),
    };
  }

  private inspectDuplicate(event: ActivityEvent): boolean {
    const existingById = this.eventsById.get(event.eventId);
    if (existingById) {
      if (sameEventRecord(existingById, event)) return true;
      throw new ChronicleConflictError(`Event ID ${event.eventId} conflicts with an existing event.`);
    }

    const identity = eventIdentity(event);
    const existingByIdentity = this.eventsByIdentity.get(identity);
    if (existingByIdentity) {
      if (sameSourceRecord(existingByIdentity, event)) return true;
      throw new ChronicleConflictError(`Source-local event identity ${identity} conflicts with an existing event.`);
    }

    return false;
  }

  private remember(event: ActivityEvent): void {
    this.eventsById.set(event.eventId, event);
    this.eventsByIdentity.set(eventIdentity(event), event);
  }

  private resetIndex(): void {
    this.eventsById.clear();
    this.eventsByIdentity.clear();
  }

  private async enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function sameEventRecord(left: ActivityEvent, right: ActivityEvent): boolean {
  return stableJson({ ...left, ingestedAt: undefined }) === stableJson({ ...right, ingestedAt: undefined });
}

function sameSourceRecord(left: ActivityEvent, right: ActivityEvent): boolean {
  const { eventId: _leftEventId, ingestedAt: _leftIngestedAt, ...leftRecord } = left;
  const { eventId: _rightEventId, ingestedAt: _rightIngestedAt, ...rightRecord } = right;
  return stableJson(leftRecord) === stableJson(rightRecord);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

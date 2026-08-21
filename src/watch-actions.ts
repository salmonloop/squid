import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CapabilityDispatcher,
  type ActionResult,
} from "./capability-gateway.js";
import { McpCapabilityGateway } from "./mcp-gateway.js";
import type { PredictionCandidate, PredictionKind } from "./protocol.js";
import type { PredictionLedger } from "./prediction-ledger.js";
import type { PredictionRuntime } from "./prediction-runtime.js";

/**
 * The prediction kinds the live dispatch loop is willing to act on. This is
 * narrower than the MCP gateway's mapping on purpose: `run_tests` executes a
 * command on this machine, and no user-confirmation step exists yet (see
 * README "What is not yet implemented"), so it is not auto-dispatched.
 */
const autoDispatchKinds: readonly PredictionKind[] = ["search_selection"];

export interface WatchActionsResolution {
  readonly dispatcher: CapabilityDispatcher;
  readonly gatewayId: string;
  /** Closes the client transport. */
  close(): Promise<void>;
}

/**
 * Wires the real MCP transport and dispatcher seams together from the
 * environment variables the watch entry points use — the same split as
 * `watch-provider.ts`: everything env-dependent and dependency-heavy lives
 * here, while the pieces underneath are pure and unit-tested.
 *
 * Returning `undefined` means actions stay off — the default, identical to
 * the pre-dispatch behavior. A recognized variable holding an unrecognized
 * value is a config error, reported before any sink opens, so a typo cannot
 * silently disable execution and look like a working setup.
 */
export async function resolveWatchActions(
  runtime: PredictionRuntime,
  ledger: PredictionLedger,
  env: Record<string, string | undefined> = process.env,
): Promise<WatchActionsResolution | undefined | { readonly configError: string }> {
  const mode = env.SQUID_ACTIONS;
  if (mode === undefined) {
    return undefined;
  }
  if (mode !== "mcp") {
    return { configError: 'SQUID_ACTIONS must be "mcp" or unset.' };
  }

  const command = env.SQUID_ACTIONS_MCP_COMMAND?.trim();
  if (command === undefined || command.length === 0) {
    return { configError: "SQUID_ACTIONS=mcp requires SQUID_ACTIONS_MCP_COMMAND." };
  }

  const [executable, ...args] = command.split(/\s+/);
  const client = new Client({ name: "squid", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: executable!, args }));

  const gateway = new McpCapabilityGateway({ client });
  return {
    dispatcher: new CapabilityDispatcher({ runtime, gateway, ledger }),
    gatewayId: gateway.id,
    close: () => client.close(),
  };
}

/**
 * The automatic half of the closed loop: after a prediction outcome settles,
 * dispatch its best still-fresh dispatchable candidate through the given
 * dispatcher, or return null when nothing qualifies.
 *
 * Expiry is enforced here because nothing else does — the coordinator ranks
 * candidates but never checks `expiresAt`, so an expired candidate that sat at
 * the top would otherwise execute on stale context. Only kinds in
 * `autoDispatchKinds` are eligible; the rest are skipped even when ranked
 * higher, because acting on them needs a confirmation step that does not
 * exist yet.
 *
 * The candidate ID format (`requestId:candidate:ordinal`) is derived from the
 * candidate's position in the outcome rather than carried separately — the
 * dispatcher re-resolves it against the ledger and refuses unknown IDs, so a
 * wrong derivation surfaces as a failed dispatch, not a silent no-op.
 */
export function dispatchTopCandidate(
  outcome: { readonly requestId: string },
  candidates: readonly PredictionCandidate[],
  dispatcher: CapabilityDispatcher,
  now = new Date(),
): Promise<ActionResult | null> {
  const eligible = candidates
    .map((candidate, ordinal) => ({ candidate, ordinal }))
    .filter(({ candidate }) => autoDispatchKinds.includes(candidate.kind))
    .filter(({ candidate }) => Date.parse(candidate.expiresAt) > now.getTime())
    .sort((left, right) => right.candidate.confidence - left.candidate.confidence);

  const chosen = eligible[0];
  if (chosen === undefined) {
    return Promise.resolve(null);
  }

  return dispatcher.dispatch(`${outcome.requestId}:candidate:${chosen.ordinal}`);
}

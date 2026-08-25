import { Compile } from "typebox/compile";
import { Type, type TSchema } from "typebox";
import type { AdmissionContext, AdmissionResult } from "./action-admission.js";
import type { ProjectCheck, ProjectProfile } from "./project-detect.js";
import type { PredictionKind } from "./protocol.js";

/**
 * The capability surface, as data.
 *
 * It used to be two `switch (kind)` statements — one in `action-planner.ts` deciding how a
 * kind becomes a command, one in `action-admission.ts` deciding when it may run — over a
 * five-value closed union. That made the answer to "what can Squid do" a property of the
 * type system: three executable things, two of them literally `bun`. No model, however
 * capable, could widen it, and the model's whole authority was reordering three
 * rule-generated candidates.
 *
 * So the surface becomes a registry. A capability is a `ToolDescriptor`: a schema for the
 * arguments a model must supply, a `render` that turns validated arguments into a concrete
 * invocation, and an optional `guard` for the world-still-matches checks that are specific
 * to it. Adding a capability is registering a descriptor, and there is exactly one place
 * that knows how each one is built and when it may run.
 *
 * What does *not* move into the model's hands: whether the arguments are valid, whether a
 * path is contained, and whether the world still matches. Those are decided here, by code,
 * over whatever the model proposed — the same neural-proposes/symbolic-decides split the
 * belief layer uses.
 */

/** How much of the outside world a tool can reach. Declared, not inferred. */
export type ToolRisk =
  /** Reads project state and reports. Nothing observable changes. */
  | "read_only"
  /** Runs project tooling: may write build output, caches, or fixtures. */
  | "mutates_workspace"
  /** Leaves the machine. Governed by the egress policy, never by risk alone. */
  | "external";

export interface RenderedInvocation {
  /** Gateway tool name — the capability the gateway will actually call. */
  readonly tool: string;
  /**
   * The invocation, as an argv array where a command is involved.
   *
   * Never a shell string. Nothing downstream needs a shell, and a string would have to be
   * re-split by whoever runs it — which is exactly where quoting bugs and injection live.
   * A model-authored argument therefore cannot introduce a pipe, a redirect, or a `;`.
   */
  readonly argv?: readonly string[];
  /** Non-command arguments, for tools that are not a subprocess. */
  readonly arguments?: Readonly<Record<string, string | number | boolean | null>>;
  /** Operator-facing description. Must never quote user text. */
  readonly summary: string;
  readonly canonicalWorkingDirectory: string | null;
  readonly canonicalTarget: string | null;
}

export interface ToolRenderFailure {
  readonly reasonCode: ToolRenderFailureReason;
}

/**
 * Why a tool could not be rendered. A closed vocabulary because these are compared in
 * tests and counted in diagnostics; a reason carrying a path would put user text into
 * both.
 */
export type ToolRenderFailureReason =
  | "arguments_invalid"
  | "workdir_missing"
  | "workdir_not_absolute"
  | "workdir_control_characters"
  | "workdir_unresolvable"
  | "path_absolute"
  | "path_control_characters"
  | "path_escapes_workdir"
  | "path_unresolvable"
  | "command_unavailable";

export interface ToolRenderContext {
  readonly workingDirectory?: string;
  /** Injected in tests; defaults to the platform realpath. */
  readonly resolvePath?: (path: string) => Promise<string>;
  /** What the project itself declares it can run. */
  readonly project?: ProjectProfile;
}

export interface ToolDescriptor {
  /** Stable identifier a candidate names and the ledger records. */
  readonly id: string;
  readonly title: string;
  /**
   * Semantic category, from the closed prediction vocabulary.
   *
   * Kept because `kind` still earns its keep: the evaluation corpus scores against it,
   * belief values map onto it, and the ledger report groups by it. What it no longer does
   * is *select* the capability — that is `id`. The two cannot drift because a candidate
   * copies its `kind` from here rather than setting it independently.
   */
  readonly category: PredictionKind;
  /** Arguments a model must supply. Validated against this, never trusted. */
  readonly parameters: TSchema;
  readonly risk: ToolRisk;
  /**
   * Whether the user is asked before this runs.
   *
   * A property of the tool rather than of the run: a read-only tool has nothing to
   * confirm, while a command that writes does. `resolveAutorun` can force this to `none`
   * globally, which is a separate decision from what a tool asks for by default.
   */
  readonly confirmation: "none" | "required";
  render(
    args: Readonly<Record<string, unknown>>,
    context: ToolRenderContext,
  ): Promise<RenderedInvocation | ToolRenderFailure>;
  /**
   * Checks specific to this tool, run after every generic admission check.
   *
   * Absent means the generic checks are sufficient — which is true for a read-only tool
   * whose target was already contained at render time. It is never a way to skip the
   * generic checks; those run first, unconditionally.
   */
  guard?(context: AdmissionContext): AdmissionResult;
}

export function isRenderFailure(
  value: RenderedInvocation | ToolRenderFailure,
): value is ToolRenderFailure {
  return "reasonCode" in value;
}

/**
 * The tools one run may propose.
 *
 * Built per run rather than as a module constant, because what is available depends on the
 * project: a `lint` tool exists only when the project declares a lint command. A registry
 * is therefore a fact about this repository at this moment, and a stored `toolId` is
 * checked against it rather than assumed to still exist.
 */
export class ToolRegistry {
  private readonly byId = new Map<string, ToolDescriptor>();
  private readonly validators = new Map<string, ReturnType<typeof Compile>>();

  public constructor(descriptors: readonly ToolDescriptor[] = []) {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  public register(descriptor: ToolDescriptor): void {
    if (this.byId.has(descriptor.id)) {
      throw new TypeError(`Tool ${descriptor.id} is already registered.`);
    }
    this.byId.set(descriptor.id, descriptor);
    // Compiled once at registration. The validator is used on every prediction, and
    // compiling per call would put schema compilation on the prediction path.
    this.validators.set(descriptor.id, Compile(descriptor.parameters));
  }

  public get(toolId: string): ToolDescriptor | undefined {
    return this.byId.get(toolId);
  }

  public has(toolId: string): boolean {
    return this.byId.has(toolId);
  }

  /** Registration order, which is the order a prompt lists them in. */
  public get all(): readonly ToolDescriptor[] {
    return [...this.byId.values()];
  }

  public get ids(): readonly string[] {
    return [...this.byId.keys()];
  }

  /**
   * True when these arguments satisfy the tool's schema.
   *
   * Separate from `render` so a caller can refuse a malformed proposal before doing
   * filesystem work, and so the model-facing normalization and the planner share one
   * answer about validity rather than each having an opinion.
   */
  public validateArguments(toolId: string, args: unknown): boolean {
    const validator = this.validators.get(toolId);
    if (validator === undefined) return false;
    return validator.Check(args);
  }
}

/**
 * The prompt-facing view of one registered tool: pure data, no behavior.
 *
 * A descriptor's `render` and `guard` are code — closures over path containment
 * and admission policy — and must never travel toward a model. What a model may
 * see is exactly what it needs to propose well: the id to name, the title to
 * understand it by, the category its proposal will be grouped under, the
 * argument schema to satisfy, and the risk class. Anything more is attack
 * surface; anything less is guessing.
 */
export interface ToolSummary {
  readonly id: string;
  readonly title: string;
  readonly category: PredictionKind;
  /**
   * The argument schema itself, sent verbatim rather than paraphrased. A TSchema
   * is a plain object tree, so it crosses the boundary as data — and sending the
   * real thing means the prompt and the validator cannot disagree about what
   * counts as a valid proposal, which a hand-written description eventually
   * would.
   */
  readonly parameters: unknown;
  readonly risk: ToolRisk;
}

/**
 * Summarizes a registry in registration order — which is the order the prompt
 * lists them in, because that order is itself a signal about what is common.
 */
export function summarizeTools(registry: ToolRegistry): readonly ToolSummary[] {
  return registry.all.map((descriptor) => ({
    id: descriptor.id,
    title: descriptor.title,
    category: descriptor.category,
    parameters: descriptor.parameters,
    risk: descriptor.risk,
  }));
}

/** Argument schema shared by every tool that names a file inside the project. */
export const containedPathSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
}, { additionalProperties: false });

/**
 * A project check class, by name.
 *
 * The command is not in the schema, and that is the point: a model asks for "the lint
 * check", and which command that is comes from `detectProject`. A model naming the command
 * itself would be a model choosing what runs on the machine from a string it composed,
 * which is the one thing the argv discipline exists to prevent. The field name follows the
 * captured fact (`commandClass` in terminal capture and admission) so candidates feed this
 * schema without translation.
 */
export function projectCheckSchema(available: readonly ProjectCheck[]): TSchema {
  return Type.Object({
    commandClass: Type.Union(available.map((check) => Type.Literal(check))),
  }, { additionalProperties: false });
}

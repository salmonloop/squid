/**
 * Smoke run for the graphical confirmation surface: a real window, a real
 * click, a real decision.
 *
 * This is the one check that cannot be a unit test. `tests/` injects a stub
 * transport or a stub child process, which is right — what those verify is the
 * surface's own logic, and binding them to a renderer would make them slow and
 * flaky for no gain. But it means nothing in `bun test` can fail if the window
 * never maps, if a click never reaches the answer channel, or if the binary
 * aborts on a missing runtime library. Slint loads its X11 dependencies
 * dynamically, so `cargo build` succeeding proves nothing about any of that.
 *
 * So this drives the *production* chain — `createConfirmation`, the same
 * function `resolveWatchActions` calls — against the compiled binary under a
 * virtual display, and clicks the button with `xdotool`. A pass means the whole
 * path holds end to end; a failure names which link broke.
 *
 * Run with `bun run ui:smoke`. Requires `Xvfb` and `xdotool`, and a binary built
 * by `cargo build --release` in `ui/`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createConfirmation } from "./watch-actions.js";
import type { ImmutableActionPlan } from "./action-plan.js";

/**
 * The plan the window will display. Fixed, because this checks plumbing.
 *
 * A full `ImmutableActionPlan` rather than the loose shape the surface tests use:
 * those live in `tests/`, which is outside `tsconfig.json`, so nothing there
 * checks the plan against the real type. This file is under `src/`, so the
 * compiler holds it to the shape `confirm` actually takes.
 */
const PLAN: ImmutableActionPlan = {
  planSchemaVersion: 1,
  kind: "run_tests",
  descriptorId: "run_tests",
  candidateId: "smoke:candidate:0",
  attemptId: "smoke:attempt:0",
  tool: "run_command",
  arguments: { command: "cd /workspace && bun test" },
  summary: "cd /workspace && bun test",
  confirmation: "required",
  canonicalWorkingDirectory: "/workspace",
  canonicalTarget: null,
};

/**
 * Where the window's buttons are, in window-relative pixels.
 *
 * The layout is `prompt.slint`'s: a 460px-wide window with Decline then Approve
 * right-aligned at the bottom. Hard-coding coordinates is the trade this script
 * accepts — it is checking that a click lands, not that the layout is pretty,
 * and a Slint accessibility query would be a second thing to get wrong.
 */
const APPROVE_AT = { x: 400, y: 120 } as const;
const DECLINE_AT = { x: 315, y: 120 } as const;

const log = (message: string) => process.stdout.write(`${message}\n`);

/** Fails the run with a message rather than a stack trace. */
function fail(message: string): never {
  process.stderr.write(`ui:smoke failed — ${message}\n`);
  process.exit(1);
}

/** Runs a helper to completion, resolving to its exit code and stdout. */
function run(
  command: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<{ readonly code: number | null; readonly stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

/**
 * Starts an X server on a free display and returns its number.
 *
 * `Xvfb` directly rather than `xvfb-run`, because this script needs the display
 * for two cooperating processes — the window and `xdotool` — and `xvfb-run`
 * wraps a single command. `-displayfd` has the server pick a free number and
 * report it, which avoids racing another test run for `:99`.
 */
async function startDisplay(): Promise<{ readonly display: string; readonly stop: () => void }> {
  const server = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x1024x24"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const display = await new Promise<string>((resolve, reject) => {
    let seen = "";
    server.on("error", () => reject(new Error("Xvfb is not installed")));
    server.on("exit", () => reject(new Error("Xvfb exited before reporting a display")));
    server.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const line = seen.split("\n")[0];
      if (line !== undefined && seen.includes("\n") && line.trim().length > 0) {
        resolve(`:${line.trim()}`);
      }
    });
  });
  return { display, stop: () => server.kill() };
}

/**
 * Waits for the window to map, then returns its X11 id.
 *
 * Polls rather than sleeping a fixed interval: first-window latency includes
 * GPU-less renderer setup, which is fast on one machine and slow on another, and
 * a fixed sleep would be either flaky or needlessly slow.
 */
async function awaitWindow(display: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = await run("xdotool", ["search", "--name", "^Squid$"], { DISPLAY: display });
    const id = found.stdout.trim().split("\n")[0];
    if (id !== undefined && id.length > 0 && (await isViewable(display, id))) {
      return id;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("no Squid window appeared within 10s (missing libxkbcommon-x11?)");
}

/**
 * Whether a window is actually on screen.
 *
 * `xdotool search` keeps matching a window after it is hidden, so its presence
 * is not the question — `Map State` is. This is exactly the distinction that
 * makes "the window disappears once answered" checkable at all.
 */
async function isViewable(display: string, windowId: string): Promise<boolean> {
  const info = await run("xwininfo", ["-id", windowId], { DISPLAY: display });
  return info.stdout.includes("IsViewable");
}

/** Clicks one point inside the window. */
async function click(
  display: string,
  windowId: string,
  at: { readonly x: number; readonly y: number },
): Promise<void> {
  await run(
    "xdotool",
    ["mousemove", "--window", windowId, String(at.x), String(at.y), "click", "1"],
    { DISPLAY: display },
  );
}

/**
 * Answers one prompt by clicking, and checks the decision and the window state.
 *
 * The `confirm` call is started but deliberately not awaited before the click:
 * it only resolves *because* of the click, so awaiting first would deadlock. The
 * engine's own timeout is what bounds this if the click never lands.
 */
async function expectDecision(
  policy: ReturnType<typeof createConfirmation>,
  display: string,
  at: { readonly x: number; readonly y: number },
  expected: string,
  label: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const decided = policy.confirm({ candidateId: `smoke:${label}`, plan: PLAN, expiresAt });
  const windowId = await awaitWindow(display);
  await click(display, windowId, at);
  const decision = await decided;
  const actual = decision.outcome === "rejected" ? decision.reason : decision.outcome;
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
  // Answering must take the window away. A dialog still on screen after a
  // decision invites a second click on a question that is already settled.
  if (await isViewable(display, windowId)) {
    fail(`${label}: the window stayed on screen after the decision`);
  }
  log(`  ${label}: ${actual}, window hidden`);
}

async function main(): Promise<void> {
  const binary =
    process.argv[2] ??
    join(dirname(new URL(import.meta.url).pathname), "..", "ui", "target", "release", "squid-ui");
  try {
    await access(binary);
  } catch {
    fail(`no binary at ${binary} — run \`cargo build --release\` in ui/`);
  }

  const started = await startDisplay().catch((error: Error) => fail(error.message));
  log(`virtual display ${started.display}, binary ${binary}`);

  // The transport spawns the binary with this process's environment — that is
  // the production behavior, and giving `createConfirmation` an env parameter
  // just for a smoke run would put test-only surface area in the shipped seam.
  // So the display is published here, before the policy exists, and the child
  // inherits it like any other daemon-launched UI would.
  process.env.DISPLAY = started.display;

  // The production factory, not a hand-built policy: this is the same call
  // `resolveWatchActions` makes for `SQUID_ACTION_CONFIRM=graphical`, so a break
  // in that wiring fails here too. The timeout is generous because a human
  // watching this run is not the one clicking.
  const policy = createConfirmation(
    { mode: "graphical", command: binary, args: [] },
    { timeoutMs: 20_000 },
  );

  try {
    await expectDecision(policy, started.display, APPROVE_AT, "accepted", "approve");
    // The same process serves the second prompt — one window per session, not
    // one per question — so this also covers the kept-alive path.
    await expectDecision(policy, started.display, DECLINE_AT, "user_rejected", "decline");
    log("ui:smoke passed");
  } finally {
    await policy.close?.();
    started.stop();
  }
}

await main();

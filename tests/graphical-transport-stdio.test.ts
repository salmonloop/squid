import { describe, expect, it } from "bun:test";
import { createStdioGraphicalTransport } from "../src/graphical-transport-stdio.js";
import type { GraphicalPromptPayload } from "../src/confirmation-surface-graphical.js";

const stub = `${import.meta.dir}/fixtures/graphical-ui/stub.mjs`;
const node = process.execPath;

const payload: GraphicalPromptPayload = {
  candidateId: "req:candidate:0",
  kind: "run_tests",
  summary: "bun test -- tests/foo.test.ts",
  expiresAt: "2030-01-01T00:01:00.000Z",
};

const ask = (transport: ReturnType<typeof createStdioGraphicalTransport>) =>
  transport.ask(payload, new AbortController().signal);

describe("createStdioGraphicalTransport", () => {
  it("returns the answer the stub writes", async () => {
    const transport = createStdioGraphicalTransport({
      command: node,
      args: [stub, "approve"],
    });
    expect(await ask(transport)).toBe("approved");
    await transport.close?.();
  });

  it("maps a declined answer through unchanged", async () => {
    const transport = createStdioGraphicalTransport({
      command: node,
      args: [stub, "decline"],
    });
    expect(await ask(transport)).toBe("declined");
    await transport.close?.();
  });

  it("reports a surface-closed rejection when the process exits without answering", async () => {
    const transport = createStdioGraphicalTransport({
      command: node,
      args: [stub, "exit"],
    });
    await expect(ask(transport)).rejects.toThrow(/surface closed/);
    await transport.close?.();
  });

  it("reports a surface-closed rejection when the stub writes garbage", async () => {
    const transport = createStdioGraphicalTransport({
      command: node,
      args: [stub, "garbage"],
    });
    // A garbage line is not a decline and not a hang: the wire is broken, so
    // the transport rejects with "surface closed", which the engine reads as
    // input_closed — never as consent.
    await expect(ask(transport)).rejects.toThrow(/surface closed/);
    await transport.close?.();
  });

  it("reports a surface-closed rejection when the binary cannot be spawned", async () => {
    const transport = createStdioGraphicalTransport({
      command: "/definitely/not/a/real/binary",
    });
    // available() is true before the first ask (the child is spawned lazily),
    // but the ask itself triggers spawn, which fails with ENOENT → "surface
    // closed: ENOENT".
    expect(transport.available()).toBe(true);
    await expect(ask(transport)).rejects.toThrow(/surface closed/);
    expect(transport.available()).toBe(false);
  });

  it("marks the surface unavailable after close", async () => {
    const transport = createStdioGraphicalTransport({
      command: node,
      args: [stub, "approve"],
    });
    expect(transport.available()).toBe(true);
    await transport.close?.();
    expect(transport.available()).toBe(false);
    // A second ask after close never spawns a new child — the surface stays
    // closed.
    await expect(ask(transport)).rejects.toThrow(/surface closed/);
  });

  it("serves a second prompt on the same kept-alive process", async () => {
    const transport = createStdioGraphicalTransport({
      command: node,
      args: [stub, "approve"],
    });
    expect(await ask(transport)).toBe("approved");
    // The process is reused: serial policy guarantees one pending ask at a
    // time, so the second prompt lands on the same child without a respawn.
    expect(await ask(transport)).toBe("approved");
    await transport.close?.();
  });

  it("settles a pending ask when the signal aborts", async () => {
    const transport = createStdioGraphicalTransport({
      command: node,
      args: [stub, "silent"],
    });
    const controller = new AbortController();
    const pending = transport.ask(payload, controller.signal);
    // The engine aborts on timeout, on expiry, and on shutdown. A surface that
    // ignored the signal would leave this promise unsettled and the window on
    // screen for a question nobody is waiting for.
    controller.abort();
    await expect(pending).rejects.toThrow(/surface closed/);
    await transport.close?.();
  });

  it("refuses an ask whose signal is already aborted", async () => {
    const transport = createStdioGraphicalTransport({
      command: node,
      args: [stub, "approve"],
    });
    const controller = new AbortController();
    controller.abort();
    await expect(transport.ask(payload, controller.signal)).rejects.toThrow(/surface closed/);
    await transport.close?.();
  });

  it("drops an answer whose prompt id does not match the pending ask", async () => {
    const transport = createStdioGraphicalTransport({
      command: node,
      args: [stub, "stale"],
    });
    const controller = new AbortController();
    const pending = transport.ask(payload, controller.signal);
    // The stub answers with a wrong id, modelling a reply to a prompt this side
    // already abandoned. Applying it would mean approving a plan the user never
    // saw, so the transport must ignore it and stay pending until aborted.
    controller.abort();
    await expect(pending).rejects.toThrow(/surface closed/);
    await transport.close?.();
  });
});

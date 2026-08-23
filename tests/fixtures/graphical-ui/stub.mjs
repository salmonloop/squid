/**
 * A stub of the Rust UI binary, for testing `createStdioGraphicalTransport`.
 *
 * The real binary is Slint + Rust; this is plain JS so the test runs without a
 * Rust toolchain. It speaks the same line-JSON protocol:
 *
 *   stdin  ← {"type":"prompt","promptId":1,"candidateId":"...","kind":"run_tests","summary":"...","expiresAt":"..."}
 *   stdin  ← {"type":"cancel","promptId":1}
 *   stdout → {"promptId":1,"answer":"approved"}   (or "declined")
 *
 * The answer echoes the prompt's id, which is what lets the transport drop a
 * reply to a prompt it has already abandoned.
 *
 * Behavior is picked from argv[2], so one file covers every case the transport
 * must handle:
 *   approve   — answer "approved" to every prompt
 *   decline   — answer "declined" to every prompt
 *   garbage   — write a line that is not valid JSON, so the transport rejects
 *   exit      — exit before answering, so the transport sees a process exit
 *   silent    — read prompts and never answer, so only an abort or close settles
 *   stale     — answer every prompt with a fixed wrong id, so the transport must
 *               drop the reply rather than apply it to the pending ask
 */
const mode = process.argv[2] ?? "approve";

if (mode === "exit") {
  process.exit(0);
}

const send = (line) => process.stdout.write(`${line}\n`);
const answer = mode === "decline" ? "declined" : "approved";

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);

    if (mode === "garbage") {
      send("not valid json");
      continue;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // A cancel closes that prompt's window. The stub has no window, so it just
    // stops tracking the prompt — and never answers a cancelled one.
    if (message.type === "cancel" || mode === "silent") {
      continue;
    }
    if (message.type !== "prompt") {
      continue;
    }

    // `stale` models the race the promptId exists for: an answer that arrives
    // for a prompt this side has already given up on.
    const replyId = mode === "stale" ? message.promptId + 1000 : message.promptId;
    send(JSON.stringify({ promptId: replyId, answer }));
  }
});
process.stdin.on("end", () => {
  // stdin closed — the transport is shutting down.
  process.exit(0);
});

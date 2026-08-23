/**
 * A stub of the Rust UI binary, for testing `createStdioGraphicalTransport`.
 *
 * The real binary is Slint + Rust; this is plain JS so the test runs without a
 * Rust toolchain. It speaks the same line-JSON protocol:
 *
 *   stdin  ← {"type":"prompt","candidateId":"...","kind":"run_tests","summary":"...","expiresAt":"..."}
 *   stdout → {"answer":"approved"}   (or "declined")
 *
 * Behavior is picked from argv[2], so one file covers every case the transport
 * must handle:
 *   approve   — answer "approved" to every prompt
 *   decline   — answer "declined" to every prompt
 *   garbage   — write a line that is not valid JSON, so the transport rejects
 *   exit      — exit before answering, so the transport sees a process exit
 *   silent    — read stdin but never respond, so the transport only settles on close
 */
const mode = process.argv[2] ?? "approve";

if (mode === "exit") {
  process.exit(0);
}

const send = (line) => process.stdout.write(`${line}\n`);

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
    // The stub does not need to parse the prompt; it only echoes an answer.
    send(
      JSON.stringify({
        answer: mode === "decline" ? "declined" : "approved",
      }),
    );
  }
});
process.stdin.on("end", () => {
  // stdin closed — the transport is shutting down. Exit so the test's process
  // listener fires; silent mode never wrote an answer, so this is the path the
  // transport's close() must settle.
  process.exit(0);
});

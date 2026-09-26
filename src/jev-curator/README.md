# `src/jev-curator/` — vendored curator core

These four files are copied, near-verbatim, from
[`pi-jev-context-curator`](https://www.npmjs.com/package/pi-jev-context-curator)
v1.1.0 (MIT, © 2026 Shashank H — see `LICENSE`). They are the pure decision
logic: message → units, a per-session judgment checkpoint, and the one
`/v1/systemone` HTTP call.

**Why vendored rather than depended on.** The upstream package is a full Pi TUI
extension — it imports `pi-tui` for a removed-context dialog, reads
`process.env` directly in `loadConfig()`, and keeps its API key in
`~/.pi/curator-jev.json`. Squid's resident agent is headless, and every setting
it reads must arrive through the *merged* env (`effective-env.ts` lays the Squid
config file under `process.env`), so an extension that read `process.env`
itself would bypass the one contract this repo enforces about where settings
come from. The fork keeps the logic and drops the TUI: `config.ts` here is a
plain `CuratorConfig` shape with no `loadConfig()`, and the extension wrapper
(`../decision-curator-extension.ts`) is written against Squid's own
`InlineExtension` + injected keystore.

**Wire contract, unchanged.** The request is `POST {baseUrl}/v1/systemone` with
`{state, model, questions:{u0:{type:"noul",…}}}` and reads back
`answers[k].noul`. That is the hosted Jev API's shape, which OpenJev and Kev
also serve — so pointing this at a free self-hosted replica is two settings
(`decisionCuratorBaseUrl`, `decisionCuratorModel`), no code change.

**What changed from upstream, exactly:**

- `config.ts` — kept the constants and the `CuratorConfig` interface; deleted
  `loadConfig()` (the `process.env` reader) and `TAG`/pricing/`debug`.
- `units.ts` — `AgentMessage` is sourced through
  `@earendil-works/pi-coding-agent`'s `ContextEvent["messages"][number]` (the
  package this repo already pins) instead of importing `pi-agent-core`; added
  bounds guards for `noUncheckedIndexedAccess`.
- `jev.ts` — imports use `.js` extensions (NodeNext); added the same bounds
  guards. Logic byte-for-byte otherwise.
- `checkpoint.ts` — verbatim.

Not vendored: `index.ts` (the TUI wiring), `keystore.ts` (Squid has its own —
see `../decision-keystore.ts`), `stats.ts`, `removed-context*.ts` (TUI dialog).

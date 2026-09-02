---
version: 1
slug: "ui-panel-slint"
primary_target: "ui/panel.slint"
related_targets: ["ui/src/main.rs","docs/panel-protocol.md"]
---

# Panel window

**Mode:** Operate.

## Primary task

Let a non-technical person understand whether Squid is currently observing,
see evidence of its recent work, repair a source only when it needs repair, and
answer a consequential request without accidental approval.

## Success

A first-time person can: find whether watching is active; pause it; recognise
that Browser needs setup and reach exactly its setup fields; find exclusions;
recognise an API key is already stored without seeing it; decline or defer a
prompt. An expert can reach technical detail from the exact capability, without
a global Advanced area.

## Interaction rules

- Capability state and recovery belong on the same card.
- Default Home contains no raw wire vocabulary or full settings form.
- Keep native titlebar. Do not imitate drag/move controls unavailable in Slint 1.17.
- State is never colour-only. Custom controls expose a role, label, description,
and focus treatment through Slint accessibility.
- Confirmation takes the top of the resident window, above the scroll region, with
no default action and fail-closed close. A separate Window is the eventual shape;
see DESIGN.md for why it is not what ships yet.

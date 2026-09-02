# Squid panel design system

## Intent

A quiet, native Windows control centre for a person who wants to know whether
Squid is watching, what it recently noticed, and whether it needs a decision.
The UI is an **Operate** surface: trust, legibility, and recoverability outrank
visual novelty.

## Visual world

- **Foundation:** explicitly compile Slint's Fluent widget style, retain the
  native Windows title bar and familiar platform controls.
- **Theme:** `Palette.color-scheme` drives a semantic token layer. Canvas,
  raised surface, primary/secondary text, border, focus, action, calm,
  caution, and danger are tokens; a component may not introduce a literal
  status colour.
- **Type:** bundled readable sans when licensing allows; otherwise tested
  system sans fallback. Dense but not tiny: body is never diagnostic 10–11px
  text. Monospace is reserved for an already user-requested command detail.
- **Icons:** authored SVG `Path` icons with one rounded stroke system. No emoji
  or unicode glyphs as state icons.
- **Depth:** restrained raised surfaces, one-pixel borders, offset soft shadow
  only where FemtoVG rendering demonstrates it remains legible. No decorative
  gradients or glass.
- **Motion:** 150–250ms ease-out for local reveal/state feedback only. No
  perpetual healthy-state spinner; reduced-motion must resolve to an equally
  clear static state.

## Information architecture

The resident Home answers, in order:

1. **What is Squid doing now?** A text + shaped state indicator, consequence
   sentence, and last confirmed time.
2. **What did it recently notice?** A short evidence feed, not internal event
   vocabulary.
3. **What can it use?** Capability cards that are themselves the route into
   their own status, setup, privacy explanation, and technical detail.

There is no global Advanced page, switch, tab, or catch-all menu. A control is
advanced only relative to the capability it configures, so it is found from that
capability's detail surface. Controls that cannot affect a consumer decision
(such as a polling interval) do not occupy the normal path.

## Status vocabulary

Each state is identified by shape + plain title + consequence sentence + colour:

- **Watching** — current evidence is arriving.
- **Paused** — Squid will not record new activity until resumed.
- **Working** — Squid is considering a recent change.
- **Limited** — part of the experience is unavailable, but self-recovery is in progress.
- **Needs a hand** — a person has one concrete action to take.
- **Waiting for you** — a decision is pending; only this state earns a numeric badge.

Never claim current health from stale data. A disconnected or stale session says
when it was last heard from and disables/redirects actions honestly.

## Progressive disclosure

- A card reveals its setup only when the user opens that card or its state needs
  repair. The repair button opens precisely the fields needed, not a settings wall.
- Fields are named after a result: “Keep activity for”, “Don't watch these apps”,
  “Connect a model”. They never expose variable names as labels.
- Contextual “Technical details” is a local escape hatch for raw diagnostics,
  poll paths, and environment provenance. It is never the first content nor a
  global skill level.
- Privacy/observing status, pause/resume, pending decisions, exclusion controls,
  and non-self-healing faults remain discoverable without disclosure.

## Confirmation

A confirmation takes over the top of the resident window, directly under the
status header and above the scroll region. It cannot be pushed off-screen by
content below it, and the status header names the pending decision rather than
reporting health. It always shows decision-critical information: action, reason,
outcome of refusal, a sanitized summary, and expiry. It never receives command
arguments or selection text. Allow, Decline, and Later are visually balanced; no
button is the default, Return cannot approve, and closing/expiry/disconnect fail
closed. Later defers without deciding, and the deferred decision stays visible
until it is answered or expires.

A separate native window is the eventual shape, because a consequential decision
deserves protected focus. It is deliberately not what ships here: the defect worth
fixing first was that the decision was invisible and unreachable, and moving it
above the fold fixes that with one window's lifecycle instead of two. Promoting it
to its own window is a later change, not a rewrite of this one.

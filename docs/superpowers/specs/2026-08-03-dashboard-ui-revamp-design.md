# Dashboard UI Revamp — Design Spec

**Status:** self-directed (user unavailable for this session; decisions below are mine, made in their stead, and are open to revision on review).

## Context

`public/index.html` + `app.js` + `styles.css` (~400 lines total, no build step, vanilla JS/CSS, served statically by `dashboard-server.ts`) is the only UI in the product: a local daemon dashboard for running SSH commands on registered servers by opaque id. Three views — Live, History, Servers — plus a WebSocket-fed live feed.

Current look: pure-black background, Geist/Geist Mono, hairline borders, green/amber/red status dots. Functionally solid but visually generic — Geist is a top-tier "AI/Vercel-template" tell, the layout is the default sidebar+cards shape everyone ships, and several interactions (native `confirm()`, blank-flash loading, plain error text) feel unfinished rather than intentional.

## Concept: "Ops console, not sales page"

This is a tool sysadmins/agents live in for hours, not a marketing surface — so the direction is **refined technical minimalism** grounded in real ops-console/terminal-multiplexer conventions (Warp, OrbStack, tmux, avionics HUDs), not dashboard-template maximalism. Distinctiveness comes from precision and restraint, not decoration.

- **Canvas**: near-black but warm (`#0b0a08`), not flat `#000` — a room with a light on, not a void.
- **Accent**: one deliberate color, warm phosphor-amber (`#ffb238`), used only for brand mark, active states, focus rings, primary actions. Status semantics stay separate: green=running, gray=idle, red=error — these are information, not brand.
- **Type**: Hanken Grotesk (UI sans) + Fragment Mono (ids, commands, logs, timestamps) — replaces Geist/Geist Mono. Both are legitimate, uncommon choices, not on any AI-tell list.
- **Shape language**: small radii (4–6px), hairline 1px borders, no glow/blur shadows, no edge accent bars on cards.
- **Texture**: a very faint animated grain/scanline overlay on the canvas only — a CRT/terminal nod that's grounded in the ops-console metaphor, not decorative.
- **Motion**: one orchestrated staggered reveal on view load; a live pulse on the "running" dot; everything else (hovers, nav) is a fast, quiet 120ms — no scroll animations, no count-ups.

## UX changes beyond reskinning

1. **Command palette (⌘K / Ctrl+K)** — fuzzy-jump to a server, switch view, or start "Register a server". Matches the keyboard-first audience.
2. **Sidebar**: search box, servers grouped into "Active" (has a running job) / "All", live daemon-socket connection indicator in the top bar (connected/reconnecting) — trust signal for an SSH tool.
3. **Live view**: real terminal-panel treatment for output (monospace, auto-scroll with a "jump to latest" pill once the user scrolls up, per-run copy-to-clipboard). Empty state explains *why* it's empty and how to start a run, not "No active runs."
4. **History view**: filter by server id / exit code, duration + timestamp as a compact meta row, expand/collapse long output instead of a fixed 220px scroll box for every row.
5. **Servers view**: register/edit moves into a slide-over panel (was inline push-down), custom confirm dialog replaces native `confirm()` on delete, bulk import keeps its textarea but gets real inline JSON validation feedback and a toast on completion instead of a static result line.
6. **Toast system** for transient feedback (bulk import result, delete confirmed, connection dropped).
7. **Keyboard nav**: `g` then `l/h/s` (or plain `1/2/3`) to switch views, `Esc` closes palette/slide-over, visible focus rings everywhere.
8. **Loading skeletons** for the first fetch instead of a blank flash.

## Explicit non-goals (YAGNI)

- No frontend framework/build step — stays vanilla JS/CSS per existing architecture (`CLAUDE.md` documents this as intentional).
- No new backend endpoints/API shape changes — same `/api/servers`, `/api/servers/bulk`, `/api/servers/:id`, `/api/history`, `/api/live` contract.
- No auth, no new persistence beyond `localStorage` for last-active view/theme.
- No light-theme toggle — this is a single-purpose dark ops tool; not worth the surface area right now.

## Verification plan

Implement directly in `public/`, then use `agent-browser` to screenshot the three views at a couple of widths and read every screenshot for clipping/overflow/contrast issues before calling it done (per the project's UI-quality bar). No daemon changes needed, so a plain static file server is enough for the screenshot pass — the real daemon is never started for this.

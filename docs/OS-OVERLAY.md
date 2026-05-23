# OS Overlay — Spotlight for `.yo` and `.sup`

Bring `.yo` and `.sup` out of yo-client's window boundary so they can be
invoked from anywhere on the user's machine, with screen awareness and the
ability to write back into the app the user came from.

## The user moment we're after

1. User is reading a long Slack thread and wants to draft a friendly decline.
2. Hits `Cmd+Shift+Space`. A small, frameless overlay appears.
3. Behind the scenes, yo-client snapshots the active window (Slack), OCRs /
   reads accessibility text from it, and remembers "Slack was focused, the
   compose box was the active field."
4. User types `.yo draft a friendly decline` and hits enter.
5. The yo agent receives the prompt **plus the captured Slack context** and
   streams a reply into the overlay.
6. User clicks **Insert →**. The reply lands in Slack's compose box where the
   cursor was. User reviews, hits send.

One hotkey, two clicks. The AI saw the screen and wrote into where the user
was working.

## Scope

**In scope for v1:**
- Global hotkey → frameless, always-on-top overlay window
- The full `.yo` composer UX (modes, perms, plan checkbox, model dropdown)
  in a compact form factor
- Active-window screenshot capture on invoke
- OCR pipeline (macOS Vision via shortcut shell-out; Tesseract fallback)
- macOS Accessibility-tree read as a more reliable alternative to OCR
- "Insert →" button that pastes the result back into the originating app
- Permission gating with a clear first-run flow

**Out of scope (deferred):**
- True OS-level keystroke interception (Karabiner-style typed-everywhere `.yo`)
- Windows / Linux parity for v1 — macOS only first
- Region-select capture (drag-to-rect) — v2
- Auto-insert without click confirmation — v2 preference

## Why not Path 2 (true keystroke interception)?

Every time macOS releases a new version of Privacy & Security we'd be
re-shipping. AV vendors flag it as a keylogger. Apple has been making it
harder year over year. The semantic problem ("am I typing `.yo` as a command
or as text?") guarantees misfires. The operational cost is huge for a small
delta over Path 1. Defer indefinitely unless there's a specific user moment
that *only* keystroke interception solves.

## Architecture

### Hotkey + overlay window

```
Electron globalShortcut.register("CommandOrControl+Shift+Space", showOverlay)

showOverlay():
  capture()                         // screenshot + OCR/AX in parallel
  rememberFocus()                   // foreground app + focused element
  createOverlayWindow({             // frameless, transparent, alwaysOnTop
    width: 600, height: 360,
    show: false, frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
  })
```

The overlay is a separate `BrowserWindow` (not a panel inside the main
window). Its renderer is a stripped-down `.yo` composer that talks to the
existing yo-agent via the same IPC bridges main.ts already exposes.

### Capture pipeline

Three sources of context, ranked by reliability:

| Source            | Tool                         | macOS perm        | Quality |
|-------------------|------------------------------|-------------------|---------|
| Accessibility tree | `node-mac-accessibility` / AppleScript | Accessibility    | Best (clean text, no OCR errors) |
| Screen pixels      | `desktopCapturer.getSources` | Screen Recording  | Always available |
| OCR of pixels      | macOS Vision via `shortcuts run` (fallback: Tesseract.js) | Screen Recording | Good enough |

The capture function tries AX first (clean text from the window's text
elements), falls back to screenshot + OCR if the foreground app isn't
accessible (some games, deep native apps).

Capture happens **on invoke**, not continuously. Privacy story: nothing
ever leaves the device unless the user hits enter on a query that pulls
the capture into context.

### Focus tracking

Before showing the overlay, capture:
- `foregroundWindow` — the bundle id / window title of what was focused
- `focusedElement` — via AX API on macOS, the active text field (if any)

The overlay keeps these for the "Insert →" round-trip. If the user moves
focus to another app while the agent thinks, we just bail on auto-insert
and copy the result to the clipboard instead, with a toast: "Copied —
focus moved during thinking."

### Round-trip: response → originating app

Three insertion strategies, picked by routing rules:

1. **yo-client panel** — capture came from a BrowserView inside yo-client
   (browser tab, terminal, etc.). Use the existing relay/RPA tools:
   `rpa.type(panelId, selector, text)`. Precise, no new permissions.
2. **External native app (clipboard-paste)** — save user's clipboard, set
   it to the response, simulate `Cmd+V`, restore clipboard. Works
   everywhere, survives focus loss, no risk of typing into the wrong
   field. Default mode.
3. **External native app (direct typing)** — character-by-character via
   `@nut-tree/nut-js` or `robotjs`. No clipboard side effects, slower,
   slightly more brittle in rich text editors. Opt-in via preference.

All three are triggered by the same "Insert →" button in the overlay —
the routing happens transparently based on where the capture came from.

### Permissions

macOS asks for:
1. **Screen Recording** — required for `desktopCapturer`. One-time grant
   in System Settings → Privacy & Security → Screen Recording.
2. **Accessibility** — required for reading AX text from foreground app
   AND for simulating keystrokes back. One-time grant.

First-run UX: when the user opens the overlay for the first time, we
detect both permissions and walk them through granting each one with a
clear "why we need this" panel. After grant, restart yo-client. After
that, it's silent.

### IPC surface

New IPC channels (main ↔ overlay window only):

| Channel                 | Direction | Purpose |
|-------------------------|-----------|---------|
| `overlay-show`          | main→r    | Triggered by global hotkey |
| `overlay-capture`       | r→main    | Request screenshot + OCR/AX of foreground window |
| `overlay-submit`        | r→main    | User hit enter; main routes to yoAgent.send |
| `overlay-stream-token`  | main→r    | Agent token streaming back |
| `overlay-stream-done`   | main→r    | Agent done — final text + insertion strategy |
| `overlay-insert`        | r→main    | User hit "Insert →"; main does the clipboard/typing dance |
| `overlay-dismiss`       | r→main    | User hit ESC or clicked outside |

The overlay reuses the existing `yo-panel-input` UI as much as possible —
modes, perms, plan checkbox, model dropdown all carry over. Same `setAgentMode`,
same `getLLMConfig`, etc.

### Files this introduces

```
src/main/overlay-window.ts       // window lifecycle, hotkey reg, focus tracking
src/main/screen-capture.ts       // desktopCapturer wrapper + OCR pipeline
src/main/accessibility-mac.ts    // AX-tree read + write (focused element)
src/main/insert-router.ts        // routes response to panel / clipboard / typing
src/renderer/overlay.html        // overlay markup (compact composer)
src/renderer/overlay.ts          // overlay renderer (reuses yo-panel-ui pieces)
src/renderer/overlay-preload.ts  // contextBridge for overlay-* channels
```

Plus a `build:overlay` step in `package.json` modeled on `build:council` /
`build:waz`.

## Phase plan

### v1 — invoke, capture, insert (target: 2 weeks focused)

- [ ] Global hotkey + frameless overlay window
- [ ] Active-window screenshot via `desktopCapturer`
- [ ] macOS Vision OCR pipeline (`shortcuts run`)
- [ ] AX-tree read for accessible foreground apps
- [ ] Focus tracking on invoke
- [ ] Wire to existing `yoAgent.send()` with captured context
- [ ] "Insert →" via clipboard-paste (default)
- [ ] Permission first-run flow

### v1.5 — polish

- [ ] Auto-insert preference (user-confirmed by default)
- [ ] Direct-typing alternative to clipboard-paste
- [ ] Region-select capture (drag-to-rect like Cmd+Shift+4)
- [ ] Overlay positioning preferences (top center, near cursor, last position)
- [ ] Multiple-monitor handling

### v2 — Windows parity

- [ ] Windows hotkey + overlay
- [ ] Windows screen capture (no permission needed)
- [ ] Windows UI Automation API for the AX-tree equivalent
- [ ] Windows clipboard-paste / SendInput keystroke simulation

### v2+ — beyond

- macOS Services menu integration ("right-click selection → Send to .yo")
- Browser extension as a separate surface
- iOS / mobile — via the relay (overlay phone app talks to your desktop's yo-client)

## What this does NOT do

- It does not intercept your typing. The hotkey is the only entry point.
- It does not screenshot continuously. Capture happens on invoke.
- It does not send anything to yo-server until you hit enter. The screenshot
  + OCR sit in main process memory until then.
- It does not auto-insert by default. The user always sees the response in
  the overlay and chooses to insert.

## Open questions

1. **Overlay position** — top center (like Spotlight), centered (like Raycast),
   or near cursor? Probably top center, configurable.
2. **Dismiss behavior** — ESC to close, click-outside to close, both?
3. **History** — does the overlay show recent overlay sessions, or are those
   just regular chats in the yo-client history? Probably the latter — one
   chat history, accessible from both surfaces.
4. **`.sup` UX** — does `.sup` close the overlay immediately with a toast,
   or stay open showing what was captured? Probably toast + close.
5. **Multi-monitor** — show on the monitor with the foreground window, or
   always on the primary? Probably foreground.

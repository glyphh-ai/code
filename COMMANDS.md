# YoSup Command Reference

Three verbs: `.yo` (capture), `.sup` (retrieve/process), `.dip` (navigate).
One effect: `.drip` (animations).

## `.yo` — Capture (screen → memory)

| Command | Action |
|---|---|
| `.yo .` | Capture active panel → context store + clipboard |
| `.yo . <skill>` | Capture → process with skill → inject result |
| `.yo . <prompt>` | Capture → process with prompt → inject result |
| `.yo . .dip <panel>` | Capture, then navigate (chainable with .dip) |
| `.yo` (bare) | No-op |

## `.sup` — Retrieve / Process → inject into text area

| Command | Action |
|---|---|
| `.sup` | Open library browser |
| `.sup <query>` | Search context store → inject raw results |
| `.sup . <skill>` | Process **last capture** (from `.yo .`) with skill → inject |
| `.sup . <prompt>` | Process **last capture** with prompt → inject |
| `.sup <query> . <skill>` | Search memory + process with skill → inject |
| `.sup <query> . <prompt>` | Search memory + process with prompt → inject |

The `.` separates query from processor. No query + `.` = use the last `.yo .` capture as input.

## `.dip` — Navigate

| Command | Action |
|---|---|
| `.dip <panel>` | Switch to panel |
| `.dip <layout>` | Apply saved layout (auto-detected by name) |
| `.dip <url>` | Navigate active panel to URL |
| `.dip . <panel>` | Swap calling panel within current grid |
| `.dip back` | Previous panel |
| `.dip split <a> <b> ...` | Side-by-side split |
| `.dip grid <cells> / <cells>` | Full grid with spans and custom widths |
| `.dip add <url>` | Add new app panel |
| `.dip list` | List all apps and layouts |
| `.dip refresh [panel]` | Refresh panel |
| `.dip zoom <val>` | Set zoom level |
| `.dip clear-session [panel]` | Clear panel session data |

## `.drip` — Effects

| Command | Action |
|---|---|
| `.drip <animation>` | Play a CSS animation effect |

## Utilities

| Command | Action |
|---|---|
| `.yo help` | Help overlay |
| `.yo skills` | Skills manager |
| `.yo layout` | Layouts manager |

# YoSup Command Reference

Three verbs: `.yo` (search/retrieve), `.sup` (capture), `.dip` (navigate).
One effect: `.drip` (animations).

## `.yo` — Search & Retrieve (the brain)

| Command | Action |
|---|---|
| `.yo` (bare) | Open search widget / library browser |
| `.yo <query>` | Search context store → open inline widget with results |
| `.yo . <skill>` | Process **last capture** (from `.sup`) with skill → inject |
| `.yo . <prompt>` | Process **last capture** with prompt → inject |
| `.yo <query> . <skill>` | Search memory + process with skill → inject |
| `.yo <query> . <prompt>` | Search memory + process with prompt → inject |

The `.` separates query from processor. No query + `.` = use the last `.sup` capture as input.

## `.sup` — Capture (screen → memory)

| Command | Action |
|---|---|
| `.sup` | Capture active panel → context store + clipboard |
| `.sup .` | Capture active panel (explicit dot modifier) |
| `.sup . <skill>` | Capture → process with skill → inject result |
| `.sup . <prompt>` | Capture → process with prompt → inject result |
| `.sup . .dip <panel>` | Capture, then navigate (chainable with .dip) |

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
| `.yo skill` | Skills manager |
| `.yo layout` | Layouts manager |

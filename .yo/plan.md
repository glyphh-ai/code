# Fix Skills toolbar button alignment

## Context
On the yo-client Skills tab, the header toolbar shows a title plus two icon buttons (`+` and refresh). They are not grouped on the right: the `+` floats in the middle and refresh sits at the far right. The user wants both buttons grouped on the right edge, with **refresh next to the title-side and `+` furthest right**.

### Root cause
`.skill-tree-toolbar` (`src/renderer/styles.css:8267-8271`) uses `justify-content: space-between` with **three** flex children — title, `newBtn` (`+`), `refreshBtn`. space-between spreads them: title left, `+` middle, refresh right. The DOM order (`src/renderer/help/skills.ts:55-60`) is also `newBtn` then `refreshBtn`, i.e. `+` before refresh.

## Changes

### 1. `src/renderer/help/skills.ts` (toolbar children, ~line 55-60)
Swap button order so `+` is last (furthest right):
```ts
el("div", { class: "skill-tree-toolbar" }, [
  el("span", { class: "skill-tree-title", text: "Skills" }),
  refreshBtn,
  newBtn,
]),
```

### 2. `src/renderer/styles.css` (`.skill-tree-toolbar`, line 8268)
Drop `justify-content: space-between` and instead let the title push the buttons to the right so they group together. Add `margin-left: auto` to the title:
- `.skill-tree-toolbar`: remove `justify-content: space-between` (keep `display:flex; align-items:center; gap:8px; …`).
- `.skill-tree-title` (line 8272): add `margin-right: auto;` so the title takes the free space and the two buttons sit flush-right, separated only by the 8px gap.

Result left→right: `Skills` … (gap) … `refresh` `+`.

## Verification
- Build/run the renderer (the yo-client Electron app) and open the Skills tab.
- Confirm the header shows `Skills` on the left and both icon buttons grouped at the right edge, with refresh immediately left of `+`, and `+` flush to the right margin.
- Confirm both buttons still work: `+` opens the create menu, refresh reloads the skill list.

# Glyphh Code

**Your AI development workspace.** Glyphh Code is a desktop app — a multi-panel
Electron workspace where every panel is a live web app or tool, all driven by an
AI agent you talk to with `.yo` commands (`.yo`, `.sup`, `.dip`, `.drip`).

Open source under the [Apache-2.0](LICENSE) license. **No account, no sign-in** —
you bring your own Anthropic (Claude) API key.

> ### ⚠️ Requires a Claude API key
> Glyphh Code is built on **Anthropic's Claude** (via the
> [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)).
> The AI agent **will not work without your own Anthropic API key.** The app opens
> and runs, but the agent stays inert until you add a key. See
> [Bring your own key](#bring-your-own-key-byok) below.

## Requirements

- **Node.js 20+**
- **macOS or Windows** (native modules are rebuilt for Electron during install)
- **An Anthropic API key** — [get one here](https://console.anthropic.com/settings/keys)
  (it starts with `sk-ant-`). Usage is billed to *your* Anthropic account.

## Get started

```bash
git clone https://github.com/glyphh-ai/code.git
cd code
npm install        # postinstall runs electron-rebuild for native modules
                   # (better-sqlite3, node-pty, onnxruntime-node, …)
npm run dev        # builds the bundles, then launches the app
```

The app opens straight into the workspace — no login. If you haven't set a key
yet, it prompts you to paste your Anthropic API key (you can also add or change it
any time under **Settings → Providers**). Once a key is set, just talk to the
agent — type `.yo <what you want>` in any panel.

## Bring your own key (BYOK)

Glyphh Code talks directly to Anthropic's API using **your** key — there is no
Glyphh account, subscription, or proxy in between.

1. **Get a key:** sign in at
   [console.anthropic.com](https://console.anthropic.com/settings/keys), create an
   API key, and add credit/billing to your Anthropic account.
2. **Add it to the app:** paste it into the first-run prompt, or go to
   **Settings → Providers** and paste it there. Keys must start with `sk-ant-`.
3. **That's it** — the agent now runs on Claude (default model: Claude Sonnet).

**Where your key lives:** it is stored **locally only**, encrypted with your OS
keychain via Electron `safeStorage` (under `~/yo/`). It is never sent to any
Glyphh server and never logged. Billing and rate limits are entirely between you
and Anthropic.

**No key = no agent.** Without a key the workspace, editor, terminal, and panels
all still work, but any AI/agent action is disabled until you add one.

## Using it

Talk to the agent with the `.yo` family of commands from any panel:

- `.yo <task>` — ask the agent to do something
- `.sup` · `.dip` · `.drip` — additional agent verbs (see in-app help)

Local app data (settings, keys, history) lives under `~/yo/`.

## Build & package

```bash
npm run build          # compile/bundle everything into dist/
npm run package:mac    # signed + notarized .dmg / .zip  (needs signing secrets)
npm run package:win    # Windows installer
```

Release builds are normally produced by CI (`.github/workflows/build.yml`) on a
`v*` tag.

## Configuration (optional)

- **Anthropic key** — the only thing you *need* (see above).
- `~/yo/` — local app data (keys, preferences, history).
- Some optional, server-backed extras (cloud sync, connector catalog) look for a
  backend at `https://api.glyphh.ai` (override with `YO_AUTH_SERVER` /
  `YO_PLATFORM_URL`). None of these are required — the app and the Claude agent
  work fully offline of any Glyphh server, on your key alone.

## Roadmap

**Next up: rrotor.** We're incorporating [rrotor](https://github.com/glyphh-ai/rrotor)
— the open runtime for **RotorSpec**, the standard for *deterministic agent loops*
— into Glyphh Code's tooling. Today the agent loop lives inside the model's
context; rrotor lifts it out into a declarative, replayable, auditable artifact (a
*rotor*), with grounding, gating, and durable memory as first-class steps. Folding
rrotor into the workspace means the agent's loop becomes something you can inspect,
pin, and reason about — not just a black box. More soon.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright © 2026
Glyphh AI LLC. Contributions welcome under the same license; see
[CONTRIBUTING.md](CONTRIBUTING.md) and report vulnerabilities per
[SECURITY.md](SECURITY.md).

"Claude" and "Anthropic" are trademarks of Anthropic, PBC. Glyphh Code is an
independent project and is not affiliated with or endorsed by Anthropic.

---

> _Formerly **.yo** — this app was rebranded to Glyphh._

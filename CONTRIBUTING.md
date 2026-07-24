# Contributing to Glyphh Code

Thanks for your interest in Glyphh Code — an open-source desktop AI workspace.
This project is developed in the open under the [Apache-2.0](LICENSE) license, and
we welcome issues, discussion, and pull requests.

## Ground rules

- Be respectful. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- By contributing, you agree that your contributions are licensed under the
  Apache License, Version 2.0, per section 5 of the [LICENSE](LICENSE). No
  separate CLA is required — your pull request is your submission.

## Development

Requires Node 20+ (macOS or Windows — native modules are rebuilt for Electron on
install).

```bash
npm install        # postinstall runs electron-rebuild for native modules
npm run dev        # build main + renderer bundles, then launch Electron
```

Package builds:

```bash
npm run build          # compile/bundle everything into dist/
npm run package:mac    # signed + notarized .dmg / .zip (needs signing secrets)
npm run package:win    # Windows installer
```

Glyphh Code runs with **your own Anthropic API key** — no account or sign-in.
Paste your key on first run (or in Settings).

## Pull requests

1. Fork the repo and create a topic branch from `main`.
2. Keep changes focused; one logical change per PR.
3. Make sure `npm run build` succeeds and the app launches (`npm run dev`).
4. Open the PR with a clear description of the problem and the approach. Link any
   related issue.

## Reporting bugs & requesting features

Open a [GitHub issue](https://github.com/glyphh-ai/code/issues). For anything
security-sensitive, follow [SECURITY.md](SECURITY.md) instead of filing a public
issue.

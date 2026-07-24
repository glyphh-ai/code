# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Report privately in one of two ways:

1. **GitHub private vulnerability reporting** — use the "Report a vulnerability"
   button under the repository's **Security** tab (preferred).
2. **Email** — [security@glyphh.ai](mailto:security@glyphh.ai).

Please include: a description of the issue, the affected version, steps to
reproduce, and the impact you observed. We aim to acknowledge reports within
5 business days and to keep you informed as we investigate.

## Scope

Glyphh Code is a desktop Electron app that runs on your machine with your own
Anthropic API key. Things especially worth reporting:

- Ways a rendered panel, MCP tool, or agent action could read or exfiltrate data
  or execute code outside its intended sandbox.
- Exposure of the user's API key or other local secrets.
- IPC surfaces (main ↔ renderer) that can be abused for privilege escalation.

Please do not include real secrets in a report — redact API keys and tokens.

## Disclosure

We follow coordinated disclosure. Please give us a reasonable window to release a
fix before any public disclosure, and we'll credit you in the release notes unless
you prefer otherwise.

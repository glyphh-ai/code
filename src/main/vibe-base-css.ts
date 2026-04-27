/**
 * Base design system CSS for vibes.
 * Shared between vibe-preload (runtime injection) and main (preview IPC).
 */

export const VIBE_BASE_CSS = `
:root,
[data-theme="light"] {
  color-scheme: light;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', 'Courier New', monospace;
  --bg: #f5f5f5;
  --bg-raised: #ffffff;
  --surface: #ffffff;
  --surface-2: #fafafa;
  --surface-3: #f0f0f0;
  --border: #e5e5e5;
  --border-2: #d4d4d4;
  --border-3: #c4c4c4;
  --text: #1f2937;
  --text-bright: #111111;
  --text-2: #4b5563;
  --text-3: #6b7280;
  --text-muted: #6b7280;
  --text-faint: #9ca3af;
  --white: #111111;
  --hover: #f0f0f0;
  --active-bg: rgba(37, 199, 94, 0.06);
  --accent: #25C75E;
  --accent-hover: #22b855;
  --accent-dark: #1a9e48;
  --accent-bg: #ecfdf5;
  --danger: #ef4444;
  --danger-soft: #f87171;
  --danger-bg: #fef2f2;
  --warning: #f59e0b;
  --success: #16a34a;
  --blue: #3b82f6;
  --purple: #a855f7;
  --overlay-bg: rgba(0, 0, 0, 0.3);
  --shadow: rgba(0, 0, 0, 0.12);
  --selection: rgba(37, 199, 94, 0.2);
  --scrollbar: #d4d4d4;
  --scrollbar-hover: #25C75E;
  --code-inline: #9333ea;
  --input-bg: var(--surface-2);
  --card-bg: var(--surface);
  --radius: 8px;
  --radius-sm: 4px;
  --radius-lg: 12px;
}

[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0a0a0a;
  --bg-raised: #0d0d0d;
  --surface: #111111;
  --surface-2: #1a1a1a;
  --surface-3: #141414;
  --border: #1e1e1e;
  --border-2: #2a2a2a;
  --border-3: #333333;
  --text: #e8e8e8;
  --text-bright: #ffffff;
  --text-2: #a0a0a0;
  --text-3: #707070;
  --text-muted: #606060;
  --text-faint: #484848;
  --white: #ffffff;
  --hover: #1e1e1e;
  --active-bg: rgba(37, 199, 94, 0.08);
  --accent: #25C75E;
  --accent-hover: #2dd868;
  --accent-dark: #1da34d;
  --accent-bg: #1a2a1e;
  --danger: #ff5f57;
  --danger-soft: #ff6b6b;
  --danger-bg: #2a1515;
  --warning: #f0a030;
  --success: #28c840;
  --blue: #4A9EFF;
  --purple: #a855f7;
  --overlay-bg: rgba(0, 0, 0, 0.6);
  --shadow: rgba(0, 0, 0, 0.4);
  --selection: rgba(37, 199, 94, 0.3);
  --scrollbar: var(--accent);
  --scrollbar-hover: #25C75E;
  --code-inline: #e0a0ff;
  --input-bg: var(--surface);
  --card-bg: var(--surface-3);
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html { -webkit-font-smoothing: antialiased; }

body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  font-size: 14px;
}

::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent); }

::selection { background: var(--selection); }

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

h1, h2, h3, h4, h5, h6 { color: var(--text-bright); font-weight: 600; line-height: 1.3; }
h1 { font-size: 24px; }
h2 { font-size: 20px; }
h3 { font-size: 16px; }

code, pre {
  font-family: var(--font-mono);
  font-size: 13px;
}
code {
  background: var(--surface-2);
  padding: 2px 5px;
  border-radius: var(--radius-sm);
  color: var(--code-inline);
}
pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
  overflow-x: auto;
}
pre code { background: none; padding: 0; color: inherit; }

/* ── Buttons ── */
button, .btn {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  padding: 8px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s ease;
  line-height: 1;
}
button:hover, .btn:hover {
  border-color: var(--border-2);
  background: var(--hover);
}
.btn-primary, button.primary {
  background: var(--accent);
  color: #000;
  border-color: var(--accent);
  font-weight: 600;
}
.btn-primary:hover, button.primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.btn-danger, button.danger {
  background: var(--danger);
  color: #fff;
  border-color: var(--danger);
}
.btn-danger:hover, button.danger:hover {
  background: var(--danger-soft);
  border-color: var(--danger-soft);
}
.btn-ghost, button.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-2);
}
.btn-ghost:hover, button.ghost:hover {
  background: var(--hover);
  color: var(--text);
}
.btn-sm { font-size: 12px; padding: 5px 10px; }
.btn-lg { font-size: 15px; padding: 10px 20px; }

/* ── Inputs ── */
input, select, textarea {
  font-family: var(--font-sans);
  font-size: 13px;
  padding: 8px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--text);
  transition: border-color 0.15s ease;
  line-height: 1.4;
  width: 100%;
}
input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: var(--accent);
}
input::placeholder, textarea::placeholder {
  color: var(--text-faint);
}
select { cursor: pointer; }
textarea { resize: vertical; min-height: 80px; }
label { font-size: 12px; font-weight: 500; color: var(--text-2); display: block; margin-bottom: 4px; }

/* ── Cards ── */
.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}
.card-header { font-weight: 600; color: var(--text-bright); margin-bottom: 8px; }
.card-sm { padding: 12px; border-radius: var(--radius-sm); }
.card-lg { padding: 24px; border-radius: var(--radius-lg); }

/* ── Badges / Pills ── */
.badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 100px;
  line-height: 1.4;
}
.badge-accent { background: var(--accent-bg); color: var(--accent); }
.badge-danger { background: var(--danger-bg); color: var(--danger); }
.badge-info { background: rgba(74, 158, 255, 0.12); color: var(--blue); }
.badge-muted { background: var(--surface-2); color: var(--text-3); }

/* ── Tables ── */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; color: var(--text-2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text); }
tr:hover td { background: var(--hover); }

/* ── Utility ── */
.text-accent { color: var(--accent); }
.text-muted { color: var(--text-muted); }
.text-danger { color: var(--danger); }
.text-sm { font-size: 12px; }
.text-xs { font-size: 11px; }
.text-center { text-align: center; }
.font-mono { font-family: var(--font-mono); }
.font-bold { font-weight: 600; }
.flex { display: flex; }
.flex-col { display: flex; flex-direction: column; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }
.justify-center { justify-content: center; }
.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
.gap-4 { gap: 16px; }
.p-2 { padding: 8px; }
.p-3 { padding: 12px; }
.p-4 { padding: 16px; }
.mt-2 { margin-top: 8px; }
.mt-3 { margin-top: 12px; }
.mt-4 { margin-top: 16px; }
.mb-2 { margin-bottom: 8px; }
.mb-3 { margin-bottom: 12px; }
.w-full { width: 100%; }
.hidden { display: none; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rounded { border-radius: var(--radius); }

/* ── Loading spinner ── */
.spinner {
  width: 20px; height: 20px;
  border: 2px solid var(--border-2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Divider ── */
.divider { height: 1px; background: var(--border); margin: 16px 0; }

/* ── Transitions ── */
.fade-in { animation: fadeIn 0.2s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
`;

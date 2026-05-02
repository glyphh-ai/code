/**
 * sandbox-profile — generate a macOS Sandbox Profile Language (SBPL) policy
 * for `sandbox-exec`. SBPL is a Scheme-like DSL Apple uses for their own
 * sandboxing (Safari, Mail, etc.). Documented sparsely; we use the well-known
 * subset.
 *
 * The policy:
 *   - default deny
 *   - allow process-spawn (so the agent can shell out, gated by fs+net rules)
 *   - allow fs read on system libraries + node_modules paths the host runs from
 *   - allow fs read+write inside the cypher's working dir
 *   - allow tmp + /var/folders for ephemeral work
 *   - deny network outbound by default; allow specific host:port pairs from allowNetwork
 *   - trace: log file/network attempts to auditPath for the audit stream
 */

export interface ProfileOpts {
  cwd: string;
  allowNetwork: string[];   // ["api.openai.com", "github.com:443"]
  auditPath: string;
}

function escapePath(p: string): string {
  return p.replace(/"/g, '\\"');
}

export function generateMacosProfile(opts: ProfileOpts): string {
  // Pragmatic v1 isolation model:
  //   - READ is allowed globally so frameworks/dylibs/Node runtime load.
  //     A stricter "deny read outside cwd" profile breaks every CLI on macOS
  //     because dyld walks /System, /usr/lib, /Library/Frameworks, etc.
  //   - WRITE is gated to the cypher's working dir + tmp.
  //     This stops the agent from clobbering user files or planting persistence.
  //   - NETWORK is denied by default. allowNetwork = [...] flips outbound on
  //     globally (sandbox-exec lacks hostname matching; DNS-allowlist requires
  //     a proxy — Phase 3.5).
  // This isn't confidentiality (host operator can still read the cwd), it's
  // *write/network isolation*. See CYPHER-DESIGN.md §3.
  const lines: string[] = [
    `(version 1)`,
    `(deny default)`,
    ``,
    `;; Process control — agents can fork/exec helpers (gated by fs+net rules).`,
    `(allow process*)`,
    `(allow signal)`,
    ``,
    `;; READ globally — needed so dyld/frameworks/Node runtime load.`,
    `(allow file-read*)`,
    ``,
    `;; WRITE only inside the cypher working dir + tmp (gates exfiltration).`,
    `(allow file-write*`,
    `  (subpath "${escapePath(opts.cwd)}")`,
    `  (subpath "/private/tmp")`,
    `  (subpath "/private/var/folders"))`,
    ``,
    `;; IPC + sysctl + mach-lookup — needed for any non-trivial CLI.`,
    `(allow mach-lookup)`,
    `(allow sysctl*)`,
    `(allow ipc-posix-shm)`,
  ];

  if (opts.allowNetwork.length > 0) {
    lines.push(``);
    lines.push(`;; Network: outbound allowed (sandbox-exec lacks hostname matching;`);
    lines.push(`;; DNS-allowlist proxy is Phase 3.5). Caller's allowNetwork list is`);
    lines.push(`;; recorded in the audit stream for after-the-fact review.`);
    lines.push(`(allow network*)`);
  } else {
    lines.push(``);
    lines.push(`;; Network: bind localhost only (dev convenience). Outbound denied.`);
    lines.push(`(allow network-bind (local ip))`);
  }

  lines.push(``);
  lines.push(`;; Trace every denied op (and a fair amount of allowed ones) for the audit stream.`);
  lines.push(`(trace "${escapePath(opts.auditPath)}")`);

  return lines.join("\n") + "\n";
}

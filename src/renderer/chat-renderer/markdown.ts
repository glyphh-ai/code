/**
 * Markdown -> `.rendered-markdown` DOM, modeled on VS Code's chat markdown
 * output (docs/_reference/vscode-chat/chatContentMarkdownRenderer.ts).
 *
 * VS Code renders into a `.rendered-markdown` element using semantic tags
 * (`<p>`, `<ul>`, `<pre><code>`, …) that its `chat.css` targets directly. We
 * reproduce that DOM shape here. The renderer chain is plain ESM in the browser
 * (no bundler), so we cannot pull in `marked`/`dompurify` — this is a small,
 * self-contained parser that emits the same structure.
 *
 * Output is built as an HTML string from escaped text + a fixed allow-list of
 * tags, so model output can never inject markup.
 */

const ESC_RE = /[&<>]/g;
const ESC_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
function esc(s: string): string {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

function safeHref(url: string): string | null {
  const u = url.trim().toLowerCase();
  if (u.startsWith("http://") || u.startsWith("https://") || u.startsWith("mailto:")) {
    return url.trim();
  }
  return null;
}

/** Inline spans: code, bold, italic, links, autolinks. Operates on escaped text. */
function inline(src: string): string {
  let s = esc(src);
  // inline code first — its contents are literal
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\b_([^_\n]+)_\b/g, "<em>$1</em>");
  // [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const href = safeHref(url);
    return href ? `<a href="${esc(href)}">${text}</a>` : text;
  });
  // bare autolink
  s = s.replace(/(^|[^"=>])(https?:\/\/[^\s<>]+)/g, (_m, pre, url) => {
    const href = safeHref(url);
    return href ? `${pre}<a href="${esc(href)}">${esc(url)}</a>` : `${pre}${esc(url)}`;
  });
  return s;
}

/** Render markdown source into HTML matching VS Code's `.rendered-markdown`. */
export function renderMarkdownHtml(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\S*)/);
    if (fence) {
      const lang = fence[1] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(esc(lines[i]));
        i++;
      }
      if (i < lines.length) i++; // closing fence
      const cls = lang ? ` class="language-${esc(lang)}"` : "";
      out.push(`<pre><code${cls}>${body.join("\n")}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line) || line === ">") {
      const q: string[] = [];
      while (i < lines.length && (/^>\s?/.test(lines[i]) || lines[i] === ">")) {
        q.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(q.join("\n"))}</blockquote>`);
      continue;
    }

    // GFM table — header row, then a delimiter row (|---|:--:|), then body
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const cells = (row: string): string[] => {
        let r = row.trim();
        if (r.startsWith("|")) r = r.slice(1);
        if (r.endsWith("|")) r = r.slice(0, -1);
        return r.split("|").map((c) => c.trim());
      };
      const headers = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      const at = (idx: number) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "");
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(cells(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headers
        .map((h, idx) => `<th${at(idx)}>${inline(h)}</th>`)
        .join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map(
          (row) =>
            `<tr>${headers
              .map((_, idx) => `<td${at(idx)}>${inline(row[idx] ?? "")}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // unordered list (incl. GFM task-list checkboxes: `- [ ]` / `- [x]`)
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      let hasTask = false;
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\s*[-*+]\s+/, "");
        const task = content.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          hasTask = true;
          const checked = task[1].toLowerCase() === "x" ? " checked" : "";
          items.push(
            `<li class="task-list-item"><input type="checkbox" disabled${checked}>${inline(task[2])}</li>`,
          );
        } else {
          items.push(`<li>${inline(content)}</li>`);
        }
        i++;
      }
      const cls = hasTask ? ' class="contains-task-list"' : "";
      out.push(`<ul${cls}>${items.join("")}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // paragraph — gather until a blank line or a block starter
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join("\n"))}</p>`);
  }

  return out.join("");
}

/**
 * Render markdown into a `.rendered-markdown` element. When `target` is given,
 * its content is replaced in place (incremental re-render on streaming tokens);
 * otherwise a fresh element is created.
 */
export function renderMarkdown(text: string, target?: HTMLElement): HTMLElement {
  const el = target ?? document.createElement("div");
  el.classList.add("rendered-markdown");
  const html = renderMarkdownHtml(text);
  if (el.dataset.lastHtml === html) return el; // nothing changed — skip the swap
  el.dataset.lastHtml = html;
  el.innerHTML = html;
  return el;
}

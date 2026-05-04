/** Lightweight markdown -> HTML renderer for LLM output.
 *  Handles: code fences, headers, bold, italic, inline code, links,
 *  unordered/ordered lists, blockquotes, horizontal rules, paragraphs. */
export function formatMarkdown(text: string): string {
  if (!text) return "";

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inline = (s: string) =>
    s
      .replace(/`([^`]+)`/g, (_m: string, code: string) => {
        if (/^\.(dip|yo|sup|drip)\s/.test(code)) {
          return `<code class="yo-md-inline yo-md-cmd" data-cmd="${code}" title="Click to copy">${code}</code>`;
        }
        return `<code class="yo-md-inline">${code}</code>`;
      })
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, text: string, url: string) => {
        const trimmed = url.trim().toLowerCase();
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("mailto:")) {
          return `<a class="yo-md-link" href="${url}" title="${url}">${text}</a>`;
        }
        return `<span class="yo-md-link" title="[blocked: unsafe URL]">${text}</span>`;
      })
      .replace(/(^|[^"=])(https?:\/\/[^\s<>&]+)/g, (_match: string, prefix: string, url: string) =>
        `${prefix}<a class="yo-md-link" href="${url}" title="${url}">${url}</a>`
      );

  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(esc(lines[i]));
        i++;
      }
      if (i < lines.length) i++;
      const label = lang || "code";
      const codeId = `yo-code-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      out.push(
        `<div class="yo-md-codeblock" data-code-id="${codeId}">` +
          `<div class="yo-md-codeblock-header">` +
            `<span class="yo-md-codeblock-lang">${esc(label)}</span>` +
            `<button class="yo-md-copy-btn" data-code-id="${codeId}">Copy</button>` +
          `</div>` +
          `<pre class="yo-md-pre"><code>${codeLines.join("\n")}</code></pre>` +
        `</div>`
      );
      continue;
    }

    // Heading
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level} class="yo-md-h${level}">${inline(esc(hMatch[2]))}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr class="yo-md-hr">');
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="yo-md-quote">${inline(esc(quoteLines.join("\n")))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(inline(esc(lines[i].replace(/^[-*+]\s+/, ""))));
        i++;
      }
      out.push(`<ul class="yo-md-ul">${items.map((li) => `<li>${li}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(inline(esc(lines[i].replace(/^\d+\.\s+/, ""))));
        i++;
      }
      out.push(`<ol class="yo-md-ol">${items.map((li) => `<li>${li}</li>`).join("")}</ol>`);
      continue;
    }

    // Blank line
    if (line.trim() === "") { i++; continue; }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].match(/^[-*+]\s+/) &&
      !lines[i].match(/^\d+\.\s+/) &&
      !lines[i].startsWith("> ") &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(`<p class="yo-md-p">${inline(esc(paraLines.join("\n")))}</p>`);
  }

  return out.join("");
}

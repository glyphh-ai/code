/**
 * Web search via DuckDuckGo HTML endpoint.
 * No API key required. Uses Electron's net.request for HTTP.
 */

import { net } from "electron";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(query: string, maxResults = 8): Promise<SearchResult[]> {
  const html = await fetchHTML(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  );
  return parseResults(html, maxResults);
}

export async function fetchPage(url: string, maxChars = 8000): Promise<string> {
  const html = await fetchHTML(url);
  const text = htmlToText(html);
  if (text.length > maxChars) {
    return text.slice(0, maxChars) + "\n[truncated]";
  }
  return text;
}

// ── HTTP ──────────────────────────────────────────────

function fetchHTML(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!url || !url.startsWith("http")) {
      reject(new Error(`Invalid URL: "${url}"`));
      return;
    }
    const request = net.request({ url, method: "GET" });
    request.setHeader(
      "User-Agent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    request.setHeader("Accept", "text/html,application/xhtml+xml,*/*");
    request.setHeader("Accept-Language", "en-US,en;q=0.9");

    let body = "";
    request.on("response", (response) => {
      // Follow redirects — net.request handles 3xx automatically
      response.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.end();
  });
}

// ── DuckDuckGo HTML parsing ──────────────────────────

function parseResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DDG HTML results structure:
  // <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=ENCODED_URL&...">Title</a>
  // <a class="result__snippet" href="...">Snippet text</a>
  const resultBlockRe = /<div[^>]*class="[^"]*result\s[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;

  let block;
  while ((block = resultBlockRe.exec(html)) && results.length < max) {
    const inner = block[1];
    const titleMatch = titleRe.exec(inner);
    const snippetMatch = snippetRe.exec(inner);

    if (titleMatch) {
      let rawUrl = titleMatch[1];
      // DDG wraps URLs: //duckduckgo.com/l/?uddg=REAL_URL&...
      const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        rawUrl = decodeURIComponent(uddgMatch[1]);
      } else if (rawUrl.startsWith("//")) {
        rawUrl = "https:" + rawUrl;
      }

      results.push({
        title: stripTags(titleMatch[2]).trim(),
        url: rawUrl,
        snippet: snippetMatch ? stripTags(snippetMatch[1]).trim() : "",
      });
    }
  }

  // Fallback: if block regex didn't match, try flat extraction
  if (results.length === 0) {
    const flatTitleRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const flatSnippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const titles: { url: string; title: string }[] = [];
    let m;
    while ((m = flatTitleRe.exec(html)) && titles.length < max) {
      let rawUrl = m[1];
      const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);
      else if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;
      titles.push({ url: rawUrl, title: stripTags(m[2]).trim() });
    }

    const snippets: string[] = [];
    while ((m = flatSnippetRe.exec(html)) && snippets.length < max) {
      snippets.push(stripTags(m[1]).trim());
    }

    for (let i = 0; i < titles.length; i++) {
      results.push({
        title: titles[i].title,
        url: titles[i].url,
        snippet: snippets[i] || "",
      });
    }
  }

  return results;
}

// ── HTML → plain text ────────────────────────────────

function htmlToText(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  // Block elements → newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags
  text = stripTags(text);
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

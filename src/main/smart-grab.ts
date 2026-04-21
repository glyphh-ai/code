/**
 * SmartGrab — grab page content from a webview.
 *
 * Simple: page title + URL + body text. No app-specific selectors.
 * The capture store handles chunking and the embedder handles relevance.
 */

import { WebContents } from "electron";

const GRAB_SCRIPT = `(function() {
  var lines = [];
  lines.push("PAGE: " + document.title);
  lines.push("URL: " + location.href);
  lines.push("");
  lines.push(document.body.innerText);
  return lines.join("\\n").slice(0, 30000);
})()`;

export async function smartGrab(wc: WebContents): Promise<string | null> {
  if (wc.isDestroyed()) return null;
  try {
    const result = await wc.executeJavaScript(GRAB_SCRIPT);
    return result || null;
  } catch {
    return null;
  }
}

/**
 * dom.ts — minimal DOM helpers for screens/components. No framework.
 */

/** querySelector within an optional root (default document). */
export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

/** querySelectorAll → array. */
export function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

interface ElOpts {
  class?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string>;
  on?: Record<string, (e: Event) => void>;
}

/** Create an element with class/text/html/attrs/listeners + children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOpts = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.html != null) node.innerHTML = opts.html;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  if (opts.on) for (const [ev, fn] of Object.entries(opts.on)) node.addEventListener(ev, fn);
  for (const c of children) node.append(c);
  return node;
}

/** Replace a host's contents with `markup` (string or node) and return it. */
export function mount(host: HTMLElement, markup: string | Node): HTMLElement {
  if (typeof markup === "string") host.innerHTML = markup;
  else { host.innerHTML = ""; host.append(markup); }
  return host;
}

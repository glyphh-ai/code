/**
 * ctx.ts — typed shape of the shared workspace context + the Screen contract.
 *
 * The legacy shell.ts builds an untyped `ctx` bag that init* modules attach
 * to. New code should type against `WorkspaceCtx` (cast the bag at the call
 * site) so cross-module calls are checked. Extend this interface as core
 * modules expose APIs you depend on — only declare what's real.
 */

/** A center-stage app/slide descriptor (see launcher.ts APPS). */
export interface AppDescriptor {
  id: string;
  name: string;
  letter?: string;
  color?: string;
  iconSvg?: string;
}

/** Shared APIs the core modules register on the context (grows over time). */
export interface WorkspaceCtx {
  // confirm.ts
  wsConfirm?(message: string, opts?: { yes?: string; no?: string }): Promise<boolean>;
  // slides.ts (center stack)
  pushSlide?(app: AppDescriptor & { __body?: string; onMount?: (el: HTMLElement) => void }): void;
  popSlide?(): void;
  clearStack?(): void;
  slideStack?: Array<{ id: number; app: AppDescriptor; el: HTMLElement }>;
  // rails.ts (right rail)
  placeView?(view: string): void;
  viewIsOpen?(view: string): boolean;
  // recents.ts
  renderRecents?(): void;
  // launcher.ts
  APPS?: AppDescriptor[];
  [key: string]: unknown;
}

/**
 * A rebuilt screen. Self-contained: owns its markup + behavior, mounts into a
 * host element, optionally cleans up. Register via the shell when wired.
 */
export interface Screen {
  /** Stable id (also the rail/nav key). */
  id: string;
  /** Human label for nav. */
  label: string;
  /** Render into `host`; receives the shared ctx for cross-module calls. */
  mount(host: HTMLElement, ctx: WorkspaceCtx): void;
  /** Optional teardown when the screen is replaced/closed. */
  unmount?(): void;
}

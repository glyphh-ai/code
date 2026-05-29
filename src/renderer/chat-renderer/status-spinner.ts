/**
 * Pinned "still working" indicator. While an assistant turn is active a single
 * spinner row is kept pinned as the last child of the message container; a
 * MutationObserver moves it back to the bottom as new rows land above it
 * (without recursing on its own moves). Replaces the ad-hoc pinned spinner that
 * lived in yo-panel-ui.
 */

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const PHRASES = ["thinking", "cooking", "vibing", "brewing", "conjuring", "channeling"];

export class StatusSpinner {
  private el: HTMLElement | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private observer: MutationObserver | null = null;

  constructor(private readonly container: HTMLElement) {}

  show(): void {
    if (this.el) return;
    const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    this.el = document.createElement("div");
    this.el.className = "chat-working";
    this.el.innerHTML =
      `<span class="chat-working-spinner">⠋</span>` +
      `<span class="chat-working-phrase"></span>`;
    (this.el.querySelector(".chat-working-phrase") as HTMLElement).textContent = `${phrase}…`;
    this.container.appendChild(this.el);
    this.startTicker();
    this.startPin();
  }

  hide(): void {
    this.stopTicker();
    this.stopPin();
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }

  private startTicker(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      if (!this.el) {
        this.stopTicker();
        return;
      }
      this.frame = (this.frame + 1) % BRAILLE.length;
      const s = this.el.querySelector(".chat-working-spinner") as HTMLElement | null;
      if (s) s.textContent = BRAILLE[this.frame];
    }, 80);
  }

  private stopTicker(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private startPin(): void {
    if (this.observer) return;
    this.observer = new MutationObserver(() => {
      if (!this.el) return;
      if (this.container.lastElementChild === this.el) return;
      this.container.appendChild(this.el);
    });
    this.observer.observe(this.container, { childList: true });
  }

  private stopPin(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}

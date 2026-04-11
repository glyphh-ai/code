/**
 * Renderer — command bar logic.
 */

declare global {
  interface Window {
    yo: {
      command: (input: string) => void;
      onResult: (callback: (result: string) => void) => void;
    };
  }
}

const input = document.getElementById("command-input") as HTMLInputElement;
const output = document.getElementById("command-output") as HTMLDivElement;

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const value = input.value.trim();
    if (value) {
      window.yo.command(value);
      input.value = "";
    }
  }

  // Escape clears input
  if (e.key === "Escape") {
    input.value = "";
    input.blur();
  }
});

// Show command results
window.yo.onResult((result: string) => {
  output.textContent = result;
  // Fade out after 3 seconds
  setTimeout(() => {
    output.textContent = "";
  }, 3000);
});

// Auto-focus command input
input.focus();

const DOUBLE_ESCAPE_WINDOW_MS = 750;

export class QuitDetector {
  private lastEscapeAt = 0;

  registerKeypress(sequence: string): boolean {
    const now = Date.now();

    if (sequence === "\u001b") {
      const shouldQuit = now - this.lastEscapeAt <= DOUBLE_ESCAPE_WINDOW_MS;
      this.lastEscapeAt = now;
      return shouldQuit;
    }

    this.lastEscapeAt = 0;
    return false;
  }
}


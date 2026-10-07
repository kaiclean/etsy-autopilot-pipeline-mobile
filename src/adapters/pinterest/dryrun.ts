import type { PinInput, PinterestAdapter } from "./types";

/** Records what would be pinned. Never makes network calls. */
export class PinterestDryRunAdapter implements PinterestAdapter {
  readonly mode = "dry-run" as const;
  readonly calls: PinInput[] = [];

  async createPin(input: PinInput) {
    this.calls.push(input);
    return { pinId: `dry-pin-${Date.now().toString(36)}-${this.calls.length}` };
  }
}

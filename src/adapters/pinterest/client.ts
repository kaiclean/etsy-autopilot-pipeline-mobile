import type { PinterestTokens } from "@/lib/settings";
import type { PinInput, PinterestAdapter } from "./types";

const API = "https://api.pinterest.com/v5";
/** Refresh this long before expiry. */
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Pinterest API v5. New apps start on Trial access, where created pins are visible only to you;
 * public pins need Standard access. Needs scopes boards:read and pins:write.
 */
export class PinterestLiveClient implements PinterestAdapter {
  readonly mode = "live" as const;

  constructor(
    private tokens: PinterestTokens,
    private app: { id: string; secret: string },
    private save: (t: PinterestTokens) => Promise<void>,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken() {
    if (Date.now() < this.tokens.expiresAt - REFRESH_MARGIN_MS) return this.tokens.accessToken;
    const res = await this.fetchImpl(`${API}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.app.id}:${this.app.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.tokens.refreshToken }),
    });
    if (!res.ok) throw new Error(`Pinterest token refresh ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    this.tokens = {
      accessToken: json.access_token,
      // Keep the old refresh token unless Pinterest issues a new one.
      refreshToken: json.refresh_token ?? this.tokens.refreshToken,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    await this.save(this.tokens);
    return this.tokens.accessToken;
  }

  async createPin(input: PinInput) {
    const media_source =
      input.image.kind === "url"
        ? { source_type: "image_url", url: input.image.url }
        : { source_type: "image_base64", content_type: input.image.contentType, data: input.image.data };
    const res = await this.fetchImpl(`${API}/pins`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        board_id: input.boardId,
        title: input.title,
        description: input.description,
        link: input.link,
        alt_text: input.altText,
        media_source,
      }),
    });
    if (!res.ok) throw new Error(`Pinterest ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { id: string };
    return { pinId: String(json.id) };
  }
}

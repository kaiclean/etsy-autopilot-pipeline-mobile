/** Serialize catalog reads and stop on rate limits; never retry a write. */
export class SupplierHttp {
  private tail: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    private api: string,
    private headers: Record<string, string>,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  request<T>(path: string, body?: object): Promise<T> {
    const run = this.tail.catch(() => {}).then(async () => {
      const wait = this.nextRequestAt - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.nextRequestAt = Date.now() + 1000;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.api}${path}`, {
          method: body ? "POST" : "GET",
          headers: { ...this.headers, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        // Do not expose echoed credentials, request bodies, or signed URLs.
        throw new Error("Supplier API request failed");
      }
      if (res.status === 429) {
        const raw = res.headers.get("Retry-After");
        const seconds = raw == null ? NaN : Number(raw);
        const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(raw ?? "");
        this.nextRequestAt = Math.max(this.nextRequestAt, Number.isFinite(until) ? until : Date.now() + 60_000);
      }
      if (!res.ok) throw new Error(`Supplier API returned ${res.status}${res.status === 429 ? " (rate limited)" : ""}`);
      try {
        return await res.json() as T;
      } catch {
        throw new Error("Invalid supplier API JSON response");
      }
    });
    this.tail = run;
    return run;
  }
}

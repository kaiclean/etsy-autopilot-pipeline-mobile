import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createHotGoogleAgent } from "@/pipeline/hot-signals/google-agent";
import { HOT_USER_AGENT } from "@/pipeline/hot-signals/fetch";

function request() {
  const req = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    destroy: vi.fn(),
    destroyed: false,
  });
  return req;
}

describe("hot Google transport", () => {
  it("identifies and rate-gates each underlying request and cancels pending requests on timeout", () => {
    const wait = vi.fn(() => new Promise<void>(() => {}));
    const transport = createHotGoogleAgent(wait);
    const req = request();
    transport.agent.addRequest(req as unknown as ClientRequest, { host: "trends.google.com" } as RequestOptions);
    expect(req.setHeader).toHaveBeenCalledWith("User-Agent", HOT_USER_AGENT);
    expect(wait).toHaveBeenCalledWith("trends.google.com");
    transport.stop();
    expect(req.destroy).toHaveBeenCalledWith(expect.any(Error));
  });

  it.each([403, 429])("stops a blocked HTTP %s response instead of permitting a cookie retry", (statusCode) => {
    const wait = vi.fn(() => new Promise<void>(() => {}));
    const transport = createHotGoogleAgent(wait);
    const req = request();
    transport.agent.addRequest(req as unknown as ClientRequest, { host: "trends.google.com" } as RequestOptions);
    const res = Object.assign(new EventEmitter(), { statusCode, destroy: vi.fn() });
    const retry = vi.fn();
    res.on("end", retry);
    req.emit("response", res as unknown as IncomingMessage);
    res.emit("end");
    expect(retry).not.toHaveBeenCalled();
    expect(res.destroy).toHaveBeenCalled();
    expect(req.destroy).toHaveBeenCalled();
    const next = request();
    transport.agent.addRequest(next as unknown as ClientRequest, { host: "trends.google.com" });
    expect(next.destroy).toHaveBeenCalled();
    expect(wait).toHaveBeenCalledTimes(1);
    transport.stop();
  });

  it("rejects any unexpected transport host without requesting it", () => {
    const wait = vi.fn(async () => {});
    const transport = createHotGoogleAgent(wait);
    const req = request();
    transport.agent.addRequest(req as unknown as ClientRequest, { host: "localhost" });
    expect(wait).not.toHaveBeenCalled();
    expect(req.destroy).toHaveBeenCalled();
    transport.stop();
  });
});

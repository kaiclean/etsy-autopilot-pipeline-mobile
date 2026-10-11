import { Agent } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { HOT_USER_AGENT, hotFetcher } from "./fetch";

type RequestAgent = Agent & { addRequest(req: ClientRequest, options: RequestOptions): void };

/** google-trends-api otherwise retries 429s and issues its two requests back-to-back. */
export function createHotGoogleAgent(waitForHost = hotFetcher.waitForHost) {
  const agent = new Agent({ keepAlive: false }) as RequestAgent;
  const addRequest = agent.addRequest.bind(agent);
  const requests = new Set<ClientRequest>();
  let stopped = false;
  agent.addRequest = (req, options) => {
    req.setHeader("User-Agent", HOT_USER_AGENT);
    requests.add(req);
    req.once("close", () => requests.delete(req));
    req.prependOnceListener("response", (res: IncomingMessage) => {
      if (res.statusCode === 403 || res.statusCode === 429) {
        stopped = true;
        // The library registers its response/end handler at request construction.
        // Stop other response listeners too so none can install the cookie retry.
        req.removeAllListeners("response");
        res.removeAllListeners("end");
        res.destroy();
        req.destroy(new Error("Google Trends blocked"));
      }
    });
    const host = options.hostname ?? options.host;
    if (host !== "trends.google.com" || stopped) {
      req.destroy(new Error("Google Trends unavailable"));
      return;
    }
    void waitForHost(host).then(() => {
      if (!req.destroyed && !stopped) addRequest(req, options);
      else req.destroy(new Error("Google Trends stopped"));
    }).catch(() => req.destroy(new Error("Google Trends unavailable")));
  };
  return {
    agent,
    stop() {
      stopped = true;
      for (const req of requests) req.destroy(new Error("Google Trends stopped"));
      agent.destroy();
    },
  };
}

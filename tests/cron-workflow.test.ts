import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/autopilot-cron.yml"), "utf8");

describe("background cron workflow", () => {
  it.each(["daily", "orders"])("accepts HTTP 202/200 and rejects failures for %s", async (stage) => {
    const job = workflow.split(`\n  ${stage}:\n`)[1].split(/\n  \w+:\n/)[0];
    const script = job.split("        run: |\n")[1].split("\n")
      .filter((line) => line.startsWith("          "))
      .map((line) => line.slice(10)).join("\n");
    expect(script).toContain(`/api/cron/${stage}`);
    let status = 202;
    const received: Array<{ url?: string; authorization?: string }> = [];
    const server = createServer((req, res) => {
      received.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: status === 202 ? "accepted" : "finished" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test server address");
      const env = {
        ...process.env,
        AUTOPILOT_URL: `http://127.0.0.1:${address.port}/`,
        CRON_SECRET: "unit-test-cron-secret",
        FORCE: "true",
      };
      for (status of [202, 200]) {
        const result = await exec("bash", ["-c", script], { env });
        expect(result.stdout).toContain("accepted or completed");
      }
      for (status of [401, 500, 502]) {
        await expect(exec("bash", ["-c", script], { env })).rejects.toMatchObject({ code: 22 });
      }
      expect(received).toHaveLength(5);
      expect(received.every((req) => req.url === `/api/cron/${stage}?force=1`)).toBe(true);
      expect(received.every((req) => req.authorization === ["Bearer", env.CRON_SECRET].join(" "))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

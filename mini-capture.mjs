import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8799;
const CLI = "C:/Users/YANG/AppData/Roaming/ai.opencode.desktop/cli/2.1.4-x64/opencode-cli.exe";
const OUT = "C:/Users/YANG/Desktop/project/opencode-zen-freex/genuine-2.1.4-request.json";
let longest = "";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && body.length > longest.length) {
      longest = body;
      writeFileSync(OUT, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) }, null, 1));
      console.log(`captured POST ${req.url} (${body.length} bytes) -> ${OUT}`);
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4.1-flash-free", object: "model", owned_by: "opencode" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash-free","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n');
    res.write('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash-free","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const home = mkdtempSync(join(tmpdir(), "zen-minicap-"));
  mkdirSync(join(home, "config", "opencode"), { recursive: true });
  writeFileSync(
    join(home, "config", "opencode", "opencode.json"),
    JSON.stringify({ provider: { opencode: { options: { baseURL: `http://127.0.0.1:${PORT}/v1` } } } }),
  );
  const child = spawn(CLI, ["run", "--standalone", "-m", "opencode/deepseek-v4.1-flash-free", "Say OK."], {
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache") },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 60000);
  child.on("exit", () => {
    clearTimeout(timer);
    setTimeout(() => {
      server.close();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
      process.exit(0);
    }, 300);
  });
});

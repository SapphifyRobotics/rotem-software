#!/usr/bin/env node
// rotem-hub: owns the ROTEM serial port and shares it with any number of browsers.
// Board lines go to every client; a client's command lines go to the board. The hub streams while
// at least one client is connected; clients' STREAM commands are ignored.
//
// Two ways to run it:
//   npm run dev   inside the Astro dev server (server/astro-hub.mjs): one URL, live reload
//   npm start     standalone, serving the built app: node server/hub.mjs [--port 4747] [--device PATH]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SerialPort } from "serialport";
import { WebSocketServer } from "ws";
import { allowedRequest } from "./origin.mjs";

const ROTEM = { vendorId: "cafe", productId: "4010" };

/** Attach the hub to an HTTP server: WebSocket at /ws, JSON status from the returned handler at /hub. */
export function createHub(server, { device = null, log = console.log } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") return; // leave other upgrades (Vite HMR) alone
    if (!allowedRequest(req, true)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });

  let port = null,
    devicePath = null,
    rx = "",
    lastError = "";
  const busy = () => !port && /busy|lock/i.test(lastError);
  const broadcast = (text) => {
    for (const c of wss.clients) if (c.readyState === 1) c.send(text);
  };
  const status = () =>
    broadcast(
      `HUB device=${port ? devicePath : "none"} busy=${busy() ? 1 : 0} clients=${wss.clients.size}\n`,
    );
  const write = (line) => {
    if (port) port.write(line + "\n");
  };

  async function findDevice() {
    if (device) return fs.existsSync(device) ? device : null;
    const list = await SerialPort.list();
    const matches = list.filter(
      (p) =>
        p.vendorId?.toLowerCase() === ROTEM.vendorId &&
        p.productId?.toLowerCase() === ROTEM.productId,
    );
    if (matches.length > 1) {
      lastError = "Multiple boards: choose --device explicitly";
      return null;
    }
    return matches[0]?.path ?? null;
  }

  async function connect() {
    if (port || !wss.clients.size) return;
    const dev = await findDevice();
    if (!dev) return;
    const p = new SerialPort(
      { path: dev, baudRate: 115200, lock: true },
      (err) => {
        if (err) {
          const msg = `cannot open ${dev}: ${err.message}`;
          if (msg !== lastError) {
            log(
              msg +
                (/busy|lock/i.test(err.message)
                  ? " (another program or browser tab holds it; retrying)"
                  : ""),
            );
            lastError = msg;
            status();
          }
          return;
        }
        lastError = "";
        port = p;
        devicePath = dev;
        rx = "";
        log(`board on ${dev}`);
        status();
        write("STREAM OFF");
        if (wss.clients.size) write("STREAM ON");
      },
    );
    p.on("data", (d) => {
      rx += d.toString("latin1");
      const end = rx.lastIndexOf("\n");
      if (end >= 0) {
        broadcast(rx.slice(0, end + 1));
        rx = rx.slice(end + 1);
      }
    });
    p.on("close", () => {
      if (port === p) {
        log("board disconnected");
        port = null;
        status();
      }
    });
    p.on("error", (e) => log("serial error " + e.message));
  }
  const timer = setInterval(connect, 1000);
  connect();

  wss.on("connection", (ws) => {
    void connect();
    status();
    if (wss.clients.size === 1) write("STREAM ON");
    ws.on("message", (m) => {
      for (const line of m
        .toString()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (/^STREAM /i.test(line)) continue; // the hub owns streaming
        if (/^BOOT$/i.test(line))
          broadcast("HUB board leaving for firmware update\n");
        write(line);
      }
    });
    ws.on("close", () => {
      if (!wss.clients.size) write("STREAM OFF");
      status();
    });
  });

  return {
    /** Connect-style handler for GET /hub; calls next() for anything else. */
    middleware(req, res, next) {
      if ((req.url ?? "").split("?")[0] !== "/hub") return next?.();
      if (!allowedRequest(req, false)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          hub: 1,
          device: port ? devicePath : null,
          busy: busy(),
          clients: wss.clients.size,
        }),
      );
    },
    close() {
      clearInterval(timer);
      write("STREAM OFF");
      port?.close();
      wss.close();
    },
  };
}

// ---------- standalone: serve dist/ and the hub on one port
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const PORT = Number(arg("--port", 4747));
  const root = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "dist",
  );
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".glb": "model/gltf-binary",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
  };
  let hub;
  const server = http.createServer((req, res) =>
    hub.middleware(req, res, () => {
      let url;
      try {
        url = decodeURIComponent((req.url ?? "/").split("?")[0]);
      } catch {
        res.writeHead(400);
        return res.end("Bad path");
      }
      let file = path.join(root, url === "/" ? "index.html" : url);
      if (
        !file.startsWith(root + path.sep) ||
        !fs.existsSync(file) ||
        fs.statSync(file).isDirectory()
      )
        file = path.join(root, "index.html");
      if (!fs.existsSync(file)) {
        res.writeHead(500);
        return res.end('Run "npm run build" first.');
      }
      res.writeHead(200, {
        "content-type": types[path.extname(file)] ?? "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
    }),
  );
  hub = createHub(server, { device: arg("--device", null) });
  server.listen(PORT, "127.0.0.1", () =>
    console.log(`ROTEM Studio on http://localhost:${PORT}`),
  );
  process.on("SIGINT", () => {
    hub.close();
    setTimeout(() => process.exit(0), 100);
  });
}

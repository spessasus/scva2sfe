// npm run serve:web [port]: serves build/web on http://localhost:8080 (the page's workers need http, not file://).
// Only on this machine, nothing else is reachable through it
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../build/web/", import.meta.url));
const port = Number(process.argv[2] ?? 8080);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8" };
http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let name;
    try {
        name = decodeURIComponent(url.pathname);
    } catch {
        res.writeHead(400).end("bad request");
        return;
    }
    const file = path.join(root, path.normalize(name).replace(/^([/\\])+/, "") || "index.html");
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end("not found");
        return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`build/web on http://localhost:${port}/`));

// Node adapter: node:http <-> fetch Request/Response. S1 runs the API locally for tests and the kl CLI.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export function serve(handler: (req: Request) => Promise<Response>, port = 0) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : body });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise<{ server: typeof server; port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: p, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

import http from "node:http";
import net from "node:net";

export async function createValidatedEgressProxy(urlPolicy, { connectImpl = net.connect } = {}) {
  const server = http.createServer(async (request, response) => {
    request.on("error", () => response.destroy());
    response.on("error", () => request.destroy());
    try {
      const target = new URL(request.url);
      if (target.protocol !== "http:" || !urlPolicy.allowHttp) throw new Error("plain HTTP proxying is disabled");
      const [destination] = await urlPolicy.resolvePublicHost(target.hostname);
      const upstream = http.request({
        host: destination.address, family: destination.family, port: Number(target.port || 80),
        method: request.method, path: `${target.pathname}${target.search}`,
        headers: { ...request.headers, host: target.host }
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.on("error", () => response.destroy());
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => {
        if (!response.destroyed) {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        }
      });
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    } catch {
      response.writeHead(403); response.end();
    }
  });
  server.on("connect", async (request, clientSocket, head) => {
    let upstream;
    clientSocket.on("error", () => upstream?.destroy());
    clientSocket.on("close", () => upstream?.destroy());
    try {
      const separator = request.url.lastIndexOf(":");
      if (separator < 1) throw new Error("invalid CONNECT destination");
      const hostname = request.url.slice(0, separator).replace(/^\[|\]$/g, "").toLowerCase();
      const port = Number(request.url.slice(separator + 1));
      if (port !== 443) throw new Error("only HTTPS CONNECT destinations are allowed");
      const [destination] = await urlPolicy.resolvePublicHost(hostname);
      if (clientSocket.destroyed) return;
      upstream = connectImpl({ host: destination.address, family: destination.family, port });
      upstream.setTimeout(45_000, () => upstream.destroy());
      upstream.on("error", () => clientSocket.destroy());
      upstream.on("close", () => clientSocket.destroy());
      upstream.once("connect", () => {
        if (clientSocket.destroyed) { upstream.destroy(); return; }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket); clientSocket.pipe(upstream);
      });
    } catch { if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

import http from "node:http";
import net from "node:net";

export async function createValidatedEgressProxy(urlPolicy) {
  const server = http.createServer(async (request, response) => {
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
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream);
    } catch {
      response.writeHead(403); response.end();
    }
  });
  server.on("connect", async (request, clientSocket, head) => {
    try {
      const separator = request.url.lastIndexOf(":");
      if (separator < 1) throw new Error("invalid CONNECT destination");
      const hostname = request.url.slice(0, separator).replace(/^\[|\]$/g, "").toLowerCase();
      const port = Number(request.url.slice(separator + 1));
      if (port !== 443) throw new Error("only HTTPS CONNECT destinations are allowed");
      const [destination] = await urlPolicy.resolvePublicHost(hostname);
      const upstream = net.connect({ host: destination.address, family: destination.family, port });
      upstream.setTimeout(45_000, () => upstream.destroy());
      upstream.once("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket); clientSocket.pipe(upstream);
      });
      upstream.once("error", () => clientSocket.destroy());
    } catch { clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); }
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

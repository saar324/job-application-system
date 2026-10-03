import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createChromeSessionMcp } from "./chrome-session-mcp.js";
export const createProfileMcpServer = createChromeSessionMcp;

export async function handleMcpRequest(request, response, body, dependencies) {
  const server = createProfileMcpServer(dependencies);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

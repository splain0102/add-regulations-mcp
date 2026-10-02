import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "ADD Regulations MCP",
    version: "1.0.0",
  });

  server.registerTool(
    "hello",
    {
      description: "국방과학연구소 규정 MCP 연결 테스트",
      inputSchema: {
        name: z.string().optional(),
      },
    },
    async ({ name }) => {
      return {
        content: [
          {
            type: "text",
            text: `국방과학연구소 규정 MCP 연결 성공: ${name ?? "테스트"}`,
          },
        ],
      };
    }
  );

  return server;
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        "ADD Regulations MCP is running. MCP endpoint: /mcp"
      );
    }

    if (url.pathname === "/mcp") {
      return createMcpHandler(createServer)(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

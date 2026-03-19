/**
 * Converts Copilot SDK Tool definitions into Claude Agent SDK in-process MCP tools
 * using createSdkMcpServer() and tool() helpers.
 */

import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "../copilot/tool-bridge.js";

/**
 * Convert an array of Copilot SDK Tool definitions into a Claude Agent SDK
 * in-process MCP server config and a list of allowed tool names.
 *
 * The returned mcpServer can be spread into the query options' mcpServers,
 * and the allowedToolNames should be added to allowedTools.
 */
export function bridgeToolsForClaude(tools: Tool<any>[]): {
  mcpServer: ReturnType<typeof createSdkMcpServer>;
  allowedToolNames: string[];
} {
  const MCP_SERVER_NAME = "attache";

  const sdkTools = tools.map((t) => {
    // The SDK's tool() expects a Zod raw shape (the .shape of a ZodObject),
    // not a full ZodSchema. We need to extract it.
    let inputShape: Record<string, any>;

    if (t.parameters && typeof t.parameters === "object" && "shape" in t.parameters) {
      // ZodObject — extract the raw shape
      inputShape = (t.parameters as any).shape;
    } else if (t.parameters && typeof t.parameters === "object" && "_zod" in t.parameters) {
      // Some other Zod type — try to get shape
      inputShape = (t.parameters as any).shape || {};
    } else {
      // No schema or plain JSON Schema — use empty shape
      inputShape = {};
    }

    const handler = t.handler as (args: any) => Promise<unknown>;

    return sdkTool(
      t.name,
      t.description || t.name,
      inputShape,
      async (args: any) => {
        try {
          const result = await handler(args);
          const text = typeof result === "string" ? result : JSON.stringify(result);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    );
  });

  const mcpServer = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    tools: sdkTools,
  });

  // Tool names in allowedTools follow the pattern mcp__<serverName>__<toolName>
  const allowedToolNames = tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`);

  return { mcpServer, allowedToolNames };
}

/**
 * Converts Copilot SDK Tool definitions into Codex dynamicTools format
 * and creates a dispatch handler for dynamicToolCall server requests.
 */

import type { DynamicToolSpec } from "../../types.js";
import type { Tool } from "../copilot/tool-bridge.js";
import { z } from "zod";

interface DynamicToolCallResult {
  success: boolean;
  contentItems: Array<{ type: string; text?: string }>;
}

/**
 * Convert an array of Copilot SDK Tool definitions into Codex DynamicToolSpec[] and
 * a dispatch handler function.
 */
export function bridgeToolsForCodex(tools: Tool<any>[]): {
  specs: DynamicToolSpec[];
  handler: (toolName: string, args: any) => Promise<DynamicToolCallResult>;
} {
  const handlerMap = new Map<string, (args: any) => Promise<unknown>>();

  const specs: DynamicToolSpec[] = tools.map((tool) => {
    handlerMap.set(tool.name, tool.handler as (args: any) => Promise<unknown>);

    let inputSchema: Record<string, unknown>;
    const params = tool.parameters;
    if (params && typeof params === "object" && "_zod" in params && "def" in params) {
      // Zod 4 schema — convert to JSON Schema via z.toJSONSchema()
      try {
        inputSchema = z.toJSONSchema(params as unknown as z.ZodType) as Record<string, unknown>;
      } catch {
        inputSchema = { type: "object", properties: {} };
      }
    } else if (params && typeof params === "object") {
      // Already a JSON Schema object
      inputSchema = tool.parameters as Record<string, unknown>;
    } else {
      inputSchema = { type: "object", properties: {} };
    }

    return {
      name: tool.name,
      description: tool.description || tool.name,
      inputSchema,
    };
  });

  const handler = async (toolName: string, args: any): Promise<DynamicToolCallResult> => {
    const fn = handlerMap.get(toolName);
    if (!fn) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: `Unknown tool: ${toolName}` }],
      };
    }

    try {
      const result = await fn(args);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return {
        success: true,
        contentItems: [{ type: "inputText", text }],
      };
    } catch (err) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  };

  return { specs, handler };
}

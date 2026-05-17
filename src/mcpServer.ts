import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

let server: Server | null = null;
let transport: StdioServerTransport | null = null;

export async function startMcpServer(apiKey: string, localFolderPath: string) {
  server = new Server(
    {
      name: "modelbound-workspace-manager",
      version: "1.0.0"
    },
    {
      capabilities: { tools: {} }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "fetch_and_scaffold_context",
          description:
            "Downloads an explicit prompt or context library from ModelBound.co directly into the workspace runtime.",
          inputSchema: {
            type: "object" as const,
            properties: {
              skillId: {
                type: "string",
                description:
                  "The alphanumeric ID tracking the context package."
              }
            },
            required: ["skillId"]
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "fetch_and_scaffold_context") {
      const { skillId } = request.params.arguments as { skillId: string };

      try {
        const response = await axios.get(
          `https://api.modelbound.co/v1/skills/${skillId}`,
          { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );

        const targetPath = path.join(localFolderPath, `${skillId}.md`);
        fs.writeFileSync(targetPath, response.data.content, 'utf8');

        return {
          content: [
            {
              type: "text" as const,
              text: `Success: Context loaded to ${targetPath}. Your LLM agent can now use this structural rule.`
            }
          ]
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `ModelBound API Error: ${err.message}`
            }
          ]
        };
      }
    }

    throw new Error("Target tool not registered.");
  });

  transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function stopMcpServer() {
  if (server) {
    // Safe disconnection implementation
    server = null;
  }
}

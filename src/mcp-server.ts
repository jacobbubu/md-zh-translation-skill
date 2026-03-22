#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { translateMarkdownArticle } from "./translate.js";

function readStringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Tool argument "${key}" must be a non-empty string.`);
  }
  return value;
}

const server = new Server(
  {
    name: "md-zh-translation",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "translate_markdown",
      description:
        "Translate an English Markdown article into Chinese Markdown with the frozen gated pipeline and final md-zh-format beautification.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["markdown"],
        properties: {
          markdown: {
            type: "string",
            description: "The source English Markdown article."
          },
          sourcePathHint: {
            type: "string",
            description: "An optional file name hint used for downstream Markdown formatting."
          }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "translate_markdown") {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${request.params.name}`
        }
      ],
      isError: true
    };
  }

  try {
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    const markdown = readStringArgument(args, "markdown");
    const sourcePathHint =
      typeof args.sourcePathHint === "string" && args.sourcePathHint.trim() ? args.sourcePathHint.trim() : "article.md";

    const result = await translateMarkdownArticle(markdown, {
      sourcePathHint
    });

    return {
      content: [
        {
          type: "text",
          text: result.markdown
        }
      ]
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }
      ],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

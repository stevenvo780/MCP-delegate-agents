import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs/promises";
import * as path from "path";

const log = (...args: any[]) => console.error("[delegator]", ...args);
const OLLAMA_BASE = "http://127.0.0.1:11434";

// --- File Helpers ---
async function getDirTree(dir: string, depth = 0, maxDepth = 2): Promise<string> {
  if (depth > maxDepth) return "";
  const ignore = [".git", "node_modules", "dist", "build", "package-lock.json"];
  let lines: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.includes(entry.name)) continue;
      const prefix = "  ".repeat(depth) + (depth > 0 ? "└─ " : "");
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        lines.push(await getDirTree(path.join(dir, entry.name), depth + 1, maxDepth));
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }
  } catch (e) { return ""; }
  return lines.join("\n");
}

async function readFiles(root: string, filePaths: string[]): Promise<string> {
  let context = "";
  for (const p of filePaths) {
    try {
      const fullPath = path.resolve(root, p);
      const content = await fs.readFile(fullPath, "utf-8");
      context += `\n--- FILE: ${p} ---\n${content}\n`;
    } catch (e) {}
  }
  return context;
}

// --- Ollama Helpers ---
async function ollamaChat(opts: { model: string; messages: any[]; format?: any; temperature?: number }) {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...opts, stream: false }),
  });
  const data: any = await res.json();
  return { content: data?.message?.content ?? "" };
}

// --- Tool Definition ---

const VRAM_MENU = "Recommended for RTX 5070 Ti (16GB VRAM): [deepseek-r1:14b, qwen2.5-coder:14b, qwen2.5:14b, gemma2:9b]. Avoid models >32B.";

const DelegateArgs = z.object({
  objective: z.string().describe("The detailed goal."),
  repoRoot: z.string().optional().describe("Absolute path for file access."),
  
  plannerModel: z.string().default("deepseek-r1:14b")
    .describe(`Planner model. ${VRAM_MENU} Use 'deepseek-r1:14b' for thinking tasks.`),
  
  coderModel: z.string().default("qwen2.5-coder:14b")
    .describe(`Coder model. ${VRAM_MENU} Use 'qwen2.5-coder:14b' for implementation.`),
  
  reviewerModel: z.string().default("qwen2.5:14b")
    .describe(`Synthesis/Review model. ${VRAM_MENU} Use 'qwen2.5:14b' for final polish.`),
  
  temperature: z.number().default(0.1),
});

const server = new McpServer({ name: "local-delegator", version: "0.3.1" });

server.tool("delegate_run", DelegateArgs.shape, async (args) => {
  // Log models being used so user can see in stderr
  log(`[Delegator] Models: Planner=${args.plannerModel}, Coder=${args.coderModel}, Reviewer=${args.reviewerModel}`);
  
  let fileTree = args.repoRoot ? await getDirTree(args.repoRoot) : "";

  // 1. Plan
  const planPrompt = `Objective: ${args.objective}\nFile Tree:\n${fileTree}\nReturn JSON with {relevant_files: string[], tasks: {id, role, title, instructions}[]}`;
  const planRes = await ollamaChat({
    model: args.plannerModel,
    messages: [{ role: "user", content: planPrompt }],
    format: "json"
  });
  
  const plan = JSON.parse(planRes.content);
  const fileContext = args.repoRoot ? await readFiles(args.repoRoot, plan.relevant_files || []) : "";

  // 2. Execute
  const results = await Promise.all(plan.tasks.map(async (t: any) => {
    const model = t.role === "code" ? args.coderModel : args.reviewerModel;
    const out = await ollamaChat({
      model,
      messages: [{ role: "user", content: `Context:\n${fileContext}\nTask: ${t.instructions}` }]
    });
    return { ...t, output: out.content };
  }));

  // 3. Synthesize
  const final = await ollamaChat({
    model: args.reviewerModel,
    messages: [{ role: "user", content: `Synthesize results:\n${JSON.stringify(results)}` }]
  });

  return { content: [{ type: "text", text: final.content }] };
});

// Basic tools for status/list
server.tool("get_agent_status", {}, async () => ({ content: [{ type: "text", text: "Online" }] }));
server.tool("list_available_models", {}, async () => {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  const data: any = await res.json();
  return { content: [{ type: "text", text: data.models.map((m:any) => m.name).join("\n") }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP delegator v0.3.1 started");
}
main();

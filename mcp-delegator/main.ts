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
  const ignore = [".git", "node_modules", "dist", "build", "package-lock.json", ".vscode"];
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

async function writeFile(root: string, relPath: string, content: string): Promise<string> {
  try {
    const fullPath = path.resolve(root, relPath);
    // Security check: prevent writing outside repo
    if (!fullPath.startsWith(path.resolve(root))) return `Error: Access denied to ${relPath}`;
    
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return `Successfully wrote: ${relPath}`;
  } catch (e: any) {
    return `Error writing ${relPath}: ${e.message}`;
  }
}

// --- Parsing Helpers ---
// Extracts content between <<<FILE path="X">>> ... <<<END_FILE>>>
function parseFileBlocks(text: string): Array<{ path: string, content: string }> {
  const regex = /<<<FILE path="([^"]+)">>>([\s\S]*?)<<<END_FILE>>>/g;
  const files: Array<{ path: string, content: string }> = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    files.push({ path: match[1], content: match[2].trim() });
  }
  return files;
}

// --- Ollama Helpers ---
async function ollamaChat(opts: { model: string; messages: any[]; format?: any; temperature?: number }) {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...opts,
      stream: false,
      keep_alive: -1
    }),
  });
  const data: any = await res.json();
  return { content: data?.message?.content ?? "" };
}

// --- Tool Definition ---

const VRAM_MENU = "Recommended for RTX 5070 Ti (16GB VRAM): [deepseek-r1:14b, qwen2.5-coder:14b, qwen2.5:14b, gemma2:9b]. Avoid models >32B.";

const DelegateArgs = z.object({
  objective: z.string().describe("The detailed goal."),
  repoRoot: z.string().optional().describe("Absolute path for file access."),
  apply_changes: z.boolean().default(false).describe("IF TRUE, the agent will WRITE files to disk directly. Use for implementation tasks."),
  
  plannerModel: z.string().default("deepseek-r1:14b")
    .describe(`Planner model. ${VRAM_MENU}`),
  
  coderModel: z.string().default("qwen2.5-coder:14b")
    .describe(`Coder model. ${VRAM_MENU}`),
  
  reviewerModel: z.string().default("qwen2.5:14b")
    .describe(`Synthesis/Review model. ${VRAM_MENU}`),
  
  temperature: z.number().default(0.1),
});

const server = new McpServer({ name: "local-delegator", version: "0.4.0" });

server.tool("delegate_run", DelegateArgs.shape, async (args) => {
  log(`[Delegator] Obj="${args.objective.substring(0,30)}..." Apply=${args.apply_changes}`);
  
  let fileTree = args.repoRoot ? await getDirTree(args.repoRoot) : "";

  // 1. Plan
  const planPrompt = `Objective: ${args.objective}\nFile Tree:\n${fileTree}\nReturn JSON with {relevant_files: string[], tasks: {id, role, title, instructions}[]}`;
  const planRes = await ollamaChat({
    model: args.plannerModel,
    messages: [{ role: "user", content: planPrompt }],
    format: "json"
  });
  
  let plan;
  try {
     plan = JSON.parse(planRes.content);
  } catch (e) {
     // Fallback for non-JSON response
     plan = { relevant_files: [], tasks: [{id: "1", role: "code", title: "Task", instructions: args.objective}] };
  }
  
  const fileContext = args.repoRoot ? await readFiles(args.repoRoot, plan.relevant_files || []) : "";

  // 2. Execute
  const results = await Promise.all(plan.tasks.map(async (t: any) => {
    const model = t.role === "code" ? args.coderModel : args.reviewerModel;
    
    let instructions = t.instructions;
    if (args.apply_changes && t.role === "code") {
      instructions += `\n\nIMPORTANT: You must output the full file content to be written to disk.\nUse this EXACT format:\n<<<FILE path="path/to/file.ext">>>\n[Full Content Here]\n<<<END_FILE>>>\n\nDo not use markdown blocks for the file content inside the tags.`;
    }

    const out = await ollamaChat({
      model,
      messages: [{ role: "user", content: `Context:\n${fileContext}\nTask: ${instructions}` }]
    });
    
    let outputText = out.content;
    let writtenFiles: string[] = [];

    // DIRECT WRITE LOGIC
    if (args.apply_changes && args.repoRoot) {
      const filesToWrite = parseFileBlocks(outputText);
      for (const f of filesToWrite) {
        const result = await writeFile(args.repoRoot, f.path, f.content);
        writtenFiles.push(result);
      }
      if (writtenFiles.length > 0) {
        outputText += `\n\n[SYSTEM AGENT]: I have automatically applied changes to disk:\n${writtenFiles.join("\n")}`;
      }
    }

    return { ...t, output: outputText, writtenFiles };
  }));

  // 3. Synthesize
  const synthesisPrompt = `Synthesize results. If files were written (marked as [SYSTEM AGENT]), confirm it.\nResults:\n${JSON.stringify(results)}`;
  const final = await ollamaChat({
    model: args.reviewerModel,
    messages: [{ role: "user", content: synthesisPrompt }]
  });

  return { content: [{ type: "text", text: final.content }] };
});

server.tool("get_agent_status", {}, async () => ({ content: [{ type: "text", text: "Online v0.4.0 (Write Capable)" }] }));
server.tool("list_available_models", {}, async () => {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  const data: any = await res.json();
  return { content: [{ type: "text", text: data.models.map((m:any) => m.name).join("\n") }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP delegator v0.4.0 started");
}
main();
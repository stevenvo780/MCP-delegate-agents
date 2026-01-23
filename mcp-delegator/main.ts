import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs/promises";
import * as path from "path";

const log = (...args: any[]) => console.error("[delegator]", ...args);
const OLLAMA_BASE = "http://127.0.0.1:11434";

// --- Helpers ---
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
    if (!fullPath.startsWith(path.resolve(root))) return `Error: Access denied to ${relPath}`;
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return `Successfully wrote: ${relPath}`;
  } catch (e: any) {
    return `Error writing ${relPath}: ${e.message}`;
  }
}

function parseFileBlocks(text: string): Array<{ path: string, content: string }> {
  const regex = /<<<FILE path="([^"]+)">>>([\s\S]*?)<<<END_FILE>>>/g;
  const files: Array<{ path: string, content: string }> = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    files.push({ path: match[1], content: match[2].trim() });
  }
  return files;
}

async function ollamaChat(opts: { model: string; messages: any[]; format?: any; temperature?: number }) {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...opts, stream: false, keep_alive: -1 }),
  });
  const data: any = await res.json();
  return { content: data?.message?.content ?? "" };
}

// --- Tool ---

const DelegateArgs = z.object({
  objective: z.string().describe("The detailed goal."),
  repoRoot: z.string().optional().describe("Absolute path for file access."),
  write_to_disk: z.boolean().default(false).describe("IF TRUE, the local agent writes files directly. Use for creating multiple files or large refactors to avoid UI bottlenecks."),
  plannerModel: z.string().default("deepseek-r1:14b"),
  coderModel: z.string().default("qwen2.5-coder:14b"),
  reviewerModel: z.string().default("qwen2.5:14b"),
  temperature: z.number().default(0.1),
});

const server = new McpServer({ name: "local-delegator", version: "0.4.1" });

server.tool("delegate_run", DelegateArgs.shape, async (args) => {
  log(`[Delegator] Obj="${args.objective.substring(0,30)}"... Write=${args.write_to_disk}`);
  
  let fileTree = args.repoRoot ? await getDirTree(args.repoRoot) : "";

  const planPrompt = `Objective: ${args.objective}\nFile Tree:\n${fileTree}\nReturn JSON with {relevant_files: string[], tasks: {id, role, title, instructions}[]}`;
  const planRes = await ollamaChat({
    model: args.plannerModel,
    messages: [{ role: "user", content: planPrompt }],
    format: "json"
  });
  
  let plan;
  try { plan = JSON.parse(planRes.content); } 
  catch (e) { plan = { relevant_files: [], tasks: [{id: "1", role: "code", title: "Task", instructions: args.objective}] }; }
  
  const fileContext = args.repoRoot ? await readFiles(args.repoRoot, plan.relevant_files || []) : "";

  const results = await Promise.all(plan.tasks.map(async (t: any) => {
    const model = t.role === "code" ? args.coderModel : args.reviewerModel;
    let instructions = t.instructions;
    
    if (args.write_to_disk && t.role === "code") {
      instructions += `\n\nIMPORTANT: Use this format to write to disk:\n<<<FILE path="path/to/file">>>\n[Content]\n<<<END_FILE>>>`;
    }

    const out = await ollamaChat({
      model,
      messages: [{ role: "user", content: `Context:\n${fileContext}\nTask: ${instructions}` }]
    });
    
    let outputText = out.content;
    let writtenFiles: string[] = [];

    if (args.write_to_disk && args.repoRoot) {
      const filesToWrite = parseFileBlocks(outputText);
      for (const f of filesToWrite) {
        const result = await writeFile(args.repoRoot, f.path, f.content);
        writtenFiles.push(result);
      }
      if (writtenFiles.length > 0) {
        outputText = `✅ [LOCAL WRITE SUCCESS]:\n${writtenFiles.join("\n")}\n\nOriginal Output:\n${outputText}`;
      } else {
        outputText = `⚠️ [LOCAL WRITE FAILED]: No valid <<<FILE>>> blocks found in output.\n\n${outputText}`;
      }
    } else if (args.objective.toLowerCase().includes("escribir") || args.objective.toLowerCase().includes("crear")) {
      outputText = `ℹ️ [BYPASS NOTE]: 'write_to_disk' was false. Passing code to Copilot for UI application.\n\n${outputText}`;
    }

    return { ...t, output: outputText };
  }));

  const final = await ollamaChat({
    model: args.reviewerModel,
    messages: [{ role: "user", content: `Synthesize results. Confirm disk writes if any.\nResults:\n${JSON.stringify(results)}` }]
  });

  return { content: [{ type: "text", text: final.content }] };
});

server.tool("get_agent_status", {}, async () => ({ content: [{ type: "text", text: "Online v0.4.1 (Direct Disk Write Capable)" }] }));
server.tool("list_available_models", {}, async () => {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  const data: any = await res.json();
  return { content: [{ type: "text", text: data.models.map((m:any) => m.name).join("\n") }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP delegator v0.4.1 started");
}
main();

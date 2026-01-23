import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// IMPORTANT: never console.log in stdio servers (breaks JSON-RPC)
const log = (...args: any[]) => console.error("[delegator]", ...args);

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

const OLLAMA_BASE = "http://127.0.0.1:11434";

// --- Helpers ---

async function ollamaRequest(path: string, method: string = "GET", body?: any) {
  try {
    const res = await fetch(`${OLLAMA_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (error: any) {
    if (error.cause?.code === 'ECONNREFUSED') {
      throw new Error("Ollama is not running or not accessible at " + OLLAMA_BASE);
    }
    throw error;
  }
}

async function ollamaChat(opts: {
  model: string;
  messages: ChatMsg[];
  format?: "json" | object;
  temperature?: number;
}) {
  const data: any = await ollamaRequest("/api/chat", "POST", {
    model: opts.model,
    messages: opts.messages,
    stream: false,
    format: opts.format,
    options: opts.temperature != null ? { temperature: opts.temperature } : undefined,
  });
  return {
    content: data?.message?.content ?? "",
    raw: data,
  };
}

// --- Schemas ---

const PlanSchema = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          role: { type: "string", enum: ["code", "test", "review", "docs"] },
          title: { type: "string" },
          instructions: { type: "string" },
        },
        required: ["id", "role", "title", "instructions"],
      },
    },
  },
  required: ["tasks"],
};

const DelegateArgs = z.object({
  objective: z.string()
    .describe("The detailed goal or task description. Be specific about what needs to be implemented, fixed, or analyzed."),
  
  repoRoot: z.string().optional()
    .describe("Absolute path to the repository root. Provides context to the workers."),
  
  plannerModel: z.string().default("deepseek-r1:14b")
    .describe("Model used for breaking down the task. Prefer reasoning/thinking models."),
  
  coderModel: z.string().default("qwen2.5-coder:14b")
    .describe("Model used for writing code and tests. Prefer high-parameter coding models."),
  
  reviewerModel: z.string().default("qwen2.5:14b")
    .describe("Model used for synthesis and code review. Should be a strong generalist."),
  
  docsModel: z.string().default("gemma2:9b")
    .describe("Model used for documentation and explanations."),
  
  temperature: z.number().min(0).max(2).default(0.1)
    .describe("Creativity level (0.0-1.0). Low for code, higher for brainstorming."),
});

// --- Server Setup ---

const server = new McpServer({
  name: "local-delegator",
  version: "0.2.0",
});

// --- Tools ---

// 1. STATUS TOOL
server.tool(
  "get_agent_status",
  "Checks if the local Ollama swarm is running and healthy.",
  {},
  async () => {
    try {
      const version = await ollamaRequest("/api/version");
      return {
        content: [{ type: "text", text: `Create Agent Swarm System Online. Ollama Version: ${version.version}` }]
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `System Offline: ${e.message}. Please start Ollama.` }]
      };
    }
  }
);

// 2. LIST MODELS TOOL
server.tool(
  "list_available_models",
  "Lists all local LLMs available for delegation. Use this to discover valid values for model parameters.",
  {},
  async () => {
    try {
      const data: any = await ollamaRequest("/api/tags");
      const models = data.models.map((m: any) => 
        `- ${m.name} (${(m.size / 1024 / 1024 / 1024).toFixed(1)}GB) - Family: ${m.details?.family}`
      ).join("\n");
      
      return {
        content: [{ type: "text", text: `Available Local Models:\n${models}` }]
      };
    } catch (e: any) {
      return { isError: true, content: [{ type: "text", text: `Failed to list models: ${e.message}` }] };
    }
  }
);

// 3. DELEGATE RUN TOOL
server.tool(
  "delegate_run",
  "Orchestrates a multi-agent swarm (Planner -> Workers -> Reviewer) to execute complex software tasks locally.",
  DelegateArgs.shape, 
  async (args) => {
    log(`[Start] Objective: ${args.objective.substring(0, 50)}...`);

    // 1. Verify Models Exist (Fail fast)
    // We skip strict verification to avoid blocking, but we log it.

    // 2. PLAN
    log(`[Plan] Using ${args.plannerModel}`);
    const planPrompt = `
Return ONLY valid JSON that matches this schema.
Goal: break the objective into minimal tasks (code/test/review/docs).
Objective:
${args.objective}
Repo root (optional): ${args.repoRoot ?? "(none)"}
`;

    let planContent = "";
    try {
      const plan = await ollamaChat({
        model: args.plannerModel,
        messages: [{ role: "user", content: planPrompt }],
        format: PlanSchema,
        temperature: 0.1,
      });
      planContent = plan.content;
    } catch (e: any) {
      return { isError: true, content: [{ type: "text", text: `Planning failed using ${args.plannerModel}: ${e.message}` }] };
    }

    let tasks: any[] = [];
    try {
      tasks = JSON.parse(planContent).tasks ?? [];
    } catch (e) {
      log("Plan parse error, fallback to single task", e);
      tasks = [{ id: "t1", role: "code", title: "Implement objective", instructions: args.objective }];
    }

    // 3. EXECUTE
    const roleToModel = (role: string) => {
      if (role === "code") return args.coderModel;
      if (role === "review") return args.reviewerModel;
      if (role === "docs") return args.docsModel;
      return args.coderModel;
    };

    const workerRuns = await Promise.allSettled(
      tasks.map(async (t) => {
        const model = roleToModel(t.role);
        log(`[Worker] Task ${t.id} (${t.role}) using ${model}`);
        
        const workerPrompt = `
You are a ${t.role.toUpperCase()} worker.
Task: ${t.title}
Instructions: ${t.instructions}
Context: ${args.repoRoot ?? "No local repo context provided."}

Return the practical output (code, review comments, or documentation).
`;
        const out = await ollamaChat({
          model,
          messages: [{ role: "user", content: workerPrompt }],
          temperature: args.temperature,
        });
        return { task: t, model, output: out.content };
      })
    );

    const results = workerRuns.map((r, i) => (r.status === "fulfilled" ? r.value : { task: tasks[i], output: "ERROR" }));

    // 4. SYNTHESIZE
    log(`[Synthesize] Using ${args.reviewerModel}`);
    const synthesisPrompt = `
Synthesize these worker results into a final response for the user.
If there is code, present it clearly.
Results:
${JSON.stringify(results, null, 2)}
`;
    
    const final = await ollamaChat({
      model: args.reviewerModel,
      messages: [{ role: "user", content: synthesisPrompt }],
      temperature: 0.1,
    });

    log("[Finish] Done.");
    return {
      content: [
        { type: "text", text: final.content }
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP delegator server started (STDIO) v0.2.0");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

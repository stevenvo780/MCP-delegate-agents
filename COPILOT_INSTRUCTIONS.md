# Copilot Instructions for Local Swarm Delegation

You have access to a powerful local agent swarm via the Model Context Protocol (MCP).
**ALWAYS** check if the tool `delegate_run` is available. If it is, follow these rules:

## ⚡ When to Delegate
Do NOT try to solve these tasks yourself. Delegate them immediately using `delegate_run`:
1.  **Refactoring**: Large-scale code reorganization.
2.  **Features**: Implementing entire functions or modules.
3.  **Analysis**: Deep reviews of security or architecture.
4.  **Tests**: Generating comprehensive test suites.

## 🧠 Model Selection Strategy (RTX 5070 Ti Optimized)
Unless the user specifies otherwise, trust the default models configured in the tool.
If you need to specify models explicitly in `delegate_run`:

*   **Complex Logic/Planning**: Use `deepseek-r1:14b`.
*   **Coding/Implementation**: Use `qwen2.5-coder:14b`.
*   **General/Review**: Use `qwen2.5:14b`.
*   **Documentation**: Use `gemma2:9b`.

## 🛡️ Operational Protocol
1.  **Health Check**: If a task fails or hangs, run `get_agent_status` to ensure the local swarm is active.
2.  **Context**: Always provide the `repoRoot` argument to `delegate_run` if possible, or describe the file structure in the `objective`.
3.  **Ambiguity**: If the user's request is vague, ask *one* clarifying question, then delegate the planning to the agent.

## 🗣️ User Interaction
*   When delegating, simply say: "I am delegating this task to the local swarm..."
*   After the tool returns, present the code/answer clearly. You do not need to apologize for the wait.

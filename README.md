# 🤖 Local MCP Swarm Delegator (RTX 5070 Ti Edition)

Este proyecto expone un servidor **MCP (Model Context Protocol)** que permite a asistentes como Copilot o Cursor delegar tareas complejas a un enjambre local de modelos LLM corriendo en **Ollama**.

## 🚀 Arquitectura "Swarm"

Cuando invocas `delegate_run`, el sistema orquesta lo siguiente:

1.  **🧠 Planner (`deepseek-r1:14b`)**: Razona sobre el problema y crea un plan paso a paso (JSON).
2.  **👷 Workers (`qwen2.5-coder:14b`)**: Ejecutan las tareas en paralelo (escribir código, tests, docs).
3.  **⚖️ Reviewer (`qwen2.5:14b`)**: Consolida los resultados, busca errores y genera la respuesta final.

> **Optimización Hardware**: Configurado para usar modelos de ~14B parámetros que caben íntegramente en los 16GB VRAM de una RTX 5070 Ti, garantizando máxima velocidad.

## 🛠️ Herramientas Disponibles

| Tool | Descripción |
|------|-------------|
| **`delegate_run`** | La herramienta principal. Ejecuta el ciclo Planificar -> Ejecutar -> Revisar. |
| **`get_agent_status`** | Verifica si Ollama está corriendo y responde. |
| **`list_available_models`** | Lista los modelos instalados localmente para elegir alternativas. |

## ⚡ Uso Rápido (Global)

Si ya configuraste el alias `enable-agent`:

1.  Ve a tu proyecto: `cd mi-proyecto`
2.  Activa el agente: `enable-agent`
3.  Abre VS Code: `code .`
4.  En Copilot Chat: *"Refactoriza este archivo usando el agente local"* o usa `#delegate_run`.

## ⚙️ Configuración Manual

El archivo de configuración se inyecta en `.vscode/mcp.json` apuntando al binario compilado en:
`/datos/repos/Personal/MCP-delegate-agents/mcp-delegator/dist/main.js`

#!/bin/bash

# --- Configuración ---
BASE_DIR="/datos/repos/Personal/MCP-delegate-agents"
AGENT_JS_PATH="$BASE_DIR/mcp-delegator/dist/main.js"
NODE_PATH="/home/stev/.nvm/versions/node/v22.21.1/bin/node"

# --- Validaciones ---
if [ -z "$PWD" ]; then
  echo "❌ Error: No se pudo determinar el directorio actual."
  exit 1
fi

if [ ! -f "$AGENT_JS_PATH" ]; then
  echo "❌ Error: No encuentro el agente compilado en $AGENT_JS_PATH"
  echo "   Ejecuta 'npx tsc' en la carpeta del agente primero."
  exit 1
fi

# --- Paso 1: Configurar MCP (.vscode) ---
if [ ! -d ".vscode" ]; then
  mkdir .vscode
  echo "📂 Carpeta .vscode creada."
fi

MCP_CONFIG=".vscode/mcp.json"
cat > "$MCP_CONFIG" <<EOF
{
  "servers": {
    "local-delegator": {
      "type": "stdio",
      "command": "$NODE_PATH",
      "args": ["$AGENT_JS_PATH"]
    }
  }
}
EOF
echo "✅ MCP: Configuración inyectada en $MCP_CONFIG"
echo "   (Las instrucciones de IA ya están cargadas en tu configuración global 'AltoRango')"

echo ""
echo "🎉 ¡Sistema Agente Activado!"
echo "👉 Reinicia VS Code/Copilot para que reconozca la nueva herramienta."

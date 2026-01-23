#!/bin/bash

# Ruta absoluta al ejecutable del agente (generada dinámicamente)
AGENT_JS_PATH="/datos/repos/Personal/MCP-delegate-agents/mcp-delegator/dist/main.js"
NODE_PATH="/home/stev/.nvm/versions/node/v22.21.1/bin/node"

# Verificar que estamos en un directorio
if [ -z "$PWD" ]; then
  echo "❌ Error: No se pudo determinar el directorio actual."
  exit 1
fi

# Crear carpeta .vscode si no existe
if [ ! -d ".vscode" ]; then
  mkdir .vscode
  echo "📂 Carpeta .vscode creada."
fi

CONFIG_FILE=".vscode/mcp.json"

# Contenido del JSON con rutas absolutas
cat > "$CONFIG_FILE" <<EOF
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

echo "✅ Agente 'local-delegator' activado en: $PWD"
echo "🔄 Por favor, reinicia la ventana de VS Code o recarga Copilot para ver los cambios."

const { fetch } = require("undici"); // Node 18+ native fetch inside VS Code acts like this

async function testConnection() {
  console.log("Intentando conectar a http://localhost:9527/sse...");
  
  try {
    const controller = new AbortController();
    // Timeout de 2 segundos para ver si responde
    const timeout = setTimeout(() => controller.abort(), 2000);
    
    const res = await fetch("http://localhost:9527/sse", {
      headers: {
        "Accept": "text/event-stream"
      },
      signal: controller.signal
    });
    
    clearTimeout(timeout);

    console.log(`Estado HTTP: ${res.status} ${res.statusText}`);
    console.log("Headers:", res.headers);
    
    if (res.ok) {
      console.log("✅ ÉXITO: El servidor respondió correctamente.");
      // Consumir un poco del body para asegurar
      for await (const chunk of res.body) {
         console.log("Recibido chunk:", chunk.toString());
         break; // Solo queremos ver que funciona
      }
    } else {
      console.log("❌ ERROR: El servidor respondió con error.");
    }

  } catch (error) {
    console.log("❌ FALLO CRÍTICO:", error.message);
    if (error.cause) console.log("Causa:", error.cause);
  }
}

testConnection();

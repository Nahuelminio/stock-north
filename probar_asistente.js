/**
 * Hablar con el asistente desde la terminal, sin pasar por Telegram.
 * Sirve para probar cambios sin molestar al bot ni al chat.
 *
 *   node probar_asistente.js "cuanto ice king queda"   → una pregunta y chau
 *   node probar_asistente.js                           → conversación, hasta Ctrl+C
 *
 * Necesita ANTHROPIC_API_KEY en el entorno, la misma que usa el lector de
 * comprobantes. Si no la tenés en el .env local, podés pasarla al vuelo:
 *   ANTHROPIC_API_KEY=... node probar_asistente.js "..."
 */

require("dotenv").config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Falta ANTHROPIC_API_KEY en el entorno.");
  process.exit(1);
}

const readline = require("readline");
const { responder, MODELO } = require("./app/asistente/cerebro");

const CHAT = "consola";

async function preguntar(texto) {
  const arranque = Date.now();
  const r = await responder(CHAT, texto);
  const seg = ((Date.now() - arranque) / 1000).toFixed(1);
  console.log("\n" + r + "\n");
  console.log(`\x1b[2m(${seg}s)\x1b[0m\n`);
}

(async () => {
  const suelta = process.argv.slice(2).join(" ").trim();

  if (suelta) {
    await preguntar(suelta);
    process.exit(0);
  }

  console.log(`Asistente de The North Shop — ${MODELO}`);
  console.log("Escribí tu pregunta. Ctrl+C para salir.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const turno = () => {
    rl.question("> ", async (linea) => {
      const t = linea.trim();
      if (!t) return turno();
      try { await preguntar(t); }
      catch (e) { console.error("Error:", e.message, "\n"); }
      turno();
    });
  };
  turno();
})();

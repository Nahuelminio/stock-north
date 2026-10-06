/**
 * El bot que contesta. Telegram manda acá cada mensaje que le escribís.
 *
 * Seguridad, que acá importa más que en otras rutas porque esto habla con la
 * base y nadie está logueado:
 *
 *  1. La URL lleva un secreto largo, así que no se adivina.
 *  2. Telegram manda un header con otro secreto que comparamos.
 *  3. Solo contestamos a los chats de la lista blanca.
 *
 * Con cualquiera de los tres que falle, cortamos. Y contestamos 200 igual:
 * si devolvemos error, Telegram reintenta el mismo mensaje una y otra vez.
 */

const express = require("express");
const router = express.Router();
const { responder, olvidar } = require("../asistente/cerebro");
const { transcribir } = require("../asistente/transcribir");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SECRETO = process.env.TELEGRAM_WEBHOOK_SECRET || "";

// Quiénes pueden usarlo. Si no se define, cae al chat de los avisos.
const PERMITIDOS = (process.env.TELEGRAM_CHATS_ASISTENTE || process.env.TELEGRAM_CHAT_ID || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

/** Baja un archivo que mandó el usuario. Telegram los da en dos pasos. */
async function bajarArchivo(fileId) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
  const j = await r.json();
  const ruta = j?.result?.file_path;
  if (!ruta) throw new Error("Telegram no dio la ruta del archivo");
  const bin = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${ruta}`);
  if (!bin.ok) throw new Error(`No se pudo bajar el audio (${bin.status})`);
  return { buffer: Buffer.from(await bin.arrayBuffer()), nombre: ruta.split("/").pop() };
}

const api = (metodo, cuerpo) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  }).catch((e) => console.error("Telegram:", e.message));

/** Telegram corta los mensajes en 4096; partimos por renglón para no cortar palabras. */
function partir(texto, max = 3900) {
  if (texto.length <= max) return [texto];
  const partes = [];
  let actual = "";
  for (const linea of texto.split("\n")) {
    if ((actual + linea).length > max) { partes.push(actual); actual = ""; }
    actual += linea + "\n";
  }
  if (actual.trim()) partes.push(actual);
  return partes;
}

async function enviar(chatId, texto) {
  for (const parte of partir(texto)) {
    await api("sendMessage", {
      chat_id: chatId,
      text: parte,
      disable_web_page_preview: true,
    });
  }
}

router.post("/telegram/webhook/:secreto", async (req, res) => {
  // Contestamos ya: Telegram espera pocos segundos y pensar lleva más
  res.sendStatus(200);

  try {
    if (!SECRETO || req.params.secreto !== SECRETO) return;
    const header = req.get("X-Telegram-Bot-Api-Secret-Token");
    if (header && header !== SECRETO) return;

    const msg = req.body?.message || req.body?.edited_message;
    if (!msg) return;

    const chatId = String(msg.chat?.id || "");
    if (!PERMITIDOS.includes(chatId)) {
      console.warn(`🚫 asistente: chat no autorizado ${chatId}`);
      return;
    }

    // Un audio se transcribe y de ahí en adelante es igual que un mensaje escrito
    let texto = (msg.text || "").trim();

    if (msg.voice || msg.audio) {
      api("sendChatAction", { chat_id: chatId, action: "typing" });
      const archivo = msg.voice || msg.audio;
      let t;
      try {
        const { buffer, nombre } = await bajarArchivo(archivo.file_id);
        t = await transcribir(buffer, nombre);
      } catch (e) {
        console.error("audio de Telegram:", e.message);
        await enviar(chatId, "No pude bajar el audio. Probá de nuevo.");
        return;
      }

      if (!t.ok) {
        await enviar(chatId, t.falta_clave
          ? "Todavía no tengo configurada la transcripción. Mandámelo escrito, o " +
            "dictalo con el microfonito del teclado."
          : `No pude entender el audio: ${t.error}`);
        return;
      }

      texto = t.texto;
      // Se muestra lo que se entendió: si transcribió mal, lo ves vos antes
      // que el asistente conteste cualquier cosa.
      await enviar(chatId, `Entendí: "${texto}"`);
    }

    if (!texto) return;

    if (texto === "/start" || texto === "/ayuda") {
      await enviar(chatId,
        "Preguntame lo que quieras del negocio, como se lo preguntarías a alguien.\n\n" +
        "Por ejemplo:\n" +
        "- cuánto ice king me queda\n" +
        "- cómo venimos hoy\n" +
        "- quién me debe plata\n" +
        "- armame la lista mayorista al 15\n" +
        "- qué margen dejaron los pedidos de septiembre\n\n" +
        "Solo consulto, no cargo ni modifico nada.\n" +
        "/olvidar borra lo que veníamos hablando.");
      return;
    }

    if (texto === "/olvidar") {
      olvidar(chatId);
      await enviar(chatId, "Listo, arrancamos de cero.");
      return;
    }

    // "escribiendo..." mientras piensa, para que no parezca colgado
    api("sendChatAction", { chat_id: chatId, action: "typing" });
    const respuesta = await responder(chatId, texto);
    await enviar(chatId, respuesta);
  } catch (e) {
    console.error("❌ asistente:", e);
    const chatId = req.body?.message?.chat?.id;
    if (chatId) await enviar(chatId, "Se me rompió algo buscando eso. Probá de nuevo en un rato.");
  }
});

module.exports = router;

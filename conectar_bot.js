/**
 * Conecta el bot de Telegram al asistente.
 *
 *   node conectar_bot.js estado            → qué hay configurado hoy
 *   node conectar_bot.js secreto           → genera un secreto nuevo para las variables
 *   node conectar_bot.js chat              → dice el chat_id de quien le escriba al bot
 *   node conectar_bot.js conectar <url>    → le dice a Telegram dónde mandar los mensajes
 *   node conectar_bot.js desconectar       → lo deja como estaba
 *
 * La URL es la del backend en Render, por ejemplo https://stock-north.onrender.com
 */

require("dotenv").config();
const crypto = require("crypto");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SECRETO = process.env.TELEGRAM_WEBHOOK_SECRET || "";

if (!TOKEN) {
  console.error("Falta TELEGRAM_BOT_TOKEN en el entorno.");
  process.exit(1);
}

const api = async (metodo, cuerpo) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo || {}),
  });
  return r.json();
};

const [, , accion, arg] = process.argv;

(async () => {
  if (accion === "secreto") {
    console.log("Pegá esto en las variables de Render:\n");
    console.log("TELEGRAM_WEBHOOK_SECRET=" + crypto.randomBytes(24).toString("hex"));
    return;
  }

  if (accion === "estado") {
    const info = await api("getWebhookInfo");
    const yo = await api("getMe");
    console.log("Bot:", yo.result?.username ? "@" + yo.result.username : "(no responde)");
    const w = info.result || {};
    console.log("Webhook:", w.url || "(ninguno)");
    if (w.pending_update_count) console.log("Mensajes en cola:", w.pending_update_count);
    if (w.last_error_message) {
      console.log("Último error:", w.last_error_message, "—", new Date(w.last_error_date * 1000).toLocaleString("es-AR"));
    }
    console.log("Chats permitidos:", process.env.TELEGRAM_CHATS_ASISTENTE || process.env.TELEGRAM_CHAT_ID || "(ninguno)");
    console.log("Secreto:", SECRETO ? "definido" : "FALTA");
    return;
  }

  if (accion === "chat") {
    // Solo sirve con el webhook desconectado: los dos no pueden leer a la vez
    const r = await api("getUpdates", { timeout: 0 });
    const chats = new Map();
    for (const u of r.result || []) {
      const m = u.message || u.edited_message;
      if (m?.chat) chats.set(m.chat.id, m.chat.first_name || m.chat.title || m.chat.username || "");
    }
    if (chats.size === 0) {
      console.log("Nadie le escribió al bot todavía, o el webhook está conectado y se queda con los mensajes.");
      console.log("Escribile algo al bot y volvé a correr esto (desconectado).");
      return;
    }
    console.log("Chats que le escribieron:\n");
    for (const [id, nombre] of chats) console.log(`  ${id}   ${nombre}`);
    console.log("\nPoné el tuyo en TELEGRAM_CHATS_ASISTENTE (separados por coma si son varios).");
    return;
  }

  if (accion === "conectar") {
    if (!arg) { console.error("Falta la URL. Ej: node conectar_bot.js conectar https://stock-north.onrender.com"); process.exit(1); }
    if (!SECRETO) { console.error("Falta TELEGRAM_WEBHOOK_SECRET. Generalo con: node conectar_bot.js secreto"); process.exit(1); }
    const url = `${arg.replace(/\/$/, "")}/telegram/webhook/${SECRETO}`;
    const r = await api("setWebhook", {
      url,
      secret_token: SECRETO,
      allowed_updates: ["message", "edited_message"],
      drop_pending_updates: true,
    });
    console.log(r.ok ? "✓ Conectado." : "✗ " + JSON.stringify(r));
    if (r.ok) console.log("Telegram le va a pegar a /telegram/webhook/<secreto>");
    return;
  }

  if (accion === "desconectar") {
    const r = await api("deleteWebhook", { drop_pending_updates: false });
    console.log(r.ok ? "✓ Desconectado." : "✗ " + JSON.stringify(r));
    return;
  }

  console.log("Acciones: estado | secreto | chat | conectar <url> | desconectar");
})().catch((e) => { console.error(e); process.exit(1); });

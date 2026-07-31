// Avisos por Telegram. Fire-and-forget: si falla, se loguea y no rompe el flujo
// que lo llamó — un aviso perdido nunca debe hacer fallar una operación real.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

/** @param {string} texto  Texto plano (sin parse_mode, para evitar errores de parseo) */
function avisarTelegram(texto) {
  if (!TOKEN || !CHAT_ID) return;
  fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: texto,
      disable_web_page_preview: true,
    }),
  }).catch((err) => console.error("Telegram error:", err.message || err));
}

module.exports = { avisarTelegram };

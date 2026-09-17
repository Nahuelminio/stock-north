// Avisos por Telegram. Fire-and-forget: si falla, se loguea y no rompe el flujo
// que lo llamó — un aviso perdido nunca debe hacer fallar una operación real.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
// Las ventas son muchas más que los comprobantes. Si se define este chat,
// van ahí y no tapan los avisos que hay que revisar a mano.
const CHAT_ID_VENTAS = process.env.TELEGRAM_CHAT_ID_VENTAS || CHAT_ID;

/**
 * @param {string} texto  Texto plano (sin parse_mode, para evitar errores de parseo)
 * @param {{chatId?: string}} [opts]
 */
function avisarTelegram(texto, opts = {}) {
  const chatId = opts.chatId || CHAT_ID;
  if (!TOKEN || !chatId) return;
  fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      disable_web_page_preview: true,
    }),
  }).catch((err) => console.error("Telegram error:", err.message || err));
}

/** Aviso de venta: mismo bot, pero al chat de ventas si hay uno aparte. */
function avisarVenta(texto) {
  return avisarTelegram(texto, { chatId: CHAT_ID_VENTAS });
}

module.exports = { avisarTelegram, avisarVenta };

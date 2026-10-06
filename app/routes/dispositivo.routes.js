/**
 * Lo que mira el aparato del mostrador.
 *
 * Un microcontrolador no puede loguearse ni guardar un JWT que vence, así que
 * va con un token fijo en una variable de entorno. Por eso esta ruta devuelve
 * solamente lo que no molesta que se vea en una pantalla apoyada en el
 * mostrador: el dólar y cómo viene el día. Nada de costos, deudas ni márgenes.
 *
 * La respuesta es chica a propósito: parsear JSON en un ESP32 cuesta memoria.
 */

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { dolarHoy } = require("../dolar");
const { transcribir } = require("../asistente/transcribir");
const { responder } = require("../asistente/cerebro");
const { avisarTelegram } = require("../services/telegram");

// El chat al que le llegan las respuestas de lo que se le pregunta a la placa
const CHAT = (process.env.TELEGRAM_CHATS_ASISTENTE || process.env.TELEGRAM_CHAT_ID || "")
  .split(",")[0].trim();

const TOKEN = process.env.DISPOSITIVO_TOKEN || "";

/** El token puede venir por header o por query, lo que le sea más fácil al firmware. */
function autorizado(req) {
  if (!TOKEN) return false;
  const t = req.get("X-Dispositivo-Token") || req.query.token;
  return t === TOKEN;
}

router.get("/dispositivo/panel", async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ error: "no autorizado" });

  try {
    const { dolar, fuente } = await dolarHoy(pool);

    const [[hoy]] = await pool.promise().query(
      `SELECT COALESCE(SUM(cantidad * COALESCE(precio_unitario, 0)), 0) AS total,
              COALESCE(SUM(cantidad), 0) AS unidades
         FROM ventas WHERE DATE(fecha) = CURDATE()`
    );
    const [[may]] = await pool.promise().query(
      `SELECT COALESCE(SUM(total_ars), 0) AS total
         FROM pedidos_mayoristas
        WHERE estado = 'confirmado' AND DATE(fecha_confirmacion) = CURDATE()`
    );

    res.json({
      dolar: dolar ? Math.round(dolar) : null,
      fuente,
      ventas_hoy: Math.round(Number(hoy.total) + Number(may.total)),
      unidades_hoy: Number(hoy.unidades),
      hora: new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }),
    });
  } catch (e) {
    console.error("❌ GET /dispositivo/panel:", e);
    res.status(500).json({ error: "error" });
  }
});

/**
 * POST /dispositivo/preguntar
 * El cuerpo es el audio crudo (wav o similar). La placa lo graba mientras
 * tenés el botón apretado y lo manda tal cual.
 *
 * Transcribe, se lo pasa al mismo asistente que el bot, manda la respuesta
 * completa a Telegram y le devuelve a la placa una versión corta para la
 * pantalla: ahí no entra un párrafo.
 */
router.post(
  "/dispositivo/preguntar",
  express.raw({ type: "*/*", limit: "8mb" }),
  async (req, res) => {
    if (!autorizado(req)) return res.status(401).json({ error: "no autorizado" });

    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      return res.status(400).json({ error: "sin audio" });
    }

    try {
      const t = await transcribir(audio, req.query.formato === "wav" ? "nota.wav" : "nota.ogg");
      if (!t.ok) {
        return res.json({ ok: false, pantalla: t.falta_clave ? "sin transcriptor" : "no entendi" });
      }

      const respuesta = await responder("dispositivo", t.texto);

      // A Telegram va todo, que es donde se lee cómodo
      if (CHAT) {
        avisarTelegram(`Desde el aparato: "${t.texto}"\n\n${respuesta}`, { chatId: CHAT });
      }

      // A la pantalla, el primer renglón y recortado
      const corto = respuesta.split("\n").find((l) => l.trim()) || "";
      res.json({
        ok: true,
        escuchado: t.texto,
        pantalla: corto.length > 90 ? corto.slice(0, 87) + "..." : corto,
        enviado_a_telegram: Boolean(CHAT),
      });
    } catch (e) {
      console.error("❌ POST /dispositivo/preguntar:", e);
      res.status(500).json({ ok: false, pantalla: "error" });
    }
  }
);

module.exports = router;

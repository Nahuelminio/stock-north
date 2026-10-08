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
const { listaDeStock } = require("../asistente/listaStock");
const { hablar, hablarEnVivo } = require("../asistente/voz");
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
 * POST /dispositivo/lista?sucursal=central
 * Manda la lista de stock al Telegram del dueño.
 *
 * El aparato no tiene cómo mostrar una lista de ochenta sabores, así que la
 * manda al celular y en la pantalla deja un cartel de una línea. Es la misma
 * lista que arma el bot, para que no haya dos formatos dando vueltas.
 */
router.post("/dispositivo/lista", async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ error: "no autorizado" });
  if (!CHAT) return res.json({ ok: false, pantalla: "sin telegram" });

  const cual = (req.query.sucursal || "central").toString();

  try {
    const r = await listaDeStock(cual);
    if (!r.ok) return res.json({ ok: false, pantalla: "no la encontre" });
    if (r.vacio) return res.json({ ok: false, pantalla: "sin stock" });

    for (const parte of r.partes) avisarTelegram(parte, { chatId: CHAT });

    res.json({
      ok: true,
      sucursal: r.sucursal,
      pantalla: `lista de ${r.sucursal.toLowerCase()} enviada`,
    });
  } catch (e) {
    console.error("❌ POST /dispositivo/lista:", e);
    res.status(500).json({ ok: false, pantalla: "error" });
  }
});

/**
 * GET /dispositivo/decir?texto=...&wav=1
 * Convierte un texto en voz y lo devuelve.
 *
 * Sirve para probar el audio sin pasar por el micrófono ni por el asistente:
 * si lo que sale de acá suena bien, el problema está después.
 * Con wav=1 agrega el encabezado para poder escucharlo en una computadora.
 */
router.get("/dispositivo/decir", async (req, res) => {
  if (!autorizado(req)) return res.status(401).json({ error: "no autorizado" });

  const texto = (req.query.texto || "").toString().trim();
  if (!texto) return res.status(400).json({ error: "falta el texto" });

  const v = await hablar(texto);
  if (!v.ok) return res.status(502).json({ error: v.error });

  if (req.query.wav === "1") {
    const datos = v.pcm.length;
    const cab = Buffer.alloc(44);
    cab.write("RIFF", 0);
    cab.writeUInt32LE(datos + 36, 4);
    cab.write("WAVEfmt ", 8);
    cab.writeUInt32LE(16, 16);
    cab.writeUInt16LE(1, 20);
    cab.writeUInt16LE(1, 22);
    cab.writeUInt32LE(16000, 24);
    cab.writeUInt32LE(32000, 28);
    cab.writeUInt16LE(2, 32);
    cab.writeUInt16LE(16, 34);
    cab.write("data", 36);
    cab.writeUInt32LE(datos, 40);
    res.set("Content-Type", "audio/wav");
    return res.send(Buffer.concat([cab, v.pcm]));
  }

  res.set("Content-Type", "audio/L16; rate=16000");
  res.send(v.pcm);
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

    // Se mide cada etapa y se devuelve en una cabecera: sin esto, optimizar es
    // adivinar cuál de las tres partes es la lenta.
    const reloj = Date.now();
    const tiempos = {};

    try {
      const t = await transcribir(audio, req.query.formato === "wav" ? "nota.wav" : "nota.ogg");
      tiempos.oir = Date.now() - reloj;
      if (!t.ok) {
        return res.json({ ok: false, pantalla: t.falta_clave ? "sin transcriptor" : "no entendi" });
      }

      const marca = Date.now();
      const respuesta = await responder("dispositivo", t.texto);
      tiempos.pensar = Date.now() - marca;

      // A Telegram va todo, que es donde se lee cómodo
      if (CHAT) {
        avisarTelegram(`Desde el aparato: "${t.texto}"\n\n${respuesta}`, { chatId: CHAT });
      }

      // A la pantalla, el primer renglón y recortado
      const corto = respuesta.split("\n").find((l) => l.trim()) || "";
      const pantalla = corto.length > 90 ? corto.slice(0, 87) + "..." : corto;

      if (req.query.voz === "1") {
        // Va en streaming: esperar la frase entera antes de empezar a
        // mandarla agrega los dos segundos que tarda la voz, y lo que se nota
        // en una conversación es cuánto tardás en escuchar, no el total.
        //
        // Sin largo que anunciar, la respuesta sale troceada (el tamaño de cada
        // bloque viaja dentro del flujo) y encima el proxy de adelante la
        // trocea igual aunque acá se apague. Eso ensuciaba el audio mientras la
        // placa leía el socket pelado; ahora lo decodifica como corresponde.
        //
        // Las cabeceras salen primero, antes del audio: así la placa ya puede
        // mostrar la respuesta en pantalla mientras la voz todavía se genera.
        res.set({
          Connection: "close",
          "Content-Type": "audio/L16; rate=16000",
          "X-Pantalla": encodeURIComponent(pantalla),
          "X-Escuchado": encodeURIComponent(t.texto),
          "X-Tiempos": `oir=${tiempos.oir} pensar=${tiempos.pensar}`,
        });
        res.flushHeaders();

        const marcaVoz = Date.now();
        let primero = 0;
        const v = await hablarEnVivo(corto, (trozo) => {
          if (!primero) primero = Date.now() - marcaVoz;
          res.write(trozo);
        });
        tiempos.hablar = Date.now() - marcaVoz;

        console.log(`⏱  oir=${tiempos.oir} pensar=${tiempos.pensar} ` +
                    `primera_voz=${primero} hablar=${tiempos.hablar} ` +
                    `total=${Date.now() - reloj}`);

        if (!v.ok) console.warn("voz:", v.error);
        return res.end();
      }

      res.json({
        ok: true,
        escuchado: t.texto,
        pantalla,
        enviado_a_telegram: Boolean(CHAT),
      });
    } catch (e) {
      console.error("❌ POST /dispositivo/preguntar:", e);
      res.status(500).json({ ok: false, pantalla: "error" });
    }
  }
);

module.exports = router;

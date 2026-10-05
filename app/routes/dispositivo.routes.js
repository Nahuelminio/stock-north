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

module.exports = router;

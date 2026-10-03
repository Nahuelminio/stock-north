/**
 * Costos: qué nos cuesta cada cosa.
 *
 *   GET /costos/pedidos  — todos los pedidos (mayoristas y de Central) con lo
 *                          que costó la mercadería y cuánto dejó cada uno.
 *   GET /costos/compras  — lo que le pagamos al proveedor, agrupado por tanda.
 *
 * El costo sale siempre de app/costos.js, el mismo que usan las pantallas de
 * cada pedido, para que los números coincidan.
 */

const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");
const { CENTRAL_ID, costoUnitario, costosDeGustos, margenPct } = require("../costos");

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Sólo admin" });
  next();
};

/** Rango por defecto: el mes en curso. */
function rango(req) {
  const hoy = new Date();
  const desde = req.query.desde || new Date(hoy.getFullYear(), hoy.getMonth(), 1)
    .toISOString().slice(0, 10);
  const hasta = req.query.hasta || hoy.toISOString().slice(0, 10);
  return { desde, hasta };
}

const redondear = (n) => Number((Number(n) || 0).toFixed(2));

// ─────────────────────────────────────────────────────────────────────────────
// GET /costos/pedidos?desde&hasta
// ─────────────────────────────────────────────────────────────────────────────
router.get("/costos/pedidos", authenticate, soloAdmin, async (req, res) => {
  const { desde, hasta } = rango(req);

  try {
    // ── Mayoristas: el costo se resuelve con un JOIN, los items están en tabla
    const [mayoristas] = await pool.promise().query(
      `SELECT
         pm.id, pm.estado, pm.fecha_confirmacion AS fecha, pm.total_ars AS facturado,
         c.nombre AS cliente,
         (SELECT COALESCE(SUM(pmi.cantidad), 0)
            FROM pedido_mayorista_items pmi WHERE pmi.pedido_id = pm.id) AS unidades,
         (SELECT COALESCE(SUM(pmi.cantidad * ${costoUnitario(
           "pmi.gusto_id",
           "pm.fecha_confirmacion"
         )}), 0)
            FROM pedido_mayorista_items pmi WHERE pmi.pedido_id = pm.id) AS costo
       FROM pedidos_mayoristas pm
       JOIN clientes c ON c.id = pm.cliente_id
       WHERE pm.estado = 'confirmado'
         AND DATE(pm.fecha_confirmacion) >= ? AND DATE(pm.fecha_confirmacion) <= ?
       ORDER BY pm.fecha_confirmacion DESC`,
      [desde, hasta]
    );

    // ── De Central: los items están en JSON, se resuelven aparte
    const [centrales] = await pool.promise().query(
      `SELECT id, estado, fecha_confirmacion AS fecha, total AS facturado,
              nombre_cliente AS cliente, items
         FROM pedidos_central
        WHERE estado = 'confirmado'
          AND DATE(fecha_confirmacion) >= ? AND DATE(fecha_confirmacion) <= ?
        ORDER BY fecha_confirmacion DESC`,
      [desde, hasta]
    );

    const centralesConCosto = [];
    for (const p of centrales) {
      const items = typeof p.items === "string" ? JSON.parse(p.items) : p.items || [];
      const costos = await costosDeGustos(
        pool,
        items.map((i) => i.gusto_id),
        p.fecha
      );
      let costo = 0;
      let unidades = 0;
      for (const i of items) {
        const cant = Number(i.qty ?? i.cantidad) || 0;
        costo += (costos.get(Number(i.gusto_id)) || 0) * cant;
        unidades += cant;
      }
      centralesConCosto.push({ ...p, items: undefined, unidades, costo });
    }

    const armar = (p, tipo) => {
      const facturado = Number(p.facturado) || 0;
      const costo = redondear(p.costo);
      return {
        tipo,
        id: p.id,
        fecha: p.fecha,
        cliente: p.cliente || "",
        unidades: Number(p.unidades) || 0,
        facturado: redondear(facturado),
        costo,
        ganancia: redondear(facturado - costo),
        margen_pct: margenPct(facturado, facturado - costo),
      };
    };

    const pedidos = [
      ...mayoristas.map((p) => armar(p, "mayorista")),
      ...centralesConCosto.map((p) => armar(p, "central")),
    ].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    const totales = pedidos.reduce(
      (a, p) => ({
        pedidos: a.pedidos + 1,
        unidades: a.unidades + p.unidades,
        facturado: a.facturado + p.facturado,
        costo: a.costo + p.costo,
      }),
      { pedidos: 0, unidades: 0, facturado: 0, costo: 0 }
    );
    totales.ganancia = redondear(totales.facturado - totales.costo);
    totales.facturado = redondear(totales.facturado);
    totales.costo = redondear(totales.costo);
    totales.margen_pct = margenPct(totales.facturado, totales.ganancia);

    res.json({ desde, hasta, pedidos, totales });
  } catch (e) {
    console.error("❌ GET /costos/pedidos:", e);
    res.status(500).json({ error: "Error al calcular los costos de los pedidos" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /costos/compras?desde&hasta
// Lo que le pagamos al proveedor. Una reposición se carga sabor por sabor en
// pocos minutos, así que se agrupan por tanda (mismo día y hora:minuto) para
// que una compra sea una fila y no cuarenta.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/costos/compras", authenticate, soloAdmin, async (req, res) => {
  const { desde, hasta } = rango(req);

  try {
    const [filas] = await pool.promise().query(
      `SELECT
         DATE_FORMAT(r.fecha, '%Y-%m-%d %H:%i') AS tanda,
         MIN(r.fecha) AS fecha,
         COUNT(*) AS renglones,
         SUM(r.cantidad_repuesta) AS unidades,
         SUM(r.cantidad_repuesta * COALESCE(r.precio_costo, 0)) AS invertido,
         SUM(CASE WHEN r.precio_costo IS NULL OR r.precio_costo = 0 THEN 1 ELSE 0 END) AS sin_costo,
         COUNT(DISTINCT p.id) AS modelos,
         GROUP_CONCAT(DISTINCT TRIM(REPLACE(p.nombre, CHAR(9), '')) ORDER BY p.nombre SEPARATOR ', ') AS detalle
       FROM reposiciones r
       JOIN gustos g    ON g.id = r.gusto_id
       JOIN productos p ON p.id = g.producto_id
       WHERE r.sucursal_id = ?
         AND DATE(r.fecha) >= ? AND DATE(r.fecha) <= ?
       GROUP BY tanda
       ORDER BY fecha DESC`,
      [CENTRAL_ID, desde, hasta]
    );

    const compras = filas.map((f) => ({
      tanda: f.tanda,
      fecha: f.fecha,
      renglones: Number(f.renglones),
      modelos: Number(f.modelos),
      unidades: Number(f.unidades),
      invertido: redondear(f.invertido),
      // Renglones sin precio cargado: el total de esa tanda queda corto
      sin_costo: Number(f.sin_costo),
      costo_promedio: Number(f.unidades) > 0
        ? redondear(Number(f.invertido) / Number(f.unidades))
        : 0,
      detalle: f.detalle || "",
    }));

    const totales = compras.reduce(
      (a, c) => ({
        compras: a.compras + 1,
        unidades: a.unidades + c.unidades,
        invertido: a.invertido + c.invertido,
        sin_costo: a.sin_costo + c.sin_costo,
      }),
      { compras: 0, unidades: 0, invertido: 0, sin_costo: 0 }
    );
    totales.invertido = redondear(totales.invertido);
    totales.costo_promedio = totales.unidades > 0
      ? redondear(totales.invertido / totales.unidades)
      : 0;

    res.json({ desde, hasta, compras, totales });
  } catch (e) {
    console.error("❌ GET /costos/compras:", e);
    res.status(500).json({ error: "Error al calcular las compras" });
  }
});

module.exports = router;

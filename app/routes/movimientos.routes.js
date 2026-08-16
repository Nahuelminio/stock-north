const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

// El historial deja ver cuánto se movió y hacia dónde en cada local, así que
// queda sólo para el dueño.
const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo admin" });
  next();
};

// Cómo se muestra cada motivo. Los movimientos viejos o los hechos por fuera
// del sistema quedan como "sin_registrar".
const MOTIVOS = {
  venta: "Venta",
  venta_publica: "Venta por catálogo",
  reposicion: "Reposición",
  ajuste: "Ajuste manual",
  transferencia_salida: "Transferencia (sale)",
  transferencia_entrada: "Transferencia (entra)",
  mayorista: "Pedido mayorista",
  evento_salida: "Sale a evento",
  evento_devolucion: "Vuelve de evento",
  importacion: "Importación",
  alta_producto: "Alta de producto",
  sin_registrar: "Sin registrar",
};

/**
 * GET /movimientos-stock
 * Filtros: sucursal_id, gusto_id, producto_id, motivo, desde, hasta, q, limite
 */
router.get("/movimientos-stock", authenticate, soloAdmin, async (req, res) => {
  const { sucursal_id, gusto_id, producto_id, motivo, desde, hasta, q } = req.query;
  const limite = Math.min(Number(req.query.limite) || 200, 1000);

  const where = [];
  const params = [];
  if (sucursal_id) { where.push("m.sucursal_id = ?"); params.push(sucursal_id); }
  if (gusto_id) { where.push("m.gusto_id = ?"); params.push(gusto_id); }
  if (producto_id) { where.push("g.producto_id = ?"); params.push(producto_id); }
  if (motivo) { where.push("m.motivo = ?"); params.push(motivo); }
  if (desde) { where.push("m.creado_at >= ?"); params.push(desde); }
  if (hasta) { where.push("m.creado_at < ?"); params.push(hasta); }
  if (q) {
    where.push("(p.nombre LIKE ? OR g.nombre LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }

  try {
    const [filas] = await pool.promise().query(
      `SELECT m.id, m.gusto_id, m.sucursal_id, m.delta, m.cantidad_antes, m.cantidad_despues,
              m.motivo, m.referencia, m.usuario_id, m.creado_at,
              TRIM(p.nombre) AS producto, TRIM(g.nombre) AS gusto,
              COALESCE(s.apodo, s.nombre) AS sucursal,
              u.email AS usuario
         FROM stock_movimientos m
         LEFT JOIN gustos g     ON g.id = m.gusto_id
         LEFT JOIN productos p  ON p.id = g.producto_id
         LEFT JOIN sucursales s ON s.id = m.sucursal_id
         LEFT JOIN usuarios u   ON u.id = m.usuario_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY m.creado_at DESC, m.id DESC
        LIMIT ?`,
      [...params, limite]
    );

    res.json({
      movimientos: filas.map((f) => ({ ...f, motivo_texto: MOTIVOS[f.motivo] || f.motivo })),
      motivos: MOTIVOS,
    });
  } catch (e) {
    console.error("❌ Error en GET /movimientos-stock:", e);
    res.status(500).json({ error: "No se pudieron traer los movimientos" });
  }
});

/**
 * GET /movimientos-stock/control
 * Compara el stock actual contra la suma de los movimientos registrados.
 * Sirve para detectar si quedó algún camino que mueve stock sin registrar:
 * si aparece una diferencia, es que algo lo cambió sin pasar por el trigger.
 */
router.get("/movimientos-stock/control", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[desde]] = await pool.promise().query(
      "SELECT MIN(creado_at) AS desde, COUNT(*) AS total FROM stock_movimientos"
    );
    // Sólo tiene sentido para lo que se movió desde que existe el registro:
    // el stock que ya estaba cargado antes no tiene movimientos que lo expliquen.
    const [filas] = await pool.promise().query(
      `SELECT s.gusto_id, s.sucursal_id, s.cantidad AS stock_actual,
              COALESCE(SUM(m.delta), 0) AS suma_movimientos,
              TRIM(p.nombre) AS producto, TRIM(g.nombre) AS gusto,
              COALESCE(su.apodo, su.nombre) AS sucursal
         FROM stock s
         JOIN stock_movimientos m ON m.gusto_id = s.gusto_id AND m.sucursal_id = s.sucursal_id
         LEFT JOIN gustos g     ON g.id = s.gusto_id
         LEFT JOIN productos p  ON p.id = g.producto_id
         LEFT JOIN sucursales su ON su.id = s.sucursal_id
        GROUP BY s.gusto_id, s.sucursal_id, s.cantidad, p.nombre, g.nombre, su.apodo, su.nombre`
    );
    res.json({ desde: desde.desde, total_movimientos: Number(desde.total), filas });
  } catch (e) {
    console.error("❌ Error en GET /movimientos-stock/control:", e);
    res.status(500).json({ error: "No se pudo hacer el control" });
  }
});

module.exports = router;

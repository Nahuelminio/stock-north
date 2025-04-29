const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

// 🔵 Vender producto (de su sucursal)
router.post("/vender", authenticate, async (req, res) => {
  const { gusto_id, cantidad } = req.body;
  const { sucursalId } = req.user;

  if (!gusto_id || !cantidad) {
    return res.status(400).json({ error: "Datos incompletos" });
  }
  try {
    const [[stock]] = await pool
      .promise()
      .query(
        "SELECT cantidad FROM stock WHERE gusto_id = ? AND sucursal_id = ?",
        [gusto_id, sucursalId]
      );

    if (!stock || stock.cantidad < cantidad) {
      return res
        .status(400)
        .json({ error: "Stock insuficiente o no encontrado" });
    }

    await pool
      .promise()
      .query(
        "UPDATE stock SET cantidad = cantidad - ? WHERE gusto_id = ? AND sucursal_id = ?",
        [cantidad, gusto_id, sucursalId]
      );

    await pool
      .promise()
      .query(
        "INSERT INTO ventas (gusto_id, sucursal_id, cantidad, fecha) VALUES (?, ?, ?, NOW())",
        [gusto_id, sucursalId, cantidad]
      );

    res.json({ mensaje: "✅ Venta registrada" });
  } catch (error) {
    console.error("❌ Error al registrar venta:", error);
    res.status(500).json({ error: "Error al registrar venta" });
  }
});

// 🔵 Ventas mensuales (solo de su sucursal, salvo admin)
router.get("/ventas-mensuales", authenticate, async (req, res) => {
  const { mes, anio } = req.query;
  const { sucursalId, rol } = req.user;

  if (!mes || !anio) {
    return res.status(400).json({ error: "Faltan parámetros mes y año" });
  }
  try {
    let query = `
      SELECT 
        s.nombre AS sucursal,
        SUM(v.cantidad) AS total_ventas
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
    `;
    const params = [mes, anio];

    if (rol !== "admin") {
      query += " AND v.sucursal_id = ?";
      params.push(sucursalId);
    }

    query += " GROUP BY v.sucursal_id";

    const [result] = await pool.promise().query(query, params);
    res.json(result);
  } catch (error) {
    console.error("❌ Error al obtener ventas mensuales:", error);
    res.status(500).json({ error: "Error al obtener ventas mensuales" });
  }
});

// 🔵 Historial de ventas (filtrado automático por sucursal si no es admin)
router.get("/historial", authenticate, async (req, res) => {
  const { sucursalId, rol } = req.user;

  try {
    let query = `
      SELECT 
        v.id,
        s.nombre AS sucursal,
        p.nombre AS producto,
        g.nombre AS gusto,
        v.cantidad,
        p.precio,
        v.fecha
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
    `;
    const params = [];

    if (rol !== "admin") {
      query += " WHERE v.sucursal_id = ?";
      params.push(sucursalId);
    }

    query += " ORDER BY v.fecha DESC";

    const [results] = await pool.promise().query(query, params);
    res.json(results);
  } catch (err) {
    console.error("❌ Error al obtener historial de ventas:", err);
    res.status(500).json({ error: "Error al obtener historial de ventas" });
  }
});

// 🔵 Total de ventas por sucursal (solo admin)
router.get("/total-por-sucursal", authenticate, async (req, res) => {
  const { rol } = req.user;

  if (rol !== "admin") {
    return res
      .status(403)
      .json({ error: "Acceso denegado: sólo administradores" });
  }

  try {
    const [results] = await pool.promise().query(`
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(v.cantidad * p.precio) AS total_facturado
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);

    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener total de ventas por sucursal:", error);
    res.status(500).json({ error: "Error al obtener total de ventas" });
  }
});

module.exports = router;

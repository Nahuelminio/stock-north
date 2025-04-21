const express = require("express");
const router = express.Router();
const pool = require("../db");

// Vender producto por gusto_id
router.post("/vender", async (req, res) => {
  const { gusto_id, sucursal_id, cantidad } = req.body;
  if (!gusto_id || !sucursal_id || !cantidad) {
    return res.status(400).json({ error: "Datos incompletos" });
  }
  try {
    const [[stock]] = await pool
      .promise()
      .query(
        "SELECT cantidad FROM stock WHERE gusto_id = ? AND sucursal_id = ?",
        [gusto_id, sucursal_id]
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
        [cantidad, gusto_id, sucursal_id]
      );

    await pool
      .promise()
      .query(
        "INSERT INTO ventas (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)",
        [gusto_id, sucursal_id, cantidad]
      );

    res.json({ mensaje: "Venta registrada" });
  } catch (error) {
    console.error("❌ Error al registrar venta:", error);
    res.status(500).json({ error: "Error al registrar venta" });
  }
});

// Ventas mensuales por sucursal
router.get("/ventas-mensuales", async (req, res) => {
  const { mes, anio } = req.query;
  if (!mes || !anio) {
    return res.status(400).json({ error: "Faltan parámetros mes y año" });
  }
  try {
    const [result] = await pool.promise().query(
      `
      SELECT 
        s.nombre AS sucursal,
        SUM(v.cantidad) AS total_ventas
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
      GROUP BY v.sucursal_id
    `,
      [mes, anio]
    );
    res.json(result);
  } catch (error) {
    console.error("❌ Error al obtener ventas mensuales:", error);
    res.status(500).json({ error: "Error al obtener ventas mensuales" });
  }
});

// Historial de ventas (opcionalmente filtrado por sucursal)
router.get("/historial", async (req, res) => {
  const { sucursal_id } = req.query;
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
    if (sucursal_id) {
      query += " WHERE v.sucursal_id = ?";
      params.push(sucursal_id);
    }
    query += " ORDER BY v.fecha DESC";

    const [results] = await pool.promise().query(query, params);
    res.json(results);
  } catch (err) {
    console.error("❌ Error al obtener historial de ventas:", err);
    res.status(500).json({ error: "Error al obtener historial de ventas" });
  }
});

// Total de ventas por sucursal
router.get("/total-por-sucursal", async (req, res) => {
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

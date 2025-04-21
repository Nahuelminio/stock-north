const express = require("express");
const router = express.Router();
const pool = require("../db");

// Registrar pago
router.post("/registrar-pago", async (req, res) => {
  const { sucursal_id, metodo, monto } = req.body;
  if (!sucursal_id || !metodo || !monto) {
    return res.status(400).json({ error: "Faltan datos del pago" });
  }

  try {
    await pool
      .promise()
      .query(
        "INSERT INTO pagos (sucursal_id, metodo, monto, fecha) VALUES (?, ?, ?, NOW())",
        [sucursal_id, metodo, monto]
      );
    res.json({ mensaje: "✅ Pago registrado" });
  } catch (error) {
    console.error("❌ Error al registrar pago:", error);
    res.status(500).json({ error: "Error al registrar el pago" });
  }
});

// Historial de pagos
router.get("/historial-pagos", async (req, res) => {
  const { sucursal_id, fecha_inicio, fecha_fin } = req.query;

  try {
    let query = `
      SELECT 
        p.id,
        s.nombre AS sucursal,
        p.metodo,
        p.monto,
        p.fecha
      FROM pagos p
      JOIN sucursales s ON p.sucursal_id = s.id
      WHERE 1 = 1
    `;

    const params = [];

    if (sucursal_id) {
      query += " AND p.sucursal_id = ?";
      params.push(sucursal_id);
    }

    if (fecha_inicio && fecha_fin) {
      query += " AND DATE(p.fecha) BETWEEN ? AND ?";
      params.push(fecha_inicio, fecha_fin);
    } else if (fecha_inicio) {
      query += " AND DATE(p.fecha) >= ?";
      params.push(fecha_inicio);
    } else if (fecha_fin) {
      query += " AND DATE(p.fecha) <= ?";
      params.push(fecha_fin);
    }

    query += " ORDER BY p.fecha DESC";

    const [results] = await pool.promise().query(query, params);
    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener historial de pagos:", error);
    res.status(500).json({ error: "Error al obtener historial de pagos" });
  }
});

// Pagos por sucursal
router.get("/pagos-por-sucursal", async (req, res) => {
  try {
    const [result] = await pool.promise().query(`
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        IFNULL(SUM(p.monto), 0) AS total_pagado
      FROM sucursales s
      LEFT JOIN pagos p ON p.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);
    res.json(result);
  } catch (err) {
    console.error("❌ Error al obtener pagos por sucursal:", err);
    res.status(500).json({ error: "Error al obtener pagos" });
  }
});

// Resumen financiero: facturado vs pagado
router.get("/resumen-pagos", async (req, res) => {
  try {
    const [facturadoPorSucursal] = await pool.promise().query(`
      SELECT 
        v.sucursal_id, 
        s.nombre AS sucursal,
        SUM(v.cantidad * p.precio) AS total_facturado
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY v.sucursal_id, s.nombre
    `);

    const [pagosPorSucursal] = await pool.promise().query(`
      SELECT 
        sucursal_id,
        SUM(monto) AS total_pagado
      FROM pagos
      GROUP BY sucursal_id
    `);

    const todasLasSucursales = new Set([
      ...facturadoPorSucursal.map((f) => f.sucursal_id),
      ...pagosPorSucursal.map((p) => p.sucursal_id),
    ]);

    const resumen = Array.from(todasLasSucursales).map((id) => {
      const f = facturadoPorSucursal.find((x) => x.sucursal_id === id) || {};
      const p = pagosPorSucursal.find((x) => x.sucursal_id === id) || {};
      return {
        sucursal_id: id,
        sucursal: f.sucursal || p.sucursal || "Desconocida",
        total_facturado: f.total_facturado || 0,
        total_pagado: p.total_pagado || 0,
        total_pendiente: (f.total_facturado || 0) - (p.total_pagado || 0),
      };
    });

    res.json(resumen);
  } catch (error) {
    console.error("❌ Error al obtener resumen financiero:", error);
    res.status(500).json({ error: "Error al obtener resumen financiero" });
  }
});

module.exports = router;

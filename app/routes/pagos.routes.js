const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

// 🔵 Registrar pago (solo para la sucursal logueada)
router.post("/registrar-pago", authenticate, async (req, res) => {
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

// 🔵 Historial de pagos
router.get("/historial-pagos", authenticate, async (req, res) => {
  const { fecha_inicio, fecha_fin } = req.query;
  const { sucursalId, rol } = req.user;

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
      WHERE 1=1
    `;
    const params = [];

    // Si no es admin, filtro sólo por su sucursal
    if (rol !== "admin") {
      query += " AND p.sucursal_id = ?";
      params.push(sucursalId);
    }

    // Filtros por fechas opcionales
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

// 🔵 Total de pagos por sucursal (solo para admin)
router.get("/pagos-por-sucursal", authenticate, async (req, res) => {
  const { rol } = req.user;

  if (rol !== "admin") {
    return res
      .status(403)
      .json({ error: "Acceso denegado: sólo administradores" });
  }

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
router.get("/resumen-pagos", authenticate, async (req, res) => {
  const { rol, sucursalId } = req.user;

  try {
    if (rol === "admin") {
      // 🔄 (igual que antes) devolver el resumen completo
      const [facturadoPorSucursal] = await pool.promise().query(`
        SELECT 
          v.sucursal_id, 
          s.nombre AS sucursal,
          SUM(v.cantidad * g.precio) AS total_facturado
        FROM ventas v
        JOIN gustos g ON v.gusto_id = g.id
        JOIN sucursales s ON v.sucursal_id = s.id
        GROUP BY v.sucursal_id, s.nombre
      `);

      const [pagosPorSucursal] = await pool.promise().query(`
        SELECT sucursal_id, SUM(monto) AS total_pagado
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
        const total_facturado = Number(f.total_facturado || 0);
        const total_pagado = Number(p.total_pagado || 0);

        return {
          sucursal_id: id,
          sucursal: f.sucursal || "Desconocida",
          total_facturado,
          total_pagado,
          deuda: total_facturado - total_pagado,
        };
      });

      return res.json(resumen);
    } else {
      // 🔥 ✅ Aquí: cálculo SOLO para la sucursal del usuario
      const [facturadoRow] = await pool.promise().query(
        `
        SELECT SUM(v.cantidad * g.precio) AS total_facturado
        FROM ventas v
        JOIN gustos g ON v.gusto_id = g.id
        WHERE v.sucursal_id = ?
      `,
        [sucursalId]
      );

      const [pagosRow] = await pool.promise().query(
        `
        SELECT SUM(monto) AS total_pagado
        FROM pagos
        WHERE sucursal_id = ?
      `,
        [sucursalId]
      );

      const total_facturado = Number(facturadoRow[0].total_facturado || 0);
      const total_pagado = Number(pagosRow[0].total_pagado || 0);
      const deuda = total_facturado - total_pagado;

      return res.json({
        sucursal_id: sucursalId,
        total_facturado,
        total_pagado,
        deuda,
      });
    }
  } catch (err) {
    console.error("❌ Error al obtener resumen financiero:", err);
    res.status(500).json({ error: "Error al obtener resumen financiero" });
  }
});


module.exports = router;

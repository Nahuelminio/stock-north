const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo administradores" });
  next();
};

// Datos para el dashboard principal
router.get("/dashboard", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[stockTotal]] = await pool
      .promise()
      .query("SELECT SUM(cantidad) as total FROM stock");

    const [[stockBajo]] = await pool
      .promise()
      .query("SELECT COUNT(*) as bajos FROM stock WHERE cantidad <= 5");

    const [porSucursal] = await pool.promise().query(
      `SELECT s.nombre, COUNT(*) as productos
       FROM stock st
       JOIN sucursales s ON st.sucursal_id = s.id
       GROUP BY s.nombre`
    );

    res.json({
      stockTotal: stockTotal.total || 0,
      stockBajo: stockBajo.bajos || 0,
      productosPorSucursal: porSucursal,
      totalProductos: porSucursal.reduce((acc, s) => acc + s.productos, 0),
    });
  } catch (error) {
    console.error("❌ Error al obtener dashboard:", error);
    res.status(500).json({ error: "Error al obtener dashboard" });
  }
});

router.get("/resumen-ganancias", authenticate, soloAdmin, async (req, res) => {
  try {
    const [rows] = await pool.promise().query(`
      SELECT
        s.nombre AS sucursal,
        COALESCE(reg.ventas_regulares, 0) + COALESCE(may.ventas_mayorista, 0)   AS total_ventas,
        COALESCE(reg.ventas_regulares, 0)                                         AS ventas_regulares,
        COALESCE(may.ventas_mayorista, 0)                                         AS ventas_mayorista,
        COALESCE(reg.costo_regular, 0)    + COALESCE(may.costo_mayorista, 0)    AS costo_total,
        (COALESCE(reg.ventas_regulares, 0) + COALESCE(may.ventas_mayorista, 0))
          - (COALESCE(reg.costo_regular, 0) + COALESCE(may.costo_mayorista, 0)) AS ganancia
      FROM sucursales s
      LEFT JOIN (
        SELECT
          v.sucursal_id,
          SUM(v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS ventas_regulares,
          SUM(v.cantidad * p.precio_costo)                             AS costo_regular
        FROM ventas v
        JOIN gustos   g  ON g.id  = v.gusto_id
        JOIN productos p ON p.id  = g.producto_id
        LEFT JOIN stock st ON st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id
        GROUP BY v.sucursal_id
      ) reg ON reg.sucursal_id = s.id
      LEFT JOIN (
        SELECT
          pm.sucursal_id,
          SUM(pm.total_ars)                AS ventas_mayorista,
          SUM(pmi.cantidad * p.precio_costo) AS costo_mayorista
        FROM pedidos_mayoristas pm
        JOIN pedido_mayorista_items pmi ON pmi.pedido_id = pm.id
        JOIN gustos   g ON g.id = pmi.gusto_id
        JOIN productos p ON p.id = g.producto_id
        WHERE pm.estado = 'confirmado'
        GROUP BY pm.sucursal_id
      ) may ON may.sucursal_id = s.id
      WHERE reg.sucursal_id IS NOT NULL OR may.sucursal_id IS NOT NULL
      ORDER BY s.nombre;
    `);

    res.json(rows);
  } catch (error) {
    console.error("❌ Error al obtener resumen de ganancias:", error);
    res.status(500).json({ error: "Error al obtener resumen de ganancias" });
  }
});

router.get("/resumen-ganancias-mensual", authenticate, soloAdmin, async (req, res) => {
  const { mes, anio } = req.query;

  if (!mes || !anio) {
    return res.status(400).json({ error: "Debe proporcionar mes y año" });
  }

  try {
    const [rows] = await pool.promise().query(
      `
      SELECT
        s.nombre AS sucursal,
        COALESCE(reg.ventas_regulares, 0) + COALESCE(may.ventas_mayorista, 0)   AS total_ventas,
        COALESCE(reg.ventas_regulares, 0)                                         AS ventas_regulares,
        COALESCE(may.ventas_mayorista, 0)                                         AS ventas_mayorista,
        COALESCE(reg.costo_regular, 0)    + COALESCE(may.costo_mayorista, 0)    AS costo_total,
        (COALESCE(reg.ventas_regulares, 0) + COALESCE(may.ventas_mayorista, 0))
          - (COALESCE(reg.costo_regular, 0) + COALESCE(may.costo_mayorista, 0)) AS ganancia
      FROM sucursales s
      LEFT JOIN (
        SELECT
          v.sucursal_id,
          SUM(v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS ventas_regulares,
          SUM(v.cantidad * p.precio_costo)                             AS costo_regular
        FROM ventas v
        JOIN gustos   g  ON g.id  = v.gusto_id
        JOIN productos p ON p.id  = g.producto_id
        LEFT JOIN stock st ON st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id
        WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
        GROUP BY v.sucursal_id
      ) reg ON reg.sucursal_id = s.id
      LEFT JOIN (
        SELECT
          pm.sucursal_id,
          SUM(pm.total_ars)                AS ventas_mayorista,
          SUM(pmi.cantidad * p.precio_costo) AS costo_mayorista
        FROM pedidos_mayoristas pm
        JOIN pedido_mayorista_items pmi ON pmi.pedido_id = pm.id
        JOIN gustos   g ON g.id = pmi.gusto_id
        JOIN productos p ON p.id = g.producto_id
        WHERE pm.estado = 'confirmado'
          AND MONTH(pm.fecha_confirmacion) = ? AND YEAR(pm.fecha_confirmacion) = ?
        GROUP BY pm.sucursal_id
      ) may ON may.sucursal_id = s.id
      WHERE reg.sucursal_id IS NOT NULL OR may.sucursal_id IS NOT NULL
      ORDER BY s.nombre;
      `,
      [mes, anio, mes, anio]
    );

    res.json(rows);
  } catch (error) {
    console.error("❌ Error al obtener resumen mensual:", error);
    res.status(500).json({ error: "Error al obtener resumen mensual de ganancias" });
  }
});

router.get("/kpis-hoy", authenticate, soloAdmin, async (req, res) => {
  try {
    const db = pool.promise();

    const [[hoy]] = await db.query(`
      SELECT
        COUNT(*)                                              AS transacciones,
        COALESCE(SUM(cantidad), 0)                           AS unidades,
        COALESCE(SUM(cantidad * COALESCE(precio_unitario,0)),0) AS total_ars
      FROM ventas
      WHERE DATE(fecha) = CURDATE()
    `);

    const [[ayer]] = await db.query(`
      SELECT COALESCE(SUM(cantidad * COALESCE(precio_unitario,0)),0) AS total_ars
      FROM ventas
      WHERE DATE(fecha) = CURDATE() - INTERVAL 1 DAY
    `);

    const [[mayHoy]] = await db.query(`
      SELECT COALESCE(SUM(total_ars),0) AS total_ars
      FROM pedidos_mayoristas
      WHERE estado = 'confirmado' AND DATE(fecha_confirmacion) = CURDATE()
    `);

    const [[mayAyer]] = await db.query(`
      SELECT COALESCE(SUM(total_ars),0) AS total_ars
      FROM pedidos_mayoristas
      WHERE estado = 'confirmado' AND DATE(fecha_confirmacion) = CURDATE() - INTERVAL 1 DAY
    `);

    const totalHoy  = Number(hoy.total_ars)  + Number(mayHoy.total_ars);
    const totalAyer = Number(ayer.total_ars) + Number(mayAyer.total_ars);
    const variacion = totalAyer > 0 ? ((totalHoy - totalAyer) / totalAyer) * 100 : null;

    res.json({
      ventas_hoy:       totalHoy,
      ventas_ayer:      totalAyer,
      variacion_pct:    variacion !== null ? Math.round(variacion * 10) / 10 : null,
      unidades_hoy:     Number(hoy.unidades),
      transacciones_hoy: Number(hoy.transacciones),
    });
  } catch (error) {
    console.error("❌ Error kpis-hoy:", error);
    res.status(500).json({ error: "Error al obtener KPIs del día" });
  }
});

router.get("/ranking-productos-sucursal", authenticate, soloAdmin, async (req, res) => {
  const { mes, anio } = req.query;

  if (!mes || !anio) {
    return res.status(400).json({ error: "Faltan parámetros mes o año" });
  }

  try {
    const [rows] = await pool.promise().query(
      `
      SELECT
        s.nombre AS sucursal,
        p.nombre AS producto_nombre,
        g.nombre AS gusto,
        SUM(v.cantidad) AS total_vendido
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
      GROUP BY s.id, g.id
      ORDER BY s.nombre, total_vendido DESC;
    `,
      [mes, anio]
    );

    res.json(rows);
  } catch (error) {
    console.error("❌ Error al obtener ranking:", error);
    res.status(500).json({ error: "Error al obtener el ranking" });
  }
});

module.exports = router;

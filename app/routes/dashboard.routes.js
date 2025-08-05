const express = require("express");
const router = express.Router();
const pool = require("../db");

// Datos para el dashboard principal
router.get("/dashboard", async (req, res) => {
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
router.get("/resumen-ganancias", async (req, res) => {
  try {
    const [rows] = await pool.promise().query(`
    SELECT 
    s.nombre AS sucursal,
    SUM(v.cantidad * st.precio) AS total_ventas,
    SUM(v.cantidad * p.precio_costo) AS costo_total,
    SUM((v.cantidad * st.precio) - (v.cantidad * p.precio_costo)) AS ganancia
FROM ventas v
JOIN sucursales s ON v.sucursal_id = s.id
JOIN gustos g ON v.gusto_id = g.id
JOIN productos p ON g.producto_id = p.id
JOIN stock st ON v.gusto_id = st.gusto_id AND v.sucursal_id = st.sucursal_id
GROUP BY s.id;

    `);

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al obtener resumen de ganancias" });
  }
});
router.get("/resumen-ganancias-mensual", async (req, res) => {
  const { mes, anio } = req.query;

  if (!mes || !anio) {
    return res.status(400).json({ error: "Debe proporcionar mes y año" });
  }

  try {
    const [rows] = await pool.promise().query(
      `
      SELECT 
        s.nombre AS sucursal,
        SUM(v.cantidad * st.precio) AS total_ventas,
        SUM(v.cantidad * p.precio_costo) AS costo_total,
        SUM((v.cantidad * st.precio) - (v.cantidad * p.precio_costo)) AS ganancia
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN stock st ON v.gusto_id = st.gusto_id AND v.sucursal_id = st.sucursal_id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
      GROUP BY s.id;
    `,
      [mes, anio]
    );

    res.json(rows);
  } catch (error) {
    console.error("❌ Error al obtener resumen mensual:", error);
    res
      .status(500)
      .json({ error: "Error al obtener resumen mensual de ganancias" });
  }
});
router.get("/ranking-productos-sucursal", async (req, res) => {
  try {
    const [rows] = await pool.promise().query(`
      SELECT 
        s.nombre AS sucursal,
        p.nombre AS producto_nombre,
        g.nombre AS gusto,
        SUM(v.cantidad) AS total_vendido
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      GROUP BY v.sucursal_id, v.gusto_id
      ORDER BY s.nombre ASC, total_vendido DESC
    `);

    res.json(rows);
  } catch (error) {
    console.error("❌ Error en ranking por sucursal:", error);
    res.status(500).json({ error: "Error al obtener ranking" });
  }
});


module.exports = router;

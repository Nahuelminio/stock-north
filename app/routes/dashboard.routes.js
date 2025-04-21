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

module.exports = router;

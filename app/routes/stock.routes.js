const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

// Valor total del stock de la sucursal del usuario autenticado
// (ruta propia de sucursales — admin usa /valor-stock-por-sucursal en productos.routes)
router.get("/valor-stock-por-sucursal", authenticate, async (req, res) => {
  const { sucursalId } = req.user;

  try {
    const [results] = await pool.promise().query(
      `SELECT
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(st.cantidad * st.precio) AS valor_total
       FROM stock st
       JOIN sucursales s ON st.sucursal_id = s.id
       WHERE s.id = ?
       GROUP BY s.id, s.nombre`,
      [sucursalId]
    );

    res.json(results);
  } catch (error) {
    console.error("❌ Error al calcular valor de stock por sucursal:", error);
    res.status(500).json({ error: "Error al obtener valor de stock" });
  }
});

module.exports = router;

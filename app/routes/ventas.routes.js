const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

// 🔵 Vender producto (de su sucursal)
router.post("/vender", authenticate, async (req, res) => {
  const { gusto_id, cantidad, sucursal_id } = req.body;
  const { rol, sucursalId: sucursalIdDesdeToken } = req.user;

  // 💡 Determinar la sucursal final según el rol
  const sucursalIdFinal = rol === "admin" ? sucursal_id : sucursalIdDesdeToken;

  if (!gusto_id || !cantidad || !sucursalIdFinal) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  try {
    const [[stock]] = await pool
      .promise()
      .query(
        "SELECT cantidad FROM stock WHERE gusto_id = ? AND sucursal_id = ?",
        [gusto_id, sucursalIdFinal]
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
        [cantidad, gusto_id, sucursalIdFinal]
      );

    await pool
      .promise()
      .query(
        "INSERT INTO ventas (gusto_id, sucursal_id, cantidad, fecha) VALUES (?, ?, ?, NOW())",
        [gusto_id, sucursalIdFinal, cantidad]
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
        SUM(v.cantidad) AS total_ventas,
        SUM(v.cantidad * st.precio) AS total_facturado
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      JOIN gustos g ON v.gusto_id = g.id
      JOIN stock st ON st.gusto_id = g.id AND st.sucursal_id = v.sucursal_id
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

router.get("/historial", authenticate, async (req, res) => {
  const { sucursalId, rol } = req.user;
  const filtroSucursal = req.query.sucursal_id;

  try {
    let query = `
      SELECT 
        v.id,
        s.nombre AS sucursal,
        p.nombre AS producto,
        g.nombre AS gusto,
        v.cantidad,
        st.precio,
        v.fecha
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
      JOIN stock st ON st.gusto_id = g.id AND st.sucursal_id = v.sucursal_id
    `;

    const params = [];

    // Si no es admin, forzar su propia sucursal
    if (rol !== "admin") {
      query += " WHERE v.sucursal_id = ?";
      params.push(sucursalId);
    } else if (filtroSucursal) {
      query += " WHERE v.sucursal_id = ?";
      params.push(filtroSucursal);
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
        SUM(v.cantidad * st.precio) AS total_facturado
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN stock st ON st.gusto_id = g.id AND st.sucursal_id = v.sucursal_id
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);

    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener total de ventas por sucursal:", error);
    res.status(500).json({ error: "Error al obtener total de ventas" });
  }
});

// 🔵 Ventas mensuales por sucursal (solo admin)
router.get("/buscar-por-codigo/:codigo", async (req, res) => {
  const { codigo } = req.params;
  const { sucursal_id } = req.query;

  if (!codigo || !sucursal_id) {
    return res.status(400).json({ error: "Faltan parámetros" });
  }

  try {
    const [result] = await pool.promise().query(
      `SELECT 
        p.nombre AS producto_nombre,
        g.nombre AS gusto,
        g.id AS gusto_id,
        g.codigo_barra
      FROM gustos g
      JOIN productos p ON g.producto_id = p.id
      JOIN stock st ON st.gusto_id = g.id
      WHERE g.codigo_barra = ? AND st.sucursal_id = ?
      LIMIT 1`,
      [codigo, sucursal_id]
    );

    if (result.length === 0) {
      return res
        .status(404)
        .json({ error: "Producto no encontrado en esta sucursal" });
    }

    res.json(result[0]);
  } catch (error) {
    console.error("❌ Error al buscar producto por código:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

module.exports = router;

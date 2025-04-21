const express = require("express");
const router = express.Router();
const pool = require("../db");

// Obtener valor total del stock por sucursal
router.get("/valor-stock-por-sucursal", async (req, res) => {
  try {
    const [results] = await pool.promise().query(`
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(st.cantidad * p.precio) AS valor_total
      FROM stock st
      JOIN gustos g ON st.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON st.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);

    res.json(results);
  } catch (error) {
    console.error("❌ Error al calcular valor de stock por sucursal:", error);
    res.status(500).json({ error: "Error al obtener valor de stock" });
  }
});

// Reposición de stock (registro en historial)
router.post("/reposicion", async (req, res) => {
  const { gusto_id, sucursal_id, cantidad } = req.body;
  if (!gusto_id || !sucursal_id || !cantidad) {
    return res.status(400).json({ error: "Faltan datos para la reposición" });
  }
  try {
    await pool
      .promise()
      .query(
        "UPDATE stock SET cantidad = cantidad + ? WHERE gusto_id = ? AND sucursal_id = ?",
        [cantidad, gusto_id, sucursal_id]
      );

    await pool
      .promise()
      .query(
        "INSERT INTO reposiciones (gusto_id, sucursal_id, cantidad_repuesta, fecha) VALUES (?, ?, ?, NOW())",
        [gusto_id, sucursal_id, cantidad]
      );

    res.json({ mensaje: "Reposición registrada correctamente ✅" });
  } catch (error) {
    console.error("❌ Error al registrar reposición:", error);
    res.status(500).json({ error: "Error al registrar la reposición" });
  }
});

// Reposición rápida (sin historial)
router.post("/reposicion-rapida", async (req, res) => {
  const { gusto_id, sucursal_id, cantidad } = req.body;

  if (!gusto_id || !sucursal_id || !cantidad) {
    return res
      .status(400)
      .json({ error: "Faltan datos para la reposición rápida" });
  }

  try {
    const [existencia] = await pool
      .promise()
      .query("SELECT * FROM stock WHERE gusto_id = ? AND sucursal_id = ?", [
        gusto_id,
        sucursal_id,
      ]);

    if (existencia.length === 0) {
      await pool
        .promise()
        .query(
          "INSERT INTO stock (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)",
          [gusto_id, sucursal_id, cantidad]
        );
    } else {
      await pool
        .promise()
        .query(
          "UPDATE stock SET cantidad = cantidad + ? WHERE gusto_id = ? AND sucursal_id = ?",
          [cantidad, gusto_id, sucursal_id]
        );
    }

    res.json({ mensaje: "✅ Reposición rápida realizada" });
  } catch (error) {
    console.error("❌ Error en reposición rápida:", error);
    res.status(500).json({ error: "Error al realizar reposición rápida" });
  }
});

module.exports = router;

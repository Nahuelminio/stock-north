const express = require("express");
const router = express.Router();
const pool = require("../db");

// Editar gusto (nombre y código de barra)
router.post("/editar/:gusto_id", async (req, res) => {
  const { nuevoGusto, codigo_barra } = req.body;
  const { gusto_id } = req.params;

  if (!nuevoGusto && !codigo_barra) {
    return res.status(400).json({ error: "Faltan datos para editar gusto" });
  }

  try {
    await pool
      .promise()
      .query("UPDATE gustos SET nombre = ?, codigo_barra = ? WHERE id = ?", [
        nuevoGusto || null,
        codigo_barra || null,
        gusto_id,
      ]);

    res.json({ mensaje: "Gusto actualizado correctamente" });
  } catch (error) {
    console.error("❌ Error al editar gusto:", error);
    res.status(500).json({ error: "Error al editar gusto" });
  }
});

// Buscar producto por código de barras
router.get("/buscar-por-codigo/:codigo", async (req, res) => {
  const { codigo } = req.params;
  try {
    const [result] = await pool.promise().query(
      `SELECT 
        p.nombre AS producto_nombre,
        g.nombre AS gusto,
        g.id AS gusto_id,
        g.codigo_barra
      FROM gustos g
      JOIN productos p ON g.producto_id = p.id
      WHERE g.codigo_barra = ?
      LIMIT 1`,
      [codigo]
    );

    if (result.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    res.json(result[0]);
  } catch (error) {
    console.error("❌ Error al buscar producto por código:", error);
    res.status(500).json({ error: "Error al buscar producto por código" });
  }
});

module.exports = router;

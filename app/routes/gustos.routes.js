const express = require("express");
const router = express.Router();
const pool = require("../db");

// Editar gusto (nombre y código de barra)
router.post(
  "/editar/:gusto_id",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { stock, sucursal_id, nuevoGusto, precio, codigo_barra } = req.body;
    const { gusto_id } = req.params;

    console.log("📥 Body recibido en edición:", req.body);
    console.log("🆔 gusto_id recibido:", gusto_id);

    if (
      stock === undefined ||
      precio === undefined ||
      !sucursal_id ||
      !nuevoGusto
    ) {
      return res.status(400).json({
        error:
          "Faltan datos obligatorios (stock, precio, sucursal_id, nuevoGusto)",
      });
    }

    try {
      if (codigo_barra) {
        const [existe] = await pool.promise().query(
          `SELECT g.id FROM gustos g
           JOIN stock st ON st.gusto_id = g.id
           WHERE g.codigo_barra = ? AND st.sucursal_id = ? AND g.id != ?`,
          [codigo_barra, sucursal_id, gusto_id]
        );
        if (existe.length > 0) {
          return res.status(400).json({
            error: "Este código de barras ya existe en esta sucursal",
          });
        }
      }

      await pool
        .promise()
        .query("UPDATE gustos SET nombre = ?, codigo_barra = ? WHERE id = ?", [
          nuevoGusto,
          codigo_barra || null,
          gusto_id,
        ]);

      await pool
        .promise()
        .query(
          "UPDATE stock SET cantidad = ?, precio = ? WHERE gusto_id = ? AND sucursal_id = ?",
          [stock, precio, gusto_id, sucursal_id]
        );

      if (codigo_barra) {
        const [[gustoInfo]] = await pool
          .promise()
          .query("SELECT producto_id, nombre FROM gustos WHERE id = ?", [
            gusto_id,
          ]);

        if (gustoInfo) {
          const [codigoExistenteGlobal] = await pool
            .promise()
            .query("SELECT id FROM gustos WHERE codigo_barra = ? AND id != ?", [
              codigo_barra,
              gusto_id,
            ]);

          if (codigoExistenteGlobal.length > 0) {
            return res.status(400).json({
              error: "Este código de barras ya está asignado a otro gusto",
            });
          }

          await pool.promise().query(
            `UPDATE gustos 
               SET codigo_barra = ? 
               WHERE producto_id = ? AND nombre = ? AND id = ?`,
            [codigo_barra, gustoInfo.producto_id, gustoInfo.nombre, gusto_id]
          );
        }
      }

      res.json({ mensaje: "Producto actualizado correctamente ✅" });
    } catch (error) {
      console.error("❌ Error al editar producto:", error.message, error.stack);
      res.status(500).json({ error: "Error al editar producto" });
    }
  }
);


// Buscar producto por código de barras
router.get("/buscar-por-codigo/:codigo", async (req, res) => {
  const { codigo } = req.params;
  const { sucursal_id } = req.query;

  if (!sucursal_id) {
    return res.status(400).json({ error: "Falta sucursal_id" });
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
      WHERE g.codigo_barra = ? AND st.sucursal_id = ? AND g.activo = 1
      LIMIT 1`,
      [codigo, sucursal_id]
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

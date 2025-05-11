const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");
const { upsertStock } = require("../controllers/stockHelpers");

// 🔵 Reposición (con historial)
router.post("/reposicion", authenticate, async (req, res) => {
  const { gusto_id, cantidad, sucursal_id } = req.body;

  if (req.user.rol !== "admin") {
    return res.status(403).json({
      error: "Acceso denegado: solo admin puede registrar reposiciones",
    });
  }

  if (!gusto_id || !cantidad || !sucursal_id) {
    return res.status(400).json({
      error:
        "Faltan datos para la reposición (gusto_id, cantidad, sucursal_id son obligatorios)",
    });
  }

  try {
    await upsertStock(
      parseInt(gusto_id),
      parseInt(sucursal_id),
      parseInt(cantidad)
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

// 🔵 Reposición rápida (sin historial)
router.post("/reposicion-rapida", authenticate, async (req, res) => {
  const { gusto_id, sucursal_id, cantidad } = req.body;

  if (!gusto_id || !sucursal_id || !cantidad) {
    return res
      .status(400)
      .json({ error: "Faltan datos para la reposición rápida" });
  }

  try {
    await upsertStock(
      parseInt(gusto_id),
      parseInt(sucursal_id),
      parseInt(cantidad)
    );
    res.json({ mensaje: "✅ Reposición rápida realizada" });
  } catch (error) {
    console.error("❌ Error en reposición rápida:", error);
    res.status(500).json({ error: "Error al realizar reposición rápida" });
  }
});

// 🔵 Reposición por código de barras
router.post("/reposicion-por-codigo", authenticate, async (req, res) => {
  const { codigo_barra, sucursal_id, cantidad } = req.body;

  if (!codigo_barra || !sucursal_id || !cantidad) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    const [[producto]] = await pool
      .promise()
      .query(
        `SELECT g.id AS gusto_id FROM gustos g WHERE g.codigo_barra = ? LIMIT 1`,
        [codigo_barra]
      );

    if (!producto) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const gusto_id = producto.gusto_id;

    await upsertStock(gusto_id, parseInt(sucursal_id), parseInt(cantidad));

    await pool
      .promise()
      .query(
        "INSERT INTO reposiciones (gusto_id, sucursal_id, cantidad_repuesta, fecha) VALUES (?, ?, ?, NOW())",
        [gusto_id, sucursal_id, cantidad]
      );

    res.json({ mensaje: "Reposición registrada por código ✅" });
  } catch (error) {
    console.error("❌ Error al registrar reposición por código:", error);
    res.status(500).json({ error: "Error al registrar reposición" });
  }
});

// 🔵 Listar gustos y stock por producto
router.get(
  "/gustos/por-producto/:producto_id",
  authenticate,
  async (req, res) => {
    const { producto_id } = req.params;

    try {
      const [rows] = await pool.promise().query(
        `SELECT 
        g.id AS gusto_id,
        g.nombre AS gusto,
        g.codigo_barra,
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        st.cantidad,
        st.precio
      FROM gustos g
      JOIN stock st ON st.gusto_id = g.id
      JOIN sucursales s ON s.id = st.sucursal_id
      WHERE g.producto_id = ?
      ORDER BY g.nombre, s.nombre`,
        [producto_id]
      );

      res.json(rows);
    } catch (error) {
      console.error("❌ Error al obtener gustos por producto:", error);
      res.status(500).json({ error: "Error al obtener gustos por producto" });
    }
  }
);

// 🔵 Actualizar precio y stock por gusto (masivo por producto)
router.post("/actualizar-stock-precio", authenticate, async (req, res) => {
  const { actualizaciones } = req.body;

  if (!Array.isArray(actualizaciones)) {
    return res
      .status(400)
      .json({ error: "Formato inválido. Se espera un array." });
  }

  console.log("📦 Datos recibidos en actualización masiva:", actualizaciones);

  try {
    for (const item of actualizaciones) {
      const { gusto_id, sucursal_id, cantidad, precio, codigo_barra } = item;

      if (codigo_barra && codigo_barra.trim() !== "") {
        const [repetido] = await pool.promise().query(
          `SELECT g.id FROM gustos g
           JOIN stock st ON st.gusto_id = g.id
           WHERE g.codigo_barra = ? AND st.sucursal_id = ? AND g.id != ?`,
          [codigo_barra, sucursal_id, gusto_id]
        );

        if (repetido.length > 0) {
          return res.status(400).json({
            error: `El código de barras ${codigo_barra} ya está usado en esta sucursal`,
          });
        }

        const [[gustoInfo]] = await pool
          .promise()
          .query("SELECT producto_id, nombre FROM gustos WHERE id = ?", [
            gusto_id,
          ]);

        if (gustoInfo) {
          await pool.promise().query(
            `UPDATE gustos 
             SET codigo_barra = ? 
             WHERE producto_id = ? AND nombre = ?`,
            [codigo_barra, gustoInfo.producto_id, gustoInfo.nombre]
          );
        }
      }

      await pool
        .promise()
        .query(
          "UPDATE stock SET cantidad = ?, precio = ? WHERE gusto_id = ? AND sucursal_id = ?",
          [cantidad, precio, gusto_id, sucursal_id]
        );
    }

    res.json({ mensaje: "Actualización masiva realizada con éxito ✅" });
  } catch (error) {
    console.error("❌ Error en actualización masiva:", error.message);
    console.error(error.stack);
    res.status(500).json({ error: "Error al actualizar stock/precio" });
  }
});


module.exports = router;

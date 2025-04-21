const express = require("express");
const router = express.Router();
const pool = require("../db");

// Registrar una reposición normal
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

// Reposición rápida sin historial
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

// Reposición por código de barras
router.post("/reposicion-por-codigo", async (req, res) => {
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

    const [[stock]] = await pool
      .promise()
      .query("SELECT * FROM stock WHERE gusto_id = ? AND sucursal_id = ?", [
        gusto_id,
        sucursal_id,
      ]);

    if (!stock) {
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

// Historial de reposiciones con filtros
router.get("/historial-reposiciones", async (req, res) => {
  const { producto, gusto, sucursal_id, fecha_inicio, fecha_fin } = req.query;

  try {
    let query = `
      SELECT 
        r.id,
        r.fecha,
        s.nombre AS sucursal,
        p.nombre AS producto,
        g.nombre AS gusto,
        r.cantidad_repuesta AS cantidad
      FROM reposiciones r
      JOIN gustos g ON r.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON r.sucursal_id = s.id
      WHERE 1 = 1
    `;

    const params = [];

    if (sucursal_id) {
      query += " AND s.id = ?";
      params.push(sucursal_id);
    }

    if (producto) {
      query += " AND p.nombre LIKE ?";
      params.push(`%${producto}%`);
    }

    if (gusto) {
      query += " AND g.nombre LIKE ?";
      params.push(`%${gusto}%`);
    }

    if (fecha_inicio && fecha_fin) {
      query += " AND DATE(r.fecha) BETWEEN ? AND ?";
      params.push(fecha_inicio, fecha_fin);
    } else if (fecha_inicio) {
      query += " AND DATE(r.fecha) >= ?";
      params.push(fecha_inicio);
    } else if (fecha_fin) {
      query += " AND DATE(r.fecha) <= ?";
      params.push(fecha_fin);
    }

    query += " ORDER BY r.fecha DESC";

    const [results] = await pool.promise().query(query, params);
    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener historial de reposiciones:", error);
    res
      .status(500)
      .json({ error: "Error al obtener historial de reposiciones" });
  }
});

module.exports = router;

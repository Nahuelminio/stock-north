const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

// 🔵 Registrar reposición (historial incluido)
router.post("/reposicion", authenticate, async (req, res) => {
  const { gusto_id, cantidad, sucursal_id } = req.body;

  console.log("➡️ req.user:", req.user);
  console.log("📦 Body recibido:", req.body);

  // 🔒 Solo permitir al admin
  if (req.user.rol !== "admin") {
    return res.status(403).json({
      error: "Acceso denegado: solo admin puede registrar reposiciones",
    });
  }

  // ✅ Validamos que llegue sucursal_id, gusto_id y cantidad, todos numéricos y no vacíos
  if (
    gusto_id === undefined ||
    cantidad === undefined ||
    sucursal_id === undefined ||
    gusto_id === "" ||
    cantidad === "" ||
    sucursal_id === "" ||
    isNaN(gusto_id) ||
    isNaN(cantidad) ||
    isNaN(sucursal_id)
  ) {
    return res.status(400).json({
      error:
        "Faltan datos válidos: gusto_id, cantidad y sucursal_id deben ser numéricos y no vacíos",
    });
  }

  // 🔢 Convertimos a números seguros
  const gustoIdNum = parseInt(gusto_id);
  const cantidadNum = parseInt(cantidad);
  const sucursalIdNum = parseInt(sucursal_id);

  try {
    // Chequear si ya existe ese stock
    const [stockExistente] = await pool
      .promise()
      .query("SELECT * FROM stock WHERE gusto_id = ? AND sucursal_id = ?", [
        gustoIdNum,
        sucursalIdNum,
      ]);

    if (stockExistente.length === 0) {
      // No existe, lo creamos con precio 0 por defecto
      await pool
        .promise()
        .query(
          "INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio) VALUES (?, ?, ?, ?)",
          [gustoIdNum, sucursalIdNum, cantidadNum, 0]
        );
    } else {
      // Ya existe, actualizamos la cantidad
      await pool
        .promise()
        .query(
          "UPDATE stock SET cantidad = cantidad + ? WHERE gusto_id = ? AND sucursal_id = ?",
          [cantidadNum, gustoIdNum, sucursalIdNum]
        );
    }

    // Registramos en el historial
    await pool
      .promise()
      .query(
        "INSERT INTO reposiciones (gusto_id, sucursal_id, cantidad_repuesta, fecha) VALUES (?, ?, ?, NOW())",
        [gustoIdNum, sucursalIdNum, cantidadNum]
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

  console.log("👉 Datos recibidos en /reposicion-rapida:", {
    gusto_id,
    sucursal_id,
    cantidad,
  });

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
          "INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio) VALUES (?, ?, ?, ?)",
          [gusto_id, sucursal_id, cantidad, 0]
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

// 🔵 Reposición por código de barras
router.post("/reposicion-por-codigo", authenticate, async (req, res) => {
  const { codigo_barra, sucursal_id, cantidad } = req.body;

  console.log("👉 Datos recibidos en /reposicion-por-codigo:", {
    codigo_barra,
    sucursal_id,
    cantidad,
  });

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
          "INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio) VALUES (?, ?, ?, ?)",
          [gusto_id, sucursal_id, cantidad, 0]
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

// 🔵 Historial de reposiciones con filtros
router.get("/historial-reposiciones", authenticate, async (req, res) => {
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

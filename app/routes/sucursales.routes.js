const express = require("express");
const router = express.Router();
const authenticate = require("../middlewares/authenticate");
const cors = require("cors");
const publicCors = cors({ origin: "*", credentials: false });

const pool = require("../db");
// GET /sucursales-publico  -> [{id, nombre}]


// GET /sucursales — requiere autenticación
router.get("/", authenticate, async (req, res) => {
  try {
    const [results] = await pool.promise().query("SELECT * FROM sucursales WHERE activo = 1 ORDER BY nombre");
    res.json(results);
  } catch (err) {
    console.error("❌ Error al obtener sucursales:", err);
    res.status(500).json({ error: "Error al obtener sucursales" });
  }
});

// POST /sucursales — solo admin
router.post("/", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") {
    return res.status(403).json({ error: "Acceso denegado: solo administradores" });
  }
  const { nombre } = req.body;
  if (!nombre) {
    return res.status(400).json({ error: "Falta el nombre de la sucursal" });
  }
  try {
    const [result] = await pool
      .promise()
      .query("INSERT INTO sucursales (nombre) VALUES (?)", [nombre]);
    res.json({ mensaje: "Sucursal creada", id: result.insertId });
  } catch (error) {
    console.error("❌ Error al crear sucursal:", error);
    res.status(500).json({ error: "No se pudo crear la sucursal" });
  }
});

// ✅ GET /sucursales/:id
router.get("/:id", authenticate, async (req, res) => {
  try {
    const [result] = await pool
      .promise()
      .query("SELECT id, nombre FROM sucursales WHERE id = ?", [req.params.id]);

    if (result.length === 0) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    res.json(result[0]);
  } catch (err) {
    console.error("❌ Error al obtener la sucursal:", err);
    res.status(500).json({ error: "Error al obtener la sucursal" });
  }
});


// PATCH /sucursales/:id — actualizar nombre y/o teléfono
router.patch("/:id", authenticate, async (req, res) => {
  const { nombre, telefono } = req.body;
  if (req.user?.rol !== "admin")
    return res.status(403).json({ error: "Solo administradores" });

  // Solo se toca lo que viene en el body. Antes el teléfono se escribía siempre,
  // así que renombrar una sucursal le borraba el número de los remitos.
  const campos = [];
  const valores = [];
  if (nombre !== undefined) {
    if (!String(nombre).trim()) {
      return res.status(400).json({ error: "El nombre no puede quedar vacío" });
    }
    campos.push("nombre = ?");
    valores.push(String(nombre).trim());
  }
  if (telefono !== undefined) {
    campos.push("telefono = ?");
    valores.push(telefono || null);
  }
  if (!campos.length) return res.status(400).json({ error: "No hay nada para cambiar" });

  try {
    await pool.promise().query(
      `UPDATE sucursales SET ${campos.join(", ")} WHERE id = ?`,
      [...valores, req.params.id]
    );
    const [[s]] = await pool.promise().query("SELECT * FROM sucursales WHERE id = ?", [req.params.id]);
    res.json(s);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar sucursal" });
  }
});

module.exports = router;

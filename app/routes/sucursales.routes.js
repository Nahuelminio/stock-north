const express = require("express");
const router = express.Router();
const authenticate = require("../middlewares/authenticate");
const cors = require("cors");
const publicCors = cors({ origin: "*", credentials: false });

const pool = require("../db");
// GET /sucursales-publico  -> [{id, nombre}]


// GET /sucursales
router.get("/", async (req, res) => {
  try {
    const [results] = await pool.promise().query("SELECT * FROM sucursales");
    res.json(results);
  } catch (err) {
    console.error("❌ Error al obtener sucursales:", err);
    res.status(500).json({ error: "Error al obtener sucursales" });
  }
});

// POST /sucursales
router.post("/", async (req, res) => {
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
  try {
    await pool.promise().query(
      "UPDATE sucursales SET nombre = COALESCE(?, nombre), telefono = ? WHERE id = ?",
      [nombre || null, telefono || null, req.params.id]
    );
    const [[s]] = await pool.promise().query("SELECT * FROM sucursales WHERE id = ?", [req.params.id]);
    res.json(s);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al actualizar sucursal" });
  }
});

module.exports = router;

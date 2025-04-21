// routes/sucursales.routes.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// Obtener todas las sucursales
router.get("/", async (req, res) => {
  try {
    const [results] = await pool.promise().query("SELECT * FROM sucursales");
    res.json(results);
  } catch (err) {
    console.error("❌ Error al obtener sucursales:", err);
    res.status(500).json({ error: "Error al obtener sucursales" });
  }
});

// Crear nueva sucursal
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

module.exports = router;

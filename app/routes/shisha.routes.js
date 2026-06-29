const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

const COSTO_USD = { tabaco: 4 / 3, carbones: 0.2 * 2, papel: 0.13 };
const COSTO_TOTAL_USD = COSTO_USD.tabaco + COSTO_USD.carbones + COSTO_USD.papel;

// GET config e insumos
router.get("/shisha/config", authenticate, async (req, res) => {
  const [rows] = await pool.promise().query("SELECT * FROM shisha_insumos LIMIT 1");
  res.json(rows[0]);
});

// PUT actualizar config (precio dolar, precios venta)
router.put("/shisha/config", authenticate, async (req, res) => {
  const { precio_dolar, precio_nueva, precio_recarga } = req.body;
  await pool.promise().query(
    "UPDATE shisha_insumos SET precio_dolar = ?, precio_nueva = ?, precio_recarga = ?",
    [precio_dolar, precio_nueva, precio_recarga]
  );
  res.json({ ok: true });
});

// PUT cargar insumos (suma a lo existente)
router.put("/shisha/insumos", authenticate, async (req, res) => {
  const { tabaco_paquetes, carbones, papeles } = req.body;
  await pool.promise().query(
    "UPDATE shisha_insumos SET tabaco_paquetes = tabaco_paquetes + ?, carbones = carbones + ?, papeles = papeles + ?",
    [tabaco_paquetes || 0, carbones || 0, papeles || 0]
  );
  const [rows] = await pool.promise().query("SELECT * FROM shisha_insumos LIMIT 1");
  res.json(rows[0]);
});

// POST registrar alquiler
router.post("/shisha/alquiler", authenticate, async (req, res) => {
  const { tipo } = req.body; // 'nueva' o 'recarga'

  const [rows] = await pool.promise().query("SELECT * FROM shisha_insumos LIMIT 1");
  const config = rows[0];

  // Verificar stock
  if (config.tabaco_paquetes < 1 / 3) return res.status(400).json({ error: "Sin stock de tabaco" });
  if (config.carbones < 2) return res.status(400).json({ error: "Sin stock de carbones" });
  if (config.papeles < 1) return res.status(400).json({ error: "Sin stock de papel aluminio" });

  const precio_venta = tipo === "nueva" ? config.precio_nueva : config.precio_recarga;
  const costo_usd = COSTO_TOTAL_USD;
  const costo_pesos = costo_usd * config.precio_dolar;
  const ganancia = precio_venta - costo_pesos;

  // Descontar insumos
  await pool.promise().query(
    "UPDATE shisha_insumos SET tabaco_paquetes = tabaco_paquetes - ?, carbones = carbones - 2, papeles = papeles - 1",
    [1 / 3]
  );

  // Registrar venta
  await pool.promise().query(
    "INSERT INTO shisha_ventas (tipo, precio_venta, costo_usd, precio_dolar, costo_pesos, ganancia) VALUES (?,?,?,?,?,?)",
    [tipo, precio_venta, costo_usd, config.precio_dolar, costo_pesos, ganancia]
  );

  const [insumos] = await pool.promise().query("SELECT * FROM shisha_insumos LIMIT 1");
  res.json({ ok: true, insumos: insumos[0], ganancia, costo_pesos });
});

// GET historial ventas
router.get("/shisha/ventas", authenticate, async (req, res) => {
  const { desde, hasta } = req.query;
  let query = "SELECT * FROM shisha_ventas";
  const params = [];
  if (desde && hasta) {
    query += " WHERE DATE(created_at) BETWEEN ? AND ?";
    params.push(desde, hasta);
  }
  query += " ORDER BY created_at DESC";
  const [rows] = await pool.promise().query(query, params);

  const totales = rows.reduce((acc, v) => ({
    recaudado: acc.recaudado + v.precio_venta,
    costos: acc.costos + Number(v.costo_pesos),
    ganancia: acc.ganancia + Number(v.ganancia),
  }), { recaudado: 0, costos: 0, ganancia: 0 });

  res.json({ ventas: rows, totales });
});

module.exports = router;

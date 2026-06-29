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

// PUT actualizar config
router.put("/shisha/config", authenticate, async (req, res) => {
  const { precio_dolar, precio_nueva, precio_recarga } = req.body;
  await pool.promise().query(
    "UPDATE shisha_insumos SET precio_dolar = ?, precio_nueva = ?, precio_recarga = ?",
    [precio_dolar, precio_nueva, precio_recarga]
  );
  res.json({ ok: true });
});

// PUT cargar insumos generales (carbones y papeles)
router.put("/shisha/insumos", authenticate, async (req, res) => {
  const { carbones, papeles } = req.body;
  await pool.promise().query(
    "UPDATE shisha_insumos SET carbones = carbones + ?, papeles = papeles + ?",
    [carbones || 0, papeles || 0]
  );
  const [rows] = await pool.promise().query("SELECT * FROM shisha_insumos LIMIT 1");
  res.json(rows[0]);
});

// ── SABORES ──

// GET todos los sabores
router.get("/shisha/sabores", authenticate, async (req, res) => {
  const [rows] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json(rows);
});

// POST crear sabor
router.post("/shisha/sabores", authenticate, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta el nombre" });
  await pool.promise().query("INSERT INTO shisha_sabores (nombre) VALUES (?)", [nombre]);
  const [rows] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json(rows);
});

// PUT cargar stock de tabaco por sabor
router.put("/shisha/sabores/:id/stock", authenticate, async (req, res) => {
  const { paquetes } = req.body;
  await pool.promise().query(
    "UPDATE shisha_sabores SET stock_paquetes = stock_paquetes + ? WHERE id = ?",
    [paquetes || 0, req.params.id]
  );
  const [rows] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json(rows);
});

// PUT activar/desactivar sabor
router.put("/shisha/sabores/:id/toggle", authenticate, async (req, res) => {
  await pool.promise().query(
    "UPDATE shisha_sabores SET activo = NOT activo WHERE id = ?",
    [req.params.id]
  );
  const [rows] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json(rows);
});

// POST registrar alquiler
router.post("/shisha/alquiler", authenticate, async (req, res) => {
  const { tipo, sabor_id } = req.body;

  const [configRows] = await pool.promise().query("SELECT * FROM shisha_insumos LIMIT 1");
  const config = configRows[0];

  // Verificar insumos generales
  if (config.carbones < 2) return res.status(400).json({ error: "Sin stock de carbones" });
  if (config.papeles < 1) return res.status(400).json({ error: "Sin stock de papel aluminio" });

  // Verificar sabor
  if (!sabor_id) return res.status(400).json({ error: "Seleccioná un sabor" });
  const [saborRows] = await pool.promise().query("SELECT * FROM shisha_sabores WHERE id = ? AND activo = 1", [sabor_id]);
  const sabor = saborRows[0];
  if (!sabor) return res.status(400).json({ error: "Sabor no encontrado" });
  if (sabor.stock_paquetes < 1 / 3) return res.status(400).json({ error: `Sin stock de tabaco (${sabor.nombre})` });

  const precio_venta = tipo === "nueva" ? config.precio_nueva : config.precio_recarga;
  const costo_usd = COSTO_TOTAL_USD;
  const costo_pesos = costo_usd * config.precio_dolar;
  const ganancia = precio_venta - costo_pesos;

  // Descontar insumos
  await pool.promise().query(
    "UPDATE shisha_insumos SET carbones = carbones - 2, papeles = papeles - 1",
    []
  );
  await pool.promise().query(
    "UPDATE shisha_sabores SET stock_paquetes = stock_paquetes - ? WHERE id = ?",
    [1 / 3, sabor_id]
  );

  // Registrar venta
  await pool.promise().query(
    "INSERT INTO shisha_ventas (tipo, precio_venta, costo_usd, precio_dolar, costo_pesos, ganancia, sabor_id, sabor_nombre) VALUES (?,?,?,?,?,?,?,?)",
    [tipo, precio_venta, costo_usd, config.precio_dolar, costo_pesos, ganancia, sabor_id, sabor.nombre]
  );

  const [insumos] = await pool.promise().query("SELECT * FROM shisha_insumos LIMIT 1");
  const [sabores] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json({ ok: true, insumos: insumos[0], sabores, ganancia, costo_pesos });
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

  // Ranking de sabores
  const ranking = rows.reduce((acc, v) => {
    if (!v.sabor_nombre) return acc;
    acc[v.sabor_nombre] = (acc[v.sabor_nombre] || 0) + 1;
    return acc;
  }, {});

  res.json({ ventas: rows, totales, ranking });
});

module.exports = router;

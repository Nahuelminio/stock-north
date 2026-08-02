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

// PUT cargar insumos generales
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

router.get("/shisha/sabores", authenticate, async (req, res) => {
  const [rows] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json(rows);
});

router.post("/shisha/sabores", authenticate, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: "Falta el nombre" });
  await pool.promise().query("INSERT INTO shisha_sabores (nombre) VALUES (?)", [nombre]);
  const [rows] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json(rows);
});

router.put("/shisha/sabores/:id/stock", authenticate, async (req, res) => {
  const { paquetes } = req.body;
  await pool.promise().query(
    "UPDATE shisha_sabores SET stock_paquetes = stock_paquetes + ? WHERE id = ?",
    [paquetes || 0, req.params.id]
  );
  const [rows] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json(rows);
});

router.put("/shisha/sabores/:id/toggle", authenticate, async (req, res) => {
  await pool.promise().query("UPDATE shisha_sabores SET activo = NOT activo WHERE id = ?", [req.params.id]);
  const [rows] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json(rows);
});

// ── ALQUILER ──

router.post("/shisha/alquiler", authenticate, async (req, res) => {
  const { tipo, sabor_id, nota } = req.body;

  const [configRows] = await pool.promise().query("SELECT * FROM shisha_insumos LIMIT 1");
  const config = configRows[0];

  if (config.carbones < 2) return res.status(400).json({ error: "Sin stock de carbones" });
  if (config.papeles < 1) return res.status(400).json({ error: "Sin stock de papel aluminio" });
  if (!sabor_id) return res.status(400).json({ error: "Seleccioná un sabor" });

  const [saborRows] = await pool.promise().query("SELECT * FROM shisha_sabores WHERE id = ? AND activo = 1", [sabor_id]);
  const sabor = saborRows[0];
  if (!sabor) return res.status(400).json({ error: "Sabor no encontrado" });
  if (sabor.stock_paquetes < 1 / 3) return res.status(400).json({ error: `Sin stock de tabaco (${sabor.nombre})` });

  const precio_venta = tipo === "nueva" ? config.precio_nueva : config.precio_recarga;
  const costo_usd = COSTO_TOTAL_USD;
  const costo_pesos = costo_usd * config.precio_dolar;
  const ganancia = precio_venta - costo_pesos;

  await pool.promise().query("UPDATE shisha_insumos SET carbones = carbones - 2, papeles = papeles - 1");
  await pool.promise().query(
    "UPDATE shisha_sabores SET stock_paquetes = stock_paquetes - ? WHERE id = ?",
    [1 / 3, sabor_id]
  );

  await pool.promise().query(
    "INSERT INTO shisha_ventas (tipo, precio_venta, costo_usd, precio_dolar, costo_pesos, ganancia, sabor_id, sabor_nombre, nota) VALUES (?,?,?,?,?,?,?,?,?)",
    [tipo, precio_venta, costo_usd, config.precio_dolar, costo_pesos, ganancia, sabor_id, sabor.nombre, nota || null]
  );

  const [insumos] = await pool.promise().query("SELECT * FROM shisha_insumos LIMIT 1");
  const [sabores] = await pool.promise().query("SELECT * FROM shisha_sabores ORDER BY nombre ASC");
  res.json({ ok: true, insumos: insumos[0], sabores, ganancia, costo_pesos });
});

// PUT anular venta (devuelve insumos al stock)
router.put("/shisha/ventas/:id/anular", authenticate, async (req, res) => {
  const [rows] = await pool.promise().query("SELECT * FROM shisha_ventas WHERE id = ? AND anulada = 0", [req.params.id]);
  const venta = rows[0];
  if (!venta) return res.status(404).json({ error: "Venta no encontrada o ya anulada" });

  await pool.promise().query("UPDATE shisha_ventas SET anulada = 1 WHERE id = ?", [req.params.id]);

  // Devolver insumos
  await pool.promise().query("UPDATE shisha_insumos SET carbones = carbones + 2, papeles = papeles + 1");
  if (venta.sabor_id) {
    await pool.promise().query(
      "UPDATE shisha_sabores SET stock_paquetes = stock_paquetes + ? WHERE id = ?",
      [1 / 3, venta.sabor_id]
    );
  }

  res.json({ ok: true });
});

// GET historial ventas
router.get("/shisha/ventas", authenticate, async (req, res) => {
  const { desde, hasta } = req.query;
  let query = "SELECT * FROM shisha_ventas WHERE anulada = 0";
  const params = [];
  if (desde && hasta) {
    query += " AND DATE(created_at) BETWEEN ? AND ?";
    params.push(desde, hasta);
  }
  query += " ORDER BY created_at DESC";
  const [rows] = await pool.promise().query(query, params);

  const totales = rows.reduce((acc, v) => ({
    recaudado: acc.recaudado + v.precio_venta,
    costos: acc.costos + Number(v.costo_pesos),
    ganancia: acc.ganancia + Number(v.ganancia),
  }), { recaudado: 0, costos: 0, ganancia: 0 });

  const ranking = rows.reduce((acc, v) => {
    if (!v.sabor_nombre) return acc;
    acc[v.sabor_nombre] = (acc[v.sabor_nombre] || 0) + 1;
    return acc;
  }, {});

  res.json({ ventas: rows, totales, ranking });
});

// GET resumen mensual (mes actual vs mes anterior)
router.get("/shisha/resumen", authenticate, async (req, res) => {
  const [actual] = await pool.promise().query(`
    SELECT COUNT(*) as cantidad, COALESCE(SUM(precio_venta),0) as recaudado, COALESCE(SUM(ganancia),0) as ganancia
    FROM shisha_ventas WHERE anulada = 0 AND MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())
  `);
  const [anterior] = await pool.promise().query(`
    SELECT COUNT(*) as cantidad, COALESCE(SUM(precio_venta),0) as recaudado, COALESCE(SUM(ganancia),0) as ganancia
    FROM shisha_ventas WHERE anulada = 0 AND MONTH(created_at) = MONTH(NOW() - INTERVAL 1 MONTH) AND YEAR(created_at) = YEAR(NOW() - INTERVAL 1 MONTH)
  `);
  const [saborTop] = await pool.promise().query(`
    SELECT sabor_nombre, COUNT(*) as total FROM shisha_ventas
    WHERE anulada = 0 AND sabor_nombre IS NOT NULL
    GROUP BY sabor_nombre ORDER BY total DESC LIMIT 5
  `);

  res.json({ actual: actual[0], anterior: anterior[0], saborTop });
});

// GET cuenta shisha: el capital se recupera 100%, después se reparte 50/50.
//
// Trato con Fagu: él vende, cobra el 100% de cada shisha y se lo va pagando al
// dueño. Se separan dos cosas que antes iban juntas:
//
//   CAPITAL (shishas, quemadores, pinzas) — se compra una vez. Es el techo a
//     recuperar. Solo baja, nunca sube.
//   INSUMOS (tabaco, carbón, aluminio) — se consumen en cada shisha. El costo
//     de cada venta vuelve al dueño en esa misma venta, porque él lo repuso.
//
// Antes todo sumaba al techo, y como el tabaco se repone cada dos meses el
// techo subía más rápido de lo que las ventas lo bajaban: el 50/50 no llegaba
// nunca. Ahora lo que recupera el capital es el MARGEN (venta − insumo), y el
// reparto arranca cuando ese margen acumulado cubre el capital.
router.get("/shisha/cuenta", authenticate, async (req, res) => {
  const [[totales]] = await pool.promise().query(`
    SELECT
      COALESCE(SUM(precio_venta), 0) AS total_shisha,
      COALESCE(SUM(costo_pesos), 0)  AS total_insumos_consumidos,
      COALESCE(SUM(ganancia), 0)     AS margen_acumulado
    FROM shisha_ventas WHERE anulada = 0
  `);
  const [[pagado]] = await pool.promise().query(`
    SELECT COALESCE(SUM(monto), 0) AS total_pagado FROM shisha_pagos
  `);
  const [[invertido]] = await pool.promise().query(`
    SELECT
      COALESCE(SUM(monto), 0) AS total_invertido,
      COALESCE(SUM(CASE WHEN tipo = 'capital' THEN monto ELSE 0 END), 0) AS total_capital,
      COALESCE(SUM(CASE WHEN tipo = 'insumo'  THEN monto ELSE 0 END), 0) AS total_insumos_comprados
    FROM shisha_inversiones
  `);
  const [historial] = await pool.promise().query(`
    SELECT id, monto, metodo, fecha, notas
    FROM shisha_pagos ORDER BY fecha DESC LIMIT 30
  `);
  const [inversiones] = await pool.promise().query(`
    SELECT id, monto, tipo, descripcion, fecha
    FROM shisha_inversiones ORDER BY fecha DESC, id DESC
  `);

  const total_shisha = Number(totales.total_shisha);
  const insumos_consumidos = Number(totales.total_insumos_consumidos);
  const margen = Number(totales.margen_acumulado);
  const total_pagado = Number(pagado.total_pagado);
  const total_invertido = Number(invertido.total_invertido);
  const total_capital = Number(invertido.total_capital);
  const insumos_comprados = Number(invertido.total_insumos_comprados);

  // Sin capital cargado no hay nada que cubrir: todo sigue siendo 100% deuda.
  const capital_recuperado = total_capital > 0 ? Math.min(margen, total_capital) : margen;
  const excedente = total_capital > 0 ? Math.max(0, margen - total_capital) : 0;
  const etapa = total_capital > 0 && margen >= total_capital ? "reparto" : "recupero";

  // Deuda de cada venta: siempre le corresponde al dueño el insumo que repuso.
  // Del margen, todo mientras se recupera el capital; la mitad una vez cubierto.
  const deuda_generada = insumos_consumidos + capital_recuperado + excedente * 0.5;
  const ganancia_tuya = excedente * 0.5;

  const base = {
    total_shisha,
    total_pagado,
    total_invertido,
    total_capital,
    insumos_comprados,
    insumos_consumidos: Number(insumos_consumidos.toFixed(2)),
    margen: Number(margen.toFixed(2)),
    capital_recuperado: Number(capital_recuperado.toFixed(2)),
    etapa, // "recupero" | "reparto"
    falta_para_cubrir: Number(Math.max(0, total_capital - margen).toFixed(2)),
    deuda: Number((deuda_generada - total_pagado).toFixed(2)),
  };

  // La sucursal ve el avance del recupero — es lo que define cuándo empieza a
  // ganar el 50% — y lo que debe. El detalle de cada compra y la ganancia del
  // dueño quedan solo para el admin.
  if (req.user?.rol !== "admin") return res.json(base);

  res.json({
    ...base,
    ganancia_tuya: Number(ganancia_tuya.toFixed(2)),
    historial,
    inversiones,
  });
});

// POST registrar una compra
//   tipo "capital" -> shishas, quemadores, pinzas: forma el techo a recuperar
//   tipo "insumo"  -> tabaco, carbón, aluminio: se repone en cada venta
router.post("/shisha/inversion", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo admin" });
  const { monto, descripcion, fecha, tipo = "capital" } = req.body;
  const montoNum = Number(monto);
  if (!montoNum || montoNum <= 0) return res.status(400).json({ error: "Monto inválido" });
  if (!descripcion || !descripcion.trim()) return res.status(400).json({ error: "Falta la descripción" });
  if (!["capital", "insumo"].includes(tipo)) return res.status(400).json({ error: "Tipo inválido" });

  await pool.promise().query(
    "INSERT INTO shisha_inversiones (monto, tipo, descripcion, fecha, creado_por) VALUES (?, ?, ?, ?, ?)",
    [montoNum, tipo, descripcion.trim(), fecha || new Date().toISOString().slice(0, 10), req.user?.id || null]
  );
  res.json({ ok: true });
});

// DELETE una inversión cargada mal
router.delete("/shisha/inversion/:id", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo admin" });
  const [[i]] = await pool.promise().query("SELECT id FROM shisha_inversiones WHERE id = ?", [req.params.id]);
  if (!i) return res.status(404).json({ error: "Inversión no encontrada" });
  await pool.promise().query("DELETE FROM shisha_inversiones WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

// POST registrar pago de shisha
router.post("/shisha/cuenta/pago", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo admin" });
  const { monto, metodo, fecha, notas } = req.body;
  const montoNum = Number(monto);
  if (!montoNum || montoNum <= 0) return res.status(400).json({ error: "Monto inválido" });
  if (!metodo) return res.status(400).json({ error: "Método requerido" });

  const fechaPago = fecha ? new Date(fecha + "T12:00:00") : new Date();
  await pool.promise().query(
    "INSERT INTO shisha_pagos (metodo, monto, fecha, notas) VALUES (?, ?, ?, ?)",
    [metodo, montoNum, fechaPago, notas || null]
  );
  res.json({ ok: true });
});

// DELETE pago de shisha
router.delete("/shisha/cuenta/pago/:id", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo admin" });
  const [[p]] = await pool.promise().query("SELECT id FROM shisha_pagos WHERE id = ?", [req.params.id]);
  if (!p) return res.status(404).json({ error: "Pago no encontrado" });
  await pool.promise().query("DELETE FROM shisha_pagos WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;

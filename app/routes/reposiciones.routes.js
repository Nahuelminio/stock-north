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

    let precioCosto = null;
    if (req.body.precio_costo != null && req.body.precio_costo !== "") {
      const pc = Number(req.body.precio_costo);
      if (!Number.isFinite(pc) || pc < 0) {
        return res.status(400).json({ error: "Precio de costo inválido" });
      }
      precioCosto = pc;
    }

    await pool
      .promise()
      .query(
        "INSERT INTO reposiciones (gusto_id, sucursal_id, cantidad_repuesta, precio_costo, fecha) VALUES (?, ?, ?, ?, NOW())",
        [gusto_id, sucursal_id, cantidad, precioCosto]
      );

    res.json({ mensaje: "Reposición registrada correctamente ✅" });
  } catch (error) {
    console.error("❌ Error al registrar reposición:", error);
    res.status(500).json({ error: "Error al registrar la reposición" });
  }
});

// 🔵 Reposición rápida (sin historial) — solo admin
router.post("/reposicion-rapida", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") {
    return res.status(403).json({ error: "Acceso denegado: solo administradores" });
  }

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

// 🔵 Reposición por código de barras — solo admin
router.post("/reposicion-por-codigo", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") {
    return res.status(403).json({ error: "Acceso denegado: solo administradores" });
  }

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

    let precioCosto = null;
    if (req.body.precio_costo != null && req.body.precio_costo !== "") {
      const pc = Number(req.body.precio_costo);
      if (!Number.isFinite(pc) || pc < 0) {
        return res.status(400).json({ error: "Precio de costo inválido" });
      }
      precioCosto = pc;
    }

    await pool
      .promise()
      .query(
        "INSERT INTO reposiciones (gusto_id, sucursal_id, cantidad_repuesta, precio_costo, fecha) VALUES (?, ?, ?, ?, NOW())",
        [gusto_id, sucursal_id, cantidad, precioCosto]
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

      // ✅ Solo actualizar si se especificó un código válido
      if (codigo_barra && codigo_barra.trim() !== "") {
        await pool
          .promise()
          .query(`UPDATE gustos SET codigo_barra = ? WHERE id = ?`, [
            codigo_barra,
            gusto_id,
          ]);
      }

      await pool
        .promise()
        .query(
          "UPDATE stock SET cantidad = ?, precio = ? WHERE gusto_id = ? AND sucursal_id = ?",
          [cantidad, precio, gusto_id, sucursal_id]
        );
    }

    res.json({ mensaje: "Actualización realizada correctamente ✅" });
  } catch (error) {
    console.error("❌ Error en actualización masiva:", error.message);
    console.error(error.stack);
    res.status(500).json({ error: "Error al actualizar stock/precio" });
  }
});







/**
 * GET /costos-central?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 * Análisis de costos para la Central (sucursal_id = 7).
 * Por cada producto muestra: unidades repuestas, costo total,
 * precio de stock actual, margen estimado, y ventas del período.
 * Solo admin.
 */
const CENTRAL_ID = 7;

router.get("/costos-central", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") {
    return res.status(403).json({ error: "Acceso denegado" });
  }

  const { desde, hasta } = req.query;

  try {
    // --- Reposiciones con costo del período ---
    let whereRepo = "r.sucursal_id = ?";
    const paramsRepo = [CENTRAL_ID];
    if (desde) { whereRepo += " AND DATE(r.fecha) >= ?"; paramsRepo.push(desde); }
    if (hasta) { whereRepo += " AND DATE(r.fecha) <= ?"; paramsRepo.push(hasta); }

    const [reposiciones] = await pool.promise().query(`
      SELECT
        g.id           AS gusto_id,
        p.nombre       AS producto,
        g.nombre       AS gusto,
        SUM(r.cantidad_repuesta) AS unidades_repuestas,
        -- Costo total: solo suma reposiciones que tienen precio_costo cargado
        SUM(CASE WHEN r.precio_costo IS NOT NULL THEN r.cantidad_repuesta * r.precio_costo ELSE 0 END) AS costo_total,
        -- Costo promedio PONDERADO: suma(cantidad * precio) / suma(cantidad con costo)
        -- Ejemplo: 100u a $10 + 50u a $11 = $10.33, no $10.50
        SUM(CASE WHEN r.precio_costo IS NOT NULL THEN r.cantidad_repuesta * r.precio_costo ELSE 0 END) /
          NULLIF(SUM(CASE WHEN r.precio_costo IS NOT NULL THEN r.cantidad_repuesta ELSE 0 END), 0) AS costo_prom,
        SUM(CASE WHEN r.precio_costo IS NOT NULL THEN r.cantidad_repuesta ELSE 0 END) AS unidades_con_costo,
        COUNT(CASE WHEN r.precio_costo IS NOT NULL THEN 1 END) AS repos_con_costo,
        COUNT(*) AS repos_total
      FROM reposiciones r
      JOIN gustos g   ON g.id = r.gusto_id
      JOIN productos p ON p.id = g.producto_id
      WHERE ${whereRepo}
      GROUP BY g.id, p.nombre, g.nombre
      ORDER BY p.nombre, g.nombre
    `, paramsRepo);

    // --- Precio de venta actual en la Central ---
    const [precios] = await pool.promise().query(`
      SELECT gusto_id, precio AS precio_venta, cantidad AS stock_actual
      FROM stock
      WHERE sucursal_id = ?
    `, [CENTRAL_ID]);
    const precioMap = {};
    precios.forEach(p => { precioMap[p.gusto_id] = { precio_venta: Number(p.precio_venta), stock_actual: Number(p.stock_actual) }; });

    // --- Ventas del período en la Central ---
    let whereVentas = "v.sucursal_id = ?";
    const paramsVentas = [CENTRAL_ID];
    if (desde) { whereVentas += " AND DATE(v.fecha) >= ?"; paramsVentas.push(desde); }
    if (hasta) { whereVentas += " AND DATE(v.fecha) <= ?"; paramsVentas.push(hasta); }

    const [ventas] = await pool.promise().query(`
      SELECT
        v.gusto_id,
        SUM(v.cantidad) AS unidades_vendidas,
        SUM(v.cantidad * COALESCE(v.precio_unitario, 0)) AS total_vendido
      FROM ventas v
      WHERE ${whereVentas}
      GROUP BY v.gusto_id
    `, paramsVentas);
    const ventasMap = {};
    ventas.forEach(v => { ventasMap[v.gusto_id] = { unidades_vendidas: Number(v.unidades_vendidas), total_vendido: Number(v.total_vendido) }; });

    // --- Combinar ---
    const resultado = reposiciones.map(r => {
      const precio_venta = precioMap[r.gusto_id]?.precio_venta ?? null;
      const stock_actual = precioMap[r.gusto_id]?.stock_actual ?? 0;
      const costo_prom   = r.costo_prom != null ? Number(r.costo_prom) : null;
      const costo_total  = Number(r.costo_total);
      const unidades_repuestas = Number(r.unidades_repuestas);
      const v = ventasMap[r.gusto_id] || { unidades_vendidas: 0, total_vendido: 0 };

      const margen_unitario = (precio_venta != null && costo_prom != null)
        ? precio_venta - costo_prom
        : null;
      const margen_pct = (margen_unitario != null && costo_prom > 0)
        ? (margen_unitario / costo_prom) * 100
        : null;

      const unidades_con_costo = Number(r.unidades_con_costo);
      // Si no todas las unidades tienen costo, el promedio es parcial — lo indicamos
      const costo_prom_parcial = unidades_con_costo < unidades_repuestas;

      return {
        gusto_id: r.gusto_id,
        producto: r.producto,
        gusto: r.gusto,
        unidades_repuestas,
        unidades_con_costo,
        costo_prom_parcial,
        costo_prom: costo_prom ? Number(costo_prom.toFixed(2)) : null,
        costo_total: Number(costo_total.toFixed(2)),
        repos_con_costo: Number(r.repos_con_costo),
        repos_total: Number(r.repos_total),
        precio_venta,
        stock_actual,
        margen_unitario: margen_unitario != null ? Number(margen_unitario.toFixed(2)) : null,
        margen_pct: margen_pct != null ? Number(margen_pct.toFixed(1)) : null,
        unidades_vendidas: v.unidades_vendidas,
        total_vendido: Number(v.total_vendido.toFixed(2)),
      };
    });

    // --- Totales ---
    const totales = {
      costo_total: Number(resultado.reduce((s, r) => s + r.costo_total, 0).toFixed(2)),
      total_vendido: Number(resultado.reduce((s, r) => s + r.total_vendido, 0).toFixed(2)),
      unidades_repuestas: resultado.reduce((s, r) => s + r.unidades_repuestas, 0),
      unidades_vendidas: resultado.reduce((s, r) => s + r.unidades_vendidas, 0),
    };
    totales.ganancia_estimada = Number((totales.total_vendido - totales.costo_total).toFixed(2));
    totales.margen_pct = totales.costo_total > 0
      ? Number(((totales.ganancia_estimada / totales.costo_total) * 100).toFixed(1))
      : null;

    res.json({ productos: resultado, totales });
  } catch (e) {
    console.error("❌ Error en /costos-central:", e);
    res.status(500).json({ error: "Error al obtener análisis de costos" });
  }
});

module.exports = router;

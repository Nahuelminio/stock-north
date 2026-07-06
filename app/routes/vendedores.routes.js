const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

// Solo admin puede acceder
const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") {
    return res.status(403).json({ error: "Acceso denegado" });
  }
  next();
};

// Helper: lunes de una semana ISO
function getMondayOfISOWeek(week, year) {
  const simple = new Date(year, 0, 1 + (week - 1) * 7);
  const dow = simple.getDay();
  const ISOweekStart = new Date(simple);
  let diff;
  if (dow === 0) diff = -6;
  else if (dow <= 4) diff = 1 - dow;
  else diff = 8 - dow;
  ISOweekStart.setDate(simple.getDate() + diff);
  return ISOweekStart;
}

// Helper: semana ISO actual
function getSemanaActual() {
  const hoy = new Date();
  const fechaUTC = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()));
  const diaSemana = fechaUTC.getUTCDay() || 7;
  fechaUTC.setUTCDate(fechaUTC.getUTCDate() + 4 - diaSemana);
  const inicioAno = new Date(Date.UTC(fechaUTC.getUTCFullYear(), 0, 1));
  return {
    semana: Math.ceil(((fechaUTC - inicioAno) / 86400000 + 1) / 7),
    anio: fechaUTC.getUTCFullYear(),
  };
}

/**
 * GET /vendedores/lista
 * Lista todos los vendedores con su sucursal
 */
router.get("/lista", authenticate, soloAdmin, async (req, res) => {
  try {
    const [rows] = await pool.promise().query(`
      SELECT u.id, u.email, u.sucursal_id, s.nombre AS sucursal_nombre
      FROM usuarios u
      LEFT JOIN sucursales s ON s.id = u.sucursal_id
      WHERE u.rol = 'vendedor'
      ORDER BY u.email
    `);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error /vendedores/lista:", e);
    res.status(500).json({ error: "Error al obtener vendedores" });
  }
});

/**
 * GET /vendedores/resumen-semana?semana=X&anio=Y
 * Retorna por vendedor: total_pares, total_monto, y desglose por día
 */
router.get("/resumen-semana", authenticate, soloAdmin, async (req, res) => {
  try {
    const hoy = getSemanaActual();
    const semana = req.query.semana ? Number(req.query.semana) : hoy.semana;
    const anio   = req.query.anio   ? Number(req.query.anio)   : hoy.anio;

    if (!Number.isInteger(semana) || semana < 1 || semana > 53)
      return res.status(400).json({ error: "Semana inválida" });
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100)
      return res.status(400).json({ error: "Año inválido" });

    const lunes = getMondayOfISOWeek(semana, anio);
    const domingo = new Date(lunes);
    domingo.setDate(lunes.getDate() + 6);

    const inicioStr = lunes.toISOString().slice(0, 10);
    const finStr = domingo.toISOString().slice(0, 10);

    // 1. Traer todos los vendedores
    const [vendedores] = await pool.promise().query(`
      SELECT u.id, u.email, u.sucursal_id, s.nombre AS sucursal_nombre
      FROM usuarios u
      LEFT JOIN sucursales s ON s.id = u.sucursal_id
      WHERE u.rol = 'vendedor'
      ORDER BY u.email
    `);

    // 2. Traer ventas de esa semana agrupadas por vendedor_id + día + sucursal
    const [ventas] = await pool.promise().query(`
      SELECT
        v.vendedor_id,
        DATE(v.fecha) AS fecha,
        DAYNAME(v.fecha) AS dia_en,
        v.sucursal_id AS stock_sucursal_id,
        s.nombre AS stock_sucursal_nombre,
        SUM(v.cantidad) AS total_pares,
        SUM(v.cantidad * COALESCE(v.precio_unitario, 0)) AS total_monto
      FROM ventas v
      LEFT JOIN sucursales s ON s.id = v.sucursal_id
      JOIN usuarios u ON u.id = v.vendedor_id AND u.rol = 'vendedor'
      WHERE DATE(v.fecha) BETWEEN ? AND ?
      GROUP BY v.vendedor_id, DATE(v.fecha), DAYNAME(v.fecha), v.sucursal_id, s.nombre
      ORDER BY v.vendedor_id, DATE(v.fecha), v.sucursal_id
    `, [inicioStr, finStr]);

    // Nombres de días en español
    const diasEs = {
      Monday: "Lunes", Tuesday: "Martes", Wednesday: "Miércoles",
      Thursday: "Jueves", Friday: "Viernes", Saturday: "Sábado", Sunday: "Domingo",
    };

    // 3. Combinar — agrupar por día y anidar sucursales
    const resultado = vendedores.map((v) => {
      const filas = ventas.filter((d) => d.vendedor_id === v.id);

      // Agrupar por fecha
      const diasMap = {};
      for (const d of filas) {
        const fecha = d.fecha instanceof Date ? d.fecha.toISOString().slice(0, 10) : String(d.fecha).slice(0, 10);
        if (!diasMap[fecha]) {
          diasMap[fecha] = { fecha, dia: diasEs[d.dia_en] || d.dia_en, total_pares: 0, total_monto: 0, sucursales: [] };
        }
        diasMap[fecha].total_pares += Number(d.total_pares);
        diasMap[fecha].total_monto += Number(d.total_monto);
        diasMap[fecha].sucursales.push({
          sucursal_id: d.stock_sucursal_id,
          sucursal_nombre: d.stock_sucursal_nombre || "—",
          total_pares: Number(d.total_pares),
          total_monto: Number(d.total_monto),
        });
      }
      const dias = Object.values(diasMap).sort((a, b) => a.fecha.localeCompare(b.fecha));

      const totalPares = dias.reduce((s, d) => s + d.total_pares, 0);
      const totalMonto = dias.reduce((s, d) => s + d.total_monto, 0);

      return {
        id: v.id,
        email: v.email,
        sucursal_nombre: v.sucursal_nombre,
        total_pares: totalPares,
        total_monto: totalMonto,
        dias,
      };
    });

    res.json({
      semana,
      anio,
      inicio: inicioStr,
      fin: finStr,
      vendedores: resultado,
    });
  } catch (e) {
    console.error("❌ Error /vendedores/resumen-semana:", e);
    res.status(500).json({ error: "Error al obtener resumen semanal" });
  }
});

/**
 * GET /vendedores/resumen-mes?mes=X&anio=Y
 * Retorna por vendedor: total_pares, total_monto, y desglose por semana del mes
 */
router.get("/resumen-mes", authenticate, soloAdmin, async (req, res) => {
  try {
    const hoy = new Date();
    const mes  = req.query.mes  ? Number(req.query.mes)  : hoy.getMonth() + 1;
    const anio = req.query.anio ? Number(req.query.anio) : hoy.getFullYear();

    if (!Number.isInteger(mes) || mes < 1 || mes > 12)
      return res.status(400).json({ error: "Mes inválido" });
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100)
      return res.status(400).json({ error: "Año inválido" });

    // 1. Traer todos los vendedores
    const [vendedores] = await pool.promise().query(`
      SELECT u.id, u.email, u.sucursal_id, s.nombre AS sucursal_nombre
      FROM usuarios u
      LEFT JOIN sucursales s ON s.id = u.sucursal_id
      WHERE u.rol = 'vendedor'
      ORDER BY u.email
    `);

    // 2. Traer ventas de ese mes agrupadas por vendedor_id + semana ISO + sucursal
    const [ventas] = await pool.promise().query(`
      SELECT
        v.vendedor_id,
        WEEK(v.fecha, 1) AS semana_iso,
        DATE(DATE_SUB(v.fecha, INTERVAL WEEKDAY(v.fecha) DAY)) AS inicio_semana,
        v.sucursal_id AS stock_sucursal_id,
        s.nombre AS stock_sucursal_nombre,
        SUM(v.cantidad) AS total_pares,
        SUM(v.cantidad * COALESCE(v.precio_unitario, 0)) AS total_monto
      FROM ventas v
      JOIN usuarios u ON u.id = v.vendedor_id AND u.rol = 'vendedor'
      LEFT JOIN sucursales s ON s.id = v.sucursal_id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
      GROUP BY v.vendedor_id, WEEK(v.fecha, 1), DATE(DATE_SUB(v.fecha, INTERVAL WEEKDAY(v.fecha) DAY)), v.sucursal_id, s.nombre
      ORDER BY v.vendedor_id, semana_iso, v.sucursal_id
    `, [mes, anio]);

    // 3. Combinar — agrupar por semana y anidar sucursales
    const resultado = vendedores.map((v) => {
      const filas = ventas.filter((d) => d.vendedor_id === v.id);

      const semanasMap = {};
      for (const d of filas) {
        const key = d.semana_iso;
        const inicioStr = d.inicio_semana instanceof Date ? d.inicio_semana.toISOString().slice(0, 10) : String(d.inicio_semana).slice(0, 10);
        if (!semanasMap[key]) {
          semanasMap[key] = { semana_iso: key, inicio_semana: inicioStr, total_pares: 0, total_monto: 0, sucursales: [] };
        }
        semanasMap[key].total_pares += Number(d.total_pares);
        semanasMap[key].total_monto += Number(d.total_monto);
        semanasMap[key].sucursales.push({
          sucursal_id: d.stock_sucursal_id,
          sucursal_nombre: d.stock_sucursal_nombre || "—",
          total_pares: Number(d.total_pares),
          total_monto: Number(d.total_monto),
        });
      }
      const semanas = Object.values(semanasMap).sort((a, b) => a.semana_iso - b.semana_iso);

      const totalPares = semanas.reduce((s, d) => s + d.total_pares, 0);
      const totalMonto = semanas.reduce((s, d) => s + d.total_monto, 0);

      return {
        id: v.id,
        email: v.email,
        sucursal_nombre: v.sucursal_nombre,
        total_pares: totalPares,
        total_monto: totalMonto,
        semanas,
      };
    });

    const mesesNombres = [
      "", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
      "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
    ];

    res.json({
      mes,
      anio,
      mes_nombre: mesesNombres[mes],
      vendedores: resultado,
    });
  } catch (e) {
    console.error("❌ Error /vendedores/resumen-mes:", e);
    res.status(500).json({ error: "Error al obtener resumen mensual" });
  }
});

/**
 * GET /vendedores/deudas
 * Devuelve para cada vendedor: total facturado, total pagado, deuda actual
 */
router.get("/deudas", authenticate, soloAdmin, async (req, res) => {
  try {
    const [vendedores] = await pool.promise().query(`
      SELECT u.id, u.email,
        COALESCE(SUM(v.cantidad * COALESCE(v.precio_unitario, 0)), 0) AS total_facturado
      FROM usuarios u
      LEFT JOIN ventas v ON v.vendedor_id = u.id
      WHERE u.rol = 'vendedor'
      GROUP BY u.id, u.email
      ORDER BY u.email
    `);

    const [pagos] = await pool.promise().query(`
      SELECT vendedor_id, SUM(monto) AS total_pagado
      FROM pagos
      WHERE vendedor_id IS NOT NULL AND estado = 'ok'
      GROUP BY vendedor_id
    `);

    const pagosMap = {};
    pagos.forEach(p => { pagosMap[p.vendedor_id] = Number(p.total_pagado); });

    const resultado = vendedores.map(v => {
      const facturado = Number(v.total_facturado);
      const pagado    = pagosMap[v.id] || 0;
      return {
        id:               v.id,
        email:            v.email,
        total_facturado:  facturado,
        total_pagado:     pagado,
        deuda:            Number((facturado - pagado).toFixed(2)),
      };
    });

    res.json(resultado);
  } catch (e) {
    console.error("❌ Error /vendedores/deudas:", e);
    res.status(500).json({ error: "Error al obtener deudas" });
  }
});

/**
 * POST /vendedores/:id/pago
 * Registra un pago de un vendedor al negocio.
 * Body: { monto, metodo, fecha? (YYYY-MM-DD), notas? }
 */
router.post("/:id/pago", authenticate, soloAdmin, async (req, res) => {
  const vendedorId = Number(req.params.id);
  const { monto, metodo, fecha, notas } = req.body;

  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0)
    return res.status(400).json({ error: "Monto inválido" });
  if (!metodo || !String(metodo).trim())
    return res.status(400).json({ error: "Método de pago requerido" });

  try {
    // Verificar que el vendedor existe
    const [[vendedor]] = await pool.promise().query(
      "SELECT id, email FROM usuarios WHERE id = ? AND rol = 'vendedor'",
      [vendedorId]
    );
    if (!vendedor) return res.status(404).json({ error: "Vendedor no encontrado" });

    const fechaPago = fecha ? new Date(fecha + "T12:00:00") : new Date();

    await pool.promise().query(
      `INSERT INTO pagos (vendedor_id, sucursal_id, metodo, monto, fecha, referencia, estado)
       VALUES (?, NULL, ?, ?, ?, ?, 'ok')`,
      [vendedorId, String(metodo).trim(), montoNum, fechaPago, notas || null]
    );

    res.json({ ok: true, mensaje: "Pago registrado" });
  } catch (e) {
    console.error("❌ Error POST /vendedores/:id/pago:", e);
    res.status(500).json({ error: "Error al registrar pago" });
  }
});

/**
 * DELETE /vendedores/pagos/:pagoId
 * Elimina un pago mal registrado (v2)
 */
router.delete("/pagos/:pagoId", authenticate, soloAdmin, async (req, res) => {
  const pagoId = Number(req.params.pagoId);
  try {
    const [[pago]] = await pool.promise().query("SELECT id FROM pagos WHERE id = ? AND vendedor_id IS NOT NULL", [pagoId]);
    if (!pago) return res.status(404).json({ error: "Pago no encontrado" });
    await pool.promise().query("DELETE FROM pagos WHERE id = ?", [pagoId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ Error DELETE /vendedores/pagos/:id:", e);
    res.status(500).json({ error: "Error al eliminar pago" });
  }
});

/**
 * GET /vendedores/:id/pagos
 * Historial de pagos de un vendedor
 */
router.get("/:id/pagos", authenticate, soloAdmin, async (req, res) => {
  const vendedorId = Number(req.params.id);
  try {
    const [rows] = await pool.promise().query(
      `SELECT id, monto, metodo, fecha, referencia AS notas, estado
       FROM pagos WHERE vendedor_id = ? ORDER BY fecha DESC`,
      [vendedorId]
    );
    res.json(rows);
  } catch (e) {
    console.error("❌ Error GET /vendedores/:id/pagos:", e);
    res.status(500).json({ error: "Error al obtener pagos" });
  }
});

/**
 * GET /vendedores/ventas/detalle?semana=X&anio=Y  (o mes=X&anio=Y)
 * Devuelve todas las ventas de todos los vendedores con producto y sabor
 */
router.get("/ventas/detalle", authenticate, soloAdmin, async (req, res) => {
  try {
    const { semana, mes, anio } = req.query;
    const anioNum = anio ? Number(anio) : new Date().getFullYear();

    let whereFecha = "";
    const params = [];

    if (semana) {
      // Calcular lunes/domingo de la semana ISO
      const semanaNum = Number(semana);
      const lunes = getMondayOfISOWeek(semanaNum, anioNum);
      const domingo = new Date(lunes);
      domingo.setDate(lunes.getDate() + 6);
      whereFecha = "AND DATE(v.fecha) BETWEEN ? AND ?";
      params.push(lunes.toISOString().slice(0, 10), domingo.toISOString().slice(0, 10));
    } else if (mes) {
      whereFecha = "AND MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?";
      params.push(Number(mes), anioNum);
    }

    const [rows] = await pool.promise().query(`
      SELECT
        v.id,
        v.fecha,
        v.cantidad,
        v.precio_unitario,
        (v.cantidad * COALESCE(v.precio_unitario, 0)) AS total,
        u.id AS vendedor_id,
        u.email AS vendedor_email,
        g.id AS gusto_id,
        g.nombre AS sabor,
        p.id AS producto_id,
        p.nombre AS producto,
        sc.nombre AS sucursal_stock
      FROM ventas v
      JOIN usuarios u ON u.id = v.vendedor_id AND u.rol = 'vendedor'
      JOIN gustos g ON g.id = v.gusto_id
      JOIN productos p ON p.id = g.producto_id
      LEFT JOIN sucursales sc ON sc.id = v.sucursal_id
      WHERE 1=1 ${whereFecha}
      ORDER BY v.fecha DESC, u.email, p.nombre, g.nombre
    `, params);

    res.json(rows);
  } catch (e) {
    console.error("❌ Error GET /vendedores/ventas/detalle:", e);
    res.status(500).json({ error: "Error al obtener detalle de ventas" });
  }
});

/**
 * PUT /vendedores/ventas/:ventaId
 * Edita cantidad y/o precio_unitario de una venta de vendedor
 */
router.put("/ventas/:ventaId", authenticate, soloAdmin, async (req, res) => {
  const ventaId = Number(req.params.ventaId);
  const { cantidad, precio_unitario } = req.body;

  const cantNum   = Number(cantidad);
  const precioNum = Number(precio_unitario);

  if (!Number.isFinite(cantNum)   || cantNum   <= 0) return res.status(400).json({ error: "Cantidad inválida" });
  if (!Number.isFinite(precioNum) || precioNum <  0) return res.status(400).json({ error: "Precio inválido" });

  try {
    const [[venta]] = await pool.promise().query(
      "SELECT id, vendedor_id FROM ventas v JOIN usuarios u ON u.id = v.vendedor_id AND u.rol = 'vendedor' WHERE v.id = ?",
      [ventaId]
    );
    if (!venta) return res.status(404).json({ error: "Venta no encontrada" });

    await pool.promise().query(
      "UPDATE ventas SET cantidad = ?, precio_unitario = ? WHERE id = ?",
      [cantNum, precioNum, ventaId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ Error PUT /vendedores/ventas/:id:", e);
    res.status(500).json({ error: "Error al editar venta" });
  }
});

module.exports = router;

/**
 * Lo que se le sumó a los pedidos mayoristas después:
 *  - Armado: tildar cada renglón al meterlo en la caja.
 *  - Cobros: cuánto pagó el cliente de cada pedido y cuánto debe.
 *  - Clientes: qué compra cada uno, cada cuánto y cuánto debe.
 *
 * Se monta en /mayorista junto a mayorista.routes.js, pero va aparte para no
 * mezclar esto con el armado y la confirmación de pedidos.
 *
 * La deuda se lleva en dólares, que es la moneda del pedido. Un pago en pesos
 * se pasa a dólares con el tipo de cambio de ESE pedido, el mismo con el que se
 * le facturó, para que pagar el total en pesos deje la deuda en cero.
 *
 * Los pedidos confirmados antes de que existiera esto no tienen cobros
 * cargados; se marcan con cobro_control = 0 y se toman como cobrados. Si alguno
 * no lo estaba, se le activa el control desde el pedido.
 */
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

router.use(authenticate);

const soloAdmin = (req, res, next) =>
  req.user?.rol === "admin" ? next() : res.status(403).json({ error: "Solo admin" });

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ─── tablas ──────────────────────────────────────────────────────────────────

let listo = null;
function asegurarTablas() {
  if (listo) return listo;
  listo = (async () => {
    const q = (s, p) => pool.promise().query(s, p);
    const tieneColumna = async (tabla, col) => {
      const [[r]] = await q(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [tabla, col]
      );
      return r.n > 0;
    };

    if (!(await tieneColumna("pedido_mayorista_items", "armado"))) {
      await q("ALTER TABLE pedido_mayorista_items ADD COLUMN armado TINYINT(1) NOT NULL DEFAULT 0");
    }
    if (!(await tieneColumna("pedidos_mayoristas", "cobro_control"))) {
      // Los nuevos nacen con control; los que ya existían se toman como cobrados.
      await q("ALTER TABLE pedidos_mayoristas ADD COLUMN cobro_control TINYINT(1) NOT NULL DEFAULT 1");
      await q("UPDATE pedidos_mayoristas SET cobro_control = 0");
    }
    await q(`CREATE TABLE IF NOT EXISTS pedido_mayorista_pagos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pedido_id INT NOT NULL,
      monto DECIMAL(14,2) NOT NULL,
      moneda ENUM('ARS','USD') NOT NULL,
      monto_usd DECIMAL(12,2) NOT NULL,
      nota VARCHAR(255) NULL,
      fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      creado_por INT NULL,
      INDEX (pedido_id)
    )`);
  })().catch((e) => { listo = null; throw e; });
  return listo;
}

router.use(async (req, res, next) => {
  try { await asegurarTablas(); next(); }
  catch (e) {
    console.error("❌ mayoristaExtras: no se pudieron preparar las tablas:", e);
    res.status(500).json({ error: "Error de base de datos" });
  }
});

/** Pedido visible para el usuario (admin: todos; sucursal: los suyos) */
async function pedidoVisible(req, pedidoId) {
  const params = [pedidoId];
  let sql = `SELECT id, estado, tipo_cambio, total_usd, cobro_control, cliente_id
               FROM pedidos_mayoristas WHERE id = ?`;
  if (req.user.rol !== "admin") {
    sql += " AND sucursal_id = ?";
    params.push(Number(req.user.sucursalId));
  }
  const [[p]] = await pool.promise().query(sql, params);
  return p || null;
}

/** Lo cobrado y lo que falta de un pedido, en dólares */
const SQL_COBRADO = `(SELECT COALESCE(SUM(pp.monto_usd), 0) FROM pedido_mayorista_pagos pp WHERE pp.pedido_id = pm.id)`;
const SQL_SALDO = `IF(pm.estado = 'confirmado' AND pm.cobro_control = 1,
                      GREATEST(pm.total_usd - ${SQL_COBRADO}, 0), 0)`;

// ─── armado ──────────────────────────────────────────────────────────────────

// PATCH /mayorista/pedidos/:id/items/:itemId/armado  { armado: true|false }
router.patch("/pedidos/:id/items/:itemId/armado", async (req, res) => {
  const pedidoId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  try {
    const p = await pedidoVisible(req, pedidoId);
    if (!p) return res.status(404).json({ error: "Pedido no encontrado" });
    if (p.estado === "cancelado") return res.status(400).json({ error: "El pedido está cancelado" });

    const [r] = await pool.promise().query(
      "UPDATE pedido_mayorista_items SET armado = ? WHERE id = ? AND pedido_id = ?",
      [req.body?.armado ? 1 : 0, itemId, pedidoId]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Renglón no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ armado:", e);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

// GET /mayorista/pedidos/:id/extras — armado por renglón y cobros
router.get("/pedidos/:id/extras", async (req, res) => {
  const pedidoId = Number(req.params.id);
  try {
    const p = await pedidoVisible(req, pedidoId);
    if (!p) return res.status(404).json({ error: "Pedido no encontrado" });

    const [armado] = await pool.promise().query(
      "SELECT id, armado FROM pedido_mayorista_items WHERE pedido_id = ?", [pedidoId]
    );
    const [pagos] = await pool.promise().query(
      `SELECT id, monto, moneda, monto_usd, nota, fecha
         FROM pedido_mayorista_pagos WHERE pedido_id = ? ORDER BY fecha`, [pedidoId]
    );
    const cobrado = round2(pagos.reduce((s, x) => s + Number(x.monto_usd), 0));
    const controla = p.estado === "confirmado" && Number(p.cobro_control) === 1;
    res.json({
      armado: Object.fromEntries(armado.map((a) => [a.id, !!a.armado])),
      pagos,
      cobro_control: !!Number(p.cobro_control),
      total_usd: Number(p.total_usd),
      tipo_cambio: Number(p.tipo_cambio),
      cobrado_usd: cobrado,
      saldo_usd: controla ? Math.max(0, round2(Number(p.total_usd) - cobrado)) : 0,
    });
  } catch (e) {
    console.error("❌ extras pedido:", e);
    res.status(500).json({ error: "No se pudo cargar" });
  }
});

// ─── cobros ──────────────────────────────────────────────────────────────────

// POST /mayorista/pedidos/:id/pagos  { monto, moneda: 'ARS'|'USD', nota }
router.post("/pedidos/:id/pagos", soloAdmin, async (req, res) => {
  const pedidoId = Number(req.params.id);
  const monto = Number(req.body?.monto);
  const moneda = req.body?.moneda === "USD" ? "USD" : "ARS";
  const nota = req.body?.nota ? String(req.body.nota).trim().slice(0, 255) : null;

  if (!(monto > 0)) return res.status(400).json({ error: "Monto inválido" });
  try {
    const p = await pedidoVisible(req, pedidoId);
    if (!p) return res.status(404).json({ error: "Pedido no encontrado" });
    if (p.estado !== "confirmado") return res.status(400).json({ error: "Solo se cobran pedidos confirmados" });

    const tc = Number(p.tipo_cambio) || 0;
    if (moneda === "ARS" && !(tc > 0)) {
      return res.status(400).json({ error: "El pedido no tiene tipo de cambio: cargá el pago en dólares" });
    }
    const montoUsd = round2(moneda === "USD" ? monto : monto / tc);

    await pool.promise().query(
      `INSERT INTO pedido_mayorista_pagos (pedido_id, monto, moneda, monto_usd, nota, creado_por)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [pedidoId, monto, moneda, montoUsd, nota, req.user.id || null]
    );
    // Si se cobra un pedido viejo, es porque se quiere controlarlo
    if (!Number(p.cobro_control)) {
      await pool.promise().query("UPDATE pedidos_mayoristas SET cobro_control = 1 WHERE id = ?", [pedidoId]);
    }
    res.status(201).json({ ok: true, monto_usd: montoUsd });
  } catch (e) {
    console.error("❌ pago mayorista:", e);
    res.status(500).json({ error: "No se pudo registrar el pago" });
  }
});

// DELETE /mayorista/pagos/:pagoId — para un pago cargado por error
router.delete("/pagos/:pagoId", soloAdmin, async (req, res) => {
  try {
    const [r] = await pool.promise().query(
      "DELETE FROM pedido_mayorista_pagos WHERE id = ?", [Number(req.params.pagoId)]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Pago no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ borrar pago mayorista:", e);
    res.status(500).json({ error: "No se pudo borrar" });
  }
});

// PATCH /mayorista/pedidos/:id/cobro-control  { activo } — para un pedido viejo que no estaba pago
router.patch("/pedidos/:id/cobro-control", soloAdmin, async (req, res) => {
  try {
    const [r] = await pool.promise().query(
      "UPDATE pedidos_mayoristas SET cobro_control = ? WHERE id = ?",
      [req.body?.activo ? 1 : 0, Number(req.params.id)]
    );
    if (!r.affectedRows) return res.status(404).json({ error: "Pedido no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ cobro-control:", e);
    res.status(500).json({ error: "No se pudo guardar" });
  }
});

// GET /mayorista/pedidos-estado?ids=1,2,3 — armado y saldo para la lista
router.get("/pedidos-estado", async (req, res) => {
  const ids = String(req.query.ids || "").split(",").map(Number).filter(Boolean).slice(0, 200);
  if (!ids.length) return res.json({});
  try {
    const params = [ids];
    let filtro = "";
    if (req.user.rol !== "admin") { filtro = " AND pm.sucursal_id = ?"; params.push(Number(req.user.sucursalId)); }
    const [filas] = await pool.promise().query(
      `SELECT pm.id,
              (SELECT COUNT(*) FROM pedido_mayorista_items i WHERE i.pedido_id = pm.id) AS renglones,
              (SELECT COUNT(*) FROM pedido_mayorista_items i WHERE i.pedido_id = pm.id AND i.armado = 1) AS armados,
              ${SQL_SALDO} AS saldo_usd
         FROM pedidos_mayoristas pm WHERE pm.id IN (?)${filtro}`,
      params
    );
    res.json(Object.fromEntries(filas.map((f) => [f.id, {
      renglones: Number(f.renglones), armados: Number(f.armados), saldo_usd: Number(f.saldo_usd),
    }])));
  } catch (e) {
    console.error("❌ pedidos-estado:", e);
    res.status(500).json({ error: "No se pudo cargar" });
  }
});

// ─── costos ──────────────────────────────────────────────────────────────────

// GET /mayorista/costos-usd — { "nombre del modelo": costo USD por unidad }
// El de la última orden de reposición del modelo, con el pase incluido: es lo
// mínimo que se le puede cobrar al mayorista sin perder plata.
router.get("/costos-usd", soloAdmin, async (req, res) => {
  try {
    const [filas] = await pool.promise().query(`
      SELECT p.nombre,
             (SELECT i.precio_costo_usd
                FROM orden_reposicion_items i
                JOIN ordenes_reposicion o ON o.id = i.orden_id
                JOIN gustos g ON g.id = i.gusto_id
               WHERE g.producto_id = p.id AND i.precio_costo_usd > 0
               ORDER BY o.id DESC, i.id DESC LIMIT 1) AS costo_usd
        FROM productos p`);
    res.json(Object.fromEntries(
      filas.filter((f) => f.costo_usd != null).map((f) => [f.nombre, Number(f.costo_usd)])
    ));
  } catch (e) {
    console.error("❌ costos-usd:", e);
    res.status(500).json({ error: "No se pudieron traer los costos" });
  }
});

// ─── clientes ────────────────────────────────────────────────────────────────

// GET /mayorista/clientes-resumen — todos los clientes con lo que compraron y deben
router.get("/clientes-resumen", soloAdmin, async (req, res) => {
  try {
    const [filas] = await pool.promise().query(`
      SELECT c.id, c.nombre, c.telefono,
             COUNT(pm.id) AS pedidos,
             COALESCE(SUM(pm.total_usd), 0) AS total_usd,
             MIN(pm.fecha_confirmacion) AS primer_pedido,
             MAX(pm.fecha_confirmacion) AS ultimo_pedido,
             COALESCE(SUM(${SQL_SALDO}), 0) AS deuda_usd
        FROM clientes c
        LEFT JOIN pedidos_mayoristas pm ON pm.cliente_id = c.id AND pm.estado = 'confirmado'
       WHERE c.es_mayorista = 1
       GROUP BY c.id, c.nombre, c.telefono
       ORDER BY deuda_usd DESC, ultimo_pedido DESC`);
    res.json(filas.map((f) => ({
      ...f,
      pedidos: Number(f.pedidos),
      total_usd: Number(f.total_usd),
      deuda_usd: Number(f.deuda_usd),
      // Cada cuántos días compra, en promedio
      cada_dias: f.pedidos > 1
        ? Math.round((new Date(f.ultimo_pedido) - new Date(f.primer_pedido)) / 86400000 / (f.pedidos - 1))
        : null,
    })));
  } catch (e) {
    console.error("❌ clientes-resumen:", e);
    res.status(500).json({ error: "No se pudo cargar" });
  }
});

// GET /mayorista/clientes/:id/historial — detalle de un cliente
router.get("/clientes/:id/historial", soloAdmin, async (req, res) => {
  const clienteId = Number(req.params.id);
  try {
    const [[cliente]] = await pool.promise().query(
      "SELECT id, nombre, telefono, nota FROM clientes WHERE id = ?", [clienteId]
    );
    if (!cliente) return res.status(404).json({ error: "Cliente no encontrado" });

    const [pedidos] = await pool.promise().query(
      `SELECT pm.id, pm.fecha_confirmacion, pm.total_usd, pm.total_ars, pm.cobro_control,
              (SELECT COALESCE(SUM(i.cantidad), 0) FROM pedido_mayorista_items i WHERE i.pedido_id = pm.id) AS unidades,
              ${SQL_COBRADO} AS cobrado_usd,
              ${SQL_SALDO} AS saldo_usd
         FROM pedidos_mayoristas pm
        WHERE pm.cliente_id = ? AND pm.estado = 'confirmado'
        ORDER BY pm.fecha_confirmacion DESC`, [clienteId]
    );
    const [modelos] = await pool.promise().query(
      `SELECT p.nombre, SUM(i.cantidad) AS unidades, COALESCE(SUM(i.cantidad * i.precio_usd), 0) AS total_usd
         FROM pedido_mayorista_items i
         JOIN pedidos_mayoristas pm ON pm.id = i.pedido_id AND pm.estado = 'confirmado'
         JOIN gustos g ON g.id = i.gusto_id
         JOIN productos p ON p.id = g.producto_id
        WHERE pm.cliente_id = ?
        GROUP BY p.id, p.nombre ORDER BY unidades DESC`, [clienteId]
    );
    const [sabores] = await pool.promise().query(
      `SELECT p.nombre AS modelo, g.nombre AS sabor, SUM(i.cantidad) AS unidades
         FROM pedido_mayorista_items i
         JOIN pedidos_mayoristas pm ON pm.id = i.pedido_id AND pm.estado = 'confirmado'
         JOIN gustos g ON g.id = i.gusto_id
         JOIN productos p ON p.id = g.producto_id
        WHERE pm.cliente_id = ?
        GROUP BY g.id, p.nombre, g.nombre ORDER BY unidades DESC LIMIT 10`, [clienteId]
    );

    res.json({
      cliente,
      pedidos: pedidos.map((x) => ({
        ...x, unidades: Number(x.unidades), cobrado_usd: Number(x.cobrado_usd), saldo_usd: Number(x.saldo_usd),
      })),
      modelos: modelos.map((m) => ({ ...m, unidades: Number(m.unidades), total_usd: Number(m.total_usd) })),
      sabores: sabores.map((s) => ({ ...s, unidades: Number(s.unidades) })),
      total_usd: round2(pedidos.reduce((s, x) => s + Number(x.total_usd), 0)),
      unidades: pedidos.reduce((s, x) => s + Number(x.unidades), 0),
      deuda_usd: round2(pedidos.reduce((s, x) => s + Number(x.saldo_usd), 0)),
    });
  } catch (e) {
    console.error("❌ historial cliente:", e);
    res.status(500).json({ error: "No se pudo cargar" });
  }
});

module.exports = router;

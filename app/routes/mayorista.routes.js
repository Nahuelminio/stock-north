const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

router.use(authenticate);

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Redondea a 2 decimales para evitar errores de punto flotante */
function round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

/** Calcula totales del array de items */
function calcularTotales(items, tipoCambio) {
  const totalUsd = items.reduce(
    (acc, it) => acc + round2(parseFloat(it.precio_usd) * parseInt(it.cantidad)),
    0
  );
  const totalArs = tipoCambio > 0 ? round2(totalUsd * tipoCambio) : 0;
  return { totalUsd: round2(totalUsd), totalArs };
}

/** Valida formato YYYY-MM-DD */
function esDateValida(str) {
  return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

/** Timestamp MySQL seguro desde JS (evita problemas de timezone con NOW()) */
function nowMysql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /mayorista/clientes
// ─────────────────────────────────────────────────────────────────────────────
router.get("/clientes", async (req, res) => {
  const { q } = req.query;
  try {
    let sql = `SELECT id, nombre, telefono, nota AS observaciones
               FROM clientes WHERE es_mayorista = 1`;
    const params = [];
    if (q && String(q).trim()) {
      sql += " AND (nombre LIKE ? OR telefono LIKE ?)";
      params.push(`%${String(q).trim()}%`, `%${String(q).trim()}%`);
    }
    sql += " ORDER BY nombre ASC";
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error clientes mayoristas:", e);
    res.status(500).json({ error: "Error al obtener clientes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /mayorista/clientes
// ─────────────────────────────────────────────────────────────────────────────
router.post("/clientes", async (req, res) => {
  const nombre = String(req.body.nombre || "").trim();
  const telefono = String(req.body.telefono || "").trim();
  const observaciones = req.body.observaciones ? String(req.body.observaciones).trim() : null;

  if (!nombre) return res.status(400).json({ error: "El nombre es obligatorio" });

  try {
    const [ins] = await pool.promise().query(
      `INSERT INTO clientes (nombre, telefono, telefono_normalizado, nota, es_mayorista, acepta, estado, source)
       VALUES (?, ?, ?, ?, 1, 1, 'nuevo', 'web')`,
      [nombre, telefono, telefono.replace(/\D/g, ""), observaciones]
    );
    const [rows] = await pool.promise().query(
      "SELECT id, nombre, telefono, nota AS observaciones FROM clientes WHERE id = ?",
      [ins.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error("❌ Error crear cliente mayorista:", e);
    res.status(500).json({ error: "Error al crear cliente" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /mayorista/pedidos
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pedidos", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const { estado, cliente_id, page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const offset = (pageNum - 1) * limitNum;

  const ESTADOS_VALIDOS = ["pendiente", "confirmado", "cancelado"];

  try {
    const where = [];
    const params = [];

    if (rol !== "admin") {
      where.push("pm.sucursal_id = ?");
      params.push(Number(sucursalId));
    }
    if (estado && ESTADOS_VALIDOS.includes(estado)) {
      where.push("pm.estado = ?");
      params.push(estado);
    }
    if (cliente_id && Number(cliente_id) > 0) {
      where.push("pm.cliente_id = ?");
      params.push(Number(cliente_id));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await pool.promise().query(
      `SELECT COUNT(*) AS total FROM pedidos_mayoristas pm ${whereSql}`,
      params
    );

    const [rows] = await pool.promise().query(
      `SELECT
        pm.id, pm.estado, pm.tipo_cambio, pm.total_usd, pm.total_ars,
        pm.notas, pm.fecha_creacion, pm.fecha_confirmacion,
        c.id AS cliente_id, c.nombre AS cliente_nombre, c.telefono AS cliente_telefono,
        s.nombre AS sucursal_nombre
       FROM pedidos_mayoristas pm
       JOIN clientes   c ON c.id = pm.cliente_id
       JOIN sucursales s ON s.id = pm.sucursal_id
       ${whereSql}
       ORDER BY pm.fecha_creacion DESC
       LIMIT ? OFFSET ?`,
      [...params, limitNum, offset]
    );

    res.json({ data: rows, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) });
  } catch (e) {
    console.error("❌ Error listar pedidos mayoristas:", e);
    res.status(500).json({ error: "Error al obtener pedidos" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /mayorista/pedidos/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pedidos/:id", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const pedidoId = Number(req.params.id);
  if (!pedidoId) return res.status(400).json({ error: "ID inválido" });

  try {
    let sql = `
      SELECT pm.id, pm.estado, pm.tipo_cambio, pm.total_usd, pm.total_ars,
             pm.notas, pm.fecha_creacion, pm.fecha_confirmacion,
             c.id AS cliente_id, c.nombre AS cliente_nombre, c.telefono AS cliente_telefono,
             s.id AS sucursal_id, s.nombre AS sucursal_nombre
      FROM pedidos_mayoristas pm
      JOIN clientes   c ON c.id = pm.cliente_id
      JOIN sucursales s ON s.id = pm.sucursal_id
      WHERE pm.id = ?`;
    const params = [pedidoId];

    if (rol !== "admin") {
      sql += " AND pm.sucursal_id = ?";
      params.push(Number(sucursalId));
    }

    const [pedidos] = await pool.promise().query(sql, params);
    if (!pedidos.length) return res.status(404).json({ error: "Pedido no encontrado" });

    const pedido = pedidos[0];

    const [items] = await pool.promise().query(
      `SELECT pmi.id, pmi.gusto_id, pmi.cantidad, pmi.precio_usd,
              g.nombre AS gusto, p.nombre AS producto_nombre, g.codigo_barra
       FROM pedido_mayorista_items pmi
       JOIN gustos   g ON g.id = pmi.gusto_id
       JOIN productos p ON p.id = g.producto_id
       WHERE pmi.pedido_id = ?`,
      [pedidoId]
    );

    res.json({ ...pedido, items });
  } catch (e) {
    console.error("❌ Error obtener pedido:", e);
    res.status(500).json({ error: "Error al obtener pedido" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /mayorista/pedidos  — crea borrador
// ─────────────────────────────────────────────────────────────────────────────
router.post("/pedidos", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const { cliente_id, tipo_cambio, notas, items } = req.body;

  // ── Validaciones previas ──
  if (!cliente_id) return res.status(400).json({ error: "cliente_id requerido" });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "El pedido debe tener al menos un ítem" });

  const tipoCambio = parseFloat(tipo_cambio) || 0;
  if (tipoCambio < 0) return res.status(400).json({ error: "El tipo de cambio no puede ser negativo" });

  // ── Validar ítems antes de tocar la DB ──
  const itemsInvalidos = items.filter(
    (it) => !Number(it.gusto_id) || parseInt(it.cantidad) <= 0 || parseFloat(it.precio_usd) <= 0
  );
  if (itemsInvalidos.length > 0)
    return res.status(400).json({ error: `${itemsInvalidos.length} ítem(s) inválido(s): cantidad y precio deben ser > 0` });

  // ── Sucursal ──
  let sucursalFinal;
  if (rol === "admin") {
    sucursalFinal = Number(req.body.sucursal_id);
    if (!sucursalFinal) return res.status(400).json({ error: "sucursal_id requerido para admin" });
  } else {
    sucursalFinal = Number(sucursalId);
  }

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // ── Validar cliente mayorista ──
    const [clienteRows] = await conn.query(
      "SELECT id FROM clientes WHERE id = ? AND es_mayorista = 1",
      [Number(cliente_id)]
    );
    if (!clienteRows.length) {
      await conn.rollback();
      return res.status(400).json({ error: "Cliente no encontrado o no es mayorista" });
    }

    const { totalUsd, totalArs } = calcularTotales(items, tipoCambio);

    const [ins] = await conn.query(
      `INSERT INTO pedidos_mayoristas
         (cliente_id, sucursal_id, estado, tipo_cambio, total_usd, total_ars, notas, creado_por, fecha_creacion)
       VALUES (?, ?, 'pendiente', ?, ?, ?, ?, ?, ?)`,
      [Number(cliente_id), sucursalFinal, tipoCambio, totalUsd, totalArs, notas || null, req.user.id || null, nowMysql()]
    );
    const pedidoId = ins.insertId;

    for (const it of items) {
      await conn.query(
        "INSERT INTO pedido_mayorista_items (pedido_id, gusto_id, cantidad, precio_usd) VALUES (?, ?, ?, ?)",
        [pedidoId, Number(it.gusto_id), parseInt(it.cantidad), round2(it.precio_usd)]
      );
    }

    await conn.commit();
    res.status(201).json({ id: pedidoId, mensaje: "Pedido creado" });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error crear pedido mayorista:", e);
    res.status(500).json({ error: "Error al crear pedido" });
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /mayorista/pedidos/:id  — actualiza borrador
// ─────────────────────────────────────────────────────────────────────────────
router.put("/pedidos/:id", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const pedidoId = Number(req.params.id);
  const { cliente_id, tipo_cambio, notas, items } = req.body;

  if (!pedidoId) return res.status(400).json({ error: "ID inválido" });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "El pedido debe tener al menos un ítem" });

  const tipoCambio = parseFloat(tipo_cambio) || 0;
  if (tipoCambio < 0) return res.status(400).json({ error: "El tipo de cambio no puede ser negativo" });

  const itemsInvalidos = items.filter(
    (it) => !Number(it.gusto_id) || parseInt(it.cantidad) <= 0 || parseFloat(it.precio_usd) <= 0
  );
  if (itemsInvalidos.length > 0)
    return res.status(400).json({ error: `${itemsInvalidos.length} ítem(s) inválido(s): cantidad y precio deben ser > 0` });

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // ── Verificar pedido ──
    let checkSql = "SELECT id, sucursal_id FROM pedidos_mayoristas WHERE id = ? AND estado = 'pendiente'";
    const checkParams = [pedidoId];
    if (rol !== "admin") {
      checkSql += " AND sucursal_id = ?";
      checkParams.push(Number(sucursalId));
    }
    const [pedidos] = await conn.query(checkSql, checkParams);
    if (!pedidos.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Pedido no encontrado o no está pendiente" });
    }

    // ── Validar cliente si se cambia ──
    if (cliente_id) {
      const [clienteRows] = await conn.query(
        "SELECT id FROM clientes WHERE id = ? AND es_mayorista = 1",
        [Number(cliente_id)]
      );
      if (!clienteRows.length) {
        await conn.rollback();
        return res.status(400).json({ error: "Cliente no encontrado o no es mayorista" });
      }
    }

    const { totalUsd, totalArs } = calcularTotales(items, tipoCambio);

    await conn.query(
      `UPDATE pedidos_mayoristas
       SET cliente_id = COALESCE(?, cliente_id), tipo_cambio = ?, total_usd = ?, total_ars = ?, notas = ?
       WHERE id = ?`,
      [cliente_id ? Number(cliente_id) : null, tipoCambio, totalUsd, totalArs, notas || null, pedidoId]
    );

    await conn.query("DELETE FROM pedido_mayorista_items WHERE pedido_id = ?", [pedidoId]);

    for (const it of items) {
      await conn.query(
        "INSERT INTO pedido_mayorista_items (pedido_id, gusto_id, cantidad, precio_usd) VALUES (?, ?, ?, ?)",
        [pedidoId, Number(it.gusto_id), parseInt(it.cantidad), round2(it.precio_usd)]
      );
    }

    await conn.commit();
    res.json({ mensaje: "Pedido actualizado" });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error actualizar pedido mayorista:", e);
    res.status(500).json({ error: "Error al actualizar pedido" });
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /mayorista/pedidos/:id/confirmar
// ─────────────────────────────────────────────────────────────────────────────
router.post("/pedidos/:id/confirmar", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const pedidoId = Number(req.params.id);
  if (!pedidoId) return res.status(400).json({ error: "ID inválido" });

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // ── Obtener y lockear el pedido ──
    let sql = `SELECT id, sucursal_id FROM pedidos_mayoristas
               WHERE id = ? AND estado = 'pendiente' FOR UPDATE`;
    const params = [pedidoId];
    if (rol !== "admin") {
      sql = `SELECT id, sucursal_id FROM pedidos_mayoristas
             WHERE id = ? AND estado = 'pendiente' AND sucursal_id = ? FOR UPDATE`;
      params.push(Number(sucursalId));
    }

    const [pedidos] = await conn.query(sql, params);
    if (!pedidos.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Pedido no encontrado o ya fue procesado" });
    }
    const pedido = pedidos[0];

    const [items] = await conn.query(
      `SELECT pmi.gusto_id, pmi.cantidad, g.nombre AS gusto, p.nombre AS producto
       FROM pedido_mayorista_items pmi
       JOIN gustos   g ON g.id = pmi.gusto_id
       JOIN productos p ON p.id = g.producto_id
       WHERE pmi.pedido_id = ?`,
      [pedidoId]
    );
    if (!items.length) {
      await conn.rollback();
      return res.status(400).json({ error: "El pedido no tiene ítems" });
    }

    // ── Descontar stock — atómico con affectedRows ──
    for (const item of items) {
      // Verificar si el producto existe en stock de esta sucursal
      const [existe] = await conn.query(
        "SELECT cantidad FROM stock WHERE gusto_id = ? AND sucursal_id = ?",
        [item.gusto_id, pedido.sucursal_id]
      );

      if (!existe.length) {
        await conn.rollback();
        return res.status(400).json({
          error: `"${item.producto} — ${item.gusto}" no está registrado en esta sucursal`,
        });
      }

      if (existe[0].cantidad < item.cantidad) {
        await conn.rollback();
        return res.status(400).json({
          error: `Stock insuficiente para "${item.producto} — ${item.gusto}": hay ${existe[0].cantidad} u., se necesitan ${item.cantidad}`,
        });
      }

      // UPDATE atómico: solo descuenta si la cantidad sigue siendo suficiente
      const [upd] = await conn.query(
        "UPDATE stock SET cantidad = cantidad - ? WHERE gusto_id = ? AND sucursal_id = ? AND cantidad >= ?",
        [item.cantidad, item.gusto_id, pedido.sucursal_id, item.cantidad]
      );

      if (!upd.affectedRows) {
        await conn.rollback();
        return res.status(400).json({
          error: `Stock insuficiente para "${item.producto} — ${item.gusto}" (modificado por otra operación concurrente)`,
        });
      }
    }

    // ── Marcar como confirmado con timestamp JS ──
    await conn.query(
      "UPDATE pedidos_mayoristas SET estado = 'confirmado', fecha_confirmacion = ? WHERE id = ?",
      [nowMysql(), pedidoId]
    );

    await conn.commit();
    res.json({ mensaje: "Pedido confirmado y stock descontado" });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error confirmar pedido mayorista:", e);
    res.status(500).json({ error: "Error al confirmar pedido" });
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /mayorista/pedidos/:id  — cancela
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/pedidos/:id", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const pedidoId = Number(req.params.id);
  if (!pedidoId) return res.status(400).json({ error: "ID inválido" });

  try {
    let sql = "UPDATE pedidos_mayoristas SET estado = 'cancelado' WHERE id = ? AND estado = 'pendiente'";
    const params = [pedidoId];
    if (rol !== "admin") {
      sql += " AND sucursal_id = ?";
      params.push(Number(sucursalId));
    }
    const [result] = await pool.promise().query(sql, params);
    if (!result.affectedRows)
      return res.status(404).json({ error: "Pedido no encontrado o ya procesado" });
    res.json({ mensaje: "Pedido cancelado" });
  } catch (e) {
    console.error("❌ Error cancelar pedido mayorista:", e);
    res.status(500).json({ error: "Error al cancelar pedido" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /mayorista/stats  — dashboard admin
// ─────────────────────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  if (req.user.rol !== "admin") return res.status(403).json({ error: "Solo admin" });

  const { desde, hasta } = req.query;

  const where = ["pm.estado = 'confirmado'"];
  const params = [];

  if (desde) {
    if (!esDateValida(desde)) return res.status(400).json({ error: "Formato de fecha 'desde' inválido (YYYY-MM-DD)" });
    where.push("DATE(pm.fecha_confirmacion) >= ?");
    params.push(desde);
  }
  if (hasta) {
    if (!esDateValida(hasta)) return res.status(400).json({ error: "Formato de fecha 'hasta' inválido (YYYY-MM-DD)" });
    where.push("DATE(pm.fecha_confirmacion) <= ?");
    params.push(hasta);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  try {
    const db = pool.promise();

    const [
      [[totales]],
      [porCliente],
      [porMes],
      [porProducto],
      [[pendientes]],
    ] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS total_pedidos, COALESCE(SUM(pm.total_usd),0) AS total_usd,
                COALESCE(SUM(pm.total_ars),0) AS total_ars,
                COUNT(DISTINCT pm.cliente_id) AS clientes_unicos
         FROM pedidos_mayoristas pm ${whereSql}`,
        params
      ),
      db.query(
        `SELECT c.nombre AS cliente, COUNT(pm.id) AS pedidos, SUM(pm.total_usd) AS total_usd
         FROM pedidos_mayoristas pm
         JOIN clientes c ON c.id = pm.cliente_id
         ${whereSql}
         GROUP BY pm.cliente_id, c.nombre
         ORDER BY total_usd DESC LIMIT 10`,
        params
      ),
      db.query(
        `SELECT DATE_FORMAT(pm.fecha_confirmacion,'%Y-%m') AS mes,
                COUNT(pm.id) AS pedidos,
                SUM(pm.total_usd) AS total_usd, SUM(pm.total_ars) AS total_ars
         FROM pedidos_mayoristas pm ${whereSql}
         GROUP BY mes ORDER BY mes DESC LIMIT 12`,
        params
      ),
      db.query(
        `SELECT p.nombre AS producto, g.nombre AS gusto,
                SUM(pmi.cantidad) AS total_unidades,
                SUM(pmi.cantidad * pmi.precio_usd) AS total_usd
         FROM pedido_mayorista_items pmi
         JOIN pedidos_mayoristas pm ON pm.id = pmi.pedido_id
         JOIN gustos   g ON g.id = pmi.gusto_id
         JOIN productos p ON p.id = g.producto_id
         ${whereSql}
         GROUP BY pmi.gusto_id, p.nombre, g.nombre
         ORDER BY total_unidades DESC LIMIT 10`,
        params
      ),
      db.query("SELECT COUNT(*) AS total FROM pedidos_mayoristas WHERE estado = 'pendiente'"),
    ]);

    const ticketPromedio = Number(totales.total_pedidos) > 0
      ? round2(Number(totales.total_usd) / Number(totales.total_pedidos))
      : 0;

    res.json({
      totales: { ...totales, ticket_promedio: ticketPromedio },
      porCliente,
      porMes,
      porProducto,
      pendientes: Number(pendientes.total),
    });
  } catch (e) {
    console.error("❌ Error stats mayorista:", e);
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
});

module.exports = router;

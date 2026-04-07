const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

router.use(authenticate);

// ─────────────────────────────────────────
// GET /mayorista/clientes
// Lista clientes mayoristas
// ─────────────────────────────────────────
router.get("/clientes", async (req, res) => {
  const { q } = req.query;
  try {
    let sql = `
      SELECT id, nombre, telefono, nota AS observaciones
      FROM clientes
      WHERE es_mayorista = 1
    `;
    const params = [];
    if (q) {
      sql += " AND (nombre LIKE ? OR telefono LIKE ?)";
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY nombre ASC";
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error clientes mayoristas:", e);
    res.status(500).json({ error: "Error al obtener clientes" });
  }
});

// ─────────────────────────────────────────
// POST /mayorista/clientes
// Crea un cliente mayorista
// ─────────────────────────────────────────
router.post("/clientes", async (req, res) => {
  const { nombre, telefono, observaciones } = req.body;
  if (!nombre) return res.status(400).json({ error: "El nombre es obligatorio" });
  try {
    const [ins] = await pool.promise().query(
      `INSERT INTO clientes (nombre, telefono, telefono_normalizado, nota, es_mayorista, acepta, estado, source)
       VALUES (?, ?, ?, ?, 1, 1, 'nuevo', 'web')`,
      [
        String(nombre).trim(),
        String(telefono || "").trim(),
        String(telefono || "").replace(/\D/g, ""),
        observaciones || null,
      ]
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

// ─────────────────────────────────────────
// GET /mayorista/pedidos
// Lista pedidos (admin: todos; sucursal: solo los suyos)
// Query params: estado, page, limit
// ─────────────────────────────────────────
router.get("/pedidos", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const { estado, page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
  const offset = (pageNum - 1) * limitNum;

  try {
    const where = [];
    const params = [];

    if (rol !== "admin") {
      where.push("pm.sucursal_id = ?");
      params.push(Number(sucursalId));
    }
    if (estado) {
      where.push("pm.estado = ?");
      params.push(estado);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await pool.promise().query(
      `SELECT COUNT(*) AS total FROM pedidos_mayoristas pm ${whereSql}`,
      params
    );

    const sql = `
      SELECT
        pm.id,
        pm.estado,
        pm.tipo_cambio,
        pm.total_usd,
        pm.total_ars,
        pm.notas,
        pm.fecha_creacion,
        pm.fecha_confirmacion,
        c.id   AS cliente_id,
        c.nombre AS cliente_nombre,
        c.telefono AS cliente_telefono,
        s.nombre AS sucursal_nombre
      FROM pedidos_mayoristas pm
      JOIN clientes   c ON c.id = pm.cliente_id
      JOIN sucursales s ON s.id = pm.sucursal_id
      ${whereSql}
      ORDER BY pm.fecha_creacion DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.promise().query(sql, [...params, limitNum, offset]);

    res.json({
      data: rows,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (e) {
    console.error("❌ Error listar pedidos mayoristas:", e);
    res.status(500).json({ error: "Error al obtener pedidos" });
  }
});

// ─────────────────────────────────────────
// GET /mayorista/pedidos/:id
// Pedido con sus ítems
// ─────────────────────────────────────────
router.get("/pedidos/:id", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const pedidoId = Number(req.params.id);

  try {
    let sql = `
      SELECT
        pm.id,
        pm.estado,
        pm.tipo_cambio,
        pm.total_usd,
        pm.total_ars,
        pm.notas,
        pm.fecha_creacion,
        pm.fecha_confirmacion,
        c.id   AS cliente_id,
        c.nombre AS cliente_nombre,
        c.telefono AS cliente_telefono,
        s.id   AS sucursal_id,
        s.nombre AS sucursal_nombre
      FROM pedidos_mayoristas pm
      JOIN clientes   c ON c.id = pm.cliente_id
      JOIN sucursales s ON s.id = pm.sucursal_id
      WHERE pm.id = ?
    `;
    const params = [pedidoId];

    if (rol !== "admin") {
      sql += " AND pm.sucursal_id = ?";
      params.push(Number(sucursalId));
    }

    const [pedidos] = await pool.promise().query(sql, params);
    if (!pedidos.length) {
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    const [items] = await pool.promise().query(
      `SELECT
        pmi.id,
        pmi.gusto_id,
        pmi.cantidad,
        pmi.precio_usd,
        g.nombre   AS gusto,
        p.nombre   AS producto_nombre,
        g.codigo_barra
      FROM pedido_mayorista_items pmi
      JOIN gustos   g ON g.id = pmi.gusto_id
      JOIN productos p ON p.id = g.producto_id
      WHERE pmi.pedido_id = ?`,
      [pedidoId]
    );

    res.json({ ...pedidos[0], items });
  } catch (e) {
    console.error("❌ Error obtener pedido:", e);
    res.status(500).json({ error: "Error al obtener pedido" });
  }
});

// ─────────────────────────────────────────
// POST /mayorista/pedidos
// Crea borrador de pedido con sus ítems
// Body: { cliente_id, tipo_cambio, notas, items: [{gusto_id, cantidad, precio_usd}] }
// ─────────────────────────────────────────
router.post("/pedidos", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const { cliente_id, tipo_cambio, notas, items } = req.body;

  if (!cliente_id) return res.status(400).json({ error: "cliente_id requerido" });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "El pedido debe tener al menos un ítem" });

  const tipoCambio = parseFloat(tipo_cambio) || 0;

  // sucursal fija: si es admin debe mandar sucursal_id, si es sucursal usa la suya
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

    // Calcular totales
    let totalUsd = 0;
    for (const it of items) {
      totalUsd += (parseFloat(it.precio_usd) || 0) * (parseInt(it.cantidad) || 0);
    }
    const totalArs = tipoCambio > 0 ? totalUsd * tipoCambio : 0;

    const [ins] = await conn.query(
      `INSERT INTO pedidos_mayoristas
         (cliente_id, sucursal_id, estado, tipo_cambio, total_usd, total_ars, notas, creado_por, fecha_creacion)
       VALUES (?, ?, 'pendiente', ?, ?, ?, ?, ?, NOW())`,
      [
        Number(cliente_id),
        sucursalFinal,
        tipoCambio,
        totalUsd,
        totalArs,
        notas || null,
        req.user.id || null,
      ]
    );
    const pedidoId = ins.insertId;

    for (const it of items) {
      const gustoId = Number(it.gusto_id);
      const cantidad = parseInt(it.cantidad) || 0;
      const precioUsd = parseFloat(it.precio_usd) || 0;
      if (!gustoId || cantidad <= 0 || precioUsd < 0) continue;

      await conn.query(
        "INSERT INTO pedido_mayorista_items (pedido_id, gusto_id, cantidad, precio_usd) VALUES (?, ?, ?, ?)",
        [pedidoId, gustoId, cantidad, precioUsd]
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

// ─────────────────────────────────────────
// PUT /mayorista/pedidos/:id
// Actualiza un pedido pendiente (ítems, tipo_cambio, notas)
// Reemplaza todos los ítems
// ─────────────────────────────────────────
router.put("/pedidos/:id", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const pedidoId = Number(req.params.id);
  const { cliente_id, tipo_cambio, notas, items } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "El pedido debe tener al menos un ítem" });

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // Verificar que el pedido existe y está pendiente
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

    const tipoCambio = parseFloat(tipo_cambio) || 0;
    let totalUsd = 0;
    for (const it of items) {
      totalUsd += (parseFloat(it.precio_usd) || 0) * (parseInt(it.cantidad) || 0);
    }
    const totalArs = tipoCambio > 0 ? totalUsd * tipoCambio : 0;

    await conn.query(
      `UPDATE pedidos_mayoristas
       SET cliente_id = ?, tipo_cambio = ?, total_usd = ?, total_ars = ?, notas = ?
       WHERE id = ?`,
      [Number(cliente_id), tipoCambio, totalUsd, totalArs, notas || null, pedidoId]
    );

    // Reemplazar ítems
    await conn.query("DELETE FROM pedido_mayorista_items WHERE pedido_id = ?", [pedidoId]);

    for (const it of items) {
      const gustoId = Number(it.gusto_id);
      const cantidad = parseInt(it.cantidad) || 0;
      const precioUsd = parseFloat(it.precio_usd) || 0;
      if (!gustoId || cantidad <= 0 || precioUsd < 0) continue;

      await conn.query(
        "INSERT INTO pedido_mayorista_items (pedido_id, gusto_id, cantidad, precio_usd) VALUES (?, ?, ?, ?)",
        [pedidoId, gustoId, cantidad, precioUsd]
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

// ─────────────────────────────────────────
// POST /mayorista/pedidos/:id/confirmar
// Confirma el pedido: descuenta stock de cada ítem
// ─────────────────────────────────────────
router.post("/pedidos/:id/confirmar", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const pedidoId = Number(req.params.id);

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // Obtener pedido con lock
    let sql = `SELECT pm.id, pm.sucursal_id, pm.estado
               FROM pedidos_mayoristas pm
               WHERE pm.id = ? AND pm.estado = 'pendiente'`;
    const params = [pedidoId];
    if (rol !== "admin") {
      sql += " AND pm.sucursal_id = ?";
      params.push(Number(sucursalId));
    }

    const [pedidos] = await conn.query(sql, params);
    if (!pedidos.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Pedido no encontrado o ya fue procesado" });
    }

    const pedido = pedidos[0];

    // Obtener ítems
    const [items] = await conn.query(
      "SELECT gusto_id, cantidad FROM pedido_mayorista_items WHERE pedido_id = ?",
      [pedidoId]
    );

    if (!items.length) {
      await conn.rollback();
      return res.status(400).json({ error: "El pedido no tiene ítems" });
    }

    // Descontar stock de cada ítem (con lock FOR UPDATE)
    for (const item of items) {
      const [stockRows] = await conn.query(
        "SELECT cantidad FROM stock WHERE gusto_id = ? AND sucursal_id = ? FOR UPDATE",
        [item.gusto_id, pedido.sucursal_id]
      );

      if (!stockRows.length) {
        await conn.rollback();
        return res.status(400).json({
          error: `Sin stock registrado para gusto_id ${item.gusto_id} en esta sucursal`,
        });
      }

      if (stockRows[0].cantidad < item.cantidad) {
        await conn.rollback();
        return res.status(400).json({
          error: `Stock insuficiente para gusto_id ${item.gusto_id} (disponible: ${stockRows[0].cantidad}, pedido: ${item.cantidad})`,
        });
      }

      await conn.query(
        "UPDATE stock SET cantidad = cantidad - ? WHERE gusto_id = ? AND sucursal_id = ?",
        [item.cantidad, item.gusto_id, pedido.sucursal_id]
      );
    }

    // Marcar pedido como confirmado
    await conn.query(
      "UPDATE pedidos_mayoristas SET estado = 'confirmado', fecha_confirmacion = NOW() WHERE id = ?",
      [pedidoId]
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

// ─────────────────────────────────────────
// DELETE /mayorista/pedidos/:id
// Cancela/elimina un pedido pendiente
// ─────────────────────────────────────────
router.delete("/pedidos/:id", async (req, res) => {
  const { rol, sucursalId } = req.user;
  const pedidoId = Number(req.params.id);

  try {
    let sql = `UPDATE pedidos_mayoristas SET estado = 'cancelado'
               WHERE id = ? AND estado = 'pendiente'`;
    const params = [pedidoId];
    if (rol !== "admin") {
      sql += " AND sucursal_id = ?";
      params.push(Number(sucursalId));
    }
    const [result] = await pool.promise().query(sql, params);
    if (!result.affectedRows) {
      return res.status(404).json({ error: "Pedido no encontrado o ya procesado" });
    }
    res.json({ mensaje: "Pedido cancelado" });
  } catch (e) {
    console.error("❌ Error cancelar pedido mayorista:", e);
    res.status(500).json({ error: "Error al cancelar pedido" });
  }
});

// ─────────────────────────────────────────
// GET /mayorista/stats
// Estadísticas para el dashboard admin
// Query: desde, hasta (YYYY-MM-DD)
// ─────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const { rol } = req.user;
  if (rol !== "admin") return res.status(403).json({ error: "Solo admin" });

  const { desde, hasta } = req.query;
  try {
    const where = ["pm.estado = 'confirmado'"];
    const params = [];
    if (desde) { where.push("DATE(pm.fecha_confirmacion) >= ?"); params.push(desde); }
    if (hasta) { where.push("DATE(pm.fecha_confirmacion) <= ?"); params.push(hasta); }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [[totales]] = await pool.promise().query(
      `SELECT
        COUNT(*)           AS total_pedidos,
        SUM(pm.total_usd)  AS total_usd,
        SUM(pm.total_ars)  AS total_ars,
        COUNT(DISTINCT pm.cliente_id) AS clientes_unicos
       FROM pedidos_mayoristas pm ${whereSql}`,
      params
    );

    const [porCliente] = await pool.promise().query(
      `SELECT
        c.nombre AS cliente,
        COUNT(pm.id)       AS pedidos,
        SUM(pm.total_usd)  AS total_usd
       FROM pedidos_mayoristas pm
       JOIN clientes c ON c.id = pm.cliente_id
       ${whereSql}
       GROUP BY pm.cliente_id, c.nombre
       ORDER BY total_usd DESC
       LIMIT 10`,
      params
    );

    const [porMes] = await pool.promise().query(
      `SELECT
        DATE_FORMAT(pm.fecha_confirmacion, '%Y-%m') AS mes,
        COUNT(pm.id)       AS pedidos,
        SUM(pm.total_usd)  AS total_usd,
        SUM(pm.total_ars)  AS total_ars
       FROM pedidos_mayoristas pm
       ${whereSql}
       GROUP BY mes
       ORDER BY mes DESC
       LIMIT 12`,
      params
    );

    res.json({ totales, porCliente, porMes });
  } catch (e) {
    console.error("❌ Error stats mayorista:", e);
    res.status(500).json({ error: "Error al obtener estadísticas" });
  }
});

module.exports = router;

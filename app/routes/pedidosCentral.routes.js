const express    = require("express");
const router     = express.Router();
const pool       = require("../db");
const authenticate = require("../middlewares/authenticate");

const CENTRAL_ID = 7;

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo administradores" });
  next();
};

/**
 * POST /pedidos-central
 * Público — lo llama el catálogo cuando el usuario envía su pedido por WhatsApp.
 * Body: { items: [{gusto_id, modelo, gusto, qty, precio}], total, notas? }
 */
router.post("/pedidos-central", async (req, res) => {
  const { items, total, notas } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "El pedido no tiene items" });

  // Validar que cada item tenga lo mínimo
  for (const item of items) {
    if (!item.gusto_id || !item.qty || item.qty < 1)
      return res.status(400).json({ error: "Item inválido en el pedido" });
  }

  try {
    const [result] = await pool.promise().query(
      `INSERT INTO pedidos_central (items, total, notas) VALUES (?, ?, ?)`,
      [JSON.stringify(items), Number(total) || 0, notas || null]
    );
    res.status(201).json({ ok: true, id: result.insertId });
  } catch (e) {
    console.error("❌ POST /pedidos-central:", e);
    res.status(500).json({ error: "Error al guardar el pedido" });
  }
});

/**
 * GET /pedidos-central
 * Admin — lista de pedidos, por defecto muestra pendientes primero.
 * Query: ?estado=pendiente|confirmado|cancelado|todos
 */
router.get("/pedidos-central", authenticate, soloAdmin, async (req, res) => {
  const { estado = "pendiente", page = 1, limit = 50 } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));

  const whereEstado = estado === "todos" ? "" : "WHERE estado = ?";
  const params      = estado === "todos" ? [] : [estado];

  try {
    const [[{ total }]] = await pool.promise().query(
      `SELECT COUNT(*) AS total FROM pedidos_central ${whereEstado}`,
      params
    );

    const [rows] = await pool.promise().query(
      `SELECT id, estado, items, total, notas, fecha_creacion, fecha_confirmacion
       FROM pedidos_central
       ${whereEstado}
       ORDER BY estado = 'pendiente' DESC, fecha_creacion DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // Parsear items si vienen como string
    const data = rows.map((r) => ({
      ...r,
      items: typeof r.items === "string" ? JSON.parse(r.items) : r.items,
    }));

    res.json({ data, total, totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (e) {
    console.error("❌ GET /pedidos-central:", e);
    res.status(500).json({ error: "Error al obtener pedidos" });
  }
});

/**
 * GET /pedidos-central/:id
 * Admin — detalle de un pedido.
 */
router.get("/pedidos-central/:id", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.promise().query(
      "SELECT * FROM pedidos_central WHERE id = ?",
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });

    const items = typeof row.items === "string" ? JSON.parse(row.items) : row.items;

    // Enriquecer con stock actual
    const itemsConStock = await Promise.all(
      items.map(async (item) => {
        const [[st]] = await pool.promise().query(
          "SELECT cantidad AS stock_actual, precio FROM stock WHERE gusto_id = ? AND sucursal_id = ?",
          [item.gusto_id, CENTRAL_ID]
        );
        return { ...item, stock_actual: st?.stock_actual ?? 0 };
      })
    );

    res.json({ ...row, items: itemsConStock });
  } catch (e) {
    console.error("❌ GET /pedidos-central/:id:", e);
    res.status(500).json({ error: "Error al obtener el pedido" });
  }
});

/**
 * POST /pedidos-central/:id/confirmar
 * Admin — confirma el pedido: genera ventas y descuenta stock.
 */
router.post("/pedidos-central/:id/confirmar", authenticate, soloAdmin, async (req, res) => {
  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [[pedido]] = await conn.query(
      "SELECT * FROM pedidos_central WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!pedido)
      return conn.rollback().then(() => { conn.release(); res.status(404).json({ error: "Pedido no encontrado" }); });
    if (pedido.estado !== "pendiente")
      return conn.rollback().then(() => { conn.release(); res.status(400).json({ error: "El pedido ya fue procesado" }); });

    const items = typeof pedido.items === "string" ? JSON.parse(pedido.items) : pedido.items;

    for (const item of items) {
      // Verificar stock
      const [[st]] = await conn.query(
        "SELECT cantidad FROM stock WHERE gusto_id = ? AND sucursal_id = ? FOR UPDATE",
        [item.gusto_id, CENTRAL_ID]
      );
      if (!st) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ error: `Sin stock registrado para: ${item.modelo} - ${item.gusto}` });
      }
      if (st.cantidad < item.qty) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({
          error: `Stock insuficiente para ${item.modelo} - ${item.gusto}. Disponible: ${st.cantidad}, pedido: ${item.qty}`,
        });
      }

      // Descontar stock
      await conn.query(
        "UPDATE stock SET cantidad = cantidad - ? WHERE gusto_id = ? AND sucursal_id = ?",
        [item.qty, item.gusto_id, CENTRAL_ID]
      );

      // Registrar venta
      await conn.query(
        `INSERT INTO ventas (gusto_id, sucursal_id, sucursal_stock_id, vendedor_id, cantidad, precio_unitario, fecha)
         VALUES (?, ?, ?, NULL, ?, ?, NOW())`,
        [item.gusto_id, CENTRAL_ID, CENTRAL_ID, item.qty, item.precio || 0]
      );
    }

    // Actualizar pedido
    await conn.query(
      "UPDATE pedidos_central SET estado = 'confirmado', fecha_confirmacion = NOW(), confirmado_por = ? WHERE id = ?",
      [req.user.id, req.params.id]
    );

    await conn.commit();
    res.json({ ok: true, mensaje: "Pedido confirmado — stock actualizado y ventas registradas" });
  } catch (e) {
    await conn.rollback();
    console.error("❌ POST /pedidos-central/:id/confirmar:", e);
    res.status(500).json({ error: "Error al confirmar el pedido" });
  } finally {
    conn.release();
  }
});

/**
 * PATCH /pedidos-central/:id/cancelar
 * Admin — cancela un pedido pendiente.
 */
router.patch("/pedidos-central/:id/cancelar", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[pedido]] = await pool.promise().query(
      "SELECT estado FROM pedidos_central WHERE id = ?",
      [req.params.id]
    );
    if (!pedido) return res.status(404).json({ error: "Pedido no encontrado" });
    if (pedido.estado !== "pendiente")
      return res.status(400).json({ error: "Solo se pueden cancelar pedidos pendientes" });

    await pool.promise().query(
      "UPDATE pedidos_central SET estado = 'cancelado' WHERE id = ?",
      [req.params.id]
    );
    res.json({ ok: true, mensaje: "Pedido cancelado" });
  } catch (e) {
    console.error("❌ PATCH /pedidos-central/:id/cancelar:", e);
    res.status(500).json({ error: "Error al cancelar el pedido" });
  }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo administradores" });
  next();
};

// GET /ordenes-reposicion — lista paginada
router.get("/", authenticate, soloAdmin, async (req, res) => {
  const { page = 1, limit = 30, estado } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const whereEstado = estado ? "WHERE o.estado = ?" : "";
    const params = estado ? [estado] : [];

    const [[{ total }]] = await pool.promise().query(
      `SELECT COUNT(*) AS total FROM ordenes_reposicion o ${whereEstado}`,
      params
    );

    const [rows] = await pool.promise().query(
      `SELECT o.id, o.estado, o.notas, o.fecha_creacion, o.fecha_confirmacion,
              s.nombre AS sucursal,
              (SELECT COUNT(*) FROM orden_reposicion_items WHERE orden_id = o.id) AS total_items,
              (SELECT SUM(cantidad) FROM orden_reposicion_items WHERE orden_id = o.id) AS total_unidades
       FROM ordenes_reposicion o
       JOIN sucursales s ON s.id = o.sucursal_id
       ${whereEstado}
       ORDER BY o.id DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ data: rows, total, totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al listar órdenes" });
  }
});

// GET /ordenes-reposicion/:id — detalle
router.get("/:id", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[orden]] = await pool.promise().query(
      `SELECT o.*, s.nombre AS sucursal
       FROM ordenes_reposicion o
       JOIN sucursales s ON s.id = o.sucursal_id
       WHERE o.id = ?`,
      [req.params.id]
    );
    if (!orden) return res.status(404).json({ error: "Orden no encontrada" });

    const [items] = await pool.promise().query(
      `SELECT i.id, i.gusto_id, i.cantidad,
              g.nombre AS gusto,
              p.nombre AS producto_nombre,
              COALESCE(st.cantidad, 0) AS stock_actual
       FROM orden_reposicion_items i
       JOIN gustos g ON g.id = i.gusto_id
       JOIN productos p ON p.id = g.producto_id
       LEFT JOIN stock st ON st.gusto_id = i.gusto_id AND st.sucursal_id = ?
       WHERE i.orden_id = ?`,
      [orden.sucursal_id, req.params.id]
    );

    res.json({ ...orden, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al cargar orden" });
  }
});

// POST /ordenes-reposicion — crear
router.post("/", authenticate, soloAdmin, async (req, res) => {
  const { sucursal_id, notas, items } = req.body;
  if (!sucursal_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Faltan datos: sucursal e ítems son obligatorios" });
  }
  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [[suc]] = await conn.query("SELECT id FROM sucursales WHERE id = ?", [sucursal_id]);
    if (!suc) { await conn.rollback(); return res.status(400).json({ error: "Sucursal no existe" }); }

    const [result] = await conn.query(
      "INSERT INTO ordenes_reposicion (sucursal_id, notas) VALUES (?, ?)",
      [sucursal_id, notas || null]
    );
    const ordenId = result.insertId;

    const itemsValidos = items.filter((i) => i.gusto_id && i.cantidad > 0);
    if (itemsValidos.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: "Ningún ítem válido" });
    }

    for (const item of itemsValidos) {
      await conn.query(
        "INSERT INTO orden_reposicion_items (orden_id, gusto_id, cantidad) VALUES (?, ?, ?)",
        [ordenId, item.gusto_id, item.cantidad]
      );
    }

    await conn.commit();
    res.json({ id: ordenId, mensaje: "Orden creada como pendiente" });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "Error al crear orden" });
  } finally {
    conn.release();
  }
});

// POST /ordenes-reposicion/:id/confirmar — aplica stock
router.post("/:id/confirmar", authenticate, soloAdmin, async (req, res) => {
  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [[orden]] = await conn.query(
      "SELECT * FROM ordenes_reposicion WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!orden) { await conn.rollback(); return res.status(404).json({ error: "Orden no encontrada" }); }
    if (orden.estado !== "pendiente") { await conn.rollback(); return res.status(400).json({ error: "La orden ya fue procesada" }); }

    const [items] = await conn.query(
      "SELECT * FROM orden_reposicion_items WHERE orden_id = ?",
      [req.params.id]
    );

    for (const item of items) {
      // Obtener precio actual para no perderlo si ya existe
      const [[existing]] = await conn.query(
        "SELECT precio FROM stock WHERE gusto_id = ? AND sucursal_id = ?",
        [item.gusto_id, orden.sucursal_id]
      );
      const precio = existing?.precio ?? 0;

      await conn.query(
        `INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad)`,
        [item.gusto_id, orden.sucursal_id, item.cantidad, precio]
      );

      // Registrar en historial de reposiciones
      await conn.query(
        "INSERT INTO reposiciones (gusto_id, sucursal_id, cantidad_repuesta, fecha) VALUES (?, ?, ?, NOW())",
        [item.gusto_id, orden.sucursal_id, item.cantidad]
      );
    }

    await conn.query(
      "UPDATE ordenes_reposicion SET estado = 'confirmada', fecha_confirmacion = NOW() WHERE id = ?",
      [req.params.id]
    );

    await conn.commit();
    res.json({ mensaje: "Orden confirmada — stock actualizado" });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "Error al confirmar orden" });
  } finally {
    conn.release();
  }
});

// DELETE /ordenes-reposicion/:id — cancelar
router.delete("/:id", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[orden]] = await pool.promise().query(
      "SELECT estado FROM ordenes_reposicion WHERE id = ?",
      [req.params.id]
    );
    if (!orden) return res.status(404).json({ error: "Orden no encontrada" });
    if (orden.estado !== "pendiente") return res.status(400).json({ error: "Solo se pueden cancelar órdenes pendientes" });

    await pool.promise().query(
      "UPDATE ordenes_reposicion SET estado = 'cancelada' WHERE id = ?",
      [req.params.id]
    );
    res.json({ mensaje: "Orden cancelada" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al cancelar orden" });
  }
});

module.exports = router;

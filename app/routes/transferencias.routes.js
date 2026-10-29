const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");
const { marcar, limpiar } = require("../movimientos");

function nowMysql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function soloAdmin(req, res, next) {
  if (req.user?.rol !== "admin")
    return res.status(403).json({ error: "Acceso denegado: solo administradores" });
  next();
}

// ── GET /transferencias — lista paginada ──────────────────────────────────────
router.get("/", authenticate, soloAdmin, async (req, res) => {
  const { estado, page = 1, limit = 30 } = req.query;
  const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

  try {
    const where = estado ? "WHERE t.estado = ?" : "";
    const params = estado ? [estado] : [];

    const [[{ total }]] = await pool.promise().query(
      `SELECT COUNT(*) AS total FROM transferencias_stock t ${where}`,
      params
    );

    const [rows] = await pool.promise().query(
      `SELECT t.*,
         so.nombre AS sucursal_origen,
         sd.nombre AS sucursal_destino,
         (SELECT COUNT(*) FROM transferencia_stock_items ti WHERE ti.transferencia_id = t.id) AS total_items,
         (SELECT COALESCE(SUM(ti2.cantidad),0) FROM transferencia_stock_items ti2 WHERE ti2.transferencia_id = t.id) AS total_unidades
       FROM transferencias_stock t
       JOIN sucursales so ON so.id = t.sucursal_origen_id
       JOIN sucursales sd ON sd.id = t.sucursal_destino_id
       ${where}
       ORDER BY t.fecha_creacion DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ data: rows, total, totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener transferencias" });
  }
});

// ── GET /transferencias/mias — las de la sucursal logueada ──────────────────
// Un punto de venta ve lo que le mandaron y lo que mandó, con los sabores, pero
// no puede crear, confirmar ni cancelar: eso sigue siendo del admin.
// Va antes de /:id para que "mias" no se lea como un id.
router.get("/mias", authenticate, async (req, res) => {
  const sucursalId = Number(req.user?.sucursalId);
  if (!sucursalId) return res.status(403).json({ error: "Tu usuario no tiene sucursal" });
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;

  try {
    const [[{ total }]] = await pool.promise().query(
      `SELECT COUNT(*) AS total FROM transferencias_stock
        WHERE (sucursal_origen_id = ? OR sucursal_destino_id = ?) AND estado <> 'cancelada'`,
      [sucursalId, sucursalId]
    );
    const [rows] = await pool.promise().query(
      `SELECT t.id, t.estado, t.notas, t.fecha_creacion, t.fecha_confirmacion,
              t.sucursal_origen_id, t.sucursal_destino_id,
              so.nombre AS sucursal_origen, sd.nombre AS sucursal_destino
         FROM transferencias_stock t
         JOIN sucursales so ON so.id = t.sucursal_origen_id
         JOIN sucursales sd ON sd.id = t.sucursal_destino_id
        WHERE (t.sucursal_origen_id = ? OR t.sucursal_destino_id = ?) AND t.estado <> 'cancelada'
        ORDER BY COALESCE(t.fecha_confirmacion, t.fecha_creacion) DESC
        LIMIT ? OFFSET ?`,
      [sucursalId, sucursalId, limit, (page - 1) * limit]
    );

    const ids = rows.map((r) => r.id);
    const [items] = ids.length
      ? await pool.promise().query(
          `SELECT ti.transferencia_id, ti.cantidad, g.nombre AS gusto, p.nombre AS producto_nombre
             FROM transferencia_stock_items ti
             JOIN gustos g ON g.id = ti.gusto_id
             JOIN productos p ON p.id = g.producto_id
            WHERE ti.transferencia_id IN (?)
            ORDER BY p.nombre, g.nombre`,
          [ids]
        )
      : [[]];

    const data = rows.map((t) => {
      const suyos = items.filter((i) => i.transferencia_id === t.id);
      return {
        ...t,
        entrada: t.sucursal_destino_id === sucursalId,
        unidades: suyos.reduce((s, i) => s + Number(i.cantidad), 0),
        items: suyos,
      };
    });
    res.json({ data, total, totalPages: Math.ceil(total / limit) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener tus transferencias" });
  }
});

// ── GET /transferencias/:id — detalle con items ───────────────────────────────
router.get("/:id", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[t]] = await pool.promise().query(
      `SELECT t.*,
         so.nombre AS sucursal_origen,
         sd.nombre AS sucursal_destino,
         sd.telefono AS telefono_destino
       FROM transferencias_stock t
       JOIN sucursales so ON so.id = t.sucursal_origen_id
       JOIN sucursales sd ON sd.id = t.sucursal_destino_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: "Transferencia no encontrada" });

    const [items] = await pool.promise().query(
      `SELECT ti.*,
         g.nombre AS gusto,
         p.nombre AS producto_nombre,
         COALESCE(s.cantidad, 0) AS stock_origen
       FROM transferencia_stock_items ti
       JOIN gustos g ON g.id = ti.gusto_id
       JOIN productos p ON p.id = g.producto_id
       LEFT JOIN stock s ON s.gusto_id = ti.gusto_id AND s.sucursal_id = ?
       WHERE ti.transferencia_id = ?`,
      [t.sucursal_origen_id, req.params.id]
    );

    res.json({ ...t, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener transferencia" });
  }
});

// ── POST /transferencias — crear borrador ─────────────────────────────────────
router.post("/", authenticate, soloAdmin, async (req, res) => {
  const { sucursal_origen_id, sucursal_destino_id, notas, items } = req.body;

  if (!sucursal_origen_id || !sucursal_destino_id)
    return res.status(400).json({ error: "Falta sucursal origen o destino" });
  if (parseInt(sucursal_origen_id) === parseInt(sucursal_destino_id))
    return res.status(400).json({ error: "Origen y destino deben ser distintos" });
  if (!items || !items.length)
    return res.status(400).json({ error: "Debe incluir al menos un producto" });

  for (const it of items) {
    if (!it.gusto_id || !it.cantidad || parseInt(it.cantidad) <= 0)
      return res.status(400).json({ error: "Todos los ítems deben tener cantidad válida" });
  }

  try {
    const [result] = await pool.promise().query(
      `INSERT INTO transferencias_stock
         (sucursal_origen_id, sucursal_destino_id, notas, creado_por, fecha_creacion)
       VALUES (?, ?, ?, ?, ?)`,
      [
        parseInt(sucursal_origen_id),
        parseInt(sucursal_destino_id),
        notas || null,
        req.user?.id || null,
        nowMysql(),
      ]
    );
    const transferId = result.insertId;

    for (const it of items) {
      await pool.promise().query(
        `INSERT INTO transferencia_stock_items (transferencia_id, gusto_id, cantidad)
         VALUES (?, ?, ?)`,
        [transferId, parseInt(it.gusto_id), parseInt(it.cantidad)]
      );
    }

    res.status(201).json({ id: transferId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al crear transferencia" });
  }
});

// ── POST /transferencias/:id/confirmar — mover stock atómicamente ─────────────
router.post("/:id/confirmar", authenticate, soloAdmin, async (req, res) => {
  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [[t]] = await conn.query(
      "SELECT * FROM transferencias_stock WHERE id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!t) {
      await conn.rollback();
      return res.status(404).json({ error: "Transferencia no encontrada" });
    }
    if (t.estado !== "pendiente") {
      await conn.rollback();
      return res.status(400).json({ error: "Solo se pueden confirmar transferencias pendientes" });
    }

    const [items] = await conn.query(
      `SELECT ti.*, g.nombre AS gusto, p.nombre AS producto_nombre
       FROM transferencia_stock_items ti
       JOIN gustos g ON g.id = ti.gusto_id
       JOIN productos p ON p.id = g.producto_id
       WHERE ti.transferencia_id = ?`,
      [req.params.id]
    );

    for (const item of items) {
      // Descontar de origen — atómico: falla si no hay suficiente stock
      await marcar(conn, "transferencia_salida", { referencia: `transf ${req.params.id}`, usuarioId: req.user?.id });
      const [upd] = await conn.query(
        `UPDATE stock
         SET cantidad = cantidad - ?
         WHERE gusto_id = ? AND sucursal_id = ? AND cantidad >= ?`,
        [item.cantidad, item.gusto_id, t.sucursal_origen_id, item.cantidad]
      );
      if (!upd.affectedRows) {
        await conn.rollback();
        return res.status(400).json({
          error: `Stock insuficiente: "${item.producto_nombre} — ${item.gusto}" en la sucursal origen`,
        });
      }

      // El precio con el que entra un sabor que la sucursal destino no tenía.
      //
      // Primero, el que esa sucursal ya usa para el mismo modelo: cada local
      // tiene su lista (Itaembe Punto 2 vende todos los BC15000 a $14.000
      // aunque Central los tenga a $16.000), y un sabor nuevo de un modelo que
      // ya vende tiene que entrar a ese precio, no al de Central. Si hay más de
      // uno, el más repetido entre sus sabores; si empatan, el más alto.
      //
      // Si es el primer sabor de ese modelo en la sucursal, no hay lista que
      // seguir y va el de origen.
      const [[delModelo]] = await conn.query(
        `SELECT st.precio, COUNT(*) AS veces
           FROM stock st
           JOIN gustos g ON g.id = st.gusto_id
          WHERE st.sucursal_id = ? AND st.precio > 0
            AND g.producto_id = (SELECT producto_id FROM gustos WHERE id = ?)
            AND g.id <> ?
          GROUP BY st.precio
          ORDER BY veces DESC, st.precio DESC
          LIMIT 1`,
        [t.sucursal_destino_id, item.gusto_id, item.gusto_id]
      );
      let precioNuevo = Number(delModelo?.precio) || 0;

      if (!precioNuevo) {
        const [[stockOrigen]] = await conn.query(
          "SELECT precio FROM stock WHERE gusto_id = ? AND sucursal_id = ?",
          [item.gusto_id, t.sucursal_origen_id]
        );
        precioNuevo = Number(stockOrigen?.precio) || 0;
      }

      // Sumar en destino — upsert atómico (requiere UNIQUE KEY (gusto_id, sucursal_id) en stock)
      // Si la fila ya existe, solo suma cantidad y respeta el precio que tiene,
      // salvo que esté en cero: un renglón sin precio se vendería regalado.
      await marcar(conn, "transferencia_entrada", { referencia: `transf ${req.params.id}`, usuarioId: req.user?.id });
      await conn.query(
        `INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           cantidad = cantidad + VALUES(cantidad),
           precio = IF(precio > 0, precio, VALUES(precio))`,
        [item.gusto_id, t.sucursal_destino_id, item.cantidad, precioNuevo]
      );
      await limpiar(conn);
    }

    await conn.query(
      "UPDATE transferencias_stock SET estado = 'confirmada', fecha_confirmacion = ? WHERE id = ?",
      [nowMysql(), req.params.id]
    );

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "Error al confirmar transferencia" });
  } finally {
    conn.release();
  }
});

// ── DELETE /transferencias/:id — cancelar (solo pendiente) ────────────────────
router.delete("/:id", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[t]] = await pool.promise().query(
      "SELECT estado FROM transferencias_stock WHERE id = ?",
      [req.params.id]
    );
    if (!t) return res.status(404).json({ error: "Transferencia no encontrada" });
    if (t.estado !== "pendiente")
      return res.status(400).json({ error: "Solo se pueden cancelar transferencias pendientes" });

    await pool.promise().query(
      "UPDATE transferencias_stock SET estado = 'cancelada' WHERE id = ?",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al cancelar transferencia" });
  }
});

module.exports = router;

const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

const CENTRAL_ID = 7;

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo admin" });
  next();
};

// El slug va en la URL pública del evento, así que tiene que ser corto y sin
// acentos. Se le agrega un sufijo si ya existe uno igual.
const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);

async function slugLibre(base) {
  const raiz = slugify(base) || "evento";
  for (let i = 0; i < 50; i++) {
    const s = i ? `${raiz}-${i + 1}` : raiz;
    const [[existe]] = await pool.promise().query("SELECT id FROM eventos WHERE slug = ?", [s]);
    if (!existe) return s;
  }
  return `${raiz}-${Date.now()}`;
}

/**
 * POST /eventos
 * Crea el evento y descuenta de Central lo que se lleva.
 * Body: { nombre, lugar?, fecha, items: [{ gusto_id, cantidad, precio }] }
 */
router.post("/eventos", authenticate, soloAdmin, async (req, res) => {
  const { nombre, lugar, fecha, items } = req.body || {};

  if (!nombre || !nombre.trim()) return res.status(400).json({ error: "Falta el nombre del evento" });
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Cargá al menos un producto" });
  }

  const limpios = [];
  for (const [i, it] of items.entries()) {
    const n = i + 1;
    const gustoId = Number(it.gusto_id);
    const cantidad = Number(it.cantidad);
    const precio = Number(it.precio);
    if (!gustoId) return res.status(400).json({ error: `Renglón ${n}: elegí el producto` });
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return res.status(400).json({ error: `Renglón ${n}: cantidad inválida` });
    }
    if (!Number.isFinite(precio) || precio <= 0) {
      return res.status(400).json({ error: `Renglón ${n}: precio inválido` });
    }
    if (limpios.some((x) => x.gustoId === gustoId)) {
      return res.status(400).json({ error: `Renglón ${n}: ese producto está repetido` });
    }
    limpios.push({ gustoId, cantidad, precio });
  }

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    // Se bloquean las filas de stock para que dos cargas simultáneas no dejen
    // el stock en negativo.
    for (const it of limpios) {
      const [[fila]] = await conn.query(
        "SELECT cantidad FROM stock WHERE sucursal_id = ? AND gusto_id = ? FOR UPDATE",
        [CENTRAL_ID, it.gustoId]
      );
      const disponible = Number(fila?.cantidad) || 0;
      if (disponible < it.cantidad) {
        const [[g]] = await conn.query(
          `SELECT CONCAT(p.nombre, ' - ', g.nombre) AS nombre
           FROM gustos g JOIN productos p ON p.id = g.producto_id WHERE g.id = ?`,
          [it.gustoId]
        );
        await conn.rollback();
        return res.status(400).json({
          error: `No alcanza el stock de ${g?.nombre || "ese producto"}: hay ${disponible} en Central y pediste ${it.cantidad}`,
        });
      }
    }

    const slug = await slugLibre(`${nombre} ${fecha || ""}`);
    const [ev] = await conn.query(
      `INSERT INTO eventos (nombre, lugar, fecha, slug, sucursal_origen_id, creado_por)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        nombre.trim(),
        (lugar || "").trim() || null,
        fecha || new Date().toISOString().slice(0, 10),
        slug,
        CENTRAL_ID,
        req.user?.id || null,
      ]
    );

    for (const it of limpios) {
      await conn.query(
        "INSERT INTO evento_items (evento_id, gusto_id, cantidad_llevada, precio) VALUES (?, ?, ?, ?)",
        [ev.insertId, it.gustoId, it.cantidad, it.precio]
      );
      await conn.query(
        "UPDATE stock SET cantidad = cantidad - ? WHERE sucursal_id = ? AND gusto_id = ?",
        [it.cantidad, CENTRAL_ID, it.gustoId]
      );
    }

    await conn.commit();
    res.json({ ok: true, id: ev.insertId, slug });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error en POST /eventos:", e);
    res.status(500).json({ error: "No se pudo crear el evento" });
  } finally {
    conn.release();
  }
});

/** GET /eventos — listado con el resumen de cada uno */
router.get("/eventos", authenticate, soloAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.promise().query(`
      SELECT
        e.id, e.nombre, e.lugar, e.fecha, e.slug, e.estado, e.cerrado_at,
        COUNT(i.id) AS productos,
        COALESCE(SUM(i.cantidad_llevada), 0) AS unidades,
        COALESCE(SUM((i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0)) * i.precio), 0) AS recaudado,
        COALESCE(SUM(i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0)), 0) AS vendidas
      FROM eventos e
      LEFT JOIN evento_items i ON i.evento_id = e.id
      GROUP BY e.id
      ORDER BY e.fecha DESC, e.id DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error en GET /eventos:", e);
    res.status(500).json({ error: "No se pudieron traer los eventos" });
  }
});

/** GET /eventos/:id — detalle con sus productos */
router.get("/eventos/:id", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[ev]] = await pool.promise().query("SELECT * FROM eventos WHERE id = ?", [req.params.id]);
    if (!ev) return res.status(404).json({ error: "Evento no encontrado" });

    const [items] = await pool.promise().query(`
      SELECT
        i.id, i.gusto_id, i.cantidad_llevada, i.cantidad_devuelta, i.precio,
        p.nombre AS producto, g.nombre AS gusto
      FROM evento_items i
      JOIN gustos g    ON g.id = i.gusto_id
      JOIN productos p ON p.id = g.producto_id
      WHERE i.evento_id = ?
      ORDER BY p.nombre, g.nombre
    `, [req.params.id]);

    res.json({ ...ev, items });
  } catch (e) {
    console.error("❌ Error en GET /eventos/:id:", e);
    res.status(500).json({ error: "No se pudo traer el evento" });
  }
});

/**
 * POST /eventos/:id/cerrar
 * Body: { devoluciones: [{ item_id, cantidad }] }
 * Reingresa a Central lo que volvió y deja registrado lo vendido.
 */
router.post("/eventos/:id/cerrar", authenticate, soloAdmin, async (req, res) => {
  const { devoluciones } = req.body || {};
  if (!Array.isArray(devoluciones)) return res.status(400).json({ error: "Faltan las devoluciones" });

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [[ev]] = await conn.query("SELECT * FROM eventos WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!ev) { await conn.rollback(); return res.status(404).json({ error: "Evento no encontrado" }); }
    if (ev.estado === "cerrado") {
      await conn.rollback();
      return res.status(400).json({ error: "Ese evento ya está cerrado" });
    }

    const [items] = await conn.query("SELECT * FROM evento_items WHERE evento_id = ?", [ev.id]);
    const porId = new Map(items.map((i) => [i.id, i]));

    for (const d of devoluciones) {
      const it = porId.get(Number(d.item_id));
      if (!it) { await conn.rollback(); return res.status(400).json({ error: "Producto que no es del evento" }); }
      const vuelven = Number(d.cantidad) || 0;
      if (vuelven < 0 || vuelven > it.cantidad_llevada) {
        await conn.rollback();
        return res.status(400).json({
          error: `No pueden volver ${vuelven} de un producto del que se llevaron ${it.cantidad_llevada}`,
        });
      }
      await conn.query("UPDATE evento_items SET cantidad_devuelta = ? WHERE id = ?", [vuelven, it.id]);
      if (vuelven > 0) {
        await conn.query(
          "UPDATE stock SET cantidad = cantidad + ? WHERE sucursal_id = ? AND gusto_id = ?",
          [vuelven, ev.sucursal_origen_id, it.gusto_id]
        );
      }
    }

    // Lo que no se declaró se toma como vendido entero
    await conn.query(
      "UPDATE evento_items SET cantidad_devuelta = 0 WHERE evento_id = ? AND cantidad_devuelta IS NULL",
      [ev.id]
    );
    await conn.query(
      "UPDATE eventos SET estado = 'cerrado', cerrado_at = NOW() WHERE id = ?",
      [ev.id]
    );

    const [[tot]] = await conn.query(`
      SELECT
        COALESCE(SUM(cantidad_llevada - cantidad_devuelta), 0) AS vendidas,
        COALESCE(SUM((cantidad_llevada - cantidad_devuelta) * precio), 0) AS recaudado
      FROM evento_items WHERE evento_id = ?
    `, [ev.id]);

    await conn.commit();
    res.json({ ok: true, ...tot });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error en POST /eventos/:id/cerrar:", e);
    res.status(500).json({ error: "No se pudo cerrar el evento" });
  } finally {
    conn.release();
  }
});

/** DELETE /eventos/:id — cancela. Si estaba abierto, devuelve todo a Central. */
router.delete("/eventos/:id", authenticate, soloAdmin, async (req, res) => {
  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [[ev]] = await conn.query("SELECT * FROM eventos WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!ev) { await conn.rollback(); return res.status(404).json({ error: "Evento no encontrado" }); }

    if (ev.estado === "abierto") {
      const [items] = await conn.query("SELECT * FROM evento_items WHERE evento_id = ?", [ev.id]);
      for (const it of items) {
        await conn.query(
          "UPDATE stock SET cantidad = cantidad + ? WHERE sucursal_id = ? AND gusto_id = ?",
          [it.cantidad_llevada, ev.sucursal_origen_id, it.gusto_id]
        );
      }
    }

    await conn.query("DELETE FROM eventos WHERE id = ?", [ev.id]);
    await conn.commit();
    res.json({ ok: true, stock_devuelto: ev.estado === "abierto" });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error en DELETE /eventos/:id:", e);
    res.status(500).json({ error: "No se pudo eliminar el evento" });
  } finally {
    conn.release();
  }
});

module.exports = router;

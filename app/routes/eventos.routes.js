const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");
const { marcar, limpiar } = require("../movimientos");

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
  const { nombre, lugar, fecha, items, comision_unidad, logos, nota } = req.body || {};

  // La fiesta se queda una comisión fija por unidad vendida; el precio del
  // catálogo es lo que paga el cliente, no lo que entra a caja.
  const comision = comision_unidad === undefined || comision_unidad === ""
    ? 5000
    : Number(comision_unidad);
  if (!Number.isFinite(comision) || comision < 0) {
    return res.status(400).json({ error: "Comisión inválida" });
  }

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
    if (precio <= comision) {
      return res.status(400).json({
        error: `Renglón ${n}: a ese precio no te queda nada, la comisión es ${comision}`,
      });
    }
    if (limpios.some((x) => x.gustoId === gustoId)) {
      return res.status(400).json({ error: `Renglón ${n}: ese producto está repetido` });
    }
    limpios.push({ gustoId, cantidad, precio });
  }

  // Logos de la fiesta: llegan como data URL desde el formulario, ya reducidos
  // en el navegador. Se guardan aparte para no engordar el listado de eventos.
  const logosLimpios = [];
  for (const l of Array.isArray(logos) ? logos.slice(0, 3) : []) {
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(l || ""));
    if (!m) return res.status(400).json({ error: "Formato de logo no reconocido" });
    if (m[2].length > 900000) {
      return res.status(400).json({ error: "Ese logo pesa demasiado, probá con uno más chico" });
    }
    logosLimpios.push({ mime: m[1], datos: m[2] });
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
      `INSERT INTO eventos (nombre, lugar, nota, fecha, comision_unidad, slug, sucursal_origen_id, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nombre.trim(),
        (lugar || "").trim() || null,
        (nota || "").trim().slice(0, 300) || null,
        fecha || new Date().toISOString().slice(0, 10),
        comision,
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
      await marcar(conn, "evento_salida", { referencia: `evento ${ev.insertId}`, usuarioId: req.user?.id });
      await conn.query(
        "UPDATE stock SET cantidad = cantidad - ? WHERE sucursal_id = ? AND gusto_id = ?",
        [it.cantidad, CENTRAL_ID, it.gustoId]
      );
      await limpiar(conn);
    }

    for (const [i, l] of logosLimpios.entries()) {
      await conn.query(
        "INSERT INTO evento_logos (evento_id, imagen_base64, mime, orden) VALUES (?, ?, ?, ?)",
        [ev.insertId, l.datos, l.mime, i]
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
        e.comision_unidad,
        COALESCE(SUM(
          (i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0) - i.cantidad_directa) * i.precio
          + i.cantidad_directa * COALESCE(i.precio_directo, i.precio)
        ), 0) AS bruto,
        COALESCE(SUM(i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0)), 0) AS vendidas,
        COALESCE(SUM(i.cantidad_directa), 0) AS directas,
        COALESCE(SUM(i.cantidad_directa * COALESCE(i.precio_directo, i.precio)), 0) AS total_directo,
        -- La comisión y lo que rinde la fiesta salen sólo de lo que vendió ella
        COALESCE(SUM((i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0) - i.cantidad_directa) * e.comision_unidad), 0) AS comision,
        COALESCE(SUM((i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0) - i.cantidad_directa) * (i.precio - e.comision_unidad)), 0) AS a_rendir,
        COALESCE(SUM(
          (i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0) - i.cantidad_directa) * (i.precio - e.comision_unidad)
          + i.cantidad_directa * COALESCE(i.precio_directo, i.precio)
        ), 0) AS neto
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

/**
 * GET /eventos/estadisticas
 * Qué se vende en las fiestas, para saber qué llevar la próxima.
 * Solo cuenta eventos cerrados: en los abiertos todavía no se sabe qué se vendió.
 */
router.get("/eventos/estadisticas", authenticate, soloAdmin, async (_req, res) => {
  try {
    const [[resumen]] = await pool.promise().query(`
      SELECT
        COUNT(DISTINCT e.id) AS eventos,
        COALESCE(SUM(i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0)), 0) AS vendidas,
        COALESCE(SUM(i.cantidad_llevada), 0) AS llevadas,
        COALESCE(SUM((i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0)) * i.precio), 0) AS bruto,
        COALESCE(SUM((i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0)) * (i.precio - e.comision_unidad)), 0) AS neto
      FROM eventos e
      JOIN evento_items i ON i.evento_id = e.id
      WHERE e.estado = 'cerrado'
    `);

    // Por modelo, no por sabor: a una fiesta se lleva "Ice King", no un gusto puntual
    const [modelos] = await pool.promise().query(`
      SELECT
        p.nombre AS modelo,
        COUNT(DISTINCT e.id) AS eventos,
        SUM(i.cantidad_llevada) AS llevadas,
        SUM(i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0)) AS vendidas,
        SUM((i.cantidad_llevada - COALESCE(i.cantidad_devuelta, 0)) * (i.precio - e.comision_unidad)) AS neto,
        ROUND(AVG(i.precio)) AS precio_prom
      FROM eventos e
      JOIN evento_items i ON i.evento_id = e.id
      JOIN gustos g    ON g.id = i.gusto_id
      JOIN productos p ON p.id = g.producto_id
      WHERE e.estado = 'cerrado'
      GROUP BY p.id, p.nombre
      HAVING llevadas > 0
      ORDER BY vendidas DESC, neto DESC
    `);

    res.json({
      ...resumen,
      // Qué porcentaje de lo que se lleva se termina vendiendo: lo que manda
      // para decidir cuánto llevar la próxima vez.
      modelos: modelos.map((m) => ({
        ...m,
        salida_pct: Number(m.llevadas) > 0
          ? Math.round((Number(m.vendidas) / Number(m.llevadas)) * 100)
          : 0,
      })),
    });
  } catch (e) {
    console.error("❌ Error en GET /eventos/estadisticas:", e);
    res.status(500).json({ error: "No se pudieron traer las estadísticas" });
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
        i.cantidad_directa, i.precio_directo,
        p.nombre AS producto, g.nombre AS gusto
      FROM evento_items i
      JOIN gustos g    ON g.id = i.gusto_id
      JOIN productos p ON p.id = g.producto_id
      WHERE i.evento_id = ?
      ORDER BY p.nombre, g.nombre
    `, [req.params.id]);

    const [logos] = await pool.promise().query(
      "SELECT imagen_base64, mime FROM evento_logos WHERE evento_id = ? ORDER BY orden, id",
      [req.params.id]
    );

    res.json({
      ...ev,
      items,
      logos: logos.map((l) => `data:${l.mime};base64,${l.imagen_base64}`),
    });
  } catch (e) {
    console.error("❌ Error en GET /eventos/:id:", e);
    res.status(500).json({ error: "No se pudo traer el evento" });
  }
});

/**
 * POST /eventos/:id/cerrar
 * Body: { devoluciones: [{ item_id, cantidad, directas?, precio_directo? }] }
 * Reingresa a Central lo que volvió y deja registrado lo vendido.
 *
 * `directas` son las unidades que no vendió la fiesta: se las llevó alguien
 * nuestro y nos pagó a nosotros. No pagan comisión y no entran en lo que la
 * fiesta tiene que rendir, pero sí son una venta y se registran igual.
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

      const directas = Number(d.directas) || 0;
      if (directas < 0) {
        await conn.rollback();
        return res.status(400).json({ error: "Las unidades pagadas directo no pueden ser negativas" });
      }
      if (vuelven + directas > it.cantidad_llevada) {
        await conn.rollback();
        return res.status(400).json({
          error: `De ese producto se llevaron ${it.cantidad_llevada} y estás declarando ${vuelven} devueltas más ${directas} pagadas directo`,
        });
      }

      // Sin precio propio se toma el del catálogo del evento
      let precioDirecto = null;
      if (directas > 0) {
        precioDirecto =
          d.precio_directo === undefined || d.precio_directo === "" || d.precio_directo === null
            ? Number(it.precio)
            : Number(d.precio_directo);
        if (!Number.isFinite(precioDirecto) || precioDirecto < 0) {
          await conn.rollback();
          return res.status(400).json({ error: "Precio inválido en una venta directa" });
        }
      }

      await conn.query(
        "UPDATE evento_items SET cantidad_devuelta = ?, cantidad_directa = ?, precio_directo = ? WHERE id = ?",
        [vuelven, directas, precioDirecto, it.id]
      );
      if (vuelven > 0) {
        await marcar(conn, "evento_devolucion", { referencia: `evento ${ev.id}`, usuarioId: req.user?.id });
        await conn.query(
          "UPDATE stock SET cantidad = cantidad + ? WHERE sucursal_id = ? AND gusto_id = ?",
          [vuelven, ev.sucursal_origen_id, it.gusto_id]
        );
        await limpiar(conn);
      }
    }

    // Lo que no se declaró se toma como vendido entero
    await conn.query(
      "UPDATE evento_items SET cantidad_devuelta = 0 WHERE evento_id = ? AND cantidad_devuelta IS NULL",
      [ev.id]
    );

    // Se registran las ventas del evento en `ventas`, si no el Dashboard y el
    // resto del sistema no las ven. Se guarda el neto y no el precio de
    // catálogo: la comisión de la fiesta nunca llega a nuestra caja.
    // La marca `evento_id` permite distinguirlas de las ventas del local.
    await conn.query("DELETE FROM ventas WHERE evento_id = ?", [ev.id]);
    // Lo que vendió la fiesta: entra el precio menos su comisión
    await conn.query(`
      INSERT INTO ventas (gusto_id, sucursal_id, evento_id, cantidad, precio_unitario, fecha)
      SELECT i.gusto_id, ?, ?,
             i.cantidad_llevada - i.cantidad_devuelta - i.cantidad_directa,
             GREATEST(i.precio - ?, 0),
             ?
      FROM evento_items i
      WHERE i.evento_id = ?
        AND i.cantidad_llevada - i.cantidad_devuelta - i.cantidad_directa > 0
    `, [ev.sucursal_origen_id, ev.id, ev.comision_unidad, ev.fecha, ev.id]);
    // Lo que se pagó directo a nosotros: entra completo, sin comisión
    await conn.query(`
      INSERT INTO ventas (gusto_id, sucursal_id, evento_id, cantidad, precio_unitario, fecha)
      SELECT i.gusto_id, ?, ?, i.cantidad_directa, COALESCE(i.precio_directo, i.precio), ?
      FROM evento_items i
      WHERE i.evento_id = ? AND i.cantidad_directa > 0
    `, [ev.sucursal_origen_id, ev.id, ev.fecha, ev.id]);
    await conn.query(
      "UPDATE eventos SET estado = 'cerrado', cerrado_at = NOW() WHERE id = ?",
      [ev.id]
    );

    // `vendidas` y `bruto` cuentan todo lo que salió; la comisión y lo que la
    // fiesta rinde salen sólo de lo que vendió ella.
    const [[tot]] = await conn.query(`
      SELECT
        COALESCE(SUM(cantidad_llevada - cantidad_devuelta), 0) AS vendidas,
        COALESCE(SUM(
          (cantidad_llevada - cantidad_devuelta - cantidad_directa) * precio
          + cantidad_directa * COALESCE(precio_directo, precio)
        ), 0) AS bruto,
        COALESCE(SUM(cantidad_directa), 0) AS directas,
        COALESCE(SUM(cantidad_directa * COALESCE(precio_directo, precio)), 0) AS total_directo,
        COALESCE(SUM((cantidad_llevada - cantidad_devuelta - cantidad_directa) * ?), 0) AS comision,
        COALESCE(SUM((cantidad_llevada - cantidad_devuelta - cantidad_directa) * (precio - ?)), 0) AS a_rendir,
        COALESCE(SUM(
          (cantidad_llevada - cantidad_devuelta - cantidad_directa) * (precio - ?)
          + cantidad_directa * COALESCE(precio_directo, precio)
        ), 0) AS neto
      FROM evento_items WHERE evento_id = ?
    `, [ev.comision_unidad, ev.comision_unidad, ev.comision_unidad, ev.id]);

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

/**
 * PUT /eventos/:id
 * Edita un evento abierto: datos, precios, cantidades, productos y logos.
 * Ajusta el stock de Central por la diferencia — agregar descuenta, quitar
 * devuelve — así se puede corregir un precio o sumar mercadería en plena fiesta.
 */
router.put("/eventos/:id", authenticate, soloAdmin, async (req, res) => {
  const { nombre, lugar, fecha, nota, comision_unidad, items, logos } = req.body || {};

  if (!nombre || !nombre.trim()) return res.status(400).json({ error: "Falta el nombre del evento" });
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "El evento tiene que tener al menos un producto" });
  }

  const comision = comision_unidad === undefined || comision_unidad === ""
    ? 5000
    : Number(comision_unidad);
  if (!Number.isFinite(comision) || comision < 0) {
    return res.status(400).json({ error: "Comisión inválida" });
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
    if (precio <= comision) {
      return res.status(400).json({ error: `Renglón ${n}: a ese precio no te queda nada, la comisión es ${comision}` });
    }
    if (limpios.some((x) => x.gustoId === gustoId)) {
      return res.status(400).json({ error: `Renglón ${n}: ese producto está repetido` });
    }
    limpios.push({ gustoId, cantidad, precio });
  }

  let logosLimpios = null;   // null = no se tocan
  if (Array.isArray(logos)) {
    logosLimpios = [];
    for (const l of logos.slice(0, 3)) {
      const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(l || ""));
      if (!m) return res.status(400).json({ error: "Formato de logo no reconocido" });
      if (m[2].length > 900000) {
        return res.status(400).json({ error: "Ese logo pesa demasiado, probá con uno más chico" });
      }
      logosLimpios.push({ mime: m[1], datos: m[2] });
    }
  }

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [[ev]] = await conn.query("SELECT * FROM eventos WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!ev) { await conn.rollback(); return res.status(404).json({ error: "Evento no encontrado" }); }
    if (ev.estado !== "abierto") {
      await conn.rollback();
      return res.status(400).json({ error: "Ese evento está cerrado. Reabrilo para poder editarlo." });
    }

    const [actuales] = await conn.query("SELECT * FROM evento_items WHERE evento_id = ?", [ev.id]);
    const antes = new Map(actuales.map((i) => [i.gusto_id, i]));

    // Diferencia contra lo que ya estaba: positiva sale de Central, negativa vuelve
    const deltas = new Map();
    for (const it of limpios) {
      const previo = antes.get(it.gustoId);
      deltas.set(it.gustoId, it.cantidad - (previo ? previo.cantidad_llevada : 0));
    }
    for (const i of actuales) {
      if (!limpios.some((x) => x.gustoId === i.gusto_id)) {
        deltas.set(i.gusto_id, -i.cantidad_llevada);
      }
    }

    for (const [gustoId, delta] of deltas) {
      if (delta <= 0) continue;
      const [[fila]] = await conn.query(
        "SELECT cantidad FROM stock WHERE sucursal_id = ? AND gusto_id = ? FOR UPDATE",
        [ev.sucursal_origen_id, gustoId]
      );
      const disponible = Number(fila?.cantidad) || 0;
      if (disponible < delta) {
        const [[g]] = await conn.query(
          `SELECT CONCAT(p.nombre, ' - ', g.nombre) AS nombre
           FROM gustos g JOIN productos p ON p.id = g.producto_id WHERE g.id = ?`, [gustoId]
        );
        await conn.rollback();
        return res.status(400).json({
          error: `No alcanza el stock de ${g?.nombre || "ese producto"}: hay ${disponible} en Central y necesitás ${delta} más`,
        });
      }
    }

    for (const [gustoId, delta] of deltas) {
      if (delta === 0) continue;
      await conn.query(
        "UPDATE stock SET cantidad = cantidad - ? WHERE sucursal_id = ? AND gusto_id = ?",
        [delta, ev.sucursal_origen_id, gustoId]
      );
    }

    await conn.query("DELETE FROM evento_items WHERE evento_id = ?", [ev.id]);
    for (const it of limpios) {
      await conn.query(
        "INSERT INTO evento_items (evento_id, gusto_id, cantidad_llevada, precio) VALUES (?, ?, ?, ?)",
        [ev.id, it.gustoId, it.cantidad, it.precio]
      );
    }

    await conn.query(
      `UPDATE eventos SET nombre = ?, lugar = ?, nota = ?, fecha = ?, comision_unidad = ?
       WHERE id = ?`,
      [
        nombre.trim(),
        (lugar || "").trim() || null,
        (nota || "").trim().slice(0, 300) || null,
        fecha || ev.fecha,
        comision,
        ev.id,
      ]
    );

    if (logosLimpios) {
      await conn.query("DELETE FROM evento_logos WHERE evento_id = ?", [ev.id]);
      for (const [i, l] of logosLimpios.entries()) {
        await conn.query(
          "INSERT INTO evento_logos (evento_id, imagen_base64, mime, orden) VALUES (?, ?, ?, ?)",
          [ev.id, l.datos, l.mime, i]
        );
      }
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error en PUT /eventos/:id:", e);
    res.status(500).json({ error: "No se pudo guardar el evento" });
  } finally {
    conn.release();
  }
});

/**
 * POST /eventos/:id/reabrir
 * Deshace el cierre: lo que se había devuelto a Central vuelve a salir, y el
 * evento queda editable otra vez. Sirve cuando se contó mal una devolución.
 */
router.post("/eventos/:id/reabrir", authenticate, soloAdmin, async (req, res) => {
  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [[ev]] = await conn.query("SELECT * FROM eventos WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!ev) { await conn.rollback(); return res.status(404).json({ error: "Evento no encontrado" }); }
    if (ev.estado !== "cerrado") {
      await conn.rollback();
      return res.status(400).json({ error: "Ese evento ya está abierto" });
    }

    const [items] = await conn.query("SELECT * FROM evento_items WHERE evento_id = ?", [ev.id]);

    // Lo devuelto al cerrar tiene que volver a salir de Central. Si mientras
    // tanto se vendió, no alcanza y no se puede reabrir sin descuadrar.
    for (const it of items) {
      const vuelven = Number(it.cantidad_devuelta) || 0;
      if (vuelven <= 0) continue;
      const [[fila]] = await conn.query(
        "SELECT cantidad FROM stock WHERE sucursal_id = ? AND gusto_id = ? FOR UPDATE",
        [ev.sucursal_origen_id, it.gusto_id]
      );
      if ((Number(fila?.cantidad) || 0) < vuelven) {
        const [[g]] = await conn.query(
          `SELECT CONCAT(p.nombre, ' - ', g.nombre) AS nombre
           FROM gustos g JOIN productos p ON p.id = g.producto_id WHERE g.id = ?`, [it.gusto_id]
        );
        await conn.rollback();
        return res.status(400).json({
          error: `No se puede reabrir: de ${g?.nombre || "un producto"} ya no quedan en Central las ${vuelven} que habían vuelto`,
        });
      }
    }

    for (const it of items) {
      const vuelven = Number(it.cantidad_devuelta) || 0;
      if (vuelven > 0) {
        await conn.query(
          "UPDATE stock SET cantidad = cantidad - ? WHERE sucursal_id = ? AND gusto_id = ?",
          [vuelven, ev.sucursal_origen_id, it.gusto_id]
        );
      }
    }

    // Se deshace la venta registrada: el evento vuelve a estar en curso
    await conn.query("DELETE FROM ventas WHERE evento_id = ?", [ev.id]);
    await conn.query(
      "UPDATE evento_items SET cantidad_devuelta = NULL, cantidad_directa = 0, precio_directo = NULL WHERE evento_id = ?",
      [ev.id]
    );
    await conn.query(
      "UPDATE eventos SET estado = 'abierto', cerrado_at = NULL WHERE id = ?", [ev.id]
    );

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error en POST /eventos/:id/reabrir:", e);
    res.status(500).json({ error: "No se pudo reabrir el evento" });
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

    // El evento deja de existir, así que su facturación tampoco
    await conn.query("DELETE FROM ventas WHERE evento_id = ?", [ev.id]);
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

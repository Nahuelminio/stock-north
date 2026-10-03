const express    = require("express");
const router     = express.Router();
const pool       = require("../db");
const authenticate = require("../middlewares/authenticate");
const { marcar, limpiar } = require("../movimientos");
const { avisarVenta } = require("../services/telegram");
const { costosDeGustos, margenPct } = require("../costos");

const CENTRAL_ID = 7;
const { avisarTelegram } = require("../services/telegram");

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo administradores" });
  next();
};

/**
 * POST /pedidos-central
 * Público — lo llama el catálogo cuando el usuario envía su pedido por WhatsApp.
 * Body: { items: [...], total, notas?, nombre?, telefono?,
 *         metodo_pago? ('efectivo'|'transferencia'), direccion?, referencia?, ubicacion_url? }
 */
router.post("/pedidos-central", async (req, res) => {
  const { items, total, notas, nombre, telefono,
          metodo_pago, envio, direccion, referencia, ubicacion_url } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "El pedido no tiene items" });

  // Validar que cada item tenga lo mínimo
  for (const item of items) {
    if (!item.gusto_id || !item.qty || item.qty < 1)
      return res.status(400).json({ error: "Item inválido en el pedido" });
  }

  const nombreCliente   = nombre   ? String(nombre).trim().slice(0, 120)   : null;
  const telefonoCliente = telefono ? String(telefono).trim().slice(0, 40)  : null;
  const metodoPago      = metodo_pago === "transferencia" ? "transferencia"
                        : metodo_pago === "efectivo"      ? "efectivo" : null;
  // Envío como opción propia (independiente del método de pago)
  const esEnvio         = envio === true || envio === "true";
  const dir             = esEnvio && direccion     ? String(direccion).trim().slice(0, 255)     : null;
  const ref             = esEnvio && referencia    ? String(referencia).trim().slice(0, 255)    : null;
  const ubic            = esEnvio && ubicacion_url ? String(ubicacion_url).trim().slice(0, 255) : null;

  try {
    const [result] = await pool.promise().query(
      `INSERT INTO pedidos_central
         (items, total, notas, nombre_cliente, telefono_cliente, metodo_pago, direccion, referencia, ubicacion_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [JSON.stringify(items), Number(total) || 0, notas || null,
       nombreCliente, telefonoCliente, metodoPago, dir, ref, ubic]
    );

    // Aviso por Telegram de pedido nuevo (no bloquea la respuesta)
    const totalUnidades = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
    const resumenItems = items
      .map((i) => `• ${i.qty > 1 ? `${i.qty}× ` : ""}${i.modelo} - ${i.gusto}`)
      .join("\n");
    const totalFmt = `$ ${(Number(total) || 0).toLocaleString("es-AR")}`;
    const pagoLinea = metodoPago
      ? `\n💳 ${metodoPago === "transferencia" ? "Transferencia" : "Efectivo"}`
      : "";
    const envioLinea = esEnvio
      ? `\n🚚 ENVÍO — cotizar\n📍 ${dir || "(sin dirección)"}` +
        (ref  ? `\n   Ref: ${ref}` : "") +
        (ubic ? `\n   ${ubic}` : "")
      : "";
    const mensaje =
      `🛒 Nuevo pedido #${result.insertId}\n` +
      (nombreCliente ? `👤 ${nombreCliente}\n` : "") +
      (telefonoCliente ? `💬 ${telefonoCliente}\n` : "") +
      `\n${resumenItems}\n\n${totalUnidades} u. · ${totalFmt}` +
      pagoLinea + envioLinea;
    avisarTelegram(mensaje);

    res.status(201).json({ ok: true, id: result.insertId });
  } catch (e) {
    console.error("❌ POST /pedidos-central:", e);
    res.status(500).json({ error: "Error al guardar el pedido" });
  }
});

/**
 * GET /pedidos-central/:id/estado
 * Público — el catálogo consulta el estado de un pedido para mostrar seguimiento.
 * Devuelve solo lo mínimo, sin datos sensibles.
 */
router.get("/pedidos-central/:id/estado", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1)
    return res.status(400).json({ error: "ID inválido" });
  try {
    const [[row]] = await pool.promise().query(
      "SELECT id, estado, total, fecha_creacion, fecha_confirmacion FROM pedidos_central WHERE id = ?",
      [id]
    );
    if (!row) return res.status(404).json({ error: "Pedido no encontrado" });
    res.json(row);
  } catch (e) {
    console.error("❌ GET /pedidos-central/:id/estado:", e);
    res.status(500).json({ error: "Error al consultar el pedido" });
  }
});

/**
 * GET /pedidos-central
 * Admin — lista de pedidos, por defecto muestra pendientes primero.
 * Query: ?estado=pendiente|confirmado|cancelado|todos
 */
/**
 * Le agrega a un pedido lo que costó la mercadería y la ganancia.
 * Los items viven en JSON, así que el costo se resuelve aparte y no con un JOIN.
 * Se valúa a la fecha en que se confirmó; si todavía está pendiente, a hoy.
 */
async function conCostos(pedido) {
  const items = typeof pedido.items === "string" ? JSON.parse(pedido.items) : pedido.items;
  const lista = Array.isArray(items) ? items : [];
  const costos = await costosDeGustos(
    pool,
    lista.map((i) => i.gusto_id),
    pedido.fecha_confirmacion || new Date()
  );

  let costoTotal = 0;
  let unidades = 0;
  const conCosto = lista.map((i) => {
    const cant = Number(i.qty ?? i.cantidad) || 0;
    const costoUnit = costos.get(Number(i.gusto_id)) || 0;
    const costo = costoUnit * cant;
    const facturado = (Number(i.precio) || 0) * cant;
    costoTotal += costo;
    unidades += cant;
    return {
      ...i,
      costo_unitario: Number(costoUnit.toFixed(2)),
      costo_total: Number(costo.toFixed(2)),
      ganancia: Number((facturado - costo).toFixed(2)),
      margen_pct: margenPct(facturado, facturado - costo),
    };
  });

  const facturado = Number(pedido.total) || 0;
  return {
    ...pedido,
    items: conCosto,
    unidades,
    costo_total: Number(costoTotal.toFixed(2)),
    ganancia: Number((facturado - costoTotal).toFixed(2)),
    margen_pct: margenPct(facturado, facturado - costoTotal),
  };
}

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
      `SELECT id, estado, items, total, notas, nombre_cliente, telefono_cliente,
              metodo_pago, direccion, referencia, ubicacion_url,
              fecha_creacion, fecha_confirmacion
       FROM pedidos_central
       ${whereEstado}
       ORDER BY estado = 'pendiente' DESC, fecha_creacion DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // Parsear items y agregarles el costo
    const data = await Promise.all(rows.map(conCostos));

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

    const conCosto = await conCostos({ ...row, items: itemsConStock });
    res.json(conCosto);
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
    if (!pedido) {
      await conn.rollback();
      return res.status(404).json({ error: "Pedido no encontrado" });
    }
    if (pedido.estado !== "pendiente") {
      await conn.rollback();
      return res.status(400).json({ error: "El pedido ya fue procesado" });
    }

    const items = typeof pedido.items === "string" ? JSON.parse(pedido.items) : pedido.items;

    for (const item of items) {
      // Verificar stock
      const [[st]] = await conn.query(
        "SELECT cantidad FROM stock WHERE gusto_id = ? AND sucursal_id = ? FOR UPDATE",
        [item.gusto_id, CENTRAL_ID]
      );
      if (!st) {
        await conn.rollback();
        return res.status(400).json({ error: `Sin stock registrado para: ${item.modelo} - ${item.gusto}` });
      }
      if (st.cantidad < item.qty) {
        await conn.rollback();
        return res.status(400).json({
          error: `Stock insuficiente para ${item.modelo} - ${item.gusto}. Disponible: ${st.cantidad}, pedido: ${item.qty}`,
        });
      }

      // Descontar stock
      await marcar(conn, "venta_publica", { referencia: `pedido web ${pedido.id}`, usuarioId: req.user?.id });
      await conn.query(
        "UPDATE stock SET cantidad = cantidad - ? WHERE gusto_id = ? AND sucursal_id = ?",
        [item.qty, item.gusto_id, CENTRAL_ID]
      );
      await limpiar(conn);

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

    // Un aviso por pedido y no uno por producto: un pedido de 5 items mandaría
    // 5 mensajes seguidos por la misma compra.
    try {
      const pesos = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");
      const detalle = (Array.isArray(items) ? items : [])
        .map((it) => `  ${it.qty} x ${String(it.modelo || "").trim()} - ${it.gusto}`)
        .join("\n");
      avisarVenta(
        [
          `Pedido de Central confirmado (#${pedido.id})`,
          pedido.nombre_cliente ? `Cliente: ${pedido.nombre_cliente}` : null,
          detalle || null,
          `Total: ${pesos(pedido.total)}`,
          pedido.metodo_pago ? `Pago: ${pedido.metodo_pago}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (e) {
      console.error("aviso de pedido central:", e.message || e);
    }
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

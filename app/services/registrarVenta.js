/**
 * Registrar una venta, en un solo lugar.
 *
 * Lo usan la pantalla de ventas y el asistente de Telegram. Si hubiera dos
 * implementaciones, el día que cambie una regla —un aviso, un descuento de
 * stock— se arreglaría en una sola y tendríamos dos sistemas que dicen cosas
 * distintas, que es lo que ya nos pasó con los costos.
 *
 * Descuenta stock y escribe la venta en una transacción, con el stock bloqueado
 * para que dos ventas simultáneas del último pod no puedan pasar las dos.
 */

const pool = require("../db");
const { marcar, limpiar } = require("../movimientos");
const { avisarVenta, chatDeVentas } = require("./telegram");

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_VENTAS || "";

const limpio = (t) => String(t || "").replace(/\s+/g, " ").trim();
const pesos = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");

/**
 * @param {object} p
 * @param {number} p.gustoId
 * @param {number} p.sucursalId   Dónde se vende y de dónde sale el stock
 * @param {number} p.cantidad
 * @param {number|null} [p.precioUnitario]  Si no viene, el precio de esa sucursal
 * @param {number|null} [p.vendedorId]      Solo para vendedores minoristas
 * @param {number|null} [p.usuarioId]       Quién la carga, para el historial
 * @param {string|null} [p.origenChat]      Chat de Telegram desde el que se cargó.
 *   Si es el mismo al que van los avisos, no se manda: avisarte de una venta que
 *   acabás de cargar vos son dos mensajes para la misma cosa.
 * @returns {Promise<{ok: boolean, error?: string, venta_id?: number, precio_unitario?: number, quedan?: number}>}
 *
 * No tira: los problemas esperables (sin stock, stock insuficiente) vuelven
 * como `{ok: false, error}` para que cada quien los muestre a su manera.
 */
async function registrarVenta({
  gustoId, sucursalId, cantidad, precioUnitario = null, vendedorId = null,
  usuarioId = null, origenChat = null,
}) {
  const gid = Number(gustoId);
  const sid = Number(sucursalId);
  const cant = Number(cantidad);

  if (!Number.isInteger(gid) || gid <= 0) return { ok: false, error: "gusto_id inválido" };
  if (!Number.isInteger(sid) || sid <= 0) return { ok: false, error: "sucursal_id inválido" };
  if (!Number.isInteger(cant) || cant <= 0) return { ok: false, error: "Cantidad inválida" };

  const conn = await pool.promise().getConnection();
  let ventaId, precioFinal;

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT cantidad, precio FROM stock WHERE gusto_id = ? AND sucursal_id = ? FOR UPDATE",
      [gid, sid]
    );
    const stockRow = rows?.[0];
    if (!stockRow) { await conn.rollback(); return { ok: false, error: "Stock no encontrado" }; }
    if (stockRow.cantidad < cant) {
      await conn.rollback();
      return { ok: false, error: "Stock insuficiente", disponible: Number(stockRow.cantidad) };
    }

    await marcar(conn, "venta", { usuarioId });
    await conn.query(
      "UPDATE stock SET cantidad = cantidad - ? WHERE gusto_id = ? AND sucursal_id = ?",
      [cant, gid, sid]
    );
    await limpiar(conn);

    precioFinal =
      precioUnitario != null && !isNaN(Number(precioUnitario)) && Number(precioUnitario) >= 0
        ? Number(precioUnitario)
        : stockRow.precio;

    const [ins] = await conn.query(
      `INSERT INTO ventas (gusto_id, sucursal_id, sucursal_stock_id, vendedor_id, cantidad, precio_unitario, fecha)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [gid, sid, sid, vendedorId, cant, precioFinal]
    );
    ventaId = ins.insertId;

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error("❌ registrarVenta:", e.code || e.message, e);
    return { ok: false, error: "Error al registrar la venta" };
  } finally {
    conn.release();
  }

  const quedan = await avisar({ ventaId, gid, sid, cant, precioFinal, vendedorId, origenChat });
  return { ok: true, venta_id: ventaId, precio_unitario: Number(precioFinal), quedan };
}

/**
 * Aviso por Telegram y webhook a n8n. La venta ya está hecha, así que esto no
 * puede hacerla fallar: si se cae, se loguea y listo.
 * @returns {Promise<number|null>} lo que queda de ese sabor en esa sucursal
 */
async function avisar({ ventaId, gid, sid, cant, precioFinal, vendedorId, origenChat }) {
  try {
    const [rows] = await pool.promise().query(
      `SELECT g.nombre AS gusto_nombre, p.nombre AS modelo_nombre, s.nombre AS sucursal_nombre,
              COALESCE(NULLIF(TRIM(u.nombre), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS vendedor_nombre,
              (SELECT st.cantidad FROM stock st
                WHERE st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id) AS quedan
         FROM ventas v
         JOIN gustos g ON v.gusto_id = g.id
         JOIN productos p ON g.producto_id = p.id
         JOIN sucursales s ON v.sucursal_id = s.id
         LEFT JOIN usuarios u ON u.id = v.vendedor_id
        WHERE v.id = ?`,
      [ventaId]
    );
    const info = rows?.[0] || {};
    const quedan = info.quedan == null ? null : Number(info.quedan);
    const total = Number(precioFinal || 0) * Number(cant || 0);

    // Si la cargó el mismo chat que recibe los avisos, no le avisamos: ya lo sabe
    const silenciar = origenChat != null && String(origenChat) === String(chatDeVentas());

    if (!silenciar) avisarVenta(
      [
        `Venta en ${limpio(info.sucursal_nombre) || "sucursal " + sid}`,
        limpio(info.modelo_nombre),
        info.gusto_nombre ? `Sabor: ${limpio(info.gusto_nombre)}` : null,
        `${cant} x ${pesos(precioFinal)} = ${pesos(total)}`,
        info.vendedor_nombre ? `Vendio: ${limpio(info.vendedor_nombre)}` : null,
        quedan == null ? null
          : quedan === 0 ? "SIN STOCK de ese sabor en esa sucursal"
          : quedan <= 2 ? `Quedan solo ${quedan}`
          : `Quedan ${quedan}`,
      ].filter(Boolean).join("\n")
    );

    if (N8N_WEBHOOK_URL) {
      fetch(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venta_id: ventaId, gusto_id: gid, sucursal_id: sid, vendedor_id: vendedorId,
          cantidad: cant, precio_unitario: precioFinal,
          fecha_iso: new Date().toISOString(),
          modelo_nombre: info.modelo_nombre || null,
          gusto_nombre: info.gusto_nombre || null,
          sucursal_nombre: info.sucursal_nombre || null,
        }),
      }).catch((e) => console.error("n8n ventas:", e.message || e));
    }

    return quedan;
  } catch (e) {
    console.error("aviso de venta:", e.message || e);
    return null;
  }
}

module.exports = { registrarVenta };

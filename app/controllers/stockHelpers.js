// ✅ Reutilizable: Función upsertStock centralizada
// Archivo sugerido: controllers/stockHelpers.js

const pool = require("../db");
const { marcar, limpiar } = require("../movimientos");

/**
 * Suma `cantidad` al stock de ese gusto en esa sucursal, creando la fila si no
 * existe.
 *
 * Toma una conexión propia en vez de usar el pool suelto porque el motivo del
 * movimiento viaja en variables de sesión de MySQL: si el SET y el UPDATE
 * caen en conexiones distintas, el registro queda sin motivo.
 */
async function upsertStock(gustoId, sucursalId, cantidad, precio = 0, opciones = {}) {
  const { motivo = "reposicion", referencia = null, usuarioId = null } = opciones;
  const conn = await pool.promise().getConnection();
  try {
    await marcar(conn, motivo, { referencia, usuarioId });
    // Operación atómica: evita race conditions entre SELECT y INSERT/UPDATE concurrentes
    await conn.query(
      `INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad)`,
      [gustoId, sucursalId, cantidad, precio]
    );
  } finally {
    await limpiar(conn).catch(() => {});
    conn.release();
  }
}

module.exports = { upsertStock };

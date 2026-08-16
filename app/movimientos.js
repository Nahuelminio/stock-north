/**
 * Registro de movimientos de stock.
 *
 * Quién movió qué y cuándo no quedaba en ningún lado: para saber a dónde se
 * habían ido unas unidades había que reconstruirlo a mano cruzando ventas,
 * reposiciones, transferencias y pedidos, y los ajustes hechos a mano no
 * dejaban rastro alguno.
 *
 * Lo graban tres triggers sobre la tabla `stock`, así que ningún cambio se
 * escapa, ni siquiera uno hecho por fuera del sistema. Lo único que el trigger
 * no puede adivinar es el porqué: eso lo deja el backend en variables de
 * sesión de MySQL justo antes de tocar el stock, con `marcar()`.
 */

/**
 * Deja anotado el motivo del próximo cambio de stock.
 *
 * Tiene que ir por la MISMA conexión que hace el UPDATE — las variables son
 * por sesión y el pool reparte conexiones distintas. Por eso recibe `conn`
 * (la de la transacción) y no el pool.
 */
async function marcar(conn, motivo, { referencia = null, usuarioId = null } = {}) {
  await conn.query("SET @mov_motivo = ?, @mov_referencia = ?, @mov_usuario = ?", [
    motivo,
    referencia === null || referencia === undefined ? null : String(referencia),
    usuarioId ?? null,
  ]);
}

/**
 * Borra el motivo. Se llama al terminar para que la próxima operación que use
 * esa misma conexión del pool no herede el motivo de la anterior.
 */
async function limpiar(conn) {
  await conn.query("SET @mov_motivo = NULL, @mov_referencia = NULL, @mov_usuario = NULL");
}

/** Corre `fn` con el motivo puesto y lo limpia siempre, incluso si falla. */
async function conMotivo(conn, motivo, opciones, fn) {
  await marcar(conn, motivo, opciones);
  try {
    return await fn();
  } finally {
    await limpiar(conn);
  }
}

module.exports = { marcar, limpiar, conMotivo };

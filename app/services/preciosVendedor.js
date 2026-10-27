const pool = require("../db");

// Lo que un vendedor le paga a la casa por cada unidad de un modelo.
//
// Antes lo escribía él en cada venta, y eso daba la misma V400 a 20.000,
// 20.500 y 21.000 según el día: la deuda dependía de lo que tipeara. Ahora hay
// un precio por modelo que fija el admin, y el vendedor no lo puede tocar.
let tablaLista = null;
function asegurarTabla() {
  if (!tablaLista) {
    tablaLista = (async () => {
      await pool.promise().query(
        `CREATE TABLE IF NOT EXISTS precios_vendedor (
           producto_id INT NOT NULL PRIMARY KEY,
           precio DECIMAL(12,2) NOT NULL,
           recomendado DECIMAL(12,2) NULL,
           actualizado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         )`
      );
      // La tabla nació sin `recomendado`; se agrega si falta.
      const [[col]] = await pool.promise().query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'precios_vendedor'
            AND COLUMN_NAME = 'recomendado'`
      );
      if (!col.n) {
        await pool.promise().query(
          "ALTER TABLE precios_vendedor ADD COLUMN recomendado DECIMAL(12,2) NULL AFTER precio"
        );
      }
    })().catch((e) => { tablaLista = null; throw e; });
  }
  return tablaLista;
}

/** Precio de vendedor del modelo de ese gusto, o null si el admin no lo cargó. */
async function precioDeGusto(conn, gustoId) {
  await asegurarTabla();
  const [[fila]] = await conn.query(
    `SELECT pv.precio FROM gustos g
       JOIN precios_vendedor pv ON pv.producto_id = g.producto_id
      WHERE g.id = ?`,
    [gustoId]
  );
  return fila ? Number(fila.precio) : null;
}

/** { producto_id: precio } con todos los cargados. */
async function mapa() {
  await asegurarTabla();
  const [filas] = await pool.promise().query("SELECT producto_id, precio FROM precios_vendedor");
  return Object.fromEntries(filas.map((f) => [f.producto_id, Number(f.precio)]));
}

module.exports = { asegurarTabla, precioDeGusto, mapa };

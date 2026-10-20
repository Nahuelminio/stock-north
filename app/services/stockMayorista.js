/**
 * Lo que hay en Central para vender al por mayor, con su precio.
 *
 * El precio no sale del que está cargado en la sucursal: ese es el de venta al
 * público, lo tocan los locales y alguno quedó viejo —hay sabores a $10.000 con
 * un costo de US$ 6—. Mostrarle eso a un mayorista sería vender perdiendo.
 *
 * Sale del costo real de cada sabor más el mismo margen que la lista del
 * proveedor, así las dos secciones hablan el mismo idioma y ninguna puede
 * quedar por debajo del costo.
 */

const pool = require("../db");
const { dolarEnFecha } = require("../dolar");
const { MARGEN_USD } = require("./catalogoProveedor");

const CENTRAL = 7;

/**
 * @returns {Promise<Array<{clave, producto, gusto, cantidad, precio}>>}
 */
async function stockParaMayoristas() {
  // El costo en dólares es el de la última reposición. Si esa no lo tiene
  // cargado —hay 552 viejas que no—, se deduce del costo en pesos con el dólar
  // de ese día, que es como lo hace el resto del sistema.
  const [filas] = await pool.promise().query(
    `SELECT g.id AS gusto_id, p.nombre AS producto, g.nombre AS gusto,
            st.cantidad,
            COALESCE(
              (SELECT r.precio_costo_usd FROM reposiciones r
                WHERE r.gusto_id = g.id AND r.precio_costo_usd > 0
                ORDER BY r.fecha DESC LIMIT 1),
              (SELECT ROUND(r.precio_costo / ${dolarEnFecha("r.fecha")}, 2)
                 FROM reposiciones r
                WHERE r.gusto_id = g.id AND r.precio_costo > 0
                ORDER BY r.fecha DESC LIMIT 1)
            ) AS costo_usd
       FROM stock st
       JOIN gustos g ON g.id = st.gusto_id
       JOIN productos p ON p.id = g.producto_id
      WHERE st.sucursal_id = ? AND st.cantidad > 0 AND g.activo = 1
      ORDER BY p.nombre, g.nombre`,
    [CENTRAL]
  );

  // Sin costo no hay precio, y un precio inventado es peor que no ofrecerlo
  return filas
    .filter((f) => Number(f.costo_usd) > 0)
    .map((f) => ({
      clave: `stock-${f.gusto_id}`,
      gusto_id: f.gusto_id,
      producto: f.producto,
      gusto: f.gusto,
      cantidad: f.cantidad,
      precio: Number((Number(f.costo_usd) + MARGEN_USD).toFixed(2)),
    }));
}

/**
 * Lo mismo pero para unas claves puntuales, al guardar un pedido: el precio y
 * el nombre tienen que salir de acá y no de lo que mande el navegador.
 * @param {string[]} claves  "stock-123"
 */
async function stockPorClaves(claves) {
  const ids = claves
    .map((c) => Number(String(c).replace("stock-", "")))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const todo = await stockParaMayoristas();
  return todo.filter((f) => ids.includes(f.gusto_id));
}

module.exports = { stockParaMayoristas, stockPorClaves, CENTRAL };

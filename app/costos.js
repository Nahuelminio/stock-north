/**
 * Costo de la mercadería, en un solo lugar.
 *
 * Antes cada pantalla lo calculaba a su manera y daban números distintos: el
 * Dashboard usaba productos.precio_costo (en cero para la mayoría de los
 * productos) y Métricas las reposiciones reales. Todo lo nuevo sale de acá.
 *
 * El costo de una unidad es el de la reposición de Central más cercana ANTES de
 * la fecha en que se vendió; si no hay ninguna anterior se toma la primera
 * posterior, y si tampoco hay, el promedio del sabor. Mirar la fecha importa:
 * el mismo pod costaba $9.300 el año pasado y $16.000 ahora, así que valuar un
 * pedido viejo con el costo de hoy lo deforma.
 */

const CENTRAL_ID = 7;

/**
 * Devuelve el SQL del costo unitario de un sabor a una fecha.
 * @param {string} gusto  Expresión SQL del gusto_id (ej. "pmi.gusto_id")
 * @param {string} fecha  Expresión SQL de la fecha (ej. "pm.fecha_confirmacion")
 *
 * Ojo: si se pasa "?" como fecha, el SQL queda con DOS placeholders (la tercera
 * rama es el promedio del sabor y no mira la fecha). Hay que mandar la fecha dos
 * veces en los parámetros.
 */
function costoUnitario(gusto, fecha) {
  return `COALESCE(
    (SELECT r.precio_costo FROM reposiciones r
      WHERE r.gusto_id = ${gusto} AND r.precio_costo > 0 AND r.fecha <= ${fecha}
      ORDER BY r.fecha DESC LIMIT 1),
    (SELECT r.precio_costo FROM reposiciones r
      WHERE r.gusto_id = ${gusto} AND r.precio_costo > 0 AND r.fecha > ${fecha}
      ORDER BY r.fecha ASC LIMIT 1),
    (SELECT AVG(r.precio_costo) FROM reposiciones r
      WHERE r.gusto_id = ${gusto} AND r.precio_costo > 0)
  )`;
}

/**
 * Igual que arriba pero sin fecha: el promedio de todas las reposiciones del
 * sabor. Para pedidos todavía sin confirmar, que no tienen fecha de venta.
 */
function costoPromedio(gusto) {
  return `(SELECT AVG(r.precio_costo) FROM reposiciones r
            WHERE r.gusto_id = ${gusto} AND r.precio_costo > 0)`;
}

/**
 * Costo de cada sabor de una lista, a una fecha. Para los pedidos que guardan
 * los items en JSON y no se pueden resolver con un JOIN.
 *
 * @returns {Promise<Map<number, number>>} gusto_id -> costo unitario (0 si no se conoce)
 */
async function costosDeGustos(pool, gustoIds, fecha = null) {
  const ids = [...new Set((gustoIds || []).map(Number).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const [filas] = await pool.promise().query(
    `SELECT g.id AS gusto_id,
            ${fecha ? costoUnitario("g.id", "?") : costoPromedio("g.id")} AS costo
       FROM gustos g WHERE g.id IN (?)`,
    // La fecha va dos veces: es la cantidad de placeholders que deja costoUnitario
    fecha ? [fecha, fecha, ids] : [ids]
  );

  const mapa = new Map();
  for (const f of filas) mapa.set(Number(f.gusto_id), Number(f.costo) || 0);
  return mapa;
}

/** Margen sobre lo facturado, que es como lo muestran todas las pantallas. */
function margenPct(facturado, ganancia) {
  const f = Number(facturado) || 0;
  if (f <= 0) return null;
  return Number(((Number(ganancia) / f) * 100).toFixed(1));
}

module.exports = { CENTRAL_ID, costoUnitario, costoPromedio, costosDeGustos, margenPct };

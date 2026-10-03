/**
 * El dólar de cada fecha, para pasar costos de pesos a USD y al revés.
 *
 * No hay una tabla de cotizaciones: la fuente es el tipo_cambio con el que se
 * confirmó cada pedido mayorista, que es el dólar al que realmente trabajamos
 * ese día. Va de abril de 2026 hasta hoy, con unos 45 días cargados, así que
 * para cualquier fecha reciente siempre hay uno cerca.
 *
 * Contrastado contra los 155 renglones de reposición que tienen cargados los
 * dos valores: el USD calculado así le erra 2% en la mediana, 80% de los casos
 * caen dentro del 5% y 97% dentro del 10%. Sirve para mirar, no para discutirle
 * el precio al proveedor: el valor cargado a mano, cuando existe, manda.
 */

/**
 * Tipo de cambio más cercano a una fecha, como expresión SQL.
 * @param {string} fecha Expresión SQL de la fecha (ej. "r.fecha")
 *
 * Cuidado: deja UN placeholder si se le pasa "?" como fecha.
 */
function dolarEnFecha(fecha) {
  return `(SELECT pm.tipo_cambio FROM pedidos_mayoristas pm
            WHERE pm.tipo_cambio > 0 AND pm.fecha_confirmacion IS NOT NULL
            ORDER BY ABS(TIMESTAMPDIFF(SECOND, pm.fecha_confirmacion, ${fecha}))
            LIMIT 1)`;
}

/** El último dólar que usamos, para lo que se carga hoy. */
async function dolarHoy(pool) {
  const [f] = await pool.promise().query(
    `SELECT tipo_cambio FROM pedidos_mayoristas
      WHERE tipo_cambio > 0 AND fecha_confirmacion IS NOT NULL
      ORDER BY fecha_confirmacion DESC LIMIT 1`
  );
  return f.length ? Number(f[0].tipo_cambio) : null;
}

/**
 * Pasa un costo en pesos a USD con el dólar de esa fecha.
 * @returns {number|null} null si no hay con qué convertir
 */
function aUsd(costoArs, dolar) {
  const c = Number(costoArs);
  const d = Number(dolar);
  if (!(c > 0) || !(d > 0)) return null;
  return Number((c / d).toFixed(2));
}

module.exports = { dolarEnFecha, dolarHoy, aUsd };

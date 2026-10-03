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
 *
 * Para HOY la fuente es la cotización en vivo del dólar cripto (dolarapi.com),
 * que es al que compramos: el 3/10 daba $1.613,87 contra los $1.610 que se
 * venían cargando a mano, así que es el mismo dólar sin tener que tipearlo.
 *
 * Ojo con mezclarlos. El dólar de hoy sirve para lo que se carga hoy y para
 * saber qué saldría reponer el stock ahora; una compra de junio se valúa con el
 * dólar de junio, porque convertir un costo viejo a la cotización de hoy no
 * dice lo que pagaste sino lo que pagarías, que es otra pregunta.
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

/** El último dólar que cargamos a mano, por si la API no contesta. */
async function dolarDeLosPedidos(pool) {
  const [f] = await pool.promise().query(
    `SELECT tipo_cambio FROM pedidos_mayoristas
      WHERE tipo_cambio > 0 AND fecha_confirmacion IS NOT NULL
      ORDER BY fecha_confirmacion DESC LIMIT 1`
  );
  return f.length ? Number(f[0].tipo_cambio) : null;
}

// La cotización se pide una vez cada diez minutos y queda guardada acá: no
// tiene sentido salir a internet en cada carga de pantalla, y si la API se cae
// seguimos mostrando el último valor bueno en vez de un hueco.
const CACHE_MS = 10 * 60 * 1000;
let cache = { valor: null, cuando: 0 };

// Qué cotización usamos. El cripto es al que compramos: el 3/10 estaba en
// $1.613,87 contra los $1.610 que se venían cargando a mano, mientras que el
// blue daba $1.560 y el oficial $1.540. Se cambia con DOLAR_CASA sin tocar
// código: sirven oficial, blue, bolsa, contadoconliqui, mayorista, cripto.
const CASA = process.env.DOLAR_CASA || "cripto";

/**
 * El dólar cripto de hoy, que es al que compramos.
 * @returns {Promise<number|null>} null si la API no contesta y no hay cache
 */
async function dolarCripto() {
  if (cache.valor && Date.now() - cache.cuando < CACHE_MS) return cache.valor;
  try {
    const ctrl = new AbortController();
    const corte = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`https://dolarapi.com/v1/dolares/${CASA}`, { signal: ctrl.signal });
    clearTimeout(corte);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    // "venta" es lo que pagamos nosotros por comprar dólares
    const v = Number(j?.venta);
    if (!(v > 0)) throw new Error("respuesta sin venta");
    cache = { valor: v, cuando: Date.now(), casa: j?.nombre || CASA };
    return v;
  } catch (e) {
    console.warn("⚠️  dolarapi no contestó:", e.message);
    return cache.valor; // el último bueno, o null
  }
}

/**
 * El dólar de hoy para cargar costos: primero la cotización en vivo, y si no
 * hay, el último tipo de cambio que se usó a mano.
 * @returns {Promise<{dolar: number|null, fuente: string}>}
 */
async function dolarHoy(pool) {
  const cripto = await dolarCripto();
  if (cripto) return { dolar: cripto, fuente: cache.casa || CASA };
  const manual = await dolarDeLosPedidos(pool);
  return { dolar: manual, fuente: manual ? "pedidos" : "ninguna" };
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

module.exports = { dolarEnFecha, dolarHoy, dolarCripto, dolarDeLosPedidos, aUsd };

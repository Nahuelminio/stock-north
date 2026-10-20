/**
 * La lista de lo que tiene el proveedor, siempre al día.
 *
 * Italia Shop es una tienda WooCommerce, y WooCommerce publica su catálogo por
 * una API abierta (wp-json/wc/store/v1). No hace falta scrapear el HTML: se
 * piden siete páginas de cien y vienen los 644 descartables con nombre, SKU y
 * disponibilidad, como datos y no como texto para adivinar. Y no se rompe
 * cuando cambian el diseño de la página, que es lo que sí rompe un scrape.
 *
 * Se guarda por SKU y no por nombre: el SKU es el identificador del proveedor y
 * no se mueve, mientras que un cambio de mayúsculas en el nombre ya haría que
 * el mismo producto entre dos veces.
 *
 * Lo que desaparece de su catálogo NO se borra: se marca como ausente. Si el
 * proveedor tiene media hora de error, una corrida vacía borraría la lista
 * entera; así, lo peor que pasa es que quede un día desactualizada.
 */

const pool = require("../db");
const { avisarTelegram } = require("./telegram");

const API = "https://italiashop.com.py/wp-json/wc/store/v1/products";
const CATEGORIA = "descartables";

/**
 * Cuánto se le suma al precio de la web del proveedor para armar el precio de
 * la lista. Se cambia con MARGEN_USD sin tocar código.
 *
 * El precio de la web no es lo que paga Nahuel: le facturan entre 8% y 11% más
 * barato. Así que sumarle dos deja algo más de dos de ganancia real, y nunca
 * menos, que es el lado por el que conviene equivocarse.
 */
const MARGEN_USD = Number(process.env.MARGEN_USD || 2);
const CADA_MS = 6 * 60 * 60 * 1000;

/**
 * Parte "IGNITE V300 BLACK STRAWBERRY ICE" en modelo y gusto.
 *
 * El proveedor manda un solo texto, así que el corte sale de mirar todos los
 * nombres juntos: lo que se repite al principio es el modelo y lo que cambia es
 * el gusto. Para cada nombre se busca el prefijo más largo que compartan al
 * menos tres productos, dejando siempre una palabra para el gusto.
 *
 * Tres es el mínimo que distingue un modelo de una casualidad: "IGNITE V155
 * MATTE BLACK" lo comparten cuatro y es un modelo; "IGNITE V155 ORANGE" lo
 * comparte uno solo, así que ahí el modelo es "IGNITE V155" y naranja es gusto.
 */
function partirNombres(nombres) {
  const cuenta = new Map();
  for (const n of nombres) {
    const t = n.trim().split(/\s+/);
    for (let i = 1; i < t.length; i++) {
      const pre = t.slice(0, i).join(" ");
      cuenta.set(pre, (cuenta.get(pre) || 0) + 1);
    }
  }

  return (nombre) => {
    const t = nombre.trim().split(/\s+/);
    let corte = 1;
    for (let i = 1; i < t.length; i++) {
      if ((cuenta.get(t.slice(0, i).join(" ")) || 0) >= 3) corte = i;
    }
    // Un modelo que aparece una sola vez nunca llega a tres, y queda cortado a
    // la mitad: "NIKBAR | 25000 BLUEBERRY". Lo que arranca con un número o con
    // V123 es parte del modelo, no un gusto.
    while (corte < t.length - 1 && /^(\d|v\d)/i.test(t[corte])) corte++;
    return { modelo: t.slice(0, corte).join(" "), gusto: t.slice(corte).join(" ") };
  };
}

/** Pide el catálogo entero. @returns {Promise<Array>} */
async function bajarCatalogo() {
  const todos = [];
  for (let pagina = 1; pagina <= 20; pagina++) {
    const ctrl = new AbortController();
    const corte = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(
      `${API}?category=${CATEGORIA}&per_page=100&page=${pagina}`,
      { headers: { "User-Agent": "north-stock/1.0" }, signal: ctrl.signal }
    ).finally(() => clearTimeout(corte));

    if (!r.ok) throw new Error(`La tienda contestó ${r.status}`);
    const lote = await r.json();
    if (!lote.length) break;
    todos.push(...lote);
    if (lote.length < 100) break;
  }
  return todos;
}

/**
 * Una pasada: baja, parte en modelo y gusto, y guarda.
 * @returns {Promise<{ok: boolean, total?: number, nuevos?: number, ausentes?: number, error?: string}>}
 */
async function sincronizar() {
  let crudos;
  try {
    crudos = await bajarCatalogo();
  } catch (e) {
    console.error("❌ catálogo proveedor:", e.message);
    return { ok: false, error: e.message };
  }

  // Una corrida que trae mucho menos de lo que había es un problema de ellos,
  // no una liquidación: se avisa y no se toca nada.
  const [[antes]] = await pool.promise().query(
    "SELECT COUNT(*) AS n FROM catalogo_proveedor WHERE presente = 1"
  );
  if (antes.n > 50 && crudos.length < antes.n / 2) {
    const aviso = `⚠️ El catálogo de Italia Shop trajo ${crudos.length} productos ` +
                  `cuando ayer había ${antes.n}. No actualicé nada por las dudas.`;
    console.warn(aviso);
    avisarTelegram(aviso);
    return { ok: false, error: "vino menos de la mitad" };
  }

  const partir = partirNombres(crudos.map((p) => p.name));
  const vistos = [];
  let nuevos = 0;

  for (const p of crudos) {
    const sku = String(p.sku || p.id);
    const { modelo, gusto } = partir(p.name);

    // WooCommerce manda el precio en la unidad más chica de la moneda: "1100"
    // con currency_minor_unit 2 son 11 dólares, no mil cien.
    const escala = 10 ** Number(p.prices?.currency_minor_unit ?? 2);
    const crudo = Number(p.prices?.price);
    const precio = Number.isFinite(crudo) && crudo > 0
      ? Number((crudo / escala).toFixed(2)) : null;

    const [r] = await pool.promise().query(
      `INSERT INTO catalogo_proveedor
         (sku, nombre, modelo, gusto, precio_usd, hay, presente, visto)
       VALUES (?, ?, ?, ?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE
         nombre = VALUES(nombre), modelo = VALUES(modelo), gusto = VALUES(gusto),
         precio_usd = VALUES(precio_usd),
         hay = VALUES(hay), presente = 1, visto = NOW()`,
      [sku, p.name, modelo, gusto, precio, p.is_in_stock ? 1 : 0]
    );
    if (r.affectedRows === 1) nuevos++;   // 1 es alta, 2 es actualización
    vistos.push(sku);
  }

  const [aus] = await pool.promise().query(
    `UPDATE catalogo_proveedor SET presente = 0
      WHERE presente = 1 AND sku NOT IN (?)`,
    [vistos]
  );

  console.log(`📦 Catálogo: ${crudos.length} productos, ${nuevos} nuevos, ` +
              `${aus.affectedRows} que ya no están`);
  return { ok: true, total: crudos.length, nuevos, ausentes: aus.affectedRows };
}

/** Arranca el ciclo: una pasada al minuto de levantar y después cada seis horas. */
function arrancar() {
  setTimeout(() => sincronizar().catch(() => {}), 60 * 1000);
  setInterval(() => sincronizar().catch(() => {}), CADA_MS);
}

module.exports = { sincronizar, arrancar, partirNombres, MARGEN_USD };

/**
 * La lista de stock para mandar por WhatsApp.
 *
 * Es la misma que armaba el flujo de n8n, traída acá para no depender de un
 * servicio que se paga todos los meses. Se mantuvo el formato tal cual porque
 * ya está probado y es el que los clientes están acostumbrados a recibir.
 *
 * Dos cosas que se arreglaron al traerla:
 *
 *  - Las sucursales salen de la base, no de un mapa escrito a mano. En n8n
 *    había dos mapas distintos y ninguno tenía Weekend Bebidas, así que esa
 *    sucursal simplemente no se podía listar.
 *  - El mensaje va sin parse_mode. n8n lo mandaba como HTML y funcionaba de
 *    casualidad: un "<" o un "&" en el nombre de un producto hacía que
 *    Telegram rechazara el mensaje entero.
 */

const pool = require("../db");
const { buscarSucursal } = require("./herramientas");

const LINEA = "━━━━━━━━━━━━━━━━━━";
const LIMITE = 3500; // Telegram corta en 4096; cortamos antes por bloques enteros

/** Un asterisco suelto en un nombre partiría la negrita de WhatsApp. */
const esc = (s) => String(s ?? "").replace(/\*/g, "");
const negrita = (s) => `*${esc(s)}*`;
const limpio = (s) => String(s || "").replace(/\s+/g, " ").trim();

// La medida del modelo: puffs, ml, gramos (tabaco) o mAh (baterías)
const RE_MEDIDA = /^(\d{1,3}(?:\.\d{3})*|\d+)\s*(puffs?|ml|g|mah)$/i;

/**
 * "Elfbar BC15000 - 15.000 puffs - Sakura grape" se parte en
 * modelo, medida y gusto. Sin separar la medida, el tabaco salía como
 * "TABACO ADALYA" con el gusto "50g - Homero" pegado.
 */
function partirNombre(producto, gusto) {
  const modelo = limpio(producto);
  const partes = modelo.split(/\s*[-–—]\s*/).map(limpio).filter(Boolean);

  let medida = "";
  const resto = [];
  for (let i = 1; i < partes.length; i++) {
    if (!medida && RE_MEDIDA.test(partes[i])) { medida = partes[i]; continue; }
    resto.push(partes[i]);
  }

  return {
    modelo: partes[0] || modelo,
    medida,
    gusto: limpio(gusto) || resto.join(" - ") || "S/gusto",
  };
}

/**
 * Arma la lista de una sucursal, o de todas.
 * @param {string} nombreSucursal  "central", "weekend", "todas"...
 * @returns {Promise<{ok: boolean, error?: string, sucursal?: string, unidades?: number, partes?: string[]}>}
 */
async function listaDeStock(nombreSucursal) {
  const pedido = limpio(nombreSucursal).toLowerCase();
  const TODAS = ["all", "todo", "todos", "todas", "general", ""];
  const esTodas = TODAS.includes(pedido);

  let suc = null;
  if (!esTodas) {
    suc = await buscarSucursal(pedido);
    if (!suc) {
      const [ss] = await pool.promise().query(
        "SELECT nombre FROM sucursales WHERE activo = 1 OR activo IS NULL ORDER BY nombre"
      );
      return {
        ok: false,
        error: `No encontré la sucursal "${nombreSucursal}".`,
        sucursales: ss.map((s) => s.nombre),
      };
    }
  }

  const [filas] = await pool.promise().query(
    `SELECT p.nombre AS producto, g.nombre AS gusto, s.nombre AS sucursal,
            st.cantidad AS stock
       FROM stock st
       JOIN gustos g ON g.id = st.gusto_id
       JOIN productos p ON p.id = g.producto_id
       JOIN sucursales s ON s.id = st.sucursal_id
      WHERE st.cantidad > 0 ${suc ? "AND st.sucursal_id = ?" : ""}
      ORDER BY p.nombre, g.nombre`,
    suc ? [suc.id] : []
  );

  const titulo = suc ? suc.nombre : "Todas las sucursales";

  if (filas.length === 0) {
    return { ok: true, sucursal: titulo, unidades: 0, partes: [], vacio: true };
  }

  // Agrupar por modelo + medida
  const grupos = new Map();
  for (const f of filas) {
    const { modelo, medida, gusto } = partirNombre(f.producto, f.gusto);
    const clave = `${modelo}||${medida}`;
    if (!grupos.has(clave)) grupos.set(clave, { modelo, medida, items: [] });
    grupos.get(clave).items.push({ gusto, suc: f.sucursal });
  }

  const bloques = [];
  for (const { modelo, medida, items } of [...grupos.values()].sort(
    (a, b) => a.modelo.localeCompare(b.modelo) || a.medida.localeCompare(b.medida)
  )) {
    // El modelo en negrita y la medida normal: el ojo salta de modelo a modelo
    const cabeza = medida
      ? `📦 ${negrita(modelo.toUpperCase())} — ${esc(medida.toUpperCase())}`
      : `📦 ${negrita(modelo.toUpperCase())}`;

    const vistos = new Set();
    const lineas = [];
    for (const it of items) {
      const clave = esTodas ? `${it.gusto}||${it.suc}` : it.gusto;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      lineas.push(`•  ${esc(it.gusto)}${esTodas ? `  (${esc(it.suc)})` : ""}`);
    }
    bloques.push(`${cabeza}\n\n${lineas.join("\n")}`);
  }

  // La marca va sola en su renglón. Junta con "STOCK DISPONIBLE" daba 40
  // caracteres y en el celular se partía justo en el medio del nombre.
  const encabezado =
    `🔥 ${negrita("THE NORTH SHOP")} 🔥\n` +
    `STOCK DISPONIBLE\n` +
    `📍 ${negrita(esTodas ? titulo : `Sucursal ${titulo}`)}`;

  const pie =
    `📲 Consultanos por disponibilidad y sabores.\n\n` +
    `${negrita("THE NORTH SHOP")}\n📍 ${esc(titulo)}`;

  // Se parte por bloques enteros: un modelo nunca queda cortado al medio
  const partes = [];
  let actual = encabezado;
  for (const bloque of bloques) {
    const conBloque = `${actual}\n\n${LINEA}\n\n${bloque}`;
    if (conBloque.length > LIMITE && actual !== encabezado) {
      partes.push(actual);
      actual = `${encabezado}\n\n${LINEA}\n\n${bloque}`;
    } else {
      actual = conBloque;
    }
  }
  partes.push(`${actual}\n\n${LINEA}\n\n${pie}`);

  return {
    ok: true,
    sucursal: titulo,
    modelos: grupos.size,
    renglones: filas.length,
    unidades: filas.reduce((a, f) => a + Number(f.stock), 0),
    partes,
  };
}

/**
 * Las sucursales que se pueden pedir, con lo que tienen hoy. Sale de la base
 * para que al crear una nueva aparezca sola, sin tocar el bot.
 * Se muestran las que tienen stock primero: pedir una vacía no sirve de nada.
 */
async function sucursalesDisponibles() {
  const [filas] = await pool.promise().query(
    `SELECT s.nombre,
            COALESCE((SELECT SUM(st.cantidad) FROM stock st
                       WHERE st.sucursal_id = s.id), 0) AS unidades
       FROM sucursales s
      WHERE s.activo = 1 OR s.activo IS NULL
      ORDER BY unidades DESC, s.nombre`
  );
  return filas.map((f) => ({ nombre: f.nombre, unidades: Number(f.unidades) }));
}

module.exports = { listaDeStock, sucursalesDisponibles };

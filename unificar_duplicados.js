/**
 * Unifica los productos que están cargados varias veces con el mismo nombre.
 *
 * El mismo modelo quedó partido en hasta 4 productos porque los nombres
 * difieren en cosas invisibles: un tabulador al final, "15.000" contra "15000".
 * Para el sistema son productos distintos, así que el stock, las ventas y sobre
 * todo los costos de reposición quedaron repartidos entre las copias, y en
 * Costos Central aparecen filas repetidas a las que "les faltan" costos.
 *
 * Qué hace, por cada grupo de copias:
 *   1. elige como destino el producto con más historial (reposiciones + ventas)
 *   2. mueve al destino los sabores que no existan ahí
 *   3. los sabores repetidos los fusiona en uno solo: repunta ventas,
 *      reposiciones y demás referencias, y SUMA el stock por sucursal
 *   4. borra los sabores y los productos que quedaron vacíos
 *
 * Corre en una transacción y verifica que los totales no cambien. Si algo no
 * cuadra, deshace todo.
 *
 * Uso:
 *   node unificar_duplicados.js            -> simulación, no escribe nada
 *   node unificar_duplicados.js --aplicar  -> ejecuta de verdad
 */
require("dotenv").config({ quiet: true });
const pool = require("./app/db");

const APLICAR = process.argv.includes("--aplicar");

// Nombres que solo difieren en mayúsculas, espacios, tabs o puntos son el mismo
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Todo lo que apunta a un gusto y hay que repuntar al fusionar
const REFERENCIAS = [
  ["ventas", "gusto_id"],
  ["reposiciones", "gusto_id"],
  ["evento_items", "gusto_id"],
  ["pedido_mayorista_items", "gusto_id"],
  ["transferencia_stock_items", "gusto_id"],
  ["orden_reposicion_items", "gusto_id"],
  ["cliente_intereses", "gusto_id"],
];

async function totales(conn) {
  const uno = async (sql) => (await conn.query(sql))[0][0];
  return {
    stock: Number((await uno("SELECT COALESCE(SUM(cantidad),0) v FROM stock")).v),
    ventas: Number((await uno("SELECT COALESCE(SUM(cantidad),0) v FROM ventas")).v),
    ventas_filas: Number((await uno("SELECT COUNT(*) v FROM ventas")).v),
    repos: Number((await uno("SELECT COALESCE(SUM(cantidad_repuesta),0) v FROM reposiciones")).v),
    repos_filas: Number((await uno("SELECT COUNT(*) v FROM reposiciones")).v),
    repos_con_costo: Number((await uno("SELECT COALESCE(SUM(precio_costo>0),0) v FROM reposiciones")).v),
    mayorista: Number((await uno("SELECT COALESCE(SUM(cantidad),0) v FROM pedido_mayorista_items")).v),
  };
}

(async () => {
  const conn = await pool.promise().getConnection();
  const log = [];
  try {
    await conn.beginTransaction();
    const antes = await totales(conn);

    const [prods] = await conn.query(`
      SELECT p.id, p.nombre,
        (SELECT COUNT(*) FROM reposiciones r JOIN gustos g ON g.id=r.gusto_id WHERE g.producto_id=p.id) repos,
        (SELECT COALESCE(SUM(v.cantidad),0) FROM ventas v JOIN gustos g ON g.id=v.gusto_id WHERE g.producto_id=p.id) vendidas
      FROM productos p`);

    const grupos = new Map();
    for (const p of prods) {
      const k = norm(p.nombre);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(p);
    }

    let gustosMovidos = 0, gustosFusionados = 0, productosBorrados = 0, stockSumado = 0;
    let codigosRescatados = 0, preciosAjustados = 0;
    const destinos = [];

    for (const grupo of [...grupos.values()].filter((v) => v.length > 1)) {
      const destino = [...grupo].sort((a, b) => (b.repos + b.vendidas) - (a.repos + a.vendidas))[0];
      const otros = grupo.filter((p) => p.id !== destino.id);
      destinos.push(destino.id);
      log.push(`\n${destino.nombre.trim()}  (destino: ${destino.id}, absorbe ${otros.map((o) => o.id).join(", ")})`);

      // Todos los sabores del grupo, empezando por los del destino
      const ids = [destino.id, ...otros.map((o) => o.id)];
      const [gustos] = await conn.query(
        `SELECT id, producto_id, nombre, codigo_barra FROM gustos WHERE producto_id IN (${ids.map(() => "?").join(",")}) ORDER BY producto_id = ? DESC, id`,
        [...ids, destino.id]
      );

      // El primero de cada nombre se queda; el resto se fusiona contra él.
      // Esto tambien junta los sabores repetidos DENTRO de un mismo producto.
      const principal = new Map();
      for (const g of gustos) {
        const k = norm(g.nombre);
        const jefe = principal.get(k);

        if (!jefe) {
          principal.set(k, g);
          if (g.producto_id !== destino.id) {
            await conn.query("UPDATE gustos SET producto_id=? WHERE id=?", [destino.id, g.id]);
            gustosMovidos++;
          }
          continue;
        }

        // El código de barra del sabor que se borra se rescata: si no, el
        // lector deja de encontrar ese producto.
        if (g.codigo_barra && !jefe.codigo_barra) {
          await conn.query("UPDATE gustos SET codigo_barra=? WHERE id=?", [g.codigo_barra, jefe.id]);
          jefe.codigo_barra = g.codigo_barra;
          codigosRescatados++;
        }

        // Fusión: primero el stock, que tiene único (gusto_id, sucursal_id)
        const [filasStock] = await conn.query("SELECT sucursal_id, cantidad, precio FROM stock WHERE gusto_id=?", [g.id]);
        for (const s of filasStock) {
          const [[existe]] = await conn.query(
            "SELECT id, cantidad, precio FROM stock WHERE gusto_id=? AND sucursal_id=?", [jefe.id, s.sucursal_id]);
          if (existe) {
            // Las dos copias pueden tener precios distintos. Se conserva el más
            // alto para no terminar vendiendo a un precio viejo por error; si el
            // que queda no tiene precio, se toma el otro.
            const precioFinal = Number(existe.precio) > 0
              ? Math.max(Number(existe.precio), Number(s.precio))
              : Number(s.precio);
            if (precioFinal !== Number(existe.precio)) preciosAjustados++;
            await conn.query("UPDATE stock SET cantidad=cantidad+?, precio=? WHERE id=?",
              [s.cantidad, precioFinal, existe.id]);
            stockSumado += Number(s.cantidad);
          } else {
            await conn.query("UPDATE stock SET gusto_id=? WHERE gusto_id=? AND sucursal_id=?", [jefe.id, g.id, s.sucursal_id]);
          }
        }
        await conn.query("DELETE FROM stock WHERE gusto_id=?", [g.id]);

        for (const [tabla, col] of REFERENCIAS) {
          await conn.query(`UPDATE ${tabla} SET ${col}=? WHERE ${col}=?`, [jefe.id, g.id]);
        }
        await conn.query("DELETE FROM gustos WHERE id=?", [g.id]);
        gustosFusionados++;
      }

      // Los productos vacíos se borran. Se comprueba que no quede nada colgado:
      // el borrado en cascada se llevaría gustos, stock y reposiciones.
      for (const o of otros) {
        const [[quedan]] = await conn.query("SELECT COUNT(*) n FROM gustos WHERE producto_id=?", [o.id]);
        if (Number(quedan.n) > 0) throw new Error(`El producto ${o.id} todavía tiene ${quedan.n} sabores`);
        await conn.query("DELETE FROM productos WHERE id=?", [o.id]);
        productosBorrados++;
      }
    }

    const despues = await totales(conn);

    // Cómo queda Costos Central para los modelos tocados: es el motivo del
    // arreglo, así que conviene verlo antes de confirmar.
    const [resultado] = await conn.query(`
      SELECT p.id, p.nombre,
             COUNT(DISTINCT g.id) sabores,
             SUM(r.precio_costo > 0) repos_con_costo,
             COUNT(r.id) repos,
             ROUND(AVG(NULLIF(r.precio_costo, 0))) costo_prom
        FROM productos p
        JOIN gustos g ON g.producto_id = p.id
        LEFT JOIN reposiciones r ON r.gusto_id = g.id
       WHERE p.id IN (${destinos.map(() => "?").join(",")})
       GROUP BY p.id, p.nombre ORDER BY p.nombre`, destinos);

    console.log(log.join("\n"));
    console.log("\n=== COMO QUEDA CADA MODELO (una sola fila por modelo)");
    for (const r of resultado) {
      console.log(`  ${r.nombre.trim().padEnd(36)} ${String(r.sabores).padStart(3)} sabores · ` +
        `${r.repos_con_costo}/${r.repos} repos con costo · costo prom ${r.costo_prom ? "$" + Number(r.costo_prom).toLocaleString("es-AR") : "sin datos"}`);
    }
    console.log(`\n=== ${APLICAR ? "APLICADO" : "SIMULACIÓN (no se escribió nada)"}`);
    console.log(`sabores mudados:      ${gustosMovidos}`);
    console.log(`sabores fusionados:   ${gustosFusionados}`);
    console.log(`stock sumado:         ${stockSumado} unidades`);
    console.log(`productos eliminados: ${productosBorrados}`);
    console.log(`codigos de barra rescatados: ${codigosRescatados}`);
    console.log(`precios corregidos:   ${preciosAjustados}`);

    console.log("\n=== CONTROL (tiene que dar igual antes y después)");
    let ok = true;
    for (const k of Object.keys(antes)) {
      const igual = antes[k] === despues[k];
      if (!igual) ok = false;
      console.log(`  ${igual ? "OK " : "!! "} ${k.padEnd(16)} ${antes[k]} -> ${despues[k]}`);
    }
    if (!ok) throw new Error("Los totales cambiaron: no se aplica nada");

    if (APLICAR) { await conn.commit(); console.log("\nCambios confirmados."); }
    else { await conn.rollback(); console.log("\nSimulación deshecha. Para aplicar: node unificar_duplicados.js --aplicar"); }
  } catch (e) {
    await conn.rollback();
    console.error("\nERROR, no se cambió nada:", e.message);
  } finally {
    conn.release();
    process.exit(0);
  }
})();

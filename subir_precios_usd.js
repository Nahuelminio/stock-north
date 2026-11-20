/**
 * Aumento por la suba del dólar (20/11/2026).
 *
 * - Solo pods y cartuchos: quedan afuera esencias, salts, tabaco y baterías.
 * - El monto se decide por modelo, mirando su precio más alto en las
 *   sucursales donde HAY stock (los renglones vacíos tienen precios viejos): hasta $18.000 sube $1.000, más de eso $1.500. Así el mismo modelo
 *   sube lo mismo en todos lados aunque cada local tenga su precio.
 * - Sube en todas las sucursales, desde el precio que ya tiene cada una, incluso
 *   en los renglones en cero, para que lo que entre después ya entre al precio nuevo.
 * - El precio de vendedor del modelo sube lo mismo.
 * - Un renglón con stock y precio absurdo (< $5.000, como un Lost Mary Dura a
 *   $1.900) se lleva primero al precio más alto del modelo. Los vacíos con
 *   precio absurdo no se tocan. Los "productos de prueba" quedan afuera.
 *
 *   node subir_precios_usd.js            → muestra qué haría
 *   node subir_precios_usd.js --aplicar  → respalda y aplica
 */
require("dotenv").config();
const mysql = require("mysql2/promise");
const fs = require("fs");

const UMBRAL = 18000;
const NO_POD = /salt|esencia|tabaco|bater|prueba|\b\d+\s*ml\b|\b\d+\s*g\b/i;

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

  const [filas] = await c.query(`
    SELECT st.gusto_id, st.sucursal_id, st.precio, st.cantidad, p.id AS producto_id, p.nombre AS modelo
      FROM stock st JOIN gustos g ON g.id = st.gusto_id JOIN productos p ON p.id = g.producto_id
     WHERE st.precio > 0`);

  const modelos = new Map();
  for (const f of filas) {
    if (NO_POD.test(f.modelo)) continue;
    const m = modelos.get(f.producto_id) || { nombre: f.modelo, max: 0, maxTodos: 0, filas: [], stock: 0 };
    m.filas.push(f);
    m.stock += Number(f.cantidad);
    // El $1.900 no cuenta para decidir: es un error
    if (Number(f.precio) >= 5000) {
      m.maxTodos = Math.max(m.maxTodos, Number(f.precio));
      if (Number(f.cantidad) > 0) m.max = Math.max(m.max, Number(f.precio));
    }
    modelos.set(f.producto_id, m);
  }
  const afuera = [...new Set(filas.filter((f) => NO_POD.test(f.modelo)).map((f) => f.modelo))];

  const cambios = [];
  for (const [pid, m] of modelos) {
    if (!m.max) m.max = m.maxTodos;          // sin stock en ningún lado
    m.suba = m.max > UMBRAL ? 1500 : 1000;
    for (const f of m.filas) {
      const absurdo = Number(f.precio) < 5000;
      if (absurdo && !(Number(f.cantidad) > 0)) continue;
      const base = absurdo ? m.max : Number(f.precio);
      cambios.push({ ...f, nuevo: base + m.suba, corregido: base !== Number(f.precio) });
    }
  }

  const conStock = [...modelos.values()].filter((m) => m.stock > 0).sort((a, b) => b.stock - a.stock);
  console.table(conStock.map((m) => ({ modelo: m.nombre.slice(0, 36), stock: m.stock, max: m.max, suba: m.suba })));
  console.log(`Modelos sin stock que igual suben: ${modelos.size - conStock.length}`);
  console.log("Quedan afuera:", afuera.join(" | "));
  console.log("Corregidos:", cambios.filter((x) => x.corregido).map((x) => `${x.modelo} suc ${x.sucursal_id}: ${x.precio} → ${x.nuevo}`));
  console.log(`Renglones a cambiar: ${cambios.length}`);

  const [vend] = await c.query("SELECT producto_id, precio FROM precios_vendedor");
  const vendCambios = vend.filter((v) => modelos.has(v.producto_id))
    .map((v) => ({ ...v, nuevo: Number(v.precio) + modelos.get(v.producto_id).suba, modelo: modelos.get(v.producto_id).nombre }));
  console.log("Precios de vendedor:");
  console.table(vendCambios.map((v) => ({ modelo: v.modelo.slice(0, 36), antes: Number(v.precio), despues: v.nuevo })));

  if (process.argv[2] !== "--aplicar") { console.log("\nCorré con --aplicar."); await c.end(); return; }

  const archivo = `respaldos/precios_antes_suba_${Date.now()}.json`;
  fs.writeFileSync(archivo, JSON.stringify({ stock: cambios.map(({ gusto_id, sucursal_id, precio }) => ({ gusto_id, sucursal_id, precio })), vendedor: vend }, null, 1));
  console.log("Respaldo en", archivo);

  await c.beginTransaction();
  try {
    for (const x of cambios) {
      await c.query("UPDATE stock SET precio = ? WHERE gusto_id = ? AND sucursal_id = ? AND precio = ?",
        [x.nuevo, x.gusto_id, x.sucursal_id, x.precio]);
    }
    for (const v of vendCambios) {
      await c.query("UPDATE precios_vendedor SET precio = ? WHERE producto_id = ?", [v.nuevo, v.producto_id]);
    }
    await c.commit();
    console.log(`✅ ${cambios.length} renglones de stock y ${vendCambios.length} precios de vendedor actualizados.`);
  } catch (e) {
    await c.rollback();
    console.error("❌ No se cambió nada:", e.message);
  } finally {
    await c.end();
  }
})();

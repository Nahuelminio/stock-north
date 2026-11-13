/**
 * Compra a Italia Shop del 09/11/2026 — cotización S12599.
 * 137 unidades, USD 899,95. Strawberry Kiwi viene en dos renglones (10 + 10)
 * y va como uno solo de 20.
 *
 * Queda PENDIENTE: el stock entra al confirmarla.
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

const CENTRAL = 7;
const TC = Number(process.env.TC || 1620);
const PASE = Number(process.env.PASE || 0.30);

const REACTIVAR = [];

// [gusto_id | {p: producto, s: sabor, v: precio de venta en Central}, cantidad, usd]
const DOJO = 83;
const COMPRAS = [
  {
    papel: "cotización S12599", total: 899.95, unidades: 137,
    renglones: [
      // Vaporesso Dojo X
      [1278, 10, 6.50], [{ p: DOJO, s: "Strawberry kiwi", v: 20000 }, 20, 6.50],
      [1277, 10, 6.50], [1275, 10, 6.50], [1274, 10, 6.50], [1273, 15, 6.50],
      [1308, 10, 6.50], [1312, 15, 6.50],
      [{ p: DOJO, s: "Peach smash", v: 20000 }, 5, 6.50],
      [{ p: DOJO, s: "Pink lemonade", v: 20000 }, 5, 6.50],
      [1311, 5, 6.50], [1276, 5, 6.50],
      [{ p: DOJO, s: "Strawberry slam dunk", v: 20000 }, 10, 6.50],
      // Life Pod Eco III — cartucho
      [1259, 3, 7.85], [1263, 2, 7.85], [1261, 2, 7.85],
    ],
  },
];

(async () => {
  let mal = false;
  for (const k of COMPRAS) {
    const u = k.renglones.reduce((a, [, n]) => a + n, 0);
    const t = k.renglones.reduce((a, [, n, usd]) => a + n * usd, 0);
    const ok = u === k.unidades && Math.abs(t - k.total) < 0.01;
    if (!ok) mal = true;
    console.log(`${ok ? "✔" : "✗"} ${k.papel}: ${k.renglones.length} renglones, ${u}u, ` +
                `USD ${t.toFixed(2)} (papel ${k.total}) → con pase ${(t + u * PASE).toFixed(2)}, ` +
                `$${Math.round((t + u * PASE) * TC).toLocaleString("es-AR")} a ${TC}`);
  }
  if (mal) { console.error("❌ No cuadra con los papeles."); process.exit(1); }

  const c = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

  const existentes = COMPRAS.flatMap((k) => k.renglones.map(([g]) => g))
    .filter((g) => typeof g === "number");
  const [rev] = await c.query(
    `SELECT g.id, g.nombre, g.activo, p.nombre AS producto, st.precio
       FROM gustos g JOIN productos p ON p.id = g.producto_id
       LEFT JOIN stock st ON st.gusto_id = g.id AND st.sucursal_id = ?
      WHERE g.id IN (?)`, [CENTRAL, [...new Set(existentes)]]);
  const raros = rev.filter((r) => !(r.precio > 0) || (!r.activo && !REACTIVAR.includes(r.id)));
  console.log(`\nExistentes: ${rev.length} sabores. A reactivar: ` +
    rev.filter((r) => REACTIVAR.includes(r.id)).map((r) => `${r.nombre} ($${r.precio ?? "-"})`).join(", "));
  if (raros.length) {
    console.log("⚠️  Sin precio o dados de baja:");
    raros.forEach((r) => console.log(`   ${r.id} ${r.producto} | ${r.nombre} $${r.precio}`));
  }
  const nuevos = COMPRAS.flatMap((k) => k.renglones.map(([g]) => g))
    .filter((g) => typeof g === "object");
  console.log(`Nuevos: ${nuevos.length} sabores`);

  if (process.argv[2] !== "--cargar") { console.log("\nCorré con --cargar."); await c.end(); return; }
  if (raros.length) { console.error("No cargo con esos problemas."); await c.end(); return; }

  await c.beginTransaction();
  try {
    if (REACTIVAR.length) await c.query("UPDATE gustos SET activo = 1 WHERE id IN (?)", [REACTIVAR]);
    const creados = new Map();
    for (const k of COMPRAS) {
      const items = [];
      for (const [g, cantidad, usd] of k.renglones) {
        let gustoId = g;
        if (typeof g === "object") {
          const clave = `${g.p}|${g.s}`;
          if (creados.has(clave)) gustoId = creados.get(clave);
          else {
            const [[ya]] = await c.query(
              "SELECT id FROM gustos WHERE producto_id = ? AND nombre = ?", [g.p, g.s]);
            if (ya) gustoId = ya.id;
            else {
              const [r] = await c.query(
                "INSERT INTO gustos (producto_id, nombre, activo) VALUES (?, ?, 1)", [g.p, g.s]);
              gustoId = r.insertId;
              console.log(`+ sabor ${gustoId}: ${g.s} — $${g.v}`);
            }
            await c.query(
              `INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio) VALUES (?, ?, 0, ?)
               ON DUPLICATE KEY UPDATE precio = VALUES(precio)`, [gustoId, CENTRAL, g.v]);
            creados.set(clave, gustoId);
          }
        }
        items.push([gustoId, cantidad, Number((usd + PASE).toFixed(2))]);
      }

      const [o] = await c.query(
        "INSERT INTO ordenes_reposicion (sucursal_id, notas, tipo_cambio) VALUES (?, ?, ?)",
        [CENTRAL, `Italia Shop — ${k.papel} del 09/11/2026 — USD ${k.total} + pase ${PASE}/u`, TC]);
      for (const [gid, n, usd] of items) {
        await c.query(
          `INSERT INTO orden_reposicion_items
             (orden_id, gusto_id, cantidad, precio_costo, precio_costo_usd)
           VALUES (?, ?, ?, ?, ?)`, [o.insertId, gid, n, Number((usd * TC).toFixed(2)), usd]);
      }
      const [[chk]] = await c.query(
        `SELECT SUM(cantidad) AS u, ROUND(SUM(cantidad * precio_costo_usd), 2) AS usd,
                ROUND(SUM(cantidad * precio_costo)) AS pesos
           FROM orden_reposicion_items WHERE orden_id = ?`, [o.insertId]);
      const esperado = k.total + k.unidades * PASE;
      if (Number(chk.u) !== k.unidades || Math.abs(Number(chk.usd) - esperado) > 0.01) {
        throw new Error(`${k.papel} quedó en ${chk.u}u / USD ${chk.usd}`);
      }
      console.log(`✅ Orden ${o.insertId} (${k.papel}): ${chk.u}u · USD ${chk.usd} · ` +
                  `$${Number(chk.pesos).toLocaleString("es-AR")}`);
    }
    await c.commit();
  } catch (e) {
    await c.rollback();
    console.error("❌ Se deshizo todo:", e.message);
  } finally {
    await c.end();
  }
})();

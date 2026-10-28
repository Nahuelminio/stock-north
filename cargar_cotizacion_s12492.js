/**
 * Compra a Italia Shop del 27/10/2026 — cotización S12492.
 * 154 unidades, USD 1.297,50. El coil GTI Mesh (1u, USD 12,50) no es un
 * producto del sistema y queda afuera: entran 153 unidades, USD 1.285.
 *
 * Queda PENDIENTE: el stock entra al confirmarla.
 */
require("dotenv").config();
const mysql = require("mysql2/promise");

const CENTRAL = 7;
const TC = Number(process.env.TC || 1610);
const PASE = Number(process.env.PASE || 0.30);

const REACTIVAR = [];

// [gusto_id | {p: producto, s: sabor, v: precio de venta en Central}, cantidad, usd]
// Con objeto, si el sabor ya existe se usa ese y se le fija el precio.
const TE = 34, DOJO = 83, V500 = 73, V300 = 85, V155 = 58;
const COMPRAS = [
  {
    papel: "cotización S12492", total: 1285.00, unidades: 153,
    renglones: [
      // Elfbar TE30K
      [348, 10, 8.75], [493, 10, 8.75], [1145, 5, 8.75], [643, 10, 8.75], [367, 5, 8.75],
      [{ p: TE, s: "Guava passion fruit kiwi", v: 19000 }, 5, 8.75],   // existía sin renglón en Central
      [{ p: TE, s: "Acai banana ice", v: 19000 }, 5, 8.75],            // estaba a $14.000, debajo del costo
      [{ p: TE, s: "Winter mint", v: 19000 }, 5, 8.75],
      [347, 5, 8.75],
      [{ p: TE, s: "Strawberry peach ice", v: 19000 }, 7, 8.75],
      [1207, 7, 8.75],
      // Vaporesso Dojo X
      [1273, 5, 6.50], [1308, 5, 6.50], [1269, 5, 6.50], [1275, 5, 6.50], [1277, 5, 6.50],
      [1310, 5, 6.50], [{ p: DOJO, s: "Tropical boom", v: 20000 }, 5, 6.50],
      [1279, 5, 6.50], [1307, 5, 6.50],
      // Ignite V500
      [1200, 5, 12.00], [{ p: V500, s: "Mango passionfruit", v: 24000 }, 5, 12.00],
      // Ignite V300 Black
      [1290, 3, 10.25], [1291, 3, 10.25],
      [{ p: V300, s: "Watermelon ice", v: 21000 }, 3, 10.25],
      [{ p: V300, s: "Strawberry banana", v: 21000 }, 3, 10.25],
      // Ignite V155 Matte Black → "Ignite V155 Ultra"
      [698, 6, 8.50], [697, 3, 8.50], [837, 3, 8.50],
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
        [CENTRAL, `Italia Shop — ${k.papel} del 27/10/2026 — USD ${k.total} + pase ${PASE}/u`, TC]);
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

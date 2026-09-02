/**
 * Devuelve a Central las ventas que quedaron etiquetadas con la cuenta
 * "vendedorMartin" (usuario 14), y borra el pago de ajuste que la cerraba.
 *
 * Qué pasó: entre ago/2025 y may/2026 el 100% de las ventas de Central
 * (380 de 380, ni una sin vendedor) quedó con vendedor_id = 14, porque quien
 * las cargaba estaba logueado con esa cuenta. No eran ventas de un vendedor:
 * eran las ventas propias de Central. En junio se dejó de usar esa cuenta y
 * las ventas pasaron a cargarse sin vendedor.
 *
 * El 02/06/2026 se cargaron dos pagos a esa cuenta ($7.131.850 y $7), por el
 * total exacto de sus ventas, para dejarla en cero. No es plata que entró ese
 * día: los pagos propios de Central del período ya cubren esas ventas.
 *
 *   node corregir_cuenta_martin.js            → simulación
 *   node corregir_cuenta_martin.js --aplicar  → escribe
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const pool = require("./app/db");

const VENDEDOR = 14;
const APLICAR = process.argv.includes("--aplicar");
const q = (sql, p = []) => pool.promise().query(sql, p).then((r) => r[0]);
const money = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");

async function main() {
  console.log(APLICAR ? "MODO REAL — va a escribir\n" : "SIMULACIÓN — no escribe\n");

  const ventas = await q(
    `SELECT id, sucursal_id, fecha, cantidad, precio_unitario
       FROM ventas WHERE vendedor_id = ? ORDER BY fecha`,
    [VENDEDOR]
  );
  const pagos = await q(
    `SELECT id, fecha, monto, metodo, estado FROM pagos WHERE vendedor_id = ?`,
    [VENDEDOR]
  );

  if (ventas.length === 0 && pagos.length === 0) {
    console.log("No hay nada que corregir.");
    return;
  }

  const totalVentas = ventas.reduce((a, v) => a + Number(v.cantidad) * Number(v.precio_unitario), 0);
  const totalPagos = pagos.reduce((a, p) => a + Number(p.monto), 0);

  console.log(`Ventas a devolver a su sucursal: ${ventas.length}  (${money(totalVentas)})`);
  console.log(`Pagos de ajuste a borrar:        ${pagos.length}  (${money(totalPagos)})\n`);

  // Control 1: que todas sean de Central. Si alguna es de otra sucursal,
  // el diagnóstico no aplica y hay que mirarlo a mano.
  const otras = ventas.filter((v) => Number(v.sucursal_id) !== 7);
  if (otras.length > 0) {
    console.error(`❌ ABORTA: ${otras.length} ventas no son de Central.`);
    return;
  }
  console.log(`✅ Las ${ventas.length} ventas son todas de Central.`);

  // Control 2: que ninguna sea posterior al corte de junio
  const nuevas = ventas.filter((v) => new Date(v.fecha) >= new Date("2026-06-01"));
  if (nuevas.length > 0) {
    console.error(`❌ ABORTA: ${nuevas.length} ventas son de junio o posteriores.`);
    return;
  }
  console.log("✅ Ninguna es posterior al 01/06/2026.");

  if (!APLICAR) {
    console.log("\nSimulación terminada. Para aplicarlo: node corregir_cuenta_martin.js --aplicar");
    return;
  }

  const dir = path.join(
    process.env.HOME, "Desktop",
    "backup_cuenta_martin_" + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ventas_antes.json"), JSON.stringify(ventas, null, 2));
  fs.writeFileSync(path.join(dir, "pagos_borrados.json"), JSON.stringify(pagos, null, 2));
  fs.writeFileSync(
    path.join(dir, "revertir.sql"),
    `-- Deshace la correccion del ${new Date().toISOString()}\n` +
      `UPDATE ventas SET vendedor_id = ${VENDEDOR} WHERE id IN (${ventas.map((v) => v.id).join(",")});\n` +
      `-- Los pagos borrados estan en pagos_borrados.json; hay que reinsertarlos a mano\n` +
      `-- (llevan hash_unico, por eso no se puede recrear el INSERT a ciegas).\n`
  );
  console.log(`\nBackup en: ${dir}`);

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [u] = await conn.query(
      "UPDATE ventas SET vendedor_id = NULL WHERE id IN (?)",
      [ventas.map((v) => v.id)]
    );
    if (u.affectedRows !== ventas.length) {
      throw new Error(`ventas: esperaba ${ventas.length}, toqué ${u.affectedRows}`);
    }

    const [d] = await conn.query("DELETE FROM pagos WHERE id IN (?)", [pagos.map((p) => p.id)]);
    if (d.affectedRows !== pagos.length) {
      throw new Error(`pagos: esperaba ${pagos.length}, borré ${d.affectedRows}`);
    }

    // Control final, dentro de la transacción
    const [[quedan]] = await conn.query(
      "SELECT COUNT(*) n FROM ventas WHERE vendedor_id = ?", [VENDEDOR]
    );
    if (Number(quedan.n) > 0) throw new Error(`quedaron ${quedan.n} ventas con el vendedor`);

    await conn.commit();
    console.log(`\n✅ ${u.affectedRows} ventas devueltas a Central, ${d.affectedRows} pagos borrados.`);
  } catch (e) {
    await conn.rollback();
    console.error("\n❌ Falló, se revirtió todo:", e.message);
  } finally {
    conn.release();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});

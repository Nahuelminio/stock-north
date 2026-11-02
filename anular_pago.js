/**
 * Borra un pago cargado por error:  PAGO=856 node anular_pago.js [--borrar]
 *
 * El sistema no tiene "anular": un pago se deshace borrándolo, como hace
 * /pagos/:id/rechazar. Antes de borrar, la fila entera queda guardada en
 * respaldos/ junto con el INSERT para reponerla tal cual.
 *
 * Borrar un pago le SUBE la deuda a la sucursal, que es justo lo que se quiere
 * si el pago nunca existió.
 */
require("dotenv").config();
const mysql = require("mysql2/promise");
const fs = require("fs");

const PAGO = Number(process.env.PAGO);
if (!PAGO) { console.log("Falta PAGO=<id>"); process.exit(1); }

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });

  const [[p]] = await c.query("SELECT * FROM pagos WHERE id = ?", [PAGO]);
  if (!p) { console.log("No existe el pago", PAGO); await c.end(); return; }

  const [comp] = await c.query("SELECT * FROM pagos_comprobantes WHERE pago_id = ?", [PAGO]);
  const [ocr] = await c.query("SELECT * FROM pagos_raw_ocr WHERE pago_id = ?", [PAGO]);

  console.log("EL PAGO:"); console.table([p]);
  console.log(`Comprobantes: ${comp.length} · OCR: ${ocr.length}`);

  const [[deuda]] = await c.query(
    `SELECT COALESCE(SUM(monto), 0) AS pagado FROM pagos
      WHERE sucursal_id = ? AND estado = 'ok'`, [p.sucursal_id]);
  console.log(`La sucursal tiene $${Number(deuda.pagado).toLocaleString("es-AR")} en pagos ok.`);

  if (process.argv[2] !== "--borrar") {
    console.log("\nCorré con --borrar para hacerlo.");
    await c.end(); return;
  }

  // El respaldo primero: si algo sale mal después, esto es lo que lo repone
  const campos = Object.keys(p);
  const valores = campos.map((k) =>
    p[k] === null ? "NULL"
    : p[k] instanceof Date ? `'${p[k].toISOString().slice(0, 19).replace("T", " ")}'`
    : typeof p[k] === "number" ? String(p[k])
    : `'${String(p[k]).replace(/'/g, "''")}'`);
  const archivo = `respaldos/pago_${PAGO}_${Date.now()}.sql`;
  fs.writeFileSync(archivo,
    `-- Pago ${PAGO} borrado el ${new Date().toISOString()}\n` +
    `-- Para reponerlo tal cual, incluido el id:\n` +
    `INSERT INTO pagos (${campos.join(", ")}) VALUES (${valores.join(", ")});\n\n` +
    `-- La fila completa, por las dudas:\n-- ${JSON.stringify(p)}\n` +
    (comp.length ? `-- comprobantes: ${JSON.stringify(comp)}\n` : "") +
    (ocr.length ? `-- ocr: ${JSON.stringify(ocr)}\n` : ""));
  console.log(`\nRespaldo en ${archivo}`);

  await c.beginTransaction();
  try {
    await c.query("DELETE FROM pagos_comprobantes WHERE pago_id = ?", [PAGO]);
    await c.query("DELETE FROM pagos_raw_ocr WHERE pago_id = ?", [PAGO]);
    const [r] = await c.query("DELETE FROM pagos WHERE id = ?", [PAGO]);
    if (r.affectedRows !== 1) throw new Error(`borró ${r.affectedRows} filas, esperaba 1`);
    await c.commit();

    const [[despues]] = await c.query(
      `SELECT COALESCE(SUM(monto), 0) AS pagado FROM pagos
        WHERE sucursal_id = ? AND estado = 'ok'`, [p.sucursal_id]);
    console.log(`✅ Borrado. La sucursal queda con ` +
                `$${Number(despues.pagado).toLocaleString("es-AR")} en pagos ok ` +
                `($${Number(deuda.pagado - despues.pagado).toLocaleString("es-AR")} menos).`);
  } catch (e) {
    await c.rollback();
    console.error("❌ No se borró nada:", e.message);
  } finally {
    await c.end();
  }
})();

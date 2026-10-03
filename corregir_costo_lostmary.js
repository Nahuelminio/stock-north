/**
 * Los 8 renglones de Lost mary Dura del 11/9/2026 19:14 quedaron con el costo
 * en dólares ($8) metido en el campo de pesos. El renglón hermano de la misma
 * compra, cargado ocho minutos después, dice $12.800: ese es el precio real.
 *
 * Deja el costo en pesos en $12.800 y además guarda los 8 USD en el campo que
 * les corresponde, que estaba vacío.
 *
 *   node corregir_costo_lostmary.js            → muestra qué va a cambiar
 *   node corregir_costo_lostmary.js --aplicar  → lo aplica
 *
 * Antes de tocar nada escribe el backup y el SQL para volver atrás en
 * ~/Desktop/backup_costo_lostmary_<fecha>/
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const pool = require("./app/db");

const IDS = [1520, 1521, 1522, 1523, 1524, 1525, 1526, 1527];
const COSTO_ARS = 12800;
const COSTO_USD = 8;

const aplicar = process.argv.includes("--aplicar");
const db = pool.promise();
const pesos = (n) => "$" + Math.round(Number(n)).toLocaleString("es-AR");

(async () => {
  const [filas] = await db.query(
    `SELECT r.id, DATE_FORMAT(r.fecha, '%Y-%m-%d %H:%i') AS fecha,
            g.nombre AS gusto, r.gusto_id, r.sucursal_id,
            r.cantidad_repuesta, r.precio_costo, r.precio_costo_usd
       FROM reposiciones r
       JOIN gustos g ON g.id = r.gusto_id
      WHERE r.id IN (?)
      ORDER BY r.id`,
    [IDS]
  );

  if (filas.length !== IDS.length) {
    console.error(
      `Esperaba ${IDS.length} renglones y encontré ${filas.length}. No toco nada.`
    );
    process.exit(1);
  }

  // Que sean los que creo que son: todos a $8 y de Lost mary Dura
  const raros = filas.filter((f) => Number(f.precio_costo) !== 8);
  if (raros.length) {
    console.error("Estos renglones ya no están en $8, alguien los cambió:");
    console.table(raros);
    process.exit(1);
  }

  const unidades = filas.reduce((a, f) => a + Number(f.cantidad_repuesta), 0);
  const antes = filas.reduce(
    (a, f) => a + Number(f.cantidad_repuesta) * Number(f.precio_costo),
    0
  );
  const despues = unidades * COSTO_ARS;

  console.table(
    filas.map((f) => ({
      id: f.id,
      gusto: f.gusto,
      unid: f.cantidad_repuesta,
      costo: pesos(f.precio_costo),
      queda: pesos(COSTO_ARS),
    }))
  );
  console.log(
    `\n${unidades} unidades. La compra pasa de ${pesos(antes)} a ${pesos(despues)}.`
  );

  if (!aplicar) {
    console.log("\nCorrida en seco. Agregá --aplicar para escribir.");
    process.exit(0);
  }

  // ── Backup antes de escribir
  const sello = new Date()
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, "");
  const dir = path.join(os.homedir(), "Desktop", `backup_costo_lostmary_${sello}`);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, "reposiciones.json"),
    JSON.stringify(filas, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, "revertir.sql"),
    filas
      .map(
        (f) =>
          `UPDATE reposiciones SET precio_costo = ${f.precio_costo}, ` +
          `precio_costo_usd = ${f.precio_costo_usd === null ? "NULL" : f.precio_costo_usd} ` +
          `WHERE id = ${f.id};`
      )
      .join("\n") + "\n"
  );
  console.log(`\nBackup en ${dir}`);

  const [r] = await db.query(
    `UPDATE reposiciones
        SET precio_costo = ?, precio_costo_usd = ?
      WHERE id IN (?) AND precio_costo = 8`,
    [COSTO_ARS, COSTO_USD, IDS]
  );
  console.log(`Renglones corregidos: ${r.affectedRows}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

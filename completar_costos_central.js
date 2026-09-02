/**
 * Completa el precio_costo faltante de las reposiciones de la Central.
 *
 * Contexto: hasta el 20/05/2026 las reposiciones se cargaban sin costo
 * (precio_costo en NULL). Desde el 02/06/2026 se carga siempre. Los renglones
 * viejos hacen que Métricas tome esas ventas como costo cero, o sea 100% de
 * ganancia, inflando el resultado.
 *
 * Sólo toca la Central: de ahí sale el stock de las demás sucursales, así que
 * es el único lugar donde el costo representa una compra real.
 *
 * NO toca:
 *   - ningún sabor que ya tenga alguna reposición con costo cargado
 *   - las reposiciones de otras sucursales
 *   - los sabores sin ninguna reposición (habría que inventar el movimiento)
 *
 *   node completar_costos_central.js            → simulación, no escribe
 *   node completar_costos_central.js --aplicar  → escribe de verdad
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const pool = require("./app/db");

const CENTRAL_ID = 7;
const COSTO = 12000;
const APLICAR = process.argv.includes("--aplicar");

// Los cargás vos con el valor real: se vende a $10.000, con costo 12.000 daría pérdida
const EXCLUIR_PRODUCTO = ["Tabaco Adalya"];

const q = (sql, p = []) => pool.promise().query(sql, p).then((r) => r[0]);
const money = (n) => "$" + Math.round(Number(n || 0)).toLocaleString("es-AR");

// Un sabor es "sin costo" sólo si NINGUNA de sus reposiciones tiene precio.
// Así jamás se pisa un costo real ya cargado.
const SIN_COSTO = `
  NOT EXISTS (
    SELECT 1 FROM reposiciones r2
     WHERE r2.gusto_id = r.gusto_id AND r2.precio_costo > 0
  )`;

const filtroExcluir = EXCLUIR_PRODUCTO.map(() => "p.nombre NOT LIKE ?").join(" AND ");
const paramsExcluir = EXCLUIR_PRODUCTO.map((n) => `%${n}%`);

async function main() {
  console.log(APLICAR ? "MODO REAL — va a escribir\n" : "SIMULACIÓN — no escribe nada\n");

  const objetivo = await q(
    `SELECT r.id, r.gusto_id, r.cantidad_repuesta, r.fecha,
            TRIM(REPLACE(p.nombre, CHAR(9), '')) AS producto, g.nombre AS gusto
       FROM reposiciones r
       JOIN gustos g    ON g.id = r.gusto_id
       JOIN productos p ON p.id = g.producto_id
      WHERE r.sucursal_id = ?
        AND (r.precio_costo IS NULL OR r.precio_costo = 0)
        AND ${SIN_COSTO}
        AND ${filtroExcluir}
      ORDER BY r.fecha`,
    [CENTRAL_ID, ...paramsExcluir]
  );

  if (objetivo.length === 0) {
    console.log("No hay renglones para completar. Nada que hacer.");
    return;
  }

  const unidades = objetivo.reduce((a, r) => a + Number(r.cantidad_repuesta || 0), 0);
  const porProducto = {};
  for (const r of objetivo) {
    porProducto[r.producto] = porProducto[r.producto] || { renglones: 0, unidades: 0 };
    porProducto[r.producto].renglones++;
    porProducto[r.producto].unidades += Number(r.cantidad_repuesta || 0);
  }

  console.log(`Renglones a completar: ${objetivo.length}`);
  console.log(`Unidades involucradas: ${unidades}`);
  console.log(`Costo a asignar:       ${money(COSTO)} por unidad`);
  console.log(`Costo total imputado:  ${money(unidades * COSTO)}`);
  const dia = (f) => new Date(f).toISOString().slice(0, 10);
  console.log(`Rango de fechas:       ${dia(objetivo[0].fecha)} a ${dia(objetivo[objetivo.length - 1].fecha)}\n`);
  console.table(
    Object.entries(porProducto)
      .sort((a, b) => b[1].unidades - a[1].unidades)
      .map(([producto, v]) => ({ producto, renglones: v.renglones, unidades: v.unidades }))
  );

  // --- Control: que no se cuele ningún sabor con costo real ---
  const colados = await q(
    `SELECT COUNT(*) AS n FROM reposiciones r
      WHERE r.id IN (?) AND EXISTS (
        SELECT 1 FROM reposiciones r2
         WHERE r2.gusto_id = r.gusto_id AND r2.precio_costo > 0)`,
    [objetivo.map((r) => r.id)]
  );
  if (Number(colados[0].n) > 0) {
    console.error(`\n❌ ABORTA: ${colados[0].n} renglones pertenecen a sabores que YA tienen costo real.`);
    return;
  }
  console.log("\n✅ Control: ninguno de estos sabores tiene un costo real cargado.");

  if (!APLICAR) {
    console.log("\nSimulación terminada. Para aplicarlo: node completar_costos_central.js --aplicar");
    return;
  }

  // --- Backup antes de escribir ---
  const dir = path.join(process.env.HOME, "Desktop", "backup_costos_central_" + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ""));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "reposiciones_antes.json"),
    JSON.stringify(objetivo, null, 2)
  );
  // El revert deja el costo en NULL, que es como estaban
  fs.writeFileSync(
    path.join(dir, "revertir.sql"),
    `-- Deshace la carga de costos del ${new Date().toISOString()}\n` +
      `UPDATE reposiciones SET precio_costo = NULL\n WHERE id IN (${objetivo.map((r) => r.id).join(",")});\n`
  );
  console.log(`\nBackup guardado en: ${dir}`);

  const conn = await pool.promise().getConnection();
  try {
    await conn.beginTransaction();

    const [upd] = await conn.query(
      "UPDATE reposiciones SET precio_costo = ? WHERE id IN (?)",
      [COSTO, objetivo.map((r) => r.id)]
    );
    console.log(`Reposiciones actualizadas: ${upd.affectedRows}`);

    if (upd.affectedRows !== objetivo.length) {
      throw new Error(`Se esperaban ${objetivo.length} filas y se tocaron ${upd.affectedRows}`);
    }

    // Verificación dentro de la transacción, antes de confirmar
    const [[quedan]] = await conn.query(
      `SELECT COUNT(*) AS n FROM reposiciones r
        WHERE r.id IN (?) AND (r.precio_costo IS NULL OR r.precio_costo <> ?)`,
      [objetivo.map((r) => r.id), COSTO]
    );
    if (Number(quedan.n) > 0) throw new Error(`${quedan.n} renglones no quedaron con el costo`);

    await conn.commit();
    console.log("\n✅ Aplicado y confirmado.");
    console.log(`Para deshacerlo: mysql < ${path.join(dir, "revertir.sql")}`);
  } catch (e) {
    await conn.rollback();
    console.error("\n❌ Falló, se revirtió todo sin escribir:", e.message);
  } finally {
    conn.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
  });

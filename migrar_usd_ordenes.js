/**
 * Guarda el costo en USD de las órdenes de reposición.
 *
 * Las compras de Central se cargan en dólares con un tipo de cambio arriba,
 * pero al guardar se multiplicaba por el TC y solo se escribía el resultado en
 * pesos: el USD que se tipeó no llegaba nunca a la base. De ahí que 552
 * reposiciones no tengan el dato aunque se haya cargado.
 *
 * Agrega la columna que faltaba y el tipo de cambio de cada orden, para que
 * quede asentado a qué dólar se compró.
 *
 *   node migrar_usd_ordenes.js            → dice qué va a hacer
 *   node migrar_usd_ordenes.js --aplicar  → lo aplica
 *
 * Solo agrega columnas, no toca ni borra datos existentes.
 */

const pool = require("./app/db");

const aplicar = process.argv.includes("--aplicar");
const db = pool.promise();

const CAMBIOS = [
  {
    tabla: "orden_reposicion_items",
    columna: "precio_costo_usd",
    sql: "ALTER TABLE orden_reposicion_items ADD COLUMN precio_costo_usd DECIMAL(10,2) NULL AFTER precio_costo",
  },
  {
    tabla: "ordenes_reposicion",
    columna: "tipo_cambio",
    sql: "ALTER TABLE ordenes_reposicion ADD COLUMN tipo_cambio DECIMAL(10,2) NULL AFTER notas",
  },
];

(async () => {
  const pendientes = [];

  for (const c of CAMBIOS) {
    const [existe] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [c.tabla, c.columna]
    );
    if (existe[0].n > 0) {
      console.log(`✓ ${c.tabla}.${c.columna} ya existe`);
    } else {
      console.log(`+ falta ${c.tabla}.${c.columna}`);
      pendientes.push(c);
    }
  }

  if (pendientes.length === 0) {
    console.log("\nNada que hacer.");
    process.exit(0);
  }

  if (!aplicar) {
    console.log("\nCorrida en seco. Agregá --aplicar para escribir.");
    console.log("Para volver atrás:");
    for (const c of pendientes) {
      console.log(`  ALTER TABLE ${c.tabla} DROP COLUMN ${c.columna};`);
    }
    process.exit(0);
  }

  for (const c of pendientes) {
    await db.query(c.sql);
    console.log(`✓ agregada ${c.tabla}.${c.columna}`);
  }
  console.log("\nListo.");
  process.exit(0);
})().catch((e) => {
  console.error(e.sqlMessage || e);
  process.exit(1);
});

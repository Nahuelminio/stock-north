/**
 * Copia de seguridad de las tablas que toca unificar_duplicados.js.
 *
 * mysqldump no sirve contra Hostinger (la versión 9 no soporta el
 * mysql_native_password que usa el servidor), así que se arma a mano:
 * un INSERT por tabla, con las claves foráneas apagadas para poder
 * restaurar en cualquier orden.
 *
 *   node backup_antes_unificar.js
 *
 * Deja ~/Desktop/backup_duplicados_<fecha>/datos.sql
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const pool = require("./app/db");

// Todo lo que el script de unificación modifica o borra
const TABLAS = [
  "productos", "gustos", "stock", "ventas", "reposiciones",
  "evento_items", "pedido_mayorista_items", "transferencia_stock_items",
  "orden_reposicion_items", "cliente_intereses",
];

const sqlValor = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace("T", " ")}'`;
  if (typeof v === "number") return String(v);
  if (Buffer.isBuffer(v)) return `0x${v.toString("hex")}`;
  return `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
};

(async () => {
  const db = pool.promise();
  const sello = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const dir = path.join(os.homedir(), "Desktop", `backup_duplicados_${sello}`);
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, "datos.sql");

  const partes = ["SET FOREIGN_KEY_CHECKS=0;\n"];
  let totalFilas = 0;

  for (const tabla of TABLAS) {
    const [cols] = await db.query(`SHOW COLUMNS FROM \`${tabla}\``);
    const nombres = cols.map((c) => c.Field);
    const [filas] = await db.query(`SELECT * FROM \`${tabla}\``);
    totalFilas += filas.length;

    partes.push(`\n-- ${tabla} (${filas.length} filas)`);
    if (filas.length === 0) { partes.push("-- vacía"); continue; }

    // De a 500 por INSERT: uno solo con miles de filas es incómodo de restaurar
    for (let i = 0; i < filas.length; i += 500) {
      const lote = filas.slice(i, i + 500);
      partes.push(
        `INSERT INTO \`${tabla}\` (${nombres.map((n) => `\`${n}\``).join(",")}) VALUES\n` +
        lote.map((f) => `(${nombres.map((n) => sqlValor(f[n])).join(",")})`).join(",\n") + ";"
      );
    }
    console.log(`  ${tabla.padEnd(28)} ${String(filas.length).padStart(6)} filas`);
  }

  partes.push("\nSET FOREIGN_KEY_CHECKS=1;\n");
  fs.writeFileSync(archivo, partes.join("\n"));

  const mb = (fs.statSync(archivo).size / 1024 / 1024).toFixed(1);
  console.log(`\n${TABLAS.length} tablas, ${totalFilas} filas, ${mb}MB`);
  console.log(`Guardado en ${archivo}`);
  console.log("\nPara restaurar hay que VACIAR las tablas primero: el archivo tiene");
  console.log("INSERTs, no REPLACEs, así que sobre datos existentes choca por clave.");
  process.exit(0);
})().catch((e) => { console.error(e.sqlMessage || e); process.exit(1); });

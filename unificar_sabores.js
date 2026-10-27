/**
 * Junta dos sabores que son el mismo en uno solo.
 *
 * Nació para los dos "Watermelon ice" del Elfbar BC15000:
 *
 * El 568 es el original: dado de baja, pero con 16 ventas, 8 reposiciones y 2
 * unidades en Zoe Tec. El 1281 se creó el 17/10 desde "agregar producto" sin
 * saber que el otro existía, y es el que tiene el stock de Central y North
 * Punto #2. Se queda el 1281, que es el activo, y se le pasa todo lo del 568:
 * el stock de cada sucursal y la historia, para que las ventas y los costos de
 * ese sabor estén en un solo lugar.
 *
 * Antes de tocar nada guarda en respaldos/ todas las filas que va a cambiar.
 * Verifica al final que el total de unidades del sabor no haya cambiado.
 */
require("dotenv").config();
const mysql = require("mysql2/promise");
const fs = require("fs");

// node unificar_sabores.js <viejo> <nuevo> [--unificar]
const VIEJO = Number(process.argv[2]);
const NUEVO = Number(process.argv[3]);
const HACER = process.argv[4] === "--unificar";
const HISTORIA = ["ventas", "reposiciones", "orden_reposicion_items", "transferencia_stock_items"];

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

  const total = async () => {
    const [[r]] = await c.query(
      "SELECT COALESCE(SUM(cantidad), 0) AS u FROM stock WHERE gusto_id IN (?, ?)", [VIEJO, NUEVO]);
    return Number(r.u);
  };

  const [stockViejo] = await c.query(
    `SELECT st.*, s.nombre AS sucursal FROM stock st JOIN sucursales s ON s.id = st.sucursal_id
      WHERE st.gusto_id = ?`, [VIEJO]);
  const [stockNuevo] = await c.query("SELECT * FROM stock WHERE gusto_id = ?", [NUEVO]);
  const historia = {};
  for (const t of HISTORIA) {
    const [r] = await c.query(`SELECT * FROM ${t} WHERE gusto_id = ?`, [VIEJO]);
    historia[t] = r;
  }

  const antes = await total();
  console.log(`Unidades del sabor entre los dos: ${antes}`);
  console.log(`Renglones de stock del viejo: ${stockViejo.length} ` +
    `(con unidades: ${stockViejo.filter((s) => s.cantidad > 0).map((s) => `${s.sucursal} ${s.cantidad}`).join(", ") || "ninguno"})`);
  for (const t of HISTORIA) console.log(`  ${t}: ${historia[t].length} a repuntar`);

  if (!VIEJO || !NUEVO || VIEJO === NUEVO) {
    console.error("Uso: node unificar_sabores.js <viejo> <nuevo> [--unificar]");
    await c.end(); return;
  }
  // Tienen que ser del mismo modelo: juntar sabores de modelos distintos
  // mezclaría stock de dos productos que no son lo mismo.
  const [gs] = await c.query(
    `SELECT g.id, g.nombre, g.activo, p.nombre AS producto, g.producto_id
       FROM gustos g JOIN productos p ON p.id = g.producto_id WHERE g.id IN (?, ?)`, [VIEJO, NUEVO]);
  if (gs.length !== 2 || gs[0].producto_id !== gs[1].producto_id) {
    console.error("❌ No son dos sabores del mismo modelo:", gs);
    await c.end(); return;
  }
  gs.forEach((g) => console.log(`  ${g.id === VIEJO ? "se va" : "queda"}: ${g.id} "${g.nombre}"${g.activo ? "" : " (baja)"} — ${g.producto}`));

  if (!HACER) {
    console.log("\nEn seco. Corré con --unificar para hacerlo.");
    await c.end(); return;
  }

  fs.mkdirSync("respaldos", { recursive: true });
  const archivo = `respaldos/unificar_${VIEJO}_en_${NUEVO}_${Date.now()}.json`;
  fs.writeFileSync(archivo, JSON.stringify({ VIEJO, NUEVO, stockViejo, stockNuevo, historia }, null, 1));
  console.log(`Respaldo en ${archivo}`);

  await c.beginTransaction();
  try {
    // Stock: si la sucursal ya tiene el nuevo, se suman las unidades ahí; si
    // no, el renglón del viejo pasa a ser del nuevo, con su precio.
    for (const s of stockViejo) {
      const destino = stockNuevo.find((n) => n.sucursal_id === s.sucursal_id);
      if (destino) {
        await c.query("UPDATE stock SET cantidad = cantidad + ? WHERE id = ?", [s.cantidad, destino.id]);
        await c.query("DELETE FROM stock WHERE id = ?", [s.id]);
      } else {
        await c.query("UPDATE stock SET gusto_id = ? WHERE id = ?", [NUEVO, s.id]);
      }
    }
    for (const t of HISTORIA) {
      await c.query(`UPDATE ${t} SET gusto_id = ? WHERE gusto_id = ?`, [NUEVO, VIEJO]);
    }

    const despues = await total();
    if (despues !== antes) throw new Error(`las unidades pasaron de ${antes} a ${despues}`);
    await c.commit();
    console.log(`✅ Unificado. Unidades: ${antes} antes, ${despues} después.`);
  } catch (e) {
    await c.rollback();
    console.error("❌ No se tocó nada:", e.message);
  } finally {
    await c.end();
  }
})();

/** Suma la columna de precio al catálogo y al pedido. Solo agrega. */
require("dotenv").config();
const mysql = require("mysql2/promise");
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const hay = async (tabla, col) => {
    const [r] = await c.query(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [tabla, col]);
    return r.length > 0;
  };
  if (!await hay("catalogo_proveedor", "precio_usd")) {
    await c.query("ALTER TABLE catalogo_proveedor ADD COLUMN precio_usd DECIMAL(10,2) NULL AFTER gusto");
    console.log("+ catalogo_proveedor.precio_usd");
  } else console.log("  catalogo_proveedor.precio_usd ya estaba");

  // El precio se copia al pedido: si mañana el proveedor lo cambia, el pedido
  // tiene que seguir diciendo a cuánto se cotizó.
  if (!await hay("pedidos_lista_items", "precio_usd")) {
    await c.query("ALTER TABLE pedidos_lista_items ADD COLUMN precio_usd DECIMAL(10,2) NULL AFTER nombre");
    console.log("+ pedidos_lista_items.precio_usd");
  } else console.log("  pedidos_lista_items.precio_usd ya estaba");
  await c.end();
})();

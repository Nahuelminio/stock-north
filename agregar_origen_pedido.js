/** Marca de dónde sale cada renglón del pedido: del stock o del proveedor. */
require("dotenv").config();
const mysql = require("mysql2/promise");
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const [ya] = await c.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedidos_lista_items'
        AND COLUMN_NAME = 'origen'`);
  if (ya.length) { console.log("la columna ya estaba"); await c.end(); return; }
  await c.query(
    `ALTER TABLE pedidos_lista_items
       ADD COLUMN origen ENUM('proveedor','stock') NOT NULL DEFAULT 'proveedor' AFTER sku`);
  console.log("+ pedidos_lista_items.origen");
  await c.end();
})();

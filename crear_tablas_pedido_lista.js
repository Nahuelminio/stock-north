/** Tablas de los pedidos que mandan los mayoristas desde /lista. Solo crea. */
require("dotenv").config();
const mysql = require("mysql2/promise");
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  await c.query(`
    CREATE TABLE IF NOT EXISTS pedidos_lista (
      id      INT AUTO_INCREMENT PRIMARY KEY,
      quien   VARCHAR(120) NOT NULL,
      nota    VARCHAR(500) NULL,
      estado  ENUM('nuevo','visto','cotizado','cerrado') NOT NULL DEFAULT 'nuevo',
      fecha   DATETIME NOT NULL,
      KEY idx_fecha (fecha)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS pedidos_lista_items (
      id        INT AUTO_INCREMENT PRIMARY KEY,
      pedido_id INT NOT NULL,
      sku       VARCHAR(64) NOT NULL,
      -- El nombre se copia al momento del pedido: si el proveedor lo cambia o
      -- saca el producto, el pedido tiene que seguir diciendo qué se pidió.
      nombre    VARCHAR(255) NOT NULL,
      cantidad  INT NOT NULL,
      KEY idx_pedido (pedido_id),
      CONSTRAINT fk_pedido_lista FOREIGN KEY (pedido_id)
        REFERENCES pedidos_lista(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [[a]] = await c.query("SELECT COUNT(*) AS n FROM pedidos_lista");
  console.log("Tablas listas. Pedidos:", a.n);
  await c.end();
})();

/** Crea la tabla del catálogo del proveedor. Solo crea, no borra nada. */
require("dotenv").config();
const mysql = require("mysql2/promise");
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  await c.query(`
    CREATE TABLE IF NOT EXISTS catalogo_proveedor (
      sku       VARCHAR(64)  NOT NULL PRIMARY KEY,
      nombre    VARCHAR(255) NOT NULL,
      modelo    VARCHAR(160) NOT NULL,
      gusto     VARCHAR(160) NOT NULL,
      hay       TINYINT(1)   NOT NULL DEFAULT 1,
      presente  TINYINT(1)   NOT NULL DEFAULT 1,
      visto     DATETIME     NOT NULL,
      KEY idx_modelo (modelo),
      KEY idx_presente (presente)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const [[n]] = await c.query("SELECT COUNT(*) AS n FROM catalogo_proveedor");
  console.log("Tabla lista. Filas:", n.n);
  await c.end();
})();

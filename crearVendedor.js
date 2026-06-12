// Uso: node crearVendedor.js <email> <password> <sucursal_id>
// Ejemplo: node crearVendedor.js juan@north.com pass123 99
// La sucursal_id es la "sucursal virtual" del vendedor (para rastrear su deuda).
// Si no existe esa sucursal, creala primero en la tabla sucursales.

const bcrypt = require("bcryptjs");
const pool = require("./app/db");

async function main() {
  const [,, email, password, sucursal_id] = process.argv;

  if (!email || !password || !sucursal_id) {
    console.error("Uso: node crearVendedor.js <email> <password> <sucursal_id>");
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  await pool.promise().query(
    "INSERT INTO usuarios (email, password_hash, sucursal_id, rol) VALUES (?, ?, ?, 'vendedor')",
    [email, hash, Number(sucursal_id)]
  );

  console.log(`✅ Vendedor creado: ${email} | sucursal_id: ${sucursal_id}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

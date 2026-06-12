// ✅ Reutilizable: Función upsertStock centralizada
// Archivo sugerido: controllers/stockHelpers.js

const pool = require("../db");

async function upsertStock(gustoId, sucursalId, cantidad, precio = 0) {
  // Operación atómica: evita race conditions entre SELECT y INSERT/UPDATE concurrentes
  await pool.promise().query(
    `INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad)`,
    [gustoId, sucursalId, cantidad, precio]
  );
}

module.exports = { upsertStock };

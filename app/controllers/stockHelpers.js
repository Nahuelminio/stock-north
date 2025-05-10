// ✅ Reutilizable: Función upsertStock centralizada
// Archivo sugerido: controllers/stockHelpers.js

const pool = require("../db");

async function upsertStock(gustoId, sucursalId, cantidad, precio = 0) {
  const [existencia] = await pool
    .promise()
    .query("SELECT id FROM stock WHERE gusto_id = ? AND sucursal_id = ?", [
      gustoId,
      sucursalId,
    ]);

  if (existencia.length === 0) {
    await pool
      .promise()
      .query(
        "INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio) VALUES (?, ?, ?, ?)",
        [gustoId, sucursalId, cantidad, precio]
      );
  } else {
    await pool
      .promise()
      .query(
        "UPDATE stock SET cantidad = cantidad + ? WHERE gusto_id = ? AND sucursal_id = ?",
        [cantidad, gustoId, sucursalId]
      );
  }
}

module.exports = { upsertStock };

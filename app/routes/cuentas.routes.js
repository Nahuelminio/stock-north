const express = require("express");
const pool = require("../db");
const authenticate = require("../middlewares/authenticate"); // ajustá la ruta

const router = express.Router();

// GET /cuentas (sucursal ve solo su sucursal)
router.get("/cuentas", authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.rol === "admin";
    const sucursalId = isAdmin
      ? req.query.sucursalId || null
      : req.user.sucursalId;

    if (!isAdmin && !sucursalId) {
      return res.status(400).json({ error: "Usuario sin sucursal asignada" });
    }

    const sql = sucursalId
      ? `SELECT id, cliente_nombre, telefono, saldo, updated_at
         FROM cuentas_corrientes
         WHERE sucursal_id=?
         ORDER BY saldo DESC, cliente_nombre ASC`
      : `SELECT id, sucursal_id, cliente_nombre, telefono, saldo, updated_at
         FROM cuentas_corrientes
         ORDER BY sucursal_id, saldo DESC, cliente_nombre ASC`;

    const params = sucursalId ? [sucursalId] : [];
    const [rows] = await pool.promise().query(sql, params);

    res.json(rows);
  } catch (error) {
    console.error("❌ Error GET /cuentas:", error);
    res.status(500).json({ error: "Error al listar cuentas" });
  }
});



module.exports = router;

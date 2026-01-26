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

// POST /cuentas (crea en la sucursal del usuario)
router.post("/cuentas", authenticate, async (req, res) => {
  try {
    const {
      cliente_nombre,
      telefono,
      notas,
      sucursalId: sucursalIdBody,
    } = req.body;
    if (!cliente_nombre)
      return res.status(400).json({ error: "Falta cliente_nombre" });

    const isAdmin = req.user.rol === "admin";
    const sucursalId = isAdmin ? sucursalIdBody || null : req.user.sucursalId;

    if (!sucursalId) return res.status(400).json({ error: "Falta sucursalId" });

    const [r] = await pool
      .promise()
      .query(
        "INSERT INTO cuentas_corrientes (sucursal_id, cliente_nombre, telefono, notas) VALUES (?,?,?,?)",
        [sucursalId, cliente_nombre, telefono || null, notas || null],
      );

    res.json({ id: r.insertId, mensaje: "✅ Cuenta creada" });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ error: "Ya existe ese cliente en la sucursal" });
    }
    console.error("❌ Error POST /cuentas:", error);
    res.status(500).json({ error: "Error al crear cuenta" });
  }
});

// POST /cuentas/:id/movimientos (CARGO suma, PAGO resta; valida pertenencia a sucursal)
router.post("/cuentas/:id/movimientos", authenticate, async (req, res) => {
  const cuentaId = req.params.id;
  const { tipo, monto, descripcion } = req.body;

  const montoNum = Number(monto);
  if (!["CARGO", "PAGO"].includes(tipo)) {
    return res.status(400).json({ error: "Tipo inválido (CARGO o PAGO)" });
  }
  if (!montoNum || montoNum <= 0) {
    return res.status(400).json({ error: "Monto inválido" });
  }

  try {
    const isAdmin = req.user.rol === "admin";
    const sucursalId = isAdmin ? null : req.user.sucursalId;

    const [checkRows] = await pool
      .promise()
      .query(
        sucursalId
          ? "SELECT id, sucursal_id FROM cuentas_corrientes WHERE id=? AND sucursal_id=?"
          : "SELECT id, sucursal_id FROM cuentas_corrientes WHERE id=?",
        sucursalId ? [cuentaId, sucursalId] : [cuentaId],
      );

    const cuenta = checkRows[0];
    if (!cuenta)
      return res
        .status(403)
        .json({ error: "No autorizado o cuenta inexistente" });

    await pool.promise().query("START TRANSACTION");
    try {
      await pool
        .promise()
        .query(
          "INSERT INTO cuenta_movimientos (cuenta_id, sucursal_id, tipo, monto, descripcion, creado_por) VALUES (?,?,?,?,?,?)",
          [
            cuentaId,
            cuenta.sucursal_id,
            tipo,
            montoNum,
            descripcion || null,
            req.user.id,
          ],
        );

      const delta = tipo === "CARGO" ? montoNum : -montoNum;

      await pool
        .promise()
        .query("UPDATE cuentas_corrientes SET saldo = saldo + ? WHERE id=?", [
          delta,
          cuentaId,
        ]);

      await pool.promise().query("COMMIT");
      res.json({ ok: true, mensaje: "✅ Movimiento registrado" });
    } catch (e) {
      await pool.promise().query("ROLLBACK");
      throw e;
    }
  } catch (error) {
    console.error("❌ Error POST /cuentas/:id/movimientos:", error);
    res.status(500).json({ error: "Error al registrar movimiento" });
  }
});

// GET /cuentas/:id/movimientos (historial)
router.get("/cuentas/:id/movimientos", authenticate, async (req, res) => {
  const cuentaId = req.params.id;

  try {
    const isAdmin = req.user.rol === "admin";
    const sucursalId = isAdmin ? null : req.user.sucursalId;

    const [checkRows] = await pool
      .promise()
      .query(
        sucursalId
          ? "SELECT id FROM cuentas_corrientes WHERE id=? AND sucursal_id=?"
          : "SELECT id FROM cuentas_corrientes WHERE id=?",
        sucursalId ? [cuentaId, sucursalId] : [cuentaId],
      );

    if (!checkRows[0]) return res.status(403).json({ error: "No autorizado" });

    const [rows] = await pool.promise().query(
      `SELECT id, tipo, monto, descripcion, fecha
       FROM cuenta_movimientos
       WHERE cuenta_id=?
       ORDER BY fecha DESC`,
      [cuentaId],
    );

    res.json(rows);
  } catch (error) {
    console.error("❌ Error GET /cuentas/:id/movimientos:", error);
    res.status(500).json({ error: "Error al obtener movimientos" });
  }
});

module.exports = router;

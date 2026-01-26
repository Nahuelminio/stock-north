const express = require("express");
const pool = require("../db");
const authenticate = require("../middlewares/authenticate"); // ajustá la ruta

const router = express.Router();

// GET /cuentas (sucursal ve solo su sucursal)
router.get("/cuentas", authenticate, async (req, res) => {
  const { estado = "activas" } = req.query;

  try {
    const isAdmin = req.user.rol === "admin";
    const sucursalId = req.user.sucursalId;

    let where = [];
    let params = [];

    if (!isAdmin) {
      where.push("cc.sucursal_id = ?");
      params.push(sucursalId);
    }

    if (estado === "activas") where.push("cc.activo = 1");
    if (estado === "archivadas") where.push("cc.activo = 0");
    // "todas" no agrega filtro

    const sql = `
      SELECT cc.*
      FROM cuentas_corrientes cc
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY cc.saldo DESC, cc.cliente_nombre ASC
    `;

    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("GET /cuentas", e);
    res.status(500).json({ error: "Error al obtener cuentas" });
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
router.put("/cuentas/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const { cliente_nombre, telefono, notas } = req.body;

  if (!cliente_nombre?.trim())
    return res.status(400).json({ error: "Falta nombre" });

  try {
    const isAdmin = req.user.rol === "admin";
    const sucursalId = req.user.sucursalId;

    // validar pertenencia
    const [rows] = await pool
      .promise()
      .query(`SELECT id, sucursal_id FROM cuentas_corrientes WHERE id = ?`, [
        id,
      ]);
    if (!rows.length)
      return res.status(404).json({ error: "Cuenta no encontrada" });

    if (!isAdmin && rows[0].sucursal_id !== sucursalId) {
      return res.status(403).json({ error: "No autorizado" });
    }

    await pool.promise().query(
      `UPDATE cuentas_corrientes
       SET cliente_nombre = ?, telefono = ?, notas = ?
       WHERE id = ?`,
      [
        cliente_nombre.trim(),
        (telefono || "").trim(),
        (notas || "").trim(),
        id,
      ],
    );

    res.json({ ok: true });
  } catch (e) {
    // si choca UNIQUE(sucursal_id, cliente_nombre) al renombrar:
    if (e?.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ error: "Ya existe ese cliente en la sucursal" });
    }
    console.error("PUT /cuentas/:id", e);
    res.status(500).json({ error: "Error al editar cuenta" });
  }
});
router.patch("/cuentas/:id/archivar", authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const isAdmin = req.user.rol === "admin";
    const sucursalId = req.user.sucursalId;

    const [rows] = await pool
      .promise()
      .query(
        `SELECT id, sucursal_id, saldo, activo FROM cuentas_corrientes WHERE id = ?`,
        [id],
      );
    if (!rows.length)
      return res.status(404).json({ error: "Cuenta no encontrada" });

    const cuenta = rows[0];
    if (!isAdmin && cuenta.sucursal_id !== sucursalId) {
      return res.status(403).json({ error: "No autorizado" });
    }

    if (Number(cuenta.saldo) !== 0) {
      return res
        .status(400)
        .json({ error: "No se puede archivar con saldo distinto de 0" });
    }

    if (cuenta.activo === 0) return res.json({ ok: true });

    await pool
      .promise()
      .query(
        `UPDATE cuentas_corrientes SET activo = 0, archivado_at = NOW() WHERE id = ?`,
        [id],
      );

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /cuentas/:id/archivar", e);
    res.status(500).json({ error: "Error al archivar" });
  }
});
router.patch("/cuentas/:id/reactivar", authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const isAdmin = req.user.rol === "admin";
    const sucursalId = req.user.sucursalId;

    const [rows] = await pool
      .promise()
      .query(`SELECT id, sucursal_id FROM cuentas_corrientes WHERE id = ?`, [
        id,
      ]);
    if (!rows.length)
      return res.status(404).json({ error: "Cuenta no encontrada" });

    if (!isAdmin && rows[0].sucursal_id !== sucursalId) {
      return res.status(403).json({ error: "No autorizado" });
    }

    await pool
      .promise()
      .query(
        `UPDATE cuentas_corrientes SET activo = 1, archivado_at = NULL WHERE id = ?`,
        [id],
      );

    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /cuentas/:id/reactivar", e);
    res.status(500).json({ error: "Error al reactivar" });
  }
});


module.exports = router;

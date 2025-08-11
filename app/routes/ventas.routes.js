const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

// 🔵 Vender producto (de su sucursal) — con validación de cantidad
router.post("/vender", authenticate, async (req, res) => {
  const { rol, sucursalId: sucursalIdDesdeToken } = req.user;

  // Coerciones seguras
  const gustoId = Number(req.body.gusto_id);
  const cantidad = Number(req.body.cantidad);
  const sucursalIdBody = Number(req.body.sucursal_id);
  const sucursalIdFinal = rol === "admin" ? sucursalIdBody : Number(sucursalIdDesdeToken);

  // Validaciones de entrada
  if (!Number.isInteger(gustoId) || gustoId <= 0) {
    return res.status(400).json({ error: "gusto_id inválido" });
  }
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    return res.status(400).json({ error: "Cantidad inválida" });
  }
  if (!Number.isInteger(sucursalIdFinal) || sucursalIdFinal <= 0) {
    return res.status(400).json({ error: "sucursal_id inválido" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Leemos y bloqueamos la fila de stock (snapshot de precio y cantidad)
    const [rows] = await conn.query(
      "SELECT cantidad, precio FROM stock WHERE gusto_id = ? AND sucursal_id = ? FOR UPDATE",
      [gustoId, sucursalIdFinal]
    );
    const stockRow = rows?.[0];

    if (!stockRow) {
      await conn.rollback();
      return res.status(404).json({ error: "Stock no encontrado" });
    }
    if (stockRow.cantidad < cantidad) {
      await conn.rollback();
      return res.status(400).json({ error: "Stock insuficiente" });
    }

    // Descontar stock
    await conn.query(
      "UPDATE stock SET cantidad = cantidad - ? WHERE gusto_id = ? AND sucursal_id = ?",
      [cantidad, gustoId, sucursalIdFinal]
    );

    // Registrar venta con precio_unitario (precio en el momento)
    await conn.query(
      `INSERT INTO ventas (gusto_id, sucursal_id, cantidad, precio_unitario, fecha)
       VALUES (?, ?, ?, ?, NOW())`,
      [gustoId, sucursalIdFinal, cantidad, stockRow.precio]
    );

    await conn.commit();
    return res.json({
      mensaje: "✅ Venta registrada",
      precio_unitario: stockRow.precio,
    });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error al registrar venta:", e);
    return res.status(500).json({ error: "Error al registrar venta" });
  } finally {
    conn.release();
  }
});


// 🔵 Ventas mensuales (solo de su sucursal, salvo admin)
router.get("/ventas-mensuales", authenticate, async (req, res) => {
  const { mes, anio } = req.query;
  const { sucursalId, rol } = req.user;

  if (!mes || !anio)
    return res.status(400).json({ error: "Faltan parámetros mes y año" });

  try {
    let sql = `
      SELECT 
        s.nombre AS sucursal,
        SUM(v.cantidad) AS total_ventas,
        SUM(v.cantidad * v.precio_unitario) AS total_facturado
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
    `;
    const params = [mes, anio];

    if (rol !== "admin") {
      sql += " AND v.sucursal_id = ?";
      params.push(sucursalId);
    }

    sql += " GROUP BY v.sucursal_id";
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error ventas mensuales:", e);
    res.status(500).json({ error: "Error al obtener ventas mensuales" });
  }
});

router.get("/historial", authenticate, async (req, res) => {
  const { sucursalId, rol } = req.user;
  const filtroSucursal = req.query.sucursal_id;

  try {
    let sql = `
      SELECT 
        v.id,
        s.nombre AS sucursal,
        p.nombre AS producto,
        g.nombre AS gusto,
        v.cantidad,
        v.precio_unitario,
        (v.cantidad * v.precio_unitario) AS total_linea,
        v.fecha
      FROM ventas v
      JOIN gustos g     ON v.gusto_id = g.id
      JOIN productos p  ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
    `;
    const params = [];

    if (rol !== "admin") {
      sql += " WHERE v.sucursal_id = ?";
      params.push(sucursalId);
    } else if (filtroSucursal) {
      sql += " WHERE v.sucursal_id = ?";
      params.push(filtroSucursal);
    }

    sql += " ORDER BY v.fecha DESC";
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error historial ventas:", e);
    res.status(500).json({ error: "Error al obtener historial de ventas" });
  }
});

router.get("/total-por-sucursal", authenticate, async (req, res) => {
  const { rol } = req.user;
  if (rol !== "admin")
    return res
      .status(403)
      .json({ error: "Acceso denegado: sólo administradores" });

  try {
    const [rows] = await pool.promise().query(`
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(v.cantidad * v.precio_unitario) AS total_facturado
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error total por sucursal:", e);
    res.status(500).json({ error: "Error al obtener total de ventas" });
  }
});

// 🔵 Ventas mensuales por sucursal (solo admin)
router.get("/buscar-por-codigo/:codigo", async (req, res) => {
  const { codigo } = req.params;
  const { sucursal_id } = req.query;

  if (!codigo || !sucursal_id) {
    return res.status(400).json({ error: "Faltan parámetros" });
  }

  try {
    const [result] = await pool.promise().query(
      `SELECT 
        p.nombre AS producto_nombre,
        g.nombre AS gusto,
        g.id AS gusto_id,
        g.codigo_barra
      FROM gustos g
      JOIN productos p ON g.producto_id = p.id
      JOIN stock st ON st.gusto_id = g.id
      WHERE g.codigo_barra = ? AND st.sucursal_id = ?
      LIMIT 1`,
      [codigo, sucursal_id]
    );

    if (result.length === 0) {
      return res
        .status(404)
        .json({ error: "Producto no encontrado en esta sucursal" });
    }

    res.json(result[0]);
  } catch (error) {
    console.error("❌ Error al buscar producto por código:", error);
    res.status(500).json({ error: "Error interno" });
  }
});


/**
 * GET /deuda-por-sucursal
 * Query:
 *  - desde: YYYY-MM-DD (opcional)
 *  - hasta: YYYY-MM-DD (opcional)
 *  - sucursal_id: (solo admin) si querés filtrar una sucursal puntual
 *
 * Respuesta: [{ sucursal_id, sucursal, facturado, pagado, deuda }]
 */
router.get("/deuda-por-sucursal", authenticate, async (req, res) => {
  const { rol, sucursalId } = req.user;
  const { desde, hasta, sucursal_id } = req.query;

  try {
    // Armamos filtros independientes para ventas y pagos
    const whereV = [];
    const paramsV = [];
    const whereP = [];
    const paramsP = [];

    // Filtro por sucursal según rol
    if (rol !== "admin") {
      whereV.push("v.sucursal_id = ?");
      paramsV.push(sucursalId);
      whereP.push("p.sucursal_id = ?");
      paramsP.push(sucursalId);
    } else if (sucursal_id) {
      whereV.push("v.sucursal_id = ?");
      paramsV.push(sucursal_id);
      whereP.push("p.sucursal_id = ?");
      paramsP.push(sucursal_id);
    }

    // Filtro por rango de fechas (inclusive) usando [desde 00:00:00, hasta < día+1)
    if (desde) {
      whereV.push("v.fecha >= CONCAT(?, ' 00:00:00')");
      paramsV.push(desde);
      whereP.push("p.fecha >= CONCAT(?, ' 00:00:00')");
      paramsP.push(desde);
    }
    if (hasta) {
      whereV.push("v.fecha < DATE_ADD(?, INTERVAL 1 DAY)");
      paramsV.push(hasta);
      whereP.push("p.fecha < DATE_ADD(?, INTERVAL 1 DAY)");
      paramsP.push(hasta);
    }

    const subVentas = `
      SELECT v.sucursal_id, SUM(v.cantidad * v.precio_unitario) AS facturado
      FROM ventas v
      ${whereV.length ? "WHERE " + whereV.join(" AND ") : ""}
      GROUP BY v.sucursal_id
    `;

    const subPagos = `
      SELECT p.sucursal_id, SUM(p.monto) AS pagado
      FROM pagos p
      ${whereP.length ? "WHERE " + whereP.join(" AND ") : ""}
      GROUP BY p.sucursal_id
    `;

    // Traemos todas las sucursales visibles (una o todas según rol)
    let whereS = "";
    const paramsS = [];
    if (rol !== "admin") {
      whereS = "WHERE s.id = ?";
      paramsS.push(sucursalId);
    } else if (sucursal_id) {
      whereS = "WHERE s.id = ?";
      paramsS.push(sucursal_id);
    }

    const sql = `
      SELECT
        s.id   AS sucursal_id,
        s.nombre AS sucursal,
        COALESCE(v.facturado, 0) AS facturado,
        COALESCE(p.pagado,    0) AS pagado,
        COALESCE(v.facturado, 0) - COALESCE(p.pagado, 0) AS deuda
      FROM sucursales s
      LEFT JOIN (${subVentas}) v ON v.sucursal_id = s.id
      LEFT JOIN (${subPagos})  p ON p.sucursal_id = s.id
      ${whereS}
      ORDER BY s.nombre
    `;

    const [rows] = await pool
      .promise()
      .query(sql, [...paramsV, ...paramsP, ...paramsS]);

    res.json(rows);
  } catch (err) {
    console.error("❌ Error en /deuda-por-sucursal:", err);
    res.status(500).json({ error: "Error al calcular la deuda por sucursal" });
  }
});

module.exports = router;

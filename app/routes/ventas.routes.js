const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  "https://nahuelminio04.app.n8n.cloud/webhook/87cb3b26-fadf-43a8-950c-2b181ca9420d";

// Si tu Node no tiene fetch nativo (Node < 18), descomentá esto:
// const fetch = (...args) =>
//   import("node-fetch").then(({ default: f }) => f(...args));

router.post("/vender", authenticate, async (req, res) => {
  const { rol, sucursalId: sucursalIdDesdeToken } = req.user;

  // Coerciones seguras
  const gustoId = Number(req.body.gusto_id);
  const cantidad = Number(req.body.cantidad);
  const sucursalIdBody = Number(req.body.sucursal_id);
  const sucursalIdFinal =
    rol === "admin" ? sucursalIdBody : Number(sucursalIdDesdeToken);

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

  const conn = await pool.promise().getConnection();
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
    const [ins] = await conn.query(
      `INSERT INTO ventas (gusto_id, sucursal_id, cantidad, precio_unitario, fecha)
       VALUES (?, ?, ?, ?, NOW())`,
      [gustoId, sucursalIdFinal, cantidad, stockRow.precio]
    );

    await conn.commit();

    // 🔹 NUEVO: obtener nombres para mandar a n8n (NO afecta a la venta)
    let info = {};
    try {
      const [rowsInfo] = await conn.query(
        `
        SELECT 
          g.nombre AS gusto_nombre,
          p.nombre AS modelo_nombre,
          s.nombre AS sucursal_nombre
        FROM ventas v
        JOIN gustos g      ON v.gusto_id = g.id
        JOIN productos p   ON g.producto_id = p.id
        JOIN sucursales s  ON v.sucursal_id = s.id
        WHERE v.id = ?
        `,
        [ins.insertId]
      );
      info = rowsInfo?.[0] || {};
    } catch (e) {
      console.error("Error obteniendo info para n8n:", e.message || e);
    }

    // 🔹 NUEVO: armar payload para n8n
    const payload = {
      venta_id: ins.insertId,
      gusto_id: gustoId,
      sucursal_id: sucursalIdFinal,
      cantidad,
      precio_unitario: stockRow.precio,
      fecha_iso: new Date().toISOString(),

      modelo_nombre: info?.modelo_nombre || null,
      gusto_nombre: info?.gusto_nombre || null,
      sucursal_nombre: info?.sucursal_nombre || null,
    };

    // 🔹 NUEVO: enviar a n8n (fire-and-forget)
    (async () => {
      if (!N8N_WEBHOOK_URL) return;
      try {
        await fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        console.error("Error enviando venta a n8n:", err.message || err);
      }
    })();

    // 🔙 Respuesta al frontend: IGUAL que antes
    return res.json({
      mensaje: "✅ Venta registrada",
      venta_id: ins.insertId,
      precio_unitario: stockRow.precio,
    });
  } catch (e) {
    await conn.rollback();
    console.error("❌ Error al registrar venta:", e.code || e.message, e);
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
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(v.cantidad) AS total_ventas,
        SUM(v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS total_facturado
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      LEFT JOIN stock st ON st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
    `;
    const params = [Number(mes), Number(anio)];

    if (rol !== "admin") {
      sql += " AND v.sucursal_id = ?";
      params.push(Number(sucursalId));
    }

    sql += " GROUP BY s.id, s.nombre ORDER BY s.nombre";
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error ventas mensuales:", e);
    res.status(500).json({ error: "Error al obtener ventas mensuales" });
  }
});
// GET /ventas-semanales?anio=2025&semana=42
router.get("/ventas-semanales", authenticate, async (req, res) => {
  let { semana, anio } = req.query;
  const { sucursalId, rol } = req.user;

  try {
    const hoy = new Date();

    if (!anio) anio = hoy.getFullYear();
    anio = Number(anio);

    if (!semana) {
      // Si no viene semana, calculo la semana ISO actual
      const fechaUTC = new Date(
        Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())
      );
      const diaSemana = fechaUTC.getUTCDay() || 7; // domingo = 7
      fechaUTC.setUTCDate(fechaUTC.getUTCDate() + 4 - diaSemana);
      const inicioAno = new Date(Date.UTC(fechaUTC.getUTCFullYear(), 0, 1));
      semana = Math.ceil(((fechaUTC - inicioAno) / 86400000 + 1) / 7);
    }

    semana = Number(semana);

    if (!Number.isInteger(semana) || semana < 1 || semana > 53) {
      return res.status(400).json({ error: "Semana inválida" });
    }
    if (!Number.isInteger(anio) || anio < 2000) {
      return res.status(400).json({ error: "Año inválido" });
    }

    // 👉 Calcular lunes y domingo de esa semana ISO
    const getMondayOfISOWeek = (week, year) => {
      const simple = new Date(year, 0, 1 + (week - 1) * 7);
      const dow = simple.getDay(); // 0=domingo .. 6=sábado
      const ISOweekStart = new Date(simple);
      let diff;
      if (dow <= 4 && dow !== 0) {
        // lunes-martes-miércoles-jueves
        diff = 1 - dow;
      } else if (dow === 0) {
        // domingo
        diff = -6;
      } else {
        // viernes-sábado
        diff = 8 - dow;
      }
      ISOweekStart.setDate(simple.getDate() + diff);
      return ISOweekStart;
    };

    const inicioSemana = getMondayOfISOWeek(semana, anio); // lunes
    const finSemana = new Date(inicioSemana);
    finSemana.setDate(inicioSemana.getDate() + 6); // domingo

    const inicioStr = inicioSemana.toISOString().slice(0, 10); // YYYY-MM-DD
    const finStr = finSemana.toISOString().slice(0, 10);

    console.log(
      "📅 /ventas-semanales => semana:",
      semana,
      "año:",
      anio,
      "rango:",
      inicioStr,
      "->",
      finStr,
      "rol:",
      rol,
      "sucursalId:",
      sucursalId
    );

    // 👉 Query por rango de fechas
    let sql = `
      SELECT
        DATE_FORMAT(v.fecha, '%W')      AS dia_semana,
        SUM(
          v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)
        ) AS total_ventas
      FROM ventas v
      LEFT JOIN stock st
        ON st.gusto_id = v.gusto_id
       AND st.sucursal_id = v.sucursal_id
      WHERE DATE(v.fecha) BETWEEN ? AND ?
    `;
    const params = [inicioStr, finStr];

    // Si NO es admin, filtro por sucursal
    if (rol !== "admin") {
      sql += " AND v.sucursal_id = ?";
      params.push(Number(sucursalId));
    }

    sql += `
      GROUP BY dia_semana
      ORDER BY FIELD(
        dia_semana,
        'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'
      )
    `;

    const [rows] = await pool.promise().query(sql, params);

    const respuesta = rows.map((r) => ({
      dia: r.dia_semana, // ej: Monday, Tuesday
      total: Number(r.total_ventas) || 0,
    }));

    console.log("📊 /ventas-semanales resultado:", respuesta);

    res.json(respuesta);
  } catch (e) {
    console.error("❌ Error ventas semanales:", e);
    res.status(500).json({ error: "Error al obtener ventas semanales" });
  }
});

router.get("/historial", authenticate, async (req, res) => {
  const { sucursalId, rol } = req.user; // del token
  const { sucursal_id } = req.query; // filtro opcional para admin

  try {
    // Armamos condiciones de forma segura
    const where = [];
    const params = [];

    if (String(rol).toLowerCase() !== "admin") {
      // Si NO es admin, fuerza su propia sucursal
      where.push("v.sucursal_id = ?");
      params.push(Number(sucursalId));
    } else if (sucursal_id) {
      // Si es admin y pasó filtro
      where.push("v.sucursal_id = ?");
      params.push(Number(sucursal_id));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        v.id,
        s.nombre AS sucursal,
        p.nombre AS producto,
        g.nombre AS gusto,
        v.cantidad,
        -- ✅ precio: usa el guardado en la venta; si falta, toma el de stock
        COALESCE(v.precio_unitario, st.precio, 0) AS precio,
        -- ✅ total: cantidad * precio efectivo
        (v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS total,
        v.fecha
      FROM ventas v
      JOIN gustos g      ON v.gusto_id = g.id
      JOIN productos p   ON g.producto_id = p.id
      JOIN sucursales s  ON v.sucursal_id = s.id
      -- LEFT JOIN para respaldo de precio si la venta no tiene precio_unitario
      LEFT JOIN stock st ON st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id
      ${whereSql}
      ORDER BY v.fecha DESC
    `;

    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error historial ventas:", e);
    res.status(500).json({ error: "Error al obtener historial de ventas" });
  }
});

router.get("/ventas-mensuales", authenticate, async (req, res) => {
  const { mes, anio } = req.query;
  const { sucursalId, rol } = req.user;

  if (!mes || !anio)
    return res.status(400).json({ error: "Faltan parámetros mes y año" });

  try {
    let sql = `
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(v.cantidad) AS total_ventas,
        SUM(v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS total_facturado
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      LEFT JOIN stock st ON st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
    `;
    const params = [Number(mes), Number(anio)];

    if (rol !== "admin") {
      sql += " AND v.sucursal_id = ?";
      params.push(Number(sucursalId));
    }

    sql += " GROUP BY s.id, s.nombre ORDER BY s.nombre";
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error ventas mensuales:", e);
    res.status(500).json({ error: "Error al obtener ventas mensuales" });
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

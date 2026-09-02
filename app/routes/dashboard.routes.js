const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo administradores" });
  next();
};


/**
 * Costo de una venta, tomado de las reposiciones reales.
 *
 * Antes se usaba productos.precio_costo, un costo plano por producto que en la
 * practica esta en cero para la mayoria: eso hacia que el Dashboard mostrara
 * margenes del 85-100% mientras Metricas mostraba 20-25%. Esta es la misma
 * logica que metricas.routes.js, asi las dos pantallas dan lo mismo.
 *
 * Busca en orden: la reposicion anterior a la venta, la posterior, y por
 * ultimo el promedio del sabor. Requiere un alias 'v' para la venta.
 */
const COSTO_VENTA = `
  COALESCE(
    (SELECT r.precio_costo FROM reposiciones r
      WHERE r.gusto_id = v.gusto_id AND r.precio_costo > 0 AND r.fecha <= v.fecha
      ORDER BY r.fecha DESC LIMIT 1),
    (SELECT r.precio_costo FROM reposiciones r
      WHERE r.gusto_id = v.gusto_id AND r.precio_costo > 0 AND r.fecha > v.fecha
      ORDER BY r.fecha ASC LIMIT 1),
    (SELECT AVG(r.precio_costo) FROM reposiciones r
      WHERE r.gusto_id = v.gusto_id AND r.precio_costo > 0),
    0
  )`;

/**
 * Facturado de un pedido mayorista.
 *
 * 30 de los 86 pedidos confirmados tienen total_ars en cero: se cargaron en
 * dolares y nunca se les puso la cotizacion. Sumando total_ars a secas, esos
 * pedidos aportan costo pero no facturacion, y la ganancia da negativa.
 * Igual que en metricas.routes.js, se cae al total en dolares por el tipo de
 * cambio del pedido confirmado mas cercano en el tiempo.
 */
const FACTURADO_MAYORISTA = `
  CASE WHEN pm.total_ars > 0 THEN pm.total_ars
       ELSE pm.total_usd * COALESCE((
         SELECT p2.tipo_cambio FROM pedidos_mayoristas p2
          WHERE p2.estado = 'confirmado' AND p2.tipo_cambio > 0
          ORDER BY ABS(TIMESTAMPDIFF(SECOND, p2.fecha_confirmacion, pm.fecha_confirmacion))
          LIMIT 1), 0)
  END`;

/** Idem para un item de pedido mayorista, que no tiene fecha propia de venta. */
const COSTO_ITEM_MAYORISTA = `
  COALESCE(
    (SELECT AVG(r.precio_costo) FROM reposiciones r
      WHERE r.gusto_id = pmi.gusto_id AND r.precio_costo > 0),
    0
  )`;

// Datos para el dashboard principal
router.get("/dashboard", authenticate, soloAdmin, async (req, res) => {
  try {
    const [[stockTotal]] = await pool
      .promise()
      .query("SELECT SUM(cantidad) as total FROM stock");

    const [[stockBajo]] = await pool
      .promise()
      .query("SELECT COUNT(*) as bajos FROM stock WHERE cantidad <= 5");

    const [porSucursal] = await pool.promise().query(
      `SELECT s.nombre, COUNT(*) as productos
       FROM stock st
       JOIN sucursales s ON st.sucursal_id = s.id
       GROUP BY s.nombre`
    );

    res.json({
      stockTotal: stockTotal.total || 0,
      stockBajo: stockBajo.bajos || 0,
      productosPorSucursal: porSucursal,
      totalProductos: porSucursal.reduce((acc, s) => acc + s.productos, 0),
    });
  } catch (error) {
    console.error("❌ Error al obtener dashboard:", error);
    res.status(500).json({ error: "Error al obtener dashboard" });
  }
});

router.get("/resumen-ganancias", authenticate, soloAdmin, async (req, res) => {
  try {
    const [rows] = await pool.promise().query(`
      SELECT
        s.nombre AS sucursal,
        COALESCE(reg.ventas_regulares, 0) + COALESCE(may.ventas_mayorista, 0)   AS total_ventas,
        COALESCE(reg.ventas_regulares, 0)                                         AS ventas_regulares,
        COALESCE(may.ventas_mayorista, 0)                                         AS ventas_mayorista,
        COALESCE(reg.costo_regular, 0)    + COALESCE(may.costo_mayorista, 0)    AS costo_total,
        (COALESCE(reg.ventas_regulares, 0) + COALESCE(may.ventas_mayorista, 0))
          - (COALESCE(reg.costo_regular, 0) + COALESCE(may.costo_mayorista, 0)) AS ganancia,
        'sucursal' AS tipo
      FROM sucursales s
      LEFT JOIN (
        SELECT
          v.sucursal_id,
          SUM(v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS ventas_regulares,
          SUM(v.cantidad * ${COSTO_VENTA})                             AS costo_regular
        FROM ventas v
        JOIN gustos   g  ON g.id  = v.gusto_id
        JOIN productos p ON p.id  = g.producto_id
        LEFT JOIN stock st ON st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id
        -- Las ventas de vendedores salen aparte, abajo. Sin esto quedaban
        -- sumadas dentro de su sucursal y no se veian como canal propio.
        WHERE v.vendedor_id IS NULL
        GROUP BY v.sucursal_id
      ) reg ON reg.sucursal_id = s.id
      -- total_ars es el total del PEDIDO. Si se joinea directo con los items,
      -- la fila del pedido se repite una vez por item y el total se suma tantas
      -- veces como items tenga. Por eso los items se agregan aparte.
      LEFT JOIN (
        SELECT
          pm.sucursal_id,
          SUM(${FACTURADO_MAYORISTA}) AS ventas_mayorista,
          SUM(it.costo)     AS costo_mayorista
        FROM pedidos_mayoristas pm
        LEFT JOIN (
          SELECT pmi.pedido_id, SUM(pmi.cantidad * ${COSTO_ITEM_MAYORISTA}) AS costo
          FROM pedido_mayorista_items pmi
          GROUP BY pmi.pedido_id
        ) it ON it.pedido_id = pm.id
        WHERE pm.estado = 'confirmado'
        GROUP BY pm.sucursal_id
      ) may ON may.sucursal_id = s.id
      WHERE reg.sucursal_id IS NOT NULL OR may.sucursal_id IS NOT NULL

      UNION ALL

      -- Vendedores: mismo calculo que una sucursal, pero agrupado por vendedor.
      -- No se duplica nada porque arriba se los excluyo del subtotal de su sucursal.
      SELECT
        COALESCE(NULLIF(TRIM(u.nombre), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS sucursal,
        ven.ventas       AS total_ventas,
        ven.ventas       AS ventas_regulares,
        0                AS ventas_mayorista,
        ven.costo        AS costo_total,
        ven.ventas - ven.costo AS ganancia,
        'vendedor'       AS tipo
      FROM usuarios u
      JOIN (
        SELECT
          v.vendedor_id,
          SUM(v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS ventas,
          SUM(v.cantidad * ${COSTO_VENTA})                            AS costo
        FROM ventas v
        JOIN gustos    g ON g.id = v.gusto_id
        JOIN productos p ON p.id = g.producto_id
        LEFT JOIN stock st ON st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id
        WHERE v.vendedor_id IS NOT NULL
        GROUP BY v.vendedor_id
      ) ven ON ven.vendedor_id = u.id
      ORDER BY tipo, sucursal;
    `);

    res.json(rows);
  } catch (error) {
    console.error("❌ Error al obtener resumen de ganancias:", error);
    res.status(500).json({ error: "Error al obtener resumen de ganancias" });
  }
});

router.get("/resumen-ganancias-mensual", authenticate, soloAdmin, async (req, res) => {
  const { mes, anio } = req.query;

  if (!mes || !anio) {
    return res.status(400).json({ error: "Debe proporcionar mes y año" });
  }

  try {
    const [rows] = await pool.promise().query(
      `
      SELECT
        s.nombre AS sucursal,
        COALESCE(reg.ventas_regulares, 0) + COALESCE(may.ventas_mayorista, 0)   AS total_ventas,
        COALESCE(reg.ventas_regulares, 0)                                         AS ventas_regulares,
        COALESCE(may.ventas_mayorista, 0)                                         AS ventas_mayorista,
        COALESCE(reg.costo_regular, 0)    + COALESCE(may.costo_mayorista, 0)    AS costo_total,
        (COALESCE(reg.ventas_regulares, 0) + COALESCE(may.ventas_mayorista, 0))
          - (COALESCE(reg.costo_regular, 0) + COALESCE(may.costo_mayorista, 0)) AS ganancia,
        'sucursal' AS tipo
      FROM sucursales s
      LEFT JOIN (
        SELECT
          v.sucursal_id,
          SUM(v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS ventas_regulares,
          SUM(v.cantidad * ${COSTO_VENTA})                             AS costo_regular
        FROM ventas v
        JOIN gustos   g  ON g.id  = v.gusto_id
        JOIN productos p ON p.id  = g.producto_id
        LEFT JOIN stock st ON st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id
        WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
          AND v.vendedor_id IS NULL   -- ver nota arriba
        GROUP BY v.sucursal_id
      ) reg ON reg.sucursal_id = s.id
      -- total_ars es el total del PEDIDO. Si se joinea directo con los items,
      -- la fila del pedido se repite una vez por item y el total se suma tantas
      -- veces como items tenga. Por eso los items se agregan aparte.
      LEFT JOIN (
        SELECT
          pm.sucursal_id,
          SUM(${FACTURADO_MAYORISTA}) AS ventas_mayorista,
          SUM(it.costo)     AS costo_mayorista
        FROM pedidos_mayoristas pm
        LEFT JOIN (
          SELECT pmi.pedido_id, SUM(pmi.cantidad * ${COSTO_ITEM_MAYORISTA}) AS costo
          FROM pedido_mayorista_items pmi
          GROUP BY pmi.pedido_id
        ) it ON it.pedido_id = pm.id
        WHERE pm.estado = 'confirmado'
          AND MONTH(pm.fecha_confirmacion) = ? AND YEAR(pm.fecha_confirmacion) = ?
        GROUP BY pm.sucursal_id
      ) may ON may.sucursal_id = s.id
      WHERE reg.sucursal_id IS NOT NULL OR may.sucursal_id IS NOT NULL

      UNION ALL

      -- Vendedores: mismo calculo que una sucursal, pero agrupado por vendedor.
      -- No se duplica nada porque arriba se los excluyo del subtotal de su sucursal.
      SELECT
        COALESCE(NULLIF(TRIM(u.nombre), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS sucursal,
        ven.ventas       AS total_ventas,
        ven.ventas       AS ventas_regulares,
        0                AS ventas_mayorista,
        ven.costo        AS costo_total,
        ven.ventas - ven.costo AS ganancia,
        'vendedor'       AS tipo
      FROM usuarios u
      JOIN (
        SELECT
          v.vendedor_id,
          SUM(v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS ventas,
          SUM(v.cantidad * ${COSTO_VENTA})                            AS costo
        FROM ventas v
        JOIN gustos    g ON g.id = v.gusto_id
        JOIN productos p ON p.id = g.producto_id
        LEFT JOIN stock st ON st.gusto_id = v.gusto_id AND st.sucursal_id = v.sucursal_id
        WHERE v.vendedor_id IS NOT NULL
          AND MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
        GROUP BY v.vendedor_id
      ) ven ON ven.vendedor_id = u.id
      ORDER BY tipo, sucursal;
      `,
      [mes, anio, mes, anio, mes, anio]
    );

    res.json(rows);
  } catch (error) {
    console.error("❌ Error al obtener resumen mensual:", error);
    res.status(500).json({ error: "Error al obtener resumen mensual de ganancias" });
  }
});

router.get("/kpis-hoy", authenticate, soloAdmin, async (req, res) => {
  try {
    const db = pool.promise();

    const [[hoy]] = await db.query(`
      SELECT
        COUNT(*)                                              AS transacciones,
        COALESCE(SUM(cantidad), 0)                           AS unidades,
        COALESCE(SUM(cantidad * COALESCE(precio_unitario,0)),0) AS total_ars
      FROM ventas
      WHERE DATE(fecha) = CURDATE()
    `);

    const [[ayer]] = await db.query(`
      SELECT COALESCE(SUM(cantidad * COALESCE(precio_unitario,0)),0) AS total_ars
      FROM ventas
      WHERE DATE(fecha) = CURDATE() - INTERVAL 1 DAY
    `);

    const [[mayHoy]] = await db.query(`
      SELECT COALESCE(SUM(total_ars),0) AS total_ars
      FROM pedidos_mayoristas
      WHERE estado = 'confirmado' AND DATE(fecha_confirmacion) = CURDATE()
    `);

    const [[mayAyer]] = await db.query(`
      SELECT COALESCE(SUM(total_ars),0) AS total_ars
      FROM pedidos_mayoristas
      WHERE estado = 'confirmado' AND DATE(fecha_confirmacion) = CURDATE() - INTERVAL 1 DAY
    `);

    const totalHoy  = Number(hoy.total_ars)  + Number(mayHoy.total_ars);
    const totalAyer = Number(ayer.total_ars) + Number(mayAyer.total_ars);
    const variacion = totalAyer > 0 ? ((totalHoy - totalAyer) / totalAyer) * 100 : null;

    res.json({
      ventas_hoy:       totalHoy,
      ventas_ayer:      totalAyer,
      variacion_pct:    variacion !== null ? Math.round(variacion * 10) / 10 : null,
      unidades_hoy:     Number(hoy.unidades),
      transacciones_hoy: Number(hoy.transacciones),
    });
  } catch (error) {
    console.error("❌ Error kpis-hoy:", error);
    res.status(500).json({ error: "Error al obtener KPIs del día" });
  }
});

router.get("/ranking-productos-sucursal", authenticate, soloAdmin, async (req, res) => {
  const { mes, anio } = req.query;

  if (!mes || !anio) {
    return res.status(400).json({ error: "Faltan parámetros mes o año" });
  }

  try {
    const [rows] = await pool.promise().query(
      `
      SELECT
        s.nombre AS sucursal,
        p.nombre AS producto_nombre,
        g.nombre AS gusto,
        SUM(v.cantidad) AS total_vendido
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
      GROUP BY s.id, g.id
      ORDER BY s.nombre, total_vendido DESC;
    `,
      [mes, anio]
    );

    res.json(rows);
  } catch (error) {
    console.error("❌ Error al obtener ranking:", error);
    res.status(500).json({ error: "Error al obtener el ranking" });
  }
});

module.exports = router;

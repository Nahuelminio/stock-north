const express = require("express");
const router = express.Router();
const pool = require("../db");
const multer = require("multer");
const xlsx = require("xlsx");
const fs = require("fs");

const upload = multer({ dest: "uploads/" });

/** ==========================
 * PRODUCTOS
 * ========================== */

// Obtener productos
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `SELECT 
        p.id AS producto_id,
        p.nombre AS producto_nombre,
        p.precio,
        g.id AS gusto_id,
        g.nombre AS gusto,
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        st.cantidad AS stock
      FROM productos p
      JOIN gustos g ON g.producto_id = p.id
      JOIN stock st ON st.gusto_id = g.id
      JOIN sucursales s ON s.id = st.sucursal_id`
    );
    res.json(rows);
  } catch (error) {
    console.error("❌ Error al obtener productos:", error);
    res.status(500).json({ error: "Error al obtener productos" });
  }
});

// Agregar producto
router.post("/agregar-producto", async (req, res) => {
  const { nombre, gusto, sucursal_id, stock, precio, codigo_barra } = req.body;
  if (
    !nombre ||
    !gusto ||
    !sucursal_id ||
    stock === undefined ||
    precio === undefined
  ) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  try {
    const [[producto]] = await pool
      .promise()
      .query("SELECT id FROM productos WHERE nombre = ?", [nombre]);

    let producto_id;

    if (producto?.id) {
      producto_id = producto.id;
      await pool
        .promise()
        .query("UPDATE productos SET precio = ?, codigo_barra = ? WHERE id = ?", [
          precio,
          codigo_barra || null,
          producto_id,
        ]);
    } else {
      const [insert] = await pool
        .promise()
        .query("INSERT INTO productos (nombre, precio, codigo_barra) VALUES (?, ?, ?)", [
          nombre,
          precio,
          codigo_barra || null,
        ]);
      producto_id = insert.insertId;
    }

    const [gustoInsert] = await pool
      .promise()
      .query("INSERT INTO gustos (producto_id, nombre) VALUES (?, ?)", [
        producto_id,
        gusto,
      ]);

    await pool
      .promise()
      .query(
        "INSERT INTO stock (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)",
        [gustoInsert.insertId, sucursal_id, stock]
      );

    res.status(200).json({ mensaje: "Producto agregado correctamente" });
  } catch (error) {
    console.error("❌ Error al agregar producto:", error);
    res.status(500).json({ error: "No se pudo agregar producto" });
  }
});

// Eliminar gusto
router.delete("/:gusto_id", async (req, res) => {
  try {
    await pool
      .promise()
      .query("DELETE FROM gustos WHERE id = ?", [req.params.gusto_id]);
    res.json({ mensaje: "Gusto eliminado" });
  } catch (error) {
    res.status(500).json({ error: "Error al eliminar" });
  }
});

// Editar gusto + stock
router.post("/editar/:gusto_id", async (req, res) => {
  const { stock, sucursal_id, nuevoGusto, precio, producto_id, codigo_barra } = req.body;
  const { gusto_id } = req.params;

  try {
    if (nuevoGusto) {
      await pool
        .promise()
        .query("UPDATE gustos SET nombre = ? WHERE id = ?", [
          nuevoGusto,
          gusto_id,
        ]);
    }
    await pool
      .promise()
      .query(
        "UPDATE stock SET cantidad = ? WHERE gusto_id = ? AND sucursal_id = ?",
        [stock, gusto_id, sucursal_id]
      );

    if (precio !== undefined && producto_id) {
      await pool
        .promise()
        .query("UPDATE productos SET precio = ?, codigo_barra = ? WHERE id = ?", [
          precio,
          codigo_barra || null,
          producto_id,
        ]);
    }

    res.json({ mensaje: "Producto actualizado correctamente" });
  } catch (error) {
    console.error("❌ Error al editar producto:", error);
    res.status(500).json({ error: "Error al editar producto" });
  }
});
/** ==========================
 * SUCURSALES
 * ========================== */

router.get("/sucursales", async (req, res) => {
  try {
    const [results] = await pool.promise().query("SELECT * FROM sucursales");
    res.json(results);
  } catch (err) {
    console.error("❌ Error al obtener sucursales:", err);
    res.status(500).json({ error: "Error al obtener sucursales" });
  }
});

router.post("/sucursales", async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) {
    return res.status(400).json({ error: "Falta el nombre de la sucursal" });
  }
  try {
    const [result] = await pool
      .promise()
      .query("INSERT INTO sucursales (nombre) VALUES (?)", [nombre]);
    res.json({ mensaje: "Sucursal creada", id: result.insertId });
  } catch (error) {
    console.error("❌ Error al crear sucursal:", error);
    res.status(500).json({ error: "No se pudo crear la sucursal" });
  }
});

/** ==========================
 * STOCK y VENTAS
 * ========================== */

// Vender
router.post("/vender", async (req, res) => {
  const { gusto_id, sucursal_id, cantidad } = req.body;
  if (!gusto_id || !sucursal_id || !cantidad) {
    return res.status(400).json({ error: "Datos incompletos" });
  }
  try {
    const [[stock]] = await pool
      .promise()
      .query(
        "SELECT cantidad FROM stock WHERE gusto_id = ? AND sucursal_id = ?",
        [gusto_id, sucursal_id]
      );

    if (!stock || stock.cantidad < cantidad) {
      return res
        .status(400)
        .json({ error: "Stock insuficiente o no encontrado" });
    }

    await pool
      .promise()
      .query(
        "UPDATE stock SET cantidad = cantidad - ? WHERE gusto_id = ? AND sucursal_id = ?",
        [cantidad, gusto_id, sucursal_id]
      );

    await pool
      .promise()
      .query(
        "INSERT INTO ventas (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)",
        [gusto_id, sucursal_id, cantidad]
      );

    res.json({ mensaje: "Venta registrada" });
  } catch (error) {
    console.error("❌ Error al registrar venta:", error);
    res.status(500).json({ error: "Error al registrar venta" });
  }
});

router.get("/valor-stock-por-sucursal", async (req, res) => {
  try {
    const [results] = await pool.promise().query(`
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(st.cantidad * p.precio) AS valor_total
      FROM stock st
      JOIN gustos g ON st.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON st.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);

    res.json(results);
  } catch (error) {
    console.error("❌ Error al calcular valor de stock por sucursal:", error);
    res.status(500).json({ error: "Error al obtener valor de stock" });
  }
});

// Reposición
router.post("/reposicion", async (req, res) => {
  const { gusto_id, sucursal_id, cantidad } = req.body;
  if (!gusto_id || !sucursal_id || !cantidad) {
    return res.status(400).json({ error: "Faltan datos para la reposición" });
  }
  try {
    await pool
      .promise()
      .query(
        "UPDATE stock SET cantidad = cantidad + ? WHERE gusto_id = ? AND sucursal_id = ?",
        [cantidad, gusto_id, sucursal_id]
      );

    await pool
      .promise()
      .query(
        "INSERT INTO reposiciones (gusto_id, sucursal_id, cantidad_repuesta, fecha) VALUES (?, ?, ?, NOW())",
        [gusto_id, sucursal_id, cantidad]
      );

    res.json({ mensaje: "Reposición registrada correctamente ✅" });
  } catch (error) {
    console.error("❌ Error al registrar reposición:", error);
    res.status(500).json({ error: "Error al registrar la reposición" });
  }
});
// Reposición rápida sin registrar en historial
router.post("/reposicion-rapida", async (req, res) => {
  const { gusto_id, sucursal_id, cantidad } = req.body;

  if (!gusto_id || !sucursal_id || !cantidad) {
    return res
      .status(400)
      .json({ error: "Faltan datos para la reposición rápida" });
  }

  try {
    const [existencia] = await pool
      .promise()
      .query("SELECT * FROM stock WHERE gusto_id = ? AND sucursal_id = ?", [
        gusto_id,
        sucursal_id,
      ]);

    if (existencia.length === 0) {
      await pool
        .promise()
        .query(
          "INSERT INTO stock (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)",
          [gusto_id, sucursal_id, cantidad]
        );
    } else {
      await pool
        .promise()
        .query(
          "UPDATE stock SET cantidad = cantidad + ? WHERE gusto_id = ? AND sucursal_id = ?",
          [cantidad, gusto_id, sucursal_id]
        );
    }

    res.json({ mensaje: "✅ Reposición rápida realizada" });
  } catch (error) {
    console.error("❌ Error en reposición rápida:", error);
    res.status(500).json({ error: "Error al realizar reposición rápida" });
  }
});

/** ==========================
 * DASHBOARD / HISTORIALES
 * ========================== */

router.get("/dashboard", async (req, res) => {
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
    res.status(500).json({ error: "Error al obtener dashboard" });
  }
});
router.get("/ventas-total-por-sucursal", async (req, res) => {
  try {
    const [result] = await pool.promise().query(`
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(v.cantidad * p.precio) AS total_ventas
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);

    res.json(result);
  } catch (error) {
    console.error("❌ Error al obtener ventas por sucursal:", error);
    res.status(500).json({ error: "Error al obtener ventas por sucursal" });
  }
});

router.get("/ventas-por-sucursal", async (req, res) => {
  try {
    const [ventas] = await pool.promise().query(`
      SELECT 
        s.nombre AS sucursal, 
        SUM(v.cantidad * p.precio) AS total_facturado
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY v.sucursal_id, s.nombre
    `);
    res.json(ventas);
  } catch (err) {
    console.error("❌ Error al obtener ventas por sucursal:", err);
    res.status(500).json({ error: "Error al obtener ventas" });
  }
});


router.get("/ventas-mensuales", async (req, res) => {
  const { mes, anio } = req.query;
  if (!mes || !anio) {
    return res.status(400).json({ error: "Faltan parámetros mes y año" });
  }
  try {
    const [result] = await pool.promise().query(
      `
      SELECT 
        s.nombre AS sucursal,
        SUM(v.cantidad) AS total_ventas
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?
      GROUP BY v.sucursal_id
    `,
      [mes, anio]
    );
    res.json(result);
  } catch (error) {
    console.error("❌ Error al obtener ventas mensuales:", error);
    res.status(500).json({ error: "Error al obtener ventas mensuales" });
  }
});

router.get("/historial-ventas", async (req, res) => {
  const { sucursal_id } = req.query;
  try {
    let query = `
     SELECT 
     v.id,
     s.nombre AS sucursal,
     p.nombre AS producto,
     g.nombre AS gusto,
     v.cantidad,
     p.precio, -- 👈 agregar esta línea
     v.fecha
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
    `;

    const params = [];
    if (sucursal_id) {
      query += " WHERE v.sucursal_id = ?";
      params.push(sucursal_id);
    }
    query += " ORDER BY v.fecha DESC";

    const [results] = await pool.promise().query(query, params);
    res.json(results);
  } catch (err) {
    console.error("❌ Error al obtener historial de ventas:", err);
    res.status(500).json({ error: "Error al obtener historial de ventas" });
  }
});
router.get("/total-ventas-por-sucursal", async (req, res) => {
  try {
    const [results] = await pool.promise().query(`
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(v.cantidad * p.precio) AS total_facturado
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);

    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener total de ventas por sucursal:", error);
    res.status(500).json({ error: "Error al obtener total de ventas" });
  }
});
router.get("/ventas-totales-por-sucursal", async (req, res) => {
  try {
    const [result] = await pool.promise().query(`
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(v.cantidad * p.precio) AS total_ventas
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);
    res.json(result);
  } catch (error) {
    console.error("❌ Error al obtener ventas totales por sucursal:", error);
    res.status(500).json({ error: "Error al obtener ventas" });
  }
});



router.get("/historial-reposiciones", async (req, res) => {
  const { producto, gusto, sucursal_id, fecha_inicio, fecha_fin } = req.query;

  try {
    let query = `
      SELECT 
        r.id,
        r.fecha,
        s.nombre AS sucursal,
        p.nombre AS producto,
        g.nombre AS gusto,
        r.cantidad_repuesta AS cantidad
      FROM reposiciones r
      JOIN gustos g ON r.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON r.sucursal_id = s.id
      WHERE 1 = 1
    `;

    const params = [];

    if (sucursal_id) {
      query += " AND s.id = ?";
      params.push(sucursal_id);
    }

    if (producto) {
      query += " AND p.nombre LIKE ?";
      params.push(`%${producto}%`);
    }

    if (gusto) {
      query += " AND g.nombre LIKE ?";
      params.push(`%${gusto}%`);
    }

    if (fecha_inicio && fecha_fin) {
      query += " AND DATE(r.fecha) BETWEEN ? AND ?";
      params.push(fecha_inicio, fecha_fin);
    } else if (fecha_inicio) {
      query += " AND DATE(r.fecha) >= ?";
      params.push(fecha_inicio);
    } else if (fecha_fin) {
      query += " AND DATE(r.fecha) <= ?";
      params.push(fecha_fin);
    }

    query += " ORDER BY r.fecha DESC";

    const [results] = await pool.promise().query(query, params);
    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener historial de reposiciones:", error);
    res
      .status(500)
      .json({ error: "Error al obtener historial de reposiciones" });
  }
});

module.exports = router;

/** ==========================
 * UTILIDAD: Disponibles
 * ========================== */

router.get("/disponibles", async (req, res) => {
  const { sucursal_id } = req.query;
  if (!sucursal_id) {
    return res.status(400).json({ error: "Falta el ID de la sucursal" });
  }
  try {
    const [results] = await pool.promise().query(
      `
      SELECT 
        gustos.id AS gusto_id,
        productos.nombre AS producto_nombre,
        gustos.nombre AS gusto,
        sucursales.nombre AS sucursal,
        stock.cantidad AS stock
      FROM stock
      JOIN gustos ON stock.gusto_id = gustos.id
      JOIN productos ON gustos.producto_id = productos.id
      JOIN sucursales ON stock.sucursal_id = sucursales.id
      WHERE stock.sucursal_id = ? AND stock.cantidad > 0
    `,
      [sucursal_id]
    );
    res.json(results);
  } catch (error) {
    console.error("❌ Error al consultar productos disponibles:", error);
    res.status(500).json({ error: "Error al obtener productos disponibles" });
  }
});
// POST /productos/pagos
router.post("/pagos", async (req, res) => {
  const { sucursal_id, metodo_pago, monto } = req.body;
  if (!sucursal_id || !metodo_pago || !monto) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  try {
    await pool
      .promise()
      .query(
        "INSERT INTO pagos (sucursal_id, metodo_pago, monto) VALUES (?, ?, ?)",
        [sucursal_id, metodo_pago, monto]
      );
    res.json({ mensaje: "Pago registrado ✅" });
  } catch (err) {
    console.error("❌ Error al registrar pago:", err);
    res.status(500).json({ error: "Error al registrar pago" });
  }
});

// GET /productos/pagos-por-sucursal
router.get("/pagos-por-sucursal", async (req, res) => {
  try {
    const [result] = await pool.promise().query(`
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        IFNULL(SUM(p.monto), 0) AS total_pagado
      FROM sucursales s
      LEFT JOIN pagos p ON p.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);
    res.json(result);
  } catch (err) {
    console.error("❌ Error al obtener pagos por sucursal:", err);
    res.status(500).json({ error: "Error al obtener pagos" });
  }
});
router.get("/resumen-pagos", async (req, res) => {
  try {
    const [facturadoPorSucursal] = await pool.promise().query(`
      SELECT 
        v.sucursal_id, 
        s.nombre AS sucursal,
        SUM(v.cantidad * p.precio) AS total_facturado
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY v.sucursal_id, s.nombre
    `);

    const [pagosPorSucursal] = await pool.promise().query(`
      SELECT 
        sucursal_id,
        SUM(monto) AS total_pagado
      FROM pagos
      GROUP BY sucursal_id
    `);

    // Lista de sucursales unificada
    const todasLasSucursales = new Set([
      ...facturadoPorSucursal.map((f) => f.sucursal_id),
      ...pagosPorSucursal.map((p) => p.sucursal_id),
    ]);

    const resumen = Array.from(todasLasSucursales).map((id) => {
      const f = facturadoPorSucursal.find((x) => x.sucursal_id === id) || {};
      const p = pagosPorSucursal.find((x) => x.sucursal_id === id) || {};
      return {
        sucursal_id: id,
        sucursal: f.sucursal || p.sucursal || "Desconocida",
        total_facturado: f.total_facturado || 0,
        total_pagado: p.total_pagado || 0,
      };
    });

    res.json(resumen);
  } catch (error) {
    console.error("❌ Error al obtener resumen financiero:", error);
    res.status(500).json({ error: "Error al obtener resumen financiero" });
  }
});


router.post("/registrar-pago", async (req, res) => {
  const { sucursal_id, metodo, monto } = req.body;
  console.log("📥 Pago recibido:", req.body);

  if (!sucursal_id || !metodo || !monto) {
    return res.status(400).json({ error: "Faltan datos del pago" });
  }

  try {
    await pool
      .promise()
      .query(
        "INSERT INTO pagos (sucursal_id, metodo, monto, fecha) VALUES (?, ?, ?, NOW())",
        [sucursal_id, metodo, monto]
      );
    res.json({ mensaje: "✅ Pago registrado" });
  } catch (error) {
    console.error("❌ Error al registrar pago:", error);
    res.status(500).json({ error: "Error al registrar el pago" });
  }
});
router.get("/historial-pagos", async (req, res) => {
  const { sucursal_id, fecha_inicio, fecha_fin } = req.query;

  try {
    let query = `
      SELECT 
        p.id,
        s.nombre AS sucursal,
        p.metodo,
        p.monto,
        p.fecha
      FROM pagos p
      JOIN sucursales s ON p.sucursal_id = s.id
      WHERE 1 = 1
    `;

    const params = [];

    if (sucursal_id) {
      query += " AND p.sucursal_id = ?";
      params.push(sucursal_id);
    }

    if (fecha_inicio && fecha_fin) {
      query += " AND DATE(p.fecha) BETWEEN ? AND ?";
      params.push(fecha_inicio, fecha_fin);
    } else if (fecha_inicio) {
      query += " AND DATE(p.fecha) >= ?";
      params.push(fecha_inicio);
    } else if (fecha_fin) {
      query += " AND DATE(p.fecha) <= ?";
      params.push(fecha_fin);
    }

    query += " ORDER BY p.fecha DESC";

    const [results] = await pool.promise().query(query, params);
    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener historial de pagos:", error);
    res.status(500).json({ error: "Error al obtener historial de pagos" });
  }
});



/** ==========================
 * Código de Barras
 * ========================== */

// Buscar producto por código de barras
router.get("/buscar-por-codigo/:codigo", async (req, res) => {
  const { codigo } = req.params;
  try {
    const [result] = await pool.promise().query(
      `SELECT 
        p.id AS producto_id,
        p.nombre AS producto_nombre,
        p.codigo_barra,
        p.precio,
        g.id AS gusto_id,
        g.nombre AS gusto
      FROM productos p
      JOIN gustos g ON g.producto_id = p.id
      WHERE p.codigo_barra = ?
      LIMIT 1`,
      [codigo]
    );

    if (result.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    res.json(result[0]);
  } catch (error) {
    console.error("❌ Error al buscar producto por código:", error);
    res.status(500).json({ error: "Error al buscar producto por código" });
  }
});

// Registrar venta escaneando código
router.post("/vender-por-codigo", async (req, res) => {
  const { codigo_barra, sucursal_id, cantidad } = req.body;

  if (!codigo_barra || !sucursal_id || !cantidad) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    const [[producto]] = await pool.promise().query(
      `SELECT g.id AS gusto_id 
       FROM productos p 
       JOIN gustos g ON g.producto_id = p.id 
       WHERE p.codigo_barra = ? 
       LIMIT 1`,
      [codigo_barra]
    );

    if (!producto) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const gusto_id = producto.gusto_id;

    const [[stock]] = await pool.promise().query(
      `SELECT cantidad FROM stock WHERE gusto_id = ? AND sucursal_id = ?`,
      [gusto_id, sucursal_id]
    );

    if (!stock || stock.cantidad < cantidad) {
      return res
        .status(400)
        .json({ error: "Stock insuficiente o producto no disponible" });
    }

    await pool.promise().query(
      `UPDATE stock SET cantidad = cantidad - ? WHERE gusto_id = ? AND sucursal_id = ?`,
      [cantidad, gusto_id, sucursal_id]
    );

    await pool.promise().query(
      `INSERT INTO ventas (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)`,
      [gusto_id, sucursal_id, cantidad]
    );

    res.json({ mensaje: "Venta registrada por código ✅" });
  } catch (error) {
    console.error("❌ Error al registrar venta por código:", error);
    res.status(500).json({ error: "Error al registrar venta" });
  }
});

// Registrar reposición escaneando código
router.post("/reposicion-por-codigo", async (req, res) => {
  const { codigo_barra, sucursal_id, cantidad } = req.body;

  if (!codigo_barra || !sucursal_id || !cantidad) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    const [[producto]] = await pool.promise().query(
      `SELECT g.id AS gusto_id 
       FROM productos p 
       JOIN gustos g ON g.producto_id = p.id 
       WHERE p.codigo_barra = ? 
       LIMIT 1`,
      [codigo_barra]
    );

    if (!producto) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    const gusto_id = producto.gusto_id;

    const [[stock]] = await pool.promise().query(
      `SELECT * FROM stock WHERE gusto_id = ? AND sucursal_id = ?`,
      [gusto_id, sucursal_id]
    );

    if (!stock) {
      // Si no hay stock, insertar
      await pool.promise().query(
        `INSERT INTO stock (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)`,
        [gusto_id, sucursal_id, cantidad]
      );
    } else {
      await pool.promise().query(
        `UPDATE stock SET cantidad = cantidad + ? WHERE gusto_id = ? AND sucursal_id = ?`,
        [cantidad, gusto_id, sucursal_id]
      );
    }

    await pool.promise().query(
      `INSERT INTO reposiciones (gusto_id, sucursal_id, cantidad_repuesta, fecha) VALUES (?, ?, ?, NOW())`,
      [gusto_id, sucursal_id, cantidad]
    );

    res.json({ mensaje: "Reposición registrada por código ✅" });
  } catch (error) {
    console.error("❌ Error al registrar reposición por código:", error);
    res.status(500).json({ error: "Error al registrar reposición" });
  }
});

module.exports = router;

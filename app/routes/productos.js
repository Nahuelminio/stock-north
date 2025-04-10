const express = require("express");
const router = express.Router();
const pool = require("../db");
const multer = require("multer");
const xlsx = require("xlsx");
const fs = require("fs");

const upload = multer({ dest: "uploads/" });

/* ========= API JSON ========= */

// 🧾 Traer productos con gusto, sucursal y stock
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `SELECT 
          p.id AS producto_id,
          p.nombre AS producto_nombre,
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

// 🆕 Agregar producto + gusto + stock
router.post("/agregar-producto", async (req, res) => {
  const { nombre, gusto, sucursal_id, stock } = req.body;

  if (!nombre || !gusto || !sucursal_id || stock === undefined) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    const [productoResult] = await pool
      .promise()
      .query("SELECT id FROM productos WHERE nombre = ?", [nombre]);

    let producto_id;
    if (productoResult.length > 0) {
      producto_id = productoResult[0].id;
    } else {
      const [insert] = await pool
        .promise()
        .query("INSERT INTO productos (nombre) VALUES (?)", [nombre]);
      producto_id = insert.insertId;
    }

    const [gustoInsert] = await pool
      .promise()
      .query("INSERT INTO gustos (producto_id, nombre) VALUES (?, ?)", [
        producto_id,
        gusto,
      ]);
    const gusto_id = gustoInsert.insertId;

    await pool
      .promise()
      .query(
        "INSERT INTO stock (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)",
        [gusto_id, sucursal_id, stock]
      );

    res.status(200).json({ mensaje: "Producto agregado correctamente" });
  } catch (error) {
    console.error("❌ Error al agregar producto:", error);
    res.status(500).json({ error: "No se pudo agregar producto" });
  }
});

// 🗑️ Eliminar gusto
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

// 🛒 Registrar venta
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

// 📈 Dashboard
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

// 📊 Ventas por sucursal
router.get("/ventas-por-sucursal", async (req, res) => {
  try {
    const [ventas] = await pool.promise().query(`
      SELECT s.nombre AS sucursal, SUM(v.cantidad) AS total_ventas
      FROM ventas v
      JOIN sucursales s ON v.sucursal_id = s.id
      GROUP BY v.sucursal_id
    `);
    res.json(ventas);
  } catch (err) {
    console.error("❌ Error al obtener ventas por sucursal:", err);
    res.status(500).json({ error: "Error al obtener ventas" });
  }
});

// 📥 Importar desde Excel
router.post("/importar-excel", upload.single("archivo"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);

    for (const row of data) {
      const { nombre, gusto, sucursal, stock } = row;

      if (!nombre || !gusto || !sucursal || stock === undefined) continue;

      const [[producto]] = await pool
        .promise()
        .query("SELECT id FROM productos WHERE nombre = ?", [nombre]);

      const productoId =
        producto?.id ||
        (await pool
          .promise()
          .query("INSERT INTO productos (nombre) VALUES (?)", [nombre])
          .then(([r]) => r.insertId));

      const [[suc]] = await pool
        .promise()
        .query("SELECT id FROM sucursales WHERE nombre = ?", [sucursal]);

      const sucursalId =
        suc?.id ||
        (await pool
          .promise()
          .query("INSERT INTO sucursales (nombre) VALUES (?)", [sucursal])
          .then(([r]) => r.insertId));

      const [gustoRes] = await pool
        .promise()
        .query("INSERT INTO gustos (producto_id, nombre) VALUES (?, ?)", [
          productoId,
          gusto,
        ]);
      const gustoId = gustoRes.insertId;

      await pool
        .promise()
        .query(
          "INSERT INTO stock (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)",
          [gustoId, sucursalId, stock]
        );
    }

    fs.unlinkSync(filePath);
    res.json({ mensaje: "Importación completada" });
  } catch (error) {
    console.error("❌ Error al importar Excel:", error);
    res.status(500).json({ error: "Error al importar productos" });
  }
});

// 📤 Exportar a Excel
router.get("/exportar-excel", async (req, res) => {
  try {
    const [rows] = await pool.promise().query(`
      SELECT p.nombre AS producto, g.nombre AS gusto, s.nombre AS sucursal, st.cantidad AS stock
      FROM productos p
      JOIN gustos g ON g.producto_id = p.id
      JOIN stock st ON st.gusto_id = g.id
      JOIN sucursales s ON st.sucursal_id = s.id
    `);

    const worksheet = xlsx.utils.json_to_sheet(rows);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Productos");

    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Disposition", "attachment; filename=productos.xlsx");
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(buffer);
  } catch (error) {
    console.error("❌ Error al exportar Excel:", error);
    res.status(500).json({ error: "Error al exportar productos" });
  }
});
// ✅ Obtener todas las sucursales
router.get("/sucursales", async (req, res) => {
  try {
    const [results] = await pool.promise().query("SELECT * FROM sucursales");
    res.json(results);
  } catch (err) {
    console.error("❌ Error al obtener sucursales:", err);
    res.status(500).json({ error: "Error al obtener sucursales" });
  }
});
// ✅ Productos disponibles con stock > 0 por sucursal
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

// 📝 Editar gusto y stock
router.post("/editar/:gusto_id", async (req, res) => {
  console.log(req.body);
  const { stock, sucursal_id, nuevoGusto } = req.body;
  const { gusto_id } = req.params;

  try {
    // Actualizar nombre del gusto si es necesari
    if (nuevoGusto) {
      await pool
        .promise()
        .query("UPDATE gustos SET nombre = ? WHERE id = ?", [
          nuevoGusto,
          gusto_id,
        ]);
    }

    // Actualizar stock
    await pool
      .promise()
      .query(
        "UPDATE stock SET cantidad = ? WHERE gusto_id = ? AND sucursal_id = ?",
        [stock, gusto_id, sucursal_id]
      );

    res.json({ mensaje: "Producto actualizado correctamente" });
  } catch (error) {
    console.error("❌ Error al editar producto:", error);
    res.status(500).json({ error: "Error al editar producto" });
  }
});
// ✅ Crear una nueva sucursal
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
// 📄 Historial de ventas con detalle
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
// 📄 Historial de reposiciones
// 📄 Historial de reposiciones
router.get("/historial-reposiciones", async (req, res) => {
  try {
    const [results] = await pool.promise().query(`
      SELECT 
        r.fecha,
        s.nombre AS sucursal,
        p.nombre AS producto,
        g.nombre AS gusto,
        r.cantidad_repuesta AS cantidad
      FROM reposiciones r
      JOIN gustos g ON r.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON r.sucursal_id = s.id
      ORDER BY r.fecha DESC
    `);

    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener historial de reposiciones:", error);
    res.status(500).json({ error: "Error al obtener historial de reposiciones" });
  }
});





module.exports = router;

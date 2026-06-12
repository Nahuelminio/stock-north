const express = require("express");
const router = express.Router();
const pool = require("../db");
const multer = require("multer");
const xlsx = require("xlsx");
const fs = require("fs");
const authenticate = require("../middlewares/authenticate");

const upload = multer({ dest: "uploads/" });

// 📥 Importar productos desde Excel — solo admin
router.post("/importar-excel", authenticate, upload.single("archivo"), async (req, res) => {
  if (req.user?.rol !== "admin") {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(403).json({ error: "Acceso denegado" });
  }
  try {
    const archivo = req.file;
    if (!archivo) {
      return res.status(400).json({ error: "No se recibió archivo" });
    }

    const workbook = xlsx.readFile(archivo.path);
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const insertados = [];
    const errores = [];

    for (const fila of data) {
      const {
        nombre = "",
        gusto = "",
        sucursal_id = "",
        stock = 0,
        precio = 0,
        codigo_barra = null,
      } = fila;

      if (!nombre || !gusto || !sucursal_id || stock === undefined) {
        errores.push({ fila });
        continue;
      }

      try {
        const [[producto]] = await pool
          .promise()
          .query("SELECT id FROM productos WHERE nombre = ?", [nombre]);

        let producto_id = producto?.id;

        if (!producto_id) {
          const [result] = await pool
            .promise()
            .query("INSERT INTO productos (nombre, precio) VALUES (?, ?)", [
              nombre,
              precio,
            ]);
          producto_id = result.insertId;
        } else {
          await pool
            .promise()
            .query("UPDATE productos SET precio = ? WHERE id = ?", [
              precio,
              producto_id,
            ]);
        }

        // Buscar gusto existente para evitar duplicados
        const [[gustoExistente]] = await pool
          .promise()
          .query(
            "SELECT id FROM gustos WHERE producto_id = ? AND nombre = ? LIMIT 1",
            [producto_id, gusto]
          );

        let gusto_id;
        if (gustoExistente) {
          gusto_id = gustoExistente.id;
          // Actualizar código de barras si se proporcionó
          if (codigo_barra) {
            await pool.promise().query(
              "UPDATE gustos SET codigo_barra = ? WHERE id = ?",
              [codigo_barra, gusto_id]
            );
          }
        } else {
          const [gustoInsert] = await pool
            .promise()
            .query(
              "INSERT INTO gustos (producto_id, nombre, codigo_barra) VALUES (?, ?, ?)",
              [producto_id, gusto, codigo_barra]
            );
          gusto_id = gustoInsert.insertId;
        }

        // Upsert de stock: si ya existe suma, si no crea
        await pool.promise().query(
          `INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad), precio = VALUES(precio)`,
          [gusto_id, sucursal_id, stock, precio]
        );

        insertados.push(fila);
      } catch (err) {
        errores.push({ fila, error: err.message });
      }
    }

    fs.unlinkSync(archivo.path); // Borra el archivo temporal

    res.json({ insertados, errores });
  } catch (error) {
    console.error("❌ Error al importar productos:", error);
    res.status(500).json({ error: "Error al importar productos" });
  }
});

// 📤 Exportar productos a Excel — solo admin
router.get("/exportar-excel", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") {
    return res.status(403).json({ error: "Acceso denegado" });
  }
  try {
    const [productos] = await pool.promise().query(`
      SELECT 
        p.nombre, 
        g.nombre AS gusto, 
        s.nombre AS sucursal, 
        st.cantidad AS stock, 
        p.precio, 
        g.codigo_barra, 
        s.id AS sucursal_id 
      FROM productos p
      JOIN gustos g ON g.producto_id = p.id
      JOIN stock st ON st.gusto_id = g.id
      JOIN sucursales s ON s.id = st.sucursal_id
    `);

    const worksheet = xlsx.utils.json_to_sheet(productos);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Productos");

    const buffer = xlsx.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });

    res.setHeader("Content-Disposition", "attachment; filename=productos.xlsx");
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(buffer);
  } catch (error) {
    console.error("❌ Error al exportar productos:", error);
    res.status(500).json({ error: "Error al exportar productos" });
  }
});

module.exports = router;

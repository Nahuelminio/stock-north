const express = require("express");
const router = express.Router();
const pool = require("../db");


// Obtener todos los productos
router.get("/", async (req, res) => {
  try {
    const [rows] = await pool.promise().query(
      `SELECT 
        p.id AS producto_id,
        p.nombre AS producto_nombre,
        p.precio,
        g.id AS gusto_id,
        g.nombre AS gusto,
        g.codigo_barra,
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

// Agregar un nuevo producto
router.post("/agregar", async (req, res) => {
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
        .query("UPDATE productos SET precio = ? WHERE id = ?", [
          precio,
          producto_id,
        ]);
    } else {
      const [insert] = await pool
        .promise()
        .query("INSERT INTO productos (nombre, precio) VALUES (?, ?)", [
          nombre,
          precio,
        ]);
      producto_id = insert.insertId;
    }

    const [gustoInsert] = await pool
      .promise()
      .query(
        "INSERT INTO gustos (producto_id, nombre, codigo_barra) VALUES (?, ?, ?)",
        [producto_id, gusto, codigo_barra || null]
      );

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

// Editar producto (gusto + precio + stock)
router.post("/editar/:gusto_id", async (req, res) => {
  const { stock, sucursal_id, nuevoGusto, precio, producto_id, codigo_barra } =
    req.body;
  const { gusto_id } = req.params;

  try {
    if (nuevoGusto || codigo_barra) {
      await pool
        .promise()
        .query("UPDATE gustos SET nombre = ?, codigo_barra = ? WHERE id = ?", [
          nuevoGusto,
          codigo_barra || null,
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
        .query("UPDATE productos SET precio = ? WHERE id = ?", [
          precio,
          producto_id,
        ]);
    }

    res.json({ mensaje: "Producto actualizado correctamente" });
  } catch (error) {
    console.error("❌ Error al editar producto:", error);
    res.status(500).json({ error: "Error al editar producto" });
  }
});
// Obtener productos disponibles por sucursal
router.get("/disponibles", async (req, res) => {
  const { sucursal_id } = req.query;

  if (!sucursal_id) {
    return res.status(400).json({ error: "Falta el parámetro sucursal_id" });
  }

  try {
    const [results] = await pool.promise().query(
      `
      SELECT 
        p.id AS producto_id,
        p.nombre AS producto_nombre,
        g.id AS gusto_id,
        g.nombre AS gusto,
        g.codigo_barra,
        st.cantidad AS stock
      FROM productos p
      JOIN gustos g ON g.producto_id = p.id
      JOIN stock st ON st.gusto_id = g.id
      WHERE st.sucursal_id = ?
      `,
      [sucursal_id]
    );
    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener productos disponibles:", error);
    res.status(500).json({ error: "Error al obtener productos disponibles" });
  }
});


module.exports = router;

const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");
const authorizeAdmin = require("../middlewares/authorizeAdmin");

// 🔵 Obtener todos los productos
router.get("/", authenticate, async (req, res) => {
  try {
    const { rol, sucursalId } = req.user;

    let query = `
      SELECT 
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
      JOIN sucursales s ON s.id = st.sucursal_id
    `;

    const params = [];
    if (rol !== "admin") {
      query += " WHERE s.id = ?";
      params.push(sucursalId);
    }

    const [rows] = await pool.promise().query(query, params);
    res.json(rows);
  } catch (error) {
    console.error("❌ Error al obtener productos:", error);
    res.status(500).json({ error: "Error al obtener productos" });
  }
});

// 🔵 Verificar código duplicado por sucursal
router.get("/verificar-codigo", authenticate, async (req, res) => {
  const { codigo_barra, sucursal_id, gusto_id } = req.query;

  try {
    const [result] = await pool.promise().query(
      `SELECT g.id FROM gustos g
       JOIN stock st ON st.gusto_id = g.id
       WHERE g.codigo_barra = ? AND st.sucursal_id = ?
       ${gusto_id ? "AND g.id != ?" : ""}`,
      gusto_id
        ? [codigo_barra, sucursal_id, gusto_id]
        : [codigo_barra, sucursal_id]
    );

    res.json({ existe: result.length > 0 });
  } catch (error) {
    console.error("❌ Error al verificar código:", error);
    res.status(500).json({ error: "Error al verificar código" });
  }
});

// 🔵 Agregar producto (solo admin)
router.post("/agregar", authenticate, authorizeAdmin, async (req, res) => {
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
    if (codigo_barra) {
      const [existe] = await pool.promise().query(
        `SELECT g.id FROM gustos g
         JOIN stock st ON st.gusto_id = g.id
         WHERE g.codigo_barra = ? AND st.sucursal_id = ?`,
        [codigo_barra, sucursal_id]
      );
      if (existe.length > 0) {
        return res
          .status(400)
          .json({ error: "Este código de barras ya existe en esta sucursal" });
      }
    }

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

// 🔵 Editar producto (solo admin)
router.post(
  "/editar/:gusto_id",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const {
      stock,
      sucursal_id,
      nuevoGusto,
      precio,
      producto_id,
      codigo_barra,
    } = req.body;
    const { gusto_id } = req.params;

    try {
      if (codigo_barra) {
        const [existe] = await pool.promise().query(
          `SELECT g.id FROM gustos g
         JOIN stock st ON st.gusto_id = g.id
         WHERE g.codigo_barra = ? AND st.sucursal_id = ? AND g.id != ?`,
          [codigo_barra, sucursal_id, gusto_id]
        );
        if (existe.length > 0) {
          return res.status(400).json({
            error: "Este código de barras ya existe en esta sucursal",
          });
        }
      }

      if (nuevoGusto || codigo_barra) {
        await pool
          .promise()
          .query(
            "UPDATE gustos SET nombre = ?, codigo_barra = ? WHERE id = ?",
            [nuevoGusto, codigo_barra || null, gusto_id]
          );
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
  }
);

// 🔵 Ver productos disponibles por sucursal
router.get("/disponibles", authenticate, async (req, res) => {
  const { sucursal_id } = req.query;

  if (!sucursal_id) {
    return res.status(400).json({ error: "Falta el parámetro sucursal_id" });
  }

  try {
    const [results] = await pool.promise().query(
      `SELECT 
        p.id AS producto_id,
        p.nombre AS producto_nombre,
        g.id AS gusto_id,
        g.nombre AS gusto,
        g.codigo_barra,
        st.cantidad AS stock
      FROM productos p
      JOIN gustos g ON g.producto_id = p.id
      JOIN stock st ON st.gusto_id = g.id
      WHERE st.sucursal_id = ?`,
      [sucursal_id]
    );
    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener productos disponibles:", error);
    res.status(500).json({ error: "Error al obtener productos disponibles" });
  }
});

// 🔵 Eliminar gusto (solo admin)
router.delete(
  "/eliminar-gusto/:gusto_id",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { gusto_id } = req.params;

    try {
      await pool
        .promise()
        .query("DELETE FROM stock WHERE gusto_id = ?", [gusto_id]);
      await pool.promise().query("DELETE FROM gustos WHERE id = ?", [gusto_id]);

      res.json({ mensaje: "Gusto eliminado correctamente" });
    } catch (error) {
      console.error("❌ Error al eliminar gusto:", error);
      res.status(500).json({ error: "No se pudo eliminar el gusto" });
    }
  }
);

// SOLO PARA PROBAR — no usar en producción
router.get("/valor-stock-por-sucursal", authenticate, async (req, res) => {
  const { rol, sucursalId } = req.user;

  try {
    let query = `
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(st.cantidad * p.precio) AS valor_total
      FROM stock st
      JOIN gustos g ON st.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON st.sucursal_id = s.id
    `;
    const params = [];

    if (rol !== "admin") {
      query += " WHERE s.id = ?";
      params.push(sucursalId);
    }

    query += " GROUP BY s.id, s.nombre";

    const [results] = await pool.promise().query(query, params);
    res.json(results);
  } catch (error) {
    console.error("❌ Error al calcular valor stock:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

// 🔵 Buscar producto por código de barra
router.get(
  "/buscar-por-codigo/:codigo_barra",
  authenticate,
  async (req, res) => {
    const { codigo_barra } = req.params;

    try {
      const [result] = await pool.promise().query(
        `SELECT 
        p.id AS producto_id,
        p.nombre AS producto,
        g.id AS gusto_id,
        g.nombre AS gusto,
        g.codigo_barra,
        p.precio
      FROM gustos g
      JOIN productos p ON g.producto_id = p.id
      WHERE g.codigo_barra = ?
      LIMIT 1`,
        [codigo_barra]
      );

      if (result.length === 0) {
        return res.status(404).json({ error: "Producto no encontrado" });
      }

      res.json(result[0]);
    } catch (error) {
      console.error("❌ Error al buscar por código de barra:", error);
      res.status(500).json({ error: "Error al buscar producto" });
    }
  }
);

module.exports = router;

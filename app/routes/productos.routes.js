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
        g.id AS gusto_id,
        g.nombre AS gusto,
        g.codigo_barra,
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        st.cantidad AS stock,
        st.precio AS precio
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
    } else {
      const [insert] = await pool
        .promise()
        .query("INSERT INTO productos (nombre) VALUES (?)", [nombre]);
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
        "INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio) VALUES (?, ?, ?, ?)",
        [gustoInsert.insertId, sucursal_id, stock, precio]
      );

    // 🔁 Actualizar código para todos los gustos con mismo producto + gusto
    if (codigo_barra) {
      await pool.promise().query(
        "UPDATE gustos SET codigo_barra = ? WHERE producto_id = ? AND nombre = ?",
        [codigo_barra, producto_id, gusto]
      );
    }

    res.status(200).json({ mensaje: "Producto agregado correctamente" });
  } catch (error) {
    console.error("❌ Error al agregar producto:", error);
    res.status(500).json({ error: "No se pudo agregar producto" });
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

// 🔵 Editar producto (solo admin)
router.post(
  "/editar/:gusto_id",
  authenticate,
  authorizeAdmin,
  async (req, res) => {
    const { stock, sucursal_id, nuevoGusto, precio, codigo_barra } = req.body;
    const { gusto_id } = req.params;

    console.log("📥 Body recibido en edición:", req.body);
    console.log("🆔 gusto_id recibido:", gusto_id);

    // Validación básica
    if (
      stock === undefined ||
      precio === undefined ||
      !sucursal_id ||
      !nuevoGusto
    ) {
      return res.status(400).json({
        error:
          "Faltan datos obligatorios (stock, precio, sucursal_id, nuevoGusto)",
      });
    }

    try {
      // Verificación de código de barras
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

      // Actualización del gusto
      await pool
        .promise()
        .query("UPDATE gustos SET nombre = ?, codigo_barra = ? WHERE id = ?", [
          nuevoGusto,
          codigo_barra || null,
          gusto_id,
        ]);

      // Actualización del stock
      await pool
        .promise()
        .query(
          "UPDATE stock SET cantidad = ?, precio = ? WHERE gusto_id = ? AND sucursal_id = ?",
          [stock, precio, gusto_id, sucursal_id]
        );

      // Sincronización del código de barras en gustos iguales del mismo producto
      if (codigo_barra) {
        const [[gustoInfo]] = await pool
          .promise()
          .query("SELECT producto_id, nombre FROM gustos WHERE id = ?", [
            gusto_id,
          ]);

        if (gustoInfo) {
          await pool
            .promise()
            .query(
              "UPDATE gustos SET codigo_barra = ? WHERE producto_id = ? AND nombre = ?",
              [codigo_barra, gustoInfo.producto_id, gustoInfo.nombre]
            );
        }
      }

      res.json({ mensaje: "Producto actualizado correctamente ✅" });
    } catch (error) {
      console.error("❌ Error al editar producto:", error.message, error.stack);
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
        st.cantidad AS stock,
        st.precio AS precio
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

// 🔵 Valor del stock por sucursal (usa precio de stock)
router.get("/valor-stock-por-sucursal", authenticate, async (req, res) => {
  const { rol, sucursalId } = req.user;

  try {
    let query = `
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(st.cantidad * st.precio) AS valor_total
      FROM stock st
      JOIN gustos g ON st.gusto_id = g.id
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

// 🔵 Ranking de productos más vendidos (usa precio de stock)
router.get("/ranking-productos", authenticate, async (req, res) => {
  const { rol } = req.user;
  const { mes, anio } = req.query;

  if (rol !== "admin") {
    return res
      .status(403)
      .json({ error: "Acceso denegado: sólo administradores" });
  }

  try {
    let query = `
      SELECT 
        p.nombre AS producto,
        g.nombre AS gusto,
        SUM(v.cantidad) AS total_vendido,
        SUM(v.cantidad * st.precio) AS total_facturado
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN stock st ON st.gusto_id = g.id AND st.sucursal_id = v.sucursal_id
    `;

    const params = [];

    if (mes && anio) {
      query += " WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?";
      params.push(mes, anio);
    }

    query += `
      GROUP BY g.id
      ORDER BY total_vendido DESC
      LIMIT 10
    `;

    const [result] = await pool.promise().query(query, params);

    res.json(result);
  } catch (error) {
    console.error("❌ Error al obtener ranking de productos:", error);
    res.status(500).json({ error: "Error al obtener ranking de productos" });
  }
});
// 🔵 Verificar si el código de barras ya existe en una sucursal
router.get("/verificar-codigo/:codigo", authenticate, async (req, res) => {
  const { codigo } = req.params;
  const { rol, sucursalId } = req.user;

  try {
    const query = `
      SELECT g.id FROM gustos g
      JOIN stock st ON st.gusto_id = g.id
      WHERE g.codigo_barra = ? AND st.sucursal_id = ?
    `;
    const [rows] = await pool
      .promise()
      .query(query, [codigo, sucursalId]);

    res.json({ existe: rows.length > 0 });
  } catch (error) {
    console.error("❌ Error al verificar código:", error);
    res.status(500).json({ error: "Error al verificar el código de barras" });
  }
});
// 🔵 Verificar si el código de barras ya existe en una sucursal (por query string)
router.get("/verificar-codigo", authenticate, async (req, res) => {
  const { codigo_barra, sucursal_id, gusto_id } = req.query;

  if (!codigo_barra || !sucursal_id) {
    return res.status(400).json({ error: "Faltan parámetros requeridos" });
  }

  try {
    console.log("🔎 Verificando código:", {
      codigo_barra,
      sucursal_id,
      gusto_id,
    });

    let query = `
      SELECT g.id FROM gustos g
      JOIN stock st ON st.gusto_id = g.id
      WHERE g.codigo_barra = ? AND st.sucursal_id = ?
    `;
    const params = [codigo_barra, sucursal_id];

    if (gusto_id) {
      query += " AND g.id != ?";
      params.push(gusto_id);
    }

    const [rows] = await pool.promise().query(query, params);

    res.json({ existe: rows.length > 0 });
  } catch (error) {
    console.error("❌ Error al verificar código en backend:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});



module.exports = router;

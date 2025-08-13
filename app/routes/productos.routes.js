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

// 🔵 Editar producto (parcial/flexible) — código único por sucursal
router.post("/editar/:gusto_id", authenticate, authorizeAdmin, async (req, res) => {
  const { gusto_id } = req.params;

  // ✅ Normalización de campos
  const sucursal_id   = req.body.sucursal_id ?? req.body.sucursalId ?? req.body.sucursal ?? null;
  const nuevoGustoRaw = req.body.nuevoGusto ?? req.body.gusto ?? req.body.nombre ?? null;
  const stockRaw      = req.body.stock;
  const precioRaw     = req.body.precio;
  const codigo_barra  = (req.body.codigo_barra ?? req.body.codigoBarra ?? req.body.barcode ?? undefined);

  // ✅ Coerciones (solo si vinieron)
  const stock  = (stockRaw  !== undefined ? Number(stockRaw)  : undefined);
  const precio = (precioRaw !== undefined ? Number(precioRaw) : undefined);
  const nuevoGusto = (nuevoGustoRaw !== null ? String(nuevoGustoRaw).trim() : null);

  console.log("📥 Body:", req.body);
  console.log("✅ Normalizado:", { gusto_id, sucursal_id, nuevoGusto, stock, precio, codigo_barra });

  // ¿Qué se quiere actualizar?
  const quiereActualizarGusto = (nuevoGusto !== null) || (codigo_barra !== undefined);
  const quiereActualizarStock = (stock !== undefined) || (precio !== undefined);

  if (!quiereActualizarGusto && !quiereActualizarStock) {
    return res.status(400).json({ error: "No hay campos para actualizar." });
  }

  // Si se toca stock/precio, necesitamos sucursal_id
  if (quiereActualizarStock && !sucursal_id) {
    return res.status(400).json({ error: "Para actualizar stock o precio se requiere sucursal_id." });
  }

  // Validaciones básicas
  if (precio !== undefined && !Number.isFinite(precio)) {
    return res.status(400).json({ error: "Precio inválido." });
  }
  if (stock !== undefined && !Number.isFinite(stock)) {
    return res.status(400).json({ error: "Stock inválido." });
  }
  if (nuevoGusto !== null && nuevoGusto === "") {
    return res.status(400).json({ error: "El gusto no puede estar vacío." });
  }

  try {
    // 🔎 Validar código de barras SOLO por sucursal (no global)
    if (codigo_barra !== undefined) {
      if (!sucursal_id) {
        return res.status(400).json({ error: "Para actualizar el código de barras se requiere sucursal_id." });
      }
      const [dupeSucursal] = await pool.promise().query(
        `SELECT g.id
           FROM gustos g
           JOIN stock st ON st.gusto_id = g.id
          WHERE g.codigo_barra = ?
            AND st.sucursal_id = ?
            AND g.id != ?`,
        [codigo_barra, sucursal_id, gusto_id]
      );
      if (codigo_barra && dupeSucursal.length > 0) {
        return res.status(400).json({ error: "Este código de barras ya existe en esta sucursal." });
      }
    }

    // 🧩 1) Actualizar tabla GUSTOS si corresponde
    if (quiereActualizarGusto) {
      const sets = [];
      const params = [];
      if (nuevoGusto !== null)        { sets.push("nombre = ?");       params.push(nuevoGusto); }
      if (codigo_barra !== undefined) { sets.push("codigo_barra = ?"); params.push(codigo_barra || null); }

      if (sets.length) {
        params.push(gusto_id);
        await pool.promise().query(`UPDATE gustos SET ${sets.join(", ")} WHERE id = ?`, params);
      }
    }

    // 🧩 2) Actualizar tabla STOCK si corresponde
    if (quiereActualizarStock) {
      const sets = [];
      const params = [];
      if (stock  !== undefined) { sets.push("cantidad = ?"); params.push(stock); }
      if (precio !== undefined) { sets.push("precio = ?");   params.push(precio); }
      params.push(gusto_id, sucursal_id);

      const [upd] = await pool
        .promise()
        .query(`UPDATE stock SET ${sets.join(", ")} WHERE gusto_id = ? AND sucursal_id = ?`, params);

      if (upd.affectedRows === 0) {
        // Si no existe la fila de stock para ese gusto en esa sucursal, podés crearla automáticamente:
        // await pool.promise().query(
        //   "INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio) VALUES (?, ?, ?, ?)",
        //   [gusto_id, sucursal_id, stock ?? 0, precio ?? 0]
        // );
        return res.status(404).json({ error: "No existe stock para ese gusto en esa sucursal." });
      }
    }

    // (Opcional) devolver el registro actualizado
    const [result] = await pool.promise().query(
      `SELECT 
         p.id AS producto_id,
         p.nombre AS producto_nombre,
         g.id AS gusto_id,
         g.nombre AS gusto,
         g.codigo_barra,
         st.cantidad AS stock,
         st.precio AS precio,
         s.id AS sucursal_id,
         s.nombre AS sucursal
       FROM gustos g
       JOIN productos p ON g.producto_id = p.id
       JOIN stock st ON st.gusto_id = g.id
       JOIN sucursales s ON s.id = st.sucursal_id
      WHERE g.id = ? ${sucursal_id ? "AND s.id = ?" : ""} 
      LIMIT 1`,
      sucursal_id ? [gusto_id, sucursal_id] : [gusto_id]
    );

    res.json({ ok: true, mensaje: "Producto actualizado correctamente ✅", data: result?.[0] ?? null });
  } catch (error) {
    console.error("❌ Error al editar producto:", error.message, error.stack);
    res.status(500).json({ error: "Error al editar producto" });
  }
});




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
  if (rol !== "admin")
    return res
      .status(403)
      .json({ error: "Acceso denegado: sólo administradores" });

  try {
    let sql = `
      SELECT 
        p.nombre AS producto,
        g.nombre AS gusto,
        SUM(v.cantidad) AS total_vendido,
        SUM(v.cantidad * v.precio_unitario) AS total_facturado
      FROM ventas v
      JOIN gustos g ON v.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
    `;
    const params = [];
    if (mes && anio) {
      sql += " WHERE MONTH(v.fecha) = ? AND YEAR(v.fecha) = ?";
      params.push(mes, anio);
    }
    sql += `
      GROUP BY g.id
      ORDER BY total_vendido DESC
      LIMIT 10
    `;
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error ranking productos:", e);
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


// 🔵 Pods por sucursal (agrupado) — admite filtros q, sucursal_id, solo_con_stock
router.get("/pods-por-sucursal", authenticate, async (req, res) => {
  const { rol, sucursalId } = req.user;
  let { sucursal_id, q, solo_con_stock, agrupar = "modelo" } = req.query;

  const soloConStock = solo_con_stock === "0" ? false : true;

  const where = [];
  const params = [];

  if (rol !== "admin") {
    where.push("s.id = ?");
    params.push(Number(sucursalId));
  } else if (sucursal_id) {
    where.push("s.id = ?");
    params.push(Number(sucursal_id));
  }

  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    where.push("(p.nombre LIKE ? OR g.nombre LIKE ? OR g.codigo_barra LIKE ?)");
    params.push(like, like, like);
  }

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

  const groupByModelo = `
    SELECT
      s.id    AS sucursal_id,
      s.nombre AS sucursal,
      p.nombre AS pod,                 -- modelo
      SUM(st.cantidad) AS total
    FROM productos p
    JOIN gustos g     ON g.producto_id = p.id
    JOIN stock  st    ON st.gusto_id   = g.id
    JOIN sucursales s ON s.id          = st.sucursal_id
    ${whereSql}
    GROUP BY s.id, s.nombre, p.id, p.nombre
  `;

  const groupByGusto = `
    SELECT
      s.id    AS sucursal_id,
      s.nombre AS sucursal,
      CONCAT(p.nombre, ' - ', g.nombre) AS pod, -- modelo + gusto
      SUM(st.cantidad) AS total
    FROM productos p
    JOIN gustos g     ON g.producto_id = p.id
    JOIN stock  st    ON st.gusto_id   = g.id
    JOIN sucursales s ON s.id          = st.sucursal_id
    ${whereSql}
    GROUP BY s.id, s.nombre, g.id, p.nombre, g.nombre
  `;

  let sql = agrupar === "gusto" ? groupByGusto : groupByModelo;
  if (soloConStock) sql += ` HAVING SUM(st.cantidad) > 0`;
  sql += ` ORDER BY s.nombre, total DESC, pod`;

  try {
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error en /pods-por-sucursal:", e);
    res.status(500).json({ error: "Error al obtener pods por sucursal" });
  }
});


module.exports = router;

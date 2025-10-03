// routes/public.routes.js
const express = require("express");
const cors = require("cors");
const router = express.Router();
const pool = require("../db");

// CORS SOLO para endpoints públicos
const publicCors = cors({ origin: "*", credentials: false });

/**
 * GET /public/sucursales
 * Lista pública de sucursales: [{ id, nombre }]
 */
router.get("/public/sucursales", publicCors, async (_req, res) => {
  try {
    const [rows] = await pool
      .promise()
      .query("SELECT id, nombre FROM sucursales ORDER BY nombre ASC");
    res.json(rows);
  } catch (err) {
    console.error(
      "GET /public/sucursales error:",
      err.sqlMessage || err.message
    );
    res.status(500).json({ error: "No se pudieron traer las sucursales" });
  }
});

/**
 * GET /public/productos
 * Catálogo público por gusto. Parámetros opcionales:
 *   - sucursal_id: filtra stock/precio por esa sucursal
 *   - inStock=1  : devuelve solo con stock > 0
 */
router.get("/public/productos", publicCors, async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id
      ? Number(req.query.sucursal_id)
      : null;
    const onlyInStock = req.query.inStock === "1";

    const sql = `
      WITH agg AS (
        SELECT
          st.gusto_id,
          SUM(st.cantidad) AS stock_raw,
          MAX(st.precio)   AS precio_raw
        FROM stock st
        ${sucursalId ? "WHERE st.sucursal_id = ?" : ""}
        GROUP BY st.gusto_id
      )
      SELECT
        g.id AS id,
        CONCAT(
          TRIM(REPLACE(REPLACE(p.nombre, CHAR(9), ' '), '  ', ' ')),
          ' - ',
          TRIM(REPLACE(REPLACE(g.nombre, CHAR(9), ' '), '  ', ' '))
        ) AS nombre,
        CAST(agg.stock_raw  AS UNSIGNED)        AS stock,
        CAST(agg.precio_raw AS DECIMAL(10,2))   AS precio
      FROM gustos g
      JOIN productos p ON p.id = g.producto_id
      JOIN agg        ON agg.gusto_id = g.id
      ${onlyInStock ? "HAVING stock > 0" : ""}
      ORDER BY p.nombre ASC, g.nombre ASC
      LIMIT 500;
    `;

    const params = sucursalId ? [sucursalId] : [];
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(
      "GET /public/productos error:",
      err.sqlMessage || err.message
    );
    res.status(500).json({ error: "No se pudieron traer los productos" });
  }
});
/**
 * Helpers
 */
function cleanPhone(raw) {
  return String(raw || "").replace(/[^\d+]/g, "");
}
function toNullOrTrim(v) {
  const s = (v ?? "").toString().trim();
  return s ? s : null;
}

/**
 * POST /public/clientes
 * Guarda el lead del formulario de Comunidad North.
 * Body: { nombre, telefono, sucursal (nombre opcional), nota, acepta, source? }
 */
router.post("/public/clientes", publicCors, async (req, res) => {
  try {
    const { nombre, telefono, sucursal, nota, acepta, source } = req.body || {};

    // Validaciones básicas
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: "Nombre requerido" });
    }
    const tel = cleanPhone(telefono);
    if (!tel || tel.length < 8) {
      return res.status(400).json({ error: "WhatsApp inválido" });
    }
    if (!acepta) {
      return res.status(400).json({ error: "Se requiere consentimiento" });
    }

    // Resolver sucursal_id si te mandan el nombre
    let sucursalId = null;
    if (sucursal && String(sucursal).trim()) {
      const [suc] = await pool
        .promise()
        .query("SELECT id FROM sucursales WHERE nombre = ? LIMIT 1", [
          String(sucursal).trim(),
        ]);
      if (suc.length) sucursalId = suc[0].id;
    }

    const [result] = await pool.promise().query(
      `INSERT INTO clientes
       (nombre, telefono, sucursal_id, nota, acepta, estado, added_to_group, source)
       VALUES (?, ?, ?, ?, 1, 'nuevo', 0, ?)`,
      [String(nombre).trim(), tel, sucursalId, toNullOrTrim(nota), source || "web"]
    );

    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    console.error("POST /public/clientes error:", err.sqlMessage || err.message);
    res.status(500).json({ error: "No se pudo guardar el cliente" });
  }
});

/**
 * (Opcional) Middleware simple para "endpoints admin".
 * Si querés algo rápido: exigimos un API Key por header.
 * Reemplazá por tu auth real si ya tenés JWT/sesiones.
 */
const adminGuard = (req, res, next) => {
  const key = req.header("x-api-key");
  const expected = process.env.ADMIN_API_KEY; // definilo en tu .env del backend
  if (expected && key === expected) return next();
  // Si no configuraste clave, dejamos pasar (quitar en producción)
  if (!expected) return next();
  return res.status(401).json({ error: "No autorizado" });
};

/**
 * GET /admin/clientes
 * Filtros opcionales:
 *  - estado= nuevo|contactado|agregado|descartado
 *  - q= texto (busca en nombre, telefono, sucursal)
 *  - limit= N (default 500)
 */
router.get("/admin/clientes", adminGuard, async (req, res) => {
  try {
    const { estado, q } = req.query;
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const where = [];
    const args = [];

    if (estado) {
      where.push("c.estado = ?");
      args.push(estado);
    }
    if (q) {
      where.push("(c.nombre LIKE ? OR c.telefono LIKE ? OR s.nombre LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT
        c.id, c.nombre, c.telefono, c.nota, c.acepta,
        c.estado, c.added_to_group, c.source, c.created_at,
        c.sucursal_id, s.nombre AS sucursal
      FROM clientes c
      LEFT JOIN sucursales s ON s.id = c.sucursal_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY c.created_at DESC
      LIMIT ${limit};
    `;

    const [rows] = await pool.promise().query(sql, args);
    res.json(rows);
  } catch (err) {
    console.error("GET /admin/clientes error:", err.sqlMessage || err.message);
    res.status(500).json({ error: "No se pudieron traer los clientes" });
  }
});

/**
 * PATCH /admin/clientes/:id
 * Body (cualquiera de estos): { estado, added_to_group, sucursal_id }
 */
router.patch("/admin/clientes/:id", adminGuard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido" });

    const { estado, added_to_group, sucursal_id } = req.body || {};
    const sets = [];
    const args = [];

    if (estado) {
      sets.push("estado = ?");
      args.push(estado);
    }
    if (typeof added_to_group !== "undefined") {
      sets.push("added_to_group = ?");
      args.push(added_to_group ? 1 : 0);
    }
    if (typeof sucursal_id !== "undefined") {
      sets.push("sucursal_id = ?");
      args.push(sucursal_id || null);
    }

    if (!sets.length) {
      return res.status(400).json({ error: "Nada para actualizar" });
    }

    args.push(id);
    const sql = `UPDATE clientes SET ${sets.join(", ")} WHERE id = ?`;
    await pool.promise().query(sql, args);

    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /admin/clientes/:id error:", err.sqlMessage || err.message);
    res.status(500).json({ error: "No se pudo actualizar el cliente" });
  }
});

module.exports = router;

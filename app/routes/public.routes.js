// routes/public.routes.js
const express = require("express");
const cors = require("cors");
const router = express.Router();
const pool = require("../db");

// CORS SOLO para endpoints públicos
const publicCors = cors({ origin: "*", credentials: false });

/* =========================
   Helpers
========================= */
function cleanPhone(raw) {
  // Acepta dígitos y '+'
  return String(raw || "").replace(/[^\d+]/g, "");
}
function toNullOrTrim(v) {
  const s = (v ?? "").toString().trim();
  return s ? s : null;
}

/* =========================
   Endpoints públicos
========================= */

/**
 * GET /public/sucursales
 * Lista pública de sucursales. Muestra el apodo si existe.
 * Devuelve: [{ id, nombre, nombre_real, apodo }]
 */
router.get("/public/sucursales", publicCors, async (_req, res) => {
  try {
    const [rows] = await pool
      .promise()
      .query(`
        SELECT
          id,
          COALESCE(apodo, nombre) AS nombre,  -- nombre para mostrar
          nombre AS nombre_real,
          apodo
        FROM sucursales
        ORDER BY nombre ASC
      `);
    res.json(rows);
  } catch (err) {
    console.error("GET /public/sucursales error:", err.sqlMessage || err.message);
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
    const sucursalId = req.query.sucursal_id ? Number(req.query.sucursal_id) : null;
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
    console.error("GET /public/productos error:", err.sqlMessage || err.message);
    res.status(500).json({ error: "No se pudieron traer los productos" });
  }
});

/**
 * POST /public/clientes
 * Guarda el lead/cliente del formulario de Comunidad North.
 * Body: { nombre, telefono, sucursal (nombre opcional), nota, acepta, source? }
 * - Inserta con estado='nuevo'
 * - Notifica a n8n via webhook (si está configurado N8N_WEBHOOK_URL_NEW_CLIENT)
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

    // Resolver sucursal_id si te mandan el nombre (match por nombre real o apodo)
    let sucursalId = null;
    if (sucursal && String(sucursal).trim()) {
      const search = String(sucursal).trim();
      const [suc] = await pool
        .promise()
        .query(
          `SELECT id FROM sucursales
           WHERE nombre = ? OR apodo = ?
           LIMIT 1`,
          [search, search]
        );
      if (suc.length) sucursalId = suc[0].id;
    }

    // Insert
    const [result] = await pool.promise().query(
      `INSERT INTO clientes
       (nombre, telefono, sucursal_id, nota, acepta, estado, added_to_group, source, created_at)
       VALUES (?, ?, ?, ?, 1, 'nuevo', 0, ?, NOW())`,
      [String(nombre).trim(), tel, sucursalId, toNullOrTrim(nota), source || "web"]
    );

    // Notificar a n8n (no romper si n8n está caído)
    try {
      const webhookUrl = process.env.N8N_WEBHOOK_URL_NEW_CLIENT; // ej: https://n8n.tu-dominio/webhook/new-client
      if (webhookUrl) {
        const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: result.insertId,
            nombre: String(nombre).trim(),
            telefono: tel,            // ya normalizado
            sucursal_id: sucursalId,  // puede ser null
            nota: toNullOrTrim(nota),
            source: source || "web",
          }),
        });
      }
    } catch (e) {
      console.error("Webhook n8n falló:", e.message);
      // seguimos igual, no es crítico para responder 201
    }

    res.status(201).json({ ok: true, id: result.insertId });
  } catch (err) {
    console.error("POST /public/clientes error:", err.sqlMessage || err.message);
    res.status(500).json({ error: "No se pudo guardar el cliente" });
  }
});

/* =========================
   Endpoints admin (API Key)
========================= */

/**
 * Middleware simple para "endpoints admin".
 * Exige x-api-key = process.env.ADMIN_API_KEY
 * Reemplazar por tu auth real (JWT/sesiones) cuando quieras.
 */
const adminGuard = (req, res, next) => {
  const key = req.header("x-api-key");
  const expected = process.env.ADMIN_API_KEY;
  if (expected && key === expected) return next();
  if (!expected) return next(); // si no hay clave configurada, no bloqueamos (quitar en prod)
  return res.status(401).json({ error: "No autorizado" });
};

/**
 * GET /admin/clientes
 * Filtros opcionales:
 *  - estado = nuevo|contactado|agregado|descartado
 *  - q      = texto (busca en nombre, telefono, sucursal/apodo)
 *  - sucursal_id = filtra por sucursal
 *  - limit  = N (default 500, max 2000)
 */
router.get("/admin/clientes", adminGuard, async (req, res) => {
  try {
    const { estado, q, sucursal_id } = req.query;
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const where = [];
    const args = [];

    if (estado) {
      where.push("c.estado = ?");
      args.push(estado);
    }
    if (sucursal_id) {
      where.push("c.sucursal_id = ?");
      args.push(Number(sucursal_id));
    }
    if (q) {
      where.push("(c.nombre LIKE ? OR c.telefono LIKE ? OR s.nombre LIKE ? OR s.apodo LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT
        c.id, c.nombre, c.telefono, c.nota, c.acepta,
        c.estado, c.added_to_group, c.source, c.created_at,
        c.sucursal_id,
        COALESCE(s.apodo, s.nombre) AS sucursal, -- mostrar alias si existe
        s.nombre AS sucursal_real,
        s.apodo  AS sucursal_apodo
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
 * Body (cualquiera de estos): { estado, added_to_group, sucursal_id, nota }
 */
router.patch("/admin/clientes/:id", adminGuard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido" });

    const { estado, added_to_group, sucursal_id, nota } = req.body || {};
    const sets = [];
    const args = [];

    if (estado)       { sets.push("estado = ?");         args.push(estado); }
    if (typeof added_to_group !== "undefined") {
      sets.push("added_to_group = ?"); args.push(added_to_group ? 1 : 0);
    }
    if (typeof sucursal_id !== "undefined") {
      sets.push("sucursal_id = ?");    args.push(sucursal_id || null);
    }
    if (typeof nota !== "undefined")   { sets.push("nota = ?");           args.push(nota || null); }

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

/**
 * (Opcional) PATCH /admin/sucursales/:id
 * Setea o limpia el apodo (alias público) de una sucursal.
 * Body: { apodo }  --> string o null
 */
router.patch("/admin/sucursales/:id", adminGuard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido" });

    const { apodo } = req.body || {};
    const value = (apodo ?? "").toString().trim() || null;

    await pool.promise().query(
      "UPDATE sucursales SET apodo = ? WHERE id = ?",
      [value, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /admin/sucursales/:id error:", err.sqlMessage || err.message);
    res.status(500).json({ error: "No se pudo actualizar la sucursal" });
  }
});

module.exports = router;

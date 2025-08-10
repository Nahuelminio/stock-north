// routes/adminStock.routes.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");
const authorizeAdmin = require("../middlewares/authorizeAdmin");

/**
 * GET /admin/stock
 * Admin puede:
 *   - ?sucursal_id=ID  → filtrar una sucursal
 *   - ?sucursal_id=all | 0 → ver todas
 *   - ?solo_con_stock=1 → solo items con st.cantidad > 0
 *   - ?q=texto → filtra por producto o gusto (LIKE)
 *   - ?limit / ?offset → paginar (default 500/0)
 */
router.get("/", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const {
      sucursal_id,
      solo_con_stock,
      q,
      limit = 500,
      offset = 0,
    } = req.query;

    const verTodas = sucursal_id === "all" || sucursal_id === "0";
    const where = [];
    const params = [];

    if (!verTodas && sucursal_id) {
      where.push("s.id = ?");
      params.push(Number(sucursal_id));
    }
    if (solo_con_stock === "1" || solo_con_stock === "true") {
      where.push("st.cantidad > 0");
    }
    if (q && q.trim()) {
      where.push("(p.nombre LIKE ? OR g.nombre LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }

    let sql = `
      SELECT 
        p.id              AS producto_id,
        p.nombre          AS producto_nombre,
        g.id              AS gusto_id,
        g.nombre          AS gusto,
        g.codigo_barra,
        s.id              AS sucursal_id,
        s.nombre          AS sucursal,
        st.cantidad       AS stock,
        st.precio         AS precio
      FROM productos p
      JOIN gustos g      ON g.producto_id = p.id
      JOIN stock st      ON st.gusto_id   = g.id
      JOIN sucursales s  ON s.id          = st.sucursal_id
    `;
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY p.nombre, g.nombre LIMIT ? OFFSET ?";
    params.push(Number(limit), Number(offset));

    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error("❌ Error en /admin/stock:", error);
    res.status(500).json({ error: "Error al obtener stock" });
  }
});

/**
 * GET /admin/stock/disponibles
 * Igual que el anterior pero siempre obliga cantidad > 0
 */
router.get("/disponibles", authenticate, authorizeAdmin, async (req, res) => {
  try {
    const { sucursal_id, q, limit = 500, offset = 0 } = req.query;

    const verTodas = sucursal_id === "all" || sucursal_id === "0";
    const where = ["st.cantidad > 0"];
    const params = [];

    if (!verTodas && sucursal_id) {
      where.push("s.id = ?");
      params.push(Number(sucursal_id));
    }
    if (q && q.trim()) {
      where.push("(p.nombre LIKE ? OR g.nombre LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }

    let sql = `
      SELECT 
        p.id              AS producto_id,
        p.nombre          AS producto_nombre,
        g.id              AS gusto_id,
        g.nombre          AS gusto,
        g.codigo_barra,
        s.id              AS sucursal_id,
        s.nombre          AS sucursal,
        st.cantidad       AS stock,
        st.precio         AS precio
      FROM productos p
      JOIN gustos g      ON g.producto_id = p.id
      JOIN stock st      ON st.gusto_id   = g.id
      JOIN sucursales s  ON s.id          = st.sucursal_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.nombre, g.nombre
      LIMIT ? OFFSET ?
    `;
    params.push(Number(limit), Number(offset));

    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error("❌ Error en /admin/stock/disponibles:", error);
    res.status(500).json({ error: "Error al obtener disponibles" });
  }
});

module.exports = router;

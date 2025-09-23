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

module.exports = router;

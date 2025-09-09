// routes/pagos.js
const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

/* ----------------------- Helpers ----------------------- */

function parseFechaFlexible(fechaStr) {
  if (!fechaStr) return new Date();
  const s = String(fechaStr).trim();
  const m = s.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/
  );
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]) - 1;
    const yyyy = Number(m[3].length === 2 ? "20" + m[3] : m[3]);
    const HH = Number(m[4] || 0);
    const II = Number(m[5] || 0);
    return new Date(yyyy, mm, dd, HH, II, 0);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}
function normalizarMetodo(m) {
  const t = (m || "").toString().trim().toLowerCase();
  if (/^efec/.test(t) || t === "cash") return "efectivo";
  if (/^trans/.test(t) || /(cbu|cvu|alias|banco)/.test(t))
    return "transferencia";
  if (/^(mp|mercado\s*pago)$/.test(t)) return "mp";
  if (/credit|debito|d[eé]bito|cr[eé]dito|pos|lapos/.test(t)) return "tarjeta";
  return t || "otro";
}
const stripAcc = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
const onlyAN = (s) =>
  stripAcc(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
const lastDigits = (s, n = 12) =>
  String(s || "")
    .replace(/\D+/g, "")
    .slice(-n);
const sha256 = (s) =>
  crypto.createHash("sha256").update(String(s)).digest("hex");

/** Extrae identificadores fuertes desde referencia / ocr_text / parser_json */
function extractStrongRefs({ referencia, ocr_text, parser_json }) {
  const out = {};
  const blob = [
    referencia,
    parser_json ? JSON.stringify(parser_json) : "",
    ocr_text || "",
  ]
    .filter(Boolean)
    .join("  ");

  const mCoelsa = blob.match(/COELSA\s*ID[:\s]*([A-Z0-9\-]+)/i);
  if (mCoelsa) out.coelsa = onlyAN(mCoelsa[1]);

  const mTx = blob.match(/ID\s+de\s+la\s+transacci[oó]n[:\s]*([A-Z0-9\-]+)/i);
  if (mTx) out.txid = onlyAN(mTx[1]);

  // Ayuda para heurística
  const mCbu = blob.match(/\bCBU\b[:\s]*([0-9.\s]+)/i);
  if (mCbu) out.cbu_tail = lastDigits(mCbu[1], 12);

  // Alias (si viene en parser)
  if (parser_json && parser_json.alias)
    out.alias = stripAcc(parser_json.alias).toLowerCase();

  return out;
}

/** Construye el hash de deduplicación con prioridad por IDs fuertes */
function buildHash({
  montoNum,
  fechaPago,
  sucursal_id,
  referencia,
  ocr_text,
  parser_json,
}) {
  const strong = extractStrongRefs({ referencia, ocr_text, parser_json });

  if (strong.coelsa)
    return { hash: sha256(`COELSA|${strong.coelsa}`), mode: "COELSA" };
  if (strong.txid) return { hash: sha256(`TXID|${strong.txid}`), mode: "TXID" };

  // Heurística: ventana de 10 minutos + huella del pagador
  const bucket = Math.floor(+fechaPago / (10 * 60 * 1000));
  const payerFp = sha256(
    [
      lastDigits(strong.cbu_tail || parser_json?.cbu_cvu || referencia, 12),
      onlyAN(strong.alias || ""),
    ].join("|")
  );
  return {
    hash: sha256(
      ["HEU", montoNum, sucursal_id || 0, bucket, payerFp].join("|")
    ),
    mode: "HEU",
  };
}

/* ----------------------- Endpoints existentes ----------------------- */

// 🔵 Registrar pago (sucursal logueada)
router.post("/registrar-pago", authenticate, async (req, res) => {
  const { sucursal_id, metodo, monto } = req.body;
  if (
    !sucursal_id ||
    !metodo ||
    !monto ||
    isNaN(Number(monto)) ||
    Number(monto) <= 0
  ) {
    return res
      .status(400)
      .json({ error: "Faltan datos del pago o monto inválido" });
  }
  try {
    await pool
      .promise()
      .query(
        "INSERT INTO pagos (sucursal_id, metodo, monto, fecha) VALUES (?, ?, ?, NOW())",
        [sucursal_id, normalizarMetodo(metodo), Number(monto)]
      );
    res.json({ mensaje: "✅ Pago registrado" });
  } catch (error) {
    console.error("❌ Error al registrar pago:", error);
    res.status(500).json({ error: "Error al registrar el pago" });
  }
});

// 🔵 Historial de pagos
router.get("/historial-pagos", authenticate, async (req, res) => {
  const { fecha_inicio, fecha_fin } = req.query;
  const { sucursalId, rol } = req.user;
  try {
    let query = `
      SELECT 
        p.id, s.nombre AS sucursal, p.metodo, p.monto, p.fecha
      FROM pagos p
      JOIN sucursales s ON p.sucursal_id = s.id
      WHERE 1=1
    `;
    const params = [];
    if (rol !== "admin") {
      query += " AND p.sucursal_id = ?";
      params.push(sucursalId);
    }
    if (fecha_inicio && fecha_fin) {
      query += " AND DATE(p.fecha) BETWEEN ? AND ?";
      params.push(fecha_inicio, fecha_fin);
    } else if (fecha_inicio) {
      query += " AND DATE(p.fecha) >= ?";
      params.push(fecha_inicio);
    } else if (fecha_fin) {
      query += " AND DATE(p.fecha) <= ?";
      params.push(fecha_fin);
    }
    query += " ORDER BY p.fecha DESC";

    const [results] = await pool.promise().query(query, params);
    res.json(results);
  } catch (error) {
    console.error("❌ Error al obtener historial de pagos:", error);
    res.status(500).json({ error: "Error al obtener historial de pagos" });
  }
});

// 🔵 Total pagos por sucursal (admin)
router.get("/pagos-por-sucursal", authenticate, async (req, res) => {
  const { rol } = req.user;
  if (rol !== "admin")
    return res
      .status(403)
      .json({ error: "Acceso denegado: sólo administradores" });
  try {
    const [result] = await pool.promise().query(`
      SELECT s.id AS sucursal_id, s.nombre AS sucursal, IFNULL(SUM(p.monto), 0) AS total_pagado
      FROM sucursales s
      LEFT JOIN pagos p ON p.sucursal_id = s.id
      GROUP BY s.id, s.nombre
    `);
    res.json(result);
  } catch (err) {
    console.error("❌ Error al obtener pagos por sucursal:", err);
    res.status(500).json({ error: "Error al obtener pagos" });
  }
});

// 🔵 Resumen financiero (admin)
router.get("/resumen-pagos", authenticate, async (req, res) => {
  const { rol } = req.user;
  if (rol !== "admin")
    return res
      .status(403)
      .json({ error: "Acceso denegado: sólo administradores" });
  try {
    const [resumen] = await pool.promise().query(`
      SELECT 
          s.id AS sucursal_id,
          s.nombre AS sucursal,
          COALESCE(v.total_facturado, 0) AS total_facturado,
          COALESCE(p.total_pagado, 0) AS total_pagado,
          (COALESCE(v.total_facturado, 0) - COALESCE(p.total_pagado, 0)) AS total_pendiente
      FROM sucursales s
      LEFT JOIN (
          SELECT v.sucursal_id, SUM(v.cantidad * st.precio) AS total_facturado
          FROM ventas v
          JOIN stock st ON v.gusto_id = st.gusto_id AND v.sucursal_id = st.sucursal_id
          GROUP BY v.sucursal_id
      ) v ON s.id = v.sucursal_id
      LEFT JOIN (
          SELECT sucursal_id, SUM(monto) AS total_pagado
          FROM pagos
          GROUP BY sucursal_id
      ) p ON s.id = p.sucursal_id
      ORDER BY s.nombre
    `);
    res.json(resumen);
  } catch (error) {
    console.error("❌ Error al obtener resumen financiero:", error);
    res.status(500).json({ error: "Error al obtener resumen financiero" });
  }
});

// 🔵 Resumen financiero por sucursal (sucursal logueada)
router.get("/resumen-pagos-sucursal", authenticate, async (req, res) => {
  const { sucursalId } = req.user;
  try {
    const [resultado] = await pool.promise().query(
      `
      SELECT s.id AS sucursal_id, s.nombre AS sucursal,
             COALESCE(f.total_facturado, 0) AS total_facturado,
             COALESCE(p.total_pagado, 0) AS total_pagado,
             (COALESCE(f.total_facturado, 0) - COALESCE(p.total_pagado, 0)) AS deuda
      FROM sucursales s
      LEFT JOIN (
        SELECT v.sucursal_id, SUM(v.cantidad * st.precio) AS total_facturado
        FROM ventas v
        JOIN stock st ON v.gusto_id = st.gusto_id AND v.sucursal_id = st.sucursal_id
        WHERE v.sucursal_id = ?
        GROUP BY v.sucursal_id
      ) f ON s.id = f.sucursal_id
      LEFT JOIN (
        SELECT sucursal_id, SUM(monto) AS total_pagado
        FROM pagos
        WHERE sucursal_id = ?
        GROUP BY sucursal_id
      ) p ON s.id = p.sucursal_id
      WHERE s.id = ?
    `,
      [sucursalId, sucursalId, sucursalId]
    );

    if (resultado.length === 0)
      return res.status(404).json({ error: "Sucursal no encontrada" });
    res.json(resultado[0]);
  } catch (error) {
    console.error("❌ Error al obtener resumen financiero de sucursal:", error);
    res.status(500).json({ error: "Error al obtener resumen financiero" });
  }
});

/* ----------------------- OCR: Insert + Dedup + Raw ----------------------- */

// === POST /pagos/ingresar-ocr (admin)
router.post("/pagos/ingresar-ocr", authenticate, async (req, res) => {
  const conn = await pool.promise().getConnection();
  try {
    const { rol } = req.user;
    if (rol !== "admin") {
      conn.release();
      return res
        .status(403)
        .json({ error: "Acceso denegado: sólo administradores" });
    }

    let {
      sucursal_id,
      metodo,
      monto,
      fecha,
      referencia,
      imagen_url,
      ocr_text,
      ocr_confianza = 0.7,
      parser_json,
      confirmado = false,
    } = req.body;

    const montoNum = Number(monto);
    if (!montoNum || isNaN(montoNum) || montoNum <= 0) {
      conn.release();
      return res.status(400).json({ error: "Monto requerido, numérico y > 0" });
    }
    const metodoNorm = normalizarMetodo(metodo);
    const fechaPago = parseFechaFlexible(fecha);
    const sucId = sucursal_id || 0;
    const estado = confirmado ? "ok" : "needs_review";

    // --- dedup mejorado (prioriza IDs fuertes; luego heurística) ---
    const { hash } = buildHash({
      montoNum,
      fechaPago,
      sucursal_id: sucId,
      referencia,
      ocr_text,
      parser_json,
    });
    const hash_unico = hash;

    // ¿Existe?
    const [dup] = await conn.query(
      "SELECT id FROM pagos WHERE hash_unico = ? LIMIT 1",
      [hash_unico]
    );
    if (dup.length) {
      const pago_id = dup[0].id;
      await conn.query(
        "INSERT INTO pagos_raw_ocr (pago_id, ocr_text, ocr_confianza, parser_json, imagen_url) VALUES (?,?,?,?,?)",
        [
          pago_id,
          ocr_text || "",
          Number(ocr_confianza) || 0,
          JSON.stringify(parser_json || {}),
          imagen_url || null,
        ]
      );
      conn.release();
      return res.json({ status: "duplicado", pago_id });
    }

    // Transacción: pago + raw_ocr
    await conn.beginTransaction();

    const [ins] = await conn.query(
      `INSERT INTO pagos (sucursal_id, metodo, monto, fecha, referencia, imagen_url, estado, hash_unico)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sucursal_id || null,
        metodoNorm,
        montoNum,
        fechaPago,
        referencia || null,
        imagen_url || null,
        estado,
        hash_unico,
      ]
    );
    const pago_id = ins.insertId;

    await conn.query(
      "INSERT INTO pagos_raw_ocr (pago_id, ocr_text, ocr_confianza, parser_json, imagen_url) VALUES (?,?,?,?,?)",
      [
        pago_id,
        ocr_text || "",
        Number(ocr_confianza) || 0,
        JSON.stringify(parser_json || {}),
        imagen_url || null,
      ]
    );

    await conn.commit();
    conn.release();

    return res.json({
      status: estado === "ok" ? "insertado" : "needs_review",
      pago_id,
    });
  } catch (error) {
    try {
      await conn.rollback();
    } catch (_) {}
    conn.release();
    console.error("❌ Error en /pagos/ingresar-ocr:", error);
    res.status(500).json({ error: "Error al registrar pago via OCR" });
  }
});

/* ----------------------- Revisión/Ajuste ----------------------- */

// === PATCH /pagos/:id/revisar (admin)
router.patch("/pagos/:id/revisar", authenticate, async (req, res) => {
  const conn = await pool.promise().getConnection();
  try {
    const { rol } = req.user;
    if (rol !== "admin") {
      conn.release();
      return res.status(403).json({ error: "Sólo admin" });
    }

    const { id } = req.params;
    const {
      sucursal_id,
      metodo,
      monto,
      fecha,
      referencia,
      imagen_url,
      estado = "ok",
      ocr_text, // opcional para recalcular hash si se corrige
      parser_json, // opcional idem
    } = req.body;

    // Traer pago actual + último raw_ocr (por si no mandan ocr_text/parser_json)
    const [[pago]] = await conn.query("SELECT * FROM pagos WHERE id = ?", [id]);
    if (!pago) {
      conn.release();
      return res.status(404).json({ error: "Pago no encontrado" });
    }

    const [[raw]] = await conn.query(
      "SELECT * FROM pagos_raw_ocr WHERE pago_id = ? ORDER BY id DESC LIMIT 1",
      [id]
    );

    const nuevo = {
      sucursal_id: sucursal_id !== undefined ? sucursal_id : pago.sucursal_id,
      metodo: metodo !== undefined ? normalizarMetodo(metodo) : pago.metodo,
      monto: monto !== undefined ? Number(monto) : Number(pago.monto),
      fecha:
        fecha !== undefined ? parseFechaFlexible(fecha) : new Date(pago.fecha),
      referencia: referencia !== undefined ? referencia : pago.referencia,
      imagen_url: imagen_url !== undefined ? imagen_url : pago.imagen_url,
      estado: estado !== undefined ? estado : pago.estado,
      ocr_text: ocr_text !== undefined ? ocr_text : raw?.ocr_text || null,
      parser_json:
        parser_json !== undefined ? parser_json : raw?.parser_json || null,
    };

    if (!nuevo.monto || isNaN(nuevo.monto) || nuevo.monto <= 0) {
      conn.release();
      return res.status(400).json({ error: "Monto inválido" });
    }

    // Recalcular hash con la misma lógica
    const { hash: hash_unico } = buildHash({
      montoNum: nuevo.monto,
      fechaPago: nuevo.fecha,
      sucursal_id: nuevo.sucursal_id || 0,
      referencia: nuevo.referencia,
      ocr_text: nuevo.ocr_text,
      parser_json: nuevo.parser_json,
    });

    await conn.query(
      `UPDATE pagos
       SET sucursal_id=?, metodo=?, monto=?, fecha=?, referencia=?, imagen_url=?, estado=?, hash_unico=?
       WHERE id=?`,
      [
        nuevo.sucursal_id || null,
        nuevo.metodo,
        nuevo.monto,
        nuevo.fecha,
        nuevo.referencia || null,
        nuevo.imagen_url || null,
        nuevo.estado,
        hash_unico,
        id,
      ]
    );

    conn.release();
    res.json({ mensaje: "✅ Pago actualizado" });
  } catch (e) {
    conn.release();
    console.error("❌ Error en PATCH /pagos/:id/revisar:", e);
    res.status(500).json({ error: "Error al actualizar pago" });
  }
});

/* ----------------------- Pendientes (para UI) ----------------------- */

// === GET /pagos/pendientes
router.get("/pagos/pendientes", authenticate, async (req, res) => {
  try {
    const { rol, sucursalId } = req.user;
    let sql = `
      SELECT p.*, s.nombre AS sucursal
      FROM pagos p
      LEFT JOIN sucursales s ON s.id = p.sucursal_id
      WHERE p.estado = 'needs_review'
    `;
    const params = [];
    if (rol !== "admin") {
      sql += " AND (p.sucursal_id = ? OR p.sucursal_id IS NULL)";
      params.push(sucursalId);
    }
    sql += " ORDER BY p.fecha DESC";
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error en GET /pagos/pendientes:", e);
    res.status(500).json({ error: "Error al listar pendientes" });
  }
});

module.exports = router;

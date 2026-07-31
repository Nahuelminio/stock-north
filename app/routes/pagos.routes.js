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

  // Número de operación ya extraído (Mercado Pago, Galicia, etc. lo rotulan
  // de mil formas distintas). Es un ID fuerte: identifica la transferencia sin
  // importar qué sucursal la suba, así que dos sucursales no pueden acreditarse
  // el mismo comprobante.
  if (!out.coelsa && !out.txid && referencia) {
    const oper = onlyAN(referencia);
    if (oper.length >= 6) out.operacion = oper;
  }

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
  if (strong.operacion)
    return { hash: sha256(`OPER|${strong.operacion}`), mode: "OPER" };

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

// routes/pagos.js
router.post("/registrar-pago", authenticate, async (req, res) => {
  try {
    const { rol } = req.user || {};
    if (rol !== "admin") {
      return res.status(403).json({ error: "Acceso denegado: sólo administradores" });
    }

    const { sucursal_id, metodo, monto } = req.body || {};
    const mnum = Number(monto);

    if (!sucursal_id || !metodo || !mnum || isNaN(mnum) || mnum <= 0) {
      return res.status(400).json({ error: "Faltan datos del pago o monto inválido" });
    }

    await pool.promise().query(
      "INSERT INTO pagos (sucursal_id, metodo, monto, fecha) VALUES (?, ?, ?, NOW())",
      [Number(sucursal_id), normalizarMetodo(metodo), mnum]
    );

    res.json({ mensaje: "✅ Pago registrado" });
  } catch (error) {
    console.error("❌ Error al registrar pago:", error);
    res.status(500).json({
      error: "Error al registrar el pago",
      detalle: String(error?.sqlMessage || error?.message || error)
    });
  }
});


// 🔵 Historial de pagos
router.get("/historial-pagos", authenticate, async (req, res) => {
  const { fecha_inicio, fecha_fin } = req.query;
  const { sucursalId, rol } = req.user;
  try {
    let query = `
      SELECT
        p.id, s.nombre AS sucursal, p.metodo, p.monto, p.fecha, p.estado
      FROM pagos p
      JOIN sucursales s ON p.sucursal_id = s.id
      WHERE p.estado = 'ok'
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
      LEFT JOIN pagos p ON p.sucursal_id = s.id AND p.estado = 'ok'
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
    return res.status(403).json({ error: "Acceso denegado: sólo administradores" });
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
          SELECT v.sucursal_id, SUM(v.cantidad * v.precio_unitario) AS total_facturado
          FROM ventas v
          GROUP BY v.sucursal_id
      ) v ON s.id = v.sucursal_id
      LEFT JOIN (
          SELECT sucursal_id, SUM(monto) AS total_pagado
          FROM pagos
          WHERE estado = 'ok'
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
// 🔵 Resumen financiero por sucursal (sucursal logueada)
router.get("/resumen-pagos-sucursal", authenticate, async (req, res) => {
  const { id: userId, rol, sucursalId } = req.user;
  const esVendedor = rol === "vendedor";

  try {
    let totalFacturado = 0;
    let totalPagado    = 0;
    let nombreLabel    = "—";

    if (esVendedor) {
      // Vendedores: facturado por vendedor_id (puede haber vendido desde varias sucursales)
      const [[fila]] = await pool.promise().query(
        `SELECT COALESCE(SUM(v.cantidad * v.precio_unitario), 0) AS total_facturado
         FROM ventas v WHERE v.vendedor_id = ?`,
        [userId]
      );
      totalFacturado = Number(fila.total_facturado);

      // Pagos: por vendedor_id (nuevo modelo)
      const [[pagFila]] = await pool.promise().query(
        `SELECT COALESCE(SUM(monto), 0) AS total_pagado
         FROM pagos WHERE vendedor_id = ? AND estado = 'ok'`,
        [userId]
      );
      totalPagado = Number(pagFila.total_pagado);
    } else {
      // Sucursales: comportamiento original
      if (!sucursalId)
        return res.status(400).json({ error: "Sin sucursal asignada" });

      const [[fila]] = await pool.promise().query(
        `SELECT
           s.nombre AS sucursal,
           COALESCE(f.total_facturado, 0) AS total_facturado,
           COALESCE(p.total_pagado, 0)    AS total_pagado
         FROM sucursales s
         LEFT JOIN (
           SELECT sucursal_id, SUM(cantidad * precio_unitario) AS total_facturado
           FROM ventas WHERE sucursal_id = ? GROUP BY sucursal_id
         ) f ON s.id = f.sucursal_id
         LEFT JOIN (
           SELECT sucursal_id, SUM(monto) AS total_pagado
           FROM pagos WHERE sucursal_id = ? AND estado = 'ok' GROUP BY sucursal_id
         ) p ON s.id = p.sucursal_id
         WHERE s.id = ?`,
        [sucursalId, sucursalId, sucursalId]
      );
      if (!fila) return res.status(404).json({ error: "Sucursal no encontrada" });

      return res.json({
        sucursal: fila.sucursal,
        total_facturado: Number(fila.total_facturado),
        total_pagado:    Number(fila.total_pagado),
      });
    }

    res.json({
      sucursal:         nombreLabel,
      total_facturado:  totalFacturado,
      total_pagado:     totalPagado,
    });
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
      // No llamamos conn.release() aquí — lo hace el finally
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

    return res.json({
      status: estado === "ok" ? "insertado" : "needs_review",
      pago_id,
    });
  } catch (error) {
    try { await conn.rollback(); } catch (_) {}
    console.error("❌ Error en /pagos/ingresar-ocr:", error);
    res.status(500).json({ error: "Error al registrar pago via OCR" });
  } finally {
    conn.release();
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

/* ----------------------- Comprobante por foto ----------------------- */

// === POST /pagos/comprobante
// La sucursal (o el admin) sube la foto de un comprobante. Se lee con Claude
// Vision, se deduplica y queda pendiente de aprobación del admin.
router.post("/pagos/comprobante", authenticate, async (req, res) => {
  const conn = await pool.promise().getConnection();
  try {
    const { rol, sucursalId, id: userId } = req.user || {};
    const { imagen, mime, sucursal_id: sucursalBody } = req.body || {};

    if (!imagen) {
      return res.status(400).json({ error: "Falta la imagen del comprobante" });
    }

    // La sucursal solo puede cargar para sí misma; el admin elige a cuál
    const sucId = rol === "admin" ? Number(sucursalBody) || null : sucursalId;
    if (!sucId) {
      return res.status(400).json({ error: "No se pudo determinar la sucursal" });
    }

    const base64 = String(imagen).replace(/^data:[^;]+;base64,/, "");
    const mediaType = mime || "image/jpeg";

    // --- Leer el comprobante ---
    let datos;
    try {
      const { leerComprobante } = require("../services/leerComprobante");
      datos = await leerComprobante(base64, mediaType);
    } catch (e) {
      console.error("❌ Error al leer el comprobante:", e);
      return res.status(422).json({
        error: "No se pudo leer el comprobante. Probá con una foto más nítida.",
      });
    }

    if (!datos.es_comprobante) {
      return res.status(422).json({
        error: "La imagen no parece ser un comprobante de pago.",
      });
    }

    const montoNum = Number(datos.monto);
    if (!montoNum || isNaN(montoNum) || montoNum <= 0) {
      return res.status(422).json({
        error: "No se pudo leer el monto del comprobante.",
      });
    }

    const metodoNorm = normalizarMetodo(datos.metodo);
    const fechaPago = parseFechaFlexible(datos.fecha);
    const parserJson = {
      destinatario: datos.destinatario || null,
      cbu_cvu: datos.cbu_cvu || null,
      alias: datos.destinatario || null,
    };

    // --- Deduplicación (misma lógica que /pagos/ingresar-ocr) ---
    const { hash: hash_unico } = buildHash({
      montoNum,
      fechaPago,
      sucursal_id: sucId,
      referencia: datos.referencia,
      ocr_text: JSON.stringify(datos),
      parser_json: parserJson,
    });

    const [dup] = await conn.query(
      "SELECT id, monto, fecha, estado FROM pagos WHERE hash_unico = ? LIMIT 1",
      [hash_unico]
    );
    if (dup.length) {
      return res.status(409).json({
        error: "Este comprobante ya fue cargado.",
        status: "duplicado",
        pago_id: dup[0].id,
        pago: dup[0],
      });
    }

    // --- Insertar pago + rastro OCR + imagen ---
    await conn.beginTransaction();

    const [ins] = await conn.query(
      `INSERT INTO pagos (sucursal_id, metodo, monto, fecha, referencia, estado, hash_unico)
       VALUES (?, ?, ?, ?, ?, 'needs_review', ?)`,
      [sucId, metodoNorm, montoNum, fechaPago, datos.referencia || null, hash_unico]
    );
    const pago_id = ins.insertId;

    await conn.query(
      `INSERT INTO pagos_raw_ocr (pago_id, ocr_text, ocr_confianza, parser_json)
       VALUES (?, ?, ?, ?)`,
      [pago_id, JSON.stringify(datos), Number(datos.confianza) || 0, JSON.stringify(parserJson)]
    );

    await conn.query(
      `INSERT INTO pagos_comprobantes (pago_id, imagen_base64, mime, subido_por)
       VALUES (?, ?, ?, ?)`,
      [pago_id, base64, mediaType, userId || null]
    );

    await conn.commit();

    res.json({
      status: "pendiente",
      pago_id,
      leido: {
        monto: montoNum,
        fecha: datos.fecha,
        metodo: metodoNorm,
        referencia: datos.referencia || null,
        destinatario: datos.destinatario || null,
        confianza: Number(datos.confianza) || 0,
      },
    });
  } catch (error) {
    try { await conn.rollback(); } catch (_) {}
    console.error("❌ Error en /pagos/comprobante:", error);
    res.status(500).json({ error: "Error al procesar el comprobante" });
  } finally {
    conn.release();
  }
});

// === GET /pagos/:id/comprobante — devuelve la imagen guardada
router.get("/pagos/:id/comprobante", authenticate, async (req, res) => {
  try {
    const { rol, sucursalId } = req.user;
    const [[row]] = await pool.promise().query(
      `SELECT c.imagen_base64, c.mime, p.sucursal_id
       FROM pagos_comprobantes c
       JOIN pagos p ON p.id = c.pago_id
       WHERE c.pago_id = ? ORDER BY c.id DESC LIMIT 1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Sin comprobante" });
    if (rol !== "admin" && row.sucursal_id !== sucursalId) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    res.json({ imagen: `data:${row.mime};base64,${row.imagen_base64}` });
  } catch (e) {
    console.error("❌ Error al obtener comprobante:", e);
    res.status(500).json({ error: "Error al obtener el comprobante" });
  }
});

// === DELETE /pagos/:id/rechazar — descarta un comprobante pendiente (admin)
router.delete("/pagos/:id/rechazar", authenticate, async (req, res) => {
  const conn = await pool.promise().getConnection();
  try {
    if (req.user?.rol !== "admin") {
      return res.status(403).json({ error: "Sólo admin" });
    }
    const [[pago]] = await conn.query("SELECT estado FROM pagos WHERE id = ?", [
      req.params.id,
    ]);
    if (!pago) {
      return res.status(404).json({ error: "Pago no encontrado" });
    }
    if (pago.estado !== "needs_review") {
      return res
        .status(400)
        .json({ error: "Sólo se pueden rechazar pagos pendientes de revisión" });
    }

    await conn.beginTransaction();
    await conn.query("DELETE FROM pagos_comprobantes WHERE pago_id = ?", [req.params.id]);
    await conn.query("DELETE FROM pagos_raw_ocr WHERE pago_id = ?", [req.params.id]);
    await conn.query("DELETE FROM pagos WHERE id = ?", [req.params.id]);
    await conn.commit();

    res.json({ ok: true });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error("❌ Error al rechazar pago:", e);
    res.status(500).json({ error: "Error al rechazar el pago" });
  } finally {
    conn.release();
  }
});

/* ----------------------- Pendientes (para UI) ----------------------- */

// === GET /pagos/pendientes
router.get("/pagos/pendientes", authenticate, async (req, res) => {
  try {
    const { rol, sucursalId } = req.user;
    let sql = `
      SELECT p.*, s.nombre AS sucursal,
        r.ocr_confianza, r.parser_json,
        (SELECT COUNT(*) FROM pagos_comprobantes c WHERE c.pago_id = p.id) AS tiene_imagen
      FROM pagos p
      LEFT JOIN sucursales s ON s.id = p.sucursal_id
      LEFT JOIN pagos_raw_ocr r ON r.id = (
        SELECT MAX(r2.id) FROM pagos_raw_ocr r2 WHERE r2.pago_id = p.id
      )
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

const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate"); // 🔵 Importar middleware

// 🔵 Obtener valor total del stock solo de la sucursal del usuario
router.get("/valor-stock-por-sucursal", authenticate, async (req, res) => {
  const { sucursalId } = req.user; // ✅ Sucursal sacada del token

  try {
    const [results] = await pool.promise().query(
      `
      SELECT 
        s.id AS sucursal_id,
        s.nombre AS sucursal,
        SUM(st.cantidad * st.precio) AS valor_total
      FROM stock st
      JOIN gustos g ON st.gusto_id = g.id
      JOIN productos p ON g.producto_id = p.id
      JOIN sucursales s ON st.sucursal_id = s.id
      WHERE s.id = ?
      GROUP BY s.id, s.nombre
    `,
      [sucursalId]
    );

    res.json(results);
  } catch (error) {
    console.error("❌ Error al calcular valor de stock por sucursal:", error);
    res.status(500).json({ error: "Error al obtener valor de stock" });
  }
});


router.post("/reposicion", authenticate, async (req, res) => {
  const { gusto_id, cantidad, sucursal_id } = req.body;

  console.log("➡️ Body recibido:", { gusto_id, cantidad, sucursal_id });
  console.log("➡️ req.user:", req.user);

  if (req.user.rol !== "admin") {
    return res.status(403).json({
      error: "Acceso denegado: solo admin puede registrar reposiciones",
    });
  }

  if (!gusto_id || !cantidad || !sucursal_id) {
    console.log("❌ ERROR: Faltan datos =>", {
      gusto_id,
      cantidad,
      sucursal_id,
    });
    return res.status(400).json({
      error:
        "Faltan datos para la reposición (gusto_id, cantidad, sucursal_id son obligatorios)",
    });
  }

  const gustoIdNum = parseInt(gusto_id, 10);
  const cantidadNum = parseInt(cantidad, 10);
  const sucursalIdNum = parseInt(sucursal_id, 10);

  console.log("➡️ Convertidos a número:", {
    gustoIdNum,
    cantidadNum,
    sucursalIdNum,
  });

  if (
    isNaN(gustoIdNum) ||
    isNaN(cantidadNum) ||
    isNaN(sucursalIdNum) ||
    !gustoIdNum ||
    !cantidadNum ||
    !sucursalIdNum
  ) {
    console.log("❌ ERROR: Datos inválidos después de convertir");
    return res.status(400).json({
      error: "Los datos enviados no son válidos (deben ser números válidos)",
    });
  }

  try {
    const [stockExistente] = await pool
      .promise()
      .query("SELECT * FROM stock WHERE gusto_id = ? AND sucursal_id = ?", [
        gustoIdNum,
        sucursalIdNum,
      ]);

    console.log("🔎 Stock existente:", stockExistente);

    if (stockExistente.length === 0) {
      console.log("🆕 Creando nuevo stock...");
      await pool
        .promise()
        .query(
          "INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio) VALUES (?, ?, ?, ?)",
          [gustoIdNum, sucursalIdNum, cantidadNum, 0]
        );
    } else {
      console.log("✏️ Actualizando stock existente...");
      await pool
        .promise()
        .query(
          "UPDATE stock SET cantidad = cantidad + ? WHERE gusto_id = ? AND sucursal_id = ?",
          [cantidadNum, gustoIdNum, sucursalIdNum]
        );
    }

    console.log("📝 Registrando en historial...");
    await pool
      .promise()
      .query(
        "INSERT INTO reposiciones (gusto_id, sucursal_id, cantidad_repuesta, fecha) VALUES (?, ?, ?, NOW())",
        [gustoIdNum, sucursalIdNum, cantidadNum]
      );

    console.log("✅ Reposición registrada correctamente");
    res.json({ mensaje: "Reposición registrada correctamente ✅" });
  } catch (error) {
    console.error("❌ Error al registrar reposición:", error);
    res.status(500).json({ error: "Error al registrar la reposición" });
  }
});


// 🔵 Reposición rápida (sin historial)
router.post("/reposicion-rapida", authenticate, async (req, res) => {
  const { gusto_id, cantidad } = req.body;
  const { sucursalId } = req.user; // ✅ Usar sucursal del token

  if (!gusto_id || !cantidad) {
    return res
      .status(400)
      .json({ error: "Faltan datos para la reposición rápida" });
  }

  try {
    const [existencia] = await pool
      .promise()
      .query("SELECT * FROM stock WHERE gusto_id = ? AND sucursal_id = ?", [
        gusto_id,
        sucursalId,
      ]);

    if (existencia.length === 0) {
      await pool
        .promise()
        .query(
          "INSERT INTO stock (gusto_id, sucursal_id, cantidad) VALUES (?, ?, ?)",
          [gusto_id, sucursalId, cantidad]
        );
    } else {
      await pool
        .promise()
        .query(
          "UPDATE stock SET cantidad = cantidad + ? WHERE gusto_id = ? AND sucursal_id = ?",
          [cantidad, gusto_id, sucursalId]
        );
    }

    res.json({ mensaje: "✅ Reposición rápida realizada" });
  } catch (error) {
    console.error("❌ Error en reposición rápida:", error);
    res.status(500).json({ error: "Error al realizar reposición rápida" });
  }
});

module.exports = router;

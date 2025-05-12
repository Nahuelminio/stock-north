const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

// ✅ Registro de usuario
router.post("/register", async (req, res) => {
  const { email, password, sucursal_id, rol } = req.body;

  if (!email || !password || (!sucursal_id && rol !== "admin")) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    await pool
      .promise()
      .query(
        "INSERT INTO usuarios (email, password_hash, sucursal_id, rol) VALUES (?, ?, ?, ?)",
        [email, hashedPassword, sucursal_id || null, rol || "sucursal"]
      );

    res.json({ mensaje: "✅ Usuario registrado" });
  } catch (error) {
    console.error("❌ Error en /register:", error);
    res.status(500).json({ error: "Error al registrar usuario" });
  }
});

// ✅ Login de usuario
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Faltan email o contraseña" });
  }

  try {
    console.log("🟡 Buscando usuario:", email);
    const [rows] = await pool
      .promise()
      .query("SELECT * FROM usuarios WHERE email = ?", [email]);

    console.log("🟢 Resultado query:", rows);

    const user = rows[0];
    if (!user) {
      console.log("🔴 Usuario no encontrado");
      return res.status(401).json({ error: "Usuario no encontrado" });
    }

    console.log("🟡 Comparando password...");
    const validPassword = await bcrypt.compare(password, user.password_hash);
    console.log("🟢 Resultado bcrypt:", validPassword);

    if (!validPassword) {
      console.log("🔴 Contraseña incorrecta");
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error("❌ JWT_SECRET no está configurado");
      return res
        .status(500)
        .json({ error: "Falta configuración del servidor" });
    }

    const token = jwt.sign(
      {
        id: user.id,
        sucursal_id: user.sucursal_id,
        rol: user.rol,
      },
      jwtSecret,
      { expiresIn: "8h" }
    );

    console.log("✅ Login exitoso, generando token");

    res.json({ token });
  } catch (error) {
    console.error("❌ Error en /login:", error);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

module.exports = router;

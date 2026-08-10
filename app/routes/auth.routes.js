const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

const router = express.Router();

// ✅ Registro de usuario — solo admin puede crear usuarios
router.post("/register", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") {
    return res.status(403).json({ error: "Acceso denegado: solo administradores pueden crear usuarios" });
  }

  const { email, password, sucursal_id, rol } = req.body;

  // rol solo puede ser uno de los valores válidos; nunca viene del exterior sin validar
  const roles_validos = ["admin", "sucursal", "vendedor"];
  const rolFinal = roles_validos.includes(rol) ? rol : "sucursal";

  if (!email || !password || (!sucursal_id && rolFinal !== "admin")) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "La contraseña tiene que tener al menos 6 caracteres" });
  }

  try {
    // Sin esto el INSERT falla con un error de base que no dice nada
    const [[existe]] = await pool
      .promise()
      .query("SELECT id FROM usuarios WHERE email = ?", [email.trim()]);
    if (existe) {
      return res.status(400).json({ error: "Ya hay un usuario con ese email" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool
      .promise()
      .query(
        "INSERT INTO usuarios (email, password_hash, sucursal_id, rol) VALUES (?, ?, ?, ?)",
        [email.trim(), hashedPassword, sucursal_id || null, rolFinal]
      );

    res.json({ mensaje: "✅ Usuario registrado" });
  } catch (error) {
    console.error("❌ Error en /register:", error);
    res.status(500).json({ error: "Error al registrar usuario" });
  }
});

// ✅ Listado de usuarios — solo admin
router.get("/usuarios", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") {
    return res.status(403).json({ error: "Acceso denegado: solo administradores" });
  }
  try {
    // Nunca se devuelve el hash de la contraseña, ni siquiera al admin
    const [rows] = await pool.promise().query(`
      SELECT u.id, u.email, u.rol, u.sucursal_id, s.nombre AS sucursal
      FROM usuarios u
      LEFT JOIN sucursales s ON s.id = u.sucursal_id
      ORDER BY u.rol, u.email
    `);
    res.json(rows);
  } catch (error) {
    console.error("❌ Error en GET /auth/usuarios:", error);
    res.status(500).json({ error: "No se pudieron traer los usuarios" });
  }
});

// ✅ Login de usuario
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Faltan email o contraseña" });
  }

  try {
    const [rows] = await pool
      .promise()
      .query("SELECT * FROM usuarios WHERE email = ?", [email]);

    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: "Usuario no encontrado" });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
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

    res.json({ token });
  } catch (error) {
    console.error("❌ Error en /login:", error);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

module.exports = router;

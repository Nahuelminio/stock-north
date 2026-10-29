const jwt = require("jsonwebtoken");

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Token no enviado" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Estandariza la clave para mantener compatibilidad en el backend
    req.user = {
      id: decoded.id,
      rol: decoded.rol,
      sucursalId: decoded.sucursal_id || null,
    };

    next();
  } catch (error) {
    // Token vencido o roto es algo esperable (sesión vieja en un navegador):
    // una línea alcanza, el stack completo solo ensuciaba los logs.
    console.warn(`Auth rechazada (${error.name}: ${error.message}) en ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
};

module.exports = authenticate;

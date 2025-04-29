const jwt = require("jsonwebtoken");

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Token no enviado" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, sucursalId, rol }
    next();
  } catch (error) {
    console.error("Error de autenticación:", error);
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
};

module.exports = authenticate;

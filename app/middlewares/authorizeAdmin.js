const authorizeAdmin = (req, res, next) => {
  if (req.user.rol !== "admin") {
    return res
      .status(403)
      .json({ error: "Acceso denegado: sólo para administradores" });
  }
  next();
};

module.exports = authorizeAdmin;

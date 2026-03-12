const bcrypt = require("bcrypt");

async function generarHash() {
  const password = "maluh"; // la contraseña que quieras para la sucursal
  const hash = await bcrypt.hash(password, 10);
  console.log(hash);
}

generarHash();

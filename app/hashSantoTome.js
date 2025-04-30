const bcrypt = require("bcrypt");

async function generarHash() {
  const password = "sucursalguille"; // la contraseña que quieras para la sucursal
  const hash = await bcrypt.hash(password, 10);
  console.log(hash);
}

generarHash();

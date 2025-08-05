const bcrypt = require("bcryptjs");

async function generarHash() {
  const password = "brickell"; // O la que quieras
  const hash = await bcrypt.hash(password, 10);
  console.log(hash);
}

generarHash();

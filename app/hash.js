const bcrypt = require("bcryptjs");

async function generarHash() {
  const password = "admin123"; // O la que quieras
  const hash = await bcrypt.hash(password, 10);
  console.log(hash);
}

generarHash();

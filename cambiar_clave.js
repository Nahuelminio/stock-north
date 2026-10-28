// Cambia la contraseña de un usuario desde la terminal, para cuando no se
// puede entrar al admin. La clave se escribe oculta y nunca va como argumento.
//
//   node cambiar_clave.js admin@northshop.com

require("dotenv").config();
const bcrypt = require("bcryptjs");
const readline = require("readline");
const pool = require("./app/db");

function preguntarOculto(texto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.startsWith(texto)) rl.output.write(texto); };
    rl.question(texto, (r) => { rl.close(); process.stdout.write("\n"); resolve(r); });
  });
}

(async () => {
  const email = (process.argv[2] || "").trim();
  if (!email) { console.log("Uso: node cambiar_clave.js <email>"); process.exit(1); }

  const [[u]] = await pool.promise().query("SELECT id FROM usuarios WHERE email = ?", [email]);
  if (!u) { console.log("No existe ese usuario."); process.exit(1); }

  const clave = await preguntarOculto("Nueva contraseña: ");
  const otra = await preguntarOculto("Repetila: ");
  if (clave !== otra) { console.log("No coinciden. No cambié nada."); process.exit(1); }
  if (clave.length < 6) { console.log("Tiene que tener al menos 6 caracteres. No cambié nada."); process.exit(1); }

  await pool.promise().query("UPDATE usuarios SET password_hash = ? WHERE id = ?", [await bcrypt.hash(clave, 10), u.id]);
  console.log("✅ Contraseña cambiada. Ya podés entrar.");
  process.exit(0);
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });

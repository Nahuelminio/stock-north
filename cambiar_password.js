/**
 * Cambia la contraseña de un usuario.
 *
 * La pide por teclado y no la muestra: no queda en el historial del shell
 * ni en ningún archivo. Nunca pasar la contraseña como argumento.
 *
 *   node cambiar_password.js vendedorNico@northshop.com
 */

require("dotenv").config({ quiet: true });
const bcrypt = require("bcrypt");
const readline = require("readline");
const pool = require("./app/db");

const email = process.argv[2];

if (!email) {
  console.error("Falta el email.\n  node cambiar_password.js alguien@northshop.com");
  process.exit(1);
}

/** Lee sin mostrar lo que se escribe. */
function pedirOculto(pregunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      // Mientras escribe, se reimprime solo el texto de la pregunta
      if (![ "\n", "\r", "" ].includes(char.toString())) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(pregunta);
      }
    };
    process.stdin.on("data", onData);
    rl.question(pregunta, (valor) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(valor);
    });
  });
}

async function main() {
  const [[usuario]] = await pool
    .promise()
    .query("SELECT id, email, nombre, rol FROM usuarios WHERE email = ?", [email]);

  if (!usuario) {
    console.error(`No existe ningún usuario con el email ${email}`);
    process.exit(1);
  }

  console.log(`Usuario: ${usuario.nombre || usuario.email}  (${usuario.rol}, id ${usuario.id})\n`);

  const pass = await pedirOculto("Contraseña nueva: ");
  if (pass.length < 6) {
    console.error("Muy corta: poné al menos 6 caracteres.");
    process.exit(1);
  }
  const repetida = await pedirOculto("Repetila: ");
  if (pass !== repetida) {
    console.error("No coinciden. No se cambió nada.");
    process.exit(1);
  }

  const hash = await bcrypt.hash(pass, 10);
  const [r] = await pool
    .promise()
    .query("UPDATE usuarios SET password_hash = ? WHERE id = ?", [hash, usuario.id]);

  if (r.affectedRows !== 1) {
    console.error("No se actualizó ninguna fila.");
    process.exit(1);
  }

  // Control: que el hash nuevo realmente valide contra lo que se escribió
  const [[check]] = await pool
    .promise()
    .query("SELECT password_hash FROM usuarios WHERE id = ?", [usuario.id]);
  const ok = await bcrypt.compare(pass, check.password_hash);

  console.log(ok ? "\n✅ Contraseña cambiada y verificada." : "\n❌ Se guardó pero no valida. Revisalo.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
  });

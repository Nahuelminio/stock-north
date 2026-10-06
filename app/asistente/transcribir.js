/**
 * Pasar audio a texto.
 *
 * Claude no transcribe audio, así que esto va contra Whisper de OpenAI. Es el
 * único pedazo del asistente que usa otro proveedor.
 *
 * Lo usan dos cosas: los audios que le mandás al bot por Telegram y, cuando
 * llegue, el botón de la placa del mostrador. Las dos mandan un archivo y
 * reciben texto; de ahí en adelante es idéntico a un mensaje escrito.
 *
 * Sin OPENAI_API_KEY devuelve {ok:false, falta_clave:true} en vez de romper,
 * para que quien lo llame pueda explicar qué falta en vez de quedarse mudo.
 */

const MODELO = process.env.TRANSCRIPTOR_MODELO || "whisper-1";
const LIMITE_MB = 24;   // el límite de la API son 25, dejamos margen
const TIMEOUT_MS = 30000;

/**
 * @param {Buffer} audio
 * @param {string} nombre  Con extensión, que es de donde sale el formato: "nota.ogg"
 * @returns {Promise<{ok: boolean, texto?: string, error?: string, falta_clave?: boolean}>}
 */
async function transcribir(audio, nombre = "audio.ogg") {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, falta_clave: true, error: "Falta OPENAI_API_KEY" };
  }
  if (!audio?.length) return { ok: false, error: "El audio llegó vacío" };

  const mb = audio.length / 1024 / 1024;
  if (mb > LIMITE_MB) {
    return { ok: false, error: `El audio pesa ${mb.toFixed(1)}MB y el máximo son ${LIMITE_MB}MB` };
  }

  const form = new FormData();
  form.append("file", new Blob([audio]), nombre);
  form.append("model", MODELO);
  // Sin esto arranca adivinando el idioma y con audios cortos a veces erra
  form.append("language", "es");
  // Los nombres propios del negocio, para que no los escriba de oído
  form.append(
    "prompt",
    "Vapes y shishas. Marcas: Elfbar, Lost Mary, Ignite, Geekbar, Dinner Lady, " +
    "Oxbar, Maskking, Nasty. Sucursales: Central, Garupá, Itaembé Guazú, Santa Ana, " +
    "Santo Tomé, Brickell, Zoe Tec, Weekend Bebidas, North Punto."
  );

  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: ctrl.signal,
    });

    if (!r.ok) {
      const detalle = await r.text().catch(() => "");
      console.error("❌ transcribir:", r.status, detalle.slice(0, 300));
      return {
        ok: false,
        error: r.status === 401 ? "La clave de transcripción no es válida"
          : r.status === 429 ? "Se acabó el crédito de transcripción"
          : `El transcriptor contestó ${r.status}`,
      };
    }

    const j = await r.json();
    const texto = String(j?.text || "").trim();
    if (!texto) return { ok: false, error: "No se entendió nada en el audio" };
    return { ok: true, texto };
  } catch (e) {
    const abortado = e.name === "AbortError";
    console.error("❌ transcribir:", e.message);
    return { ok: false, error: abortado ? "El transcriptor tardó demasiado" : "No se pudo transcribir" };
  } finally {
    clearTimeout(corte);
  }
}

/** Para que las pantallas puedan avisar antes de intentar. */
const hayTranscriptor = () => Boolean(process.env.OPENAI_API_KEY);

module.exports = { transcribir, hayTranscriptor };

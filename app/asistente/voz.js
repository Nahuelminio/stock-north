/**
 * Texto a voz, para que el aparato conteste hablando.
 *
 * Usa la misma clave de OpenAI que la transcripción, así no hay una cuenta más.
 *
 * Devuelve audio crudo de 16 bits a 16 kHz, que es lo mismo que graba el
 * micrófono: así la placa usa una sola configuración para grabar y reproducir,
 * y no tiene que cambiarla a mitad de camino.
 *
 * OpenAI entrega 24 kHz, así que se baja a 16 acá. El servidor tiene CPU de
 * sobra y la placa no: todo lo que se pueda hacer de este lado, se hace acá.
 */

const MODELO = process.env.VOZ_MODELO || "gpt-4o-mini-tts";
// "coral" es de las más cálidas y suena a persona, no a locutor de aeropuerto.
// Se cambia con VOZ_NOMBRE: alloy, ash, ballad, coral, echo, fable, nova,
// onyx, sage, shimmer y verse.
const VOZ = process.env.VOZ_NOMBRE || "coral";
const TIMEOUT_MS = 20000;

// Cómo tiene que sonar. Es un aparato que vive en el mostrador y le contesta al
// dueño todo el día: tiene que sonar a alguien conocido, no a contestador.
const TONO =
  "Hablás en español rioplatense, de Argentina, con acento porteño natural: " +
  "voseo, y la 'll' y la 'y' como en Buenos Aires. Nada de acento neutro de " +
  "doblaje latino ni de locutor. Sos Vapi, el asistente del negocio, y le " +
  "hablás al dueño. Sonás como un amigo que le está dando una mano: cálido, " +
  "con buena onda, relajado. Si es una confirmación, decila con ganas. Si son " +
  "números, decilos tranquilo y claro, sin apurarte.";

/** Las voces que ofrece OpenAI, para poder probarlas desde el bot. */
const VOCES = ["alloy", "ash", "ballad", "coral", "echo", "fable",
               "nova", "onyx", "sage", "shimmer", "verse"];

const ENTRADA = 24000;   // lo que entrega OpenAI
const SALIDA  = 16000;   // lo que usa la placa

/**
 * Baja el muestreo de 24 kHz a 16 kHz interpolando entre muestras.
 * Para voz alcanza de sobra y no necesita librerías.
 */
function bajarMuestreo(pcm24) {
  const entrada = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.length / 2);
  const cuantas = Math.floor((entrada.length * SALIDA) / ENTRADA);
  const salida = new Int16Array(cuantas);

  for (let i = 0; i < cuantas; i++) {
    const pos = (i * ENTRADA) / SALIDA;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, entrada.length - 1);
    const f = pos - a;
    salida[i] = entrada[a] * (1 - f) + entrada[b] * f;
  }
  return Buffer.from(salida.buffer, salida.byteOffset, salida.byteLength);
}

/**
 * @param {string} texto  Lo que tiene que decir
 * @returns {Promise<{ok: boolean, pcm?: Buffer, error?: string, falta_clave?: boolean}>}
 */
async function hablar(texto) {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, falta_clave: true, error: "Falta OPENAI_API_KEY" };
  }
  const limpio = String(texto || "").trim();
  if (!limpio) return { ok: false, error: "No hay nada que decir" };

  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        voice: VOZ,
        input: limpio.slice(0, 500),
        response_format: "pcm",
        // Que suene como alguien del negocio contestando, no como un locutor
        instructions: TONO,
      }),
      signal: ctrl.signal,
    });

    if (!r.ok) {
      const detalle = await r.text().catch(() => "");
      console.error("❌ voz:", r.status, detalle.slice(0, 200));
      return {
        ok: false,
        error: r.status === 401 ? "La clave no es válida"
          : r.status === 429 ? "Se acabó el crédito"
          : `El servicio de voz contestó ${r.status}`,
      };
    }

    const pcm24 = Buffer.from(await r.arrayBuffer());
    return { ok: true, pcm: bajarMuestreo(pcm24) };
  } catch (e) {
    console.error("❌ voz:", e.message);
    return { ok: false, error: e.name === "AbortError" ? "Tardó demasiado" : "No se pudo generar la voz" };
  } finally {
    clearTimeout(corte);
  }
}

/**
 * Lo mismo pero sin esperar: va mandando el audio a medida que se genera.
 *
 * Esperar a tener la frase entera antes de empezar a sonar agrega casi dos
 * segundos de silencio. Lo que se nota en una conversación no es el total sino
 * cuánto tardás en escuchar la primera palabra, y así arranca apenas llega el
 * primer pedazo.
 *
 * El remuestreo se hace al vuelo. Como los pedazos no caen en límites prolijos,
 * se guarda la última muestra de cada uno para empalmar con el siguiente: sin
 * eso queda un chasquido en cada empalme.
 *
 * @param {string} texto
 * @param {(trozo: Buffer) => void} alLlegar  Se llama con cada pedazo ya a 16 kHz
 * @returns {Promise<{ok: boolean, error?: string, falta_clave?: boolean}>}
 */
async function hablarEnVivo(texto, alLlegar) {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, falta_clave: true, error: "Falta OPENAI_API_KEY" };
  }
  const limpio = String(texto || "").trim();
  if (!limpio) return { ok: false, error: "No hay nada que decir" };

  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        voice: VOZ,
        input: limpio.slice(0, 500),
        response_format: "pcm",
        instructions: TONO,
      }),
      signal: ctrl.signal,
    });

    if (!r.ok) {
      const detalle = await r.text().catch(() => "");
      console.error("❌ voz:", r.status, detalle.slice(0, 200));
      return { ok: false, error: `El servicio de voz contestó ${r.status}` };
    }

    // Los pedazos no caen en límites prolijos, así que hay dos cosas que
    // arrastrar entre uno y el siguiente: el byte suelto cuando el pedazo
    // tiene un largo impar, y la posición exacta dentro de la señal, que casi
    // nunca cae justo en una muestra. Sin lo segundo, cada empalme suena a
    // chasquido; sin lo primero, el audio entero se vuelve ruido.
    let sobra = Buffer.alloc(0);
    let anterior = 0;        // última muestra del pedazo previo
    let posicion = 0;        // dónde quedó la lectura, con decimales

    for await (const parte of r.body) {
      const bloque = Buffer.concat([sobra, Buffer.from(parte)]);
      const cuantas = bloque.length >> 1;
      sobra = bloque.subarray(cuantas << 1);
      if (!cuantas) continue;

      // Se arma la señal con la última muestra del pedazo anterior adelante,
      // para poder interpolar en el empalme.
      const muestras = new Int16Array(cuantas + 1);
      muestras[0] = anterior;
      for (let i = 0; i < cuantas; i++) muestras[i + 1] = bloque.readInt16LE(i << 1);
      anterior = muestras[cuantas];

      const paso = ENTRADA / SALIDA;           // 1,5 muestras de entrada por una de salida
      const salida = [];
      while (posicion + 1 < muestras.length) {
        const a = Math.floor(posicion);
        const f = posicion - a;
        salida.push(Math.round(muestras[a] * (1 - f) + muestras[a + 1] * f));
        posicion += paso;
      }
      posicion -= cuantas;                     // se arrastra al pedazo siguiente

      if (salida.length) {
        const pcm = new Int16Array(salida);
        alLlegar(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      }
    }
    return { ok: true };
  } catch (e) {
    console.error("❌ voz en vivo:", e.message);
    return { ok: false, error: e.name === "AbortError" ? "Tardó demasiado" : "No se pudo generar la voz" };
  } finally {
    clearTimeout(corte);
  }
}


/**
 * La misma frase pero en un formato que se pueda mandar por Telegram, y con la
 * voz que se le pida.
 *
 * Sirve para elegir voz de oído: el aparato usa la que diga VOZ_NOMBRE, y
 * probarlas una por una cambiando la variable y redeployando es insufrible.
 * OpenAI entrega opus directamente, que es justo lo que Telegram quiere para
 * una nota de voz, así que no hay que convertir nada.
 *
 * @param {string} texto
 * @param {{voz?: string, formato?: string}} [opts]
 * @returns {Promise<{ok: boolean, audio?: Buffer, error?: string}>}
 */
async function hablarComprimido(texto, opts = {}) {
  if (!process.env.OPENAI_API_KEY) return { ok: false, error: "Falta OPENAI_API_KEY" };
  const limpio = String(texto || "").trim();
  if (!limpio) return { ok: false, error: "No hay nada que decir" };

  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        voice: VOCES.includes(opts.voz) ? opts.voz : VOZ,
        input: limpio.slice(0, 500),
        response_format: opts.formato || "opus",
        instructions: TONO,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const detalle = await r.text().catch(() => "");
      console.error("❌ voz:", r.status, detalle.slice(0, 200));
      return { ok: false, error: `El servicio de voz contestó ${r.status}` };
    }
    return { ok: true, audio: Buffer.from(await r.arrayBuffer()) };
  } catch (e) {
    console.error("❌ voz:", e.message);
    return { ok: false, error: e.name === "AbortError" ? "Tardó demasiado" : "No se pudo generar la voz" };
  } finally {
    clearTimeout(corte);
  }
}

module.exports = { hablar, hablarEnVivo, hablarComprimido, VOCES, VOZ, SALIDA };

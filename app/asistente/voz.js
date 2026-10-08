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
const VOZ = process.env.VOZ_NOMBRE || "verse";
const TIMEOUT_MS = 20000;

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
        instructions: "Hablá en español rioplatense, con naturalidad y sin " +
                      "exagerar la entonación. Tono tranquilo y breve.",
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
        instructions: "Hablá en español rioplatense, con naturalidad y sin " +
                      "exagerar la entonación. Tono tranquilo y breve.",
      }),
      signal: ctrl.signal,
    });

    if (!r.ok) {
      const detalle = await r.text().catch(() => "");
      console.error("❌ voz:", r.status, detalle.slice(0, 200));
      return { ok: false, error: `El servicio de voz contestó ${r.status}` };
    }

    let sobra = Buffer.alloc(0);     // bytes que quedaron sin par
    let ultima = 0;                  // para empalmar con el pedazo siguiente

    for await (const parte of r.body) {
      let bloque = Buffer.concat([sobra, Buffer.from(parte)]);
      const pares = Math.floor(bloque.length / 2);
      sobra = bloque.subarray(pares * 2);
      if (!pares) continue;

      const entrada = new Int16Array(pares);
      for (let i = 0; i < pares; i++) entrada[i] = bloque.readInt16LE(i * 2);

      const cuantas = Math.floor((entrada.length * SALIDA) / ENTRADA);
      const salida = new Int16Array(cuantas);
      for (let i = 0; i < cuantas; i++) {
        const pos = (i * ENTRADA) / SALIDA;
        const a = Math.floor(pos);
        const f = pos - a;
        const v0 = a === 0 ? ultima : entrada[a - 1 + 1 - 1];
        const anterior = a < entrada.length ? entrada[a] : entrada[entrada.length - 1];
        const siguiente = a + 1 < entrada.length ? entrada[a + 1] : anterior;
        salida[i] = (a === 0 && f === 0 ? v0 : anterior) * (1 - f) + siguiente * f;
      }
      ultima = entrada[entrada.length - 1];

      alLlegar(Buffer.from(salida.buffer, salida.byteOffset, salida.byteLength));
    }
    return { ok: true };
  } catch (e) {
    console.error("❌ voz en vivo:", e.message);
    return { ok: false, error: e.name === "AbortError" ? "Tardó demasiado" : "No se pudo generar la voz" };
  } finally {
    clearTimeout(corte);
  }
}

module.exports = { hablar, hablarEnVivo, SALIDA };

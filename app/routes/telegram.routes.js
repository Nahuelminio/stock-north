/**
 * El bot que contesta. Telegram manda acá cada mensaje que le escribís.
 *
 * Seguridad, que acá importa más que en otras rutas porque esto habla con la
 * base y nadie está logueado:
 *
 *  1. La URL lleva un secreto largo, así que no se adivina.
 *  2. Telegram manda un header con otro secreto que comparamos.
 *  3. Solo contestamos a los chats de la lista blanca.
 *
 * Con cualquiera de los tres que falle, cortamos. Y contestamos 200 igual:
 * si devolvemos error, Telegram reintenta el mismo mensaje una y otra vez.
 */

const express = require("express");
const router = express.Router();
const { responder, olvidar } = require("../asistente/cerebro");
const { transcribir } = require("../asistente/transcribir");
const { listaDeStock, sucursalesDisponibles } = require("../asistente/listaStock");
const { hablarComprimido, VOCES, VOZ } = require("../asistente/voz");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SECRETO = process.env.TELEGRAM_WEBHOOK_SECRET || "";

// Dos niveles de permiso.
//
//   completo: todo. El dueño.
//   stock:    sólo /stock. Para las sucursales, que necesitan la lista para
//             mandarle a los clientes y nada más. No pasan por el modelo, así
//             que no hay forma de que les conteste un costo o una deuda ni
//             aunque pregunten, y tampoco gastan llamadas.
//
// Los avisos de venta no se tocan: van al chat de siempre, así que sumar
// sucursales acá no les manda ninguna notificación.
const lista = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

const CHATS_COMPLETOS = lista(process.env.TELEGRAM_CHATS_ASISTENTE || process.env.TELEGRAM_CHAT_ID);
const CHATS_STOCK = lista(process.env.TELEGRAM_CHATS_STOCK);

function permiso(chatId) {
  const id = String(chatId);
  if (CHATS_COMPLETOS.includes(id)) return "completo";
  if (CHATS_STOCK.includes(id)) return "stock";
  return null;
}

// A quién ya le dijimos que no está habilitado, para no repetirlo en cada mensaje
const avisados = new Set();

/** Baja un archivo que mandó el usuario. Telegram los da en dos pasos. */
async function bajarArchivo(fileId) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=${fileId}`);
  const j = await r.json();
  const ruta = j?.result?.file_path;
  if (!ruta) throw new Error("Telegram no dio la ruta del archivo");
  const bin = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${ruta}`);
  if (!bin.ok) throw new Error(`No se pudo bajar el audio (${bin.status})`);
  return { buffer: Buffer.from(await bin.arrayBuffer()), nombre: ruta.split("/").pop() };
}

const api = (metodo, cuerpo) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  }).catch((e) => console.error("Telegram:", e.message));

/** Telegram corta los mensajes en 4096; partimos por renglón para no cortar palabras. */
function partir(texto, max = 3900) {
  if (texto.length <= max) return [texto];
  const partes = [];
  let actual = "";
  for (const linea of texto.split("\n")) {
    if ((actual + linea).length > max) { partes.push(actual); actual = ""; }
    actual += linea + "\n";
  }
  if (actual.trim()) partes.push(actual);
  return partes;
}

async function enviar(chatId, texto) {
  for (const parte of partir(texto)) {
    await api("sendMessage", {
      chat_id: chatId,
      text: parte,
      disable_web_page_preview: true,
    });
  }
}

/**
 * Manda una nota de voz. Va por multipart porque el audio es un archivo, no
 * texto, así que no entra en el api() de arriba que manda JSON.
 */
async function enviarVoz(chatId, audio, pie) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", pie || "");
  form.append("voice", new Blob([audio], { type: "audio/ogg" }), "vapi.ogg");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, {
    method: "POST", body: form,
  }).catch((e) => { console.error("Telegram voz:", e.message); return null; });
  if (r && !r.ok) console.error("Telegram voz:", r.status, (await r.text()).slice(0, 200));
}

const RE_VOZ = /^\/voz(?:@\w+)?\b\s*(.*)$/i;

/**
 * /voz manda la misma frase con las once voces, para elegir de oído; /voz
 * <nombre> manda solo esa. Elegir por el nombre no sirve: "coral" y "sage"
 * no dicen nada hasta que las escuchás diciendo lo que el aparato dice.
 */
async function probarVoces(chatId, pedida) {
  const FRASE = "¡Ey! Listo, ya te mandé la lista de Central al Telegram. " +
                "Hay doce modelos y doscientas diecisiete unidades. ¿Algo más?";
  const cuales = pedida && VOCES.includes(pedida.toLowerCase())
    ? [pedida.toLowerCase()]
    : pedida
      ? null
      : VOCES;

  if (!cuales) {
    await enviar(chatId, `No conozco la voz "${pedida}". Las que hay:\n` +
      VOCES.join(" · ") + `\n\nAhora está puesta: ${VOZ}`);
    return;
  }

  if (cuales.length > 1) {
    await enviar(chatId, `Van las ${VOCES.length} voces con la misma frase. ` +
      `La que está puesta ahora es ${VOZ}. Cuando elijas, decime cuál y la dejo fija.`);
  }

  for (const voz of cuales) {
    api("sendChatAction", { chat_id: chatId, action: "record_voice" });
    const v = await hablarComprimido(FRASE, { voz });
    if (!v.ok) { await enviar(chatId, `${voz}: ${v.error}`); continue; }
    await enviarVoz(chatId, v.audio, voz === VOZ ? `${voz} (la actual)` : voz);
  }
}

const RE_STOCK = /^\/stock(?:@\w+)?\b\s*(.*)$/i;

// El link de seguimiento del viaje de Uber
const RE_UBER = /https?:\/\/(?:www\.)?trip\.uber\.com\/\S+/i;

/**
 * El mensaje de envío, para reenviarle al cliente.
 *
 * Es el mismo texto que armaba el flujo "Delivery" de n8n, palabra por
 * palabra: es lo que los clientes vienen recibiendo. Va sin parse_mode, así
 * los asteriscos llegan literales y al pegarlo en WhatsApp quedan en negrita.
 */
const mensajeEnvio = (link) =>
  [
    "Tu pedido de *The North Shop* ya está en camino.",
    "",
    "Podés seguir el trayecto en tiempo real desde este enlace:",
    link,
    "",
    "Te pedimos estar pendiente para recibirlo.",
    "*¡Gracias por confiar en nosotros!*",
  ].join("\n");

/**
 * La ayuda nombra todas las sucursales, sacadas de la base. Antes nombraba
 * cuatro escritas a mano y el resto había que adivinarlas.
 * Se arma cada vez: son dos consultas por mes, no hace falta guardarla.
 */
async function ayudaStock() {
  let sucursales = [];
  try { sucursales = await sucursalesDisponibles(); }
  catch (e) { console.error("ayudaStock:", e.message); }

  const conStock = sucursales.filter((s) => s.unidades > 0);
  const vacias = sucursales.filter((s) => s.unidades === 0);

  const renglon = (s) => `/stock ${s.nombre.toLowerCase()}`;

  return [
    "Pedime la lista de stock y te la mando lista para reenviar por WhatsApp.",
    "",
    ...conStock.map(renglon),
    ...(vacias.length ? ["", "Sin stock hoy:", ...vacias.map(renglon)] : []),
    "",
    "/stock todas   junta todas en una sola lista",
    "",
    "Y si pegás un link de viaje de Uber, te armo el mensaje de envío",
    "para reenviarle al cliente.",
  ].join("\n");
}

/** Manda la lista, o explica qué falta. La usan los dos niveles de permiso. */
async function mandarStock(chatId, pedida) {
  if (!pedida) { await enviar(chatId, await ayudaStock()); return; }

  const r = await listaDeStock(pedida);
  if (!r.ok) {
    await enviar(chatId, `${r.error}\n\n${await ayudaStock()}`);
    return;
  }
  if (r.vacio) { await enviar(chatId, `${r.sucursal} no tiene nada con stock.`); return; }
  for (const parte of r.partes) await enviar(chatId, parte);
}

router.post("/telegram/webhook/:secreto", async (req, res) => {
  // Contestamos ya: Telegram espera pocos segundos y pensar lleva más
  res.sendStatus(200);

  try {
    if (!SECRETO || req.params.secreto !== SECRETO) return;
    const header = req.get("X-Telegram-Bot-Api-Secret-Token");
    if (header && header !== SECRETO) return;

    const msg = req.body?.message || req.body?.edited_message;
    if (!msg) return;

    const chatId = String(msg.chat?.id || "");
    const nivel = permiso(chatId);

    if (!nivel) {
      const quien = msg.chat?.title || [msg.from?.first_name, msg.from?.username]
        .filter(Boolean).join(" @") || "desconocido";
      console.warn(`🚫 asistente: chat no habilitado ${chatId} (${quien})`);
      // Una sola vez por chat: así quien escriba puede pasar su número en vez
      // de quedarse esperando una respuesta que no llega.
      if (!avisados.has(chatId)) {
        avisados.add(chatId);
        await enviar(chatId,
          "Este bot es privado.\n\n" +
          `Si tenés que usarlo, pasale este número a Nahuel: ${chatId}`);
      }
      return;
    }

    // Las sucursales no pasan de acá: sólo la lista. No llegan al modelo, así
    // que no hay manera de que les conteste un costo, una deuda ni un margen,
    // ni aunque lo pregunten de mil formas.
    if (nivel === "stock") {
      const t = (msg.text || "").trim();
      const uber = t.match(RE_UBER);
      if (uber) { await enviar(chatId, mensajeEnvio(uber[0])); return; }
      const cmd = t.match(RE_STOCK);
      if (cmd) { await mandarStock(chatId, cmd[1].trim()); return; }
      // "stock central" sin la barra también vale: es como lo escribe la gente
      if (/\bstock\b/i.test(t)) {
        await mandarStock(chatId, t.replace(/\bstock\b/i, "").trim());
        return;
      }
      await enviar(chatId, await ayudaStock());
      return;
    }

    // Un audio se transcribe y de ahí en adelante es igual que un mensaje escrito
    let texto = (msg.text || "").trim();

    if (msg.voice || msg.audio) {
      api("sendChatAction", { chat_id: chatId, action: "typing" });
      const archivo = msg.voice || msg.audio;
      let t;
      try {
        const { buffer, nombre } = await bajarArchivo(archivo.file_id);
        t = await transcribir(buffer, nombre);
      } catch (e) {
        console.error("audio de Telegram:", e.message);
        await enviar(chatId, "No pude bajar el audio. Probá de nuevo.");
        return;
      }

      if (!t.ok) {
        await enviar(chatId, t.falta_clave
          ? "Todavía no tengo configurada la transcripción. Mandámelo escrito, o " +
            "dictalo con el microfonito del teclado."
          : `No pude entender el audio: ${t.error}`);
        return;
      }

      texto = t.texto;
      // Se muestra lo que se entendió: si transcribió mal, lo ves vos antes
      // que el asistente conteste cualquier cosa.
      await enviar(chatId, `Entendí: "${texto}"`);
    }

    if (!texto) return;

    if (texto === "/start" || texto === "/ayuda") {
      await enviar(chatId,
        "Soy Vapi. Preguntame lo que quieras del negocio, como se lo preguntarías a alguien.\n\n" +
        "Por ejemplo:\n" +
        "- cuánto ice king me queda\n" +
        "- pasame la lista de weekend\n" +
        "- cómo venimos hoy\n" +
        "- quién me debe plata\n" +
        "- armame la lista mayorista al 15\n" +
        "- qué margen dejaron los pedidos de septiembre\n\n" +
        "Para la lista de siempre, la que se manda por WhatsApp:\n" +
        "/stock central · /stock weekend · /stock todas\n\n" +
        "/voz te manda la misma frase con todas las voces, para elegir.\n" +
        "/olvidar borra lo que veníamos hablando.");
      return;
    }

    // Si pegás un link de viaje, te devuelve el mensaje armado para el cliente
    const uber = texto.match(RE_UBER);
    if (uber) { await enviar(chatId, mensajeEnvio(uber[0])); return; }

    // /stock va directo, sin pasar por el modelo: el formato es fijo, así sale
    // al instante y no gasta una llamada. Es el comando que se usaba en n8n.
    const cmdStock = texto.match(RE_STOCK);
    if (cmdStock) { await mandarStock(chatId, cmdStock[1].trim()); return; }

    const cmdVoz = texto.match(RE_VOZ);
    if (cmdVoz) { await probarVoces(chatId, cmdVoz[1].trim()); return; }

    if (texto === "/olvidar") {
      olvidar(chatId);
      await enviar(chatId, "Listo, arrancamos de cero.");
      return;
    }

    // "escribiendo..." mientras piensa, para que no parezca colgado
    api("sendChatAction", { chat_id: chatId, action: "typing" });
    const respuesta = await responder(chatId, texto);
    await enviar(chatId, respuesta);
  } catch (e) {
    console.error("❌ asistente:", e);
    const chatId = req.body?.message?.chat?.id;
    if (chatId) await enviar(chatId, "Se me rompió algo buscando eso. Probá de nuevo en un rato.");
  }
});

module.exports = router;

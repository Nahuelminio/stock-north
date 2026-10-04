/**
 * El asistente: Claude con acceso de lectura a la base.
 *
 * Recibe lo que escribiste, decide qué consultar y contesta en texto. Las
 * consultas están en herramientas.js y son todas de lectura: el asistente no
 * puede escribir nada, ni siquiera equivocándose.
 *
 * La conversación se guarda en memoria, así que un reinicio del servidor la
 * borra. Es a propósito: no vale la pena una tabla para esto, y arrancar de
 * cero después de un deploy no molesta a nadie.
 */

const Anthropic = require("@anthropic-ai/sdk");
const { catalogo, ejecutar } = require("./herramientas");

const client = new Anthropic(); // toma ANTHROPIC_API_KEY del entorno

// Sonnet alcanza de sobra para elegir una consulta y redactar la respuesta, y
// contesta mucho más rápido que Opus, que es lo que importa en un chat.
const MODELO = process.env.ASISTENTE_MODELO || "claude-sonnet-5-5";

// Tope de vueltas de herramientas por mensaje. Si lo toca es que algo se trabó.
const MAX_VUELTAS = 8;

// Cuántos mensajes de ida y vuelta recordamos por chat
const MEMORIA = 20;

const historial = new Map(); // chatId -> [{role, content}]

function instrucciones() {
  const hoy = new Date();
  const fecha = hoy.toLocaleDateString("es-AR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  return `Sos el asistente de The North Shop, un negocio de vapes y shishas en Misiones, Argentina.
Le contestás al dueño por Telegram.

Hoy es ${fecha} (${hoy.toLocaleDateString("sv-SE")}).

Cómo funciona el negocio:
- La Central es el depósito: de ahí sale la mercadería a las sucursales y a los clientes mayoristas.
- Las sucursales son puntos de venta que deben lo que venden hasta que lo pagan.
- Los vendedores minoristas funcionan igual pero son personas, no locales.
- La mercadería se compra en dólares y se vende en pesos.

Cómo contestar:
- Breve y al grano. Es un chat de Telegram, no un informe. Dos o tres renglones alcanzan casi siempre.
- Nada de markdown: Telegram lo muestra crudo. Nada de asteriscos ni almohadillas.
- Los pesos con separador de miles: $1.961.205. Los dólares con coma decimal: USD 9,80.
- Si la respuesta es una lista larga, dale los primeros y decí cuántos quedan.
- Hablá como se habla acá, de vos, sin solemnidad.

Qué tener en cuenta:
- El margen siempre es sobre lo facturado, no sobre el costo. Si el dato que tenés es otro, aclaralo.
- Los costos en dólares a veces son calculados y no de factura; las herramientas te lo dicen. Cuando sea relevante, decilo.
- Si una consulta vuelve con un error o vacía, decilo tal cual. Nunca inventes un número.
- Si no entendés qué sucursal o qué producto te están nombrando, preguntá en vez de adivinar.
- Si notás algo raro en los datos —un margen muy bajo, una deuda negativa, un costo imposible— mencionalo aunque no te lo hayan preguntado.

Lo que no podés hacer: solo consultás, no cargás ni modificás nada. Si te piden registrar una venta, aprobar un pago o cambiar un precio, decí que eso se hace desde el sistema.`;
}

/**
 * Responde un mensaje.
 * @param {string|number} chatId  Para separar las conversaciones
 * @param {string} texto          Lo que escribió el usuario
 * @returns {Promise<string>}     La respuesta en texto plano
 */
async function responder(chatId, texto) {
  const clave = String(chatId);
  const mensajes = historial.get(clave) || [];
  mensajes.push({ role: "user", content: texto });

  const usadas = [];

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const r = await client.messages.create({
      model: MODELO,
      max_tokens: 4000,
      system: instrucciones(),
      tools: catalogo(),
      messages: mensajes,
    });

    mensajes.push({ role: "assistant", content: r.content });

    if (r.stop_reason !== "tool_use") {
      const texto = r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      guardar(clave, mensajes);
      return texto || "No se me ocurrió qué contestar. Probá de nuevo.";
    }

    // Todas las herramientas del turno en paralelo: son lecturas sueltas
    const pedidos = r.content.filter((b) => b.type === "tool_use");
    const resultados = await Promise.all(
      pedidos.map(async (b) => {
        usadas.push(b.name);
        const dato = await ejecutar(b.name, b.input);
        return {
          type: "tool_result",
          tool_use_id: b.id,
          content: JSON.stringify(dato),
        };
      })
    );
    mensajes.push({ role: "user", content: resultados });
  }

  guardar(clave, mensajes);
  console.warn(`⚠️  asistente: se cortó por vueltas. Herramientas: ${usadas.join(", ")}`);
  return "Me enredé buscando el dato. Probá preguntándomelo de otra forma.";
}

/** Guarda la conversación recortada, sin partirla por la mitad de una herramienta. */
function guardar(clave, mensajes) {
  let recortados = mensajes;
  if (mensajes.length > MEMORIA) {
    // Un tool_result huérfano rompe la API, así que arrancamos en un mensaje
    // de usuario que sea texto de verdad y no el resultado de una herramienta.
    let desde = mensajes.length - MEMORIA;
    while (
      desde < mensajes.length &&
      !(mensajes[desde].role === "user" && typeof mensajes[desde].content === "string")
    ) desde++;
    recortados = desde < mensajes.length ? mensajes.slice(desde) : [];
  }
  historial.set(clave, recortados);
}

/** Olvida la conversación de un chat. */
function olvidar(chatId) {
  historial.delete(String(chatId));
}

module.exports = { responder, olvidar, MODELO };

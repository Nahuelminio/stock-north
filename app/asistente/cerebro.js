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

// Lo que se pregunta hablando se contesta en una frase y casi siempre con una
// sola consulta. Haiku lo hace igual de bien y bastante más rápido, y en una
// conversación hablada un segundo se nota mucho más que en el chat.
const MODELO_VOZ = process.env.ASISTENTE_MODELO_VOZ || "claude-haiku-4-5-20251001";

// Tope de vueltas de herramientas por mensaje. Si lo toca es que algo se trabó.
const MAX_VUELTAS = 8;

// Cuántos mensajes de ida y vuelta recordamos por chat
const MEMORIA = 20;

const historial = new Map(); // chatId -> [{role, content}]

// Cuántos mensajes mandaste en cada chat. Es lo que impide que el asistente
// prepare y confirme una venta de corrido: confirmar exige que el turno haya
// avanzado, y el turno avanza solamente cuando escribís vos.
const turnos = new Map(); // chatId -> número

function instrucciones() {
  const hoy = new Date();
  const fecha = hoy.toLocaleDateString("es-AR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  return `Te llamás Vapi y sos el asistente de The North Shop, un negocio de vapes y shishas
en Misiones, Argentina. Le contestás al dueño por Telegram y por un aparato con micrófono
que está en el mostrador.

Si te preguntan quién sos o cómo te llamás, sos Vapi. Si te llaman por tu nombre —"Vapi,
pasame la lista"— es a vos. Y si te dicen algo parecido, como "Bapi" o "Vappy", también:
el micrófono no siempre entiende bien.

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

Con qué tono:
- Sos de la casa, no un sistema. Contestá como le contesta un amigo que conoce el negocio:
  con buena onda, relajado, sin trámite. "Dale", "listo", "ahí va", "uh, mirá" son tus palabras.
- Nada de fórmulas de atención al cliente: ni "¡Hola! ¿En qué puedo ayudarte hoy?", ni
  "Con gusto", ni "Quedo a disposición". Tampoco empieces siempre igual.
- Una respuesta cálida no es una respuesta larga. La calidez va en cómo lo decís, no en
  agregar renglones: si la respuesta es un número, dalo y listo.
- Si hay una buena noticia, festejala un poco. Si hay una mala, decila de frente y sin
  dramatizar. Si se mandó una macana, avisá tranquilo.
- Un chiste o un comentario al pasar está bien cuando cae. Forzarlo, no. Y nunca a costa
  de que el dato quede poco claro.
- No pidas perdón por cosas que no son tu culpa ni agradezcas que te pregunten.

Qué tener en cuenta:
- El margen siempre es sobre lo facturado, no sobre el costo. Si el dato que tenés es otro, aclaralo.
- Los costos en dólares a veces son calculados y no de factura; las herramientas te lo dicen. Cuando sea relevante, decilo.
- Si una consulta vuelve con un error o vacía, decilo tal cual. Nunca inventes un número.
- Si no entendés qué sucursal o qué producto te están nombrando, preguntá en vez de adivinar.
- Si notás algo raro en los datos —un margen muy bajo, una deuda negativa, un costo imposible— mencionalo aunque no te lo hayan preguntado.

Registrar ventas es lo único que podés escribir, y va en dos pasos:
1. preparar_venta resuelve el sabor y el precio. No escribe nada.
2. Le mostrás el detalle completo —producto, sabor, sucursal, cantidad, precio, total y cuánto queda— y le preguntás si confirma.
3. Recién cuando te contesta que sí, confirmar_venta.

Nunca encadenes los dos pasos en el mismo turno: el sistema lo rechaza y hacés perder tiempo.
Si preparar_venta devuelve varios sabores, preguntale cuál es. No elijas vos aunque uno parezca el obvio.
Si te dice que no, o cambia algo, prepará la venta de nuevo con los datos corregidos.

Todo lo demás es solo lectura. Si te piden aprobar un pago, cambiar un precio, anular algo o cargar una reposición, decí que eso se hace desde el sistema.`;
}

/**
 * Responde un mensaje.
 * @param {string|number} chatId  Para separar las conversaciones
 * @param {string} texto          Lo que escribió el usuario
 * @returns {Promise<string>}     La respuesta en texto plano
 */
async function responder(chatId, texto) {
  const clave = String(chatId);
  // Lo que se le pregunta al aparato se contesta en voz alta: una respuesta
  // larga tarda más en generarse y encima aburre escucharla.
  const porVoz = clave === "dispositivo";
  const turno = (turnos.get(clave) || 0) + 1;
  turnos.set(clave, turno);

  const mensajes = historial.get(clave) || [];
  mensajes.push({ role: "user", content: texto });

  const usadas = [];

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const r = await client.messages.create({
      model: porVoz ? MODELO_VOZ : MODELO,
      max_tokens: 4000,
      system: instrucciones() + (porVoz
        ? "\n\nEsto te lo están preguntando por voz y tu respuesta se va a " +
          "escuchar en un parlante. Contestá en UNA sola frase corta, como se " +
          "contesta hablando. Nada de listas ni de enumerar: si hay muchos " +
          "datos, decí el que importa. Si te piden que mandes algo, mandalo y " +
          "confirmá en pocas palabras.\n" +
          "Hablá con calidez, como alguien de confianza que está ahí al lado " +
          "en el mostrador. Un \"dale\", un \"listo\", un \"ahí va\" o un " +
          "\"ya está\" quedan bien. Sin exagerar: simpático, no payaso.\n" +
          "Nada de leer en voz alta como un informe: escribí como se habla, " +
          "con la frase corta y la entonación que usarías de verdad. Si te " +
          "saludan, devolvé el saludo y nada más; no arranques a dar datos " +
          "que no te pidieron."
        : ""),
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
        const dato = await ejecutar(b.name, b.input, { chatId: clave, turno });
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
  turnos.delete(String(chatId));
}

module.exports = { responder, olvidar, MODELO };

// Lee un comprobante de pago (transferencia / Mercado Pago) desde una imagen
// y devuelve los datos estructurados. Usa Claude Vision.

const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic(); // toma ANTHROPIC_API_KEY del entorno

const SCHEMA = {
  type: "object",
  properties: {
    monto: {
      type: "number",
      description: "Monto total transferido, en pesos argentinos. Solo el número.",
    },
    fecha: {
      type: "string",
      description: "Fecha de la operación en formato YYYY-MM-DD. Si no figura, la fecha de hoy.",
    },
    metodo: {
      type: "string",
      enum: ["transferencia", "mp", "efectivo", "tarjeta", "otro"],
      description:
        "Medio de pago. 'mp' si es Mercado Pago, 'transferencia' si es una transferencia bancaria (CBU/CVU/alias).",
    },
    referencia: {
      type: "string",
      description:
        "Número de operación, COELSA ID o ID de transacción. Cadena vacía si no aparece.",
    },
    destinatario: {
      type: "string",
      description:
        "Nombre o alias de quien recibe el dinero. Cadena vacía si no aparece.",
    },
    cbu_cvu: {
      type: "string",
      description:
        "CBU o CVU de destino, solo dígitos. Cadena vacía si no aparece.",
    },
    es_comprobante: {
      type: "boolean",
      description:
        "true solo si la imagen realmente es un comprobante de pago o transferencia. false para cualquier otra cosa.",
    },
    confianza: {
      type: "number",
      description:
        "Qué tan legible fue el comprobante, de 0 a 1. Bajá el valor si la foto está borrosa, cortada o si tuviste que adivinar algún dato.",
    },
  },
  required: [
    "monto",
    "fecha",
    "metodo",
    "referencia",
    "destinatario",
    "cbu_cvu",
    "es_comprobante",
    "confianza",
  ],
  additionalProperties: false,
};

const PROMPT = `Extraé los datos de este comprobante de pago argentino.

Reglas:
- El monto va sin separador de miles ni símbolo: 150000.50, no "$150.000,50".
- En Argentina el punto separa miles y la coma separa decimales. "1.500.000,00" son un millón y medio de pesos.
- Si ves varios montos, tomá el que corresponde al total transferido, no comisiones ni saldos.
- Si la imagen no es un comprobante de pago, poné es_comprobante en false y el resto en cero o cadena vacía.
- Si algún dato no está o no se lee, dejalo vacío y bajá la confianza. No inventes.`;

/**
 * @param {string} base64  imagen sin el prefijo data:
 * @param {string} mime    'image/jpeg' | 'image/png' | ...
 */
async function leerComprobante(base64, mime = "image/jpeg") {
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("No se pudo procesar la imagen");
  }

  const texto = response.content.find((b) => b.type === "text")?.text;
  if (!texto) throw new Error("Respuesta vacía al leer el comprobante");

  return JSON.parse(texto);
}

module.exports = { leerComprobante };

// routes/public.routes.js
const express = require("express");
const cors = require("cors");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");
const { avisarTelegram } = require("../services/telegram");
const { MARGEN_USD } = require("../services/catalogoProveedor");
const { stockParaMayoristas, stockPorClaves } = require("../services/stockMayorista");

// CORS SOLO para endpoints públicos
const publicCors = cors({ origin: "*", credentials: false });

/**
 * Busca una sucursal por texto libre, como llega desde el bot de Telegram
 * (@casa-martin, @north-punto-9). Compara normalizado —sin acentos, sin #,
 * sin guiones— porque si no un renombre rompe los comandos: "North Punto #2"
 * nunca iba a matchear con "casa martin" ni con "north punto 2".
 */
const normSuc = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

async function buscarSucursal(texto) {
  const buscado = normSuc(texto);
  if (!buscado) return null;

  const [filas] = await pool
    .promise()
    .query("SELECT id, nombre, apodo FROM sucursales");

  // Primero exacto por nombre o apodo, después por contención, para que
  // "central posadas" siga encontrando Central.
  const exacto = filas.find(
    (f) => normSuc(f.nombre) === buscado || normSuc(f.apodo) === buscado
  );
  if (exacto) return exacto;

  const contenida = filas.find(
    (f) =>
      (normSuc(f.nombre) && buscado.includes(normSuc(f.nombre))) ||
      (normSuc(f.apodo) && buscado.includes(normSuc(f.apodo)))
  );
  if (contenida) return contenida;

  // Al revés: "punto 9" para "North Punto #9". Solo si una sola sucursal
  // coincide — con dos o más se estaría adivinando, y adivinar mal acá
  // descuenta stock de la sucursal equivocada.
  if (buscado.length >= 4) {
    const parciales = filas.filter(
      (f) =>
        normSuc(f.nombre).includes(buscado) ||
        (normSuc(f.apodo) && normSuc(f.apodo).includes(buscado))
    );
    if (parciales.length === 1) return parciales[0];
  }

  return null;
}

// Helper para forzar respuesta JSON sin compresión (evita que Render/nginx gzipee)
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  const len = Buffer.byteLength(body, "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Encoding": "identity",
    "Content-Length": String(len),
    "Cache-Control": "no-transform, no-store",
    "Connection": "close",
  });
  res.end(body);
}

/* =========================
   Helpers
========================= */
function cleanPhone(raw) {
  // Acepta dígitos y '+'
  return String(raw || "").replace(/[^\d+]/g, "");
}
function toNullOrTrim(v) {
  const s = (v ?? "").toString().trim();
  return s ? s : null;
}

/* =========================
   Endpoints públicos
========================= */

/**
 * GET /public/sucursales
 * Lista pública de sucursales. Muestra el apodo si existe.
 * Devuelve: [{ id, nombre, nombre_real, apodo }]
 */
// Pedidos que llegan de /lista. Es un endpoint abierto —los mayoristas no
// tienen usuario— así que hay que cuidarlo a mano: un pedido por IP cada medio
// minuto, un tope de renglones y de unidades, y los SKU se validan contra el
// catálogo en vez de confiar en lo que llega.
const ultimoPedido = new Map();
const ESPERA_MS = 30 * 1000;
const MAX_RENGLONES = 200;
const MAX_POR_RENGLON = 999;

/**
 * POST /public/pedido-lista
 * Body: { quien, nota, items: [{ sku, cantidad }] }
 *
 * No lleva precios: el mayorista dice qué quiere y cuánto, y el precio se lo
 * pone Nahuel después al armar el pedido mayorista de verdad.
 */
router.post("/public/pedido-lista", publicCors, express.json({ limit: "256kb" }),
  async (req, res) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const ahora = Date.now();
    if (ahora - (ultimoPedido.get(ip) || 0) < ESPERA_MS) {
      return res.status(429).json({ error: "Esperá un momento antes de mandar otro pedido" });
    }

    const quien = String(req.body?.quien || "").trim().slice(0, 120);
    const nota = String(req.body?.nota || "").trim().slice(0, 500) || null;
    const crudos = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!quien) return res.status(400).json({ error: "Falta tu nombre" });
    if (!crudos.length) return res.status(400).json({ error: "El pedido está vacío" });
    if (crudos.length > MAX_RENGLONES) {
      return res.status(400).json({ error: "Demasiados productos en un mismo pedido" });
    }

    // Se juntan por SKU por si el mismo producto viene dos veces
    const pedido = new Map();
    for (const it of crudos) {
      const sku = String(it?.sku || "").trim().slice(0, 64);
      const cantidad = Math.floor(Number(it?.cantidad));
      if (!sku || !(cantidad > 0)) continue;
      pedido.set(sku, Math.min((pedido.get(sku) || 0) + cantidad, MAX_POR_RENGLON));
    }
    if (!pedido.size) return res.status(400).json({ error: "El pedido está vacío" });

    try {
      // El nombre sale del catálogo, no de lo que mande el navegador: así no se
      // puede pedir "100 unidades de <lo que a uno se le ocurra escribir>".
      // Un pedido puede traer de las dos secciones: lo que ya hay en Central y
      // lo que va a pedido. Se resuelven por separado porque son dos fuentes
      // distintas, y el precio y el nombre salen de ellas, nunca del navegador:
      // este manda qué y cuánto, jamás a cuánto.
      const claves = [...pedido.keys()];
      const deStock = claves.filter((k) => k.startsWith("stock-"));
      const deProveedor = claves.filter((k) => !k.startsWith("stock-"));

      const filas = [];

      if (deProveedor.length) {
        const [cat] = await pool.promise().query(
          `SELECT sku, nombre, ROUND(precio_usd + ?, 2) AS precio
             FROM catalogo_proveedor
            WHERE sku IN (?) AND presente = 1 AND hay = 1 AND precio_usd IS NOT NULL`,
          [MARGEN_USD, deProveedor]
        );
        for (const f of cat) filas.push({ ...f, origen: "proveedor" });
      }

      if (deStock.length) {
        for (const f of await stockPorClaves(deStock)) {
          // No se puede pedir más de lo que hay: es stock real, no un catálogo
          const pedida = pedido.get(f.clave);
          if (pedida > f.cantidad) pedido.set(f.clave, f.cantidad);
          filas.push({
            sku: f.clave,
            nombre: `${f.producto} — ${f.gusto}`,
            precio: f.precio,
            origen: "stock",
          });
        }
      }

      if (!filas.length) return res.status(400).json({ error: "No reconocí ningún producto" });

      const conn = await pool.promise().getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          "INSERT INTO pedidos_lista (quien, nota, fecha) VALUES (?, ?, NOW())",
          [quien, nota]
        );
        for (const f of filas) {
          await conn.query(
            `INSERT INTO pedidos_lista_items
               (pedido_id, sku, origen, nombre, precio_usd, cantidad)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [r.insertId, f.sku, f.origen, f.nombre, f.precio, pedido.get(f.sku)]
          );
        }
        await conn.commit();

        ultimoPedido.set(ip, ahora);

        const unidades = filas.reduce((a, f) => a + pedido.get(f.sku), 0);
        const plata = filas.reduce((a, f) => a + pedido.get(f.sku) * Number(f.precio || 0), 0);
        const renglon = (f) =>
          `${pedido.get(f.sku)}x ${f.nombre} — US$ ${Number(f.precio).toFixed(2)}`;
        const hay = filas.filter((f) => f.origen === "stock").map(renglon).sort();
        const aPedido = filas.filter((f) => f.origen === "proveedor").map(renglon).sort();

        avisarTelegram(
          `🧾 Pedido nuevo de ${quien}\n` +
          `${filas.length} productos · ${unidades} unidades · US$ ${plata.toFixed(2)}\n` +
          (hay.length ? `\nDE LO QUE HAY\n${hay.join("\n")}\n` : "") +
          (aPedido.length ? `\nA PEDIDO\n${aPedido.join("\n")}\n` : "") +
          (nota ? `\nNota: ${nota}` : "")
        );

        res.json({ ok: true, id: r.insertId, productos: filas.length, unidades,
                   total_usd: Number(plata.toFixed(2)) });
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    } catch (e) {
      console.error("❌ POST /public/pedido-lista:", e);
      res.status(500).json({ error: "No pude guardar el pedido" });
    }
  }
);

/**
 * GET /pedidos-lista — lo que pidieron los mayoristas desde /lista.
 *
 * Esto sí es privado: lleva los precios con los que se cotizó y quién pidió.
 */
router.get("/pedidos-lista", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo admin" });

  const limite = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
  try {
    const [pedidos] = await pool.promise().query(
      `SELECT p.id, p.quien, p.nota, p.estado, p.fecha,
              COUNT(i.id) AS productos,
              COALESCE(SUM(i.cantidad), 0) AS unidades,
              ROUND(COALESCE(SUM(i.cantidad * i.precio_usd), 0), 2) AS total_usd
         FROM pedidos_lista p
         LEFT JOIN pedidos_lista_items i ON i.pedido_id = p.id
        GROUP BY p.id
        ORDER BY p.id DESC
        LIMIT ?`, [limite]);

    if (pedidos.length) {
      const [items] = await pool.promise().query(
        `SELECT pedido_id, sku, origen, nombre, precio_usd, cantidad
           FROM pedidos_lista_items
          WHERE pedido_id IN (?)
          ORDER BY nombre`, [pedidos.map((p) => p.id)]);
      const porPedido = new Map();
      for (const it of items) {
        if (!porPedido.has(it.pedido_id)) porPedido.set(it.pedido_id, []);
        porPedido.get(it.pedido_id).push(it);
      }
      for (const p of pedidos) p.items = porPedido.get(p.id) || [];
    }

    res.json(pedidos);
  } catch (e) {
    console.error("❌ GET /pedidos-lista:", e);
    res.status(500).json({ error: "Error al listar pedidos" });
  }
});

/** PUT /pedidos-lista/:id — mover el estado (visto, cotizado, cerrado). */
router.put("/pedidos-lista/:id", authenticate, async (req, res) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo admin" });

  const estados = ["nuevo", "visto", "cotizado", "cerrado"];
  const estado = String(req.body?.estado || "");
  if (!estados.includes(estado)) return res.status(400).json({ error: "Estado inválido" });

  try {
    const [r] = await pool.promise().query(
      "UPDATE pedidos_lista SET estado = ? WHERE id = ?", [estado, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: "No existe ese pedido" });
    res.json({ ok: true, estado });
  } catch (e) {
    console.error("❌ PUT /pedidos-lista:", e);
    res.status(500).json({ error: "No pude cambiar el estado" });
  }
});

/**
 * GET /public/lista-proveedor
 * Qué modelos y gustos tiene el proveedor, agrupado y sin un solo precio.
 *
 * Es para pasarle a los mayoristas: lo único que necesitan saber es qué se
 * puede pedir. El precio lo pone Nahuel cuando arma el pedido, así que acá no
 * viaja ni el costo ni la venta.
 */
router.get("/public/lista-proveedor", publicCors, async (_req, res) => {
  try {
    const [filas] = await pool.promise().query(
      // Solo lo que el proveedor tiene: una lista de pedidos con cosas que no
      // se pueden pedir hace perder el tiempo al que la lee y obliga a
      // contestar que no después.
      `SELECT modelo, gusto, hay, ROUND(precio_usd + ?, 2) AS precio
         FROM catalogo_proveedor
        WHERE presente = 1 AND hay = 1 AND precio_usd IS NOT NULL
        ORDER BY modelo, gusto`, [MARGEN_USD]
    );
    const [[info]] = await pool.promise().query(
      "SELECT MAX(visto) AS actualizado FROM catalogo_proveedor WHERE presente = 1 AND hay = 1"
    );

    const modelos = [];
    for (const f of filas) {
      let m = modelos[modelos.length - 1];
      if (!m || m.modelo !== f.modelo) {
        m = { modelo: f.modelo, gustos: [] };
        modelos.push(m);
      }
      m.gustos.push({ gusto: f.gusto, hay: Boolean(f.hay) });
    }

    res.json({ actualizado: info.actualizado, total: filas.length, modelos });
  } catch (e) {
    console.error("❌ GET /public/lista-proveedor:", e);
    res.status(500).json({ error: "error" });
  }
});

/**
 * GET /lista
 * La misma lista pero como página, que es lo que se manda por WhatsApp.
 *
 * Se arma acá y no en el frontend de React a propósito: es un link que se pasa
 * a gente de afuera, tiene que abrir en un segundo en cualquier teléfono y no
 * depende de que haya que deployar otra cosa más.
 */
router.get("/lista", publicCors, async (_req, res) => {
  try {
    const [filas] = await pool.promise().query(
      // Solo lo que el proveedor tiene en stock
      `SELECT sku, nombre, modelo, gusto, hay,
              ROUND(precio_usd + ?, 2) AS precio
         FROM catalogo_proveedor
        WHERE presente = 1 AND hay = 1 AND precio_usd IS NOT NULL
        ORDER BY modelo, gusto`, [MARGEN_USD]
    );
    const [[info]] = await pool.promise().query(
      "SELECT MAX(visto) AS actualizado FROM catalogo_proveedor WHERE presente = 1 AND hay = 1"
    );
    const propio = await stockParaMayoristas();

    const esc = (t) => String(t).replace(/[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

    /**
     * Un renglón con su contador.
     *
     * El contador va en los dos modos de la lista y el mismo producto aparece
     * en ambos, así que cada uno lleva su SKU: lo que se escribe en uno se
     * refleja en el otro sin tener que redibujar nada.
     */
    const fila = (f, texto, conBusca) =>
      `<li class="${f.hay ? "" : "no"}"${
        conBusca ? ` data-busca="${esc(f.nombre.toLowerCase())}"` : ""}>` +
      `<span class="que">${esc(texto)}</span>` +
      `<span class="precio">US$ ${Number(f.precio).toFixed(2).replace(".", ",")}</span>` +
      `<span class="cont" data-sku="${esc(f.sku)}" data-precio="${Number(f.precio)}">` +
        `<button class="menos" aria-label="Quitar uno">−</button>` +
        `<input type="number" min="0" max="999" value="" inputmode="numeric" placeholder="0">` +
        `<button class="mas" aria-label="Agregar uno">+</button>` +
      `</span></li>`;

    // Lo que hay en Central, agrupado por modelo. Va con la cantidad a la
    // vista: en esta sección el número importa, porque es lo que queda.
    const porProducto = new Map();
    for (const f of propio) {
      if (!porProducto.has(f.producto)) porProducto.set(f.producto, []);
      porProducto.get(f.producto).push(f);
    }
    const seccionStock = [...porProducto.entries()].map(([producto, gustos]) => {
      const items = gustos.map((g) =>
        `<li data-busca="${esc((producto + " " + g.gusto).toLowerCase())}">` +
        `<span class="que">${esc(g.gusto)}<span class="quedan">${g.cantidad}</span></span>` +
        `<span class="precio">US$ ${g.precio.toFixed(2).replace(".", ",")}</span>` +
        `<span class="cont" data-sku="${esc(g.clave)}" data-precio="${g.precio}"` +
        ` data-tope="${g.cantidad}">` +
          `<button class="menos" aria-label="Quitar uno">−</button>` +
          `<input type="number" min="0" max="${g.cantidad}" value="" inputmode="numeric" placeholder="0">` +
          `<button class="mas" aria-label="Agregar uno">+</button>` +
        `</span></li>`).join("");
      return `<section data-busca="${esc((producto + " " +
        gustos.map((g) => g.gusto).join(" ")).toLowerCase())}">
        <h2>${esc(producto)} <span>${gustos.length}</span></h2>
        <ul>${items}</ul></section>`;
    }).join("");

    const porModelo = new Map();
    for (const f of filas) {
      if (!porModelo.has(f.modelo)) porModelo.set(f.modelo, []);
      porModelo.get(f.modelo).push(f);
    }

    const cuando = info.actualizado
      ? new Date(info.actualizado).toLocaleString("es-AR",
          { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
      : "nunca";

    const secciones = [...porModelo.entries()].map(([modelo, gustos]) => {
      const items = gustos.map((g) => fila(g, g.gusto || "—")).join("");
      return `<section data-busca="${esc((modelo + " " +
        gustos.map((g) => g.gusto).join(" ")).toLowerCase())}">
        <h2>${esc(modelo)} <span>${gustos.length}</span></h2>
        <ul>${items}</ul></section>`;
    }).join("");

    // La misma cosa de corrido, por si se busca de a uno. Van las dos armadas y
    // se cambia con el botón: son los mismos datos, no hay nada que volver a
    // pedir, y así no hay que elegir una por todos.
    const corrida = [...filas]
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
      .map((f) => fila(f, f.nombre, true))
      .join("");

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lista de pedidos — The North Shop</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: #0b0f14; color: #e6edf3;
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { max-width: 760px; margin: 0 auto 18px; }
  h1 { font-size: 1.35rem; margin: 0 0 4px; }
  .sub { color: #8b98a5; font-size: .85rem; }
  #buscar { width: 100%; max-width: 760px; margin: 0 auto 20px; display: block;
            padding: 12px 14px; border-radius: 10px; border: 1px solid #243040;
            background: #121922; color: #e6edf3; font-size: 1rem; }
  main { max-width: 760px; margin: 0 auto; }
  section { margin-bottom: 22px; }
  h2 { font-size: .95rem; text-transform: uppercase; letter-spacing: .5px;
       color: #7dd3fc; margin: 0 0 8px; border-bottom: 1px solid #1d2733;
       padding-bottom: 6px; }
  h2 span { color: #64748b; font-weight: 400; }
  /* Una sola columna: el renglón ya no es un nombre suelto, lleva precio y
     contador, y en dos columnas el nombre se parte letra por letra. */
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 5px 0; font-size: .95rem;
       display: flex; align-items: center; gap: 10px; justify-content: space-between; }
  .que { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .precio { flex: none; font-size: .9rem; color: #7dd3fc; font-variant-numeric: tabular-nums;
            min-width: 66px; text-align: right; }
  .cont { display: flex; align-items: center; gap: 2px; flex: none; }
  .cont button { width: 30px; height: 30px; border-radius: 7px; cursor: pointer;
                 border: 1px solid #243040; background: #121922; color: #9fb3c8;
                 font-size: 1.05rem; line-height: 1; padding: 0; font-family: inherit; }
  .cont button:active { background: #1d4ed8; color: #fff; }
  .cont input { width: 44px; height: 30px; text-align: center; border-radius: 7px;
                border: 1px solid #243040; background: #0e141c; color: #e6edf3;
                font-size: .9rem; font-family: inherit; -moz-appearance: textfield; }
  .cont input::-webkit-outer-spin-button,
  .cont input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  li.elegido { background: #0f1b2d; border-radius: 8px; padding-left: 8px; padding-right: 4px; }
  li.elegido .cont input { border-color: #1d4ed8; color: #fff; font-weight: 600; }
  #corrida { list-style: none; margin: 0; padding: 0; display: block; }
  #corrida li { border-bottom: 1px solid #141c26; padding: 7px 0; }
  .modo { max-width: 760px; margin: 0 auto 16px; display: flex; gap: 8px; }
  .modo button { flex: 1; padding: 9px; border-radius: 9px; cursor: pointer;
                 border: 1px solid #243040; background: #121922; color: #8b98a5;
                 font-size: .9rem; font-family: inherit; }
  .modo button.activo { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
  .modo button span { opacity: .65; font-size: .8rem; }
  .submodo { max-width: 760px; margin: 0 auto 14px; display: flex; gap: 6px; }
  .submodo button { flex: 1; padding: 6px; border-radius: 7px; cursor: pointer;
                    border: 1px solid #1d2733; background: transparent; color: #64748b;
                    font-size: .8rem; font-family: inherit; }
  .submodo button.activo { color: #e6edf3; border-color: #334155; background: #121922; }
  .quedan { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 20px;
            background: #14532d; color: #86efac; font-size: .72rem; vertical-align: middle; }
  .nada2 { color: #8b98a5; text-align: center; padding: 30px 0; }
  li.no { color: #64748b; text-decoration: line-through; }
  .nada { color: #8b98a5; text-align: center; padding: 30px 0; display: none; }
  footer { max-width: 760px; margin: 30px auto 110px; color: #64748b;
           font-size: .8rem; text-align: center; }
  #barra { position: fixed; left: 0; right: 0; bottom: 0; background: #0d141dee;
           backdrop-filter: blur(8px); border-top: 1px solid #1d2733;
           padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
           display: none; }
  #barra.hay { display: block; }
  #barra .adentro { max-width: 760px; margin: 0 auto; display: flex;
                    align-items: center; gap: 12px; }
  #resumen { flex: 1; font-size: .88rem; color: #cbd5e1; }
  #resumen b { color: #fff; }
  .plata { color: #7dd3fc; font-weight: 700; font-size: 1.05rem; }
  #enviar { padding: 11px 20px; border: none; border-radius: 9px; cursor: pointer;
            background: #1d4ed8; color: #fff; font-size: .95rem; font-weight: 600;
            font-family: inherit; }
  #vaciar { background: none; border: none; color: #64748b; cursor: pointer;
            font-size: .82rem; font-family: inherit; text-decoration: underline; }
  dialog { border: 1px solid #243040; border-radius: 14px; background: #0f1620;
           color: #e6edf3; padding: 20px; width: min(420px, calc(100vw - 32px)); }
  dialog::backdrop { background: #000a; }
  dialog h3 { margin: 0 0 4px; font-size: 1.05rem; }
  dialog p { margin: 0 0 16px; color: #8b98a5; font-size: .85rem; }
  dialog label { display: block; font-size: .82rem; color: #9fb3c8; margin-bottom: 5px; }
  dialog input, dialog textarea { width: 100%; padding: 10px 12px; margin-bottom: 14px;
           border-radius: 9px; border: 1px solid #243040; background: #121922;
           color: #e6edf3; font-size: .95rem; font-family: inherit; }
  dialog textarea { resize: vertical; min-height: 60px; }
  .acciones { display: flex; gap: 8px; justify-content: flex-end; }
  .acciones button { padding: 10px 18px; border-radius: 9px; cursor: pointer;
           font-size: .9rem; font-family: inherit; border: 1px solid #243040;
           background: #121922; color: #9fb3c8; }
  .acciones button.ok { background: #1d4ed8; border-color: #1d4ed8;
           color: #fff; font-weight: 600; }
  .acciones button[disabled] { opacity: .5; cursor: default; }
  #listo { text-align: center; padding: 40px 0; display: none; }
  #listo .tilde { font-size: 2.6rem; }
  #listo h2 { border: none; color: #4ade80; font-size: 1.1rem; }
</style></head>
<body>
<header>
  <h1>Lista de pedidos</h1>
  <div class="sub">${propio.length} para entrega inmediata · ${filas.length} a pedido ·
    actualizada el ${esc(cuando)}</div>
</header>
<input id="buscar" type="search" placeholder="Buscar modelo o gusto..." autocomplete="off">
<div class="modo">
  <button id="btnHay" class="activo">Hay ahora <span>${propio.length}</span></button>
  <button id="btnPedido">A pedido <span>${filas.length}</span></button>
</div>

<main>
  <div id="hay">${seccionStock || '<p class="nada2">No hay stock cargado en Central.</p>'}</div>

  <div id="pedido" style="display:none">
    <div class="submodo">
      <button id="btnLista" class="activo">Todo junto</button>
      <button id="btnModelos">Por modelo</button>
    </div>
    <ul id="corrida">${corrida}</ul>
    <div id="agrupado" style="display:none">${secciones}</div>
  </div>

  <div class="nada">No encontré nada con eso.</div>
</main>
<footer>Precios en dólares, por unidad. Solo lo que hay.
Se actualiza sola varias veces por día.</footer>

<div id="listo">
  <div class="tilde">✓</div>
  <h2>Pedido mandado</h2>
  <p>Te escribimos por WhatsApp para coordinar.</p>
</div>

<div id="barra"><div class="adentro">
  <span id="resumen"></span>
  <button id="vaciar">Vaciar</button>
  <button id="enviar">Enviar pedido</button>
</div></div>

<dialog id="dialogo">
  <h3>Mandar el pedido</h3>
  <p id="queVa"></p>
  <label for="quien">¿Quién pide?</label>
  <input id="quien" maxlength="120" placeholder="Tu nombre o el del negocio" autocomplete="name">
  <label for="nota">Algo para aclarar (opcional)</label>
  <textarea id="nota" maxlength="500" placeholder="Cuándo lo necesitás, cómo lo retirás..."></textarea>
  <div class="acciones">
    <button id="cancelar">Cancelar</button>
    <button id="confirmar" class="ok">Mandar</button>
  </div>
</dialog>
<script>
  const campo = document.getElementById("buscar");
  const sueltos = [...document.querySelectorAll("#corrida li")];
  const bloques = [...document.querySelectorAll("#agrupado section")];
  const bloquesHay = [...document.querySelectorAll("#hay section")];
  const corrida = document.getElementById("corrida");
  const agrupado = document.getElementById("agrupado");
  const nada = document.querySelector(".nada");
  const btnLista = document.getElementById("btnLista");
  const btnModelos = document.getElementById("btnModelos");
  const btnHay = document.getElementById("btnHay");
  const btnPedido = document.getElementById("btnPedido");
  const panelHay = document.getElementById("hay");
  const panelPedido = document.getElementById("pedido");
  let porModelo = false;
  let enStock = true;

  function filtrar() {
    const q = campo.value.trim().toLowerCase();
    const cuales = enStock ? bloquesHay : (porModelo ? bloques : sueltos);
    let visibles = 0;
    for (const el of cuales) {
      const ok = !q || el.dataset.busca.includes(q);
      el.style.display = ok ? "" : "none";
      if (ok) visibles++;
    }
    nada.style.display = visibles ? "none" : "block";
  }

  function modo(agrupar) {
    porModelo = agrupar;
    corrida.style.display = agrupar ? "none" : "block";
    agrupado.style.display = agrupar ? "block" : "none";
    btnModelos.classList.toggle("activo", agrupar);
    btnLista.classList.toggle("activo", !agrupar);
    filtrar();
  }

  function seccion(stock) {
    enStock = stock;
    panelHay.style.display = stock ? "block" : "none";
    panelPedido.style.display = stock ? "none" : "block";
    btnHay.classList.toggle("activo", stock);
    btnPedido.classList.toggle("activo", !stock);
    filtrar();
  }

  campo.addEventListener("input", filtrar);
  btnLista.addEventListener("click", () => modo(false));
  btnModelos.addEventListener("click", () => modo(true));
  btnHay.addEventListener("click", () => seccion(true));
  btnPedido.addEventListener("click", () => seccion(false));

  // ── El pedido ──────────────────────────────────────────────────────────
  // Lo elegido vive en un solo lugar y los contadores son su reflejo. El mismo
  // producto aparece en los dos modos de la lista, así que si cada input
  // guardara su propio número, pasar de "todo junto" a "por modelo" mostraría
  // cantidades distintas para la misma cosa.
  const CLAVE = "pedido-north";
  let elegido = {};
  try { elegido = JSON.parse(localStorage.getItem(CLAVE) || "{}"); } catch (e) {}

  const conts = [...document.querySelectorAll(".cont")];

  // Precio por SKU, una sola vez. Sumar recorriendo los contadores contaba
  // doble: cada producto tiene uno en "todo junto" y otro en "por modelo".
  const precios = {};
  for (const c of conts) precios[c.dataset.sku] = Number(c.dataset.precio || 0);

  // Lo guardado puede tener productos que ya no están: el proveedor los agotó
  // o los sacó desde la última vez que entró. Se limpian al abrir, porque si
  // no siguen sumando unidades al total sin aparecer en ningún renglón, y se
  // irían en el pedido sin que nadie los vea.
  let sobraron = 0;
  for (const sku of Object.keys(elegido)) {
    if (!(sku in precios)) { delete elegido[sku]; sobraron++; }
  }
  if (sobraron) {
    guardar();
    console.log(sobraron + " producto(s) del pedido ya no están en la lista");
  }

  const cuanto = () => Object.keys(elegido)
    .reduce((a, sku) => a + elegido[sku] * (precios[sku] || 0), 0);
  const enPlata = (n) => "US$ " + n.toFixed(2).replace(".", ",");
  const barra = document.getElementById("barra");
  const resumen = document.getElementById("resumen");
  const dialogo = document.getElementById("dialogo");
  const queVa = document.getElementById("queVa");
  const confirmar = document.getElementById("confirmar");

  function guardar() {
    try { localStorage.setItem(CLAVE, JSON.stringify(elegido)); } catch (e) {}
  }

  function pintar() {
    for (const c of conts) {
      const n = elegido[c.dataset.sku] || 0;
      const input = c.querySelector("input");
      if (document.activeElement !== input) input.value = n || "";
      c.closest("li").classList.toggle("elegido", n > 0);
    }
    const skus = Object.keys(elegido);
    const unidades = skus.reduce((a, k) => a + elegido[k], 0);
    barra.classList.toggle("hay", skus.length > 0);
    // Sin template literals: este script viaja adentro de uno del servidor, y
    // los $ con llave los interpolaría Node antes de que llegue al navegador.
    resumen.innerHTML = "<b>" + skus.length + "</b> producto" +
      (skus.length === 1 ? "" : "s") + " · <b>" + unidades + "</b> unidad" +
      (unidades === 1 ? "" : "es") +
      '<br><span class="plata">' + enPlata(cuanto()) + "</span>";
  }

  // Lo que hay en Central es stock real: no se puede pedir más de lo que queda.
  // El catálogo del proveedor no tiene tope porque no es stock nuestro.
  const topes = {};
  for (const c of conts) if (c.dataset.tope) topes[c.dataset.sku] = Number(c.dataset.tope);

  function poner(sku, n) {
    n = Math.max(0, Math.min(topes[sku] || 999, Math.floor(n) || 0));
    if (n) elegido[sku] = n; else delete elegido[sku];
    guardar();
    pintar();
  }

  for (const c of conts) {
    const sku = c.dataset.sku;
    c.querySelector(".menos").addEventListener("click",
      () => poner(sku, (elegido[sku] || 0) - 1));
    c.querySelector(".mas").addEventListener("click",
      () => poner(sku, (elegido[sku] || 0) + 1));
    c.querySelector("input").addEventListener("input",
      (e) => poner(sku, Number(e.target.value)));
  }

  document.getElementById("vaciar").addEventListener("click", () => {
    if (!confirm("¿Borrar todo el pedido?")) return;
    elegido = {};
    guardar();
    pintar();
  });

  document.getElementById("enviar").addEventListener("click", () => {
    const skus = Object.keys(elegido);
    const unidades = skus.reduce((a, k) => a + elegido[k], 0);
    queVa.textContent = skus.length + " producto" + (skus.length === 1 ? "" : "s") +
      ", " + unidades + " unidad" + (unidades === 1 ? "" : "es") +
      ", " + enPlata(cuanto()) + ".";
    document.getElementById("quien").value = localStorage.getItem("quien-north") || "";
    dialogo.showModal();
  });

  document.getElementById("cancelar").addEventListener("click", () => dialogo.close());

  confirmar.addEventListener("click", async () => {
    const quien = document.getElementById("quien").value.trim();
    if (!quien) { document.getElementById("quien").focus(); return; }

    confirmar.disabled = true;
    confirmar.textContent = "Mandando...";
    try {
      const r = await fetch("/public/pedido-lista", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quien,
          nota: document.getElementById("nota").value.trim(),
          items: Object.keys(elegido).map((sku) => ({ sku, cantidad: elegido[sku] })),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "No se pudo mandar");

      // Recién acá se borra: si falló, el pedido sigue entero y se puede
      // reintentar sin volver a marcar ochenta productos.
      localStorage.setItem("quien-north", quien);
      elegido = {};
      guardar();
      dialogo.close();
      document.querySelector("main").style.display = "none";
      document.querySelector(".modo").style.display = "none";
      campo.style.display = "none";
      barra.classList.remove("hay");
      document.getElementById("listo").style.display = "block";
    } catch (e) {
      alert(e.message);
    } finally {
      confirmar.disabled = false;
      confirmar.textContent = "Mandar";
    }
  });

  pintar();
</script>
</body></html>`);
  } catch (e) {
    console.error("❌ GET /lista:", e);
    res.status(500).send("No pude armar la lista.");
  }
});

router.get("/public/sucursales", publicCors, async (_req, res) => {
  try {
    const [rows] = await pool.promise().query(`
        SELECT
          id,
          COALESCE(apodo, nombre) AS nombre,  -- nombre para mostrar
          nombre AS nombre_real,
          apodo
        FROM sucursales
        WHERE activo = 1
        ORDER BY nombre ASC
      `);
    res.json(rows);
  } catch (err) {
    console.error(
      "GET /public/sucursales error:",
      err.sqlMessage || err.message
    );
    res.status(500).json({ error: "No se pudieron traer las sucursales" });
  }
});

// =========================
// 📦 Registrar venta pública
// =========================
router.post("/public/registrar-venta", publicCors, async (req, res) => {
  let conn;
  try {
    let {
      modelo,
      serie,
      gusto,
      barcode,
      cantidad = 1,
      sucursal,
    } = req.body || {};

    // 1️⃣ Validaciones mínimas
    if (!sucursal)
      return sendJson(res, 400, { ok: false, msg: "Sucursal requerida" });
    if (!barcode && !gusto && !modelo)
      return sendJson(res, 400, {
        ok: false,
        msg: "Faltan datos. Enviá 'barcode' o al menos 'gusto' / 'modelo'.",
      });

    // 2️⃣ Normalizaciones
    sucursal = String(sucursal).toLowerCase().trim();
    cantidad = Number(cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0)
      return sendJson(res, 400, { ok: false, msg: "Cantidad inválida" });

    if (!barcode) {
      modelo = modelo ? String(modelo).toLowerCase().trim() : "";
      serie  = serie  ? String(serie).toLowerCase().trim()  : "";
      gusto  = gusto  ? String(gusto).toLowerCase().trim()  : "";
    } else {
      barcode = String(barcode).trim();
      if (!barcode)
        return sendJson(res, 400, { ok: false, msg: "Código de barras inválido" });
    }

    // 3️⃣ Conexión + Transacción
    conn = await pool.promise().getConnection();
    await conn.beginTransaction();

    // 🔹 Buscar sucursal (por nombre, apodo o id numérico)
    const encontrada = await buscarSucursal(sucursal);
    const sucRows = encontrada ? [encontrada] : [];
    if (!sucRows.length) {
      await conn.rollback();
      return sendJson(res, 404, { ok: false, msg: `Sucursal no encontrada: "${sucursal}"` });
    }
    const sucursal_id = sucRows[0].id;
    const sucursal_nombre = sucRows[0].nombre;

    // 🔹 Resolver producto/gusto
    let producto_id, gusto_id, producto_nombre_found, gusto_nombre_found;

    if (barcode) {
      // A) Buscar por código de barras
      const [rows] = await conn.query(
        `SELECT g.id AS gusto_id, g.producto_id, g.nombre AS gusto_nombre, p.nombre AS producto_nombre
         FROM gustos g
         JOIN productos p ON p.id = g.producto_id
         WHERE g.codigo_barra = ?
         LIMIT 1`,
        [barcode]
      );
      if (!rows.length) {
        await conn.rollback();
        return sendJson(res, 404, { ok: false, msg: `Código de barras no encontrado: ${barcode}` });
      }
      gusto_id = rows[0].gusto_id;
      producto_id = rows[0].producto_id;
      producto_nombre_found = rows[0].producto_nombre;
      gusto_nombre_found = rows[0].gusto_nombre;
    } else {
      // B) Búsqueda por texto con múltiples fallbacks
      const modeloNS = modelo.replace(/[\s-]+/g, "");
      const serieNS  = serie.replace(/[\s-]+/g, "");
      const gustoTxt = gusto;

      const normSql = `REPLACE(REPLACE(REPLACE(LOWER(CONCAT(p.nombre,' ',g.nombre)), ' ', ''), '-', ''), 'puffs', '')`;
      const selectCols = `g.id AS gusto_id, g.producto_id, g.nombre AS gusto_nombre, p.nombre AS producto_nombre`;

      let found = null;

      // T1: modelo + serie + gusto
      if (modeloNS && serieNS && gustoTxt) {
        const [t1] = await conn.query(
          `SELECT ${selectCols} FROM gustos g JOIN productos p ON p.id = g.producto_id
           WHERE ${normSql} LIKE ? AND ${normSql} LIKE ? AND LOWER(g.nombre) LIKE ? LIMIT 1`,
          [`%${modeloNS}%`, `%${serieNS}%`, `%${gustoTxt}%`]
        );
        if (t1.length) found = t1[0];
      }

      // T2: serie + gusto
      if (!found && serieNS && gustoTxt) {
        const [t2] = await conn.query(
          `SELECT ${selectCols} FROM gustos g JOIN productos p ON p.id = g.producto_id
           WHERE ${normSql} LIKE ? AND LOWER(g.nombre) LIKE ? LIMIT 1`,
          [`%${serieNS}%`, `%${gustoTxt}%`]
        );
        if (t2.length) found = t2[0];
      }

      // T3: modelo + gusto
      if (!found && modeloNS && gustoTxt) {
        const [t3] = await conn.query(
          `SELECT ${selectCols} FROM gustos g JOIN productos p ON p.id = g.producto_id
           WHERE ${normSql} LIKE ? AND LOWER(g.nombre) LIKE ? LIMIT 1`,
          [`%${modeloNS}%`, `%${gustoTxt}%`]
        );
        if (t3.length) found = t3[0];
      }

      // T4: solo gusto (más amplio, último recurso)
      if (!found && gustoTxt) {
        const [t4] = await conn.query(
          `SELECT ${selectCols} FROM gustos g JOIN productos p ON p.id = g.producto_id
           WHERE LOWER(g.nombre) LIKE ? LIMIT 1`,
          [`%${gustoTxt}%`]
        );
        if (t4.length) found = t4[0];
      }

      if (!found) {
        await conn.rollback();
        const terminos = [modelo, serie, gusto].filter(Boolean).join(" / ");
        return sendJson(res, 404, { ok: false, msg: `Producto no encontrado: "${terminos}". Verificá el nombre o usá el código de barras.` });
      }

      gusto_id = found.gusto_id;
      producto_id = found.producto_id;
      producto_nombre_found = found.producto_nombre;
      gusto_nombre_found = found.gusto_nombre;
    }

    // 🔹 Verificar stock (modelo de movimientos)
    await conn.query(
      `SELECT id FROM stock WHERE sucursal_id=? AND gusto_id=? FOR UPDATE`,
      [sucursal_id, gusto_id]
    );

    const [[saldo]] = await conn.query(
      `SELECT COALESCE(SUM(cantidad),0) AS stock_disponible
       FROM stock
       WHERE sucursal_id=? AND gusto_id=?`,
      [sucursal_id, gusto_id]
    );

    const stockDisponible = Number(saldo.stock_disponible) || 0;
    if (stockDisponible < cantidad) {
      await conn.rollback();
      return sendJson(res, 400, { ok: false, msg: `Stock insuficiente en la sucursal. Disponible: ${stockDisponible}` });
    }

    // 🔹 Registrar venta (usa precio actual del último movimiento)
    const [[precioRow]] = await conn.query(
      `SELECT precio FROM stock 
       WHERE gusto_id = ? AND sucursal_id = ? 
       ORDER BY id DESC LIMIT 1`,
      [gusto_id, sucursal_id]
    );
    const precioUnit = precioRow?.precio || 0;

    const [ventaRes] = await conn.query(
      `INSERT INTO ventas (gusto_id, sucursal_id, cantidad, precio_unitario, fecha)
       VALUES (?, ?, ?, ?, NOW())`,
      [gusto_id, sucursal_id, cantidad, precioUnit]
    );

    // 🔹 Registrar movimiento de stock negativo
    await conn.query(
      `INSERT INTO stock (gusto_id, sucursal_id, cantidad, precio)
       VALUES (?, ?, ?, NULL)`,
      [gusto_id, sucursal_id, -cantidad]
    );

    await conn.commit();

    // ✅ Éxito
    return sendJson(res, 200, {
      ok: true,
      msg: "Venta registrada correctamente",
      data: {
        venta_id: ventaRes.insertId,
        producto_id,
        gusto_id,
        sucursal_id,
        sucursal_nombre,
        producto_nombre: producto_nombre_found,
        gusto_nombre: gusto_nombre_found,
        cantidad,
        precio_unitario: precioUnit,
        metodo: barcode ? "barcode" : "texto",
        stock_restante: stockDisponible - cantidad,
      },
    });
  } catch (err) {
    if (conn)
      try {
        await conn.rollback();
      } catch {}
    console.error("❌ POST /public/registrar-venta error:", err.message);
    return sendJson(res, 500, { ok: false, msg: "Error interno del servidor" });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * GET /public/productos
 * Catálogo público por gusto. Parámetros opcionales:
 *   - sucursal_id: filtra stock/precio por esa sucursal
 *   - inStock=1  : devuelve solo con stock > 0
 */
router.get("/public/productos", publicCors, async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id
      ? Number(req.query.sucursal_id)
      : null;
    const onlyInStock = req.query.inStock === "1";

    const sql = `
      WITH agg AS (
        SELECT
          st.gusto_id,
          SUM(st.cantidad) AS stock_raw,
          MAX(st.precio)   AS precio_raw
        FROM stock st
        ${sucursalId ? "WHERE st.sucursal_id = ?" : ""}
        GROUP BY st.gusto_id
      )
      SELECT
        g.id AS id,
        CONCAT(
          TRIM(REPLACE(REPLACE(p.nombre, CHAR(9), ' '), '  ', ' ')),
          ' - ',
          TRIM(REPLACE(REPLACE(g.nombre, CHAR(9), ' '), '  ', ' '))
        ) AS nombre,
        CAST(agg.stock_raw  AS UNSIGNED)        AS stock,
        CAST(agg.precio_raw AS DECIMAL(10,2))   AS precio
      FROM gustos g
      JOIN productos p ON p.id = g.producto_id
      JOIN agg        ON agg.gusto_id = g.id
      ${onlyInStock ? "HAVING stock > 0" : ""}
      ORDER BY p.nombre ASC, g.nombre ASC
      LIMIT 500;
    `;

    const params = sucursalId ? [sucursalId] : [];
    const [rows] = await pool.promise().query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(
      "GET /public/productos error:",
      err.sqlMessage || err.message
    );
    res.status(500).json({ error: "No se pudieron traer los productos" });
  }
});

// routes/public.routes.js
router.get(
  "/public/todos-en-stock-por-sucursal",
  publicCors,
  async (req, res) => {
    let conn;
    try {
      conn = await pool.getConnection();

      // Paginación opcional (por si tu dataset es grande)
      const pageSize = Math.min(
        Math.max(parseInt(req.query.pageSize) || 1000, 1),
        5000
      );
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const offset = (page - 1) * pageSize;

      const sql = `
      WITH agg AS (
        SELECT
          st.gusto_id,
          st.sucursal_id,
          SUM(st.cantidad) AS stock_raw
        FROM stock st
        GROUP BY st.gusto_id, st.sucursal_id
      )
      SELECT
        g.id AS id,
        CONCAT(
          TRIM(REPLACE(REPLACE(p.nombre, CHAR(9), ' '), '  ', ' ')),
          ' - ',
          TRIM(REPLACE(REPLACE(g.nombre, CHAR(9), ' '), '  ', ' '))
        ) AS nombre,
        CAST(agg.stock_raw AS UNSIGNED) AS stock,
        LOWER(s.nombre) AS sucursal
      FROM agg
      JOIN gustos g      ON g.id = agg.gusto_id
      JOIN productos p   ON p.id = g.producto_id
      JOIN sucursales s  ON s.id = agg.sucursal_id
      HAVING stock > 0
      ORDER BY p.nombre ASC, g.nombre ASC, s.nombre ASC
      LIMIT ? OFFSET ?;
    `;

      const [rows] = await conn.query(sql, [pageSize, offset]);

      res.json({
        ok: true,
        page,
        pageSize,
        count: rows.length,
        items: rows, // [{ id, nombre, stock, sucursal }]
      });
    } catch (err) {
      console.error(
        "GET /public/todos-en-stock-por-sucursal error:",
        err.sqlMessage || err.message
      );
      res
        .status(500)
        .json({ ok: false, msg: "No se pudo consultar el stock por sucursal" });
    } finally {
      if (conn) conn.release();
    }
  }
);

/**
 * POST /public/clientes
 * Guarda el lead/cliente del formulario de Comunidad North.
 * Body: { nombre, telefono, sucursal (nombre opcional), nota, acepta, source? }
 * - Inserta con estado='nuevo'
 * - Notifica a n8n via webhook (si está configurado N8N_WEBHOOK_URL_NEW_CLIENT)
 */
router.post("/public/clientes", publicCors, async (req, res) => {
  try {
    const { nombre, telefono, sucursal, nota, acepta, source } = req.body || {};

    // Validaciones básicas
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: "Nombre requerido" });
    }
    const tel = cleanPhone(telefono);
    if (!tel || tel.length < 8) {
      return res.status(400).json({ error: "WhatsApp inválido" });
    }
    if (!acepta) {
      return res.status(400).json({ error: "Se requiere consentimiento" });
    }

    // Resolver sucursal_id si te mandan el nombre (match por nombre real o apodo)
    let sucursalId = null;
    if (sucursal && String(sucursal).trim()) {
      const encontrada = await buscarSucursal(sucursal);
      if (encontrada) sucursalId = encontrada.id;
    }

    // Insert
    const [result] = await pool.promise().query(
      `INSERT INTO clientes
       (nombre, telefono, sucursal_id, nota, acepta, estado, added_to_group, source, created_at)
       VALUES (?, ?, ?, ?, 1, 'nuevo', 0, ?, NOW())`,
      [
        String(nombre).trim(),
        tel,
        sucursalId,
        toNullOrTrim(nota),
        source || "web",
      ]
    );

    // Notificar a n8n (no romper si n8n está caído)
    try {
      const webhookUrl = process.env.N8N_WEBHOOK_URL_NEW_CLIENT; // ej: https://n8n.tu-dominio/webhook/new-client
      if (webhookUrl) {
        const fetch = (...args) =>
          import("node-fetch").then(({ default: f }) => f(...args));
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: result.insertId,
            nombre: String(nombre).trim(),
            telefono: tel, // ya normalizado
            sucursal_id: sucursalId, // puede ser null
            nota: toNullOrTrim(nota),
            source: source || "web",
          }),
        });
      }
    } catch (e) {
      console.error("Webhook n8n falló:", e.message);
      // seguimos igual, no es crítico para responder 201
    }

    res.status(201).json({ ok: true, id: result.insertId });
  } catch (err) {
    console.error(
      "POST /public/clientes error:",
      err.sqlMessage || err.message
    );
    res.status(500).json({ error: "No se pudo guardar el cliente" });
  }
});

/* =========================
   Endpoints admin (API Key)
========================= */

/**
 * Middleware simple para "endpoints admin".
 * Exige x-api-key = process.env.ADMIN_API_KEY
 * Reemplazar por tu auth real (JWT/sesiones) cuando quieras.
 */
const adminGuard = (req, res, next) => {
  const key = req.header("x-api-key");
  const expected = process.env.ADMIN_API_KEY;
  if (expected && key === expected) return next();
  if (!expected) return next(); // si no hay clave configurada, no bloqueamos (quitar en prod)
  return res.status(401).json({ error: "No autorizado" });
};

/**
 * GET /admin/clientes
 * Filtros opcionales:
 *  - estado = nuevo|contactado|agregado|descartado
 *  - q      = texto (busca en nombre, telefono, sucursal/apodo)
 *  - sucursal_id = filtra por sucursal
 *  - limit  = N (default 500, max 2000)
 */
router.get("/admin/clientes", adminGuard, async (req, res) => {
  try {
    const { estado, q, sucursal_id } = req.query;
    const limit = Math.min(Number(req.query.limit) || 500, 2000);

    const where = [];
    const args = [];

    if (estado) {
      where.push("c.estado = ?");
      args.push(estado);
    }
    if (sucursal_id) {
      where.push("c.sucursal_id = ?");
      args.push(Number(sucursal_id));
    }
    if (q) {
      where.push(
        "(c.nombre LIKE ? OR c.telefono LIKE ? OR s.nombre LIKE ? OR s.apodo LIKE ?)"
      );
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT
        c.id, c.nombre, c.telefono, c.nota, c.acepta,
        c.estado, c.added_to_group, c.source, c.created_at,
        c.sucursal_id,
        COALESCE(s.apodo, s.nombre) AS sucursal, -- mostrar alias si existe
        s.nombre AS sucursal_real,
        s.apodo  AS sucursal_apodo
      FROM clientes c
      LEFT JOIN sucursales s ON s.id = c.sucursal_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY c.created_at DESC
      LIMIT ${limit};
    `;

    const [rows] = await pool.promise().query(sql, args);
    res.json(rows);
  } catch (err) {
    console.error("GET /admin/clientes error:", err.sqlMessage || err.message);
    res.status(500).json({ error: "No se pudieron traer los clientes" });
  }
});

/**
 * PATCH /admin/clientes/:id
 * Body (cualquiera de estos): { estado, added_to_group, sucursal_id, nota }
 */
router.patch("/admin/clientes/:id", adminGuard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido" });

    const { estado, added_to_group, sucursal_id, nota } = req.body || {};
    const sets = [];
    const args = [];

    if (estado) {
      sets.push("estado = ?");
      args.push(estado);
    }
    if (typeof added_to_group !== "undefined") {
      sets.push("added_to_group = ?");
      args.push(added_to_group ? 1 : 0);
    }
    if (typeof sucursal_id !== "undefined") {
      sets.push("sucursal_id = ?");
      args.push(sucursal_id || null);
    }
    if (typeof nota !== "undefined") {
      sets.push("nota = ?");
      args.push(nota || null);
    }

    if (!sets.length) {
      return res.status(400).json({ error: "Nada para actualizar" });
    }

    args.push(id);
    const sql = `UPDATE clientes SET ${sets.join(", ")} WHERE id = ?`;
    await pool.promise().query(sql, args);

    res.json({ ok: true });
  } catch (err) {
    console.error(
      "PATCH /admin/clientes/:id error:",
      err.sqlMessage || err.message
    );
    res.status(500).json({ error: "No se pudo actualizar el cliente" });
  }
});

/**
 * (Opcional) PATCH /admin/sucursales/:id
 * Setea o limpia el apodo (alias público) de una sucursal.
 * Body: { apodo }  --> string o null
 */
router.patch("/admin/sucursales/:id", adminGuard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido" });

    const { apodo } = req.body || {};
    const value = (apodo ?? "").toString().trim() || null;

    await pool
      .promise()
      .query("UPDATE sucursales SET apodo = ? WHERE id = ?", [value, id]);

    res.json({ ok: true });
  } catch (err) {
    console.error(
      "PATCH /admin/sucursales/:id error:",
      err.sqlMessage || err.message
    );
    res.status(500).json({ error: "No se pudo actualizar la sucursal" });
  }
});

router.get("/public/productosSucursal", publicCors, async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id
      ? Number(req.query.sucursal_id)
      : null;
    const onlyInStock = req.query.inStock === "1";

    // Si viene sucursal_id, filtramos en el CTE; si no, traemos todas las sucursales
    const whereSucursal = sucursalId ? "WHERE st.sucursal_id = ?" : "";

    const sql = `
      WITH agg AS (
        SELECT
          st.gusto_id,
          st.sucursal_id,
          SUM(st.cantidad) AS stock_raw,
          MAX(st.precio)   AS precio_raw
        FROM stock st
        ${whereSucursal}
        GROUP BY st.gusto_id, st.sucursal_id
      )
      SELECT
        g.id AS id,
        CONCAT(
          TRIM(REPLACE(REPLACE(p.nombre, CHAR(9), ' '), '  ', ' ')),
          ' - ',
          TRIM(REPLACE(REPLACE(g.nombre, CHAR(9), ' '), '  ', ' '))
        ) AS nombre,
        CAST(agg.stock_raw  AS UNSIGNED)        AS stock,
        CAST(agg.precio_raw AS DECIMAL(10,2))   AS precio,
        s.id                                      AS sucursal_id,
        LOWER(s.nombre)                           AS sucursal
      FROM agg
      JOIN gustos g      ON g.id = agg.gusto_id
      JOIN productos p   ON p.id = g.producto_id
      JOIN sucursales s  ON s.id = agg.sucursal_id
      ${onlyInStock ? "WHERE agg.stock_raw > 0" : ""}
      ORDER BY p.nombre ASC, g.nombre ASC, s.nombre ASC
      LIMIT 500;
    `;

    const params = sucursalId ? [sucursalId] : [];
    const [rows] = await pool.promise().query(sql, params);

    // ⚠️ Si querés exactamente { id, nombre, stock, sucursal } podés mapear acá:
    // const data = rows.map(r => ({ id: r.id, nombre: r.nombre, stock: r.stock, sucursal: r.sucursal }));
    // return res.json(data);

    res.json(rows);
  } catch (err) {
    console.error(
      "GET /public/productosSucursal error:",
      err.sqlMessage || err.message
    );
    res
      .status(500)
      .json({ error: "No se pudieron traer los productos por sucursal" });
  }
});
// POST que recibe el pago desde n8n
router.post("/pagos-mp", (req, res) => {
  const { monto, fecha, raw } = req.body;

  if (!monto) {
    return res.status(400).json({ error: "Falta monto" });
  }

  // fecha viene como string de milisegundos, ej: "1737683129000"
  const fechaDate = fecha ? new Date(Number(fecha)) : new Date();

  pool.query(
    `INSERT INTO pagos_mp (monto, fecha_email, raw_body)
     VALUES (?, ?, ?)`,
    [monto, fechaDate, raw || null],
    (err, result) => {
      if (err) {
        console.error("Error /pagos-mp:", err);
        return res.status(500).json({ error: "Error interno" });
      }

      return res.json({ ok: true, id: result.insertId });
    }
  );
});
// 📊 Ventas semanales públicas (opcionalmente filtradas por sucursal_id)
// GET /public/ventas-semanales?anio=2025&semana=42[&sucursal_id=3]
router.get("/public/ventas-semanales", publicCors, async (req, res) => {
  let { semana, anio, sucursal_id } = req.query;

  try {
    const hoy = new Date();

    // Año por defecto: actual
    if (!anio) anio = hoy.getFullYear();
    anio = Number(anio);

    // Semana ISO por defecto: semana actual
    if (!semana) {
      const fechaUTC = new Date(
        Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())
      );
      const diaSemana = fechaUTC.getUTCDay() || 7; // domingo = 7
      fechaUTC.setUTCDate(fechaUTC.getUTCDate() + 4 - diaSemana);
      const inicioAno = new Date(
        Date.UTC(fechaUTC.getUTCFullYear(), 0, 1)
      );
      semana = Math.ceil(
        ((fechaUTC - inicioAno) / 86400000 + 1) / 7
      );
    }

    semana = Number(semana);

    if (!Number.isInteger(semana) || semana < 1 || semana > 53) {
      return res.status(400).json({ error: "Semana inválida" });
    }
    if (!Number.isInteger(anio) || anio < 2000) {
      return res.status(400).json({ error: "Año inválido" });
    }

    // 👉 Calcular lunes de la semana ISO y domingo
    const getMondayOfISOWeek = (week, year) => {
      const simple = new Date(year, 0, 1 + (week - 1) * 7);
      const dow = simple.getDay(); // 0=domingo .. 6=sábado
      const ISOweekStart = new Date(simple);
      let diff;
      if (dow <= 4 && dow !== 0) {
        diff = 1 - dow;      // lunes-jueves
      } else if (dow === 0) {
        diff = -6;           // domingo
      } else {
        diff = 8 - dow;      // viernes-sábado
      }
      ISOweekStart.setDate(simple.getDate() + diff);
      return ISOweekStart;
    };

    const inicioSemana = getMondayOfISOWeek(semana, anio);
    const finSemana = new Date(inicioSemana);
    finSemana.setDate(inicioSemana.getDate() + 6);

    const inicioStr = inicioSemana.toISOString().slice(0, 10); // YYYY-MM-DD
    const finStr = finSemana.toISOString().slice(0, 10);

    console.log(
      "📅 /public/ventas-semanales => semana:",
      semana,
      "año:",
      anio,
      "rango:",
      inicioStr,
      "->",
      finStr,
      "sucursal_id:",
      sucursal_id || "(todas)"
    );

    // 👉 Query por rango de fechas (y opcional sucursal)
    let sql = `
      SELECT
        DATE_FORMAT(v.fecha, '%W') AS dia_semana,
        SUM(v.cantidad * COALESCE(v.precio_unitario, st.precio, 0)) AS total_ventas
      FROM ventas v
      LEFT JOIN stock st
        ON st.gusto_id = v.gusto_id
       AND st.sucursal_id = v.sucursal_id
      WHERE DATE(v.fecha) BETWEEN ? AND ?
    `;
    const params = [inicioStr, finStr];

    if (sucursal_id) {
      sql += " AND v.sucursal_id = ?";
      params.push(Number(sucursal_id));
    }

    sql += `
      GROUP BY dia_semana
      ORDER BY FIELD(
        dia_semana,
        'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'
      )
    `;

    const [rows] = await pool.promise().query(sql, params);

    const respuesta = rows.map((r) => ({
      dia: r.dia_semana,                 // ej: Monday, Tuesday
      total: Number(r.total_ventas) || 0
    }));

    console.log("📊 /public/ventas-semanales resultado:", respuesta);

    res.json(respuesta);
  } catch (e) {
    console.error("❌ Error /public/ventas-semanales:", e);
    res.status(500).json({ error: "Error al obtener ventas semanales" });
  }
});

/**
 * GET /public/shishas
 * Carta de shishas para el catálogo online. Los precios salen de la misma
 * configuración que usa el bar, así no hay una segunda lista que mantener.
 * Solo se publican los sabores activos; el stock no se expone.
 */
router.get("/public/shishas", publicCors, async (_req, res) => {
  try {
    const [[cfg]] = await pool
      .promise()
      .query("SELECT precio_nueva, precio_recarga FROM shisha_insumos LIMIT 1");

    const [sabores] = await pool.promise().query(`
      SELECT nombre, linea, resumen, descripcion
      FROM shisha_sabores
      WHERE activo = 1
      ORDER BY linea, orden, nombre
    `);

    // Agrupado por línea, respetando el orden en que aparecen
    const lineas = [];
    for (const s of sabores) {
      let g = lineas.find((x) => x.linea === s.linea);
      if (!g) { g = { linea: s.linea, sabores: [] }; lineas.push(g); }
      g.sabores.push({
        nombre: s.nombre,
        resumen: s.resumen,
        descripcion: s.descripcion,
      });
    }

    res.json({
      precios: {
        armado: Number(cfg?.precio_nueva) || 0,
        recarga: Number(cfg?.precio_recarga) || 0,
      },
      lineas,
    });
  } catch (e) {
    console.error("❌ Error en GET /public/shishas:", e);
    res.status(500).json({ error: "No se pudo cargar la carta" });
  }
});
/**
 * GET /public/evento/:slug
 * Catálogo de un evento (fiesta con stock nuestro). Solo eventos abiertos:
 * cerrado el evento el link deja de mostrar precios viejos.
 * No expone cuántas unidades quedan, igual que la hoja impresa.
 */
router.get("/public/evento/:slug", publicCors, async (req, res) => {
  try {
    const [[ev]] = await pool
      .promise()
      .query("SELECT id, nombre, lugar, nota, fecha, estado FROM eventos WHERE slug = ?", [req.params.slug]);

    if (!ev) return res.status(404).json({ error: "Ese catálogo no existe" });
    if (ev.estado !== "abierto") return res.status(410).json({ error: "Este catálogo ya no está disponible" });

    // Misma forma que /public/productos para que el catálogo reuse los mismos
    // ayudantes (separar modelo y gusto, sacar los puffs, resolver la imagen).
    const [items] = await pool.promise().query(`
      SELECT
        g.id AS id,
        CONCAT(
          TRIM(REPLACE(REPLACE(p.nombre, CHAR(9), ' '), '  ', ' ')),
          ' - ',
          TRIM(REPLACE(REPLACE(g.nombre, CHAR(9), ' '), '  ', ' '))
        ) AS nombre,
        CAST(i.precio AS DECIMAL(10,2)) AS precio
      FROM evento_items i
      JOIN gustos g    ON g.id = i.gusto_id
      JOIN productos p ON p.id = g.producto_id
      WHERE i.evento_id = ? AND i.cantidad_llevada > 0
      ORDER BY p.nombre, g.nombre
    `, [ev.id]);

    const [logos] = await pool.promise().query(
      "SELECT imagen_base64, mime FROM evento_logos WHERE evento_id = ? ORDER BY orden, id",
      [ev.id]
    );

    res.json({
      nombre: ev.nombre,
      lugar: ev.lugar,
      nota: ev.nota,
      fecha: ev.fecha,
      logos: logos.map((l) => `data:${l.mime};base64,${l.imagen_base64}`),
      items,
    });
  } catch (e) {
    console.error("❌ Error en GET /public/evento/:slug:", e);
    res.status(500).json({ error: "No se pudo cargar el catálogo" });
  }
});
/**
 * GET /public/eventos-hoy
 * Eventos abiertos que son hoy, para avisar en el catálogo principal.
 * Devuelve lo justo para armar el aviso; el detalle va en su propia página.
 */
router.get("/public/eventos-hoy", publicCors, async (_req, res) => {
  try {
    const [rows] = await pool.promise().query(`
      SELECT nombre, lugar, slug
      FROM eventos
      WHERE estado = 'abierto' AND fecha = CURDATE()
      ORDER BY id
    `);
    res.json(rows);
  } catch (e) {
    console.error("❌ Error en GET /public/eventos-hoy:", e);
    res.status(500).json({ error: "No se pudieron traer los eventos" });
  }
});

module.exports = router;

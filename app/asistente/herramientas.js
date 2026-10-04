/**
 * Lo que el asistente puede consultar.
 *
 * Cada herramienta es una consulta de SOLO LECTURA contra la misma base que
 * usan las pantallas. Nada de escribir: un malentendido en una respuesta se
 * aclara con otra pregunta, pero uno en una escritura queda en la base.
 *
 * Las consultas reusan app/costos.js y app/dolar.js para que los números no
 * puedan contradecir a los de las pantallas.
 */

const pool = require("../db");
const { CENTRAL_ID, costoUnitario, costosDeGustos, margenPct } = require("../costos");
const { dolarEnFecha, dolarCripto, aUsd } = require("../dolar");

const db = () => pool.promise();

/** Los nombres vienen con tabuladores de las importaciones viejas. */
const limpio = (s) => String(s || "").replace(/\s+/g, " ").trim();
const redondear = (n) => Number((Number(n) || 0).toFixed(2));

// ─────────────────────────────────────────────────────────────────────────────
// Sucursales
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resuelve el nombre de una sucursal a su id. Acepta aproximaciones: "garupá",
 * "weekend", "punto 9". Si no la encuentra devuelve null y el asistente avisa,
 * que es mejor que contestar con los datos de otra sucursal.
 */
async function buscarSucursal(texto) {
  if (!texto) return null;
  const [filas] = await db().query(
    "SELECT id, nombre, apodo FROM sucursales WHERE activo = 1 OR activo IS NULL"
  );
  const norma = (s) =>
    String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const q = norma(texto);

  // Primero exacta, después por contenido en cualquiera de los dos sentidos
  return (
    filas.find((s) => norma(s.nombre) === q || norma(s.apodo) === q) ||
    filas.find((s) => norma(s.nombre).includes(q) || norma(s.apodo).includes(q)) ||
    filas.find((s) => q.includes(norma(s.nombre))) ||
    null
  );
}

async function listarSucursales() {
  const [filas] = await db().query(
    `SELECT s.id, s.nombre, s.telefono,
            COALESCE((SELECT SUM(st.cantidad) FROM stock st WHERE st.sucursal_id = s.id), 0) AS unidades
       FROM sucursales s
      WHERE s.activo = 1 OR s.activo IS NULL
      ORDER BY s.nombre`
  );
  return filas.map((s) => ({ ...s, unidades: Number(s.unidades) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Qué hay en una sucursal, o dónde está un producto.
 * Sin sucursal y sin producto devuelve el total de cada sucursal.
 */
async function consultarStock({ sucursal, producto, detalle_por_sabor } = {}) {
  let suc = null;
  if (sucursal) {
    suc = await buscarSucursal(sucursal);
    if (!suc) return { error: `No encontré ninguna sucursal que se parezca a "${sucursal}".` };
  }

  const where = ["st.cantidad > 0"];
  const params = [];
  if (suc) { where.push("st.sucursal_id = ?"); params.push(suc.id); }
  if (producto) {
    where.push("(p.nombre LIKE ? OR g.nombre LIKE ?)");
    params.push(`%${producto}%`, `%${producto}%`);
  }

  // Por sabor solo si lo piden o si buscan un producto puntual: el detalle
  // completo de una sucursal son cientos de renglones y no entra en un mensaje.
  const porSabor = detalle_por_sabor || (producto && suc);

  const sql = porSabor
    ? `SELECT s.nombre AS sucursal, p.nombre AS producto, g.nombre AS sabor,
              st.cantidad AS unidades, st.precio
         FROM stock st
         JOIN gustos g ON g.id = st.gusto_id
         JOIN productos p ON p.id = g.producto_id
         JOIN sucursales s ON s.id = st.sucursal_id
        WHERE ${where.join(" AND ")}
        ORDER BY st.cantidad DESC LIMIT 60`
    : `SELECT s.nombre AS sucursal, p.nombre AS producto,
              SUM(st.cantidad) AS unidades, MAX(st.precio) AS precio
         FROM stock st
         JOIN gustos g ON g.id = st.gusto_id
         JOIN productos p ON p.id = g.producto_id
         JOIN sucursales s ON s.id = st.sucursal_id
        WHERE ${where.join(" AND ")}
        GROUP BY s.nombre, p.nombre
        ORDER BY unidades DESC LIMIT 60`;

  const [filas] = await db().query(sql, params);
  const items = filas.map((f) => ({
    sucursal: f.sucursal,
    producto: limpio(f.producto),
    ...(f.sabor ? { sabor: f.sabor } : {}),
    unidades: Number(f.unidades),
    precio_venta: Number(f.precio) || null,
  }));

  return {
    sucursal: suc ? suc.nombre : "todas",
    total_unidades: items.reduce((a, i) => a + i.unidades, 0),
    items,
    nota: items.length === 60 ? "Hay más renglones, esto es el top 60." : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ventas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ventas minoristas de un período, abiertas por sucursal y por vendedor.
 * Los pedidos mayoristas van aparte porque no salen de la tabla ventas.
 */
async function consultarVentas({ desde, hasta, sucursal } = {}) {
  const d = desde || new Date().toLocaleDateString("sv-SE");
  const h = hasta || d;

  let suc = null;
  if (sucursal) {
    suc = await buscarSucursal(sucursal);
    if (!suc) return { error: `No encontré ninguna sucursal que se parezca a "${sucursal}".` };
  }

  const filtro = suc ? "AND v.sucursal_id = ?" : "";
  const extra = suc ? [suc.id] : [];

  const [porSucursal] = await db().query(
    `SELECT s.nombre AS sucursal,
            COUNT(*) AS transacciones,
            SUM(v.cantidad) AS unidades,
            SUM(v.cantidad * COALESCE(v.precio_unitario, 0)) AS facturado
       FROM ventas v
       JOIN sucursales s ON s.id = v.sucursal_id
      WHERE DATE(v.fecha) BETWEEN ? AND ? ${filtro}
      GROUP BY s.nombre ORDER BY facturado DESC`,
    [d, h, ...extra]
  );

  const [porVendedor] = await db().query(
    `SELECT COALESCE(NULLIF(TRIM(u.nombre), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS vendedor,
            SUM(v.cantidad) AS unidades,
            SUM(v.cantidad * COALESCE(v.precio_unitario, 0)) AS facturado
       FROM ventas v
       JOIN usuarios u ON u.id = v.vendedor_id
      WHERE DATE(v.fecha) BETWEEN ? AND ? AND v.vendedor_id IS NOT NULL ${filtro}
      GROUP BY vendedor ORDER BY facturado DESC`,
    [d, h, ...extra]
  );

  const [[mayorista]] = await db().query(
    `SELECT COUNT(*) AS pedidos, COALESCE(SUM(total_ars), 0) AS facturado
       FROM pedidos_mayoristas
      WHERE estado = 'confirmado' AND DATE(fecha_confirmacion) BETWEEN ? AND ?`,
    [d, h]
  );

  const minorista = porSucursal.reduce((a, f) => a + Number(f.facturado), 0);

  return {
    desde: d,
    hasta: h,
    facturado_minorista: redondear(minorista),
    facturado_mayorista: redondear(mayorista.facturado),
    facturado_total: redondear(minorista + Number(mayorista.facturado)),
    pedidos_mayoristas: Number(mayorista.pedidos),
    unidades: porSucursal.reduce((a, f) => a + Number(f.unidades), 0),
    por_sucursal: porSucursal.map((f) => ({
      sucursal: f.sucursal,
      transacciones: Number(f.transacciones),
      unidades: Number(f.unidades),
      facturado: redondear(f.facturado),
    })),
    por_vendedor: porVendedor.map((f) => ({
      vendedor: f.vendedor,
      unidades: Number(f.unidades),
      facturado: redondear(f.facturado),
    })),
  };
}

/** Lo más vendido de un período. */
async function masVendido({ desde, hasta, sucursal, limite = 10 } = {}) {
  const d = desde || new Date().toLocaleDateString("sv-SE");
  const h = hasta || d;
  let suc = null;
  if (sucursal) {
    suc = await buscarSucursal(sucursal);
    if (!suc) return { error: `No encontré la sucursal "${sucursal}".` };
  }
  const [filas] = await db().query(
    `SELECT p.nombre AS producto, SUM(v.cantidad) AS unidades,
            SUM(v.cantidad * COALESCE(v.precio_unitario, 0)) AS facturado
       FROM ventas v
       JOIN gustos g ON g.id = v.gusto_id
       JOIN productos p ON p.id = g.producto_id
      WHERE DATE(v.fecha) BETWEEN ? AND ? ${suc ? "AND v.sucursal_id = ?" : ""}
      GROUP BY p.nombre ORDER BY unidades DESC LIMIT ?`,
    suc ? [d, h, suc.id, Number(limite)] : [d, h, Number(limite)]
  );
  return {
    desde: d, hasta: h, sucursal: suc ? suc.nombre : "todas",
    items: filas.map((f) => ({
      producto: limpio(f.producto),
      unidades: Number(f.unidades),
      facturado: redondear(f.facturado),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deudas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quién debe plata. Las sucursales deben lo vendido menos lo pagado; los
 * vendedores lo mismo pero por vendedor_id. Es el mismo cálculo que el
 * Dashboard, para que no den distinto.
 */
async function consultarDeudas({ tipo = "ambos" } = {}) {
  const salida = {};

  if (tipo === "sucursal" || tipo === "ambos") {
    const [filas] = await db().query(
      `SELECT s.nombre AS sucursal,
              COALESCE(v.facturado, 0) AS facturado,
              COALESCE(p.pagado, 0) AS pagado,
              COALESCE(v.facturado, 0) - COALESCE(p.pagado, 0) AS deuda
         FROM sucursales s
         LEFT JOIN (SELECT sucursal_id, SUM(cantidad * COALESCE(precio_unitario,0)) AS facturado
                      FROM ventas GROUP BY sucursal_id) v ON v.sucursal_id = s.id
         LEFT JOIN (SELECT sucursal_id, SUM(monto) AS pagado
                      FROM pagos WHERE estado = 'ok' GROUP BY sucursal_id) p ON p.sucursal_id = s.id
        HAVING deuda <> 0
        ORDER BY deuda DESC`
    );
    salida.sucursales = filas.map((f) => ({
      sucursal: f.sucursal,
      deuda: redondear(f.deuda),
    }));
    salida.total_sucursales = redondear(
      filas.reduce((a, f) => a + Number(f.deuda), 0)
    );
  }

  if (tipo === "vendedor" || tipo === "ambos") {
    const [filas] = await db().query(
      `SELECT COALESCE(NULLIF(TRIM(u.nombre), ''), SUBSTRING_INDEX(u.email, '@', 1)) AS vendedor,
              COALESCE(SUM(v.cantidad * COALESCE(v.precio_unitario, 0)), 0) AS facturado,
              COALESCE((SELECT SUM(monto) FROM pagos
                         WHERE vendedor_id = u.id AND estado = 'ok'), 0) AS pagado
         FROM usuarios u
         LEFT JOIN ventas v ON v.vendedor_id = u.id
        WHERE u.rol = 'vendedor'
        GROUP BY u.id, u.email, u.nombre`
    );
    salida.vendedores = filas
      .map((f) => ({
        vendedor: f.vendedor,
        deuda: redondear(Number(f.facturado) - Number(f.pagado)),
      }))
      .filter((v) => v.deuda !== 0)
      .sort((a, b) => b.deuda - a.deuda);
    salida.total_vendedores = redondear(
      salida.vendedores.reduce((a, f) => a + f.deuda, 0)
    );
  }

  return salida;
}

// ─────────────────────────────────────────────────────────────────────────────
// Costos y precios
// ─────────────────────────────────────────────────────────────────────────────

/** Costo de cada modelo que hay en stock en la Central, en pesos y en USD. */
async function costosDeStock() {
  const dolar = await dolarCripto();
  const [filas] = await db().query(
    `SELECT p.id, p.nombre AS modelo,
       COALESCE((SELECT SUM(s.cantidad) FROM stock s JOIN gustos gx ON gx.id = s.gusto_id
                  WHERE gx.producto_id = p.id AND s.sucursal_id = ?), 0) AS stock,
       (SELECT r2.precio_costo FROM reposiciones r2 JOIN gustos g2 ON g2.id = r2.gusto_id
         WHERE g2.producto_id = p.id AND r2.sucursal_id = ? AND r2.precio_costo IS NOT NULL
         ORDER BY r2.fecha DESC, r2.id DESC LIMIT 1) AS costo,
       (SELECT r2.precio_costo_usd FROM reposiciones r2 JOIN gustos g2 ON g2.id = r2.gusto_id
         WHERE g2.producto_id = p.id AND r2.sucursal_id = ? AND r2.precio_costo_usd IS NOT NULL
         ORDER BY r2.fecha DESC, r2.id DESC LIMIT 1) AS usd_real,
       (SELECT ${dolarEnFecha("r3.fecha")} FROM reposiciones r3 JOIN gustos g3 ON g3.id = r3.gusto_id
         WHERE g3.producto_id = p.id AND r3.sucursal_id = ? AND r3.precio_costo IS NOT NULL
         ORDER BY r3.fecha DESC, r3.id DESC LIMIT 1) AS dolar_compra
     FROM reposiciones r JOIN gustos g ON g.id = r.gusto_id JOIN productos p ON p.id = g.producto_id
     WHERE r.sucursal_id = ?
     GROUP BY p.id, p.nombre
     HAVING stock > 0
     ORDER BY stock DESC`,
    [CENTRAL_ID, CENTRAL_ID, CENTRAL_ID, CENTRAL_ID, CENTRAL_ID]
  );

  // Los modelos duplicados por tabuladores en el nombre se suman en uno
  const porNombre = new Map();
  for (const f of filas) {
    const nombre = limpio(f.modelo);
    const clave = nombre.toLowerCase();
    const usd = f.usd_real != null ? Number(f.usd_real) : aUsd(f.costo, f.dolar_compra);
    if (!porNombre.has(clave)) {
      porNombre.set(clave, {
        modelo: nombre,
        stock: 0,
        costo_ars: Number(f.costo) || null,
        costo_usd: usd,
        usd_de_factura: f.usd_real != null,
      });
    }
    const e = porNombre.get(clave);
    e.stock += Number(f.stock);
    if (f.usd_real != null && !e.usd_de_factura) {
      e.costo_usd = Number(f.usd_real);
      e.usd_de_factura = true;
    }
  }

  const modelos = [...porNombre.values()].sort((a, b) => b.stock - a.stock);
  return {
    dolar_hoy: dolar,
    unidades: modelos.reduce((a, m) => a + m.stock, 0),
    valor_a_costo_ars: redondear(
      modelos.reduce((a, m) => a + m.stock * (m.costo_ars || 0), 0)
    ),
    modelos,
  };
}

/**
 * Lista de precios mayorista sobre lo que hay en stock.
 * El margen es sobre lo facturado, como en todas las pantallas: precio = costo / (1 - margen).
 */
async function listaDePrecios({ margen_pct = 15 } = {}) {
  const m = Number(margen_pct);
  if (!(m > 0 && m < 90)) return { error: "El margen tiene que estar entre 1 y 89." };

  const base = await costosDeStock();
  const factor = 1 - m / 100;

  const items = base.modelos
    .filter((x) => x.costo_usd > 0)
    .map((x) => ({
      modelo: x.modelo,
      stock: x.stock,
      costo_usd: redondear(x.costo_usd),
      venta_usd: redondear(x.costo_usd / factor),
      venta_ars: base.dolar_hoy
        ? Math.round((x.costo_usd / factor) * base.dolar_hoy)
        : null,
      usd_de_factura: x.usd_de_factura,
    }))
    .sort((a, b) => a.venta_usd - b.venta_usd);

  return {
    margen_pct: m,
    dolar: base.dolar_hoy,
    nota: "El margen es sobre lo facturado, igual que en el resto del sistema.",
    items,
  };
}

/** Margen real de los pedidos de un período. */
async function margenDePedidos({ desde, hasta } = {}) {
  const hoy = new Date();
  const d = desde || new Date(hoy.getFullYear(), hoy.getMonth(), 1).toLocaleDateString("sv-SE");
  const h = hasta || hoy.toLocaleDateString("sv-SE");

  const [mayoristas] = await db().query(
    `SELECT pm.id, pm.fecha_confirmacion AS fecha, pm.total_ars AS facturado, c.nombre AS cliente,
       (SELECT COALESCE(SUM(pmi.cantidad * ${costoUnitario("pmi.gusto_id", "pm.fecha_confirmacion")}), 0)
          FROM pedido_mayorista_items pmi WHERE pmi.pedido_id = pm.id) AS costo
     FROM pedidos_mayoristas pm JOIN clientes c ON c.id = pm.cliente_id
     WHERE pm.estado = 'confirmado' AND DATE(pm.fecha_confirmacion) BETWEEN ? AND ?
     ORDER BY pm.fecha_confirmacion`,
    [d, h]
  );

  const [centrales] = await db().query(
    `SELECT id, fecha_confirmacion AS fecha, total AS facturado, nombre_cliente AS cliente, items
       FROM pedidos_central
      WHERE estado = 'confirmado' AND DATE(fecha_confirmacion) BETWEEN ? AND ?`,
    [d, h]
  );

  const pedidos = mayoristas.map((p) => ({
    tipo: "mayorista", id: p.id, cliente: p.cliente,
    facturado: redondear(p.facturado), costo: redondear(p.costo),
    ganancia: redondear(Number(p.facturado) - Number(p.costo)),
    margen_pct: margenPct(p.facturado, Number(p.facturado) - Number(p.costo)),
  }));

  for (const p of centrales) {
    const its = typeof p.items === "string" ? JSON.parse(p.items) : p.items || [];
    const costos = await costosDeGustos(pool, its.map((i) => i.gusto_id), p.fecha);
    let costo = 0;
    for (const i of its) {
      costo += (costos.get(Number(i.gusto_id)) || 0) * (Number(i.qty ?? i.cantidad) || 0);
    }
    pedidos.push({
      tipo: "central", id: p.id, cliente: p.cliente,
      facturado: redondear(p.facturado), costo: redondear(costo),
      ganancia: redondear(Number(p.facturado) - costo),
      margen_pct: margenPct(p.facturado, Number(p.facturado) - costo),
    });
  }

  const facturado = pedidos.reduce((a, p) => a + p.facturado, 0);
  const costo = pedidos.reduce((a, p) => a + p.costo, 0);

  return {
    desde: d, hasta: h,
    pedidos: pedidos.sort((a, b) => (a.margen_pct ?? 0) - (b.margen_pct ?? 0)),
    total: {
      pedidos: pedidos.length,
      facturado: redondear(facturado),
      costo: redondear(costo),
      ganancia: redondear(facturado - costo),
      margen_pct: margenPct(facturado, facturado - costo),
    },
  };
}

/** La cotización de hoy. */
async function cotizacionDolar() {
  const d = await dolarCripto();
  return d ? { dolar_cripto: d } : { error: "No pude leer la cotización." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo que ve el modelo
// ─────────────────────────────────────────────────────────────────────────────

const HERRAMIENTAS = [
  {
    name: "listar_sucursales",
    description:
      "Lista las sucursales activas con su teléfono y cuántas unidades tienen en stock. " +
      "Usala cuando no sepas qué sucursales existen o cómo se escriben.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    ejecutar: listarSucursales,
  },
  {
    name: "consultar_stock",
    description:
      "Qué hay en stock. Sin parámetros devuelve el total por sucursal y producto. " +
      "Con 'sucursal' filtra una; con 'producto' busca ese modelo en todas las sucursales, " +
      "que es la forma de responder 'dónde hay X'.",
    input_schema: {
      type: "object",
      properties: {
        sucursal: { type: "string", description: "Nombre aproximado: 'central', 'garupa', 'weekend'." },
        producto: { type: "string", description: "Parte del nombre del modelo o del sabor: 'ice king', 'mango'." },
        detalle_por_sabor: { type: "boolean", description: "true para abrir sabor por sabor en vez de agrupar por modelo." },
      },
      additionalProperties: false,
    },
    ejecutar: consultarStock,
  },
  {
    name: "consultar_ventas",
    description:
      "Ventas de un período, abiertas por sucursal y por vendedor, más los pedidos mayoristas. " +
      "Sin fechas toma el día de hoy. Las fechas van en formato YYYY-MM-DD.",
    input_schema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "YYYY-MM-DD. Si falta, hoy." },
        hasta: { type: "string", description: "YYYY-MM-DD. Si falta, igual que desde." },
        sucursal: { type: "string", description: "Para filtrar una sola sucursal." },
      },
      additionalProperties: false,
    },
    ejecutar: consultarVentas,
  },
  {
    name: "mas_vendido",
    description: "Ranking de los productos más vendidos de un período, en unidades.",
    input_schema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "YYYY-MM-DD. Si falta, hoy." },
        hasta: { type: "string", description: "YYYY-MM-DD." },
        sucursal: { type: "string" },
        limite: { type: "integer", description: "Cuántos traer. Por defecto 10." },
      },
      additionalProperties: false,
    },
    ejecutar: masVendido,
  },
  {
    name: "consultar_deudas",
    description:
      "Quién debe plata: las sucursales (lo vendido menos lo pagado) y los vendedores minoristas.",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["sucursal", "vendedor", "ambos"], description: "Por defecto ambos." },
      },
      additionalProperties: false,
    },
    ejecutar: consultarDeudas,
  },
  {
    name: "costos_de_stock",
    description:
      "Costo de cada modelo que hay en stock en la Central, en pesos y en dólares, con el valor " +
      "total del stock. Marca si el costo en USD sale de la factura o si lo dedujimos del dólar.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    ejecutar: costosDeStock,
  },
  {
    name: "lista_de_precios",
    description:
      "Arma la lista de precios mayorista sobre lo que hay en stock, con el margen que se le pida. " +
      "El margen es sobre lo facturado: 15 significa que de cada $100 vendidos, $15 son ganancia.",
    input_schema: {
      type: "object",
      properties: {
        margen_pct: { type: "number", description: "Margen en por ciento. Por defecto 15." },
      },
      additionalProperties: false,
    },
    ejecutar: listaDePrecios,
  },
  {
    name: "margen_de_pedidos",
    description:
      "Margen real de los pedidos confirmados de un período, uno por uno y el total. " +
      "Sin fechas toma el mes en curso. Vienen ordenados del peor margen al mejor.",
    input_schema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "YYYY-MM-DD." },
        hasta: { type: "string", description: "YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    ejecutar: margenDePedidos,
  },
  {
    name: "cotizacion_dolar",
    description: "La cotización del dólar cripto de hoy, que es al que compramos.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    ejecutar: cotizacionDolar,
  },
];

/** Lo que se le manda a la API: el catálogo sin la función. */
const catalogo = () => HERRAMIENTAS.map(({ ejecutar, ...resto }) => resto);

/** Corre una herramienta por nombre. Nunca tira: el error vuelve como dato. */
async function ejecutar(nombre, entrada) {
  const h = HERRAMIENTAS.find((x) => x.name === nombre);
  if (!h) return { error: `No existe la herramienta ${nombre}.` };
  try {
    return await h.ejecutar(entrada || {});
  } catch (e) {
    console.error(`❌ herramienta ${nombre}:`, e);
    return { error: `Falló la consulta: ${e.sqlMessage || e.message}` };
  }
}

module.exports = {
  catalogo,
  ejecutar,
  // exportadas sueltas para poder probarlas sin pasar por el modelo
  listarSucursales, consultarStock, consultarVentas, masVendido,
  consultarDeudas, costosDeStock, listaDePrecios, margenDePedidos,
  cotizacionDolar, buscarSucursal,
};

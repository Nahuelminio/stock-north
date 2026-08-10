const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticate = require("../middlewares/authenticate");

const CENTRAL_ID = 7;

const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo admin" });
  next();
};

const num = (x) => Number(x) || 0;

/**
 * Costo unitario de un gusto en cascada, porque no todas las reposiciones
 * tienen el costo cargado:
 *   1. la última reposición con costo anterior a la venta (lo que pagaste ese día)
 *   2. la primera reposición con costo posterior (para ventas viejas)
 *   3. el promedio del gusto
 * Si no hay ninguna, la venta queda sin costo y se cuenta aparte para poder
 * avisar qué parte de la ganancia es estimada.
 */
const COSTO_VENTA = `
  COALESCE(
    (SELECT r.precio_costo FROM reposiciones r
      WHERE r.gusto_id = v.gusto_id AND r.precio_costo > 0 AND r.fecha <= v.fecha
      ORDER BY r.fecha DESC LIMIT 1),
    (SELECT r.precio_costo FROM reposiciones r
      WHERE r.gusto_id = v.gusto_id AND r.precio_costo > 0 AND r.fecha > v.fecha
      ORDER BY r.fecha ASC LIMIT 1),
    (SELECT AVG(r.precio_costo) FROM reposiciones r
      WHERE r.gusto_id = v.gusto_id AND r.precio_costo > 0)
  )`;

/** El canal sale de cómo se cargó la venta; son excluyentes entre sí. */
const CANAL_VENTA = `
  CASE
    WHEN v.evento_id IS NOT NULL     THEN 'eventos'
    WHEN v.vendedor_id IS NOT NULL   THEN 'vendedores'
    WHEN v.sucursal_id = ${CENTRAL_ID} THEN 'central'
    ELSE 'sucursales'
  END`;

/**
 * Ganancia acumulada del dueño en shishas hasta una fecha.
 *
 * El trato con Fagu no es por venta sino acumulado: el margen (venta − insumos)
 * primero recupera el capital y recién después se reparte 50/50. Así que la
 * ganancia de un período es la diferencia entre el acumulado al final y al
 * principio, no algo que se pueda sumar venta por venta.
 */
async function shishaAcumulado(hasta) {
  const [[t]] = await pool.promise().query(
    `SELECT COALESCE(SUM(precio_venta),0) facturado,
            COALESCE(SUM(ganancia),0)     margen,
            COUNT(*)                      ventas
       FROM shisha_ventas
      WHERE anulada = 0 AND created_at < ?`,
    [hasta]
  );
  // El capital se toma completo y no "hasta la fecha": se cargó con una fecha
  // nominal posterior a las primeras ventas, así que prorratearlo daría que en
  // junio y julio ya ganabas, cuando en realidad ese margen fue a recuperar la
  // inversión. Es el mismo criterio que usa la pantalla de Shishas.
  const [[i]] = await pool.promise().query(
    `SELECT COALESCE(SUM(CASE WHEN tipo='capital' THEN monto ELSE 0 END),0) capital
       FROM shisha_inversiones`
  );
  const margen = num(t.margen);
  const capital = num(i.capital);
  const excedente = capital > 0 ? Math.max(0, margen - capital) : margen;
  return {
    facturado: num(t.facturado),
    ventas: num(t.ventas),
    margen,
    capital,
    // Mientras se recupera el capital al dueño no le queda nada: todo el margen
    // va a cubrir la inversión.
    ganancia: capital > 0 ? excedente * 0.5 : margen,
    falta_para_cubrir: Math.max(0, capital - margen),
  };
}

/**
 * GET /metricas/ingresos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 * Facturación y ganancia de cada fuente de ingreso en el período.
 * `hasta` es exclusivo: se pasa el día siguiente al último que se quiere ver.
 */
router.get("/metricas/ingresos", authenticate, soloAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) {
    return res.status(400).json({ error: "Faltan las fechas (desde y hasta)" });
  }

  try {
    // ── Vapes: sucursales, central, vendedores y eventos salen todos de `ventas`
    const [porCanal] = await pool.promise().query(
      `SELECT ${CANAL_VENTA} AS canal,
              SUM(v.cantidad)                          AS unidades,
              SUM(v.cantidad * v.precio_unitario)      AS facturado,
              SUM(v.cantidad * COALESCE(${COSTO_VENTA}, 0)) AS costo,
              SUM(CASE WHEN ${COSTO_VENTA} IS NULL
                       THEN v.cantidad * v.precio_unitario ELSE 0 END) AS facturado_sin_costo
         FROM ventas v
        WHERE v.fecha >= ? AND v.fecha < ?
        GROUP BY canal`,
      [desde, hasta]
    );

    // ── Mayorista. Casi la mitad de los pedidos se confirmaron sin tipo de
    // cambio y quedaron con total_ars en 0: para esos se usa el dólar del
    // pedido confirmado más cercano en el tiempo, igual que en Costos Central.
    const [[may]] = await pool.promise().query(
      `SELECT
         COUNT(*) AS pedidos,
         COALESCE(SUM(
           CASE WHEN pm.total_ars > 0 THEN pm.total_ars
                ELSE pm.total_usd * COALESCE((
                  SELECT p2.tipo_cambio FROM pedidos_mayoristas p2
                   WHERE p2.estado='confirmado' AND p2.tipo_cambio > 0
                   ORDER BY ABS(TIMESTAMPDIFF(SECOND, p2.fecha_confirmacion, pm.fecha_confirmacion))
                   LIMIT 1), 0)
           END), 0) AS facturado,
         COALESCE(SUM(CASE WHEN pm.total_ars > 0 THEN 0 ELSE 1 END), 0) AS sin_cotizacion
       FROM pedidos_mayoristas pm
       WHERE pm.estado = 'confirmado'
         AND pm.fecha_confirmacion >= ? AND pm.fecha_confirmacion < ?`,
      [desde, hasta]
    );

    // El costo de los items se agrega aparte: si se joinea con el pedido, su
    // total se repite una vez por item.
    const [[mayCosto]] = await pool.promise().query(
      `SELECT COALESCE(SUM(it.costo), 0) AS costo,
              COALESCE(SUM(it.unidades), 0) AS unidades
         FROM pedidos_mayoristas pm
         JOIN (
           SELECT pmi.pedido_id,
                  SUM(pmi.cantidad) AS unidades,
                  SUM(pmi.cantidad * COALESCE(
                    (SELECT AVG(r.precio_costo) FROM reposiciones r
                      WHERE r.gusto_id = pmi.gusto_id AND r.precio_costo > 0),
                    0)) AS costo
             FROM pedido_mayorista_items pmi
            GROUP BY pmi.pedido_id
         ) it ON it.pedido_id = pm.id
        WHERE pm.estado = 'confirmado'
          AND pm.fecha_confirmacion >= ? AND pm.fecha_confirmacion < ?`,
      [desde, hasta]
    );

    // ── Shishas: por diferencia de acumulados (ver shishaAcumulado)
    const [ini, fin] = await Promise.all([shishaAcumulado(desde), shishaAcumulado(hasta)]);
    const shisha = {
      facturado: fin.facturado - ini.facturado,
      ganancia: fin.ganancia - ini.ganancia,
      ventas: fin.ventas - ini.ventas,
      etapa: fin.capital > 0 && fin.margen >= fin.capital ? "reparto" : "recupero",
      falta_para_cubrir: fin.falta_para_cubrir,
      margen: fin.margen - ini.margen,
    };

    // ── Armado de la respuesta
    const dePorCanal = (clave) => porCanal.find((c) => c.canal === clave) || {};
    const canalVapes = (clave, nombre) => {
      const r = dePorCanal(clave);
      const facturado = num(r.facturado);
      const costo = num(r.costo);
      return {
        clave,
        nombre,
        facturado,
        costo,
        ganancia: facturado - costo,
        unidades: num(r.unidades),
        // Qué parte de lo facturado no tiene costo conocido: ahí la ganancia
        // aparece más alta de lo que fue.
        facturado_sin_costo: num(r.facturado_sin_costo),
      };
    };

    const canales = [
      canalVapes("central", "Central (minorista)"),
      canalVapes("sucursales", "Sucursales"),
      canalVapes("vendedores", "Vendedores"),
      canalVapes("eventos", "Eventos"),
      {
        clave: "mayorista",
        nombre: "Mayorista",
        facturado: num(may.facturado),
        costo: num(mayCosto.costo),
        ganancia: num(may.facturado) - num(mayCosto.costo),
        unidades: num(mayCosto.unidades),
        facturado_sin_costo: 0,
        pedidos: num(may.pedidos),
        sin_cotizacion: num(may.sin_cotizacion),
      },
      {
        clave: "shishas",
        nombre: "Shishas",
        facturado: shisha.facturado,
        // En shishas el "costo" que importa es lo que no te queda a vos: los
        // insumos más lo que recupera capital o va para Fagu.
        costo: shisha.facturado - shisha.ganancia,
        ganancia: shisha.ganancia,
        unidades: shisha.ventas,
        facturado_sin_costo: 0,
        etapa: shisha.etapa,
        falta_para_cubrir: shisha.falta_para_cubrir,
        margen: shisha.margen,
      },
    ];

    const totales = canales.reduce(
      (a, c) => ({
        facturado: a.facturado + c.facturado,
        costo: a.costo + c.costo,
        ganancia: a.ganancia + c.ganancia,
        unidades: a.unidades + c.unidades,
        facturado_sin_costo: a.facturado_sin_costo + c.facturado_sin_costo,
      }),
      { facturado: 0, costo: 0, ganancia: 0, unidades: 0, facturado_sin_costo: 0 }
    );

    // Desglose de las sucursales, que es el canal más gordo
    const [sucursales] = await pool.promise().query(
      `SELECT s.id, COALESCE(s.apodo, s.nombre) AS nombre,
              SUM(v.cantidad)                     AS unidades,
              SUM(v.cantidad * v.precio_unitario) AS facturado,
              SUM(v.cantidad * COALESCE(${COSTO_VENTA}, 0)) AS costo
         FROM ventas v
         JOIN sucursales s ON s.id = v.sucursal_id
        WHERE v.fecha >= ? AND v.fecha < ?
          AND v.evento_id IS NULL AND v.vendedor_id IS NULL
          AND v.sucursal_id <> ${CENTRAL_ID}
        GROUP BY s.id, nombre
        ORDER BY facturado DESC`,
      [desde, hasta]
    );

    res.json({
      desde,
      hasta,
      canales,
      totales,
      sucursales: sucursales.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        unidades: num(s.unidades),
        facturado: num(s.facturado),
        costo: num(s.costo),
        ganancia: num(s.facturado) - num(s.costo),
      })),
    });
  } catch (e) {
    console.error("❌ Error en GET /metricas/ingresos:", e);
    res.status(500).json({ error: "No se pudieron calcular las métricas" });
  }
});

/**
 * GET /metricas/serie?desde=&hasta=&paso=mes|semana
 * La misma facturación y ganancia pero partida en períodos, para ver la
 * evolución sin tener que pedir mes por mes.
 */
router.get("/metricas/serie", authenticate, soloAdmin, async (req, res) => {
  const { desde, hasta } = req.query;
  const paso = req.query.paso === "semana" ? "semana" : "mes";
  if (!desde || !hasta) {
    return res.status(400).json({ error: "Faltan las fechas (desde y hasta)" });
  }

  // Las semanas arrancan el lunes (modo 1 de YEARWEEK/DATE_FORMAT %x-%v)
  const grupo =
    paso === "semana"
      ? "DATE_FORMAT(DATE_SUB(v.fecha, INTERVAL WEEKDAY(v.fecha) DAY), '%Y-%m-%d')"
      : "DATE_FORMAT(v.fecha, '%Y-%m')";

  try {
    const [filas] = await pool.promise().query(
      `SELECT ${grupo} AS periodo, ${CANAL_VENTA} AS canal,
              SUM(v.cantidad * v.precio_unitario)           AS facturado,
              SUM(v.cantidad * COALESCE(${COSTO_VENTA}, 0)) AS costo,
              SUM(CASE WHEN ${COSTO_VENTA} IS NULL
                       THEN v.cantidad * v.precio_unitario ELSE 0 END) AS sin_costo
         FROM ventas v
        WHERE v.fecha >= ? AND v.fecha < ?
        GROUP BY periodo, canal
        ORDER BY periodo`,
      [desde, hasta]
    );

    const grupoMay =
      paso === "semana"
        ? "DATE_FORMAT(DATE_SUB(pm.fecha_confirmacion, INTERVAL WEEKDAY(pm.fecha_confirmacion) DAY), '%Y-%m-%d')"
        : "DATE_FORMAT(pm.fecha_confirmacion, '%Y-%m')";

    // El costo de los items se pre-agrega por pedido: joineado directo, el
    // total del pedido se repetiría una vez por item.
    const [may] = await pool.promise().query(
      `SELECT ${grupoMay} AS periodo,
              COALESCE(SUM(
                CASE WHEN pm.total_ars > 0 THEN pm.total_ars
                     ELSE pm.total_usd * COALESCE((
                       SELECT p2.tipo_cambio FROM pedidos_mayoristas p2
                        WHERE p2.estado='confirmado' AND p2.tipo_cambio > 0
                        ORDER BY ABS(TIMESTAMPDIFF(SECOND, p2.fecha_confirmacion, pm.fecha_confirmacion))
                        LIMIT 1), 0)
                END), 0) AS facturado,
              COALESCE(SUM(it.costo), 0) AS costo
         FROM pedidos_mayoristas pm
         LEFT JOIN (
           SELECT pmi.pedido_id,
                  SUM(pmi.cantidad * COALESCE(
                    (SELECT AVG(r.precio_costo) FROM reposiciones r
                      WHERE r.gusto_id = pmi.gusto_id AND r.precio_costo > 0),
                    0)) AS costo
             FROM pedido_mayorista_items pmi
            GROUP BY pmi.pedido_id
         ) it ON it.pedido_id = pm.id
        WHERE pm.estado='confirmado'
          AND pm.fecha_confirmacion >= ? AND pm.fecha_confirmacion < ?
        GROUP BY periodo ORDER BY periodo`,
      [desde, hasta]
    );

    const grupoSh =
      paso === "semana"
        ? "DATE_FORMAT(DATE_SUB(created_at, INTERVAL WEEKDAY(created_at) DAY), '%Y-%m-%d')"
        : "DATE_FORMAT(created_at, '%Y-%m')";

    const [sh] = await pool.promise().query(
      `SELECT ${grupoSh} AS periodo,
              COALESCE(SUM(precio_venta),0) AS facturado,
              COALESCE(SUM(ganancia),0)     AS margen
         FROM shisha_ventas
        WHERE anulada = 0 AND created_at >= ? AND created_at < ?
        GROUP BY periodo ORDER BY periodo`,
      [desde, hasta]
    );

    // Se junta todo en un mapa por período
    const mapa = new Map();
    const traer = (p) => {
      if (!mapa.has(p)) {
        mapa.set(p, {
          periodo: p, facturado: 0, costo: 0, ganancia: 0,
          // Cuánto de lo facturado no tiene costo conocido: en los meses viejos
          // casi no se cargaban costos y la ganancia de esos períodos sale
          // inflada. Se devuelve para poder avisarlo en el gráfico.
          facturado_sin_costo: 0,
          canales: {},
        });
      }
      return mapa.get(p);
    };
    const sumar = (p, canal, facturado, costo, sinCosto = 0) => {
      const f = traer(p);
      f.facturado += facturado;
      f.costo += costo;
      f.ganancia += facturado - costo;
      f.facturado_sin_costo += sinCosto;
      f.canales[canal] = (f.canales[canal] || 0) + facturado;
    };

    for (const r of filas) sumar(r.periodo, r.canal, num(r.facturado), num(r.costo), num(r.sin_costo));
    for (const r of may) sumar(r.periodo, "mayorista", num(r.facturado), num(r.costo));

    // La shisha se reparte con Fagu sobre el acumulado, no venta por venta: el
    // margen primero cubre el capital y recién el excedente se va a medias. Por
    // eso se recorre en orden arrastrando el acumulado, igual que en
    // /metricas/ingresos — si no, la serie mostraría ganancia donde el panel
    // muestra cero.
    const [[capFila]] = await pool.promise().query(
      `SELECT COALESCE(SUM(CASE WHEN tipo='capital' THEN monto ELSE 0 END),0) capital
         FROM shisha_inversiones`
    );
    const [[previo]] = await pool.promise().query(
      `SELECT COALESCE(SUM(ganancia),0) margen FROM shisha_ventas
        WHERE anulada = 0 AND created_at < ?`,
      [desde]
    );
    const capital = num(capFila.capital);
    const tuya = (acum) => (capital > 0 ? Math.max(0, acum - capital) * 0.5 : acum);

    let acum = num(previo.margen);
    for (const r of [...sh].sort((a, b) => String(a.periodo).localeCompare(String(b.periodo)))) {
      const antes = tuya(acum);
      acum += num(r.margen);
      const ganancia = tuya(acum) - antes;
      sumar(r.periodo, "shishas", num(r.facturado), num(r.facturado) - ganancia);
    }

    res.json({ paso, periodos: [...mapa.values()].sort((a, b) => a.periodo.localeCompare(b.periodo)) });
  } catch (e) {
    console.error("❌ Error en GET /metricas/serie:", e);
    res.status(500).json({ error: "No se pudo calcular la serie" });
  }
});

module.exports = router;

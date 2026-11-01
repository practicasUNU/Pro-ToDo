#!/usr/bin/env node
// Genera las 11 capturas del informe tecnico en docs/capturas/ (1920x1080 PNG).
// Combina vistas reales de la app (Playwright, Chromium headless) con
// fragmentos del codigo fuente pintados en HTML. El login conserva el OTP:
// el codigo llega por correo y se teclea en la terminal (o PROTODO_OTP_CODE).
//
// Uso: PROTODO_SCREENSHOT_EMAIL=usuario@dominio node scripts/generate-doc-screenshots.js

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { createRequire } = require("node:module");

// La raiz no tiene node_modules: playwright, pg y dotenv viven en backend/.
const ROOT = path.resolve(__dirname, "..");
const backendRequire = createRequire(
  path.join(ROOT, "backend", "package.json"),
);
const { chromium } = backendRequire("playwright");
const dotenv = backendRequire("dotenv");
const { Client } = backendRequire("pg");

const OUTPUT_DIR = path.join(ROOT, "docs", "capturas");
const VIEWPORT = { width: 1920, height: 1080 };
const NAVIGATION_TIMEOUT_MS = 30_000;
const SETTLE_DELAY_MS = 1_200;
const MAX_CODE_LINES = 70;

const backendEnv = (() => {
  const envPath = path.join(ROOT, "backend", ".env");
  return fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
})();

const FRONTEND_URL = (
  process.env.PROTODO_FRONTEND_URL ??
  backendEnv.FRONTEND_URL ??
  "http://localhost:9000"
).replace(/\/+$/, "");

/**
 * Panel de vista real de la app. Opciones: `clip` (selector que se recorta;
 * por defecto `.q-page`, sin el shell), `prepare(page)` (clics previos a la
 * captura) y `navigate(page)` (sustituye al `goto` cuando la ruta es dinamica).
 */
const ui = (route, title, options = {}) => ({
  kind: "ui",
  route,
  title: title ?? route,
  clip: ".q-page",
  ...options,
});

/** Formulario de un nodo en el Banco de Pruebas (`?nodeType=`). */
const sandbox = (nodeType, title) =>
  ui(`/nodos/config-sandbox?nodeType=${nodeType}`, title, {
    key: `sandbox-${nodeType}`,
    waitFor: ".sandbox-grid",
    clip: ".sandbox-grid > div:first-child",
  });

/** Panel de codigo: el fragmento se localiza por regex, no por numero de linea. */
const code = (file, anchor, lines) => ({ kind: "code", file, anchor, lines });

/** Panel con el resultado de una consulta de solo lectura. */
const query = (title, sql) => ({ kind: "query", title, sql });

/** Canvas: entra por "Supervisar"; prefiere un flujo Notiweb si existe. */
async function openWorkflowCanvas(page) {
  // Con `to`, el q-btn se renderiza como enlace: se localiza por aria-label.
  await page.goto(appUrl("/flujos"), { waitUntil: "networkidle" });
  const supervise = page.locator('[aria-label^="Supervisar "]');
  await supervise.first().waitFor({ timeout: NAVIGATION_TIMEOUT_MS });
  const preferred = supervise.filter({
    has: page.locator(
      "xpath=self::*[contains(translate(@aria-label, 'NOTIWEB', 'notiweb'), 'notiweb')]",
    ),
  });
  const target = (await preferred.count()) > 0 ? preferred : supervise;
  await target.first().click();
  await page.waitForURL((url) => /^#\/flujos\/[0-9a-f-]{36}/.test(url.hash), {
    timeout: NAVIGATION_TIMEOUT_MS,
  });
}

/** Reduce solo en la captura el grafo, para que quepa el flujo completo. */
async function fitCanvasToViewport(page) {
  await page.addStyleTag({ content: ".pd-canvas { zoom: 0.66; }" });
}

// Un PNG por tema y como maximo 2-3 paneles: en mosaicos de 4-6 el texto
// dejaba de leerse.
const CAPTURES = [
  {
    file: "captura_01a_seguridad_codigo.png",
    title: "Seguridad: verificacion OTP, red local (CIDR) y RBAC",
    panels: [
      code(
        "backend/src/modules/auth/auth.service.ts",
        /public async verifyOtp\(/,
        55,
      ),
      code(
        "backend/src/common/middlewares/red-local.middleware.ts",
        /public async use\(/,
        30,
      ),
      code(
        "backend/src/common/guards/roles.guard.ts",
        /public canActivate\(/,
        30,
      ),
    ],
  },
  {
    file: "captura_01b_seguridad_ui.png",
    title: "Seguridad: mantenimiento de la lista blanca de IPs",
    panels: [ui("/ip-whitelist", "Lista blanca de IP (CIDR)")],
  },
  {
    file: "captura_02_persistencia.png",
    title:
      "Persistencia: migraciones SQL puras, schema_migrations y Docker Compose",
    panels: [
      code("db/migrations/067-notiweb-referencia-autonoma.sql", /^BEGIN;/m, 55),
      query(
        "schema_migrations (ultimas aplicadas)",
        "SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 22",
      ),
      code("docker-compose.yml", /^\s*postgres:/m, 45),
    ],
  },
  {
    file: "captura_03_motor_fsm.png",
    title:
      "Motor FSM: bucle evaluador, contexto inmutable y fabrica de estrategias",
    panels: [
      code(
        "backend/src/core/fsm/services/fsm-engine.service.ts",
        /while \(cursor !== null\)/,
        70,
      ),
      code(
        "backend/src/core/fsm/context/state-payload.context.ts",
        /public setNamespace\(/,
        35,
      ),
      code(
        "backend/src/core/fsm/factories/node-strategy.factory.ts",
        /public registerStrategy\(/,
        50,
      ),
    ],
  },
  {
    file: "captura_04_drupal.png",
    title:
      "Nodo DESTINO_DRUPAL: formulario de configuracion y estrategia del backend",
    layout: "hero",
    panels: [
      sandbox("DESTINO_DRUPAL", "DrupalHttpConfig.vue en el Banco de Pruebas"),
      code(
        "backend/src/modules/nodes/strategies/drupal-http.strategy.ts",
        /private async runCreateNode\(/,
        34,
      ),
      code(
        "backend/src/modules/nodes/strategies/drupal-http.strategy.ts",
        /private async runAppendHtmlBlock\(/,
        34,
      ),
    ],
  },
  {
    file: "captura_05a_acens_codigo.png",
    title: "Destino HTTP generico y Acens: credencial aplicada al envio",
    panels: [
      code(
        "backend/src/modules/nodes/strategies/http-generic-destination.strategy.ts",
        /private async applyCredential\(/,
        60,
      ),
      code(
        "backend/src/modules/nodes/strategies/acens-http.strategy.ts",
        /public async execute\(/,
        60,
      ),
    ],
  },
  {
    file: "captura_05b_acens_vault_ui.png",
    title: "Boveda de credenciales: cifrado AES-256-GCM",
    panels: [
      code(
        "backend/src/core/security/encryption.service.ts",
        /public encrypt\(/,
        60,
      ),
      ui("/credenciales", "Boveda de credenciales"),
    ],
  },
  {
    file: "captura_06_resiliencia.png",
    title: "Resiliencia: pausa con checkpoint y reanudacion",
    panels: [
      ui("/flujos", "Ejecuciones y estados"),
      code(
        "backend/src/core/fsm/services/fsm-engine.service.ts",
        /private async pauseAt\(/,
        60,
      ),
    ],
  },
  {
    file: "captura_07a_wizard_seleccion.png",
    title: "Asistente guiado: eleccion de la plantilla del flujo",
    panels: [
      ui("/flujos/nuevo", "Asistente: eleccion de plantilla", {
        waitFor: ".pd-pipeline-card",
      }),
    ],
  },
  {
    file: "captura_07b_nodo_trigger_imap.png",
    title: "Formulario del nodo: Disparador IMAP",
    panels: [sandbox("TRIGGER_IMAP", "Disparador IMAP")],
  },
  {
    file: "captura_07c_nodo_extractor_web.png",
    title: "Formulario del nodo: Extractor web",
    panels: [sandbox("EXTRACTOR_WEB", "Extractor web")],
  },
  {
    file: "captura_07d_nodo_procesador_ia.png",
    title: "Formulario del nodo: Procesador IA",
    panels: [sandbox("PROCESADOR_IA", "Procesador IA")],
  },
  {
    file: "captura_07e_nodo_escudo_post_ia.png",
    title: "Formulario del nodo: Escudo post-IA",
    panels: [sandbox("ESCUDO_POST_IA", "Escudo post-IA")],
  },
  {
    file: "captura_07f_nodo_mapeador_plantilla.png",
    title: "Formulario del nodo: Mapeador de plantilla",
    panels: [sandbox("MAPEADOR_PLANTILLA", "Mapeador de plantilla")],
  },
  {
    file: "captura_08a_cruds_ui.png",
    title: "Mantenimientos: usuarios e IPs autorizadas",
    panels: [ui("/users", "Usuarios"), ui("/ip-whitelist", "IPs autorizadas")],
  },
  {
    file: "captura_08b_plantillas_ws.png",
    title: "Catalogo de plantillas y cliente WebSocket",
    panels: [
      ui("/templates", "Plantillas"),
      code(
        "frontend/src/services/socket.client.ts",
        /export const connectSocket/,
        60,
      ),
    ],
  },
  {
    file: "captura_09a_canvas_flujo.png",
    title: "Canvas de topologia del flujo",
    panels: [
      ui(null, "Canvas de topologia del flujo", {
        key: "canvas",
        navigate: openWorkflowCanvas,
        waitFor: ".pd-canvas",
        prepare: fitCanvasToViewport,
      }),
    ],
  },
  {
    file: "captura_09b_supervision_ejecuciones.png",
    title:
      "Supervision: ejecuciones en tiempo real, pausas HITL y costes de IA",
    panels: [
      ui("/flujos", "Ejecuciones en tiempo real"),
      ui("/informes", "Resumen de costes de IA"),
    ],
  },
  {
    file: "captura_10_hitl_ws.png",
    title:
      "HITL: PauseFlowStrategy, pasarela Socket.IO y reanudacion por correo",
    panels: [
      code(
        "backend/src/modules/nodes/strategies/pause-flow.strategy.ts",
        /public async execute\(/,
        60,
      ),
      code(
        "backend/src/modules/notifications/notification.gateway.ts",
        /public async subscribeToFlow\(/,
        55,
      ),
      code(
        "backend/src/modules/workflows/inbound-email-resume.service.ts",
        /public async processMessage\(/,
        60,
      ),
    ],
  },
  {
    file: "captura_11a_telemetria_ui.png",
    title: "Telemetria de IA: informe de consumo y tarifas por modelo",
    panels: [
      ui("/informes", "Informe de consumo de IA"),
      ui("/precios", "Gestion de tarifas"),
    ],
  },
  {
    file: "captura_11b_telemetria_codigo.png",
    title: "Telemetria de IA: tokens y coste estimado en USD",
    panels: [
      code(
        "backend/src/modules/telemetry/telemetry.service.ts",
        /public async computeUsage\(/,
        60,
      ),
      code(
        "backend/src/modules/telemetry/telemetry.service.ts",
        /public async recordTokenUsage\(/,
        60,
      ),
      code(
        "backend/src/modules/nodes/strategies/inference-telemetry.ts",
        /export const recordResponseUsage/,
        60,
      ),
    ],
  },
];

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Fragmento de un fichero del repo a partir de la primera linea que casa. */
const readExcerpt = ({ file, anchor, lines }) => {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
  const start = source.findIndex((line) => anchor.test(line));

  if (start === -1) {
    return { start: 0, lines: [`// Fragmento no encontrado: ${anchor}`] };
  }

  return {
    start,
    lines: source.slice(start, start + Math.min(lines, MAX_CODE_LINES)),
  };
};

const renderCodePanel = (panel) => {
  const excerpt = readExcerpt(panel);
  const rows = excerpt.lines
    .map(
      (line, index) =>
        `<div class="ln"><span class="no">${excerpt.start + index + 1}</span><span>${escapeHtml(line) || " "}</span></div>`,
    )
    .join("");

  return `<section class="panel"><h2>${escapeHtml(panel.file)}</h2><pre>${rows}</pre></section>`;
};

/** Geometria del lienzo compuesto, en px (cabecera 64, margen 16, hueco 16). */
const CANVAS = { width: 1888, height: 984, gap: 16, panelChrome: 35 };
const SLICE_GAP = 12;
const MAX_SLICES = 4;

/** Area util (ancho, alto) del panel `index` segun el layout de la captura. */
const slotSize = (capture, index, count) => {
  const { width, height, gap, panelChrome } = CANVAS;
  let slotWidth;
  let slotHeight;

  if (capture.layout === "hero") {
    const usable = width - gap;
    slotWidth = index === 0 ? (usable * 3) / 5 : (usable * 2) / 5;
    slotHeight =
      index === 0 ? height : (height - gap * (count - 2)) / (count - 1);
  } else {
    const columns = count <= 3 ? count : Math.ceil(count / 2);
    const rows = count <= 3 ? 1 : 2;
    slotWidth = (width - gap * (columns - 1)) / columns;
    slotHeight = (height - gap * (rows - 1)) / rows;
  }

  return { width: slotWidth - 2, height: slotHeight - panelChrome };
};

/**
 * Numero de columnas en que se trocea una vista alta: el que maximiza la
 * escala. Un formulario de 2500 px en una sola columna quedaria ilegible.
 */
const bestSlicing = (image, slot) => {
  let best = { slices: 1, scale: 0 };

  for (let slices = 1; slices <= MAX_SLICES; slices += 1) {
    const sliceHeight = Math.ceil(image.height / slices);
    const scale = Math.min(
      1,
      (slot.width - SLICE_GAP * (slices - 1)) / (slices * image.width),
      slot.height / sliceHeight,
    );

    if (scale > best.scale + 0.01) {
      best = { slices, scale, sliceHeight };
    }
  }

  return best;
};

const renderImagePanel = (panel, slot) => {
  const { slices, scale, sliceHeight } = bestSlicing(panel, slot);
  const width = Math.floor(panel.width * scale);
  const height = Math.ceil(sliceHeight * scale);
  const columns = Array.from(
    { length: slices },
    (_, index) =>
      `<div class="slice" style="width:${width}px;height:${height}px">` +
      `<img src="data:image/png;base64,${panel.image}" style="width:${width}px;transform:translateY(-${index * height}px)"></div>`,
  ).join("");

  return (
    `<section class="panel"><h2>${escapeHtml(panel.title)} · <span class="mono">${escapeHtml(panel.route)}</span></h2>` +
    `<div class="shot">${columns}</div></section>`
  );
};

const renderQueryPanel = (panel) => {
  const body =
    panel.rows === null
      ? '<p class="muted">Base de datos no disponible.</p>'
      : `<table><thead><tr>${panel.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>` +
        panel.rows
          .map(
            (row) =>
              `<tr>${panel.columns.map((c) => `<td>${escapeHtml(row[c] instanceof Date ? row[c].toISOString() : row[c])}</td>`).join("")}</tr>`,
          )
          .join("") +
        "</tbody></table>";

  return `<section class="panel"><h2>${escapeHtml(panel.title)}</h2><div class="scroll">${body}</div></section>`;
};

const RENDERERS = {
  code: renderCodePanel,
  ui: renderImagePanel,
  query: renderQueryPanel,
};

/** Pagina compuesta con la paleta oscura UNUWARE; sin fuentes externas. */
const gridTemplate = (capture, count) => {
  // "hero": el primer panel ocupa la columna ancha; el resto se apila al lado.
  if (capture.layout === "hero") {
    return `grid-template-columns: 3fr 2fr; grid-template-rows: repeat(${count - 1}, minmax(0, 1fr));`;
  }

  const columns = count <= 3 ? count : Math.ceil(count / 2);
  const rows = count <= 3 ? 1 : 2;

  return `grid-template-columns: repeat(${columns}, minmax(0, 1fr)); grid-template-rows: repeat(${rows}, minmax(0, 1fr));`;
};

const renderComposite = (capture, panels) => {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1920px; height: 1080px; background: #0D0F26; color: #FFFFFF;
      font-family: Inter, Roboto, system-ui, sans-serif; display: flex; flex-direction: column; }
    header { height: 64px; padding: 0 28px; display: flex; align-items: center; gap: 16px;
      background: linear-gradient(90deg, #2C4FC7 0%, #4E74E8 100%); }
    header h1 { font-size: 24px; font-weight: 600; }
    header span { margin-left: auto; font-size: 14px; color: #E4EAFB; }
    main { flex: 1; min-height: 0; padding: 16px; display: grid; gap: 16px;
      ${gridTemplate(capture, panels.length)} }
    main.hero > .panel:first-child { grid-row: 1 / -1; }
    .panel { min-height: 0; display: flex; flex-direction: column; background: #12142E;
      border: 1px solid rgba(184,192,222,.4); border-radius: 8px; overflow: hidden; }
    .panel h2 { font-size: 13px; font-weight: 600; padding: 8px 12px; background: #161A3D; color: #B8C0DE;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    pre, .mono { font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace; }
    pre { flex: 1; overflow: hidden; padding: 8px 0; font-size: 12px; line-height: 1.45; color: #E4EAFB; }
    .ln { display: flex; white-space: pre; }
    .no { width: 52px; flex: none; padding-right: 12px; text-align: right; color: #5B5B66; }
    .shot { flex: 1; min-height: 0; display: flex; gap: ${SLICE_GAP}px; align-items: flex-start; justify-content: center; background: #0D0F26; overflow: hidden; }
    .slice { flex: none; overflow: hidden; border-right: 1px dashed rgba(184,192,222,.25); }
    .slice:last-child { border-right: none; }
    .slice img { display: block; max-width: none; }
    .scroll { flex: 1; overflow: hidden; padding: 8px 12px; }
    table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 13px; }
    th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid rgba(184,192,222,.2); }
    th { color: #5B8CE8; }
    .muted { color: #B8C0DE; }
  </style></head><body>
    <header><h1>${escapeHtml(capture.title)}</h1><span>Proto-Do · UNUWARE</span></header>
    <main class="${capture.layout ?? ""}">${panels.map((panel, index) => RENDERERS[panel.kind](panel, slotSize(capture, index, panels.length))).join("")}</main>
  </body></html>`;
};

/** Codigo OTP: variable de entorno o, si hay terminal, lectura interactiva. */
const readOtpCode = async (email) => {
  if (process.env.PROTODO_OTP_CODE) {
    return process.env.PROTODO_OTP_CODE.trim();
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `OTP solicitado para ${email}. Sin terminal interactiva: relanza con PROTODO_OTP_CODE=<codigo> antes de que caduque.`,
    );
  }

  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await prompt.question(`Codigo OTP enviado a ${email}: `);
  prompt.close();

  return answer.trim();
};

/** El router de Quasar va en modo `hash`: las rutas cuelgan de `/#`. */
const appUrl = (route) => `${FRONTEND_URL}/#${route}`;
const isLoginUrl = (url) => url.hash.startsWith("#/login");

const login = async (page, email) => {
  await page.goto(appUrl("/login"), { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', email);
  await page.click('button[type="submit"]');

  const cells = page.locator(".otp-grid input");
  await cells.first().waitFor({ timeout: NAVIGATION_TIMEOUT_MS });

  const otp = await readOtpCode(email);

  if (!/^\d{6}$/.test(otp)) {
    throw new Error("El codigo OTP debe tener 6 digitos.");
  }

  for (const [index, digit] of [...otp].entries()) {
    await cells.nth(index).fill(digit);
  }

  // `@complete` suele enviar solo; si el boton sigue activo, se pulsa.
  await page
    .waitForURL((url) => !isLoginUrl(url), { timeout: 5_000 })
    .catch(async () => {
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !isLoginUrl(url), {
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    });
};

/** Captura de una vista de la app, en memoria y en base64 (cacheada por clave). */
/** Ancho del drawer del shell, que queda fuera de `.q-page`. */
const DRAWER_WIDTH = 220;

/**
 * Ventana a la que se renderiza una vista: cercana al ancho de su panel, para
 * que en un mosaico de 2 no se encoja a la mitad. Nunca por debajo de 1100 px,
 * para no cruzar el punto en que Quasar pliega el drawer.
 */
const viewportWidthFor = (slot) =>
  Math.min(
    VIEWPORT.width,
    Math.max(1100, Math.round(slot.width / 0.9) + DRAWER_WIDTH),
  );

const captureUi = async (page, panel, cache, slot) => {
  const width = viewportWidthFor(slot);
  const key = `${panel.key ?? panel.route}@${width}`;

  if (cache.has(key)) {
    return cache.get(key);
  }

  await page.setViewportSize({ width, height: VIEWPORT.height });

  if (panel.navigate) {
    await panel.navigate(page);
  } else {
    await page.goto(appUrl(panel.route), {
      waitUntil: "networkidle",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  }

  if (panel.waitFor) {
    await page
      .locator(panel.waitFor)
      .first()
      .waitFor({ timeout: NAVIGATION_TIMEOUT_MS });
  }

  await panel.prepare?.(page);
  await page.waitForTimeout(SETTLE_DELAY_MS);
  // Los avisos efimeros (p. ej. "codigo enviado") no forman parte de la vista.
  await page.addStyleTag({
    // Cabecera y drawer son fijos: al capturar un elemento alto se
    // superpondrian a el. `visibility` no altera el layout.
    content:
      ".q-notifications { display: none !important; } .q-header, .q-drawer { visibility: hidden !important; }",
  });

  // Elemento COMPLETO, aunque supere la ventana: si es alto, el compositor
  // lo trocea en columnas en vez de cortarlo.
  const region = page.locator(panel.clip).first();
  const buffer =
    (await region.count()) > 0
      ? await region.screenshot({ type: "png" })
      : await page.screenshot({ type: "png" });
  const shot = {
    image: buffer.toString("base64"),
    // Cabecera IHDR del PNG: ancho y alto en los bytes 16-23.
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    route: new URL(page.url()).hash.replace(/^#/, ""),
  };

  cache.set(key, shot);
  return shot;
};

/** Consulta de solo lectura; `rows: null` si la BD no responde. */
const runQuery = async (sql) => {
  const client = new Client({
    host: backendEnv.DB_HOST ?? "localhost",
    port: Number(backendEnv.DB_PORT ?? 5432),
    user: backendEnv.DB_USER,
    password: backendEnv.DB_PASSWORD,
    database: backendEnv.DB_NAME,
    connectionTimeoutMillis: 5_000,
  });

  try {
    await client.connect();
    const result = await client.query(sql);
    return {
      columns: result.fields.map((field) => field.name),
      rows: result.rows,
    };
  } catch (error) {
    console.warn(`  aviso: consulta no disponible (${error.message})`);
    return { columns: [], rows: null };
  } finally {
    await client.end().catch(() => undefined);
  }
};

const resolvePanel = async (panel, page, cache, slot) => {
  if (panel.kind === "ui") {
    return { ...panel, ...(await captureUi(page, panel, cache, slot)) };
  }

  if (panel.kind === "query") {
    return { ...panel, ...(await runQuery(panel.sql)) };
  }

  return panel;
};

const main = async () => {
  const email = process.env.PROTODO_SCREENSHOT_EMAIL;

  if (!email) {
    throw new Error(
      "Define PROTODO_SCREENSHOT_EMAIL con el correo del usuario de prueba.",
    );
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      colorScheme: "dark",
      locale: "es-ES",
    });
    const page = await context.newPage();
    const composer = await context.newPage();
    const cache = new Map();

    console.log(`Autenticando en ${FRONTEND_URL} ...`);
    await login(page, email);

    for (const capture of CAPTURES) {
      console.log(`- ${capture.file}`);
      const panels = [];

      for (const [index, panel] of capture.panels.entries()) {
        const slot = slotSize(capture, index, capture.panels.length);
        panels.push(await resolvePanel(panel, page, cache, slot));
      }

      await composer.setContent(renderComposite(capture, panels), {
        waitUntil: "load",
      });
      await composer.screenshot({
        path: path.join(OUTPUT_DIR, capture.file),
        type: "png",
      });
    }

    // Solo tras generar todo: borra las capturas de catalogos anteriores.
    const expected = new Set(CAPTURES.map((capture) => capture.file));
    for (const file of fs.readdirSync(OUTPUT_DIR)) {
      if (/^captura_.*\.png$/.test(file) && !expected.has(file)) {
        fs.unlinkSync(path.join(OUTPUT_DIR, file));
      }
    }

    console.log(
      `Listo: ${CAPTURES.length} capturas en ${path.relative(ROOT, OUTPUT_DIR)}/`,
    );
    for (const capture of CAPTURES) {
      const png = fs.readFileSync(path.join(OUTPUT_DIR, capture.file));
      console.log(
        `  ${capture.file}  ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`,
      );
    }
  } finally {
    await browser.close();
  }
};

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});

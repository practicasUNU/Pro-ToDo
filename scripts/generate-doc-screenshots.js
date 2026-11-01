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

/** Panel de vista real de la app. */
const ui = (route, title) => ({ kind: "ui", route, title: title ?? route });

/** Panel de codigo: el fragmento se localiza por regex, no por numero de linea. */
const code = (file, anchor, lines) => ({ kind: "code", file, anchor, lines });

/** Panel con el resultado de una consulta de solo lectura. */
const query = (title, sql) => ({ kind: "query", title, sql });

const CAPTURES = [
  {
    file: "captura_01_seguridad.png",
    title: "Seguridad perimetral: OTP, lista blanca CIDR y RBAC",
    panels: [
      code(
        "backend/src/modules/auth/auth.service.ts",
        /public async verifyOtp\(/,
        45,
      ),
      code(
        "backend/src/common/middlewares/red-local.middleware.ts",
        /public async use\(/,
        35,
      ),
      code(
        "backend/src/common/guards/roles.guard.ts",
        /public canActivate\(/,
        30,
      ),
      ui("/ip-whitelist", "Lista blanca de IP (CIDR)"),
    ],
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
      "Nodo DESTINO_DRUPAL: creacion de nodo y mutacion de paginas agregadoras",
    panels: [
      code(
        "backend/src/modules/nodes/strategies/drupal-http.strategy.ts",
        /private async runCreateNode\(/,
        70,
      ),
      code(
        "backend/src/modules/nodes/strategies/drupal-http.strategy.ts",
        /private async runAppendHtmlBlock\(/,
        70,
      ),
    ],
  },
  {
    file: "captura_05_http_acens.png",
    title: "Destino HTTP generico / Acens con credencial cifrada AES-256-GCM",
    panels: [
      code(
        "backend/src/modules/nodes/strategies/http-generic-destination.strategy.ts",
        /private async applyCredential\(/,
        45,
      ),
      code(
        "backend/src/modules/nodes/strategies/acens-http.strategy.ts",
        /public async execute\(/,
        50,
      ),
      code(
        "backend/src/core/security/encryption.service.ts",
        /public encrypt\(/,
        45,
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
        55,
      ),
    ],
  },
  {
    file: "captura_07_wizard.png",
    title:
      "Asistente guiado (Poka-Yoke): validacion por paso y selectores cerrados",
    panels: [ui("/flujos/nuevo", "Asistente de creacion de flujo")],
  },
  {
    file: "captura_08_crud_ws.png",
    title: "Mantenimientos CRUD y cliente WebSocket",
    panels: [
      ui("/users", "Usuarios"),
      ui("/ip-whitelist", "IPs autorizadas"),
      ui("/templates", "Plantillas"),
      code(
        "frontend/src/services/socket.client.ts",
        /export const connectSocket/,
        45,
      ),
    ],
  },
  {
    file: "captura_09_panel_supervision.png",
    title: "Panel de supervision: ejecuciones, pausas HITL y costes de IA",
    panels: [
      ui("/flujos", "Ejecuciones en tiempo real"),
      ui("/informes", "Informes y costes de IA"),
      ui("/precios", "Tarifas de IA"),
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
    file: "captura_11_telemetria.png",
    title: "Telemetria de tokens, coste estimado en USD y tarifas de IA",
    panels: [
      ui("/informes", "Telemetria de tokens"),
      ui("/precios", "Gestion de tarifas"),
      code(
        "backend/src/modules/telemetry/telemetry.service.ts",
        /public async computeUsage\(/,
        50,
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

const renderImagePanel = (panel) =>
  `<section class="panel"><h2>${escapeHtml(panel.title)} · <span class="mono">${escapeHtml(panel.route)}</span></h2>` +
  `<div class="shot"><img src="data:image/png;base64,${panel.image}"></div></section>`;

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
const renderComposite = (capture, panels) => {
  const columns = panels.length === 4 ? 2 : panels.length;
  const rows = panels.length === 4 ? 2 : 1;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1920px; height: 1080px; background: #0D0F26; color: #FFFFFF;
      font-family: Inter, Roboto, system-ui, sans-serif; display: flex; flex-direction: column; }
    header { height: 64px; padding: 0 28px; display: flex; align-items: center; gap: 16px;
      background: linear-gradient(90deg, #2C4FC7 0%, #4E74E8 100%); }
    header h1 { font-size: 24px; font-weight: 600; }
    header span { margin-left: auto; font-size: 14px; color: #E4EAFB; }
    main { flex: 1; min-height: 0; padding: 16px; display: grid; gap: 16px;
      grid-template-columns: repeat(${columns}, minmax(0, 1fr)); grid-template-rows: repeat(${rows}, minmax(0, 1fr)); }
    .panel { min-height: 0; display: flex; flex-direction: column; background: #12142E;
      border: 1px solid rgba(184,192,222,.4); border-radius: 8px; overflow: hidden; }
    .panel h2 { font-size: 13px; font-weight: 600; padding: 8px 12px; background: #161A3D; color: #B8C0DE;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    pre, .mono { font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace; }
    pre { flex: 1; overflow: hidden; padding: 8px 0; font-size: 12px; line-height: 1.45; color: #E4EAFB; }
    .ln { display: flex; white-space: pre; }
    .no { width: 52px; flex: none; padding-right: 12px; text-align: right; color: #5B5B66; }
    .shot { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: #0D0F26; }
    .shot img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .scroll { flex: 1; overflow: hidden; padding: 8px 12px; }
    table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 13px; }
    th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid rgba(184,192,222,.2); }
    th { color: #5B8CE8; }
    .muted { color: #B8C0DE; }
  </style></head><body>
    <header><h1>${escapeHtml(capture.title)}</h1><span>Proto-Do · UNUWARE</span></header>
    <main>${panels.map((panel) => RENDERERS[panel.kind](panel)).join("")}</main>
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

/** Captura de una ruta de la app, en memoria y en base64. */
const captureRoute = async (page, route, cache) => {
  if (!cache.has(route)) {
    await page.goto(appUrl(route), {
      waitUntil: "networkidle",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForTimeout(SETTLE_DELAY_MS);
    cache.set(
      route,
      (await page.screenshot({ type: "png" })).toString("base64"),
    );
  }

  return cache.get(route);
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

const resolvePanel = async (panel, page, cache) => {
  if (panel.kind === "ui") {
    return { ...panel, image: await captureRoute(page, panel.route, cache) };
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

      for (const panel of capture.panels) {
        panels.push(await resolvePanel(panel, page, cache));
      }

      await composer.setContent(renderComposite(capture, panels), {
        waitUntil: "load",
      });
      await composer.screenshot({
        path: path.join(OUTPUT_DIR, capture.file),
        type: "png",
      });
    }

    console.log(
      `Listo: ${CAPTURES.length} capturas en ${path.relative(ROOT, OUTPUT_DIR)}/`,
    );
  } finally {
    await browser.close();
  }
};

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});

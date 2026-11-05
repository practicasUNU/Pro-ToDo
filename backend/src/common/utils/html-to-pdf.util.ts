import { BRAND_TEXT_MUTED } from '@common/constants/email-brand.constants';

import type { BrowserPoolService } from '@modules/nodes/services/browser-pool.service';

/**
 * Imprime un informe HTML a PDF A4 con el Chromium compartido
 * (`BrowserPoolService`): vectorial, con pie "Pagina X de Y" y sin
 * dependencias nuevas. Comun a los informes de telemetria y de auditoria.
 *
 * El HTML no debe referenciar recursos externos: el contexto del pool bloquea
 * imagenes y fuentes, y el proyecto no hace peticiones a terceros. El contexto
 * de Chromium se cierra SIEMPRE, tambien si la impresion falla.
 */
export const renderHtmlToPdf = async (
  browserPool: Pick<BrowserPoolService, 'createContext'>,
  html: string,
): Promise<Buffer> => {
  const context = await browserPool.createContext();

  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });

    return await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        `<div style="width:100%;font-size:8px;text-align:center;color:${BRAND_TEXT_MUTED};">` +
        'Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
      margin: { top: '18mm', bottom: '20mm', left: '14mm', right: '14mm' },
    });
  } finally {
    await context.close();
  }
};

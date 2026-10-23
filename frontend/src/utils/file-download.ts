// Helper de presentacion sin estado (frontend-architecture.md §2.1): ofrece al
// navegador unos bytes como descarga. No hace I/O de red; los bytes ya los
// trajo `reports.service.ts`.

/** Nombres de descarga, iguales a los que fija el backend en `Content-Disposition`. */
export const REPORT_FILENAMES = {
  csv: 'informe-telemetria.csv',
  pdf: 'informe-telemetria.pdf',
} as const;

/**
 * Guarda un `Blob` con el nombre indicado.
 *
 * Se usa un enlace temporal con `download` y no `window.open`: abrir el blob en
 * otra pestana lo bloquean los navegadores como ventana emergente, y un CSV ni
 * siquiera se mostraria. La URL se revoca enseguida para no retener los bytes en
 * memoria mientras la pestana siga abierta.
 */
export const saveBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);

  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
};

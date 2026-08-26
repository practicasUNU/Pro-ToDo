// Helper puro de validacion (frontend-architecture.md §2.1). Vivia dentro de
// UserDialog.vue; al necesitarlo tambien LoginPage.vue paso a compartirse, que
// es el criterio de la §3: si otra vista necesita el mismo resultado, sube.
//
// Es una guarda Poka-Yoke de interfaz, NO un control de seguridad: el backend
// valida el dominio por su cuenta (ACCEPTED_EMAIL_DOMAINS) y es quien manda.

/** Dominios autorizados, declarados en `frontend/.env` con prefijo VITE_. */
export const acceptedEmailDomains: string[] = (
  import.meta.env.VITE_ACCEPTED_EMAIL_DOMAINS ?? ''
)
  .split(',')
  .map((domain) => domain.trim())
  .filter(Boolean);

/** Mensaje de error unico, para que login y alta de usuario digan lo mismo. */
export const corporateEmailErrorMessage = `El correo debe pertenecer a un dominio corporativo autorizado (${acceptedEmailDomains.join(', ')})`;

/**
 * Comprueba que el correo pertenezca a un dominio corporativo.
 * Sin lista configurada no se bloquea a nadie: la decision queda en el backend.
 */
export const isCorporateEmail = (value: string): boolean => {
  if (acceptedEmailDomains.length === 0) return true;

  return acceptedEmailDomains.some((domain) =>
    value.toLowerCase().endsWith(domain.toLowerCase()),
  );
};

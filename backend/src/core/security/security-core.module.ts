import { Module } from '@nestjs/common';

import { EncryptionService } from '@core/security/encryption.service';

/**
 * Primitivas criptograficas compartidas.
 *
 * Vive en `@core` y no dentro de `CredentialsModule` porque cifrar en reposo no
 * es propio de las credenciales: cualquier secreto futuro que haya que guardar
 * en PostgreSQL debe pasar por la MISMA clave y el mismo algoritmo, no por una
 * segunda implementacion que diverja.
 */
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class SecurityCoreModule {}

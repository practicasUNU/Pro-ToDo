import { SetMetadata } from '@nestjs/common';

import { IS_PUBLIC_IP_KEY } from '@common/constants/security.constants';

import type { CustomDecorator } from '@nestjs/common';

/**
 * Exime a un controlador o ruta de la validacion de subred corporativa (PROT-05).
 *
 * Reservado para endpoints que deben responder desde fuera de la red, como el
 * healthcheck del contenedor Docker (`GET /api/health`). No lo apliques a rutas
 * que expongan datos de negocio.
 */
export const PublicIp = (): CustomDecorator<string> =>
  SetMetadata(IS_PUBLIC_IP_KEY, true);

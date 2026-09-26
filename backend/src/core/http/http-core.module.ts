import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { HttpClientService } from '@core/http/http-client.service';

/**
 * Modulo del cliente HTTP saliente compartido.
 *
 * Se aisla en `@core` y no se cuelga de `NodesModule` porque el consumidor
 * natural del cliente no es el nodo de IA sino CUALQUIER nodo que salga a
 * Internet: el `DESTINO_HTTP` de Drupal y el `DESTINO_ACENS` pendientes lo
 * necesitaran igual, y ninguno de los dos deberia tener que importar el modulo
 * de nodos para conseguirlo.
 *
 * NO se importa en `AppModule`: no aporta controladores ni providers globales, y
 * declararlo alli solo instanciaria el `HttpModule` en arranques que no lo usan.
 * Lo importa quien lo consume.
 */
@Module({
  imports: [HttpModule],
  providers: [HttpClientService],
  exports: [HttpClientService],
})
export class HttpCoreModule {}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import {
  CREDENTIALS_ENCRYPTION_KEY_VAR,
  EncryptionService,
} from '@core/security/encryption.service';

import { CredentialResponseDto } from './dto/credential-response.dto';
import { Credential } from './entities/credential.entity';
import {
  ApiKeyPlacement,
  CredentialAuthType,
} from './enums/credential-auth-type.enum';

import type { CrudAction } from '@common/types/crud-events.types';
import type { Repository } from 'typeorm';
import type { CreateCredentialDto } from './dto/create-credential.dto';
import type { UpdateCredentialDto } from './dto/update-credential.dto';
import type { CredentialSecret } from './types/credential-secret.types';

/** La credencial existe en algun flujo o plantilla: no se puede borrar. */
export const ERR_CREDENTIAL_IN_USE = 'ERR_CREDENTIAL_IN_USE';

/** Campos secretos que puede traer un DTO de alta o edicion. */
type SecretInput = Pick<
  CreateCredentialDto,
  'token' | 'username' | 'password' | 'keyName' | 'apiKey' | 'placement'
>;

/** Claves secretas del DTO: si llega alguna, se re-cifra el juego completo. */
const SECRET_INPUT_KEYS: readonly (keyof SecretInput)[] = [
  'token',
  'username',
  'password',
  'keyName',
  'apiKey',
  'placement',
];

/** Campos del secreto sin el discriminante, que ya es columna propia. */
const omitAuthType = (secret: CredentialSecret): Record<string, string> =>
  Object.fromEntries(
    Object.entries(secret).filter(([key]) => key !== 'authType'),
  );

const isApiKeyPlacement = (value: string): value is ApiKeyPlacement =>
  (Object.values(ApiKeyPlacement) as string[]).includes(value);

/**
 * Resultado de resolver un secreto para la FSM.
 *
 * Union y no excepcion, igual que `HttpClientService`: la estrategia convierte
 * cada motivo en un `NodeErrorDetail` GRAVE, reanudable, y un `throw` acabaria
 * normalizado a URGENTE por el motor.
 */
export type SecretResolution =
  | { readonly secret: CredentialSecret }
  | { readonly reason: 'NOT_FOUND' | 'VAULT_UNAVAILABLE' | 'UNREADABLE' };

/**
 * Consulta que responde si algun esquema de pipeline cita la credencial.
 *
 * `jsonb_path_exists` con variable `$id` y no un `LIKE` sobre el texto: el
 * identificador viaja como parametro, sin interpolar en el SQL, y la ruta mira
 * exactamente `nodes.*.params.authConfig.credentialId` en vez de cualquier
 * aparicion casual del UUID. Cubre flujos y plantillas de flujo, porque una
 * plantilla instanciada despues reintroduciria la referencia rota.
 */
const IN_USE_QUERY = `
  SELECT 1 FROM flujos
   WHERE jsonb_path_exists(
           configuracion_pipeline,
           '$.nodes.*.params.authConfig.credentialId ? (@ == $id)',
           jsonb_build_object('id', $1::text))
  UNION ALL
  SELECT 1 FROM plantillas_flujo
   WHERE jsonb_path_exists(
           configuracion_pipeline,
           '$.nodes.*.params.authConfig.credentialId ? (@ == $id)',
           jsonb_build_object('id', $1::text))
  LIMIT 1`;

/**
 * Boveda de credenciales cifradas (AES-256-GCM) para los nodos de destino.
 *
 * Solo la gestiona el ADMIN (lo impone el controlador). El EDITOR elige una
 * credencial por su id desde un selector cerrado y nunca ve su contenido.
 *
 * EL SECRETO NO VIVE EN NINGUNA PROPIEDAD. La entidad guarda solo el cifrado;
 * el texto plano existe en dos momentos: dentro de `create` / `update`, entre
 * el DTO y `encrypt`, y dentro de `resolveSecret`, que lo devuelve a la
 * estrategia del nodo para que construya UNA peticion HTTP. Ninguno de los dos
 * lo registra en log ni lo devuelve por la API.
 */
@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name);

  constructor(
    @InjectRepository(Credential)
    private readonly credentialRepository: Repository<Credential>,
    private readonly encryption: EncryptionService,
    private readonly dataSource: DataSource,
    private readonly crudEvents: CrudEventsCoordinator,
  ) {}

  public async findAll(): Promise<Credential[]> {
    return this.credentialRepository.find({ order: { name: 'ASC' } });
  }

  /** Opciones del selector del nodo, opcionalmente filtradas por tipo. */
  public async findOptions(
    authType?: CredentialAuthType,
  ): Promise<Credential[]> {
    return this.credentialRepository.find({
      ...(authType === undefined ? {} : { where: { authType } }),
      order: { name: 'ASC' },
    });
  }

  public async findOne(id: string): Promise<Credential> {
    const credential = await this.credentialRepository.findOne({
      where: { id },
    });

    if (credential === null) {
      throw new NotFoundException(`No existe la credencial ${id}.`);
    }

    return credential;
  }

  public async create(dto: CreateCredentialDto): Promise<Credential> {
    this.assertVaultUsable();
    await this.assertNameAvailable(dto.name);

    // El id se genera AQUI y no en PostgreSQL: es el AAD del cifrado.
    const id = randomUUID();
    const encrypted = this.encryptSecret(
      id,
      this.buildSecret(dto.authType, dto),
    );

    await this.credentialRepository.insert({
      id,
      name: dto.name,
      authType: dto.authType,
      ...encrypted,
    });

    const saved = await this.findOne(id);
    this.publishMutation('CREATED', saved);

    return saved;
  }

  /**
   * Edita nombre y, si llega, el secreto COMPLETO.
   *
   * Cambiar el tipo de una credencial en uso se rechaza: el nodo que la cita
   * declara su propio `authType`, y la credencial dejaria de encajar con el en
   * la siguiente ejecucion, con el flujo PAUSADO lejos de quien hizo el cambio.
   */
  public async update(
    id: string,
    dto: UpdateCredentialDto,
  ): Promise<Credential> {
    const current = await this.findOne(id);
    const nextType = dto.authType ?? current.authType;
    const rotatesSecret =
      dto.authType !== undefined ||
      SECRET_INPUT_KEYS.some((key) => dto[key] !== undefined);

    if (dto.name !== undefined && dto.name !== current.name) {
      await this.assertNameAvailable(dto.name);
    }

    if (nextType !== current.authType && (await this.isInUse(id))) {
      throw new ConflictException({
        code: ERR_CREDENTIAL_IN_USE,
        message:
          'La credencial esta en uso por al menos un flujo o plantilla: no se puede cambiar su tipo. Crea una credencial nueva y cambia el nodo a ella.',
      });
    }

    const patch: Partial<Credential> = {
      ...(dto.name === undefined ? {} : { name: dto.name }),
      authType: nextType,
    };

    if (rotatesSecret) {
      this.assertVaultUsable();
      Object.assign(
        patch,
        this.encryptSecret(id, this.buildSecret(nextType, dto)),
      );
    }

    await this.credentialRepository.update({ id }, patch);

    const saved = await this.findOne(id);
    this.publishMutation('UPDATED', saved);

    return saved;
  }

  /**
   * Borrado FISICO, bloqueado mientras algun esquema cite la credencial.
   *
   * Fisico y no logico: una credencial retirada no tiene nada que conservar
   * —su secreto no debe sobrevivir a la baja— y la traza de quien la borro
   * queda en `audit_eventos`.
   */
  public async remove(id: string): Promise<Credential> {
    const current = await this.findOne(id);

    if (await this.isInUse(id)) {
      throw new ConflictException({
        code: ERR_CREDENTIAL_IN_USE,
        message:
          'La credencial esta en uso por al menos un flujo o plantilla de flujo. Cambia esos nodos a otra credencial antes de borrarla.',
      });
    }

    await this.credentialRepository.delete({ id });
    this.publishMutation('DELETED', current);

    return current;
  }

  /**
   * Descifra una credencial para UNA peticion de la FSM.
   *
   * Es el unico camino por el que el texto plano sale de la boveda. Nunca
   * lanza: cualquier motivo se devuelve para que la estrategia lo traduzca a un
   * fallo GRAVE reanudable. El log nombra la credencial por su id, jamas por su
   * contenido.
   */
  public async resolveSecret(id: string): Promise<SecretResolution> {
    if (!this.encryption.isUsable) {
      return { reason: 'VAULT_UNAVAILABLE' };
    }

    const row = await this.credentialRepository
      .createQueryBuilder('credential')
      .addSelect([
        'credential.encryptedData',
        'credential.iv',
        'credential.authTag',
      ])
      .where('credential.id = :id', { id })
      .getOne();

    if (row === null) {
      return { reason: 'NOT_FOUND' };
    }

    try {
      const plain = this.encryption.decrypt(
        { ciphertext: row.encryptedData, iv: row.iv, authTag: row.authTag },
        row.id,
      );
      const parsed = JSON.parse(plain) as Record<string, unknown>;

      return {
        secret: { ...parsed, authType: row.authType } as CredentialSecret,
      };
    } catch {
      this.logger.warn(
        `La credencial ${id} no se pudo descifrar: dato alterado o ${CREDENTIALS_ENCRYPTION_KEY_VAR} distinta de la que la cifro.`,
      );

      return { reason: 'UNREADABLE' };
    }
  }

  // --- Internos ------------------------------------------------------------

  private assertVaultUsable(): void {
    if (!this.encryption.isUsable) {
      throw new ServiceUnavailableException(
        `La boveda de credenciales no esta disponible: falta ${CREDENTIALS_ENCRYPTION_KEY_VAR} en el entorno del servidor.`,
      );
    }
  }

  /** Pre-comprobacion del nombre unico, con el mismo criterio que los prompts. */
  private async assertNameAvailable(name: string): Promise<void> {
    if (await this.credentialRepository.exists({ where: { name } })) {
      throw new ConflictException(
        `Ya existe una credencial llamada "${name}".`,
      );
    }
  }

  private async isInUse(id: string): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(IN_USE_QUERY, [id]);

    return rows.length > 0;
  }

  /**
   * Compone el secreto del tipo pedido exigiendo su juego COMPLETO.
   *
   * Solo copia los campos del tipo: un `password` enviado junto a un
   * BEARER_TOKEN se descarta en vez de cifrarse en silencio.
   */
  private buildSecret(
    authType: CredentialAuthType,
    input: SecretInput,
  ): CredentialSecret {
    const require = (field: keyof SecretInput): string => {
      const value = input[field];

      if (typeof value !== 'string' || value.length === 0) {
        throw new BadRequestException(
          `${field} es obligatorio para una credencial ${authType}: el secreto se reemplaza completo, nunca por partes.`,
        );
      }

      return value;
    };

    switch (authType) {
      case CredentialAuthType.BEARER_TOKEN:
        return { authType, token: require('token') };

      case CredentialAuthType.BASIC_AUTH:
        return {
          authType,
          username: require('username'),
          password: require('password'),
        };

      case CredentialAuthType.API_KEY: {
        const placement = require('placement');

        if (!isApiKeyPlacement(placement)) {
          throw new BadRequestException(
            `placement debe ser uno de: ${Object.values(ApiKeyPlacement).join(', ')}.`,
          );
        }

        return {
          authType,
          keyName: require('keyName'),
          apiKey: require('apiKey'),
          placement,
        };
      }
    }
  }

  /**
   * Cifra el secreto ligado al id. El `authType` NO entra en el cifrado: ya es
   * columna propia, y duplicarlo permitiria que las dos copias discreparan.
   */
  private encryptSecret(
    id: string,
    secret: CredentialSecret,
  ): Pick<Credential, 'encryptedData' | 'iv' | 'authTag'> {
    // El discriminante se descarta con `omitAuthType` y no con una variable
    // `_authType` sin usar, que el linter del repositorio rechaza.
    const fields = omitAuthType(secret);
    const { ciphertext, iv, authTag } = this.encryption.encrypt(
      JSON.stringify(fields),
      id,
    );

    return { encryptedData: ciphertext, iv, authTag };
  }

  /** Difunde la mutacion a los paneles abiertos (sala de ADMIN). */
  private publishMutation(action: CrudAction, credential: Credential): void {
    this.crudEvents.dispatch({
      entity: 'credentials',
      action,
      id: credential.id,
      data: plainToInstance(CredentialResponseDto, credential),
      emittedAt: new Date().toISOString(),
    });
  }
}

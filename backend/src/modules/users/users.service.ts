import { ConfigService } from '@nestjs/config';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { IsNull, Repository } from 'typeorm';

import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import { SessionEventsCoordinator } from '@common/services/session-events.coordinator';
import { SessionRevocationCoordinator } from '@common/services/session-revocation.coordinator';
import {
  AUDIT_RELATIONS,
  stampCreated,
  stampUpdated,
} from '@common/utils/audit.util';

import { UserResponseDto } from './dto/user-response.dto';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

import type { CrudAction } from '@common/types/crud-events.types';
import type { UserRole } from '@modules/users/enums/user-role.enum';
import type { ModifiedUserField } from '@common/types/session-events.types';

/** Lo que hay que comparar para saber si una sesion deja de ser valida. */
interface SessionRelevantFields {
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly email: string;
}

/**
 * Campos que, al cambiar, obligan a rehacer la sesion del afectado.
 *
 * Son exactamente tres, y ninguno esta ahi por gusto: el ROL viaja firmado
 * dentro del JWT, asi que un token viejo seguiria abriendo pantallas que su
 * dueno ya no deberia ver; el ESTADO decide si la cuenta puede operar; y el
 * CORREO es la identidad con la que se inicia sesion. Cualquier otra edicion
 * —el nombre, una marca de auditoria— no altera lo que el token afirma, y
 * expulsar por ella seria castigar al usuario por un cambio cosmetico.
 *
 * Funcion PURA y exportada para poder probarla sin montar el servicio.
 */
export const resolveSessionBreakingFields = (
  previous: SessionRelevantFields,
  next: SessionRelevantFields,
): ModifiedUserField[] => {
  const changed: ModifiedUserField[] = [];

  if (previous.role !== next.role) changed.push('rol');
  if (previous.isActive !== next.isActive) changed.push('estado');
  if (previous.email !== next.email) changed.push('correo');

  return changed;
};

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly crudEvents: CrudEventsCoordinator,
    private readonly sessionRevocation: SessionRevocationCoordinator,
    private readonly sessionEvents: SessionEventsCoordinator,
  ) {}

  /**
   * Difunde la mutacion a los paneles abiertos.
   *
   * Proyecta con `UserResponseDto` y NUNCA emite la entidad: ese DTO es una
   * lista blanca (`@Exclude()` de clase mas `@Expose()` por campo) para que una
   * columna nueva no se filtre por olvido, y mandar la entidad en crudo
   * esquivaria esa politica por la puerta de atras.
   *
   * Una baja logica viaja como `UPDATED`, no como `DELETED`: la fila sigue
   * existiendo con `isActive` en falso, que es justo lo que el panel debe
   * pintar.
   */
  private publishMutation(action: CrudAction, user: User): void {
    this.crudEvents.dispatch({
      entity: 'users',
      action,
      id: user.id,
      data: plainToInstance(UserResponseDto, user),
      emittedAt: new Date().toISOString(),
    });
  }

  /**
   * Estado de autorizacion de una cuenta, para `JwtStrategy`.
   *
   * Lee SOLO las dos columnas que deciden si un token sigue sirviendo, porque
   * esto corre en CADA peticion autenticada: traer la fila entera —con su
   * `secreto_otp` y sus relaciones de auditoria— multiplicaria el coste del
   * guard sin que nadie use el resto.
   *
   * Devuelve `null` si la cuenta ya no existe, que para el llamante significa
   * exactamente lo mismo que un token invalido.
   */
  public async findAuthState(
    id: string,
  ): Promise<{ tokenVersion: number; isActive: boolean } | null> {
    return this.userRepository.findOne({
      where: { id },
      select: { tokenVersion: true, isActive: true },
    });
  }

  // Filtro de dominios corporativos (MOD-01): rechaza correos fuera de ACCEPTED_EMAIL_DOMAINS
  private assertCorporateEmail(email: string): void {
    const acceptedDomains = (
      this.configService.get<string>('ACCEPTED_EMAIL_DOMAINS') ?? ''
    )
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean);

    if (acceptedDomains.length === 0) return;

    const isAccepted = acceptedDomains.some((domain) =>
      email.toLowerCase().endsWith(domain.toLowerCase()),
    );

    if (!isAccepted) {
      throw new ForbiddenException(
        `El correo debe pertenecer a un dominio corporativo autorizado (${acceptedDomains.join(', ')})`,
      );
    }
  }

  public async findAll(): Promise<User[]> {
    return this.userRepository.find({ relations: AUDIT_RELATIONS });
  }

  public async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: AUDIT_RELATIONS,
    });

    if (!user) {
      throw new NotFoundException(`Usuario con id "${id}" no encontrado`);
    }

    return user;
  }

  /**
   * Busca un usuario por su correo. A diferencia de `findOne`, NO lanza si no existe:
   * el flujo de autenticacion necesita distinguir el caso sin convertirlo en un 404,
   * que permitiria enumerar cuentas validas desde fuera.
   */
  public async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email: email.trim().toLowerCase() },
    });
  }

  /**
   * Busca un usuario incluyendo su secreto TOTP.
   *
   * `otpSecret` esta marcado con `select: false`, asi que ningun `find` lo trae:
   * hace falta pedirlo explicitamente con `addSelect`. Este metodo es el unico
   * camino por el que el secreto sale del repositorio, y solo lo consume el flujo
   * de autenticacion.
   */
  public async findByEmailWithOtpSecret(email: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.otpSecret')
      .where('user.email = :email', { email: email.trim().toLowerCase() })
      .getOne();
  }

  /**
   * Inscribe la cuenta en TOTP si aun no tiene secreto (inscripcion perezosa).
   *
   * La actualizacion es CONDICIONAL (`otpSecret IS NULL`): si dos peticiones
   * concurrentes intentan inscribir la misma cuenta, la segunda no sobreescribe
   * el secreto de la primera, que invalidaria el codigo ya enviado por correo.
   *
   * @returns El secreto que ha quedado persistido, sea el nuevo o el preexistente.
   */
  public async ensureOtpSecret(
    userId: string,
    secret: string,
  ): Promise<string> {
    await this.userRepository.update(
      { id: userId, otpSecret: IsNull() },
      { otpSecret: secret },
    );

    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.otpSecret')
      .where('user.id = :userId', { userId })
      .getOne();

    return user?.otpSecret ?? secret;
  }

  /** @param actorId ADMIN que da de alta la cuenta, tomado del JWT. */
  public async create(
    createUserDto: CreateUserDto,
    actorId: string,
  ): Promise<User> {
    this.assertCorporateEmail(createUserDto.email);

    const existingUser = await this.userRepository.findOne({
      where: { email: createUserDto.email },
    });

    if (existingUser) {
      throw new ConflictException(
        `El correo "${createUserDto.email}" ya está registrado`,
      );
    }

    const user = stampCreated(
      this.userRepository.create(createUserDto),
      actorId,
    );
    const saved = await this.userRepository.save(user);
    // Se relee para devolver los autores ya resueltos (`AUDIT_RELATIONS`).
    const stored = await this.findOne(saved.id);
    // Siempre DESPUES de confirmar la escritura: emitir antes abriria una
    // ventana en la que otro panel pinta una fila que PostgreSQL aun no tiene.
    this.publishMutation('CREATED', stored);

    return stored;
  }

  public async update(
    id: string,
    updateUserDto: UpdateUserDto,
    actorId: string,
  ): Promise<User> {
    if (updateUserDto.email) {
      this.assertCorporateEmail(updateUserDto.email);
    }

    const user = await this.findOne(id);

    // FOTOGRAFIA ANTES del `Object.assign`, que muta la entidad en el sitio:
    // leida despues, cada campo ya valdria lo nuevo y la comparacion de
    // `resolveSessionBreakingFields` no encontraria jamas un cambio.
    const previous = {
      role: user.role,
      isActive: user.isActive,
      email: user.email,
    };

    Object.assign(user, updateUserDto);

    const breakingFields = resolveSessionBreakingFields(previous, user);

    // El contador se sube en la MISMA escritura que los campos, no en un
    // `update` aparte: si se guardara en dos pasos, un fallo entre ambos
    // dejaria el rol nuevo con la generacion vieja, es decir, el privilegio
    // cambiado y las sesiones antiguas todavia validas.
    if (breakingFields.length > 0) {
      user.tokenVersion += 1;
    }

    await this.userRepository.save(stampUpdated(user, actorId));
    const stored = await this.findOne(id);
    this.publishMutation('UPDATED', stored);

    await this.closeSessionsAfterChange(id, actorId, breakingFields);

    return stored;
  }

  // Borrado lógico: desactiva al usuario en lugar de eliminar el registro
  public async remove(id: string, actorId: string): Promise<User> {
    const user = await this.findOne(id);

    // Solo cuenta como cambio si la cuenta estaba viva: desactivar dos veces no
    // tiene por que invalidar nada ni avisar a nadie por segunda vez.
    const breakingFields: ModifiedUserField[] = user.isActive ? ['estado'] : [];

    user.isActive = false;

    if (breakingFields.length > 0) {
      user.tokenVersion += 1;
    }

    await this.userRepository.save(stampUpdated(user, actorId));
    const stored = await this.findOne(id);
    this.publishMutation('UPDATED', stored);

    await this.closeSessionsAfterChange(id, actorId, breakingFields);

    return stored;
  }

  /**
   * Cierra las sesiones vivas del usuario y le avisa de por que.
   *
   * ORDEN DELIBERADO: primero se revoca y despues se anuncia. Al reves, el
   * cliente recibiria el modal de cierre mientras sus tokens siguen sirviendo,
   * y bastaria con cerrar la pestana durante la cuenta atras para conservar una
   * sesion que el sistema ya da por muerta.
   *
   * La revocacion SI puede tumbar la peticion —un fallo ahi deja sesiones
   * abiertas que creemos cerradas, y tragarselo convertiria un agujero en un
   * silencio—, mientras que el aviso es cortesia: `token_version` ya esta
   * escrita, de modo que un socket caido no salva a nadie, solo le priva de la
   * explicacion.
   */
  private async closeSessionsAfterChange(
    userId: string,
    actorId: string,
    updatedFields: readonly ModifiedUserField[],
  ): Promise<void> {
    if (updatedFields.length === 0) {
      return;
    }

    await this.sessionRevocation.revokeAllForUser(userId);

    this.sessionEvents.dispatch({
      userId,
      actorEmail: await this.resolveActorEmail(actorId),
      updatedFields,
      emittedAt: new Date().toISOString(),
    });
  }

  /**
   * Correo de quien hizo el cambio, para que el aviso no sea anonimo.
   *
   * Se consulta aqui en vez de arrastrarlo por la firma de `update` y `remove`:
   * solo hace falta en el caso raro en que de verdad se cierra una sesion, y
   * ensanchar las dos firmas obligaria a tocar controladores y pruebas para un
   * dato que casi nunca se usa.
   *
   * Si el actor ya no existe —se borro a si mismo, o la fila cambio— el aviso
   * sale igual con un marcador: dejar al usuario sin explicacion seria peor que
   * darle una incompleta.
   */
  private async resolveActorEmail(actorId: string): Promise<string> {
    const actor = await this.userRepository.findOne({
      where: { id: actorId },
      select: { email: true },
    });

    return actor?.email ?? 'un administrador';
  }
}

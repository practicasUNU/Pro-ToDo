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

import { UserResponseDto } from './dto/user-response.dto';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

import type { CrudAction } from '@common/types/crud-events.types';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly crudEvents: CrudEventsCoordinator,
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
    return this.userRepository.find();
  }

  public async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });

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

  public async create(createUserDto: CreateUserDto): Promise<User> {
    this.assertCorporateEmail(createUserDto.email);

    const existingUser = await this.userRepository.findOne({
      where: { email: createUserDto.email },
    });

    if (existingUser) {
      throw new ConflictException(
        `El correo "${createUserDto.email}" ya está registrado`,
      );
    }

    const user = this.userRepository.create(createUserDto);
    const saved = await this.userRepository.save(user);
    // Siempre DESPUES de confirmar la escritura: emitir antes abriria una
    // ventana en la que otro panel pinta una fila que PostgreSQL aun no tiene.
    this.publishMutation('CREATED', saved);

    return saved;
  }

  public async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    if (updateUserDto.email) {
      this.assertCorporateEmail(updateUserDto.email);
    }

    const user = await this.findOne(id);

    Object.assign(user, updateUserDto);
    const saved = await this.userRepository.save(user);
    this.publishMutation('UPDATED', saved);

    return saved;
  }

  // Borrado lógico: desactiva al usuario en lugar de eliminar el registro
  public async remove(id: string): Promise<User> {
    const user = await this.findOne(id);

    user.isActive = false;
    const saved = await this.userRepository.save(user);
    this.publishMutation('UPDATED', saved);

    return saved;
  }
}

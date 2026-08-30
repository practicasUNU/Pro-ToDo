import { ConfigService } from '@nestjs/config';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
  ) {}

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
    return this.userRepository.save(user);
  }

  public async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    if (updateUserDto.email) {
      this.assertCorporateEmail(updateUserDto.email);
    }

    const user = await this.findOne(id);

    Object.assign(user, updateUserDto);
    return this.userRepository.save(user);
  }

  // Borrado lógico: desactiva al usuario en lugar de eliminar el registro
  public async remove(id: string): Promise<User> {
    const user = await this.findOne(id);

    user.isActive = false;
    return this.userRepository.save(user);
  }
}

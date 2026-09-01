import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

import { IP_OR_CIDR_REGEX } from '@common/constants/security.constants';

export class CreateAllowedIpDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(IP_OR_CIDR_REGEX, {
    message:
      'ipOrCidr debe ser una IPv4/IPv6 valida, opcionalmente con sufijo CIDR (ej. 192.168.1.0/24)',
  })
  ipOrCidr: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  description: string;
}

import { PartialType } from '@nestjs/mapped-types';

import { CreateAllowedIpDto } from './create-allowed-ip.dto';

export class UpdateAllowedIpDto extends PartialType(CreateAllowedIpDto) {}

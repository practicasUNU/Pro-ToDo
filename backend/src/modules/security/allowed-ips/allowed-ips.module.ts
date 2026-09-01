import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AllowedIpsController } from './allowed-ips.controller';
import { AllowedIpsService } from './allowed-ips.service';
import { AllowedIp } from './entities/allowed-ip.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AllowedIp])],
  controllers: [AllowedIpsController],
  providers: [AllowedIpsService],
  exports: [AllowedIpsService],
})
export class AllowedIpsModule {}

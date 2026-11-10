import { Module } from '@nestjs/common';
import { CustomersAliasController, TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  controllers: [TenantsController, CustomersAliasController],
  providers: [TenantsService],
})
export class TenantsModule {}

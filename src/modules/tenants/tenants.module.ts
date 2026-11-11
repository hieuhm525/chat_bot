import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SignupController } from './signup.controller';
import { CustomersAliasController, TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [AuthModule],
  controllers: [TenantsController, CustomersAliasController, SignupController],
  providers: [TenantsService],
})
export class TenantsModule {}

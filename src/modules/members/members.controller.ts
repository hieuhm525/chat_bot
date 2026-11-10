import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { IsString, Matches, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { Roles } from '../../common/roles.decorator';
import { MembersService } from './members.service';

class CreateMemberDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9._-]{3,32}$/, { message: 'Tên đăng nhập 3-32 ký tự, chỉ gồm chữ, số, . _ -' })
  username!: string;

  @IsString() @MinLength(6) password!: string;
}

class PasswordDto {
  @IsString() @MinLength(6) password!: string;
}

@Roles('owner')
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.members.list(user.workspaceId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateMemberDto) {
    return this.members.create(user.workspaceId, dto);
  }

  @Patch(':id/password')
  updatePassword(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PasswordDto,
  ) {
    return this.members.updatePassword(user.workspaceId, id, dto.password);
  }

  @Delete(':id')
  disable(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.disable(user.workspaceId, user.id, id);
  }
}

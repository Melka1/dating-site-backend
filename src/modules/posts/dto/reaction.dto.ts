import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { ReactionType } from '../entities/reaction.entity';

export const REACTION_TYPES = Object.values(ReactionType);

export class SetReactionDto {
  @ApiProperty({ enum: REACTION_TYPES })
  @IsIn(REACTION_TYPES)
  type!: ReactionType;
}

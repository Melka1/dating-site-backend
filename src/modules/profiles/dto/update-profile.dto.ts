import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const GENDERS = ['male', 'female', 'non_binary', 'other', 'prefer_not_to_say'] as const;
const MARITAL = ['single', 'married', 'divorced', 'widowed', 'separated', 'other'] as const;
const RELATIONSHIP = ['serious', 'casual', 'friendship', 'affair', 'marriage', 'open'] as const;
const CHILDREN = ['none', 'have', 'want', 'dont_want', 'maybe'] as const;
const SMOKING = ['never', 'casual', 'regular', 'trying_to_quit'] as const;
const DRINKING = ['never', 'socially', 'regularly'] as const;
const VISIBILITY = ['public', 'members_only', 'private'] as const;
export const PROFESSIONS = [
  'PAINTER', 'PHOTOGRAPHER', 'MODEL', 'PROJECT_MANAGER', 'DEVELOPER',
  'MUSICIAN', 'SINGER', 'PRODUCER', 'DIRECTOR', 'RAPPER',
  'VIDEOGRAPHER', 'EDITOR_WRITING', 'EDITOR_VIDEO', 'GRAPHIC_DESIGNER',
  'WEB_DEVELOPER', 'VENUE', 'SEAMSTRESS', 'ACTOR_ACTRESS',
  'MAKEUP_ARTIST', 'INTERIOR_DECORATOR', 'CATERER', 'PROMOTER',
  'PRINTER', 'DANCER', 'ARCHITECT', 'ENGINEER', 'CONTRACTOR',
  'WRITER', 'STYLIST', 'VOICEOVER_ARTIST', 'SONGWRITER',
] as const;

@ValidatorConstraint({ name: 'IsAdultDob', async: false })
class IsAdultDobConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const dob = new Date(value);
    if (Number.isNaN(dob.getTime())) return false;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 18);
    return dob.getTime() <= cutoff.getTime();
  }
  defaultMessage(_args: ValidationArguments) {
    return 'Must be at least 18 years old';
  }
}

export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) displayName?: string;
  @ApiPropertyOptional({ enum: GENDERS }) @IsOptional() @IsIn(GENDERS as readonly string[]) gender?: typeof GENDERS[number];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  seeking?: string[];

  @ApiPropertyOptional({ description: 'YYYY-MM-DD; must be 18+' })
  @IsOptional()
  @IsDateString()
  @Validate(IsAdultDobConstraint)
  dob?: string;

  @ApiPropertyOptional({ enum: MARITAL }) @IsOptional() @IsIn(MARITAL as readonly string[]) maritalStatus?: typeof MARITAL[number];
  @ApiPropertyOptional({ enum: RELATIONSHIP }) @IsOptional() @IsIn(RELATIONSHIP as readonly string[]) relationshipType?: typeof RELATIONSHIP[number];

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) country?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) city?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(240) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) bio?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) lookingFor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) likes?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) interests?: string[];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) favoritePlaces?: string[];

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) languages?: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) religion?: string;
  @ApiPropertyOptional({ enum: CHILDREN }) @IsOptional() @IsIn(CHILDREN as readonly string[]) children?: typeof CHILDREN[number];
  @ApiPropertyOptional({ enum: SMOKING }) @IsOptional() @IsIn(SMOKING as readonly string[]) smoking?: typeof SMOKING[number];
  @ApiPropertyOptional({ enum: DRINKING }) @IsOptional() @IsIn(DRINKING as readonly string[]) drinking?: typeof DRINKING[number];

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(80) @Max(260) heightCm?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(30) @Max(400) weightKg?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) hairColor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) eyeColor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) bodyType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) ethnicity?: string;
  @ApiPropertyOptional({ enum: PROFESSIONS })
  @IsOptional() @IsIn(PROFESSIONS as readonly string[]) profession?: typeof PROFESSIONS[number];

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description: "Professions this user is open to meeting. Use 'any' as a wildcard.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PROFESSIONS.length + 1)
  @IsIn([...PROFESSIONS, 'any'] as readonly string[], { each: true })
  seekingProfessions?: string[];

  @ApiPropertyOptional({ enum: VISIBILITY })
  @IsOptional()
  @IsIn(VISIBILITY as readonly string[])
  visibility?: typeof VISIBILITY[number];
}

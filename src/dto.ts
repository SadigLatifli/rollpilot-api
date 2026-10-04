import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBase64, IsDefined, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PHOTO_KEYS, type PhotoKey } from './models';

export class PlanGroupDto {
  @Matches(/^[A-Za-z0-9_-]{1,80}$/) id!: string;
  @IsString() @MinLength(1) @MaxLength(100) title!: string;
  @IsInt() @Min(0) @Max(1_000_000) count!: number;
  @IsIn(PHOTO_KEYS) photo!: PhotoKey;
  @Matches(/^#[0-9a-fA-F]{6}$/) tint!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @Matches(/^[A-Za-z0-9_-]{1,100}$/, { each: true }) assetIds?: string[];
  @IsOptional() @Matches(/^[A-Za-z0-9_-]{1,100}$/) coverAssetId?: string;
}

export class CreatePlanDto {
  @IsIn(['organize', 'cleanup', 'find']) kind!: 'organize' | 'cleanup' | 'find';
  @IsString() @MinLength(1) @MaxLength(500) command!: string;
  @IsString() @MinLength(1) @MaxLength(200) headline!: string;
  @IsString() @MinLength(1) @MaxLength(300) detail!: string;
  @IsString() @MaxLength(100) scanned!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PlanGroupDto) groups!: PlanGroupDto[];
  @IsOptional() @IsString() @MaxLength(40) potentialSpace?: string;
}

export class ConfirmPlanDto {
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) selectedGroupIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(90) @IsString({ each: true }) selectedItemIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @Matches(/^[A-Za-z0-9_-]{1,100}$/, { each: true }) selectedAssetIds?: string[];
}

export class CompleteOnboardingDto {
  @IsBoolean() onboarded!: boolean;
}

export class ThumbnailDto {
  @IsIn(['image/jpeg', 'image/png']) mimeType!: 'image/jpeg' | 'image/png';
  @IsBase64() @MaxLength(266668) data!: string;
}

export class PhotoCandidateDto {
  @Matches(/^[A-Za-z0-9_-]{1,100}$/) assetId!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsISO8601() createdAt?: string;
  @IsOptional() @ValidateNested() @Type(() => ThumbnailDto) thumbnail?: ThumbnailDto;
  @IsOptional() @IsIn(PHOTO_KEYS) previewKey?: PhotoKey;
}

export class AnalyzeDto {
  @IsString() @MinLength(1) @MaxLength(500) command!: string;
  @IsBoolean() cloudImagesAllowed!: boolean;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => PhotoCandidateDto) candidates!: PhotoCandidateDto[];
}

export class EmbedImageDto {
  @IsBoolean() cloudImagesAllowed!: boolean;
  @IsDefined() @ValidateNested() @Type(() => ThumbnailDto) thumbnail!: ThumbnailDto;
}
export class EmbedTextDto {
  @IsString() @MinLength(1) @MaxLength(500) text!: string;
}
